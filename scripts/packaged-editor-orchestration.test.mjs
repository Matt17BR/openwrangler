import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retainEditorAcceptanceEvidence } from "./editor-acceptance-evidence.mjs";
import {
  assertEditorAcceptancePrivateRootReceipt,
  cleanupPackagedCursorAcquisition,
  createEditorAcceptancePrivatePathIdentityLatch,
  createEditorAcceptancePrivatePathSafetyPolicy,
  createEditorAcceptancePrivateRootReceipt,
  packagedEditorFailureLeaves,
  retainPackagedEditorFailureLeaves,
  removeEditorAcceptancePrivateRoot,
  runPackagedEditorOrchestration,
  runWithRetainedFailure
} from "./packaged-editor-orchestration.mjs";
import {
  CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
  CANDIDATE_PYTHON_JUPYTER_PROFILE,
  packagedPythonJupyterEditorPlan,
  resolvePackagedPythonJupyterProfile
} from "./packaged-python-jupyter.mjs";
import {
  CORE_R_JUPYTER_SELECTOR,
  KERNEL_RESTART_R_JUPYTER_SELECTOR,
  NATIVE_FRAMES_R_JUPYTER_SELECTOR,
  PIVOT_WIDER_R_JUPYTER_SELECTOR,
  resolvePackagedRJourneySelection
} from "./packaged-r-journey.mjs";

test("candidate Python Jupyter gives comprehensive evidence to VS Code and one compatibility seam to Cursor", () => {
  assert.equal(CANDIDATE_PYTHON_JUPYTER_PROFILE, "candidate-one-owner");
  assert.equal(CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR, "candidate-compatibility-seam");
  const candidate = resolvePackagedPythonJupyterProfile({
    value: CANDIDATE_PYTHON_JUPYTER_PROFILE,
    acceptanceMode: "full",
    jupyterExtensionEnabled: true,
    dataWranglerCoexistenceEnabled: false,
    remoteJupyterEnabled: true,
    requestedEditors: ["vscode", "cursor"]
  });
  assert.deepEqual(packagedPythonJupyterEditorPlan(candidate, "vscode", true), {
    phases: ["jupyter-deny", "jupyter-allow", "jupyter-pyspark"],
    remote: true,
    allowSelector: undefined,
    integrationOnly: true
  });
  assert.deepEqual(packagedPythonJupyterEditorPlan(candidate, "cursor", true), {
    phases: ["jupyter-allow"],
    remote: false,
    allowSelector: CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
    integrationOnly: true
  });
});

test("unset Python Jupyter profile preserves complete manual coverage in both editors", () => {
  const profile = resolvePackagedPythonJupyterProfile({
    value: undefined,
    acceptanceMode: "full",
    jupyterExtensionEnabled: true,
    dataWranglerCoexistenceEnabled: false,
    remoteJupyterEnabled: true,
    requestedEditors: ["vscode", "cursor"]
  });
  for (const editor of ["vscode", "cursor"]) {
    assert.deepEqual(packagedPythonJupyterEditorPlan(profile, editor, true), {
      phases: ["jupyter-deny", "jupyter-allow", "jupyter-pyspark"],
      remote: true,
      allowSelector: undefined,
      integrationOnly: false
    });
  }
});

test("candidate Python Jupyter profile rejects every non-candidate context", () => {
  const base = {
    value: CANDIDATE_PYTHON_JUPYTER_PROFILE,
    acceptanceMode: "full",
    jupyterExtensionEnabled: true,
    dataWranglerCoexistenceEnabled: false,
    remoteJupyterEnabled: true,
    requestedEditors: ["vscode", "cursor"]
  };
  for (const overrides of [
    { value: "other" },
    { acceptanceMode: "platform-smoke" },
    { acceptanceMode: "r-jupyter" },
    { jupyterExtensionEnabled: false },
    { dataWranglerCoexistenceEnabled: true },
    { remoteJupyterEnabled: false },
    { requestedEditors: ["vscode"] },
    { requestedEditors: ["cursor", "vscode"] }
  ]) {
    assert.throws(() => resolvePackagedPythonJupyterProfile({ ...base, ...overrides }), /must be unset|valid only/u);
  }
});

