import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const svgFull = readFileSync(join(dir, 'icon.svg'), 'utf8');
const svgSmall = readFileSync(join(dir, 'icon-small.svg'), 'utf8');
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
// Windows reads one .ico and picks a frame per context (16 in the title bar, 256
// in the Explorer preview), so the whole ladder ships in a single file.
const icoSizes = [16, 32, 48, 64, 128, 256];

const rendered = new Map();
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
    rendered.set(size, buf);
    await page.close();
    console.log(`rendered ${size}.png`);
  }
} finally {
  await browser.close();
}

writeFileSync(join(dir, 'icon.ico'), ico(icoSizes.map((s) => rendered.get(s))));
console.log(`packed icon.ico (${icoSizes.join(', ')})`);

/**
 * Pack PNGs into an .ico. Every Windows since Vista reads PNG-compressed frames,
 * so the encoded bytes go in verbatim — no BMP re-encode, no image library.
 */
function ico(pngs) {
  const dirEntries = Buffer.alloc(6 + 16 * pngs.length);
  dirEntries.writeUInt16LE(1, 2); // type: 1 = icon
  dirEntries.writeUInt16LE(pngs.length, 4);
  let offset = dirEntries.length;
  pngs.forEach((png, i) => {
    const at = 6 + 16 * i;
    // A PNG's IHDR puts width/height at fixed offsets; 256 is stored as 0.
    const side = png.readUInt32BE(16) & 0xff;
    dirEntries.writeUInt8(side, at); // width
    dirEntries.writeUInt8(side, at + 1); // height
    dirEntries.writeUInt16LE(1, at + 4); // color planes
    dirEntries.writeUInt16LE(32, at + 6); // bits per pixel
    dirEntries.writeUInt32LE(png.length, at + 8);
    dirEntries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([dirEntries, ...pngs]);
}
