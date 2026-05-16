import { setStatus, setProgress, attachBrowser } from '../sessions.js';
import * as runtime from '../runtime/playwright.js';
import {
  raceForSettle,
  dumpDebug,
  dismissCookieBanner,
  REAL_CONTEXT_OPTIONS,
  userKeyFor,
  thinkTime,
  makeLog,
  safeClick,
  safeFill,
  prefetchAndSave,
} from './_shared.js';

const LOGIN_URL = 'https://www.lemonade.com/login';
const STEP_TIMEOUT_MS = 30_000;

// Lemonade-specific error texts, taken from the i18n bundle embedded in the page.
// We match against rendered body text (not class names) because Lemonade keeps
// an empty error placeholder DIV in the DOM at all times, which would otherwise
// trigger a false positive.
const LEMONADE_ERROR_TEXT_PATTERNS = [
  /wrong\s+code/i,
  /code\s+has\s+expired/i,
  /can[’']?t\s+login/i,
  /something\s+went\s+wrong/i,
  /sorry,\s+we\s+couldn/i,        // "Sorry, we couldn't find your email..."
  /session\s+has\s+expired/i,
  /doesn[’']?t\s+look\s+like\s+a\s+valid\s+email/i,
];

// Lemonade's customer dashboard typically keeps account/policy options behind
// a profile menu (revealed by clicking the user's name button). Try to open it.
async function tryOpenProfileMenu(page, log, session) {
  const candidates = [
    page.getByRole('button').filter({ hasText: /\b(ishaan|account|profile|me)\b/i }).first(),
    page.locator('button[aria-label*="account" i], button[aria-label*="profile" i], button[aria-label*="menu" i]').first(),
    page.locator('[data-testid*="profile" i], [data-testid*="account" i]').first(),
  ];
  for (const c of candidates) {
    const v = await c.isVisible({ timeout: 1_000 }).catch(() => false);
    if (v) {
      log('clicking profile/account menu candidate');
      await c.click({ timeout: 3_000 }).catch((e) => log('profile-menu click failed', e?.message));
      await page.waitForTimeout(800);
      await dumpDebug(page, session, '04b-profile-menu-open');
      await pageSnapshot(page, log, 'profile-menu-open', { withAnchors: true });
      return true;
    }
  }
  log('no profile-menu button found');
  return false;
}

async function waitForOtpResult(page, log, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!/\/login/.test(page.url())) return { ok: true };
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    for (const re of LEMONADE_ERROR_TEXT_PATTERNS) {
      const m = text.match(re);
      if (m) {
        log(`OTP error text matched: "${m[0]}"`);
        return { ok: false, error: m[0] };
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, error: 'Timed out waiting for OTP result' };
}

const OTP_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"][maxlength="1"]',
  'input[maxlength="1"][type="text"]',
  'input[maxlength="1"]',
  'input[type="tel"]',
  'input[inputmode="numeric"]',
];

const DOC_ACCEPT_TEXT = /^\s*(view\s+)?(policy\s+)?documents?\s*$|declaration|certificate|^\s*coverage\s+(forms?|documents?)/i;
const DOC_ACCEPT_HREF = /\/(documents?|declarations?|coverage|certificate)|\.pdf(\?|$)/i;
const DOC_REJECT = /privacy|opt[-\s]?out|do\s+not\s+sell|terms|legal|cookie|careers?|contact|sitemap|press|giveback|claim|payment/i;

// ----- diagnostic helpers --------------------------------------------------

function wireDiagnosticEvents(page, log) {
  page.on('console', (msg) => {
    const t = msg.text();
    if (!t) return;
    log(`[browser:${msg.type()}]`, t.slice(0, 280));
  });
  page.on('pageerror', (err) => {
    log(`[browser:pageerror]`, err.message);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) log(`[nav] -> ${frame.url()}`);
  });
  page.on('response', (resp) => {
    const url = resp.url();
    const status = resp.status();
    const method = resp.request().method();
    if (/\.(png|jpe?g|svg|gif|webp|ico|css|woff2?|ttf)(\?|$)/i.test(url)) return;
    if (/google|sentry|datadog|segment|optimizely|hotjar|fullstory/i.test(url)) return;
    if (status >= 400 || method !== 'GET' || /api|graphql|login|otp|auth|signin/i.test(url)) {
      log(`[net] ${status} ${method} ${url.slice(0, 160)}`);
    }
  });
  page.on('requestfailed', (req) => {
    log(`[net:failed] ${req.method()} ${req.url().slice(0, 160)} -> ${req.failure()?.errorText}`);
  });
}