test("R journey selection keeps combined diagnostics by default and isolates remote-only acceptance", () => {
  assert.equal(CORE_R_JUPYTER_SELECTOR, "core-operations");
  assert.equal(KERNEL_RESTART_R_JUPYTER_SELECTOR, "kernel-restart");
  assert.equal(NATIVE_FRAMES_R_JUPYTER_SELECTOR, "native-frames");
  assert.equal(PIVOT_WIDER_R_JUPYTER_SELECTOR, "pivot-wider");
  const resolve = (overrides = {}) =>
    resolvePackagedRJourneySelection({
      acceptanceMode: "r-jupyter",
      selector: undefined,
      requestedEditors: ["vscode", "cursor"],
      remoteJupyterEnabled: false,
      platform: "linux",
      ...overrides
    });

  assert.deepEqual(resolve(), {
    local: true,
    remote: false,
    remoteOnly: false,
    requiresHostR: true,
    literateDocuments: false,
    nativeEditorTooling: false
  });
  assert.deepEqual(resolve({ remoteJupyterEnabled: true }), {
    local: true,
    remote: true,
    remoteOnly: false,
    requiresHostR: true,
    literateDocuments: false,
    nativeEditorTooling: false
  });
  for (const [selector, literateDocuments, nativeEditorTooling] of [
    [CORE_R_JUPYTER_SELECTOR, false, false],
    ["categorical-operations", false, false],
    ["value-operations", false, false],
    [PIVOT_WIDER_R_JUPYTER_SELECTOR, false, false],
    [KERNEL_RESTART_R_JUPYTER_SELECTOR, false, false],
    [NATIVE_FRAMES_R_JUPYTER_SELECTOR, false, false],
    ["interactive-terminal", false, true],
    ["literate-documents", true, true]
  ]) {
    assert.deepEqual(resolve({ selector, requestedEditors: ["vscode"] }), {
      local: true,
      remote: false,
      remoteOnly: false,
      requiresHostR: true,
      literateDocuments,
      nativeEditorTooling
    });
  }
  assert.deepEqual(
    resolve({
      selector: "remote-r-jupyter",
      requestedEditors: ["vscode"],
      remoteJupyterEnabled: true
    }),
    {
      local: false,
      remote: true,
      remoteOnly: true,
      requiresHostR: false,
      literateDocuments: false,
      nativeEditorTooling: false
    }
  );
  assert.deepEqual(
    resolvePackagedRJourneySelection({
      acceptanceMode: "full",
      selector: undefined,
      requestedEditors: undefined,
      remoteJupyterEnabled: false,
      platform: "linux"
    }),
    {
      local: false,
      remote: false,
      remoteOnly: false,
      requiresHostR: false,
      literateDocuments: false,
      nativeEditorTooling: false
    }
  );

  for (const [overrides, message] of [
    [{ selector: "unknown" }, /must be unset/u],
    [{ acceptanceMode: "full", selector: "literate-documents" }, /requires OPEN_WRANGLER_PACKAGED_MODE/u],
    [{ requestedEditors: undefined }, /explicit, duplicate-free/u],
    [{ requestedEditors: ["vscode", "vscode"] }, /explicit, duplicate-free/u],
    [{ requestedEditors: ["vscode", "other"] }, /explicit, duplicate-free/u],
    [{ selector: "literate-documents", remoteJupyterEnabled: true }, /cannot be combined/u],
    [{ selector: CORE_R_JUPYTER_SELECTOR, remoteJupyterEnabled: true }, /cannot be combined/u],
    [{ selector: "categorical-operations", remoteJupyterEnabled: true }, /cannot be combined/u],
    [{ selector: "value-operations", remoteJupyterEnabled: true }, /cannot be combined/u],
    [{ selector: PIVOT_WIDER_R_JUPYTER_SELECTOR, remoteJupyterEnabled: true }, /cannot be combined/u],
    [{ selector: KERNEL_RESTART_R_JUPYTER_SELECTOR, remoteJupyterEnabled: true }, /cannot be combined/u],
    [{ selector: NATIVE_FRAMES_R_JUPYTER_SELECTOR, remoteJupyterEnabled: true }, /cannot be combined/u],
    [{ remoteJupyterEnabled: true, requestedEditors: ["cursor"] }, /requires VS Code/u],
    [{ selector: "remote-r-jupyter", requestedEditors: ["vscode"] }, /requires real remote/u],
    [
      { selector: "remote-r-jupyter", requestedEditors: ["vscode"], remoteJupyterEnabled: true, platform: "darwin" },
      /Linux-only/u
    ],
    [
      {
        selector: "remote-r-jupyter",
        requestedEditors: ["vscode", "cursor"],
        remoteJupyterEnabled: true
      },
      /exactly VS Code/u
    ]
  ]) {
    assert.throws(() => resolve(overrides), message);
  }
});

