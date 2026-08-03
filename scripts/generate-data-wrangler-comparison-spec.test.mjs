import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileFromFile } from "json-schema-to-typescript";
import {
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  captureDataWranglerStudyMethodReceipt,
  canonicalStudyJson
} from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_STUDY_SPECIFICATION_GENERATOR_PROTOCOL,
  generateDataWranglerComparisonSpecification,
  parseDataWranglerComparisonSpecificationArguments,
  readBoundedDataWranglerComparisonSpecificationDraft
} from "./generate-data-wrangler-comparison-spec.mjs";

function withDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "openwrangler-study-spec-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("specification generator replaces the draft methodology before validation and durable publication", () => {
  withDirectory((directory) => {
    const draftPath = resolve(directory, "draft.json");
    const outputPath = resolve(directory, "specification.json");
    const methodologyPath = resolve(directory, "method.md");
    const draft = { studyId: "draft-study", method: { copied: "untrusted" }, provenance: { marker: 1 } };
    writeFileSync(draftPath, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
    writeFileSync(methodologyPath, "# Reviewed method\n", { mode: 0o600 });
    const expectedMethod = captureDataWranglerStudyMethodReceipt(methodologyPath);
    const calls = [];
    let stored;

    const result = generateDataWranglerComparisonSpecification(
      { draft: draftPath, out: outputPath },
      {
        captureMethodology: () => expectedMethod,
        buildManifest(specification) {
          calls.push("build");
          assert.deepEqual(specification.method, expectedMethod);
          return { protocol: "validated-manifest", specification: structuredClone(specification) };
        },
        writeSpecification(path, specification) {
          calls.push("publish");
          assert.equal(path, outputPath);
          stored = structuredClone(specification);
          return { status: "published", sha256: "a".repeat(64) };
        },
        readSpecification(path) {
          calls.push("read-back");
          assert.equal(path, outputPath);
          return structuredClone(stored);
        }
      }
    );

    assert.deepEqual(calls, ["build", "publish", "read-back"]);
    assert.equal(result.protocol, DATA_WRANGLER_STUDY_SPECIFICATION_GENERATOR_PROTOCOL);
    assert.deepEqual(result.specification.method, expectedMethod);
    assert.equal("copied" in result.specification.method, false);
    assert.equal(result.manifest.protocol, "validated-manifest");
  });
});

test("specification generator stops before publication when the production validator rejects a draft", () => {
  withDirectory((directory) => {
    const draftPath = resolve(directory, "draft.json");
    writeFileSync(draftPath, '{"method":null}\n', { mode: 0o600 });
    let published = false;
    assert.throws(
      () =>
        generateDataWranglerComparisonSpecification(
          { draft: draftPath, out: resolve(directory, "specification.json") },
          {
            captureMethodology: () => ({
              protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
              sha256: "b".repeat(64)
            }),
            writeSpecification() {
              published = true;
            },
            readSpecification() {
              throw new Error("unreachable");
            }
          }
        ),
      /missing or unknown fields/u
    );
    assert.equal(published, false);
  });
});

test("specification generator reads a bounded no-follow draft and verifies the durable read-back", () => {
  withDirectory((directory) => {
    const realDraft = resolve(directory, "real-draft.json");
    const linkedDraft = resolve(directory, "linked-draft.json");
    writeFileSync(realDraft, "{}\n", { mode: 0o600 });
    symlinkSync(realDraft, linkedDraft);
    assert.throws(
      () =>
        generateDataWranglerComparisonSpecification(
          { draft: linkedDraft, out: resolve(directory, "specification.json") },
          {
            captureMethodology: () => ({
              protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
              sha256: "c".repeat(64)
            })
          }
        ),
      /bounded, owned, singly linked regular JSON file/u
    );

    writeFileSync(realDraft, '{"method":null,"method":{}}\n', { mode: 0o600 });
    assert.throws(
      () => readBoundedDataWranglerComparisonSpecificationDraft(realDraft),
      /must not contain duplicate keys/u
    );
    writeFileSync(realDraft, "{}\n", { mode: 0o600 });

    assert.throws(
      () =>
        generateDataWranglerComparisonSpecification(
          { draft: realDraft, out: resolve(directory, "specification.json") },
          {
            captureMethodology: () => ({
              protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
              sha256: "d".repeat(64)
            }),
            buildManifest: (value) => value,
            writeSpecification: () => ({ status: "published" }),
            readSpecification: () => ({ method: { protocol: "changed", sha256: "e".repeat(64) } })
          }
        ),
      /does not match the validated generated value/u
    );
  });
});

test("specification generator arguments are explicit", () => {
  const cwd = resolve("/tmp", "study-spec-cwd");
  assert.deepEqual(
    parseDataWranglerComparisonSpecificationArguments(["--draft", "draft.json", "--out", "spec.json"], cwd),
    { draft: resolve(cwd, "draft.json"), out: resolve(cwd, "spec.json") }
  );
  assert.throws(
    () => parseDataWranglerComparisonSpecificationArguments(["--draft", "one.json", "--draft", "two.json"], cwd),
    /Usage/u
  );
});

test("checked-in specification schema is draft 2020-12 and covers the validated top-level contract", async () => {
  const schemaPath = resolve("docs/performance-comparison.spec.schema.json");
  const bytes = readFileSync(schemaPath);
  const schema = JSON.parse(bytes.toString("utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "studyId",
    "createdAtUtc",
    "method",
    "candidate",
    "baseline",
    "editor",
    "python",
    "fixtures",
    "provenance"
  ]);
  assert.equal(schema.properties.method.$ref, "#/$defs/method");
  assert.equal(schema.properties.provenance.$ref, "#/$defs/provenance");
  assert.equal(schema.$defs.provenance.additionalProperties, false);
  assert.equal(schema.$defs.fixtureToolchain.properties.contractVersion.const, 1);
  assert.equal(schema.$defs.python.properties.packages.minItems, 5);
  assert.equal(schema.$defs.fixtureList.minItems, 2);
  const generatedType = await compileFromFile(schemaPath, { bannerComment: "" });
  assert.match(generatedType, /export interface OpenWranglerDataWranglerPerformanceStudySpecification/u);
  assert.equal(createHash("sha256").update(canonicalStudyJson(schema), "utf8").digest("hex").length, 64);
});