async function pageSnapshot(page, log, label, { withAnchors = false } = {}) {
  try {
    const data = await page.evaluate((withAnchorsArg) => {
      const inputs = Array.from(document.querySelectorAll('input')).map((el) => ({
        type: el.type || null,
        id: el.id || null,
        name: el.name || null,
        placeholder: el.placeholder || null,
        autocomplete: el.autocomplete || null,
        maxLength: el.maxLength === -1 ? null : el.maxLength,
        inputMode: el.getAttribute('inputmode') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        dataAtnId: el.getAttribute('data-atn-id') || null,
        disabled: el.disabled,
        visible: el.offsetParent !== null,
        valueLen: (el.value || '').length,
      }));
      const buttons = Array.from(document.querySelectorAll('button, a[role="button"]')).map((b) => ({
        text: (b.textContent || '').trim().slice(0, 60),
        type: b.getAttribute('type') || null,
        dataAtnId: b.getAttribute('data-atn-id') || null,
        ariaLabel: b.getAttribute('aria-label') || null,
        visible: b.offsetParent !== null,
        disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
      }));
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((h) => (h.textContent || '').trim().slice(0, 120))
        .filter(Boolean);
      const visibleText = (document.body.innerText || '').slice(0, 3000);
      let anchors = null;
      if (withAnchorsArg) {
        anchors = Array.from(document.querySelectorAll('a')).map((a) => ({
          text: (a.textContent || '').trim().slice(0, 80),
          href: (a.href || '').slice(0, 160),
          visible: a.offsetParent !== null,
        })).filter((a) => a.href && a.text);
      }
      return { url: location.href, title: document.title, inputs, buttons, headings, visibleText, anchors };
    }, withAnchors);
    log(`[snap:${label}] url=${data.url} title=${JSON.stringify(data.title)}`);
    log(`[snap:${label}] headings:`, data.headings);
    log(`[snap:${label}] inputs (${data.inputs.length}):`, data.inputs);
    log(`[snap:${label}] buttons (${data.buttons.length}):`, data.buttons.filter((b) => b.visible));
    log(`[snap:${label}] body text (3000 chars):`, data.visibleText.replace(/\s+/g, ' '));
    if (withAnchors && data.anchors) {
      log(`[snap:${label}] anchors (${data.anchors.length}, visible-only shown):`,
        data.anchors.filter((a) => a.visible));
    }
  } catch (e) {
    log(`[snap:${label}] failed:`, e?.message);
  }
}

async function startStatePoller(page, log, durationMs = 20_000) {
  const start = Date.now();
  let lastUrl = null;
  let lastSig = null;
  let stop = false;
  const handle = (async () => {
    while (!stop && Date.now() - start < durationMs) {
      try {
        const url = page.url();
        const counts = await page.evaluate(() => ({
          inputs: document.querySelectorAll('input').length,
          buttons: document.querySelectorAll('button').length,
          disabledEmails: document.querySelectorAll('input[type="email"][disabled]').length,
          maxlen1: document.querySelectorAll('input[maxlength="1"]').length,
          oneTimeCode: document.querySelectorAll('input[autocomplete="one-time-code"]').length,
        }));
        const sig = JSON.stringify(counts);
        if (url !== lastUrl || sig !== lastSig) {
          log(`[poll t=${Date.now() - start}ms]`, { url, ...counts });
          lastUrl = url;
          lastSig = sig;
        }
      } catch (e) {
        // page closed or navigating
      }
      await new Promise((r) => setTimeout(r, 750));
    }
  })();
  return { stop: () => { stop = true; }, done: handle };
}