test("Cursor cleanup never inspects or launches an uninstaller under ownership uncertainty", async () => {
  let propertyReads = 0;
  const acquisition = new Proxy(
    {},
    {
      get() {
        propertyReads += 1;
        throw new Error("the private acquisition must remain untouched");
      }
    }
  );
  assert.deepEqual(
    await cleanupPackagedCursorAcquisition(acquisition, {
      processTreeVerifiedStopped: false,
      privatePathsVerified: true
    }),
    { cleaned: false, withheld: true }
  );
  assert.equal(propertyReads, 0);
});

test("R notebook phases use fixed private-root identity classifiers", () => {
  for (const cleanupOfPhase of [
    "jupyter-r",
    "jupyter-r-remote-base-build",
    "jupyter-r-remote-runtime-build",
    "jupyter-r-remote-setup",
    "jupyter-r-remote",
    "jupyter-r-remote-cleanup"
  ]) {
    const latch = createEditorAcceptancePrivatePathIdentityLatch({ reporter: () => undefined });
    const identityLoss = new Error("private root changed");
    identityLoss.code = "EDITOR_PRIVATE_ROOT_IDENTITY_LOST";
    identityLoss.details = {
      privateRootIdentity: "lost",
      privateRootCheckpoint: "receipt-mismatch"
    };
    assert.equal(
      latch.latch(identityLoss, {
        scope: "orchestration-profile",
        editor: "vscode",
        cleanupOfPhase
      }),
      true
    );
    assert.deepEqual(latch.details(), {
      scope: "orchestration-profile",
      editor: "vscode",
      phase: "cleanup",
      cleanupOfPhase,
      checkpoint: "receipt-mismatch"
    });
  }
});

test("Cursor cleanup invokes its private uninstaller once only after ownership is verified", async () => {
  let cleanups = 0;
  assert.deepEqual(
    await cleanupPackagedCursorAcquisition(
      {
        async cleanup() {
          cleanups += 1;
        }
      },
      { processTreeVerifiedStopped: true, privatePathsVerified: true }
    ),
    { cleaned: true, withheld: false }
  );
  assert.equal(cleanups, 1);
});

test("Cursor cleanup never inspects its acquisition after private-path identity is lost", async () => {
  let propertyReads = 0;
  const acquisition = new Proxy(
    {},
    {
      get() {
        propertyReads += 1;
        throw new Error("the private acquisition must remain untouched");
      }
    }
  );
  assert.deepEqual(
    await cleanupPackagedCursorAcquisition(acquisition, {
      processTreeVerifiedStopped: true,
      privatePathsVerified: false
    }),
    { cleaned: false, withheld: true }
  );
  assert.deepEqual(
    await cleanupPackagedCursorAcquisition(undefined, {
      processTreeVerifiedStopped: true,
      privatePathsVerified: false
    }),
    { cleaned: false, withheld: true }
  );
  assert.equal(propertyReads, 0);
});

test("Cursor cleanup requires explicit process and private-path decisions", async () => {
  await assert.rejects(
    cleanupPackagedCursorAcquisition(undefined, {
      processTreeVerifiedStopped: true
    }),
    /explicit private-path identity decision/u
  );
  await assert.rejects(
    cleanupPackagedCursorAcquisition(undefined, {
      privatePathsVerified: true
    }),
    /explicit process-tree ownership decision/u
  );
});

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

test("success is reported only after orchestration cleanup and finalization", async () => {
  const events = [];
  const value = await runPackagedEditorOrchestration(
    {
      evidenceRoot: "/virtual/evidence",
      run: async () => {
        events.push("run");
        return "complete";
      },
      retainFailure: async () => assert.fail("a successful run has nothing to retain"),
      cleanup: async () => events.push("cleanup")
    },
    {
      clearEvidence: () => events.push("clear"),
      finalizeSuccess: async (result) => {
        assert.equal(result, "complete");
        events.push("finalize");
      },
      reportSuccess: (result) => {
        assert.equal(result, "complete");
        events.push("report");
      }
    }
  );
  assert.equal(value, "complete");
  assert.deepEqual(events, ["clear", "run", "cleanup", "finalize", "report"]);
});

