// Dumps the public login page structure of a given URL.
// Usage: node scripts/probe-login.js <url>
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) { console.error('usage: node scripts/probe-login.js <url>'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
} catch (e) {
  console.error('goto failed:', e.message);
}

const summary = await page.evaluate(() => {
  const allInputs = Array.from(document.querySelectorAll('input')).map((i) => ({
    id: i.id || null,
    name: i.name || null,
    type: i.type || null,
    placeholder: i.placeholder || null,
    autocomplete: i.autocomplete || null,
    ariaLabel: i.getAttribute('aria-label') || null,
  }));
  const allButtons = Array.from(document.querySelectorAll('button, input[type=submit]')).map((b) => ({
    id: b.id || null,
    name: b.name || null,
    type: b.type || null,
    text: (b.textContent || b.value || '').trim().slice(0, 80),
    ariaLabel: b.getAttribute('aria-label') || null,
  }));
  const forms = Array.from(document.querySelectorAll('form')).map((f) => ({
    id: f.id || null,
    name: f.name || null,
    action: f.action || null,
    method: f.method || null,
  }));
  return { url: location.href, title: document.title, forms, inputs: allInputs, buttons: allButtons };
});

console.log(JSON.stringify(summary, null, 2));

await browser.close();
