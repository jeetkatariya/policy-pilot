const $ = (id) => document.getElementById(id);
const POLL_MS = 500;

let sessionId = null;
let pollTimer = null;
let carriers = [];                 // metadata loaded from /api/carriers
let lastSubmittedCarrier = null;   // carrier id of the most recent submitted session
let currentCarrier = null;         // currently-selected dropdown value (tracks changes)

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

// ---------- status bar ---------------------------------------------------

const STAGE_TEXT = {
  opening_login:          'Opening carrier portal…',
  submitting_credentials: 'Submitting credentials…',
  awaiting_mfa:           'Awaiting your verification code…',
  verifying_code:         'Verifying code…',
  discovering_policies:   'Discovering policies…',
  fetching_policy_docs:   'Fetching documents…',
  done:                   'Done',
};

function setStatus({ tone = 'idle', text = 'Ready', meta = '' } = {}) {
  const el = $('status');
  el.classList.remove('ok', 'warn', 'err');
  if (tone === 'ok')   el.classList.add('ok');
  if (tone === 'warn') el.classList.add('warn');
  if (tone === 'err')  el.classList.add('err');
  el.querySelector('.text').textContent = text;
  $('statusMeta').textContent = meta;
}

function renderStatusFromSnapshot(s) {
  // Tone
  let tone = 'warn';
  if (s.status === 'done') tone = 'ok';
  if (s.status === 'failed') tone = 'err';

  // Primary text
  const stage = s.progress?.stage;
  let text;
  if (s.status === 'failed') {
    text = 'Failed';
  } else if (s.status === 'done') {
    const n = s.documents?.length || 0;
    text = `Done — ${n} document${n === 1 ? '' : 's'}`;
  } else if (stage === 'fetching_policy_docs' && s.progress?.current && s.progress?.total) {
    text = `Fetching documents (${s.progress.current}/${s.progress.total})…`;
  } else if (stage && STAGE_TEXT[stage]) {
    text = STAGE_TEXT[stage];
  } else {
    text = 'Working…';
  }

  // Meta (right side): trusted-session note, or latency, or current stage
  const parts = [];
  if (s.status === 'done' && !s.mfaWasRequired) {
    parts.push('trusted session · no MFA needed');
  }
  if (s.status === 'done' && s.mfaToDoneMs != null) {
    parts.push(`mfa→docs ${s.mfaToDoneMs}ms`);
  }
  setStatus({ tone, text, meta: parts.join(' · ') });
}

// ---------- form helpers -------------------------------------------------

function selectedCarrierMeta() {
  const id = $('carrier').value;
  return carriers.find((c) => c.id === id) || null;
}

