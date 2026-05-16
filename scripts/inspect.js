// Headful inspector: launches a real Chrome window pointed at a carrier's
// public login page so selectors can be picked manually via DevTools or the
// Playwright Inspector. Usage: node scripts/inspect.js <carrier>
import { chromium } from 'playwright';

const URLS = {
  lemonade:    'https://www.lemonade.com/login',
  petsbest:    'https://www.petsbest.com/customerportal',
  erenterplan: 'https://www.erenterplan.com/Account/SignIn',
};

const carrier = process.argv[2];
const url = URLS[carrier];
if (!url) {
  console.error(`usage: node scripts/inspect.js <${Object.keys(URLS).join('|')}>`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
console.log(`Opened ${url} — close the browser window to exit.`);
await page.goto(url);
await new Promise((resolve) => browser.on('disconnected', resolve));
