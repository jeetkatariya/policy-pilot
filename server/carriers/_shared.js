import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Fetch a URL through the browser context (so cookies / auth state apply),
// save the response body to ./downloads/<sessionId>/<filename> with the
// appropriate extension, and return the local path. Returns null on failure.
// Used by carriers (Lemonade, Pets Best) to pre-fetch documents during the
// session so the persistent context can be closed afterwards without losing
// the ability to serve the documents to the UI.
export async function prefetchAndSave(context, url, sessionId, baseName) {
  if (!url) return null;
  try {
    const resp = await context.request.get(url);
    if (!resp.ok()) return null;
    const body = await resp.body();
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const ext = ct.includes('pdf') ? '.pdf'
      : ct.includes('png') ? '.png'
      : ct.includes('jpeg') ? '.jpg'
      : ct.includes('html') ? '.html'
      : '.bin';
    const safe = String(baseName || 'doc').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'doc';
    const filename = safe.toLowerCase().endsWith(ext) ? safe : safe + ext;
    const dir = path.resolve(process.cwd(), 'downloads', sessionId);
    await mkdir(dir, { recursive: true });
    const localPath = path.join(dir, filename);
    await writeFile(localPath, body);
    return localPath;
  } catch {
    return null;
  }
}

// Wait for either a success signal (URL match and/or selector visible) or an
// error selector to appear. Returns { ok: true } or { ok: false, error }.
// Pass `action` to perform the click/submit after the watchers are wired up.
export async function raceForSettle(page, {
  urlPattern = null,
  successSelector = null,
  errorSelectors = [],
  timeoutMs = 10_000,
  action = null,
} = {}) {
  const successPromises = [];
  if (urlPattern) {
    successPromises.push(
      page.waitForURL(urlPattern, { timeout: timeoutMs }).then(() => ({ ok: true })),
    );
  }
  if (successSelector) {
    successPromises.push(
      page.locator(successSelector).first().waitFor({ timeout: timeoutMs })
        .then(() => ({ ok: true })),
    );
  }
  const errorPromises = errorSelectors.map((sel) =>
    page.locator(sel).first().waitFor({ timeout: timeoutMs }).then(async () => {
      const text = await page.locator(sel).first().textContent().catch(() => '');
      return { ok: false, error: (text || '').trim().slice(0, 300) || 'Carrier reported an error.' };
    }),
  );
  const all = [...successPromises, ...errorPromises].map((p) => p.catch(() => null));
  if (action) await action();
  const settled = await Promise.race(all);
  if (settled) return settled;
  return { ok: false, error: 'Timed out waiting for portal response.' };
}

const DUMP_ROOT = path.resolve(process.cwd(), 'dumps');

// Saves a screenshot + html of the current page state under ./dumps/<sessionId>/.
// Always dumps on the 'error' stage; otherwise only when DEBUG_DUMP=1.
export async function dumpDebug(page, session, stage) {
  if (!page) return null;
  const always = stage === 'error';
  if (!always && process.env.DEBUG_DUMP !== '1') return null;
  try {
    const dir = path.join(DUMP_ROOT, session.id);
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${stage}.png`), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(path.join(dir, `${stage}.html`), html);
    return dir;
  } catch {
    return null;
  }
}

// Try to dismiss a cookie consent banner if present. Best-effort and silent.
export async function dismissCookieBanner(page, options = {}) {
  const candidates = options.texts || ['Reject all', 'Accept all', 'I accept', 'Accept All', 'OK', 'Got it'];
  for (const text of candidates) {
    const loc = page.getByRole('button', { name: text, exact: false });
    try {
      if (await loc.first().isVisible({ timeout: 400 })) {
        await loc.first().click({ timeout: 1000 }).catch(() => {});
        return text;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export const REAL_CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
};

// Stable profile/rate-limit key per (carrier, username).
export function userKeyFor(carrier, username) {
  return createHash('sha256')
    .update(`${carrier}:${String(username || '').toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 16);
}

// Type one keystroke at a time with random delay so it looks like a human.
export async function humanType(locator, text) {
  await locator.click();
  await locator.pressSequentially(text, { delay: 60 + Math.random() * 40 });
}

// Hover over the target, pause briefly, then click — instead of teleporting.
export async function humanClick(locator) {
  await locator.hover().catch(() => {});
  const page = locator.page();
  await page.waitForTimeout(150 + Math.random() * 250);
  await locator.click();
}

// Random pause between major steps. Bots are too fast; this slows us down to human pace.
export async function thinkTime(page, minMs = 200, maxMs = 600) {
  await page.waitForTimeout(minMs + Math.random() * (maxMs - minMs));
}

// A simple stdout logger with prefix — used by drivers so the terminal shows what's happening.
export function makeLog(prefix) {
  return (msg, meta) => {
    const t = new Date().toISOString().slice(11, 23);
    if (meta !== undefined) console.log(`[${t}] ${prefix} ${msg}`, meta);
    else                    console.log(`[${t}] ${prefix} ${msg}`);
  };
}

// Click with a clear diagnostic: log how many elements matched, whether visible.
// Fail fast with a descriptive error so the timeout doesn't burn 30s.
export async function safeClick(log, locator, label) {
  const count = await locator.count().catch(() => 0);
  const url = locator.page().url();
  log(`click "${label}" — matched ${count} element(s)`, { url });
  if (count === 0) {
    throw new Error(`Selector "${label}" did not match any element on ${url}`);
  }
  const first = locator.first();
  const visible = await first.isVisible().catch(() => false);
  const enabled = await first.isEnabled().catch(() => false);
  log(`click "${label}" — visible=${visible}, enabled=${enabled}`);
  if (!visible) throw new Error(`Selector "${label}" matched ${count} element(s) but none visible on ${url}`);
  if (!enabled) throw new Error(`Selector "${label}" matched but is disabled on ${url}`);
  await humanClick(first);
}

// Fill with diagnostic; masks the value if it's a password field.
export async function safeFill(log, locator, value, label, { mask = false } = {}) {
  const count = await locator.count().catch(() => 0);
  log(`fill "${label}" — matched ${count} element(s), value=${mask ? '*'.repeat(value.length) : JSON.stringify(value)}`);
  if (count === 0) throw new Error(`Selector "${label}" did not match any element on ${locator.page().url()}`);
  await humanType(locator.first(), value);
}
