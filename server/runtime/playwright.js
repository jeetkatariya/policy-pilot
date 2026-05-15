import { chromium as chromiumExtra } from 'playwright-extra';
import { chromium as chromiumStock } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

chromiumExtra.use(stealth());

// Shared headless browser — fast, used by stub-pw for tests.
let _sharedBrowser = null;
let _launching = null;

async function getSharedBrowser() {
  if (_sharedBrowser) return _sharedBrowser;
  if (!_launching) {
    _launching = chromiumStock
      .launch({ headless: process.env.HEADFUL !== '1' })
      .then((b) => { _sharedBrowser = b; return b; });
  }
  return _launching;
}

// For the stub-pw carrier: light, shared, headless by default.
export async function newContext(options = {}) {
  const browser = await getSharedBrowser();
  return browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...options,
  });
}

export const PROFILES_DIR = path.resolve(process.cwd(), 'profiles');

// For real carriers: one persistent profile per user, real Chrome, stealth-patched.
// Cookies/localStorage persist across runs, so subsequent runs ride the existing
// session (and we side-step the most heavily fingerprinted step — login).
//
// Default: headless (no visible window). The user types into our UI; the bot
// silently replays into the carrier portal. Set HEADFUL=1 to see the browser
// for debugging.
export async function newPersistentContext(profileKey, options = {}) {
  const profileDir = path.join(PROFILES_DIR, profileKey);
  await mkdir(profileDir, { recursive: true });
  const launchOpts = {
    channel: 'chrome',
    headless: process.env.HEADFUL !== '1',
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
    ...options,
  };
  return chromiumExtra.launchPersistentContext(profileDir, launchOpts);
}

export async function shutdown() {
  if (_sharedBrowser) {
    const b = _sharedBrowser;
    _sharedBrowser = null;
    _launching = null;
    await b.close().catch(() => {});
  }
}
