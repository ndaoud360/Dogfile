// node build/store/promo/render.mjs  → promo-3840x2160.png (needs Playwright with Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // CommonJS lookup, so NODE_PATH works
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(dir, 'promo-3840x2160.png');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await p.emulateMedia({ colorScheme: 'light' });
await p.goto(pathToFileURL(path.join(dir, 'promo.html')).href);
await p.evaluate(() => document.fonts.ready);
await p.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
await p.waitForTimeout(300);
await p.screenshot({ path: out });
await b.close();
console.log('wrote', out);
