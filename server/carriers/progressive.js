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
} from './_shared.js';

const LOGIN_URL = 'https://www.progressive.com/rp/login?cntgrp=A';
const STEP_TIMEOUT_MS = 30_000;

const ERROR_SELECTORS = [
  '[role="alert"]',
  '.alert-danger',
  '.error-message',
  '[data-testid*="error" i]',
  '[data-pgr-id*="error" i]',
  'p.error',
  'div.error',
];

const MFA_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[placeholder*="code" i]',
  'input[aria-label*="code" i]',
];

const SUBMIT_LOGIN_BUTTON = '[data-pgr-id="buttonSubmitLogin"]';
const USERNAME_INPUT = 'form#login input[placeholder="User ID"], form#login input[type="text"]';
const PASSWORD_INPUT = '#inputPassword';

// Accept: anchors whose visible text or href looks like a real policy document
// link — declarations, ID cards, policy contract, the literal word "documents".
// We don't match generic "policy" because Progressive's site is full of footer
// links containing that word.
const DOC_ACCEPT_TEXT = /^\s*(view\s+)?(policy\s+)?documents?\s*$|declarations?\s*page|id\s*cards?|policy\s+contract|coverage\s+(forms?|documents?)|policy\s+documents?/i;
const DOC_ACCEPT_HREF = /\/(documents?|declarations?|id-?cards?|policy-?docs?)(\/|\?|$)|\.pdf(\?|$)/i;

// Hard-reject footer/legal/marketing links that contain words like privacy,
// "do not sell", California residents, etc.
const DOC_REJECT = /privacy|opt[-\s]?out|do\s+not\s+sell|terms|legal|cookie|careers?|contact|residents?|advertising|accessibility|sitemap|press/i;

