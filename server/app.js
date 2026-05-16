import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

import {
  createSession,
  getSession,
  snapshotForClient,
  submitMfa,
} from './sessions.js';
import { getCarrier, listCarriers } from './carriers/index.js';
import { userKeyFor } from './carriers/_shared.js';
import { canStart, recordStart } from './rateLimit.js';
import fakePortal from './fakePortal.js';

const REAL_CARRIERS = new Set(['progressive', 'lemonade']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

function fieldErr(field, message) { return { field, message }; }

function validateCreate(body) {
  const errors = [];
  const carrier = body?.carrier?.trim();
  const username = body?.username?.trim();
  const password = body?.password;
  if (!carrier) errors.push(fieldErr('carrier', 'carrier required'));
  else if (!getCarrier(carrier)) errors.push(fieldErr('carrier', `unknown carrier: ${carrier}`));
  if (!username) errors.push(fieldErr('username', 'username required'));
  if (!password) errors.push(fieldErr('password', 'password required'));
  return errors;
}

function validateMfa(body) {
  const errors = [];
  const code = body?.code?.trim();
  if (!code) errors.push(fieldErr('code', 'code required'));
  return errors;
}

export async function buildApp({ logger = false } = {}) {
  const app = Fastify({ logger });

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body);
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        done(null, obj);
      } catch (err) {
        done(err);
      }
    },
  );

  await app.register(fakePortal);

  app.get('/api/carriers', async () => listCarriers());

  app.post('/api/sessions', async (req, reply) => {
    const errs = validateCreate(req.body || {});
    if (errs.length) return reply.code(400).send({ error: errs[0].message, errors: errs });
    const { carrier, username, password } = req.body;
    const carrierName = carrier.trim();
    const driver = getCarrier(carrierName);

    if (REAL_CARRIERS.has(carrierName)) {
      const key = userKeyFor(carrierName, username.trim());
      const rl = canStart(key);
      if (!rl.ok) {
        const secs = Math.ceil(rl.retryAfterMs / 1000);
        return reply.code(429).send({
          error: `Please wait ${secs}s before retrying (anti-bot rate limit).`,
          retryAfterMs: rl.retryAfterMs,
        });
      }
      recordStart(key);
    }

    const session = createSession({
      carrier: carrierName,
      username: username.trim(),
      password,
    });
    driver.run(session).catch((err) => {
      app.log.error({ err }, 'carrier driver crashed');
    });
    return snapshotForClient(session);
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const session = getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    return snapshotForClient(session);
  });

  app.post('/api/sessions/:id/mfa', async (req, reply) => {
    const session = getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const errs = validateMfa(req.body || {});
    if (errs.length) return reply.code(400).send({ error: errs[0].message, errors: errs });
    const ok = submitMfa(session, req.body.code.trim());
    if (!ok) return reply.code(409).send({ error: 'not awaiting mfa' });
    return { ok: true };
  });

  app.get('/api/sessions/:id/documents/:docId', async (req, reply) => {
    const session = getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const docId = decodeURIComponent(req.params.docId);
    const doc = (session.documents || []).find((d) => d.id === docId);
    if (!doc) return reply.code(404).send({ error: 'doc not found' });

    // Docs captured via Playwright's download event are saved locally — stream
    // them from disk. (Used by carriers like eRenterPlan where the carrier UI
    // triggers a JS-driven download with no static URL.)
    if (doc.localPath) {
      const s = await stat(doc.localPath).catch(() => null);
      if (!s) return reply.code(404).send({ error: 'local file no longer present' });
      const ext = path.extname(doc.localPath).toLowerCase();
      const mime = ext === '.pdf' ? 'application/pdf'
        : ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : 'application/octet-stream';
      reply.header('Content-Type', mime);
      reply.header('Content-Disposition', `inline; filename="${path.basename(doc.localPath)}"`);
      return reply.send(createReadStream(doc.localPath));
    }

    if (doc.sourceUrl && session.pwContext) {
      const resp = await session.pwContext.request.get(doc.sourceUrl);
      reply.code(resp.status());
      const ct = resp.headers()['content-type'];
      if (ct) reply.header('Content-Type', ct);
      return reply.send(await resp.body());
    }

    reply.header('Content-Type', 'text/plain');
    return `Stub document: ${doc.name}\nSession: ${session.id}\n`;
  });

  return app;
}
