import { setStatus, setProgress, attachBrowser } from '../sessions.js';
import * as runtime from '../runtime/playwright.js';
import {
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
const POLICIES_API = 'https://my.lemonade.com/api/v1/web_dashboard/accounts/home/policies';
const STEP_TIMEOUT_MS = 30_000;

// Lemonade keeps an empty error placeholder DIV in its OTP page that would
// false-positive any class-based error race. We match on rendered body text
// against the carrier's actual i18n error strings instead.
const ERROR_TEXT_PATTERNS = [
  /wrong\s+code/i,
  /code\s+has\s+expired/i,
  /can[’']?t\s+login/i,
  /something\s+went\s+wrong/i,
  /sorry,\s+we\s+couldn/i,
  /session\s+has\s+expired/i,
  /doesn[’']?t\s+look\s+like\s+a\s+valid\s+email/i,
];

const OTP_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"][maxlength="1"]',
  'input[maxlength="1"][type="text"]',
  'input[maxlength="1"]',
  'input[type="tel"]',
  'input[inputmode="numeric"]',
];

async function waitForOtpResult(page, log, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!/\/login/.test(page.url())) return { ok: true };
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    for (const re of ERROR_TEXT_PATTERNS) {
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

    setProgress(session, { stage: 'opening_login' });
    log('goto login', { url: LOGIN_URL });
    await page.goto(LOGIN_URL, { timeout: STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await dismissCookieBanner(page);
    log('after goto', { currentUrl: page.url() });
    await dumpDebug(page, session, '01-login-page');

    const alreadyLoggedIn = !/\/login/.test(page.url());
    log(`alreadyLoggedIn = ${alreadyLoggedIn}`);

    if (!alreadyLoggedIn) {
      setProgress(session, { stage: 'submitting_credentials' });
      const emailInput = page.locator('input[type="email"]').first();
      await emailInput.waitFor({ timeout: STEP_TIMEOUT_MS });
      await thinkTime(page, 300, 700);
      await safeFill(log, emailInput, session.username, 'email');
      await thinkTime(page, 200, 500);

      log('submitting email');
      const loginBtn = page.getByRole('button', { name: /^\s*log\s*in\s*$/i }).first();
      await safeClick(log, loginBtn, 'email-submit');

      // Lemonade is a SPA: URL stays on /login#email and the OTP step is
      // rendered in place. Wait for the first reliable OTP-page signal.
      log('waiting for OTP page (up to 20s)');
      await Promise.race([
        page.getByText(/check your phone|please check your inbox|enter.*pass\s*code|enter.*code|sent.*code|verification code/i).first().waitFor({ timeout: 20_000 }),
        page.getByText(/send.*pass\s*code|didn[’']?t get it/i).first().waitFor({ timeout: 20_000 }),
        page.locator('input[autocomplete="one-time-code"]').first().waitFor({ timeout: 20_000 }),
        page.locator('input[maxlength="1"]').first().waitFor({ timeout: 20_000 }),
      ]).catch((e) => log('OTP-page wait timed out', { msg: e?.message }));
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
      await dumpDebug(page, session, '02-after-email');

      let otpInputs = null;
      let otpCount = 0;
      for (const sel of OTP_INPUT_SELECTORS) {
        const loc = page.locator(sel);
        const n = await loc.count().catch(() => 0);
        if (n > 0) { otpInputs = loc; otpCount = n; break; }
      }
      const otpHeadingVisible = await page
        .getByText(/check your phone|please check your inbox|enter.*pass\s*code|enter.*code|sent.*code|verification code/i)
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false);
      log(`OTP detection: count=${otpCount}, headingVisible=${otpHeadingVisible}`);

      if (otpCount === 0 && !otpHeadingVisible) {
        throw new Error(
          `Did not find OTP UI after email submit (page: ${page.url()}). ` +
          `Lemonade may have rate-limited this email — try again in ~15 minutes.`,
        );
      }

      setStatus(session, 'awaiting_mfa', { mfaRequired: true });
      setProgress(session, { stage: 'awaiting_mfa' });
      log('awaiting OTP code from user');
      const code = await session._mfaPromise;
      if (!code) throw new Error('No MFA code received.');

      setStatus(session, 'fetching_docs', { mfaRequired: false });
      setProgress(session, { stage: 'verifying_code' });
      await thinkTime(page, 200, 500);

      // Real keyboard events drive Lemonade's controlled OTP component's
      // auto-advance correctly; per-box .fill() can confuse the component on
      // re-render.
      const target = otpInputs ? otpInputs.first() : page.locator('input').first();
      await target.click();
      await thinkTime(page, 100, 250);
      for (const ch of code) {
        await page.keyboard.type(ch, { delay: 90 + Math.random() * 100 });
      }

      // Lemonade typically auto-submits when the OTP is complete; click an
      // explicit verify button only if one is rendered.
      const verifyBtn = page.getByRole('button', { name: /verify|continue|submit|next/i }).first();
      if (await verifyBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await safeClick(log, verifyBtn, 'otp-verify');
      }

      const otpRes = await waitForOtpResult(page, log, STEP_TIMEOUT_MS);
      log('OTP result', otpRes);
      if (!otpRes.ok) throw new Error(`OTP submit failed: ${otpRes.error}`);

      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-login', { url: page.url() });
      await dumpDebug(page, session, '03-post-login');
    } else {
      setStatus(session, 'fetching_docs', { mfaRequired: false });
    }

    setProgress(session, { stage: 'discovering_policies' });
    log('discovering documents', { url: page.url() });
    await dumpDebug(page, session, '04-account-home');

    const documents = await discoverDocs(page, session, log);
    log(`discovered ${documents.length} document(s)`);
    if (documents.length === 0) {
      throw new Error(`No documents discovered. Inspect ./dumps/${session.id}/.`);
    }
    setProgress(session, { stage: 'done', totalDocs: documents.length });
    setStatus(session, 'done', { documents });
    log('done');

    // Documents are persisted to disk during discovery; close the context to
    // release the profile-singleton lock for the next session.
    if (context) {
      await context.close().catch(() => {});
      attachBrowser(session, null, null);
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

// Lemonade's dashboard calls this endpoint to render its policy list — we hit
// it directly so discovery is API-driven, not HTML-driven. The response shape
// is `{ data: { items: { "LP...": {policy}, ... } } }` (object keyed by id).
async function discoverDocs(page, session, log) {
  let policies = [];
  let rawBody = null;
  try {
    log(`GET ${POLICIES_API}`);
    const resp = await page.context().request.get(POLICIES_API);
    log(`policies API: status=${resp.status()}`);
    if (resp.ok()) {
      rawBody = await resp.json().catch(() => null);
      if (rawBody?.data?.items && typeof rawBody.data.items === 'object' && !Array.isArray(rawBody.data.items)) {
        policies = Object.values(rawBody.data.items).filter((p) => p && p.is_policy);
      } else if (Array.isArray(rawBody)) {
        policies = rawBody;
      } else if (rawBody && Array.isArray(rawBody.policies)) {
        policies = rawBody.policies;
      } else if (rawBody && Array.isArray(rawBody.data)) {
        policies = rawBody.data;
      }
    }
  } catch (e) {
    log('policies API call failed:', e?.message);
  }

  log(`policies extracted: ${policies.length}`);
  if (policies.length === 0) return [];

  // Each policy has `form_url`: a token-signed icebox URL pointing at the
  // policy PDF. Pre-fetch via the authenticated context and save locally so
  // the persistent context can be closed afterwards.
  const ctx = page.context();
  const docs = [];
  for (const p of policies) {
    const id = p.id || p.public_id || p.policy_id || 'unknown';
    const type = p.humanized_type || p.coverage_type || 'Policy';
    const state = p.state ? ` (${p.state})` : '';
    const addr = p.address ? ` — ${p.address}` : '';
    const name = `${type} Policy ${id}${state}${addr}`;
    const sourceUrl = p.form_url || p.documents_url || p.url || null;
    log(`policy ${id}: type=${type}, state=${p.state || 'n/a'}, status=${p.status || 'n/a'}`);

    let localPath = null;
    if (sourceUrl) {
      localPath = await prefetchAndSave(ctx, sourceUrl, session.id, `${id}-${type.toLowerCase()}-policy`);
      if (localPath) log(`  pre-fetched -> ${localPath}`);
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
  return docs;
}
