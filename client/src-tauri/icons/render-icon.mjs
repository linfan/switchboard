import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const svgFull = readFileSync(join(dir, 'icon.svg'), 'utf8');
const svgSmall = readFileSync(join(dir, 'icon-small.svg'), 'utf8');
const sizes = [16, 32, 64, 128, 256, 512, 1024];

const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const svg = size <= 64 ? svgSmall : svgFull;
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><style>
         *{margin:0;padding:0}html,body{background:transparent}
         svg{display:block;width:${size}px;height:${size}px}
       </style></head><body>${svg}</body></html>`,
      { waitUntil: 'networkidle' }
    );
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    writeFileSync(join(dir, `${size}.png`), buf);
    await page.close();
    console.log(`rendered ${size}.png`);
  }
} finally {
  await browser.close();
}
