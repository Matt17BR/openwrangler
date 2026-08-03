import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DATA_WRANGLER_PUBLIC_UI_CAPTURE_PHASE_PROTOCOL,
  assertDataWranglerPublicUiManifestEntryMatchesPhase,
  deriveDataWranglerPublicUiManifestEntryFromPhase
} from "./data-wrangler-comparison-public-phase-receipt.mjs";
import {
  PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
  PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
  PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
  PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
  canonicalPublicUiReceiptJson,
  createPublicUiReceiptContext,
  digestPublicUiReceiptEvidence
} from "./data-wrangler-public-ui-receipts.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";

const fixture = Object.freeze({
  id: "csv-100k-50",
  format: "csv",
  rows: 100_000,
  columns: 2,
  sha256: "6".repeat(64),
  schema: Object.freeze([
    Object.freeze({ name: "c00", dtype: "int64" }),
    Object.freeze({ name: "c01", dtype: "int64" })
  ]),
  sentinels: Object.freeze([
    Object.freeze({ rowIndex: 0, column: "c00", value: 0 }),
    Object.freeze({ rowIndex: 1, column: "c01", value: 2 }),
    Object.freeze({ rowIndex: 99_999, column: "c01", value: 100_000 })
  ])
});
const editor = Object.freeze({
  id: "Microsoft.VisualStudioCode",
  version: "1.130.0",
  sha256: "3".repeat(64),
  uiLocale: "en"
});
const kernel = Object.freeze({
  name: "openwrangler-study-private",
  displayName: "Open Wrangler study CPython 3.12.11 (private trial)"
});
const python = Object.freeze({ implementation: "CPython", version: "3.12.11" });
const sourceReceipt = Object.freeze({
  sha256: fixture.sha256,
  filesystemIdentity: Object.freeze({ device: "8", inode: "120", sizeBytes: 4096, mtimeNs: "1000000000" })
});

function context(captureId) {
  return createPublicUiReceiptContext({
    captureId,
    editor,
    source: {
      variableName: "study_frame",
      engine: "polars",
      semanticClass: "dataframe",
      rowCount: fixture.rows,
      columnCount: fixture.columns,
      schemaSha256: digestStudyValue(fixture.schema),
      sentinels: fixture.sentinels.map((sentinel) => ({
        rowIndex: sentinel.rowIndex,
        columnName: sentinel.column,
        value: sentinel.value
      }))
    }
  });
}

function actions(available = false) {
  return [
    {
      product: "open-wrangler",
      accessibleName: PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
      matchCount: 0,
      pointerUsable: false
    },
    {
      product: "data-wrangler",
      accessibleName: PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
      matchCount: available ? 1 : 0,
      pointerUsable: available
    }
  ];
}

function phase(kind, captureId) {
  const start = 10_000;
  const available = kind === "capability";
  const times = available
    ? [start, start + 250, start + 500]
    : [...Array(PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS / PUBLIC_UI_OBSERVATION_MAX_GAP_MS + 1).keys()].map(
        (index) => start + index * PUBLIC_UI_OBSERVATION_MAX_GAP_MS
      );
  const trace = times.map((atMonotonicMs, index) => ({
    atMonotonicMs,
    output: { ready: true, busy: false, obstructed: false, owner: "host-jupyter" },
    actions: actions(available && index >= times.length - 2)
  }));
  return {
    protocol: DATA_WRANGLER_PUBLIC_UI_CAPTURE_PHASE_PROTOCOL,
    captureId,
    kind,
    locale: "en",
    editorVersion: editor.version,
    study: {
      engine: "polars",
      format: fixture.format,
      kind: "warm",
      fixture: { id: fixture.id, sha256: fixture.sha256, rows: fixture.rows, columns: fixture.columns },
      kernel: { name: kernel.name, displayName: kernel.displayName },
      sourceReceipt: structuredClone(sourceReceipt)
    },
    verification: {
      phase: "before-timing",
      pythonImplementation: "CPython",
      pythonVersion: python.version,
      classMatched: true,
      shapeMatched: true,
      columnsMatched: true,
      integerDtypeMatched: true,
      sentinelsMatched: true,
      objectTokenContinuous: true,
      rowDataIncluded: false,
      observedSource: {
        file: structuredClone(sourceReceipt),
        semanticClass: "dataframe",
        rowCount: fixture.rows,
        columnCount: fixture.columns,
        schema: structuredClone(fixture.schema),
        sentinels: structuredClone(fixture.sentinels)
      }
    },
    observation: {
      clock: "linux-monotonic",
      startedAtMonotonicMs: start,
      endedAtMonotonicMs: times.at(-1),
      absenceDeadlineAtMonotonicMs: start + PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
      maxGapMs: PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
      sampleCount: trace.length
    },
    trace,
    output: structuredClone(trace.at(-1).output),
    actions: structuredClone(trace.at(-1).actions),
    conclusion: available ? "available" : "neither-product-control"
  };
}

