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

const LOGIN_URL = 'https://www.petsbest.com/customerportal/Account/login';
const DOCS_URL = 'https://www.petsbest.com/customerportal/account/downloaddocuments';
const STEP_TIMEOUT_MS = 30_000;

// Classic ASP.NET MVC error containers + generic alert selectors.
const ERROR_SELECTORS = [
  '.validation-summary-errors',
  '.field-validation-error',
  '[role="alert"]',
  '.alert-danger',
  '.error-message',
];

const MFA_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[name*="token" i]',
  'input[id*="code" i]',
  'input[placeholder*="code" i]',
];

// Pets Best names a user's actual policy documents as "Your <something>"
// ("Your Illness Policy", "Your Declarations Page"). Anything that doesn't
// start with "Your" is footer / nav / feature link.
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
    log('after goto', { currentUrl: page.url(), title: await page.title().catch(() => '') });

    const alreadyLoggedIn = !/\/Account\/login/i.test(page.url());
    log(`alreadyLoggedIn = ${alreadyLoggedIn}`);
    await dumpDebug(page, session, '01-login-page');

    let needsMfa = false;

    if (!alreadyLoggedIn) {
      await page.locator('#Password').waitFor({ timeout: STEP_TIMEOUT_MS });
      log('login form present');
      await thinkTime(page, 400, 900);

      setProgress(session, { stage: 'submitting_credentials' });
      await safeFill(log, page.locator('#Username'), session.username, 'username');
      await thinkTime(page, 150, 400);
      await safeFill(log, page.locator('#Password'), session.password, 'password', { mask: true });
      await thinkTime(page, 250, 600);

      // Pets Best's submit may be a <button> OR an <input type="submit" value="Log In">.
      // getByRole matches both shapes; we probe a few explicit selectors and
      // pick the first visible match.
      const submitCandidates = [
        page.locator('form#login-form').getByRole('button', { name: /^\s*log\s*in\s*$/i }).first(),
        page.locator('form#login-form input[type="submit"]').first(),
        page.locator('form#login-form button:has-text("Log In")').first(),
        page.getByRole('button', { name: /^\s*log\s*in\s*$/i }).first(),
      ];
      let submitBtn = null;
      for (const cand of submitCandidates) {
        const count = await cand.count().catch(() => 0);
        const visible = count > 0 ? await cand.isVisible().catch(() => false) : false;
        log(`submit candidate matched=${count} visible=${visible}`);
        if (visible) { submitBtn = cand; break; }
      }

      log('submitting login');
      if (submitBtn) {
        await safeClick(log, submitBtn, 'login-submit');
      } else {
        log('no submit element matched — submitting form via JS');
        await page.evaluate(() => {
          const f = document.getElementById('login-form');
          if (f && typeof f.requestSubmit === 'function') f.requestSubmit();
          else if (f) f.submit();
        });
      }

      // Wait for navigation away from /Account/login. Do NOT race against
      // class-based error selectors — Pets Best has transient role=alert /
      // alert elements during navigation that fire false positives. Instead,
      // wait for the URL change and then verify by checking the new page.
      try {
        await page.waitForURL((u) => !/\/Account\/login/i.test(u.toString()), {
          timeout: STEP_TIMEOUT_MS,
        });
      } catch (e) {
        // No nav => still on login page => check for visible error text there.
        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        const m = bodyText.match(/invalid|incorrect|wrong|locked|attempt.*later|password.*expired/i);
        throw new Error(`Login failed${m ? ': ' + bodyText.slice(0, 200).replace(/\s+/g, ' ') : ' (still on login page after submit)'}`);
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-login state', { url: page.url(), title: await page.title().catch(() => '') });
      await dumpDebug(page, session, '02-post-login');

      // Detect whether we landed on MFA (either the method-choice page or
      // a code-entry page directly).
      const url = page.url();
      const mfaInput = page.locator(MFA_INPUT_SELECTORS.join(', ')).first();
      const codeFieldVisible = await mfaInput.isVisible({ timeout: 3_000 }).catch(() => false);
      const mfaInUrl = /verify|mfa|2fa|otp|challenge|twofactor/i.test(url);
      needsMfa = codeFieldVisible || mfaInUrl;
      log('MFA detection', { codeFieldVisible, mfaInUrl, needsMfa, url });
    }

    if (needsMfa) {
      // Step 1 of MFA (may be skipped if the code field is already on screen):
      // Pets Best's first MFA page asks the user to choose Text vs Email. We
      // auto-select Text (SMS) since the user has the phone in hand for the
      // demo, then click Submit. If a code input is already visible, we skip
      // this step.
      let codeInputVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
        .isVisible({ timeout: 1_500 }).catch(() => false);

      if (!codeInputVisible) {
        log('MFA method-choice page detected — auto-selecting SMS');
        await dumpDebug(page, session, '02b-mfa-method-choice');

        // Find SMS radio by label text containing "Text" (Pets Best's wording)
        // with fallbacks to a generic first radio.
        const smsCandidates = [
          page.getByLabel(/^\s*text\b/i),
          page.getByRole('radio', { name: /text|sms|phone/i }),
          page.locator('input[type="radio"]'),
        ];
        let picked = false;
        for (const c of smsCandidates) {
          const n = await c.count().catch(() => 0);
          log(`SMS-radio candidate matched=${n}`);
          if (n > 0) {
            await c.first().check({ timeout: 3_000 }).catch((e) => log('check failed', e?.message));
            picked = true;
            break;
          }
        }
        if (!picked) {
          log('no method-choice radio found — proceeding anyway');
        }
        await thinkTime(page, 200, 500);

        const methodSubmit = page.getByRole('button', { name: /submit|continue|send|next/i }).first();
        const ms = await methodSubmit.count().catch(() => 0);
        log(`method-submit button matched=${ms}`);
        if (ms > 0) {
          await safeClick(log, methodSubmit, 'mfa-method-submit');
        } else {
          // Try a form submit fallback if no clear button
          await page.evaluate(() => {
            const f = document.querySelector('form');
            if (f && typeof f.requestSubmit === 'function') f.requestSubmit();
            else if (f) f.submit();
          });
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
        log('post-method-choice', { url: page.url() });
        await dumpDebug(page, session, '02c-after-method-choice');

        // Now wait for the code input to render.
        codeInputVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
          .isVisible({ timeout: 10_000 }).catch(() => false);
        log(`code input visible after method choice: ${codeInputVisible}`);
      }

      if (!codeInputVisible) {
        throw new Error('Could not reach MFA code input. See ./dumps/' + session.id + '/ for state.');
      }

      const mfaInput = page.locator(MFA_INPUT_SELECTORS.join(', ')).first();
      setStatus(session, 'awaiting_mfa', { mfaRequired: true });
      setProgress(session, { stage: 'awaiting_mfa' });
      log('awaiting MFA code from user');
      const code = await session._mfaPromise;
      if (!code) throw new Error('No MFA code received.');
      log(`MFA code received (length=${code.length})`);

      setStatus(session, 'fetching_docs', { mfaRequired: false });
      setProgress(session, { stage: 'verifying_code' });
      await thinkTime(page, 200, 500);
      await safeFill(log, mfaInput, code, 'mfa-code', { mask: true });
      await thinkTime(page, 200, 500);
      const codeSubmit = page.getByRole('button', { name: /verify|continue|submit|next/i }).first();
      log('submitting MFA code');
      const beforeUrl = page.url();
      await safeClick(log, codeSubmit, 'mfa-submit');
      // Same approach as login: URL-based success detection only.
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

    // Navigate directly to the documents page. The URL is stable and was
    // discovered in the public HTML, so we don't need to hunt for a nav link.
    setProgress(session, { stage: 'discovering_policies' });
    log('navigating to documents page', { url: DOCS_URL });
    await page.goto(DOCS_URL, { timeout: STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    log('on documents page', { url: page.url() });
    await dumpDebug(page, session, '04-documents-page');

    const documents = await discoverDocs(page, session, log);
    log(`discovered ${documents.length} document(s)`);
    if (documents.length === 0) {
      throw new Error('No documents discovered on Pets Best documents page. Inspect ./dumps/' + session.id + '/04-documents-page.html');
    }
    setProgress(session, { stage: 'done', totalDocs: documents.length });
    setStatus(session, 'done', { documents });
    log('done');

    // Pets Best docs are pre-fetched to disk during discovery — close the
    // persistent context to release the profile-singleton lock.
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
  const all = await page.$$eval('a', (anchors) =>
    anchors.map((a) => ({
      href: a.href || '',
      text: (a.textContent || '').trim(),
      visible: a.offsetParent !== null,
    })).filter((a) => a.href && a.text),
  );
  log(`anchors on page = ${all.length}`);

  const accepted = [];
  const considered = [];
  for (const a of all) {
    if (!a.visible) continue;
    const rejected = DOC_REJECT.test(a.text) || DOC_REJECT.test(a.href);
    const match = DOC_ACCEPT_TEXT.test(a.text) || DOC_ACCEPT_HREF.test(a.href);
    if (match) {
      if (rejected) considered.push({ ...a, decision: 'rejected (footer/legal)' });
      else { accepted.push(a); considered.push({ ...a, decision: 'accepted' }); }
    }
  }
  log('candidate doc links:', considered.slice(0, 30));
  log(`accepted = ${accepted.length}`);

  if (accepted.length === 0) {
    log('NO DOC LINKS ACCEPTED — share ./dumps/' + session.id + '/04-documents-page.html for selector tuning.');
  }

  // Pre-fetch each accepted doc through the authenticated context. The bytes
  // are saved locally so the persistent context can be closed afterwards,
  // releasing the Chrome profile-singleton lock for the next session.
  const ctx = page.context();
  const seen = new Set();
  const docs = [];
  for (const d of accepted) {
    if (seen.has(d.href)) continue;
    seen.add(d.href);
    const baseName = d.text.replace(/\s+/g, '_').slice(0, 60) || `doc-${docs.length}`;
    const localPath = await prefetchAndSave(ctx, d.href, session.id, baseName);
    if (localPath) log(`  pre-fetched "${d.text}" -> ${localPath}`);
    else log(`  pre-fetch failed for "${d.text}"`);
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
