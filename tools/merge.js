// Merge Latin glyphs from a base monospace font with CJK glyphs from a donor font.
// Usage: node merge.js <base.ttf> <donor.ttf> <out.ttf> <family> <subfamily>
const fs = require("fs");
const { Font } = require("fonteditor-core");

const [basePath, donorPath, outPath, family, sub] = process.argv.slice(2);
const read = (p) => Font.create(fs.readFileSync(p), { type: "ttf", hinting: false, compound2simple: true });

const baseFont = read(basePath);
const base = baseFont.get();
const donor = read(donorPath).get();

const have = new Set();
for (const g of base.glyf) for (const u of g.unicode ?? []) have.add(u);

// One terminal cell is the base font's advance; CJK takes two cells.
const cell = base.glyf.find((g) => (g.unicode ?? []).includes(0x4d))?.advanceWidth ?? base.glyf[1].advanceWidth;
const scale = base.head.unitsPerEm / donor.head.unitsPerEm;
const donorEm = donor.head.unitsPerEm;

let added = 0;
for (const g of donor.glyf) {
  const codes = (g.unicode ?? []).filter((u) => !have.has(u));
  if (!codes.length) continue;
  const wide = (g.advanceWidth ?? donorEm) >= donorEm * 0.9;
  const target = wide ? cell * 2 : cell;
  const dx = Math.round((target - (g.advanceWidth ?? donorEm) * scale) / 2);
  const contours = (g.contours ?? []).map((c) => c.map((p) => ({ ...p, x: Math.round(p.x * scale) + dx, y: Math.round(p.y * scale) })));
  let xMin = 0, yMin = 0, xMax = 0, yMax = 0;
  const pts = contours.flat();
  if (pts.length) {
    xMin = Math.min(...pts.map((p) => p.x)); xMax = Math.max(...pts.map((p) => p.x));
    yMin = Math.min(...pts.map((p) => p.y)); yMax = Math.max(...pts.map((p) => p.y));
  }
  base.glyf.push({ contours, xMin, yMin, xMax, yMax, advanceWidth: target, leftSideBearing: xMin, name: g.name, unicode: codes });
  for (const u of codes) have.add(u);
  added++;
}

const ps = `${family}-${sub}`.replace(/\s+/g, "");
Object.assign(base.name, {
  fontFamily: sub === "Regular" || sub === "Bold" ? family : `${family} ${sub}`,
  fontSubFamily: sub === "Bold" ? "Bold" : "Regular",
  preferredFamily: family,
  preferredSubFamily: sub,
  fullName: `${family} ${sub}`,
  uniqueSubFamily: `${family} ${sub}`,
  postScriptName: ps,
});

baseFont.set(base);
const out = baseFont.write({ type: "ttf", hinting: false });
fs.writeFileSync(outPath, Buffer.from(out));
console.log(`${sub}: cell=${cell} scale=${scale.toFixed(3)} added=${added} glyphs=${base.glyf.length} bytes=${out.byteLength}`);
