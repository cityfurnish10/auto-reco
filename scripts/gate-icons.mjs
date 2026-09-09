// Rasterise the CF mark into the PNG sizes a web app manifest needs.
//
// Playwright rather than a native image library: it is already a devDependency
// (the gate smoke tests drive a real browser), so this adds nothing to install
// and renders the SAME SVG the site serves. Re-run after any brand change:
//   node scripts/gate-icons.mjs
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const mark = (inset) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#4a36b3"/>
  <g transform="translate(256,256) scale(${1 - inset}) translate(-256,-256)">
    <text x="256" y="266" text-anchor="middle" dominant-baseline="central"
      font-family="Poppins, Arial, Helvetica, sans-serif" font-weight="700"
      font-size="270" letter-spacing="-10" fill="#ffffff">CF</text>
  </g>
</svg>`;

const b = await chromium.launch();
for (const [name, size, inset] of [
  // "any" icons keep the full-bleed mark; the maskable one insets so Android's
  // circle/squircle crop cannot clip the letters.
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 0.3],
]) {
  const p = await (await b.newContext({ viewport: { width: size, height: size },
    deviceScaleFactor: 1 })).newPage();
  await p.setContent(`<body style="margin:0">${mark(inset).replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body>`);
  writeFileSync(`public/scan/${name}`, await p.screenshot({ omitBackground: false }));
  console.log(`  public/scan/${name}  ${size}x${size}`);
}
await b.close();
