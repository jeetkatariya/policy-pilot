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
      await thinkTime(page, 400, 900);

      setProgress(session, { stage: 'submitting_credentials' });
      await safeFill(log, page.locator('#username'), session.username, 'username');
      await thinkTime(page, 150, 400);
      await safeFill(log, page.locator('#password'), session.password, 'password', { mask: true });
      await thinkTime(page, 250, 600);

      log('submitting login');
      await safeClick(log, page.locator('#signIn'), 'login-submit');

      // URL-based success: leaving /Account/SignIn means login worked.
      // No class-based error race because eRenterPlan has transient error
      // placeholders that cause false positives during navigation.
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

      const codeFieldVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
        .isVisible({ timeout: 3_000 }).catch(() => false);
      const mfaInUrl = /verify|mfa|2fa|otp|challenge|twofactor/i.test(page.url());
      needsMfa = codeFieldVisible || mfaInUrl;
      log('MFA detection', { codeFieldVisible, mfaInUrl, needsMfa, url: page.url() });
    }

    if (needsMfa) {
      // If a method-choice page is shown first (radio buttons, no code field
      // yet), auto-pick the first option and submit before expecting code entry.
      let codeInputVisible = await page.locator(MFA_INPUT_SELECTORS.join(', ')).first()
        .isVisible({ timeout: 1_500 }).catch(() => false);
      if (!codeInputVisible) {
        await dumpDebug(page, session, '02b-mfa-method-choice');
        const radios = page.locator('input[type="radio"]');
        const n = await radios.count().catch(() => 0);
        if (n > 0) {
          await radios.first().check({ timeout: 3_000 }).catch(() => {});
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
    const documents = await discoverDocs(page, session, log);
    log(`discovered ${documents.length} document(s)`);
    if (documents.length === 0) {
      throw new Error(
        `No documents discovered. Re-run with DEBUG_DUMP=1 and inspect ./dumps/${session.id}/.`,
      );
    }
    setProgress(session, { stage: 'done', totalDocs: documents.length });
    setStatus(session, 'done', { documents });
    log('done');

    // Documents are persisted to disk during discovery; close the persistent
    // context so the profile-singleton lock is released for the next session.
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

// eRenterPlan flow:
//   /Policy/Dashboard → click a policy card → policy detail page →
//   "Download Document" button opens a modal → cloud icon downloads the PDF.
async function discoverDocs(page, session, log) {
  if (!/\/Policy\/Dashboard/i.test(page.url())) {
    await page.goto('https://www.erenterplan.com/Policy/Dashboard', {
      timeout: STEP_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
  }
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await dumpDebug(page, session, '04a-dashboard');
  log('on dashboard', { url: page.url() });

  const dashAnchors = await page.$$eval('a', (anchors) =>
    anchors.map((a) => ({
      text: (a.textContent || '').trim().slice(0, 80),
      href: a.href || '',
      visible: a.offsetParent !== null,
    })).filter((a) => a.visible && a.href && a.text),
  );

  const policyAnchors = dashAnchors.filter((a) =>
    /\/Policy\/(?!Dashboard|Add|Logout|SignIn|SignOut)/i.test(a.href) &&
    !/^(home|about|contact|faq|log\s*in|log\s*out|add\s+policy)$/i.test(a.text),
  );
  let policyUrls = [...new Set(policyAnchors.map((a) => a.href))];

  // Policy cards are typically clickable Angular divs, not anchors. Find the
  // policy-number text element and click each clickable ancestor until the
  // SPA navigates. SPA navigations don't fire DOMContentLoaded, so success is
  // detected by URL change.
  if (policyUrls.length === 0) {
    const before = page.url();
    const numberLoc = page.locator(':text-matches("^\\\\s*\\\\d{8,10}\\\\s*$")').first();
    const numberCount = await numberLoc.count().catch(() => 0);
    log(`policy-number elements: ${numberCount}`);

    if (numberCount > 0) {
      const waitForNav = (timeoutMs) =>
        page.waitForURL((u) => u.toString() !== before, { timeout: timeoutMs })
          .then(() => true).catch(() => false);

      for (let depth = 0; depth <= 6; depth++) {
        const target = depth === 0 ? numberLoc : numberLoc.locator(`xpath=ancestor::*[${depth}]`);
        try { await target.click({ timeout: 2_500 }); }
        catch (e) { log(`depth=${depth} click error: ${e?.message?.slice(0, 120)}`); continue; }
        if (await waitForNav(3_500)) {
          log(`URL changed after depth=${depth} click ->`, page.url());
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
          policyUrls = [page.url()];
          break;
        }
      }
    }
  }

  if (policyUrls.length === 0) {
    throw new Error(`No policy cards found on eRenterPlan dashboard. Inspect ./dumps/${session.id}/04a-dashboard.html`);
  }

  const allDocs = [];
  for (let i = 0; i < Math.min(policyUrls.length, 5); i++) {
    const url = policyUrls[i];
    if (page.url() !== url) {
      await page.goto(url, { timeout: STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    }
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    await dumpDebug(page, session, `04b-policy-${i + 1}-detail`);
    log(`policy ${i + 1}: on detail`, { url: page.url() });

    // "Download Document" is a styled button; same ancestor-walk trick as the
    // policy card. Success signal is a modal-shaped element appearing.
    const dlTextLoc = page.locator(':text-matches("^\\\\s*download\\\\s+document\\\\s*$", "i")').first();
    if (!(await dlTextLoc.isVisible({ timeout: 4_000 }).catch(() => false))) {
      log(`policy ${i + 1}: "Download Document" text not on page — skipping`);
      continue;
    }

    const waitForModal = async (timeoutMs) => {
      try {
        await Promise.any([
          page.locator('[role="dialog"]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="modal" i]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="dialog" i]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="popup" i]').first().waitFor({ timeout: timeoutMs }),
          page.locator('[class*="overlay" i]').first().waitFor({ timeout: timeoutMs }),
          page.getByText(/insurance packet/i).first().waitFor({ timeout: timeoutMs }),
        ]);
        return true;
      } catch { return false; }
    };

    let modalOpened = false;
    for (let depth = 0; depth <= 6 && !modalOpened; depth++) {
      const target = depth === 0 ? dlTextLoc : dlTextLoc.locator(`xpath=ancestor::*[${depth}]`);
      try { await target.click({ timeout: 2_500, force: true }); }
      catch (e) { log(`dl-button depth=${depth} click error: ${e?.message?.slice(0, 120)}`); continue; }
      modalOpened = await waitForModal(1_800);
      if (modalOpened) {
        log(`modal appeared after depth=${depth} click`);
        // Modal container can render before its children. Wait for the
        // cloud-download icon specifically before scanning the modal.
        await page.locator('em[class*="cloud-download" i]').first()
          .waitFor({ timeout: 8_000 }).catch(() => {});
      }
    }
    if (!modalOpened) {
      log(`policy ${i + 1}: clicked through ancestors but no modal opened — skipping`);
      continue;
    }

    await page.waitForTimeout(600);
    await dumpDebug(page, session, `04c-policy-${i + 1}-modal`);

    const downloadsDir = path.resolve(process.cwd(), 'downloads', session.id);
    await mkdir(downloadsDir, { recursive: true });

    // Cloud-download icon is `<em class="icon-cloud-download">` wrapped by an
    // `<a>`. The share icon (`icon-share-2`) is a sibling anchor — match the
    // download one specifically so the share popup is never triggered.
    const downloadAnchors = page.locator('#policyDocumentsModal a').filter({
      has: page.locator('em[class*="cloud-download" i], em[class*="icon-download" i]'),
    });
    let anchorCount = await downloadAnchors.count().catch(() => 0);
    let anchorsLocator = downloadAnchors;
    if (anchorCount === 0) {
      anchorsLocator = page.locator('#policyDocumentsModal a, #policyDocumentsModal button').filter({
        has: page.locator('[class*="download" i]'),
      });
      anchorCount = await anchorsLocator.count().catch(() => 0);
    }
    log(`download anchors in modal: ${anchorCount}`);
    if (anchorCount === 0) continue;

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
        if (!resp.ok()) return;
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
      if (!(await anchor.isVisible({ timeout: 500 }).catch(() => false))) continue;

      const attrs = await anchor.evaluate((el) => ({
        href: el.getAttribute('href'),
        target: el.getAttribute('target'),
        download: el.getAttribute('download'),
        ariaLabel: el.getAttribute('aria-label'),
      })).catch(() => ({}));

      // Real href → fetch via authenticated context, bypass the click.
      if (attrs.href && !/^\s*(javascript:|#|\s*$)/i.test(attrs.href)) {
        const absoluteUrl = new URL(attrs.href, page.url()).toString();
        await savePopupOrUrl(absoluteUrl, attrs.ariaLabel || `doc-${a}`);
        continue;
      }

      // Angular (click) handlers don't always fire on Playwright's force-click;
      // try several click strategies and stop at the first one that produces
      // a download / popup / navigation.
      const tryClick = async (label, doClick) => {
        const downloadP = page.waitForEvent('download', { timeout: 3_500 }).catch(() => null);
        const popupP = ctx.waitForEvent('page', { timeout: 3_500 }).catch(() => null);
        const beforeUrl = page.url();
        try { await doClick(); }
        catch (e) { log(`  [${label}] click error: ${e?.message?.slice(0, 100)}`); return false; }
        const [download, popup] = await Promise.all([downloadP, popupP]);
        if (download) { await saveDownload(download, `doc-${a}.pdf`); return true; }
        if (popup) {
          await savePopupOrUrl(popup.url(), attrs.ariaLabel || `doc-${a}`);
          await popup.close().catch(() => {});
          return true;
        }
        if (page.url() !== beforeUrl) {
          await savePopupOrUrl(page.url(), attrs.ariaLabel || `doc-${a}`);
          await page.goBack().catch(() => {});
          return true;
        }
        return false;
      };

      let success = await tryClick('playwright-click', () =>
        anchor.click({ force: true, timeout: 2_500 }));
      if (!success) {
        success = await tryClick('dispatchEvent', () => anchor.dispatchEvent('click'));
      }
      if (!success) {
        const box = await anchor.boundingBox().catch(() => null);
        if (box) {
          success = await tryClick('mouse-click', async () => {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.waitForTimeout(50);
            await page.mouse.up();
          });
        }
      }
      if (!success) {
        const em = anchor.locator('em, svg, i').first();
        if (await em.isVisible({ timeout: 500 }).catch(() => false)) {
          success = await tryClick('inner-icon', () =>
            em.click({ force: true, timeout: 2_500 }));
        }
      }
      if (!success) {
        await dumpDebug(page, session, `04d-policy-${i + 1}-anchor-${a}-after-clicks`);
        log(`anchor ${a}: no click strategy produced a download`);
      }
    }

    log(`policy ${i + 1}: captured ${collectedDocs.length} document(s)`);
    allDocs.push(...collectedDocs);

    const closeBtn = page.getByRole('button', { name: /^\s*close\s*$/i }).first();
    if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await closeBtn.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  return allDocs;
}
