// node bench/run.mjs [url]  (dev server must run; uses the GPU build of Chromium)
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5179/bench/';
const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(url);
await page.waitForFunction(() => window.bench, null, { timeout: 900000 });
console.log(JSON.stringify(await page.evaluate(() => window.bench), null, 2));
await browser.close();
