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
} from './_shared.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as fs from 'node:fs/promises';

const LOGIN_URL = 'https://www.erenterplan.com/Account/SignIn';
const STEP_TIMEOUT_MS = 30_000;

const MFA_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[name*="token" i]',
  'input[id*="code" i]',
  'input[placeholder*="code" i]',
];

// Accept anything that looks like a user-facing policy document. eRenterPlan's
// naming convention is unverified — we tighten this on first credentialed run.
// Common policy-doc text patterns: "Declarations Page", "Policy", "Policy
// Booklet", "ID Card", "Certificate of Insurance".
const DOC_ACCEPT_TEXT = /declarations?\s*page|policy\s*(booklet|document|contract|jacket)|certificate\s*of\s*insurance|id\s*card|coverage\s*summary/i;
const DOC_ACCEPT_HREF = /\.pdf(\?|$)|\/document\/|\/policy-?document|\/declarations?\b/i;
const DOC_REJECT = /privacy|opt[-\s]?out|terms|legal|cookie|careers?|contact|sitemap|press|sign\s*out|log\s*out|claim|profile|settings|alert|notification|preference|message|subscribe|my\s+account|home\s*$/i;

export async function run(session) {
  const log = makeLog(`[erenterplan ${session.id.slice(0, 8)}]`);
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

    const alreadyLoggedIn = !/\/Account\/SignIn/i.test(page.url());
    log(`alreadyLoggedIn = ${alreadyLoggedIn}`);
    await dumpDebug(page, session, '01-login-page');

    let needsMfa = false;

    if (!alreadyLoggedIn) {
      await page.locator('#password').waitFor({ timeout: STEP_TIMEOUT_MS });
      log('login form present');
      await thinkTime(page, 400, 900);

      setProgress(session, { stage: 'submitting_credentials' });
      await safeFill(log, page.locator('#username'), session.username, 'username');
      await thinkTime(page, 150, 400);
      await safeFill(log, page.locator('#password'), session.password, 'password', { mask: true });
      await thinkTime(page, 250, 600);

      const submitBtn = page.locator('#signIn');
      log('submitting login');
      await safeClick(log, submitBtn, 'login-submit');

      // URL-only success detection: wait until we leave /Account/SignIn.
      // If we don't, scrape the page for an actual error message.
      try {
        await page.waitForURL((u) => !/\/Account\/SignIn/i.test(u.toString()), {
          timeout: STEP_TIMEOUT_MS,
        });
      } catch (e) {
        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        const m = bodyText.match(/invalid|incorrect|wrong|locked|attempt|password.*expired|not\s*found/i);
        throw new Error(`Login failed${m ? ': ' + bodyText.slice(0, 200).replace(/\s+/g, ' ') : ' (still on login page after submit)'}`);
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      log('post-login state', { url: page.url(), title: await page.title().catch(() => '') });
      await dumpDebug(page, session, '02-post-login');

      // MFA detection: either a code input is visible, or URL hints at challenge.
      const url = page.url();
      const codeFieldVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
        .isVisible({ timeout: 3_000 }).catch(() => false);
      const mfaInUrl = /verify|mfa|2fa|otp|challenge|twofactor/i.test(url);
      needsMfa = codeFieldVisible || mfaInUrl;
      log('MFA detection', { codeFieldVisible, mfaInUrl, needsMfa, url });
    }

    if (needsMfa) {
      // If a method-choice step is shown first (radio buttons, no code field),
      // auto-pick the first option and submit, then expect a code-entry page.
      let codeInputVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
        .isVisible({ timeout: 1_500 }).catch(() => false);
      if (!codeInputVisible) {
        log('possible MFA method-choice page; trying to pick a delivery method');
        await dumpDebug(page, session, '02b-mfa-method-choice');
        const radios = page.locator('input[type="radio"]');
        const n = await radios.count().catch(() => 0);
        log(`method-choice radios matched=${n}`);
        if (n > 0) {
          await radios.first().check({ timeout: 3_000 }).catch((e) => log('radio check failed', e?.message));
          await thinkTime(page, 200, 500);
          const next = page.getByRole('button', { name: /submit|continue|send|next/i }).first();
          await safeClick(log, next, 'mfa-method-submit').catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
          await dumpDebug(page, session, '02c-after-method-choice');
        }
        codeInputVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
          .isVisible({ timeout: 10_000 }).catch(() => false);
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
      const beforeUrl = page.url();
      log('submitting MFA code');
      await safeClick(log, codeSubmit, 'mfa-submit');
      try {
        await page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: STEP_TIMEOUT_MS });
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

    setProgress(session, { stage: 'discovering_policies' });
    log('discovering documents (dashboard -> policy -> modal flow)', { url: page.url() });

    const documents = await discoverDocs(page, session, log);
    log(`discovered ${documents.length} document(s)`);
    if (documents.length === 0) {
      throw new Error(
        'No documents discovered. Re-run with DEBUG_DUMP=1 then share ' +
        `./dumps/${session.id}/04a-dashboard.html, 04b-policy-1-detail.html, ` +
        'and 04c-policy-1-modal.html (if present) for selector tuning.',
      );
    }
    setProgress(session, { stage: 'done', totalDocs: documents.length });
    setStatus(session, 'done', { documents });
    log('done');

    // eRenterPlan docs are all captured to disk via the Playwright download
    // event (each has a localPath, not a sourceUrl). The doc proxy streams
    // them from disk, so we don't need the browser context alive any longer.
    // Close it now to release the persistent-profile lock so the next session
    // for this same user can run without "ProcessSingleton" conflict.
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

// eRenterPlan flow:
//   1. /Policy/Dashboard shows one or more policy cards
//   2. Each card navigates to a policy-detail page
//   3. Policy detail has a "Download Document" button that opens a MODAL
//   4. Modal lists the real docs (e.g., "Certificate of Insurance", "Insurance Packet")
async function discoverDocs(page, session, log) {
  // Step 1: make sure we're on the dashboard.
  if (!/\/Policy\/Dashboard/i.test(page.url())) {
    log('navigating to /Policy/Dashboard');
    await page.goto('https://www.erenterplan.com/Policy/Dashboard', {
      timeout: STEP_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
  }
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await dumpDebug(page, session, '04a-dashboard');
  log('on dashboard', { url: page.url() });

  // Step 2: locate policy URLs. Cards may be <a> elements or clickable divs.
  const dashAnchors = await page.$$eval('a', (anchors) =>
    anchors.map((a) => ({
      text: (a.textContent || '').trim().slice(0, 80),
      href: a.href || '',
      visible: a.offsetParent !== null,
    })).filter((a) => a.visible && a.href && a.text),
  );
  log('visible anchors on dashboard (first 20):', dashAnchors.slice(0, 20));

  const policyAnchors = dashAnchors.filter((a) =>
    /\/Policy\/(?!Dashboard|Add|Logout|SignIn|SignOut)/i.test(a.href) &&
    !/^(home|about|contact|faq|log\s*in|log\s*out|add\s+policy)$/i.test(a.text),
  );
  log(`policy-anchor candidates: ${policyAnchors.length}`, policyAnchors);

  let policyUrls = [...new Set(policyAnchors.map((a) => a.href))];

  // Fallback: cards may not be anchors but clickable React divs (no <a> href).
  // We find the policy-number text element and walk up its ancestor chain,
  // trying to click each one. SPA navigations don't fire DOMContentLoaded, so
  // we detect success by waiting for the URL to change.
  if (policyUrls.length === 0) {
    log('no policy anchors — trying click-based discovery on policy-number cards');
    const before = page.url();
    const numberLoc = page.locator(':text-matches("^\\\\s*\\\\d{8,10}\\\\s*$")').first();
    const numberCount = await numberLoc.count().catch(() => 0);
    log(`policy-number elements: ${numberCount}`);

    if (numberCount > 0) {
      // Log the ancestor chain so we know what the card structure looks like.
      const ancestorChain = await numberLoc.evaluate((el) => {
        const chain = [];
        let cur = el;
        while (cur && cur !== document.body && chain.length < 10) {
          chain.push({
            tag: cur.tagName.toLowerCase(),
            cls: (cur.getAttribute('class') || '').slice(0, 60),
            role: cur.getAttribute('role') || null,
            cursor: getComputedStyle(cur).cursor,
            hasOnclick: !!cur.onclick || cur.hasAttribute('onclick'),
          });
          cur = cur.parentElement;
        }
        return chain;
      }).catch(() => []);
      log('ancestor chain of policy-number element:', ancestorChain);

      // Try clicking each ancestor (and the number itself) until URL changes.
      const waitForNav = async (timeoutMs) =>
        page.waitForURL((u) => u.toString() !== before, { timeout: timeoutMs })
          .then(() => true).catch(() => false);

      let navigated = false;
      // Depth 0 = element itself; depth N = Nth ancestor
      for (let depth = 0; depth <= 6 && !navigated; depth++) {
        const target = depth === 0
          ? numberLoc
          : numberLoc.locator(`xpath=ancestor::*[${depth}]`);
        try {
          await target.click({ timeout: 2_500 });
          log(`clicked depth=${depth}`);
        } catch (e) {
          log(`depth=${depth} click error: ${e?.message?.slice(0, 120)}`);
          continue;
        }
        // Wait briefly for either a URL change or a network-idle (SPA fetch).
        navigated = await waitForNav(3_500);
        if (navigated) {
          log(`URL changed after depth=${depth} click ->`, page.url());
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
          policyUrls = [page.url()];
          break;
        }
      }
      if (!navigated) {
        log('no ancestor click triggered a navigation — dumping dashboard for inspection');
      }
    }
  }

  if (policyUrls.length === 0) {
    throw new Error('No policy cards found on eRenterPlan dashboard. Inspect ./dumps/' + session.id + '/04a-dashboard.html');
  }

  // Step 3 + 4: per-policy navigation + modal scrape.
  const allDocs = [];
  for (let i = 0; i < Math.min(policyUrls.length, 5); i++) {
    const url = policyUrls[i];
    log(`policy ${i + 1}/${policyUrls.length}: navigating to ${url}`);
    if (page.url() !== url) {
      await page.goto(url, { timeout: STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    }
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    await dumpDebug(page, session, `04b-policy-${i + 1}-detail`);
    log(`policy ${i + 1}: on detail`, { url: page.url() });

    // "Download Document" may not be a real <button>/<a>. Same as the policy
    // card, find it by text and walk up the ancestor chain until clicking
    // opens a modal-shaped element on the page.
    const dlTextLoc = page.locator(':text-matches("^\\\\s*download\\\\s+document\\\\s*$", "i")').first();
    const dlVisible = await dlTextLoc.isVisible({ timeout: 4_000 }).catch(() => false);
    log(`policy ${i + 1}: "Download Document" text visible: ${dlVisible}`);

    if (!dlVisible) {
      log(`policy ${i + 1}: skipping — "Download Document" text not on page`);
      continue;
    }

    const dlAncestors = await dlTextLoc.evaluate((el) => {
      const chain = [];
      let cur = el;
      while (cur && cur !== document.body && chain.length < 10) {
        chain.push({
          tag: cur.tagName.toLowerCase(),
          cls: (cur.getAttribute('class') || '').slice(0, 60),
          role: cur.getAttribute('role') || null,
          cursor: getComputedStyle(cur).cursor,
        });
        cur = cur.parentElement;
      }
      return chain;
    }).catch(() => []);
    log('"Download Document" ancestor chain:', dlAncestors);

    // Multi-signal modal detection: any of these promises resolving = modal up.
    // Includes text-based signals because eRenterPlan may not use standard
    // dialog/modal class names. "Insurance Packet" is the most reliable signal
    // — that text doesn't exist on the page until the modal renders it.
    const waitForModal = async (timeoutMs) => {
      try {
        await Promise.any([
          page.locator('[role="dialog"]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="modal" i]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="dialog" i]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="popup" i]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="overlay" i]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="lightbox" i]').first().waitFor({ timeout: timeoutMs }),
          page.getByText(/insurance packet/i).first().waitFor({ timeout: timeoutMs }),
        ]);
        return true;
      } catch {
        return false;
      }
    };

    let modalOpened = false;
    for (let depth = 0; depth <= 6 && !modalOpened; depth++) {
      const target = depth === 0
        ? dlTextLoc
        : dlTextLoc.locator(`xpath=ancestor::*[${depth}]`);
      try {
        await target.click({ timeout: 2_500, force: true });
        log(`dl-button click depth=${depth} succeeded (force=true)`);
      } catch (e) {
        log(`dl-button depth=${depth} click error: ${e?.message?.slice(0, 120)}`);
        continue;
      }
      modalOpened = await waitForModal(1_800);
      if (modalOpened) {
        log(`modal appeared after depth=${depth} click`);
        // Modal container is up, but Angular may still be rendering its
        // contents. Wait specifically for the cloud-download icon to be in
        // the DOM before we go scanning for it — race-free.
        const ready = await page.locator('em[class*="cloud-download" i]').first()
          .waitFor({ timeout: 8_000 })
          .then(() => true).catch(() => false);
        log(`cloud-download icon present in modal: ${ready}`);
        // Interactive debugging hook. When PAUSE_AT_MODAL=1 is set, pause here
        // so the developer can use the Playwright Inspector to "Pick locator"
        // on the cloud-download icon. The bot resumes when "Resume" is clicked
        // in the inspector window.
        if (process.env.PAUSE_AT_MODAL === '1') {
          log('PAUSE_AT_MODAL=1 — pausing for Playwright Inspector.');
          log('  → in the Inspector window: click "Pick locator" then click the cloud-download icon in the page.');
          log('  → copy the selector string the Inspector shows, paste it here in chat.');
          log('  → click "Resume" in the Inspector to continue.');
          await page.pause();
        }
      }
    }
    if (!modalOpened) {
      log(`policy ${i + 1}: clicked through ancestors but no modal signal — skipping`);
      continue;
    }

    await page.waitForTimeout(600);
    await dumpDebug(page, session, `04c-policy-${i + 1}-modal`);

    const downloadsDir = path.resolve(process.cwd(), 'downloads', session.id);
    await mkdir(downloadsDir, { recursive: true });

    // The cloud-download icon is `<em class="simple-icon icon-cloud-download">`
    // wrapped by an `<a>`. The SHARE icon (`icon-share-2`) is a sibling anchor.
    // Target the specific anchor that contains the cloud-download <em> so we
    // never trigger the share-flow popup again.
    const downloadAnchors = page.locator('#policyDocumentsModal a').filter({
      has: page.locator('em[class*="cloud-download" i], em[class*="icon-download" i]'),
    });
    let anchorCount = await downloadAnchors.count().catch(() => 0);
    log(`cloud-download anchors (a:has(em.icon-cloud-download)): ${anchorCount}`);

    let anchorsLocator = downloadAnchors;
    if (anchorCount === 0) {
      // Fallback: any anchor whose icon child looks download-ish.
      anchorsLocator = page.locator('#policyDocumentsModal a, #policyDocumentsModal button').filter({
        has: page.locator('[class*="download" i]'),
      });
      anchorCount = await anchorsLocator.count().catch(() => 0);
      log(`fallback (any [class*=download]): ${anchorCount}`);
    }

    if (anchorCount === 0) {
      log(`policy ${i + 1}: no download anchors in modal`);
      continue;
    }

    const collectedDocs = [];
    const ctx = page.context();

    const saveDownload = async (download, fallbackName) => {
      const suggested = download.suggestedFilename() || fallbackName;
      const localPath = path.join(
        downloadsDir,
        `${String(collectedDocs.length).padStart(2, '0')}-${suggested}`,
      );
      await download.saveAs(localPath);
      log(`  download captured: ${suggested} -> ${localPath}`);
      collectedDocs.push({
        id: `doc-${allDocs.length + collectedDocs.length}`,
        name: suggested.replace(/\.[^.]+$/, ''),
        policyId: null,
        policyLabel: 'eRenterPlan',
        localPath,
      });
    };

    const savePopupOrUrl = async (url, fallbackName) => {
      try {
        const resp = await ctx.request.get(url);
        if (!resp.ok()) {
          log(`  fetch ${url} returned ${resp.status()}`);
          return;
        }
        const body = await resp.body();
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        const ext = ct.includes('pdf') ? '.pdf'
          : ct.includes('png') ? '.png'
          : ct.includes('jpeg') ? '.jpg'
          : '.bin';
        const filename = fallbackName.endsWith(ext) ? fallbackName : fallbackName + ext;
        const localPath = path.join(
          downloadsDir,
          `${String(collectedDocs.length).padStart(2, '0')}-${filename}`,
        );
        await fs.writeFile(localPath, body);
        log(`  fetched ${url.slice(0, 80)} -> ${localPath}`);
        collectedDocs.push({
          id: `doc-${allDocs.length + collectedDocs.length}`,
          name: filename.replace(/\.[^.]+$/, ''),
          policyId: null,
          policyLabel: 'eRenterPlan',
          localPath,
        });
      } catch (e) {
        log(`  popup/url fetch failed: ${e?.message?.slice(0, 100)}`);
      }
    };

    for (let a = 0; a < anchorCount; a++) {
      const anchor = anchorsLocator.nth(a);
      const visible = await anchor.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;

      // Inspect the anchor first — its attributes tell us what kind of trigger it is.
      const attrs = await anchor.evaluate((el) => ({
        href: el.getAttribute('href'),
        target: el.getAttribute('target'),
        download: el.getAttribute('download'),
        onclick: !!el.onclick || el.hasAttribute('onclick'),
        ariaLabel: el.getAttribute('aria-label'),
        innerHTML: (el.innerHTML || '').slice(0, 200),
      })).catch(() => ({}));
      log(`anchor ${a} attrs:`, attrs);

      // If href is a real URL (not javascript: or empty), try fetching directly
      // via the authenticated context. This sidesteps any click-handler quirks.
      const hrefIsReal = attrs.href && !/^\s*(javascript:|#|\s*$)/i.test(attrs.href);
      if (hrefIsReal) {
        const absoluteUrl = new URL(attrs.href, page.url()).toString();
        log(`anchor ${a} has real href — fetching directly: ${absoluteUrl.slice(0, 100)}`);
        await savePopupOrUrl(absoluteUrl, attrs.ariaLabel || `doc-${a}`);
        continue;
      }

      // Otherwise: try four click methods in sequence. Angular (click) handlers
      // sometimes don't fire on Playwright's force-click; real mouse events at
      // coordinates are the gold-standard escape hatch.
      const tryWithListeners = async (label, doClick) => {
        const downloadP = page.waitForEvent('download', { timeout: 3_500 }).catch(() => null);
        const popupP = ctx.waitForEvent('page', { timeout: 3_500 }).catch(() => null);
        const beforeUrl = page.url();
        try {
          await doClick();
        } catch (e) {
          log(`  [${label}] click error: ${e?.message?.slice(0, 100)}`);
          return false;
        }
        const [download, popup] = await Promise.all([downloadP, popupP]);
        if (download) {
          await saveDownload(download, `doc-${a}.pdf`);
          return true;
        }
        if (popup) {
          const url = popup.url();
          log(`  [${label}] popup opened: ${url}`);
          await savePopupOrUrl(url, attrs.ariaLabel || `doc-${a}`);
          await popup.close().catch(() => {});
          return true;
        }
        if (page.url() !== beforeUrl) {
          log(`  [${label}] in-page navigation: ${page.url()}`);
          await savePopupOrUrl(page.url(), attrs.ariaLabel || `doc-${a}`);
          await page.goBack().catch(() => {});
          return true;
        }
        log(`  [${label}] no observable effect`);
        return false;
      };

      let success = false;

      // Method 1: Playwright force click on the anchor itself.
      log(`anchor ${a}: trying playwright-click`);
      success = await tryWithListeners('playwright-click', () =>
        anchor.click({ force: true, timeout: 2_500 }));

      // Method 2: dispatchEvent('click') — works for many JS click handlers.
      if (!success) {
        log(`anchor ${a}: trying dispatchEvent`);
        success = await tryWithListeners('dispatchEvent', () =>
          anchor.dispatchEvent('click'));
      }

      // Method 3: real mouse click at the anchor's bounding-box center —
      // closest to a true user gesture; bypasses pointer-events overlays.
      if (!success) {
        const box = await anchor.boundingBox().catch(() => null);
        if (box) {
          log(`anchor ${a}: trying mouse-click at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})`);
          success = await tryWithListeners('mouse-click', async () => {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.waitForTimeout(50);
            await page.mouse.up();
          });
        } else {
          log(`anchor ${a}: no bounding box for mouse-click fallback`);
        }
      }

      // Method 4: click the inner <em> icon directly.
      if (!success) {
        const em = anchor.locator('em, svg, i').first();
        const emVisible = await em.isVisible({ timeout: 500 }).catch(() => false);
        if (emVisible) {
          log(`anchor ${a}: trying inner-icon click`);
          success = await tryWithListeners('inner-icon', () =>
            em.click({ force: true, timeout: 2_500 }));
        }
      }

      if (!success) {
        await dumpDebug(page, session, `04d-policy-${i + 1}-anchor-${a}-after-clicks`);
        log(`anchor ${a}: ALL click methods failed — dumped 04d for inspection`);
      }
    }

    log(`policy ${i + 1}: captured ${collectedDocs.length} document(s)`);
    allDocs.push(...collectedDocs);

    // Close modal before iterating to next policy.
    const closeCandidates = [
      page.getByRole('button', { name: /^\s*close\s*$/i }),
      page.locator('[aria-label="Close" i]'),
      page.locator('button:has-text("Close")'),
    ];
    for (const c of closeCandidates) {
      const v = await c.first().isVisible({ timeout: 1_000 }).catch(() => false);
      if (v) {
        await c.first().click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(300);
        break;
      }
    }
  }

  log(`total docs collected across policies: ${allDocs.length}`);
  return allDocs;
}
