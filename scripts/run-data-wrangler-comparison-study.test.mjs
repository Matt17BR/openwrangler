import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DATA_WRANGLER_STUDY_METHOD_PROTOCOL, createStudyFragmentIdentity } from "./data-wrangler-comparison-study.mjs";
import {
  parseDataWranglerComparisonStudyArguments,
  runDataWranglerComparisonStudy
} from "./run-data-wrangler-comparison-study.mjs";

const digest = (value) => value.repeat(64);

test("study command arguments are explicit and reject missing or repeated paths", () => {
  assert.deepEqual(
    parseDataWranglerComparisonStudyArguments(["plan", "--spec", "spec.json", "--out", "manifest.json"], "/work"),
    { command: "plan", spec: "/work/spec.json", out: "/work/manifest.json" }
  );
  assert.throws(
    () => parseDataWranglerComparisonStudyArguments(["plan", "--spec", "spec.json"], "/work"),
    /requires --out/u
  );
  assert.throws(
    () =>
      parseDataWranglerComparisonStudyArguments(
        ["status", "--manifest", "one.json", "--manifest", "two.json", "--fragments", "fragments"],
        "/work"
      ),
    /only once/u
  );
  assert.throws(() => parseDataWranglerComparisonStudyArguments(["launch"], "/work"), /Usage/u);
});

test("plan, record, and status preserve one immutable manifest and append-only fragment", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(directory, "manifest.json");
    const fragmentInputPath = resolve(directory, "fragment-input.json");
    const fragments = resolve(directory, "fragments");
    writeFileSync(specificationPath, JSON.stringify(studySpecification()));

    const planned = runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
      cwd: directory
    });
    assert.equal(planned.output.schedule.length, 96);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).studyId, planned.output.studyId);
    assert.throws(
      () =>
        runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
          cwd: directory
        }),
      /EEXIST/u
    );

    const entry = planned.output.schedule[0];
    const fragment = {
      ...createStudyFragmentIdentity({
        manifest: planned.output,
        scheduleEntry: entry,
        recordedAtUtc: "2026-08-02T11:00:00.000Z"
      }),
      outcome: { status: "success", reasonClass: null, actionStarted: true, correctness: "passed" },
      milestones: {
        inlineActionMs: 1,
        inlineReadyMs: 2,
        workbenchActionMs: 3,
        workbenchReadyMs: 4,
        profileActionMs: 5,
        firstProfileReadyMs: 6,
        profilesCompleteMs: 7,
        samplingStoppedMs: 2_007
      },
      resourceObservation: null
    };
    writeFileSync(fragmentInputPath, JSON.stringify(fragment));
    const recorded = runDataWranglerComparisonStudy(
      ["record", "--manifest", manifestPath, "--fragments", fragments, "--fragment", fragmentInputPath],
      { cwd: directory }
    );
    assert.equal(recorded.output.fragmentId, fragment.fragmentId);
    const status = runDataWranglerComparisonStudy(["status", "--manifest", manifestPath, "--fragments", fragments], {
      cwd: directory
    });
    assert.equal(status.output.fragmentCount, 1);
    assert.equal(status.output.pendingCount, 95);
    assert.throws(
      () =>
        runDataWranglerComparisonStudy(
          ["finalize", "--manifest", manifestPath, "--fragments", fragments, "--out", "result.json"],
          { cwd: directory }
        ),
      /planned pair work remains/u
    );
  });
});

function studySpecification() {
  return {
    studyId: "11111111-1111-4111-8111-111111111111",
    createdAtUtc: "2026-08-02T10:00:00.000Z",
    method: { protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL, sha256: digest("1") },
    candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1", sha256: digest("2") },
    baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
    editor: { id: "Microsoft.VisualStudioCode", version: "1.130.0", sha256: digest("3") },
    python: {
      implementation: "CPython",
      version: "3.12.10",
      executableSha256: digest("4"),
      environmentSha256: digest("5")
    },
    fixtures: [
      { id: "csv-100k-50", format: "csv", rows: 100_000, columns: 50, sha256: digest("6") },
      { id: "parquet-1m-20", format: "parquet", rows: 1_000_000, columns: 20, sha256: digest("7") }
    ]
  };
}

function withDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-study-command-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