test("cleanup or finalization failure suppresses terminal success reporting", async () => {
  let reports = 0;
  const cleanupFailure = new Error("cleanup failed");
  await assert.rejects(
    runPackagedEditorOrchestration(
      {
        evidenceRoot: "/virtual/evidence",
        run: async () => undefined,
        retainFailure: async () => undefined,
        cleanup: async () => {
          throw cleanupFailure;
        }
      },
      {
        clearEvidence: () => undefined,
        finalizeSuccess: () => assert.fail("finalization cannot follow failed cleanup"),
        reportSuccess: () => {
          reports += 1;
        }
      }
    ),
    (error) => error === cleanupFailure
  );
  const finalizationFailure = new Error("finalization failed");
  await assert.rejects(
    runPackagedEditorOrchestration(
      {
        evidenceRoot: "/virtual/evidence",
        run: async () => undefined,
        retainFailure: async () => undefined,
        cleanup: async () => undefined
      },
      {
        clearEvidence: () => undefined,
        finalizeSuccess: () => {
          throw finalizationFailure;
        },
        reportSuccess: () => {
          reports += 1;
        }
      }
    ),
    (error) => error === finalizationFailure
  );
  assert.equal(reports, 0);
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
  let propertyReads = 0;
  const receipt = new Proxy(
    {},
    {
      get() {
        propertyReads += 1;
        throw new Error("the private receipt must remain untouched");
      }
    }
  );
  assert.throws(
    () =>
      removeEditorAcceptancePrivateRoot(receipt, {
        privatePathsVerified: false,
        moveToQuarantine() {
          removeCalled = true;
        }
      }),
    (error) => {
      assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
      assert.equal(error.details.privateRootIdentity, "lost");
      assert.equal(error.details.privateRootCheckpoint, "cleanup-already-unverified");
      return true;
    }
  );
  assert.equal(removeCalled, false);
  assert.equal(propertyReads, 0);
});

test("private-path identity reporting is fixed, first-cause, path-free, and emitted once", () => {
  const messages = [];
  const latch = createEditorAcceptancePrivatePathIdentityLatch({
    reporter: (message) => messages.push(message)
  });
  let first;
  try {
    removeEditorAcceptancePrivateRoot(undefined, { privatePathsVerified: false });
  } catch (error) {
    first = error;
  }
  assert.equal(
    latch.latch(first, {
      scope: "editor-profile",
      editor: "cursor",
      cleanupOfPhase: "platform-smoke"
    }),
    true
  );
  let laterReads = 0;
  const forbiddenLaterValue = new Proxy(
    {},
    {
      get() {
        laterReads += 1;
        throw new Error("later errors and contexts must remain opaque");
      }
    }
  );
  assert.equal(latch.latch(forbiddenLaterValue, forbiddenLaterValue), true);
  assert.equal(laterReads, 0);
  assert.deepEqual(latch.details(), {
    scope: "editor-profile",
    editor: "cursor",
    phase: "cleanup",
    cleanupOfPhase: "platform-smoke",
    checkpoint: "cleanup-already-unverified"
  });
  assert.equal(latch.isVerified(), false);
  assert.equal(latch.reportWithheld(), true);
  assert.equal(latch.reportWithheld(), false);
  assert.deepEqual(messages, [
    "Packaged-editor diagnostics were withheld because private-path identity is unverified (scope=editor-profile, editor=cursor, phase=cleanup, cleanupOfPhase=platform-smoke, checkpoint=cleanup-already-unverified)."
  ]);
  assert.doesNotMatch(messages[0], /raw|sentinel/u);
});

test("the first retention identity loss embargoes every later aggregate leaf", () => {
  const messages = [];
  const latch = createEditorAcceptancePrivatePathIdentityLatch({
    reporter: (message) => messages.push(message)
  });
  const leafA = new Error("leaf A");
  const leafB = new Error("leaf B");
  const handled = new Set();
  const calls = [];
  let laterLeafReads = 0;
  const aggregate = new AggregateError([], "phase failures");
  Object.defineProperty(aggregate, "errors", {
    value: new Proxy([leafA, leafB], {
      get(target, property, receiver) {
        if (property === "1") {
          laterLeafReads += 1;
          throw new Error("a later aggregate leaf must remain untouched");
        }
        return Reflect.get(target, property, receiver);
      }
    })
  });
  let identityLoss;
  try {
    removeEditorAcceptancePrivateRoot(undefined, { privatePathsVerified: false });
  } catch (error) {
    identityLoss = error;
  }
  assert.throws(
    () =>
      retainPackagedEditorFailureLeaves(aggregate, {
        handledFailures: handled,
        identityLatch: latch,
        identityContext: { scope: "orchestration-evidence", editor: "cursor" },
        onIdentityWithheld: () => latch.reportWithheld(),
        retainLeaf(failure) {
          calls.push(failure);
          throw identityLoss;
        }
      }),
    (error) => error === identityLoss
  );
  assert.deepEqual(calls, [leafA]);
  assert.deepEqual([...handled], [leafA, aggregate]);
  assert.equal(laterLeafReads, 0);
  assert.equal(latch.isVerified(), false);
  assert.equal(messages.length, 1);

  let postLatchErrorReads = 0;
  const leafC = new Proxy(
    {},
    {
      get() {
        postLatchErrorReads += 1;
        throw new Error("a post-latch primary error must remain opaque");
      }
    }
  );
  const forbiddenRetainer = new Proxy(() => undefined, {
    apply() {
      assert.fail("post-latch retention must not inspect another leaf");
    }
  });
  retainPackagedEditorFailureLeaves(leafC, {
    handledFailures: handled,
    identityLatch: latch,
    identityContext: { scope: "orchestration-evidence", editor: "cursor" },
    onIdentityWithheld: () => latch.reportWithheld(),
    retainLeaf: forbiddenRetainer
  });
  assert.equal(handled.has(leafC), true);
  assert.equal(postLatchErrorReads, 0);
  assert.equal(messages.length, 1);
});

