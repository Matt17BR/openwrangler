import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PNG } from "pngjs";
import { compareDecodedPng } from "./inspect-media-changes.mjs";

function image(width, height, rgba = [0, 0, 0, 255]) {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set(rgba, offset);
  }
  return png;
}

test("reports exact changed-pixel bounds", () => {
  const before = image(4, 3);
  const after = image(4, 3);
  after.data.set([255, 0, 0, 255], (1 * 4 + 2) * 4);
  after.data.set([0, 255, 0, 255], (2 * 4 + 3) * 4);
  assert.deepEqual(compareDecodedPng(before, after), {
    changedPixels: 2,
    bounds: { minimumX: 2, minimumY: 1, maximumX: 3, maximumY: 2 },
    before: { width: 4, height: 3 },
    after: { width: 4, height: 3 }
  });
});

test("reports dimension changes without comparing incompatible buffers", () => {
  assert.deepEqual(compareDecodedPng(image(2, 2), image(3, 1)), {
    changedPixels: null,
    bounds: null,
    before: { width: 2, height: 2 },
    after: { width: 3, height: 1 }
  });
});

test("the public command takes the heavy lease and each decoder gets a bounded heap", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    manifest.scripts["inspect:media-changes"],
    "node scripts/run-heavy-local-command.mjs inspect:media-changes -- node scripts/inspect-media-changes.mjs"
  );
  const source = readFileSync(new URL("./inspect-media-changes.mjs", import.meta.url), "utf8");
  assert.match(source, /--max-old-space-size=\$\{CHILD_HEAP_MIB\}/u);
  assert.match(source, /for \(const path of paths\)/u);
  assert.doesNotMatch(source, /Promise\.all/u);
});
