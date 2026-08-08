import assert from "node:assert/strict";
import test from "node:test";
import { R_EDITOR_ACCEPTANCE_TOOLING } from "./r-editor-acceptance-tooling.mjs";

test("native R and Quarto acceptance pins one reviewed toolchain", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(R_EDITOR_ACCEPTANCE_TOOLING).map(([key, value]) => [key, "id" in value ? value.id : value.version])
    ),
    {
      rSyntax: "reditorsupport.r-syntax@0.1.4",
      r: "reditorsupport.r@2.8.8",
      quartoExtension: "quarto.quarto@1.135.0",
      quartoCli: "1.10.18"
    }
  );
  for (const pin of Object.values(R_EDITOR_ACCEPTANCE_TOOLING)) {
    assert.equal(Object.isFrozen(pin), true);
    assert.match(pin.url, /^https:\/\//u);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0);
  }
});
