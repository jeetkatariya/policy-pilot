// Headful inspector — launches a real browser pointed at a carrier's login page
// so you can interactively walk through the flow and pick selectors.
// Usage: node scripts/inspect.js <progressive|lemonade>
import { chromium } from 'playwright';

const URLS = {
  progressive: 'https://www.progressive.com/rp/login?cntgrp=A',
  lemonade:    'https://www.lemonade.com/login',
};

const carrier = process.argv[2];
const url = URLS[carrier];
if (!url) {
  console.error('usage: node scripts/inspect.js <progressive|lemonade>');
  console.error('available:', Object.keys(URLS).join(', '));
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
console.log(`Opening ${url} — interact manually. Close the browser window to exit.`);
console.log('Tips:');
console.log(' • Right-click on inputs/buttons → Inspect to read selectors.');
console.log(' • In Playwright codegen panel you can record actions.');
await page.goto(url);

await new Promise((resolve) => browser.on('disconnected', resolve));
