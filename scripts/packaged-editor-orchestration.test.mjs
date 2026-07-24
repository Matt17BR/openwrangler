import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retainEditorAcceptanceEvidence } from "./editor-acceptance-evidence.mjs";
import {
  assertEditorAcceptancePrivateRootReceipt,
  createEditorAcceptancePrivateRootReceipt,
  packagedEditorFailureLeaves,
  removeEditorAcceptancePrivateRoot,
  runPackagedEditorOrchestration,
  runWithRetainedFailure
} from "./packaged-editor-orchestration.mjs";

test("a packaged-editor failure is retained before its disposable profile is removed", async () => {
  const events = [];
  const failure = new Error("editor setup failed");

  await assert.rejects(
    runPackagedEditorOrchestration(
      {
        evidenceRoot: "/virtual/evidence",
        run: async () => {
          events.push("run");
          throw failure;
        },
        retainFailure: async (error) => {
          assert.equal(error, failure);
          events.push("retain");
        },
        cleanup: async () => {
          events.push("cleanup");
        },
        failureMessage: "VS Code packaged acceptance failed."
      },
      {
        clearEvidence(path) {
          assert.equal(path, "/virtual/evidence");
          events.push("clear");
        }
      }
    ),
    (error) => error === failure
  );
  assert.deepEqual(events, ["clear", "run", "retain", "cleanup"]);
});

test("retention and cleanup faults preserve the primary packaged-editor failure", async () => {
  const primary = new Error("display startup failed");
  const retention = new Error("evidence write failed");
  const cleanup = new Error("profile cleanup failed");

  await assert.rejects(
    runWithRetainedFailure({
      run: async () => {
        throw primary;
      },
      retainFailure: async () => {
        throw retention;
      },
      cleanup: async () => {
        throw cleanup;
      },
      failureMessage: "Packaged editor orchestration failed."
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "Packaged editor orchestration failed.");
      assert.deepEqual(error.errors, [primary, retention, retention, cleanup]);
      return true;
    }
  );
});