// --------------------------------------------------------------------------

export async function run(session) {
  const log = makeLog(`[lemonade ${session.id.slice(0, 8)}]`);
  let context = null;
  let page = null;
  try {
    const profileKey = userKeyFor(session.carrier, session.username);
    log('launching persistent Chrome', { profileKey, headless: process.env.HEADFUL !== '1' });
    context = await runtime.newPersistentContext(profileKey, REAL_CONTEXT_OPTIONS);
    page = context.pages()[0] || (await context.newPage());
    attachBrowser(session, context, page);
    wireDiagnosticEvents(page, log);

    setProgress(session, { stage: 'opening_login' });
    log('goto login', { url: LOGIN_URL });
    await page.goto(LOGIN_URL, { timeout: STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await dismissCookieBanner(page);
    log('after goto', { currentUrl: page.url(), title: await page.title().catch(() => '') });
    await dumpDebug(page, session, '01-login-page');
    await pageSnapshot(page, log, 'after-goto');

    const alreadyLoggedIn = !/\/login/.test(page.url());
    log(`alreadyLoggedIn = ${alreadyLoggedIn}`);

    let needsMfa = false;
    if (!alreadyLoggedIn) {
      setProgress(session, { stage: 'submitting_credentials' });
      const emailInput = page.locator('input[type="email"]').first();
      await emailInput.waitFor({ timeout: STEP_TIMEOUT_MS });
      log('email input present');
      await thinkTime(page, 300, 700);
      await safeFill(log, emailInput, session.username, 'email');
      await thinkTime(page, 200, 500);

      const loginBtn = page.getByRole('button', { name: /^\s*log\s*in\s*$/i }).first();
      log('submitting email');
      await safeClick(log, loginBtn, 'email-submit');

      // Start polling the page state in the background so we see DOM changes
      // even while the OTP-page race is waiting.
      const poller = await startStatePoller(page, log, 22_000);

      // Periodic dumps so user can scroll through visual states.
      const dumps = [
        setTimeout(() => dumpDebug(page, session, '02a-click+2s').catch(() => {}), 2_000),
        setTimeout(() => dumpDebug(page, session, '02b-click+5s').catch(() => {}), 5_000),
        setTimeout(() => dumpDebug(page, session, '02c-click+10s').catch(() => {}), 10_000),
      ];

      log('waiting for OTP page (up to 20s)');
      await Promise.race([
        page.getByText(/check your phone|please check your inbox|enter.*pass\s*code|enter.*code|sent.*code|verification code/i).first().waitFor({ timeout: 20_000 }),
        page.getByText(/send.*pass\s*code|didn[’']?t get it/i).first().waitFor({ timeout: 20_000 }),
        page.locator('input[autocomplete="one-time-code"]').first().waitFor({ timeout: 20_000 }),
        page.locator('input[maxlength="1"]').first().waitFor({ timeout: 20_000 }),
      ]).catch((e) => log('OTP-page wait timed out (no positive signal seen)', { msg: e?.message }));

      poller.stop();
      for (const t of dumps) clearTimeout(t);
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
      await dumpDebug(page, session, '02-after-email');
      await pageSnapshot(page, log, 'after-email-wait');

      log('looking for OTP inputs');
      let otpInputs = null;
      let otpCount = 0;
      let usedSelector = null;
      for (const sel of OTP_INPUT_SELECTORS) {
        const loc = page.locator(sel);
        const n = await loc.count().catch(() => 0);
        log(`  selector "${sel}" -> ${n} match(es)`);
        if (n > 0) { otpInputs = loc; otpCount = n; usedSelector = sel; break; }
      }
      const otpHeadingVisible = await page
        .getByText(/check your phone|please check your inbox|enter.*pass\s*code|enter.*code|sent.*code|verification code/i)
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false);
      log(`OTP heading visible: ${otpHeadingVisible}, otpCount: ${otpCount}, selector: ${usedSelector}`);

      needsMfa = otpCount > 0 || otpHeadingVisible;
      if (!needsMfa) {
        throw new Error(
          `Did not find OTP/passcode UI after email submit. Page: ${page.url()}. ` +
          `Likely Lemonade rate-limited the email (try again in ~15 minutes), or layout changed. ` +
          `See ./dumps/${session.id}/ for screenshots at +2s/+5s/+10s.`,
        );
      }

      setStatus(session, 'awaiting_mfa', { mfaRequired: true });
      setProgress(session, { stage: 'awaiting_mfa' });
      log('awaiting OTP code from user');
      const code = await session._mfaPromise;
      if (!code) throw new Error('No MFA code received.');
      log(`OTP code received (length=${code.length})`);

      setStatus(session, 'fetching_docs', { mfaRequired: false });
      setProgress(session, { stage: 'verifying_code' });
      await thinkTime(page, 200, 500);

      // Always use keyboard.type after focusing the first box. This fires real
      // keydown/keypress/input events which React controlled components
      // (including Lemonade's OTP component with auto-advance) handle reliably.
      // Per-box .fill() can confuse controlled components on re-render.
      if (otpInputs) {
        log(`focusing first of ${otpCount} OTP box(es) and typing ${code.length} char(s) with auto-advance`);
        await otpInputs.first().click();
        await thinkTime(page, 100, 250);
        for (const ch of code) {
          await page.keyboard.type(ch, { delay: 90 + Math.random() * 100 });
        }
      } else {
        log('no OTP selector matched; falling back to first visible input');
        const fallback = page.locator('input').first();
        await fallback.click();
        for (const ch of code) {
          await page.keyboard.type(ch, { delay: 90 + Math.random() * 100 });
        }
      }

      // After typing, Lemonade typically auto-submits. If a verify button is
      // visible, click it. Then poll URL+text for either success or specific
      // Lemonade error text. We do NOT use class-based error selectors here
      // because Lemonade keeps an empty .ErrorLine__StyledError placeholder
      // in the DOM (with just a "Notice" SVG title), which would false-positive.
      const verifyBtn = page.getByRole('button', { name: /verify|continue|submit|next/i }).first();
      const verifyVisible = await verifyBtn.isVisible({ timeout: 1_500 }).catch(() => false);
      log(`verify button visible: ${verifyVisible}`);
      if (verifyVisible) {
        await safeClick(log, verifyBtn, 'otp-verify');
      }

      log('polling for OTP result (URL change or known error text, up to 30s)');
      const otpRes = await waitForOtpResult(page, log, STEP_TIMEOUT_MS);
      log('OTP result', otpRes);
      if (!otpRes.ok) {
        await pageSnapshot(page, log, 'after-otp-fail');
        throw new Error(`OTP submit failed: ${otpRes.error}`);
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-login', { url: page.url() });
      await dumpDebug(page, session, '03-post-login');
      await pageSnapshot(page, log, 'post-login');
    } else {
      log('skipping login (persistent session valid)');
      setStatus(session, 'fetching_docs', { mfaRequired: false });
    }

    setProgress(session, { stage: 'discovering_policies' });
    log('discovering documents', { url: page.url() });
    await dumpDebug(page, session, '04-account-home');
    await pageSnapshot(page, log, 'account-home', { withAnchors: true });

    const documents = await discoverDocs(page, session, log);
    log(`discovered ${documents.length} document(s)`);
    if (documents.length === 0) {
      throw new Error('No documents discovered. Inspect ./dumps/' + session.id + ' to see page state.');
    }
    setProgress(session, { stage: 'done', totalDocs: documents.length });
    setStatus(session, 'done', { documents });
    log('done');

    // All docs were pre-fetched to local files during discoverDocs. Close the
    // persistent context to release the Chrome profile-singleton lock so the
    // next session for this user can launch immediately.
    if (context) {
      await context.close().catch(() => {});
      attachBrowser(session, null, null);
      log('persistent context closed (profile lock released)');
    }
  } catch (err) {
    log('ERROR ' + err.message);
    const dir = await dumpDebug(page, session, 'error');
    const detail = dir ? ` (debug dump: ${dir})` : '';
    setStatus(session, 'failed', { error: `${err.message}${detail}` });
    if (context) {
      await context.close().catch(() => {});
      attachBrowser(session, null, null);
    }
  }
}

async function discoverDocs(page, session, log) {
  // API-ONLY discovery. The dashboard itself fetches this endpoint to render
  // policies. The persistent context's auth cookies authenticate the call.
  // No HTML fallback / marketing-link scanning per user preference — if the
  // API yields nothing, we return nothing rather than guessing.
  const POLICIES_API = 'https://my.lemonade.com/api/v1/web_dashboard/accounts/home/policies';
  let policies = [];
  let rawBody = null;
  try {
    log(`GET ${POLICIES_API}`);
    const resp = await page.context().request.get(POLICIES_API);
    log(`policies API: status=${resp.status()}`);
    if (resp.ok()) {
      rawBody = await resp.json().catch(() => null);
      log('policies API body (first 2500 chars):', JSON.stringify(rawBody, null, 2)?.slice(0, 2500));

      // Real Lemonade shape: { data: { title: "my policies", items: { "LP...": {...} } } }
      // — items is an OBJECT keyed by policy id, NOT an array. Convert via Object.values.
      if (rawBody?.data?.items && typeof rawBody.data.items === 'object' && !Array.isArray(rawBody.data.items)) {
        policies = Object.values(rawBody.data.items).filter((p) => p && p.is_policy);
      } else if (Array.isArray(rawBody)) {
        policies = rawBody;
      } else if (rawBody && Array.isArray(rawBody.policies)) {
        policies = rawBody.policies;
      } else if (rawBody && Array.isArray(rawBody.data)) {
        policies = rawBody.data;
      } else if (rawBody?.data?.items && Array.isArray(rawBody.data.items)) {
        policies = rawBody.data.items.filter((p) => p && p.is_policy);
      }
    }
  } catch (e) {
    log('policies API call failed:', e?.message);
  }

  log(`policies extracted from API: ${policies.length}`);

  if (policies.length === 0) {
    log('top-level keys for debugging:', rawBody ? Object.keys(rawBody) : null);
    return [];
  }

  // Each active policy becomes one document entry. `form_url` is Lemonade's
  // icebox token URL — the actual policy form PDF the user wants.
  // We PRE-FETCH each form_url via the authenticated context so the doc bytes
  // are stored locally and the persistent context can be closed afterwards
  // (releasing the profile-singleton lock for the next session).
  const ctx = page.context();
  const docs = [];
  for (const p of policies) {
    const id = p.id || p.public_id || p.policy_id || 'unknown';
    const type = p.humanized_type || p.coverage_type || 'Policy';
    const state = p.state ? ` (${p.state})` : '';
    const addr = p.address ? ` — ${p.address}` : '';
    const name = `${type} Policy ${id}${state}${addr}`;
    const sourceUrl = p.form_url || p.documents_url || p.url || null;
    log(`policy ${id}: type=${type}, state=${p.state || 'n/a'}, status=${p.status || 'n/a'}, form_url=${sourceUrl}`);

    let localPath = null;
    if (sourceUrl) {
      localPath = await prefetchAndSave(ctx, sourceUrl, session.id, `${id}-${(type || 'policy').toLowerCase()}-policy`);
      if (localPath) log(`  pre-fetched -> ${localPath}`);
      else log(`  pre-fetch failed (will fall back to live context.request at click time if available)`);
    }

    docs.push({
      id: `policy-${id}`,
      name,
      policyId: String(id),
      policyLabel: 'Lemonade',
      sourceUrl,
      localPath,
    });
  }
  log(`returning ${docs.length} document(s) from API`);
  return docs;
}
