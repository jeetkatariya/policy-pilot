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

const LOGIN_URL = 'https://www.petsbest.com/customerportal/Account/login';
const DOCS_URL = 'https://www.petsbest.com/customerportal/account/downloaddocuments';
const STEP_TIMEOUT_MS = 30_000;

const MFA_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[name*="token" i]',
  'input[id*="code" i]',
  'input[placeholder*="code" i]',
];

// Pets Best names a user's policy documents as "Your <something>"
// ("Your Illness Policy", "Your Declarations Page"). Footer / nav / feature
// links never start with that prefix, so this filter cleanly separates them.
const DOC_ACCEPT_TEXT = /^\s*your\s+/i;
const DOC_ACCEPT_HREF = /\.pdf(\?|$)|\/document\/|\/policy-document/i;
const DOC_REJECT = /privacy|opt[-\s]?out|terms|legal|cookie|careers?|contact|sitemap|press|sign\s*out|log\s*out|claim|profile|settings|alert|notification|preference|message|subscribe|my\s+pets|my\s+account/i;

export async function run(session) {
  const log = makeLog(`[petsbest ${session.id.slice(0, 8)}]`);
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

    const alreadyLoggedIn = !/\/Account\/login/i.test(page.url());
    log(`alreadyLoggedIn = ${alreadyLoggedIn}`);
    await dumpDebug(page, session, '01-login-page');

    let needsMfa = false;

    if (!alreadyLoggedIn) {
      await page.locator('#Password').waitFor({ timeout: STEP_TIMEOUT_MS });
      await thinkTime(page, 400, 900);

      setProgress(session, { stage: 'submitting_credentials' });
      await safeFill(log, page.locator('#Username'), session.username, 'username');
      await thinkTime(page, 150, 400);
      await safeFill(log, page.locator('#Password'), session.password, 'password', { mask: true });
      await thinkTime(page, 250, 600);

      // Submit can be either a <button> or an <input type="submit" value="Log In">.
      // getByRole covers both shapes via accessible-name lookup.
      const submitCandidates = [
        page.locator('form#login-form').getByRole('button', { name: /^\s*log\s*in\s*$/i }).first(),
        page.locator('form#login-form input[type="submit"]').first(),
        page.locator('form#login-form button:has-text("Log In")').first(),
        page.getByRole('button', { name: /^\s*log\s*in\s*$/i }).first(),
      ];
      let submitBtn = null;
      for (const cand of submitCandidates) {
        if (await cand.isVisible().catch(() => false)) { submitBtn = cand; break; }
      }

      log('submitting login');
      if (submitBtn) {
        await safeClick(log, submitBtn, 'login-submit');
      } else {
        await page.evaluate(() => {
          const f = document.getElementById('login-form');
          if (f && typeof f.requestSubmit === 'function') f.requestSubmit();
          else if (f) f.submit();
        });
      }

      // Pets Best has transient role="alert" elements during navigation that
      // false-positive any class-based error race. Use URL-only success
      // detection and scrape body text only after the wait fails.
      try {
        await page.waitForURL((u) => !/\/Account\/login/i.test(u.toString()), {
          timeout: STEP_TIMEOUT_MS,
        });
      } catch (e) {
        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        const m = bodyText.match(/invalid|incorrect|wrong|locked|attempt.*later|password.*expired/i);
        throw new Error(`Login failed${m ? ': ' + bodyText.slice(0, 200).replace(/\s+/g, ' ') : ' (still on login page after submit)'}`);
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-login state', { url: page.url() });
      await dumpDebug(page, session, '02-post-login');

      const codeFieldVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
        .isVisible({ timeout: 3_000 }).catch(() => false);
      const mfaInUrl = /verify|mfa|2fa|otp|challenge|twofactor/i.test(page.url());
      needsMfa = codeFieldVisible || mfaInUrl;
      log('MFA detection', { codeFieldVisible, mfaInUrl, needsMfa });
    }

    if (needsMfa) {
      // Pets Best gates MFA behind a method-choice page (Text vs Email radios).
      // Auto-select Text/SMS and submit, then wait for the code-entry page.
      let codeInputVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
        .isVisible({ timeout: 1_500 }).catch(() => false);

      if (!codeInputVisible) {
        log('MFA method-choice page detected — auto-selecting SMS');
        await dumpDebug(page, session, '02b-mfa-method-choice');

        const smsCandidates = [
          page.getByLabel(/^\s*text\b/i),
          page.getByRole('radio', { name: /text|sms|phone/i }),
          page.locator('input[type="radio"]'),
        ];
        for (const c of smsCandidates) {
          if ((await c.count().catch(() => 0)) > 0) {
            await c.first().check({ timeout: 3_000 }).catch(() => {});
            break;
          }
        }
        await thinkTime(page, 200, 500);

        const methodSubmit = page.getByRole('button', { name: /submit|continue|send|next/i }).first();
        if ((await methodSubmit.count().catch(() => 0)) > 0) {
          await safeClick(log, methodSubmit, 'mfa-method-submit');
        } else {
          await page.evaluate(() => {
            const f = document.querySelector('form');
            if (f && typeof f.requestSubmit === 'function') f.requestSubmit();
            else if (f) f.submit();
          });
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
        await dumpDebug(page, session, '02c-after-method-choice');

        codeInputVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
          .isVisible({ timeout: 10_000 }).catch(() => false);
      }

      if (!codeInputVisible) {
        throw new Error(`Could not reach MFA code input. See ./dumps/${session.id}/ for state.`);
      }

      const mfaInput = page.locator(MFA_INPUT_SELECTORS.join(', ')).first();
      setStatus(session, 'awaiting_mfa', { mfaRequired: true });
      setProgress(session, { stage: 'awaiting_mfa' });
      log('awaiting MFA code from user');
      const code = await session._mfaPromise;
      if (!code) throw new Error('No MFA code received.');

      setStatus(session, 'fetching_docs', { mfaRequired: false });
      setProgress(session, { stage: 'verifying_code' });
      await thinkTime(page, 200, 500);
      await safeFill(log, mfaInput, code, 'mfa-code', { mask: true });
      await thinkTime(page, 200, 500);
      const codeSubmit = page.getByRole('button', { name: /verify|continue|submit|next/i }).first();
      const beforeUrl = page.url();
      await safeClick(log, codeSubmit, 'mfa-submit');
      try {
        await page.waitForURL((u) => u.toString() !== beforeUrl && !/verifyidentity/i.test(u.toString()), {
          timeout: STEP_TIMEOUT_MS,
        });
      } catch (e) {
        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        const m = bodyText.match(/invalid|incorrect|wrong|expired|attempt/i);
        throw new Error(`MFA failed${m ? ': ' + bodyText.slice(0, 200).replace(/\s+/g, ' ') : ' (no nav after code submit)'}`);
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-MFA state', { url: page.url() });
      await dumpDebug(page, session, '03-post-mfa');
    } else {
      setStatus(session, 'fetching_docs', { mfaRequired: false });
    }

    // Documents page URL is stable and was discovered in the public HTML, so
    // we can navigate to it directly instead of hunting for a nav link.
    setProgress(session, { stage: 'discovering_policies' });
    log('navigating to documents page', { url: DOCS_URL });
    await page.goto(DOCS_URL, { timeout: STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await dumpDebug(page, session, '04-documents-page');

    const documents = await discoverDocs(page, session, log);
    log(`discovered ${documents.length} document(s)`);
    if (documents.length === 0) {
      throw new Error(`No documents discovered. Inspect ./dumps/${session.id}/04-documents-page.html`);
    }
    setProgress(session, { stage: 'done', totalDocs: documents.length });
    setStatus(session, 'done', { documents });
    log('done');

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

async function discoverDocs(page, session, log) {
  const all = await page.$$eval('a', (anchors) =>
    anchors.map((a) => ({
      href: a.href || '',
      text: (a.textContent || '').trim(),
      visible: a.offsetParent !== null,
    })).filter((a) => a.href && a.text),
  );

  const accepted = [];
  for (const a of all) {
    if (!a.visible) continue;
    if (DOC_REJECT.test(a.text) || DOC_REJECT.test(a.href)) continue;
    if (DOC_ACCEPT_TEXT.test(a.text) || DOC_ACCEPT_HREF.test(a.href)) accepted.push(a);
  }
  log(`accepted doc links: ${accepted.length}`);

  // Pre-fetch each accepted doc through the authenticated context and persist
  // to disk so the persistent context can be closed after the run.
  const ctx = page.context();
  const seen = new Set();
  const docs = [];
  for (const d of accepted) {
    if (seen.has(d.href)) continue;
    seen.add(d.href);
    const baseName = d.text.replace(/\s+/g, '_').slice(0, 60) || `doc-${docs.length}`;
    const localPath = await prefetchAndSave(ctx, d.href, session.id, baseName);
    if (localPath) log(`  pre-fetched "${d.text}" -> ${localPath}`);
    docs.push({
      id: `doc-${docs.length}`,
      name: d.text,
      policyId: null,
      policyLabel: 'Pets Best',
      sourceUrl: d.href,
      localPath,
    });
  }
  return docs;
}