function clearFieldErrors(prefix) {
  document.querySelectorAll('.error').forEach((el) => {
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

function applyCarrierToForm(meta) {
  if (!meta) return;
  // Password visibility
  const wantsPwd = meta.requiresPassword !== false;
  $('passwordField').classList.toggle('hidden', !wantsPwd);
  if (!wantsPwd) $('password').value = '';

  // Username label + hint per carrier
  const labelEl = $('usernameLabel');
  const hintEl = $('usernameHint');
  if (meta.id === 'lemonade') {
    labelEl.textContent = 'Email';
    hintEl.textContent = 'Lemonade authenticates with email + a one-time SMS code (no password).';
    hintEl.classList.remove('hidden');
  } else {
    labelEl.textContent = 'Username';
    hintEl.textContent = '';
    hintEl.classList.add('hidden');
  }
  validateLoginInputs();
}

function validateLoginInputs() {
  const meta = selectedCarrierMeta();
  const u = $('username').value.trim();
  const p = $('password').value;
  const needsPwd = meta?.requiresPassword !== false;
  const ok = u.length > 0 && (!needsPwd || p.length > 0);
  $('loginBtn').disabled = !ok;
}

function validateMfaInputs() {
  $('mfaBtn').disabled = $('mfaCode').value.trim().length === 0;
}

// ---------- carrier change reset ----------------------------------------

function resetSessionState() {
  sessionId = null;
  stopPolling();
  $('mfaCard').classList.add('hidden');
  $('docsCard').classList.add('hidden');
  $('docList').innerHTML = '';
  // Clear ALL form fields when carrier changes — credentials for one carrier
  // don't apply to another. Only the dropdown selection is preserved.
  $('username').value = '';
  $('password').value = '';
  $('mfaCode').value = '';
  $('mfaBtn').disabled = true;
  clearFieldErrors();
  showTopError(null);
  setStatus({ tone: 'idle', text: 'Ready', meta: '' });
  validateLoginInputs();
}

function onCarrierChanged() {
  const newId = $('carrier').value;
  // Whenever the dropdown value changes, wipe all form fields + session state.
  // Same value re-selected = no-op (state persists).
  if (currentCarrier !== null && currentCarrier !== newId) {
    resetSessionState();
    lastSubmittedCarrier = null;
  }
  currentCarrier = newId;
  applyCarrierToForm(selectedCarrierMeta());
}

// ---------- session lifecycle -------------------------------------------

async function loadCarriers() {
  const list = await api('GET', '/api/carriers');
  carriers = list;
  const sel = $('carrier');
  for (const c of list) {
    const opt = document.createElement('option');
    opt.value = c.id;
    let label = c.name;
    if (c.disabled) label += ' (coming soon)';
    else if (c.experimental) label += ' (experimental)';
    opt.textContent = label;
    if (c.disabled) opt.disabled = true;
    sel.appendChild(opt);
  }
  applyCarrierToForm(selectedCarrierMeta());
  currentCarrier = $('carrier').value;
}

async function startLogin() {
  clearFieldErrors();
  showTopError(null);
  const meta = selectedCarrierMeta();
  const body = {
    carrier: $('carrier').value,
    username: $('username').value.trim(),
    password: meta?.requiresPassword !== false ? $('password').value : '',
  };
  $('loginBtn').disabled = true;
  setStatus({ tone: 'warn', text: 'Starting…' });
  try {
    const s = await api('POST', '/api/sessions', body);
    sessionId = s.id;
    lastSubmittedCarrier = body.carrier;
    renderStatusFromSnapshot(s);
    startPolling();
  } catch (e) {
    if (e.payload?.errors) showFieldErrors(e.payload.errors);
    else showTopError(e.message);
    $('loginBtn').disabled = false;
    setStatus({ tone: 'err', text: 'Failed to start' });
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!sessionId) return;
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
  renderStatusFromSnapshot(s);

  // Show Verification section ONLY if MFA was actually required.
  // (When session reuse / trusted-device skips MFA, never render it.)
  if (s.mfaWasRequired) {
    $('mfaCard').classList.remove('hidden');
    if (s.status === 'awaiting_mfa' && $('mfaCode') !== document.activeElement) {
      $('mfaCode').focus();
    }
  }

  if (s.status === 'done') {
    stopPolling();
    renderDocs(s.documents);
  }

  if (s.status === 'failed') {
    stopPolling();
    showTopError(s.error || 'Failed');
    $('loginBtn').disabled = false;
  }
}

function renderDocs(docs) {
  $('docsCard').classList.remove('hidden');
  const root = $('docList');
  root.innerHTML = '';
  if (!docs || docs.length === 0) {
    root.textContent = 'No documents found.';
    return;
  }
  const groups = new Map();
  for (const d of docs) {
    const key = d.policyId || d.policyLabel || '(policy)';
    if (!groups.has(key)) groups.set(key, { label: d.policyLabel || key, items: [] });
    groups.get(key).items.push(d);
  }
  for (const [, g] of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'policy-group';
    const h = document.createElement('h3');
    h.textContent = g.label;
    wrap.appendChild(h);
    const ul = document.createElement('ul');
    for (const d of g.items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = d.url;
      a.textContent = d.name;
      a.target = '_blank';
      a.rel = 'noopener';
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
  if (!code) { showFieldErrors([{ field: 'code', message: 'code required' }]); return; }
  $('mfaBtn').disabled = true;
  try {
    await api('POST', `/api/sessions/${sessionId}/mfa`, { code });
  } catch (e) {
    if (e.payload?.errors) showFieldErrors(e.payload.errors);
    else showTopError(e.message);
    $('mfaBtn').disabled = false;
  }
}

// ---------- wire up ------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  await loadCarriers();
  $('carrier').addEventListener('change', onCarrierChanged);
  $('username').addEventListener('input', validateLoginInputs);
  $('password').addEventListener('input', validateLoginInputs);
  $('mfaCode').addEventListener('input', validateMfaInputs);
  $('loginBtn').addEventListener('click', () => {
    // If user clicks Start again after a completed/failed run on the same carrier,
    // wipe state and start a new session.
    if (sessionId) resetSessionState();
    startLogin();
  });
  $('mfaBtn').addEventListener('click', submitMfa);
});
