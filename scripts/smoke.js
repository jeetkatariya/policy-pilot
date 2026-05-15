// End-to-end smoke test: starts an ephemeral server, runs scenarios against the
// stub-pw carrier (Playwright + fake portal), prints PASS/FAIL, exits non-zero on failure.

import { buildApp } from '../server/app.js';
import { allSessions, disposeSession } from '../server/sessions.js';
import * as runtime from '../server/runtime/playwright.js';

const HOST = '127.0.0.1';

function makeApi(baseUrl) {
  return async function api(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try { payload = await res.json(); } catch {}
    return { status: res.status, body: payload };
  };
}

async function waitFor(api, sessionId, predicate, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api('GET', `/api/sessions/${sessionId}`);
    if (predicate(body)) return body;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting; predicate did not match`);
}

async function scenarioSinglePolicy(api) {
  const { status, body: s } = await api('POST', '/api/sessions', {
    carrier: 'stub-pw', username: 'alice', password: 'pw',
  });
  if (status !== 200) throw new Error(`create failed: ${JSON.stringify(s)}`);

  await waitFor(api, s.id, (b) => b.status === 'awaiting_mfa');

  const mfaRes = await api('POST', `/api/sessions/${s.id}/mfa`, { code: '123456' });
  if (mfaRes.status !== 200) throw new Error(`mfa failed: ${JSON.stringify(mfaRes.body)}`);

  const done = await waitFor(api, s.id, (b) => b.status === 'done' || b.status === 'failed');
  if (done.status === 'failed') throw new Error(`session failed: ${done.error}`);
  if (done.documents.length !== 3) throw new Error(`expected 3 docs, got ${done.documents.length}`);
  if (done.mfaToDoneMs == null || done.mfaToDoneMs > 8000) {
    throw new Error(`latency budget blown: ${done.mfaToDoneMs}ms`);
  }
  const docResp = await fetch(`${api.base}${done.documents[0].url}`);
  const text = await docResp.text();
  if (!text.includes('Fake document')) throw new Error(`doc fetch unexpected body: ${text}`);
  return { docs: done.documents.length, mfaToDoneMs: done.mfaToDoneMs };
}

async function scenarioMultiPolicy(api) {
  const { body: s } = await api('POST', '/api/sessions', {
    carrier: 'stub-pw', username: 'bob-multi', password: 'pw',
  });
  await waitFor(api, s.id, (b) => b.status === 'awaiting_mfa');
  await api('POST', `/api/sessions/${s.id}/mfa`, { code: '111111' });
  const done = await waitFor(api, s.id, (b) => b.status === 'done' || b.status === 'failed');
  if (done.status === 'failed') throw new Error(`session failed: ${done.error}`);
  // 3 auto docs + 2 home docs = 5
  if (done.documents.length !== 5) throw new Error(`expected 5 docs, got ${done.documents.length}`);
  const policyIds = new Set(done.documents.map((d) => d.policyId));
  if (policyIds.size !== 2) throw new Error(`expected 2 distinct policies, got ${policyIds.size}`);
  return { docs: done.documents.length, mfaToDoneMs: done.mfaToDoneMs };
}

async function scenarioWrongPassword(api) {
  const { body: s } = await api('POST', '/api/sessions', {
    carrier: 'stub-pw', username: 'alice', password: 'wrong',
  });
  const done = await waitFor(api, s.id, (b) => b.status === 'failed' || b.status === 'done',
    { timeoutMs: 6000 });
  if (done.status !== 'failed') throw new Error(`expected failed, got ${done.status}`);
  if (!/invalid/i.test(done.error)) throw new Error(`expected invalid-credentials error, got: ${done.error}`);
  return { error: done.error };
}

async function scenarioWrongMfa(api) {
  const { body: s } = await api('POST', '/api/sessions', {
    carrier: 'stub-pw', username: 'alice', password: 'pw',
  });
  await waitFor(api, s.id, (b) => b.status === 'awaiting_mfa');
  await api('POST', `/api/sessions/${s.id}/mfa`, { code: '000000' });
  const done = await waitFor(api, s.id, (b) => b.status === 'failed' || b.status === 'done',
    { timeoutMs: 6000 });
  if (done.status !== 'failed') throw new Error(`expected failed, got ${done.status}`);
  if (!/incorrect/i.test(done.error)) throw new Error(`expected incorrect-code error, got: ${done.error}`);
  return { error: done.error };
}

async function scenarioServerValidation(api) {
  const r = await api('POST', '/api/sessions', { carrier: 'stub-pw' }); // missing creds
  if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  if (!Array.isArray(r.body?.errors) || r.body.errors.length === 0) {
    throw new Error(`expected structured errors, got: ${JSON.stringify(r.body)}`);
  }
  return { errors: r.body.errors.map((e) => e.field) };
}

const SCENARIOS = [
  ['server validation rejects missing fields', scenarioServerValidation],
  ['single-policy happy path',                 scenarioSinglePolicy],
  ['multi-policy discovery',                   scenarioMultiPolicy],
  ['wrong password surfaces carrier error',    scenarioWrongPassword],
  ['wrong MFA surfaces carrier error',         scenarioWrongMfa],
];

async function main() {
  process.env.FAKE_PORTAL_BASE = process.env.FAKE_PORTAL_BASE || '';
  const app = await buildApp();
  await app.listen({ port: 0, host: HOST });
  const port = app.server.address().port;
  const baseUrl = `http://${HOST}:${port}`;
  process.env.FAKE_PORTAL_BASE = baseUrl; // driver reads this at runtime

  const api = makeApi(baseUrl);
  api.base = baseUrl;

  let passed = 0;
  let failed = 0;
  const results = [];
  for (const [name, fn] of SCENARIOS) {
    const t0 = Date.now();
    try {
      const info = await fn(api);
      const dt = Date.now() - t0;
      results.push({ name, ok: true, dt, info });
      passed++;
      console.log(`PASS  ${name}  (${dt}ms)  ${JSON.stringify(info)}`);
    } catch (e) {
      const dt = Date.now() - t0;
      results.push({ name, ok: false, dt, error: e.message });
      failed++;
      console.log(`FAIL  ${name}  (${dt}ms)  ${e.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  for (const s of allSessions()) await disposeSession(s);
  await runtime.shutdown();
  await app.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke harness crashed:', e);
  process.exit(2);
});