test("ordinary retention faults remain distinct and do not create an identity embargo", () => {
  const latch = createEditorAcceptancePrivatePathIdentityLatch({ reporter: () => undefined });
  const leafA = new Error("leaf A");
  const leafB = new Error("leaf B");
  const faultA = new Error("retention A");
  const faultB = new Error("retention B");
  const handled = new Set();
  const calls = [];
  assert.throws(
    () =>
      retainPackagedEditorFailureLeaves(new AggregateError([leafA, leafB], "phase failures"), {
        handledFailures: handled,
        identityLatch: latch,
        identityContext: { scope: "orchestration-evidence", editor: "vscode" },
        retainLeaf(failure) {
          calls.push(failure);
          throw failure === leafA ? faultA : faultB;
        }
      }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [faultA, faultB]);
      return true;
    }
  );
  assert.deepEqual(calls, [leafA, leafB]);
  assert.deepEqual([...handled], []);
  assert.equal(latch.isVerified(), true);
});

test("evidence publication cannot invoke its callback after an identity embargo", () => {
  const latch = createEditorAcceptancePrivatePathIdentityLatch({ reporter: () => undefined });
  let identityLoss;
  try {
    removeEditorAcceptancePrivateRoot(undefined, { privatePathsVerified: false });
  } catch (error) {
    identityLoss = error;
  }
  assert.equal(latch.latch(identityLoss, { scope: "temporary-root", editor: "orchestration" }), true);
  let publicationCalls = 0;
  const context = {
    processTreeMayBeLive: false,
    evidenceCollectionSafe: true,
    hasTemporaryRootReceipt: true,
    evidenceReceiptCount: 1
  };
  assert.equal(
    latch.publishIfSafe(context, () => {
      publicationCalls += 1;
      throw new Error("publication must remain embargoed");
    }),
    undefined
  );
  assert.equal(publicationCalls, 0);

  const safeLatch = createEditorAcceptancePrivatePathIdentityLatch({ reporter: () => undefined });
  assert.equal(
    safeLatch.publishIfSafe(context, () => {
      publicationCalls += 1;
      return "/sealed/artifact.json";
    }),
    "/sealed/artifact.json"
  );
  assert.equal(publicationCalls, 1);
});

test("the runner terminal policy preserves display files and embargoes cleanup and publication after identity loss", () => {
  const latch = createEditorAcceptancePrivatePathIdentityLatch({ reporter: () => undefined });
  let identityLoss;
  try {
    removeEditorAcceptancePrivateRoot(undefined, { privatePathsVerified: false });
  } catch (error) {
    identityLoss = error;
  }
  assert.equal(latch.latch(identityLoss, { scope: "temporary-root", editor: "orchestration" }), true);

  let processOwnershipReads = 0;
  const policy = createEditorAcceptancePrivatePathSafetyPolicy({
    identityLatch: latch,
    processTreeMayBeLive() {
      processOwnershipReads += 1;
      throw new Error("process ownership must remain unread after the identity latch");
    }
  });
  assert.deepEqual(policy.displayStopOptions(), { preservePrivateFiles: true });
  let failureReads = 0;
  const opaqueFailure = new Proxy(
    {},
    {
      get() {
        failureReads += 1;
        throw new Error("the phase failure must remain opaque after the identity latch");
      }
    }
  );
  assert.equal(
    policy.failureOwnershipMayBeUnsafe(opaqueFailure, () => {
      throw new Error("process ownership must not be inspected after the identity latch");
    }),
    true
  );

  let cleanupCalls = 0;
  const cleanup = new Proxy(() => undefined, {
    apply() {
      cleanupCalls += 1;
      throw new Error("private receipts must remain untouched after the identity latch");
    }
  });
  assert.equal(policy.runCleanupIfSafe(cleanup), false);
  assert.throws(
    () => policy.runRequired(cleanup),
    (error) => {
      assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
      assert.equal(error.details.privateRootCheckpoint, "cleanup-already-unverified");
      return true;
    }
  );

  let publicationCalls = 0;
  const publicationContext = new Proxy(
    {},
    {
      get() {
        throw new Error("publication context must remain untouched after the identity latch");
      },
      ownKeys() {
        throw new Error("publication context must remain untouched after the identity latch");
      }
    }
  );
  assert.equal(
    policy.publishIfSafe(publicationContext, () => {
      publicationCalls += 1;
      throw new Error("artifact publication must remain embargoed");
    }),
    undefined
  );
  assert.equal(processOwnershipReads, 0);
  assert.equal(failureReads, 0);
  assert.equal(cleanupCalls, 0);
  assert.equal(publicationCalls, 0);
});

