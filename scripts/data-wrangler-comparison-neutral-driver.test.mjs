import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  comparisonHostRequest,
  summarizePss,
  verifyComparisonSource
} from "./data-wrangler-comparison-neutral-driver.mjs";

test("host request omits the launcher-only VS Code CLI path", () => {
  const request = {
    protocol: "openwrangler-comparison-trial-request-v1",
    editor: {
      path: "/code",
      cliPath: "/code-cli",
      version: "1.131.0",
      sha256: "a".repeat(64),
      cliSha256: "b".repeat(64)
    },
    cell: {
      id: "pandas-csv",
      engine: "pandas",
      format: "csv",
      rows: 100_000,
      columns: 50,
      source: "/source.csv",
      sourceSha256: "c".repeat(64),
      variableName: "study_frame"
    }
  };
  const host = comparisonHostRequest(request);
  assert.deepEqual(host.editor, {
    path: "/code",
    version: "1.131.0",
    sha256: "a".repeat(64)
  });
  assert.equal(request.editor.cliPath, "/code-cli");
  assert.equal(Object.hasOwn(host.cell, "sourceSha256"), false);
});

test("private trial sources are checked before and after editor use", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-comparison-source-"));
  const source = join(root, "source.csv");
  try {
    writeFileSync(source, "value\n1\n");
    const expected = createHash("sha256").update("value\n1\n").digest("hex");
    assert.doesNotThrow(() => verifyComparisonSource(source, expected));
    writeFileSync(source, "value\n2\n");
    assert.throws(() => verifyComparisonSource(source, expected), /SHA-256 changed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PSS summary uses the pre-action median and measured-window peak", () => {
  const samples = [
    sample(100, 100),
    sample(200, 120),
    sample(300, 110),
    sample(400, 180),
    sample(500, 160),
    sample(600, 999)
  ];
  const summary = summarizePss(samples, [
    { name: "run-cell-click", monotonicNs: "350" },
    { name: "profiles-complete", monotonicNs: "550" }
  ]);
  assert.deepEqual(summary, {
    baselinePssBytes: 110,
    peakPssBytes: 180,
    adjustedPeakPssBytes: 70,
    sampleCount: 6,
    intervalMs: 200,
    samples: [
      sanitizedSample(100, 100),
      sanitizedSample(200, 120),
      sanitizedSample(300, 110),
      sanitizedSample(400, 180),
      sanitizedSample(500, 160),
      sanitizedSample(600, 999)
    ]
  });
  assert.equal(JSON.stringify(summary).includes("rootPid"), false);
  assert.equal(JSON.stringify(summary).includes("processes"), false);
});

test("PSS evidence rejects an out-of-order raw series", () => {
  assert.throws(() => summarizePss([sample(200, 100), sample(100, 200)], []), /increase strictly/u);
});

function sample(monotonicNs, pssBytes) {
  return { monotonicNs: String(monotonicNs), rootPid: 10, processCount: 1, pssBytes, processes: [] };
}

function sanitizedSample(monotonicNs, pssBytes) {
  return { monotonicNs: String(monotonicNs), pssBytes, processCount: 1 };
}
