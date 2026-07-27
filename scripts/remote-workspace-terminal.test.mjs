import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PINNED_REMOTE_SSH_BYTES,
  PINNED_REMOTE_SSH_SHA256,
  PINNED_REMOTE_SSH_VERSION,
  REMOTE_WORKSPACE_AUTHORITY,
  createRemoteWorkspaceHostIsolationDigest
} from "./remote-workspace-acceptance.mjs";
import { PINNED_REMOTE_VSCODE_COMMIT } from "./remote-workspace-acquisition.mjs";
import { validateRemoteWorkspaceTerminal } from "./remote-workspace-terminal.mjs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EXPECTED = Object.freeze({
  runId: RUN_ID,
  sha256: "a".repeat(64),
  bytes: 123,
  hostIsolationSha256: createRemoteWorkspaceHostIsolationDigest("/host-home", "/host-sentinel")
});

for (const outcome of ["success", "failure"]) {
  test(`Remote SSH host terminal validation revalidates the complete ${outcome} boundary`, async () => {
    const fixture = realpathSync(await mkdtemp(join(tmpdir(), `ow-remote-terminal-${outcome}-`)));
    const resultPath = join(fixture, "result.json");
    const result =
      outcome === "success"
        ? { protocol: 1, runId: RUN_ID, phase: "remote-workspace", ok: true }
        : {
            protocol: 1,
            runId: RUN_ID,
            phase: "remote-workspace",
            ok: false,
            error: "deliberate failure"
          };
    const contents = JSON.stringify(result);
    let revalidated = 0;
    try {
      await writeFile(resultPath, contents, { mode: 0o600, flag: "wx" });
      const terminal = await validateRemoteWorkspaceTerminal({
        stdout: `${JSON.stringify(attestation(outcome, contents))}\n`,
        stderr: "",
        resultPath,
        expected: EXPECTED,
        async revalidate() {
          revalidated += 1;
          assert.equal(await readFile(resultPath, "utf8"), contents);
        }
      });
      assert.equal(revalidated, 1);
      assert.equal(terminal.result.outcome, outcome);
      assert.equal(terminal.result.error, result.error);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

for (const [controllerCode, controllerError] of [
  [
    "phase-cleanup-failed",
    "controller:phase-cleanup-failed: the isolated Remote SSH process or display cleanup failed."
  ],
  [
    "phase-result-validation-failed",
    "controller:phase-result-validation-failed: the isolated Remote SSH terminal evidence failed validation."
  ]
]) {
  for (const resultOutcome of ["success", "failure"]) {
    test(`Remote SSH host terminal validation preserves an existing ${resultOutcome} result after ${controllerCode}`, async () => {
      const fixture = realpathSync(await mkdtemp(join(tmpdir(), `ow-remote-terminal-controller-${resultOutcome}-`)));
      const resultPath = join(fixture, "result.json");
      const result =
        resultOutcome === "success"
          ? { protocol: 1, runId: RUN_ID, phase: "remote-workspace", ok: true }
          : {
              protocol: 1,
              runId: RUN_ID,
              phase: "remote-workspace",
              ok: false,
              error: "underlying harness failure"
            };
      const contents = JSON.stringify(result);
      let revalidated = 0;
      try {
        await writeFile(resultPath, contents, { mode: 0o600, flag: "wx" });
        const terminal = await validateRemoteWorkspaceTerminal({
          stdout: `${JSON.stringify(controllerAttestation(controllerCode, resultOutcome, contents))}\n`,
          stderr: "",
          resultPath,
          expected: EXPECTED,
          async revalidate() {
            revalidated += 1;
            assert.equal(await readFile(resultPath, "utf8"), contents);
          }
        });
        assert.equal(revalidated, 1);
        assert.equal(await readFile(resultPath, "utf8"), contents);
        assert.equal(terminal.attestation.outcome, "failure");
        assert.equal(terminal.attestation.resultOutcome, resultOutcome);
        assert.deepEqual(terminal.result, {
          protocol: 1,
          runId: RUN_ID,
          phase: "remote-workspace",
          ok: false,
          error: controllerError,
          outcome: "failure"
        });
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
}

test("Remote SSH host terminal validation rejects stderr before touching a result path", async () => {
  let revalidated = false;
  await assert.rejects(
    validateRemoteWorkspaceTerminal({
      stdout: "",
      stderr: "unexpected",
      resultPath: "/not-touched",
      expected: EXPECTED,
      revalidate() {
        revalidated = true;
      }
    }),
    /unexpected diagnostic stream/u
  );
  assert.equal(revalidated, false);
});

test("Remote SSH host terminal validation rejects result receipt drift before final provenance", async () => {
  const fixture = realpathSync(await mkdtemp(join(tmpdir(), "ow-remote-terminal-mismatch-")));
  const resultPath = join(fixture, "result.json");
  const contents = JSON.stringify({ protocol: 1, runId: RUN_ID, phase: "remote-workspace", ok: true });
  let revalidated = false;
  try {
    await writeFile(resultPath, contents, { mode: 0o600, flag: "wx" });
    await assert.rejects(
      validateRemoteWorkspaceTerminal({
        stdout: `${JSON.stringify({ ...attestation("success", contents), resultSha256: "b".repeat(64) })}\n`,
        stderr: "",
        resultPath,
        expected: EXPECTED,
        revalidate() {
          revalidated = true;
        }
      }),
      /did not match/u
    );
    assert.equal(revalidated, false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH controller terminal validation rejects its underlying outcome before final provenance", async () => {
  const fixture = realpathSync(await mkdtemp(join(tmpdir(), "ow-remote-terminal-controller-mismatch-")));
  const resultPath = join(fixture, "result.json");
  const contents = JSON.stringify({ protocol: 1, runId: RUN_ID, phase: "remote-workspace", ok: true });
  let revalidated = false;
  try {
    await writeFile(resultPath, contents, { mode: 0o600, flag: "wx" });
    await assert.rejects(
      validateRemoteWorkspaceTerminal({
        stdout: `${JSON.stringify(controllerAttestation("phase-result-validation-failed", "failure", contents))}\n`,
        stderr: "",
        resultPath,
        expected: EXPECTED,
        revalidate() {
          revalidated = true;
        }
      }),
      /did not match/u
    );
    assert.equal(revalidated, false);
    assert.equal(await readFile(resultPath, "utf8"), contents);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH final provenance drift overrides a validated harness failure", async () => {
  const fixture = realpathSync(await mkdtemp(join(tmpdir(), "ow-remote-terminal-final-drift-")));
  const resultPath = join(fixture, "result.json");
  const displaced = join(fixture, "displaced.json");
  const contents = JSON.stringify({
    protocol: 1,
    runId: RUN_ID,
    phase: "remote-workspace",
    ok: false,
    error: "must not escape before final validation"
  });
  try {
    await writeFile(resultPath, contents, { mode: 0o600, flag: "wx" });
    await assert.rejects(
      validateRemoteWorkspaceTerminal({
        stdout: `${JSON.stringify(attestation("failure", contents))}\n`,
        stderr: "",
        resultPath,
        expected: EXPECTED,
        async revalidate() {
          await rename(resultPath, displaced);
          throw new Error("final provenance changed");
        }
      }),
      (error) => {
        assert.match(error.message, /terminal boundary failed|final provenance changed/u);
        assert.doesNotMatch(error.message, /must not escape/u);
        return true;
      }
    );
    assert.equal(await readFile(displaced, "utf8"), contents);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function attestation(outcome, resultContents) {
  return {
    protocol: 1,
    runId: RUN_ID,
    phase: "remote-workspace",
    namespaceEmpty: true,
    network: "unshared",
    ipc: "unshared",
    uts: "unshared",
    hostname: "openwrangler-remote-acceptance",
    display: "xvfb",
    displayEmpty: true,
    remoteAuthority: REMOTE_WORKSPACE_AUTHORITY,
    version: "1.130.0",
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    candidateSha256: EXPECTED.sha256,
    candidateBytes: EXPECTED.bytes,
    remoteSshVersion: PINNED_REMOTE_SSH_VERSION,
    remoteSshBytes: PINNED_REMOTE_SSH_BYTES,
    remoteSshSha256: PINNED_REMOTE_SSH_SHA256,
    hostIsolationSha256: EXPECTED.hostIsolationSha256,
    outcome,
    resultBytes: Buffer.byteLength(resultContents),
    resultSha256: createHash("sha256").update(resultContents).digest("hex"),
    capabilities: {
      inheritable: 0,
      permitted: 0,
      effective: 0,
      bounding: 0,
      ambient: 0
    }
  };
}

function controllerAttestation(controllerCode, resultOutcome, resultContents) {
  const { resultBytes, resultSha256, capabilities, ...prefix } = attestation("failure", resultContents);
  return {
    ...prefix,
    controllerCode,
    resultOutcome,
    resultBytes,
    resultSha256,
    capabilities
  };
}
