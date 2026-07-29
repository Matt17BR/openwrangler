import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("README media is compact, portable, and composition-verified", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const compositor = readFileSync(resolve(root, "scripts", "compose-readme-media.mjs"), "utf8");
  const readme = readFileSync(resolve(root, "README.md"), "utf8");

  assert.equal(packageJson.scripts?.["compose:readme-media"], "node scripts/compose-readme-media.mjs");
  assert.equal(packageJson.scripts?.["verify:readme-media"], "node scripts/compose-readme-media.mjs --verify");
  assert.match(packageJson.scripts?.["test:webview-acceptance"] ?? "", /npm run verify:readme-media/u);
  assert.match(packageJson.scripts?.["test:scripts"] ?? "", /scripts\/readme-media\.test\.mjs/u);
  assert.match(compositor, /vscode-hero-dark\.png/u);
  assert.match(compositor, /vscode-hero-light\.png/u);
  assert.match(compositor, /vscode-notebook-pandas-dark\.png/u);
  assert.match(compositor, /vscode-notebook-polars-dark\.png/u);
  assert.match(compositor, /pixelmatch/u);
  assert.match(compositor, /sRGB/u);
  assert.doesNotMatch(compositor, /\bpyspark\b/iu);

  for (const [name, width, height] of [
    ["workbench.png", 1_440, 720],
    ["notebooks.png", 1_440, 520]
  ]) {
    const path = resolve(root, "docs", "images", "readme", "v1.1", name);
    const png = readFileSync(path);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    assert.ok(png.byteLength < 300 * 1_024, `${name} should remain compact at README display size.`);
    assert.ok(pngChunkTypes(png).includes("sRGB"), `${name} should declare the standard sRGB color space.`);
    assert.ok(readme.includes(`docs/images/readme/v1.1/${name}`));
  }

  assert.equal(readme.match(/docs\/images\/readme\/v1\.1\/(?:workbench|notebooks)\.png/gu)?.length, 2);
  assert.doesNotMatch(readme, /docs\/images\/editor-acceptance\/vscode-(?:hero|notebook)/u);
  assert.doesNotMatch(readme, /The image automatically follows your GitHub theme\./u);
});

function pngChunkTypes(png) {
  const types = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    offset += length + 12;
    if (type === "IEND") break;
  }
  assert.equal(types.at(-1), "IEND");
  assert.equal(offset, png.length);
  return types;
}
