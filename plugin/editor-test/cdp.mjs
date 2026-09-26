// Evaluates an expression in the viewer page inside the running editor, through the
// WebView2 debug port (editor started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=0).
//   node plugin/editor-test/cdp.mjs "<expression>"
// Does not close anything: it only drops its own connection.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const portFile = path.join(process.env.LOCALAPPDATA, 'AmlViewer3D', 'WebView2', 'EBWebView', 'DevToolsActivePort');
const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('aml3d-viewer.local'));
if (!page) { console.log('no viewer page; pages: ' + browser.contexts().flatMap(c => c.pages()).map(p => p.url()).join(', ')); process.exit(1); }
const result = await page.evaluate(process.argv[2] ?? 'document.title');
console.log(typeof result === 'string' ? result : JSON.stringify(result));
process.exit(0);