test("the runner terminal policy permits final cleanup and publication only after both ownership checks pass", () => {
  const latch = createEditorAcceptancePrivatePathIdentityLatch({ reporter: () => undefined });
  let treeMayBeLive = false;
  const policy = createEditorAcceptancePrivatePathSafetyPolicy({
    identityLatch: latch,
    processTreeMayBeLive: () => treeMayBeLive
  });
  assert.deepEqual(policy.displayStopOptions(), { preservePrivateFiles: false });
  let cleanupCalls = 0;
  assert.equal(
    policy.runCleanupIfSafe(() => {
      cleanupCalls += 1;
    }),
    true
  );
  let publicationCalls = 0;
  assert.equal(
    policy.publishIfSafe(
      {
        evidenceCollectionSafe: true,
        hasTemporaryRootReceipt: true,
        evidenceReceiptCount: 1
      },
      () => {
        publicationCalls += 1;
        return "/sealed/artifact.json";
      }
    ),
    "/sealed/artifact.json"
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(publicationCalls, 1);
  assert.equal(
    policy.runRequired(() => "finalized"),
    "finalized"
  );

  treeMayBeLive = true;
  assert.deepEqual(policy.displayStopOptions(), { preservePrivateFiles: true });
  assert.equal(
    policy.runCleanupIfSafe(() => {
      cleanupCalls += 1;
    }),
    false
  );
  assert.equal(
    policy.publishIfSafe(
      {
        evidenceCollectionSafe: true,
        hasTemporaryRootReceipt: true,
        evidenceReceiptCount: 1
      },
      () => {
        publicationCalls += 1;
      }
    ),
    undefined
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(publicationCalls, 1);
  assert.throws(
    () => policy.runRequired(() => "must not finalize"),
    (error) => error.code === "EDITOR_PRIVATE_ROOT_CLEANUP_WITHHELD"
  );
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
      (error) =>
        error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST" && error.details.privateRootCheckpoint === "receipt-mismatch"
    );
    assert.throws(
      () => removeEditorAcceptancePrivateRoot(receipt),
      (error) =>
        error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST" && error.details.privateRootCheckpoint === "receipt-mismatch"
    );
    assert.equal(await readFile(replacementMarker, "utf8"), "preserve me\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private-root pre-quarantine failures expose every fixed boundary checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-checkpoints-"));
  const expectCheckpoint = (operation, checkpoint) =>
    assert.throws(operation, (error) => {
      assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
      assert.equal(error.details.privateRootCheckpoint, checkpoint);
      return true;
    });
  try {
    expectCheckpoint(
      () => createEditorAcceptancePrivateRootReceipt(join(directory, "missing-root"), { containedBy: directory }),
      "capture-metadata"
    );

    const captured = join(directory, "captured");
    await mkdir(captured);
    const receipt = createEditorAcceptancePrivateRootReceipt(captured, { containedBy: directory });
    expectCheckpoint(
      () => createEditorAcceptancePrivateRootReceipt(captured, { containedBy: captured }),
      "capture-containment"
    );
    expectCheckpoint(() => assertEditorAcceptancePrivateRootReceipt({}), "receipt-shape");

    const unreadable = join(directory, "unreadable");
    await mkdir(unreadable);
    const unreadableReceipt = createEditorAcceptancePrivateRootReceipt(unreadable, { containedBy: directory });
    await rm(unreadable, { recursive: true });
    expectCheckpoint(() => assertEditorAcceptancePrivateRootReceipt(unreadableReceipt), "receipt-read");

    expectCheckpoint(
      () =>
        assertEditorAcceptancePrivateRootReceipt({
          ...receipt,
          canonicalParent: receipt.canonicalPath
        }),
      "receipt-containment"
    );
    expectCheckpoint(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          cleanupId: () => "invalid"
        }),
      "quarantine-id"
    );
    expectCheckpoint(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          quarantinePathFor: () => join(directory, "nested", "quarantine")
        }),
      "quarantine-path"
    );

    const plantedId = "44444444-4444-4444-8444-444444444444";
    const planted = join(directory, `.openwrangler-remove-${plantedId}`);
    await mkdir(planted);
    expectCheckpoint(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          cleanupId: () => plantedId
        }),
      "quarantine-absence"
    );

    const rechecked = join(directory, "source-recheck");
    const displaced = join(directory, "source-recheck-displaced");
    await mkdir(rechecked);
    const recheckedReceipt = createEditorAcceptancePrivateRootReceipt(rechecked, { containedBy: directory });
    expectCheckpoint(
      () =>
        removeEditorAcceptancePrivateRoot(recheckedReceipt, {
          cleanupId() {
            renameSync(rechecked, displaced);
            return "55555555-5555-4555-8555-555555555555";
          }
        }),
      "source-recheck"
    );

    const latch = createEditorAcceptancePrivatePathIdentityLatch({ reporter: () => undefined });
    const legacy = new Error("legacy identity loss without a checkpoint");
    legacy.code = "EDITOR_PRIVATE_ROOT_IDENTITY_LOST";
    assert.equal(
      latch.latch(legacy, {
        scope: "orchestration",
        editor: "orchestration",
        cleanupOfPhase: "setup"
      }),
      true
    );
    assert.equal(latch.details().checkpoint, "unclassified");
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

