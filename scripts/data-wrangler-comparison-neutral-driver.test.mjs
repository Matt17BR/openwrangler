import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  comparisonProductSettings,
  comparisonHostRequest,
  summarizePss,
  verifyComparisonSource
} from "./data-wrangler-comparison-neutral-driver.mjs";

test("enables each product's public notebook renderer for Pandas and Polars", () => {
  assert.deepEqual(comparisonProductSettings("open-wrangler"), {
    "openWrangler.notebookPreviewProvider": "openWrangler"
  });
  assert.deepEqual(comparisonProductSettings("data-wrangler"), {
    "dataWrangler.outputRenderer.enabled": true,
    "dataWrangler.outputRenderer.enabledTypes": {
      "pandas.core.frame.DataFrame": true,
      "pandas.DataFrame": true,
      "polars.dataframe.frame.DataFrame": true
    }
  });
});

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

test("PSS summary requires a settled pre-action window and keeps the measured absolute peak", () => {
  const samples = [
    ...Array.from({ length: 20 }, (_unused, index) => sample(1_000_000_000 + index * 200_000_000, 100)),
    sample(5_000_000_000, 180),
    sample(5_200_000_000, 160),
    sample(5_400_000_000, 999)
  ];
  const summary = summarizePss(samples, [
    { name: "run-cell-click", monotonicNs: "5000000000" },
    { name: "profiles-complete", monotonicNs: "5300000000" }
  ]);
  assert.deepEqual(summary, {
    peakPssBytes: 180,
    sampleCount: 23,
    intervalMs: 200,
    samples: samples.map(({ monotonicNs, pssBytes }) => sanitizedSample(monotonicNs, pssBytes))
  });
  assert.equal(JSON.stringify(summary).includes("rootPid"), false);
  assert.equal(JSON.stringify(summary).includes("processes"), false);
});

test("PSS evidence rejects an out-of-order raw series", () => {
  assert.throws(() => summarizePss([sample(200, 100), sample(100, 200)], []), /increase strictly/u);
});

test("PSS evidence rejects a rising pre-action process tree", () => {
  const samples = [
    ...Array.from({ length: 20 }, (_unused, index) =>
      sample(1_000_000_000 + index * 200_000_000, 100_000_000 + index * 10_000_000)
    ),
    sample(5_000_000_000, 300_000_000)
  ];
  assert.throws(
    () =>
      summarizePss(samples, [
        { name: "run-cell-click", monotonicNs: "5000000000" },
        { name: "profiles-complete", monotonicNs: "5100000000" }
      ]),
    /plateau|drifting/u
  );
});

function sample(monotonicNs, pssBytes) {
  return { monotonicNs: String(monotonicNs), rootPid: 10, processCount: 1, pssBytes, processes: [] };
}

function sanitizedSample(monotonicNs, pssBytes) {
  return { monotonicNs: String(monotonicNs), pssBytes, processCount: 1 };
}
