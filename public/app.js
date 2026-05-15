const $ = (id) => document.getElementById(id);
const POLL_MS = 500;

let sessionId = null;
let pollTimer = null;

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  let payload = null;
  try { payload = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(payload?.error || `${res.status}`);
    err.payload = payload;
    err.status = res.status;
    throw err;
  }
  return payload;
}

function setStatusText(text) { $('status').textContent = text; }
function clearFieldErrors(prefix) {
  document.querySelectorAll('.field-error').forEach((el) => {
    if (!prefix || el.id.startsWith(prefix)) el.textContent = '';
  });
}
function showFieldErrors(errors) {
  if (!errors) return;
  for (const e of errors) {
    const el = $(`err-${e.field}`);
    if (el) el.textContent = e.message;
  }
}
function showTopError(msg) {
  const el = $('topError');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = msg;
}
function setProgress(p) {
  const el = $('progress');
  if (!p) { el.classList.add('hidden'); el.textContent = ''; return; }
  let text;
  switch (p.stage) {
    case 'opening_login':       text = 'opening login page...'; break;
    case 'submitting_credentials': text = 'submitting credentials...'; break;
    case 'awaiting_mfa':        text = 'awaiting MFA code...'; break;
    case 'verifying_code':      text = 'verifying code...'; break;
    case 'discovering_policies': text = 'discovering policies...'; break;
    case 'fetching_policy_docs': text = `fetching docs for policy ${p.current}/${p.total} (${p.policyId})...`; break;
    case 'done':                text = `done - ${p.totalDocs} document(s) collected`; break;
    default:                    text = p.stage;
  }
  el.classList.remove('hidden');
  el.textContent = text;
}

function validateLoginInputs() {
  const enabled = $('username').value.trim().length > 0 && $('password').value.length > 0;
  $('loginBtn').disabled = !enabled;
}
function validateMfaInputs() {
  $('mfaBtn').disabled = $('mfaCode').value.trim().length === 0;
}

async function loadCarriers() {
  const carriers = await api('GET', '/api/carriers');
  const sel = $('carrier');
  for (const c of carriers) {
    const opt = document.createElement('option');
    opt.value = c.id;
    let label = c.name;
    if (c.disabled) label += ' (coming soon)';
    else if (c.experimental) label += ' (real portal - experimental)';
    opt.textContent = label;
    if (c.disabled) opt.disabled = true;
    sel.appendChild(opt);
  }
}

function resetForNewSession() {
  sessionId = null;
  stopPolling();
  clearFieldErrors();
  showTopError(null);
  setProgress(null);
  $('mfaCard').classList.add('hidden');
  $('docsCard').classList.add('hidden');
  $('docList').innerHTML = '';
  $('mfaCode').value = '';
  $('loginBtn').disabled = false;
  validateLoginInputs();
}

async function startLogin() {
  clearFieldErrors();
  showTopError(null);
  const body = {
    carrier: $('carrier').value,
    username: $('username').value.trim(),
    password: $('password').value,
  };
  $('loginBtn').disabled = true;
  setStatusText('starting...');
  try {
    const s = await api('POST', '/api/sessions', body);
    sessionId = s.id;
    setStatusText(`session ${sessionId.slice(0, 8)} - ${s.status}`);
    startPolling();
  } catch (e) {
    if (e.payload?.errors) showFieldErrors(e.payload.errors);
    else showTopError(e.message);
    $('loginBtn').disabled = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const s = await api('GET', `/api/sessions/${sessionId}`);
      onSnapshot(s);
    } catch (e) {
      showTopError(e.message);
    }
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function onSnapshot(s) {
  setStatusText(`session ${sessionId.slice(0, 8)} - ${s.status}`);
  setProgress(s.progress);

  if (s.status === 'awaiting_mfa' && $('mfaCard').classList.contains('hidden')) {
    $('mfaCard').classList.remove('hidden');
    $('mfaCode').focus();
  }

  if (s.status === 'done') {
    stopPolling();
    renderDocs(s.documents);
    if (s.mfaToDoneMs != null) {
      setStatusText(`done - mfa->docs ${s.mfaToDoneMs}ms (server)`);
    }
  }

  if (s.status === 'failed') {
    stopPolling();
    showTopError(s.error || 'failed');
    setProgress(null);
    $('mfaCard').classList.add('hidden');
    $('loginBtn').disabled = false;
  }
}

function renderDocs(docs) {
  $('docsCard').classList.remove('hidden');
  const root = $('docList');
  root.innerHTML = '';
  if (!docs || docs.length === 0) {
    root.textContent = 'no documents';
    return;
  }
  const groups = new Map();
  for (const d of docs) {
    const key = d.policyId || '(no policy)';
    if (!groups.has(key)) groups.set(key, { label: d.policyLabel || key, items: [] });
    groups.get(key).items.push(d);
  }
  for (const [policyId, g] of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'policy-group';
    const h = document.createElement('h4');
    h.textContent = g.label;
    wrap.appendChild(h);
    const ul = document.createElement('ul');
    for (const d of g.items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = d.url;
      a.textContent = d.name;
      a.target = '_blank';
      li.appendChild(a);
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    root.appendChild(wrap);
  }
}

async function submitMfa() {
  clearFieldErrors('err-code');
  showTopError(null);
  const code = $('mfaCode').value.trim();
  $('mfaBtn').disabled = true;
  try {
    await api('POST', `/api/sessions/${sessionId}/mfa`, { code });
  } catch (e) {
    if (e.payload?.errors) showFieldErrors(e.payload.errors);
    else showTopError(e.message);
    $('mfaBtn').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadCarriers();
  $('username').addEventListener('input', validateLoginInputs);
  $('password').addEventListener('input', validateLoginInputs);
  $('mfaCode').addEventListener('input', validateMfaInputs);
  $('loginBtn').addEventListener('click', () => {
    if (sessionId) resetForNewSession();
    startLogin();
  });
  $('mfaBtn').addEventListener('click', submitMfa);
});