test("a primary failure followed by cleanup failure retains both diagnostics before rejection", async () => {
  const primary = new Error("editor phase failed");
  const cleanup = new Error("profile cleanup failed");
  const retained = [];

  await assert.rejects(
    runWithRetainedFailure({
      run: async () => {
        throw primary;
      },
      retainFailure: async (error, context) => retained.push([error, context.stage]),
      cleanup: async () => {
        throw cleanup;
      },
      failureMessage: "Editor phase and cleanup failed."
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    }
  );
  assert.deepEqual(retained, [
    [primary, "run"],
    [cleanup, "cleanup"]
  ]);
});

test("nested phase and shutdown aggregates expose each unique diagnostic leaf", () => {
  const phase = new Error("phase failed");
  const shutdown = new Error("shutdown failed");
  const nested = new AggregateError([phase, new AggregateError([shutdown, phase], "nested")], "combined");
  assert.deepEqual(packagedEditorFailureLeaves(nested), [phase, shutdown]);
});

test("empty and cyclic aggregates remain retainable diagnostic leaves", () => {
  const empty = new AggregateError([], "empty aggregate");
  const cyclic = new AggregateError([], "cyclic aggregate");
  cyclic.errors.push(cyclic);
  assert.deepEqual(packagedEditorFailureLeaves(empty), [empty]);
  assert.deepEqual(packagedEditorFailureLeaves(cyclic), [cyclic]);
});

test("an unverified editor tree prevents every access to its private root", () => {
  let removeCalled = false;
  assert.throws(
    () =>
      removeEditorAcceptancePrivateRoot(Object.freeze({ path: "/must-not-be-touched" }), {
        processTreeVerifiedStopped: false,
        moveToQuarantine() {
          removeCalled = true;
        }
      }),
    (error) => {
      assert.equal(error.code, "EDITOR_PRIVATE_ROOT_CLEANUP_WITHHELD");
      assert.equal(error.details.treeVerifiedStopped, false);
      assert.equal(error.details.privateRootCleanup, "withheld");
      assert.doesNotMatch(error.message, /must-not-be-touched/u);
      return true;
    }
  );
  assert.equal(removeCalled, false);
});

test("a lost private-path identity prevents every access to its former root", () => {
  let removeCalled = false;
  assert.throws(
    () =>
      removeEditorAcceptancePrivateRoot(Object.freeze({ path: "/must-not-be-touched" }), {
        privatePathsVerified: false,
        moveToQuarantine() {
          removeCalled = true;
        }
      }),
    (error) => {
      assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
      assert.equal(error.details.privateRootIdentity, "lost");
      assert.doesNotMatch(error.message, /must-not-be-touched/u);
      return true;
    }
  );
  assert.equal(removeCalled, false);
});

test("private-root receipts reject a rebound directory without removing its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-rebind-"));
  const parent = join(directory, "private-parent");
  const privateRoot = join(parent, "captured-root");
  const displaced = join(parent, "displaced-root");
  const replacement = join(directory, "replacement-root");
  const replacementMarker = join(privateRoot, "user-owned.txt");
  try {
    await mkdir(privateRoot, { recursive: true });
    await mkdir(replacement);
    await writeFile(join(replacement, "user-owned.txt"), "preserve me\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: parent });

    await rename(privateRoot, displaced);
    await rename(replacement, privateRoot);

    assert.throws(
      () => assertEditorAcceptancePrivateRootReceipt(receipt),
      (error) => error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
    assert.throws(
      () => removeEditorAcceptancePrivateRoot(receipt),
      (error) => error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
    assert.equal(await readFile(replacementMarker, "utf8"), "preserve me\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private-root cleanup removes only the directory bound to its receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-cleanup-"));
  const privateRoot = join(directory, "captured-root");
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });
    assert.equal(assertEditorAcceptancePrivateRootReceipt(receipt), privateRoot);
    removeEditorAcceptancePrivateRoot(receipt);
    await assert.rejects(stat(privateRoot), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private-root cleanup never deletes a directory rebound during quarantine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-quarantine-rebind-"));
  const privateRoot = join(directory, "captured-root");
  const displaced = join(directory, "displaced-root");
  const replacement = join(directory, "replacement-root");
  const cleanupId = "11111111-1111-4111-8111-111111111111";
  const quarantine = join(directory, `.openwrangler-remove-${cleanupId}`);
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    await mkdir(replacement);
    await writeFile(join(replacement, "user-owned.txt"), "preserve me\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          cleanupId: () => cleanupId,
          moveToQuarantine(source, target) {
            renameSync(source, displaced);
            renameSync(replacement, source);
            renameSync(source, target);
          }
        }),
      (error) => error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
    assert.equal(await readFile(join(displaced, "owned.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(quarantine, "user-owned.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private-root cleanup revalidates its random quarantine immediately before deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-final-rebind-"));
  const privateRoot = join(directory, "captured-root");
  const displaced = join(directory, "displaced-root");
  const cleanupId = "22222222-2222-4222-8222-222222222222";
  const quarantine = join(directory, `.openwrangler-remove-${cleanupId}`);
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          cleanupId: () => cleanupId,
          beforeRemove(target) {
            renameSync(target, displaced);
            mkdirSync(target);
            writeFileSync(join(target, "user-owned.txt"), "preserve me\n");
          }
        }),
      (error) => error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
    assert.equal(await readFile(join(displaced, "owned.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(quarantine, "user-owned.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("combined phase and cleanup failures persist as distinct bounded evidence attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-orchestration-combined-"));
  const temporaryRoot = join(directory, "private");
  const profile = join(temporaryRoot, "profile");
  const resultPath = join(profile, "verify-result.json");
  const evidenceRoot = join(directory, "evidence");
  const primary = new Error("phase diagnostic must survive");
  const cleanup = new Error("cleanup diagnostic must survive");
  let attempt = 0;
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(resultPath, "{}\n");
    await assert.rejects(
      runWithRetainedFailure({
        run: async () => {
          throw primary;
        },
        retainFailure: async (error, { stage }) => {
          const phase = stage === "cleanup" ? "cleanup" : "verify";
          retainEditorAcceptanceEvidence({
            evidenceRoot,
            temporaryRoot,
            profile,
            editor: { key: "vscode", name: "VS Code", version: "1.129.0" },
            phase,
            attempt: (attempt += 1),
            error,
            resultPath
          });
        },
        cleanup: async () => {
          throw cleanup;
        },
        failureMessage: "Combined editor failure."
      }),
      (error) => error instanceof AggregateError
    );

    assert.equal(attempt, 2);
    const attempts = (await readdir(evidenceRoot)).sort();
    assert.deepEqual(attempts, ["vscode-1.129.0-cleanup-attempt-2", "vscode-1.129.0-verify-attempt-1"]);
    const failures = await Promise.all(
      attempts.map(async (name) => JSON.parse(await readFile(join(evidenceRoot, name, "failure.json"), "utf8")))
    );
    assert.equal(
      failures.some(
        (failure) => failure.phase === "verify" && failure.message.includes("phase diagnostic must survive")
      ),
      true
    );
    assert.equal(
      failures.some(
        (failure) => failure.phase === "cleanup" && failure.message.includes("cleanup diagnostic must survive")
      ),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cleanup-only failure persists in an explicit cleanup evidence directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-orchestration-cleanup-"));
  const temporaryRoot = join(directory, "private");
  const profile = join(temporaryRoot, "profile");
  const resultPath = join(profile, "verify-result.json");
  const evidenceRoot = join(directory, "evidence");
  const cleanup = new Error("cleanup-only diagnostic must survive");
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(resultPath, "{}\n");
    await assert.rejects(
      runWithRetainedFailure({
        run: async () => undefined,
        retainFailure: async (error, { stage }) => {
          assert.equal(stage, "cleanup");
          retainEditorAcceptanceEvidence({
            evidenceRoot,
            temporaryRoot,
            profile,
            editor: { key: "cursor", name: "Cursor", version: "3.11.19" },
            phase: "cleanup",
            error,
            resultPath
          });
        },
        cleanup: async () => {
          throw cleanup;
        }
      }),
      (error) => error === cleanup
    );
    assert.deepEqual(await readdir(evidenceRoot), ["cursor-3.11.19-cleanup-attempt-1"]);
    const failure = JSON.parse(
      await readFile(join(evidenceRoot, "cursor-3.11.19-cleanup-attempt-1", "failure.json"), "utf8")
    );
    assert.equal(failure.phase, "cleanup");
    assert.match(failure.message, /cleanup-only diagnostic must survive/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("falsy thrown values still reject and retain instead of being mistaken for success", async () => {
  const events = [];
  let rejection = Symbol("not-rejected");
  try {
    await runWithRetainedFailure({
      run: async () => {
        throw 0;
      },
      retainFailure: async (error) => {
        assert.equal(error, 0);
        events.push("retain");
      },
      cleanup: async () => {
        events.push("cleanup");
      }
    });
  } catch (error) {
    rejection = error;
  }
  assert.equal(rejection, 0);
  assert.deepEqual(events, ["retain", "cleanup"]);
});

test("a cleanup failure after a successful editor run retains its remaining profile exactly once", async () => {
  const events = [];
  const cleanup = new Error("profile cleanup failed");
  let cleanupCalls = 0;

  await assert.rejects(
    runWithRetainedFailure({
      run: async () => {
        events.push("run");
      },
      retainFailure: async (error) => {
        assert.equal(error, cleanup);
        events.push("retain");
      },
      cleanup: async () => {
        cleanupCalls += 1;
        events.push("cleanup");
        throw cleanup;
      },
      failureMessage: "Cursor packaged acceptance cleanup failed."
    }),
    (error) => error === cleanup
  );
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(events, ["run", "cleanup", "retain"]);
});

test("a stale-evidence cleanup failure still retains diagnostics and cleans the private root", async () => {
  const events = [];
  const clearFailure = new Error("stale evidence could not be cleared");

  await assert.rejects(
    runPackagedEditorOrchestration(
      {
        evidenceRoot: "/virtual/evidence",
        run: async () => {
          assert.fail("the editor run must not start after evidence cleanup fails");
        },
        retainFailure: async (error) => {
          assert.equal(error, clearFailure);
          events.push("retain");
        },
        cleanup: async () => {
          events.push("cleanup");
        }
      },
      {
        clearEvidence() {
          events.push("clear");
          throw clearFailure;
        }
      }
    ),
    (error) => error === clearFailure
  );
  assert.deepEqual(events, ["clear", "retain", "cleanup"]);
});

test("stale-evidence and retention failures aggregate without skipping private-root cleanup", async () => {
  const events = [];
  const clearFailure = new Error("stale evidence could not be cleared");
  const retentionFailure = new Error("replacement evidence could not be retained");

  await assert.rejects(
    runPackagedEditorOrchestration(
      {
        evidenceRoot: "/virtual/evidence",
        run: async () => {
          assert.fail("the editor run must not start after evidence cleanup fails");
        },
        retainFailure: async () => {
          events.push("retain");
          throw retentionFailure;
        },
        cleanup: async () => {
          events.push("cleanup");
        },
        failureMessage: "Packaged editor orchestration could not prepare evidence."
      },
      {
        clearEvidence() {
          events.push("clear");
          throw clearFailure;
        }
      }
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "Packaged editor orchestration could not prepare evidence.");
      assert.deepEqual(error.errors, [clearFailure, retentionFailure]);
      return true;
    }
  );
  assert.deepEqual(events, ["clear", "retain", "cleanup"]);
});

test("a successful orchestration clears stale evidence and leaves no new evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-orchestration-success-"));
  const evidenceRoot = join(directory, "evidence");
  const privateRoot = join(directory, "private-root");
  const events = [];
  try {
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(privateRoot, { recursive: true });
    await writeFile(join(evidenceRoot, "stale-failure.json"), "{}\n");

    const result = await runPackagedEditorOrchestration(
      {
        evidenceRoot,
        run: async () => {
          events.push("run");
          return "passed";
        },
        retainFailure: async () => {
          assert.fail("successful orchestration must not retain failure evidence");
        },
        cleanup: async () => {
          events.push("cleanup");
          await rm(privateRoot, { recursive: true, force: true });
        }
      },
      {
        clearEvidence(path) {
          assert.equal(path, evidenceRoot);
          events.push("clear");
          rmSync(path, { recursive: true, force: true });
        }
      }
    );

    assert.equal(result, "passed");
    assert.deepEqual(events, ["clear", "run", "cleanup"]);
    await assert.rejects(readFile(join(evidenceRoot, "stale-failure.json")), { code: "ENOENT" });
    await assert.rejects(stat(evidenceRoot), { code: "ENOENT" });
    await assert.rejects(stat(privateRoot), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
