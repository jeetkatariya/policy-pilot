import { randomUUID } from 'node:crypto';

const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

export function createSession({ carrier, username, password }) {
  const id = randomUUID();
  const session = {
    id,
    carrier,
    username,
    password,
    status: 'starting',
    mfaRequired: false,
    mfaWasRequired: false, // sticky: true once MFA was ever asked for in this session
    documents: null,
    error: null,
    progress: null,
    createdAt: Date.now(),
    mfaSubmittedAt: null,
    doneAt: null,
    pwContext: null,
    pwPage: null,
    _mfaResolver: null,
    _mfaPromise: null,
  };
  session._mfaPromise = new Promise((resolve) => {
    session._mfaResolver = resolve;
  });
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id);
}

export function snapshotForClient(session) {
  if (!session) return null;
  const mfaToDoneMs =
    session.mfaSubmittedAt && session.doneAt ? session.doneAt - session.mfaSubmittedAt : null;
  return {
    id: session.id,
    carrier: session.carrier,
    status: session.status,
    mfaRequired: session.mfaRequired,
    mfaWasRequired: session.mfaWasRequired || false,
    documents:
      session.documents?.map((d) => ({
        id: d.id,
        name: d.name,
        policyId: d.policyId || null,
        policyLabel: d.policyLabel || null,
        url: `/api/sessions/${session.id}/documents/${encodeURIComponent(d.id)}`,
      })) || null,
    error: session.error,
    progress: session.progress,
    mfaToDoneMs,
  };
}

export function submitMfa(session, code) {
  if (!session._mfaResolver) return false;
  session.mfaSubmittedAt = Date.now();
  session._mfaResolver(code);
  session._mfaResolver = null;
  return true;
}

export function setStatus(session, status, patch = {}) {
  session.status = status;
  Object.assign(session, patch);
  if (status === 'awaiting_mfa') {
    session.mfaWasRequired = true;
  }
  if (status === 'done' || status === 'failed') {
    session.doneAt = Date.now();
  }
}

export function setProgress(session, progress) {
  session.progress = progress;
}

export function attachBrowser(session, pwContext, pwPage) {
  session.pwContext = pwContext;
  session.pwPage = pwPage;
}

export async function disposeSession(session) {
  if (!session) return;
  const ctx = session.pwContext;
  session.pwContext = null;
  session.pwPage = null;
  if (ctx) {
    await ctx.close().catch(() => {});
  }
  sessions.delete(session.id);
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      disposeSession(s);
    }
  }
}, 60 * 1000).unref();

export function allSessions() {
  return sessions.values();
}
