import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseInstalledPerformanceArguments,
  runInstalledMeasuredEditorPhase,
  stageInstalledPerformanceVsix,
  writeInstalledPerformanceRun
} from "./run-installed-performance.mjs";

test("installed performance arguments default to both first-class editors", () => {
  const parsed = parseInstalledPerformanceArguments(["candidate.vsix"]);

  assert.equal(parsed.smoke, false);
  assert.deepEqual(parsed.editors, ["vscode", "cursor"]);
  assert.match(parsed.vsix, /candidate\.vsix$/u);
  assert.match(parsed.output, /tmp[/\\]performance[/\\]installed-performance\.json$/u);
});

test("installed performance arguments support explicit smoke editor sharding", () => {
  const parsed = parseInstalledPerformanceArguments([
    "candidate.vsix",
    "--smoke",
    "--editors",
    "vscode",
    "--out",
    "tmp/custom.json"
  ]);

  assert.equal(parsed.smoke, true);
  assert.deepEqual(parsed.editors, ["vscode"]);
  assert.match(parsed.output, /tmp[/\\]custom\.json$/u);
  assert.throws(
    () => parseInstalledPerformanceArguments(["candidate.vsix", "--editors", "vscode,vscode"]),
    /unique comma-separated subset/u
  );
  assert.throws(
    () => parseInstalledPerformanceArguments(["candidate.vsix", "--unknown"]),
    /Unknown installed-performance option/u
  );
});

test("the VSIX snapshot copies and hashes one pinned regular file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    const bytes = Buffer.from("deterministic candidate bytes");
    await writeFile(source, bytes);

    const snapshot = stageInstalledPerformanceVsix(source, destination);

    assert.equal(snapshot.bytes, bytes.length);
    assert.equal(snapshot.sha256, "4fd9b5f5c728de97c6b47a9db2fa77ec840d29766f562b7cff26fe4a0a903391");
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the VSIX snapshot rejects symbolic and hard-linked candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const symbolic = join(directory, "symbolic.vsix");
    const hard = join(directory, "hard.vsix");
    await writeFile(source, "candidate");
    await symlink(source, symbolic);
    assert.throws(
      () => stageInstalledPerformanceVsix(symbolic, join(directory, "symbolic-copy.vsix")),
      /single-link regular VSIX/u
    );
    await link(source, hard);
    assert.throws(
      () => stageInstalledPerformanceVsix(source, join(directory, "hard-copy.vsix")),
      /single-link regular VSIX/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the installed performance result writer replaces only a regular destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const destination = join(directory, "results", "installed-performance.json");
    writeInstalledPerformanceRun(destination, { protocol: "test", value: 1 });
    writeInstalledPerformanceRun(destination, { protocol: "test", value: 2 });
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { protocol: "test", value: 2 });

    const linked = join(directory, "linked.json");
    await mkdir(join(directory, "target"));
    await symlink(destination, linked);
    assert.throws(
      () => writeInstalledPerformanceRun(linked, { protocol: "test" }),
      /absent or a single-link regular file/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("measured editor phases attach after spawn and sample only after verified phase cleanup", async () => {
  const events = [];
  const child = { pid: 4812 };
  await runInstalledMeasuredEditorPhase({
    phase: "perf-parquet-warm",
    sampler: {
      begin(phase, processGroupId) {
        events.push(["begin", phase, processGroupId]);
      },
      end() {
        events.push(["end"]);
      }
    },
    spawnOwned() {
      events.push(["spawn"]);
      return child;
    },
    async runPhase(spawnProcess) {
      assert.equal(spawnProcess("editor", [], {}), child);
      events.push(["phase-clean"]);
    }
  });
  assert.deepEqual(events, [["spawn"], ["begin", "perf-parquet-warm", 4812], ["phase-clean"], ["end"]]);
});

test("RSS attachment faults never interrupt editor cleanup and aggregate with phase faults", async () => {
  const phaseError = new Error("phase cleanup failed");
  const samplerError = new Error("sampler attach failed");
  let phaseContinued = false;
  await assert.rejects(
    runInstalledMeasuredEditorPhase({
      phase: "perf-csv-cold",
      sampler: {
        begin() {
          throw samplerError;
        },
        end() {
          assert.fail("a sampler that never attached must not be ended");
        }
      },
      spawnOwned() {
        return { pid: 912 };
      },
      async runPhase(spawnProcess) {
        spawnProcess("editor", [], {});
        phaseContinued = true;
        throw phaseError;
      }
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.includes(phaseError) &&
      error.errors.includes(samplerError)
  );
  assert.equal(phaseContinued, true);
});