test("private-root quarantine move faults expose only their fixed checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-move-fault-"));
  const privateRoot = join(directory, "captured-root");
  let moveAttempts = 0;
  try {
    await mkdir(privateRoot);
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });
    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          moveToQuarantine() {
            moveAttempts += 1;
            throw new Error("EPERM /raw/private/path");
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "quarantine-move");
        assert.doesNotMatch(error.message, /EPERM|\/raw\/private\/path/u);
        return true;
      }
    );
    assert.equal(moveAttempts, 1);
    assert.equal((await stat(privateRoot)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows private-root cleanup retries only bounded transient quarantine-move failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-windows-retry-"));
  const privateRoot = join(directory, "captured-root");
  const waits = [];
  let moveAttempts = 0;
  let removals = 0;
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    removeEditorAcceptancePrivateRoot(receipt, {
      platform: "win32",
      moveToQuarantine(source, target) {
        moveAttempts += 1;
        if (moveAttempts < 3) {
          const error = new Error("transient Windows sharing violation");
          error.code = moveAttempts === 1 ? "EPERM" : "EBUSY";
          throw error;
        }
        renameSync(source, target);
      },
      waitForQuarantineMoveRetry(delayMs) {
        waits.push(delayMs);
      },
      removeQuarantine(path, options) {
        removals += 1;
        rmSync(path, options);
      }
    });

    assert.equal(moveAttempts, 3);
    assert.deepEqual(waits, [250, 500]);
    assert.equal(removals, 1);
    await assert.rejects(stat(privateRoot), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows quarantine-move retries revalidate the source after every wait", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-windows-recheck-"));
  const privateRoot = join(directory, "captured-root");
  const displaced = join(directory, "displaced-root");
  const replacement = join(directory, "replacement-root");
  let moveAttempts = 0;
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    await mkdir(replacement);
    await writeFile(join(replacement, "user-owned.txt"), "preserve me\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          platform: "win32",
          moveToQuarantine() {
            moveAttempts += 1;
            const error = new Error("transient Windows sharing violation");
            error.code = "EACCES";
            throw error;
          },
          waitForQuarantineMoveRetry() {
            renameSync(privateRoot, displaced);
            renameSync(replacement, privateRoot);
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "source-recheck");
        return true;
      }
    );
    assert.equal(moveAttempts, 1);
    assert.equal(await readFile(join(displaced, "owned.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(privateRoot, "user-owned.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows quarantine-move retries fail closed if the quarantine target appears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-windows-target-"));
  const privateRoot = join(directory, "captured-root");
  const cleanupId = "22222222-2222-4222-8222-222222222222";
  const quarantine = join(directory, `.openwrangler-remove-${cleanupId}`);
  let moveAttempts = 0;
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          cleanupId: () => cleanupId,
          platform: "win32",
          moveToQuarantine() {
            moveAttempts += 1;
            const error = new Error("transient Windows sharing violation");
            error.code = "EPERM";
            throw error;
          },
          waitForQuarantineMoveRetry() {
            mkdirSync(quarantine);
            writeFileSync(join(quarantine, "user-owned.txt"), "preserve me\n");
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "quarantine-absence");
        return true;
      }
    );
    assert.equal(moveAttempts, 1);
    assert.equal(await readFile(join(privateRoot, "owned.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(quarantine, "user-owned.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows quarantine-move retries reject non-transient errors immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-windows-terminal-"));
  const privateRoot = join(directory, "captured-root");
  let moveAttempts = 0;
  let waits = 0;
  try {
    await mkdir(privateRoot);
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          platform: "win32",
          moveToQuarantine() {
            moveAttempts += 1;
            const error = new Error("terminal native error");
            error.code = "ENOENT";
            throw error;
          },
          waitForQuarantineMoveRetry() {
            waits += 1;
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "quarantine-move");
        return true;
      }
    );
    assert.equal(moveAttempts, 1);
    assert.equal(waits, 0);
    assert.equal((await stat(privateRoot)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-Windows quarantine moves never retry Windows sharing errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-posix-terminal-"));
  const privateRoot = join(directory, "captured-root");
  let moveAttempts = 0;
  let waits = 0;
  try {
    await mkdir(privateRoot);
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          platform: "linux",
          moveToQuarantine() {
            moveAttempts += 1;
            const error = new Error("EPERM /raw/private/path");
            error.code = "EPERM";
            throw error;
          },
          waitForQuarantineMoveRetry() {
            waits += 1;
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "quarantine-move");
        assert.doesNotMatch(error.message, /EPERM|\/raw\/private\/path/u);
        return true;
      }
    );
    assert.equal(moveAttempts, 1);
    assert.equal(waits, 0);
    assert.equal((await stat(privateRoot)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows quarantine-move retry wait failures remain path-free and terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-windows-wait-"));
  const privateRoot = join(directory, "captured-root");
  let moveAttempts = 0;
  let removals = 0;
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          platform: "win32",
          moveToQuarantine() {
            moveAttempts += 1;
            const error = new Error("transient Windows sharing violation");
            error.code = "EPERM";
            throw error;
          },
          waitForQuarantineMoveRetry() {
            throw new Error("wait failed at C:\\private\\path");
          },
          removeQuarantine() {
            removals += 1;
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "quarantine-move");
        assert.doesNotMatch(error.message, /wait failed|C:\\private\\path/iu);
        return true;
      }
    );
    assert.equal(moveAttempts, 1);
    assert.equal(removals, 0);
    assert.equal(await readFile(join(privateRoot, "owned.txt"), "utf8"), "owned\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows quarantine-move retries remain bounded and hide the native error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-windows-bounded-"));
  const privateRoot = join(directory, "captured-root");
  let moveAttempts = 0;
  const waits = [];
  try {
    await mkdir(privateRoot);
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          platform: "win32",
          moveToQuarantine() {
            moveAttempts += 1;
            const error = new Error("EPERM C:\\private\\path");
            error.code = "EPERM";
            throw error;
          },
          waitForQuarantineMoveRetry(delayMs) {
            waits.push(delayMs);
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "quarantine-move");
        assert.doesNotMatch(error.message, /EPERM|C:\\private\\path/iu);
        return true;
      }
    );
    assert.equal(moveAttempts, 7);
    assert.deepEqual(waits, [250, 500, 1_000, 2_000, 4_000, 8_000]);
    assert.equal((await stat(privateRoot)).isDirectory(), true);
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
      (error) =>
        error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST" &&
        error.details.privateRootCheckpoint === "post-move-attestation"
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
      (error) =>
        error.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST" &&
        error.details.privateRootCheckpoint === "pre-delete-attestation"
    );
    assert.equal(await readFile(join(displaced, "owned.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(quarantine, "user-owned.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private-root deletion faults become one fixed terminal uncertainty checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-root-delete-fault-"));
  const privateRoot = join(directory, "captured-root");
  const cleanupId = "33333333-3333-4333-8333-333333333333";
  const quarantine = join(directory, `.openwrangler-remove-${cleanupId}`);
  let deletionAttempts = 0;
  try {
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: directory });
    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          cleanupId: () => cleanupId,
          removeQuarantine() {
            deletionAttempts += 1;
            throw new Error("injected sharing violation at /raw/private/path");
          }
        }),
      (error) => {
        assert.equal(error.code, "EDITOR_PRIVATE_ROOT_IDENTITY_LOST");
        assert.equal(error.details.privateRootCheckpoint, "quarantine-delete");
        assert.equal(error.details.privateRootCleanup, "uncertain");
        assert.match(error.message, /cleanup completion could not be verified/u);
        assert.doesNotMatch(error.message, /sharing violation|\/raw\/private\/path/iu);
        return true;
      }
    );
    assert.equal(deletionAttempts, 1);
    assert.equal(await readFile(join(quarantine, "owned.txt"), "utf8"), "owned\n");
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