function options(kind, raw, publicContext) {
  return {
    kind,
    fixtureId: fixture.id,
    phaseReceipt: raw,
    context: publicContext,
    editor,
    fixture,
    kernel,
    sourceReceipt,
    python
  };
}

function resignPhase(raw, mutate) {
  const changed = structuredClone(raw);
  mutate(changed);
  return { changed, sha256: digestStudyValue(changed) };
}

test("capability and control manifest receipts derive only from their retained raw phase evidence", () => {
  for (const [kind, captureId] of [
    ["capability", "11111111-1111-4111-8111-111111111111"],
    ["control", "22222222-2222-4222-8222-222222222222"]
  ]) {
    const raw = phase(kind, captureId);
    const publicContext = context(captureId);
    const entry = deriveDataWranglerPublicUiManifestEntryFromPhase(options(kind, raw, publicContext));
    assert.deepEqual(
      assertDataWranglerPublicUiManifestEntryMatchesPhase(entry, options(kind, raw, publicContext)),
      entry
    );
  }
});

test("recomputed raw digests cannot legitimize changed conclusion, trace, action, or source evidence", async (t) => {
  const raw = phase("capability", "11111111-1111-4111-8111-111111111111");
  const publicContext = context(raw.captureId);
  const manifestEntry = deriveDataWranglerPublicUiManifestEntryFromPhase(options("capability", raw, publicContext));
  const cases = [
    ["conclusion", (changed) => (changed.conclusion = "capability-timeout")],
    ["trace", (changed) => (changed.trace.at(-1).actions[1].matchCount = 0)],
    ["action", (changed) => (changed.actions[1].pointerUsable = false)],
    ["source", (changed) => (changed.verification.observedSource.rowCount -= 1)]
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const resigned = resignPhase(raw, mutate);
      assert.match(resigned.sha256, /^[0-9a-f]{64}$/u);
      assert.notEqual(resigned.sha256, digestStudyValue(raw));
      assert.throws(
        () =>
          assertDataWranglerPublicUiManifestEntryMatchesPhase(
            manifestEntry,
            options("capability", resigned.changed, publicContext)
          ),
        /Public-UI|capability|summary|trace|source/iu
      );
    });
  }
});

test("a recomputed manifest inventory receipt cannot replace the receipt derived from raw phase evidence", () => {
  const raw = phase("capability", "11111111-1111-4111-8111-111111111111");
  const publicContext = context(raw.captureId);
  const manifestEntry = structuredClone(
    deriveDataWranglerPublicUiManifestEntryFromPhase(options("capability", raw, publicContext))
  );
  const inventory = manifestEntry.receipt.evidence.extensions;
  inventory.entries.find((entry) => entry.extensionId === "ms-toolsai.datawrangler").version = "1.24.3";
  inventory.sha256 = createHash("sha256").update(canonicalPublicUiReceiptJson(inventory.entries), "utf8").digest("hex");
  manifestEntry.receipt.evidenceSha256 = digestPublicUiReceiptEvidence(manifestEntry.receipt.evidence);
  manifestEntry.receiptSha256 = digestStudyValue(manifestEntry.receipt);
  assert.equal(
    manifestEntry.receipt.evidenceSha256,
    createHash("sha256").update(canonicalPublicUiReceiptJson(manifestEntry.receipt.evidence), "utf8").digest("hex")
  );
  assert.throws(
    () => assertDataWranglerPublicUiManifestEntryMatchesPhase(manifestEntry, options("capability", raw, publicContext)),
    /does not derive exactly/iu
  );
});
