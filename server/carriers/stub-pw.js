import { setStatus, setProgress, attachBrowser } from '../sessions.js';
import * as runtime from '../runtime/playwright.js';
import { raceForSettle } from './_shared.js';

const STEP_TIMEOUT_MS = 8_000;

function getBase() {
  return process.env.FAKE_PORTAL_BASE || 'http://127.0.0.1:3000';
}

export async function run(session) {
  const FAKE_PORTAL_BASE = getBase();
  let context = null;
  let page = null;
  try {
    context = await runtime.newContext();
    page = await context.newPage();
    attachBrowser(session, context, page);

    setProgress(session, { stage: 'opening_login' });
    await page.goto(`${FAKE_PORTAL_BASE}/fake-portal/login`, { timeout: STEP_TIMEOUT_MS });

    setProgress(session, { stage: 'submitting_credentials' });
    await page.fill('#username', session.username);
    await page.fill('#password', session.password);
    const loginRes = await raceForSettle(page, {
      urlPattern: '**/fake-portal/mfa',
      errorSelectors: ['.error[data-error="1"]'],
      timeoutMs: STEP_TIMEOUT_MS,
      action: () => page.click('#loginSubmit'),
    });
    if (!loginRes.ok) throw new Error(loginRes.error);

    setStatus(session, 'awaiting_mfa', { mfaRequired: true });
    setProgress(session, { stage: 'awaiting_mfa' });
    const code = await session._mfaPromise;
    if (!code) throw new Error('No MFA code received.');

    setStatus(session, 'fetching_docs', { mfaRequired: false });
    setProgress(session, { stage: 'verifying_code' });
    await page.fill('#code', code);
    const mfaRes = await raceForSettle(page, {
      urlPattern: '**/fake-portal/dashboard',
      errorSelectors: ['.error[data-error="1"]'],
      timeoutMs: STEP_TIMEOUT_MS,
      action: () => page.click('#mfaSubmit'),
    });
    if (!mfaRes.ok) throw new Error(mfaRes.error);

    setProgress(session, { stage: 'discovering_policies' });
    await page.click('#navPolicies');
    await page.waitForURL('**/fake-portal/policies', { timeout: STEP_TIMEOUT_MS });

    const policies = await page.$$eval('article.policy-card', (cards) =>
      cards.map((c) => ({
        id: c.dataset.policyId,
        label: c.querySelector('h3')?.textContent.trim() || c.dataset.policyId,
        link: c.querySelector('a.policy-link')?.href || null,
      })),
    );

    if (policies.length === 0) {
      throw new Error('No policies found on this account.');
    }

    const allDocs = [];
    for (let i = 0; i < policies.length; i++) {
      const p = policies[i];
      setProgress(session, {
        stage: 'fetching_policy_docs',
        current: i + 1,
        total: policies.length,
        policyId: p.id,
      });
      const docsUrl = new URL(p.link, FAKE_PORTAL_BASE).pathname + '/documents';
      await page.goto(`${FAKE_PORTAL_BASE}${docsUrl}`, { timeout: STEP_TIMEOUT_MS });
      const docs = await page.$$eval('.doc-row', (rows) =>
        rows.map((r) => ({
          docId: r.dataset.docId,
          name: r.querySelector('.doc-name')?.textContent.trim() || r.dataset.docId,
          href: r.querySelector('a.doc-download')?.href || null,
        })),
      );
      for (const d of docs) {
        allDocs.push({
          id: `${p.id}/${d.docId}`,
          name: d.name,
          policyId: p.id,
          policyLabel: p.label,
          sourceUrl: d.href,
        });
      }
    }

    setProgress(session, { stage: 'done', totalDocs: allDocs.length });
    setStatus(session, 'done', { documents: allDocs });
  } catch (err) {
    setStatus(session, 'failed', { error: String(err.message || err) });
    if (context) {
      await context.close().catch(() => {});
      attachBrowser(session, null, null);
    }
  }
}
