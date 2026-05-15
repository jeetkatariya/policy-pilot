import { randomUUID } from 'node:crypto';

const mfaPending = new Map();    // preMfaId -> { username }
const validSessions = new Map(); // sessionId -> { username }

const PRE_MFA_COOKIE = 'fp_pre_mfa';
const SESSION_COOKIE = 'fp_session';

function policiesFor(username) {
  const u = String(username || '').toLowerCase();
  if (u.includes('multi')) {
    return [
      { id: 'POL-AUTO-001', type: 'auto', label: 'Auto Policy (MO-1234)' },
      { id: 'POL-HOME-001', type: 'home', label: 'Home Policy (HO-5678)' },
    ];
  }
  if (u.includes('empty')) return [];
  return [{ id: 'POL-AUTO-001', type: 'auto', label: 'Auto Policy (MO-1234)' }];
}

function docsForPolicy(policy) {
  if (policy.type === 'auto') {
    return [
      { id: 'dec',      name: 'Declarations Page.pdf' },
      { id: 'id-cards', name: 'ID Cards.pdf' },
      { id: 'policy',   name: 'Auto Policy Contract.pdf' },
    ];
  }
  if (policy.type === 'home') {
    return [
      { id: 'dec',    name: 'Declarations Page.pdf' },
      { id: 'policy', name: 'Home Policy Contract.pdf' },
    ];
  }
  return [];
}

const layout = (title, body) => `<!doctype html>
<html><head><title>${title}</title></head>
<body style="font-family:monospace;max-width:640px;margin:2rem auto;padding:0 1rem">
<header><strong>fake carrier portal</strong> &mdash; <em>${title}</em></header><hr>
${body}
</body></html>`;

const errorPage = (title, msg) => layout(title, `<p class="error" data-error="1">${msg}</p>
<p><a href="/fake-portal/login">back to login</a></p>`);

function getSessionFromReq(req) {
  const sid = parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (!sid) return null;
  const entry = validSessions.get(sid);
  if (!entry) return null;
  return { sid, ...entry };
}

