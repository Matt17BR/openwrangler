import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { stringifyForInlineScript } from "./capture-screenshots-json.mjs";

test("inline-script JSON escapes HTML script boundaries without changing its value", () => {
  const payload = {
    message: "</ScRiPt><script>window.openWranglerEscaped = false;</script><!--&-->\u2028\u2029",
    nested: ["plain", { code: "before</script>after", value: 42 }],
    enabled: true,
    missing: null
  };

  const serialized = stringifyForInlineScript(payload);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/u);
  assert.doesNotMatch(serialized, /<\/script/iu);

  const harness = `<script>globalThis.payload = ${serialized};</script>`;
  assert.equal(harness.match(/<\/script>/giu)?.length, 1);
  assert.equal(JSON.stringify(runInNewContext(`(${serialized})`)), JSON.stringify(payload));
});

test("inline-script JSON retains ordinary JSON.stringify semantics", () => {
  assert.equal(stringifyForInlineScript(undefined), "undefined");
  assert.equal(stringifyForInlineScript(Number.NaN), "null");
  assert.equal(stringifyForInlineScript(-0), "0");
  assert.equal(stringifyForInlineScript('"quoted"'), '"\\"quoted\\""');
  assert.throws(() => stringifyForInlineScript(1n), /BigInt/u);
});

test("every screenshot harness inline payload uses the script-safe serializer", () => {
  const source = readFileSync(new URL("./capture-screenshots.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\$\{\s*JSON\.stringify/u);

  for (const expression of [
    "stringifyForInlineScript(sessionPayload)",
    "stringifyForInlineScript(columnValues)",
    "stringifyForInlineScript(suppliedPages)",
    "stringifyForInlineScript(stepInspections)",
    "stringifyForInlineScript(strictProjectedPages)",
    "stringifyForInlineScript(fetchColumnBlockSize)",
    "stringifyForInlineScript(editorAction)",
    "stringifyForInlineScript(appearance.followupMessage)",
    'stringifyForInlineScript(`th[data-column="${openColumnFilter}"]`)',
    "stringifyForInlineScript(payload)",
    "stringifyForInlineScript(code)"
  ]) {
    assert.ok(source.includes(expression), `Missing script-safe serialization for ${expression}.`);
  }
});