export async function run(session) {
  const log = makeLog(`[progressive ${session.id.slice(0, 8)}]`);
  let context = null;
  let page = null;
  try {
    const profileKey = userKeyFor(session.carrier, session.username);
    log('launching persistent Chrome', { profileKey, headless: process.env.HEADFUL !== '1' });
    context = await runtime.newPersistentContext(profileKey, REAL_CONTEXT_OPTIONS);
    page = context.pages()[0] || (await context.newPage());
    attachBrowser(session, context, page);

    setProgress(session, { stage: 'opening_login' });
    log('goto login page', { url: LOGIN_URL });
    await page.goto(LOGIN_URL, { timeout: STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await dismissCookieBanner(page);
    log('after goto', { currentUrl: page.url(), title: await page.title().catch(() => '') });

    const alreadyLoggedIn = !/\/access\/login/.test(page.url());
    log(`alreadyLoggedIn = ${alreadyLoggedIn}`);
    await dumpDebug(page, session, '01-login-page');

    if (!alreadyLoggedIn) {
      log('waiting for password field to appear');
      await page.locator(PASSWORD_INPUT).waitFor({ timeout: STEP_TIMEOUT_MS });
      log('password field present');
      await thinkTime(page, 400, 900);

      setProgress(session, { stage: 'submitting_credentials' });
      await safeFill(log, page.locator(USERNAME_INPUT), session.username, 'username');
      await thinkTime(page, 150, 400);
      await safeFill(log, page.locator(PASSWORD_INPUT), session.password, 'password', { mask: true });
      await thinkTime(page, 250, 600);

      // Confirm the submit button is present before kicking off the race.
      const submitBtn = page.locator(SUBMIT_LOGIN_BUTTON);
      const submitCount = await submitBtn.count();
      const submitVisible = submitCount > 0 ? await submitBtn.first().isVisible().catch(() => false) : false;
      const submitEnabled = submitCount > 0 ? await submitBtn.first().isEnabled().catch(() => false) : false;
      log('submit button state', { selector: SUBMIT_LOGIN_BUTTON, count: submitCount, visible: submitVisible, enabled: submitEnabled });
      if (submitCount === 0) {
        throw new Error(`Login submit button not found via "${SUBMIT_LOGIN_BUTTON}". Page DOM may have changed; check ./dumps/${session.id}/error.html.`);
      }

      log('submitting login');
      const loginRes = await raceForSettle(page, {
        urlPattern: (url) => !/\/access\/login/.test(url.toString()),
        errorSelectors: ERROR_SELECTORS,
        timeoutMs: STEP_TIMEOUT_MS,
        action: () => safeClick(log, submitBtn, 'login-submit'),
      });
      log('post-submit race settled', loginRes);
      if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.error}`);
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-login state', { url: page.url(), title: await page.title().catch(() => '') });
      await dumpDebug(page, session, '02-post-login');
    }

    // Detect MFA challenge — only meaningful if we just logged in.
    let needsMfa = false;
    if (!alreadyLoggedIn) {
      const mfaInput0 = page.locator(MFA_INPUT_SELECTORS.join(', ')).first();
      const visible = await mfaInput0.isVisible({ timeout: 4_000 }).catch(() => false);
      const inUrl = /verify|mfa|2fa|otp|challenge|security/i.test(page.url());
      needsMfa = visible || inUrl;
      log('MFA detection', { visible, inUrl, url: page.url(), needsMfa });
    } else {
      log('skipping MFA detection (persistent session already logged in)');
    }

    if (needsMfa) {
      const mfaInput = page.locator(MFA_INPUT_SELECTORS.join(', ')).first();
      setStatus(session, 'awaiting_mfa', { mfaRequired: true });
      setProgress(session, { stage: 'awaiting_mfa' });
      log('awaiting MFA code from user');
      const code = await session._mfaPromise;
      if (!code) throw new Error('No MFA code received.');
      log('MFA code received from user (length=' + code.length + ')');

      setStatus(session, 'fetching_docs', { mfaRequired: false });
      setProgress(session, { stage: 'verifying_code' });
      await thinkTime(page, 200, 500);
      await safeFill(log, mfaInput, code, 'mfa-code', { mask: true });
      await thinkTime(page, 200, 500);
      const submitBtn = page.getByRole('button', { name: /verify|continue|submit|next/i }).first();
      log('submitting MFA code');
      const mfaRes = await raceForSettle(page, {
        urlPattern: (url) => !/verify|mfa|2fa|otp|challenge/i.test(url.toString()),
        errorSelectors: ERROR_SELECTORS,
        timeoutMs: STEP_TIMEOUT_MS,
        action: () => safeClick(log, submitBtn, 'mfa-submit'),
      });
      log('post-MFA race settled', mfaRes);
      if (!mfaRes.ok) throw new Error(`MFA failed: ${mfaRes.error}`);
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-MFA state', { url: page.url() });
      await dumpDebug(page, session, '03-post-mfa');
    } else {
      setStatus(session, 'fetching_docs', { mfaRequired: false });
    }

    setProgress(session, { stage: 'discovering_policies' });
    log('discovering documents', { url: page.url() });
    await dumpDebug(page, session, '04-account-home');

    const documents = await discoverDocs(page, session, log);
    log(`discovered ${documents.length} document(s)`);
    if (documents.length === 0) {
      throw new Error('No documents discovered. Inspect ./dumps/' + session.id + ' to see page state.');
    }
    setProgress(session, { stage: 'done', totalDocs: documents.length });
    setStatus(session, 'done', { documents });
    log('done');
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
  // Try to find a clearly-labelled "Policy Documents" navigation link first.
  // Be specific: prefer link text that looks like "policy documents" / "view documents"
  // and avoid generic "documents" matches that might be footer-level.
  const docNavCandidates = [
    page.getByRole('link', { name: /^policy\s+documents?$/i }).first(),
    page.getByRole('link', { name: /^view\s+(policy\s+)?documents?$/i }).first(),
    page.locator('a[data-pgr-id*="document" i]').first(),
    page.locator('a[href*="/documents" i]').first(),
  ];
  for (const nav of docNavCandidates) {
    const visible = await nav.isVisible({ timeout: 1_500 }).catch(() => false);
    if (visible) {
      log('found documents nav candidate; clicking');
      await safeClick(log, nav, 'documents-nav');
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('navigated', { url: page.url() });
      await dumpDebug(page, session, '05-documents-page');
      break;
    }
  }

  // Scan every anchor; classify accept/reject; log everything so the user can
  // share the terminal output if discovery doesn't find the right links.
  const all = await page.$$eval('a', (anchors) =>
    anchors.map((a) => ({
      href: a.href || '',
      text: (a.textContent || '').trim(),
      dataId: a.getAttribute('data-pgr-id') || a.getAttribute('data-testid') || null,
    })).filter((a) => a.href && a.text),
  );
  log(`anchors on page = ${all.length}`);

  const accepted = [];
  const considered = [];
  for (const a of all) {
    const rejectedByPattern = DOC_REJECT.test(a.text) || DOC_REJECT.test(a.href);
    const matchText = DOC_ACCEPT_TEXT.test(a.text);
    const matchHref = DOC_ACCEPT_HREF.test(a.href);
    if (matchText || matchHref) {
      if (rejectedByPattern) {
        considered.push({ ...a, decision: 'rejected (privacy/legal)' });
      } else {
        accepted.push(a);
        considered.push({ ...a, decision: 'accepted' });
      }
    }
  }
  log(`candidate links (accepted + rejected):`, considered.slice(0, 30));
  log(`accepted = ${accepted.length}`);

  if (accepted.length === 0) {
    log('NO DOC LINKS ACCEPTED — share dumps/' + session.id + '/04-account-home.html (and any 05-documents-page.html) so selectors can be tightened.');
  }

  const seen = new Set();
  const docs = [];
  for (const d of accepted) {
    if (seen.has(d.href)) continue;
    seen.add(d.href);
    docs.push({
      id: `doc-${docs.length}`,
      name: d.text,
      policyId: null,
      policyLabel: 'Progressive',
      sourceUrl: d.href,
    });
  }
  return docs;
}