export default async function fakePortal(app) {
  app.get('/fake-portal/login', async (_req, reply) => {
    reply.type('text/html').send(layout('login', `
      <form id="loginForm" method="POST" action="/fake-portal/login-submit">
        <p><input id="username" name="username" placeholder="username" required></p>
        <p><input id="password" name="password" type="password" placeholder="password" required></p>
        <p><button id="loginSubmit" type="submit">log in</button></p>
      </form>
      <small>hint: password "wrong" fails; usernames containing "multi" have 2 policies</small>
    `));
  });

  app.post('/fake-portal/login-submit', async (req, reply) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      reply.code(400).type('text/html').send(errorPage('login', 'Username and password required.'));
      return;
    }
    if (password === 'wrong') {
      reply.code(401).type('text/html').send(errorPage('login', 'Invalid username or password.'));
      return;
    }
    const pre = randomUUID();
    mfaPending.set(pre, { username });
    reply
      .header('Set-Cookie', `${PRE_MFA_COOKIE}=${pre}; Path=/; HttpOnly`)
      .redirect('/fake-portal/mfa');
  });

  app.get('/fake-portal/mfa', async (req, reply) => {
    const pre = parseCookie(req.headers.cookie, PRE_MFA_COOKIE);
    if (!pre || !mfaPending.has(pre)) {
      reply.code(401).type('text/html').send(errorPage('mfa', 'Session expired. Please log in again.'));
      return;
    }
    reply.type('text/html').send(layout('mfa', `
      <p>Code sent to ***-1234.</p>
      <form id="mfaForm" method="POST" action="/fake-portal/mfa-submit">
        <p><input id="code" name="code" inputmode="numeric" placeholder="6-digit code" required></p>
        <p><label><input type="checkbox" id="trust" name="trust"> trust this device</label></p>
        <p><button id="mfaSubmit" type="submit">verify</button></p>
      </form>
      <small>hint: code "000000" fails, "expired" returns expired error</small>
    `));
  });

  app.post('/fake-portal/mfa-submit', async (req, reply) => {
    const pre = parseCookie(req.headers.cookie, PRE_MFA_COOKIE);
    if (!pre || !mfaPending.has(pre)) {
      reply.code(401).type('text/html').send(errorPage('mfa', 'Session expired. Please log in again.'));
      return;
    }
    const { code } = req.body || {};
    if (!code) {
      reply.code(400).type('text/html').send(errorPage('mfa', 'Code required.'));
      return;
    }
    if (code === '000000') {
      reply.code(401).type('text/html').send(errorPage('mfa', 'Incorrect verification code.'));
      return;
    }
    if (code === 'expired') {
      reply.code(401).type('text/html').send(errorPage('mfa', 'Verification code expired. Request a new one.'));
      return;
    }
    const { username } = mfaPending.get(pre);
    mfaPending.delete(pre);
    const sess = randomUUID();
    validSessions.set(sess, { username });
    reply
      .header('Set-Cookie', `${SESSION_COOKIE}=${sess}; Path=/; HttpOnly`)
      .redirect('/fake-portal/dashboard');
  });

  app.get('/fake-portal/dashboard', async (req, reply) => {
    const s = getSessionFromReq(req);
    if (!s) {
      reply.code(401).type('text/html').send(errorPage('dashboard', 'Not authenticated.'));
      return;
    }
    reply.type('text/html').send(layout('dashboard', `
      <p>Welcome back, ${s.username}.</p>
      <nav>
        <ul>
          <li><a href="/fake-portal/claims">Claims</a></li>
          <li><a href="/fake-portal/billing">Billing</a></li>
          <li><a id="navPolicies" href="/fake-portal/policies">My Policies</a></li>
        </ul>
      </nav>
    `));
  });

  app.get('/fake-portal/claims', async (req, reply) => {
    if (!getSessionFromReq(req)) return reply.code(401).send('not authed');
    reply.type('text/html').send(layout('claims', '<p>No open claims.</p>'));
  });

  app.get('/fake-portal/billing', async (req, reply) => {
    if (!getSessionFromReq(req)) return reply.code(401).send('not authed');
    reply.type('text/html').send(layout('billing', '<p>$0.00 balance.</p>'));
  });

  app.get('/fake-portal/policies', async (req, reply) => {
    const s = getSessionFromReq(req);
    if (!s) {
      reply.code(401).type('text/html').send(errorPage('policies', 'Not authenticated.'));
      return;
    }
    const policies = policiesFor(s.username);
    if (policies.length === 0) {
      reply.type('text/html').send(layout('policies', '<p>No active policies on this account.</p>'));
      return;
    }
    const cards = policies.map((p) => `
      <article class="policy-card" data-policy-id="${p.id}">
        <h3>${p.label}</h3>
        <p>Policy ID: <span class="policy-id">${p.id}</span></p>
        <p><a class="policy-link" href="/fake-portal/policies/${p.id}">View policy</a></p>
      </article>
    `).join('');
    reply.type('text/html').send(layout('policies', `
      <h2>My Policies</h2>
      <section id="policyList">${cards}</section>
    `));
  });

  app.get('/fake-portal/policies/:id', async (req, reply) => {
    const s = getSessionFromReq(req);
    if (!s) {
      reply.code(401).type('text/html').send(errorPage('policy', 'Not authenticated.'));
      return;
    }
    const policy = policiesFor(s.username).find((p) => p.id === req.params.id);
    if (!policy) {
      reply.code(404).type('text/html').send(errorPage('policy', 'Policy not found.'));
      return;
    }
    reply.type('text/html').send(layout(`policy ${policy.id}`, `
      <h2>${policy.label}</h2>
      <nav class="policy-tabs">
        <a href="/fake-portal/policies/${policy.id}">Overview</a>
        | <a class="docs-tab" href="/fake-portal/policies/${policy.id}/documents">Documents</a>
        | <a href="/fake-portal/policies/${policy.id}/billing">Billing</a>
      </nav>
      <section>
        <p>Effective: 2026-01-01 &mdash; 2026-12-31</p>
      </section>
    `));
  });

  app.get('/fake-portal/policies/:id/documents', async (req, reply) => {
    const s = getSessionFromReq(req);
    if (!s) {
      reply.code(401).type('text/html').send(errorPage('documents', 'Not authenticated.'));
      return;
    }
    const policy = policiesFor(s.username).find((p) => p.id === req.params.id);
    if (!policy) {
      reply.code(404).type('text/html').send(errorPage('documents', 'Policy not found.'));
      return;
    }
    const docs = docsForPolicy(policy);
    const rows = docs.map((d) => `
      <div class="doc-row" data-doc-id="${d.id}">
        <span class="doc-name">${d.name}</span>
        <a class="doc-download" href="/fake-portal/policies/${policy.id}/documents/${d.id}">Download</a>
      </div>
    `).join('');
    reply.type('text/html').send(layout(`documents ${policy.id}`, `
      <h2>${policy.label} &mdash; Documents</h2>
      <section class="doc-table">${rows || '<p>No documents.</p>'}</section>
    `));
  });

  app.get('/fake-portal/policies/:id/documents/:docId', async (req, reply) => {
    const s = getSessionFromReq(req);
    if (!s) return reply.code(401).type('text/plain').send('not authenticated');
    const policy = policiesFor(s.username).find((p) => p.id === req.params.id);
    if (!policy) return reply.code(404).type('text/plain').send('policy not found');
    const doc = docsForPolicy(policy).find((d) => d.id === req.params.docId);
    if (!doc) return reply.code(404).type('text/plain').send('doc not found');
    reply
      .type('text/plain')
      .send(`Fake document\nPolicy: ${policy.label} (${policy.id})\nDocument: ${doc.name}\nUser: ${s.username}\nGenerated: ${new Date().toISOString()}\n`);
  });

  app.get('/fake-portal/policies/:id/billing', async (req, reply) => {
    if (!getSessionFromReq(req)) return reply.code(401).send('not authed');
    reply.type('text/html').send(layout('policy billing', '<p>$0.00 due.</p>'));
  });
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v;
  }
  return null;
}
