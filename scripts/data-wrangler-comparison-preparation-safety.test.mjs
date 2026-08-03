import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createDataWranglerComparisonCleanupUnsettledError,
  dataWranglerComparisonCleanupMayBeUnsettled
} from "./data-wrangler-comparison-cleanup-safety.mjs";
import {
  captureDataWranglerPreparationFile,
  createDataWranglerConfiguredTemplateCapture,
  executeIdentityPinnedPreparationInterpreter,
  readBoundedDataWranglerPreparationJson,
  revalidateDataWranglerPreparationFileIdentity
} from "./data-wrangler-comparison-preparation.mjs";
import { writeDataWranglerComparisonKernelSpec } from "./run-data-wrangler-comparison-preparation.mjs";

const EMPTY_SETTINGS_SHA256 = createHash("sha256").update("{}\n", "utf8").digest("hex");

function withRoot(t, prefix) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("bounded preparation JSON rejects links, FIFOs, and oversized input without opening them", (t) => {
  const root = withRoot(t, "ow-preparation-json-types-");
  const source = resolve(root, "source.json");
  writeFileSync(source, "{}", { mode: 0o600 });
  const symbolic = resolve(root, "symbolic.json");
  symlinkSync(source, symbolic);
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(symbolic, "Symbolic preparation JSON", 64),
    /owned, singly linked regular file/u
  );

  const hard = resolve(root, "hard.json");
  linkSync(source, hard);
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(source, "Linked preparation JSON", 64),
    /owned, singly linked regular file/u
  );

  const fifo = resolve(root, "pipe.json");
  execFileSync("mkfifo", [fifo]);
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(fifo, "FIFO preparation JSON", 64),
    /owned, singly linked regular file/u
  );

  const oversized = resolve(root, "oversized.json");
  writeFileSync(oversized, JSON.stringify({ value: "too large" }), { mode: 0o600 });
  assert.throws(
    () => readBoundedDataWranglerPreparationJson(oversized, "Oversized preparation JSON", 8),
    /within its byte bound/u
  );
});

test("bounded preparation JSON detects file and parent replacement after its descriptor opens", (t) => {
  const root = withRoot(t, "ow-preparation-json-swap-");
  const file = resolve(root, "value.json");
  writeFileSync(file, '{"value":1}', { mode: 0o600 });
  assert.throws(
    () =>
      readBoundedDataWranglerPreparationJson(file, "Swapped preparation JSON", 64, {
        afterOpen() {
          renameSync(file, resolve(root, "original.json"));
          writeFileSync(file, '{"value":2}', { mode: 0o600 });
        }
      }),
    /changed while it was read/u
  );

  const parent = resolve(root, "parent");
  mkdirSync(parent, { mode: 0o700 });
  const nested = resolve(parent, "value.json");
  writeFileSync(nested, '{"value":1}', { mode: 0o600 });
  assert.throws(
    () =>
      readBoundedDataWranglerPreparationJson(nested, "Reparented preparation JSON", 64, {
        afterOpen() {
          renameSync(parent, resolve(root, "original-parent"));
          mkdirSync(parent, { mode: 0o700 });
          writeFileSync(resolve(parent, "value.json"), '{"value":1}', { mode: 0o600 });
        }
      }),
    /or its parent changed while it was read/u
  );
});

test("the preparation interpreter executes its open descriptor and rejects named replacement", (t) => {
  const root = withRoot(t, "ow-preparation-interpreter-");
  const stable = resolve(root, "stable.sh");
  writeFileSync(stable, "#!/bin/sh\nprintf 'stable\\n'\n", { mode: 0o700 });
  chmodSync(stable, 0o700);
  assert.equal(executeIdentityPinnedPreparationInterpreter(stable, []), "stable\n");

  const replacing = resolve(root, "replacing.sh");
  const original = resolve(root, "replacing-original.sh");
  writeFileSync(
    replacing,
    `#!/bin/sh\nmv ${JSON.stringify(replacing)} ${JSON.stringify(original)}\nprintf '#!/bin/sh\\nprintf replacement\\n' > ${JSON.stringify(replacing)}\nchmod 700 ${JSON.stringify(replacing)}\nprintf 'descriptor\\n'\n`,
    { mode: 0o700 }
  );
  assert.throws(() => executeIdentityPinnedPreparationInterpreter(replacing, []), /changed while it executed/u);
});

test("the preparation interpreter accepts only bounded multiline -c source", (t) => {
  const root = withRoot(t, "ow-preparation-interpreter-arguments-");
  const interpreter = resolve(root, "interpreter.sh");
  writeFileSync(interpreter, "#!/bin/sh\nprintf 'accepted\\n'\n", { mode: 0o700 });
  chmodSync(interpreter, 0o700);

  assert.equal(
    executeIdentityPinnedPreparationInterpreter(interpreter, ["-I", "-c", "print('first')\nprint('second')"]),
    "accepted\n"
  );
  for (const args of [
    ["line one\nline two"],
    ["-c", "print('ok')", "trailing\nargument"],
    ["-c\n", "print('not source')"],
    ["option\r"],
    ["option\0"],
    ["-c", "print('carriage')\r"],
    ["-c", "print('nul')\0"]
  ]) {
    assert.throws(
      () => executeIdentityPinnedPreparationInterpreter(interpreter, args),
      /interpreter arguments are invalid/u
    );
  }

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => executeIdentityPinnedPreparationInterpreter(interpreter, sparse),
    /interpreter arguments are invalid/u
  );
  assert.throws(
    () =>
      executeIdentityPinnedPreparationInterpreter(
        interpreter,
        Array.from({ length: 65 }, () => "argument")
      ),
    /interpreter arguments are invalid/u
  );
  assert.throws(
    () => executeIdentityPinnedPreparationInterpreter(interpreter, ["x".repeat(64 * 1024 + 1)]),
    /interpreter arguments are invalid/u
  );
  assert.throws(
    () =>
      executeIdentityPinnedPreparationInterpreter(interpreter, [
        "x".repeat(48 * 1024),
        "y".repeat(48 * 1024),
        "z".repeat(48 * 1024)
      ]),
    /interpreter arguments are invalid/u
  );
});

test("spawn-bound revalidation detects a same-inode same-size rewrite with restored mtime", (t) => {
  const root = withRoot(t, "ow-preparation-content-rewrite-");
  const file = resolve(root, "authority.bin");
  const timestampSeconds = 1_700_000_000;
  writeFileSync(file, "original-bytes", { mode: 0o600 });
  utimesSync(file, timestampSeconds, timestampSeconds);
  const receipt = captureDataWranglerPreparationFile(file, "Prepared authority", { maximumBytes: 64 });

  writeFileSync(file, "tampered-bytes", { mode: 0o600 });
  utimesSync(file, timestampSeconds, timestampSeconds);
  const rewritten = captureDataWranglerPreparationFile(file, "Prepared authority", { maximumBytes: 64 });
  assert.deepEqual(rewritten.filesystemIdentity, receipt.filesystemIdentity);
  assert.notEqual(rewritten.sha256, receipt.sha256);
  assert.throws(
    () => revalidateDataWranglerPreparationFileIdentity(receipt, "Prepared authority", { maximumBytes: 64 }),
    /changed before the measured spawn/u
  );
});

test("the private study kernelspec is product-neutral and names its exact CPython 3.12 runtime", (t) => {
  const root = withRoot(t, "ow-preparation-kernelspec-");
  const kernel = writeDataWranglerComparisonKernelSpec(root, "/private/cpython-3.12.11", "3.12.11");
  assert.match(kernel.name, /^dataframe-comparison-study-[a-f0-9]{32}$/u);
  assert.equal(kernel.displayName, "Dataframe comparison study CPython 3.12.11 (private trial)");
  assert.doesNotMatch(`${kernel.name} ${kernel.displayName}`, /open[ -]?wrangler|data[ -]?wrangler/iu);
  const value = JSON.parse(readFileSync(kernel.path, "utf8"));
  assert.deepEqual(value.argv, [
    "/private/cpython-3.12.11",
    "-I",
    "-Xfrozen_modules=off",
    "-m",
    "ipykernel_launcher",
    "-f",
    "{connection_file}"
  ]);
  assert.equal(value.display_name, kernel.displayName);
});

test("configured template capture accepts exactly one profile for each product", async (t) => {
  const root = withRoot(t, "ow-preparation-configured-templates-");
  const studyRoot = resolve(root, "study-complete");
  const incompleteStudyRoot = resolve(root, "study-incomplete");
  mkdirSync(studyRoot, { mode: 0o700 });
  mkdirSync(incompleteStudyRoot, { mode: 0o700 });
  const profiles = new Map();
  for (const product of ["open-wrangler", "data-wrangler"]) {
    const profile = resolve(root, product);
    const userData = resolve(profile, "user");
    const extensions = resolve(profile, "extensions");
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    const settingsDirectory = resolve(userData, "User");
    mkdirSync(settingsDirectory, { mode: 0o700 });
    mkdirSync(extensions, { mode: 0o700 });
    writeFileSync(resolve(settingsDirectory, "settings.json"), "{}\n", { mode: 0o600 });
    if (product === "data-wrangler") {
      symlinkSync(resolve(root, "opaque-package-trap"), resolve(extensions, "ms-toolsai.datawrangler-1.24.2"));
      const globalStorage = resolve(settingsDirectory, "globalStorage", "ms-toolsai.datawrangler");
      mkdirSync(globalStorage, { recursive: true, mode: 0o700 });
      writeFileSync(resolve(globalStorage, "state.bin"), "private extension state", { mode: 0o600 });
      const workspaceStorage = resolve(settingsDirectory, "workspaceStorage");
      mkdirSync(workspaceStorage, { mode: 0o700 });
      writeFileSync(resolve(workspaceStorage, "state.vscdb"), "private workspace state", { mode: 0o600 });
      const marketplaceCache = resolve(userData, "CachedExtensionVSIXs");
      mkdirSync(marketplaceCache, { mode: 0o700 });
      writeFileSync(resolve(marketplaceCache, "ms-toolsai.datawrangler-1.24.2"), "cached package", {
        mode: 0o600
      });
      symlinkSync(resolve(root, "unreadable-log-trap"), resolve(userData, "logs"));
    }
    profiles.set(product, {
      product,
      kind: "configured-only",
      privateRoot: profile,
      userData,
      extensions,
      editor: {},
      sandboxArgs: [],
      installedExtensions: [
        product === "data-wrangler" ? "ms-toolsai.datawrangler@1.24.2" : "matt17br.openwrangler@1.2.1"
      ],
      settingsSha256: EMPTY_SETTINGS_SHA256
    });
  }

  const incomplete = createDataWranglerConfiguredTemplateCapture(incompleteStudyRoot);
  const incompleteProfile = resolve(root, "incomplete-open-wrangler");
  const incompleteUserData = resolve(incompleteProfile, "user");
  const incompleteExtensions = resolve(incompleteProfile, "extensions");
  mkdirSync(incompleteUserData, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(incompleteUserData, "User"), { mode: 0o700 });
  mkdirSync(incompleteExtensions, { mode: 0o700 });
  writeFileSync(resolve(incompleteUserData, "User", "settings.json"), "{}\n", { mode: 0o600 });
  await incomplete.capture({
    ...profiles.get("open-wrangler"),
    privateRoot: incompleteProfile,
    userData: incompleteUserData,
    extensions: incompleteExtensions
  });
  assert.throws(() => incomplete.values(), /both configured-only product templates/u);

  const capture = createDataWranglerConfiguredTemplateCapture(studyRoot);
  await assert.rejects(
    capture.capture({ ...profiles.get("open-wrangler"), kind: "warmed" }),
    /only exact configured-only/u
  );
  await capture.capture(profiles.get("open-wrangler"));
  await capture.capture(profiles.get("data-wrangler"));
  await assert.rejects(capture.capture(profiles.get("open-wrangler")), /more than once/u);
  assert.deepEqual(
    capture.values().map((entry) => `${entry.product}:${entry.kind}`),
    ["open-wrangler:configured-only", "data-wrangler:configured-only"]
  );
  const dataWranglerTemplate = capture.values().find((entry) => entry.product === "data-wrangler");
  assert.equal(existsSync(resolve(dataWranglerTemplate.root, "extensions", "ms-toolsai.datawrangler-1.24.2")), false);
  for (const excluded of [
    resolve(dataWranglerTemplate.root, "user", "User", "globalStorage"),
    resolve(dataWranglerTemplate.root, "user", "User", "workspaceStorage"),
    resolve(dataWranglerTemplate.root, "user", "CachedExtensionVSIXs"),
    resolve(dataWranglerTemplate.root, "user", "logs")
  ]) {
    assert.equal(existsSync(excluded), false);
  }
});

test("a failed configured capture retires its source profile and partial retained template", async (t) => {
  const root = withRoot(t, "ow-preparation-failed-configured-capture-");
  const studyRoot = resolve(root, "study");
  const privateRoot = resolve(root, "bootstrap-profile");
  const userData = resolve(privateRoot, "user");
  const extensions = resolve(privateRoot, "extensions");
  mkdirSync(studyRoot, { mode: 0o700 });
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(userData, "User"), { mode: 0o700 });
  mkdirSync(extensions, { mode: 0o700 });
  symlinkSync(resolve(root, "unsafe-setting"), resolve(userData, "User", "settings.json"));
  symlinkSync(resolve(root, "opaque-package-trap"), resolve(extensions, "ms-toolsai.datawrangler-1.24.2"));

  const capture = createDataWranglerConfiguredTemplateCapture(studyRoot);
  await assert.rejects(
    capture.capture({
      product: "data-wrangler",
      kind: "configured-only",
      privateRoot,
      userData,
      extensions,
      editor: {},
      sandboxArgs: [],
      installedExtensions: ["ms-toolsai.datawrangler@1.24.2"],
      settingsSha256: EMPTY_SETTINGS_SHA256
    }),
    /singly linked regular file/u
  );
  assert.equal(existsSync(privateRoot), false);
  assert.equal(existsSync(resolve(studyRoot, "templates", "data-wrangler", "configured-only")), false);
});

test("configured capture rejects settings changed after the harness authored them", async (t) => {
  const root = withRoot(t, "ow-preparation-mutated-settings-");
  const studyRoot = resolve(root, "study");
  const privateRoot = resolve(root, "bootstrap-profile");
  const userData = resolve(privateRoot, "user");
  const extensions = resolve(privateRoot, "extensions");
  const harnessSettings = '{"safe":true}\n';
  mkdirSync(studyRoot, { mode: 0o700 });
  mkdirSync(resolve(userData, "User"), { recursive: true, mode: 0o700 });
  mkdirSync(extensions, { mode: 0o700 });
  writeFileSync(resolve(userData, "User", "settings.json"), '{"productState":"private"}\n', { mode: 0o600 });

  const capture = createDataWranglerConfiguredTemplateCapture(studyRoot);
  await assert.rejects(
    capture.capture({
      product: "data-wrangler",
      kind: "configured-only",
      privateRoot,
      userData,
      extensions,
      editor: {},
      sandboxArgs: [],
      installedExtensions: ["ms-toolsai.datawrangler@1.24.2"],
      settingsSha256: createHash("sha256").update(harnessSettings, "utf8").digest("hex")
    }),
    /changed the harness-authored settings/u
  );
  assert.equal(existsSync(privateRoot), false);
  assert.equal(existsSync(resolve(studyRoot, "templates", "data-wrangler", "configured-only")), false);
});

test("configured capture retires its source and every identity-known target after setup failure", async (t) => {
  const root = withRoot(t, "ow-preparation-configured-setup-failures-");
  for (const stage of ["mkdir-call", "mkdir", "receipt", "chmod"]) {
    const caseRoot = resolve(root, stage);
    const studyRoot = resolve(caseRoot, "study");
    const privateRoot = resolve(caseRoot, "bootstrap-profile");
    const userData = resolve(privateRoot, "user");
    const extensions = resolve(privateRoot, "extensions");
    mkdirSync(studyRoot, { recursive: true, mode: 0o700 });
    mkdirSync(resolve(userData, "User"), { recursive: true, mode: 0o700 });
    mkdirSync(extensions, { mode: 0o700 });
    writeFileSync(resolve(userData, "User", "settings.json"), "{}\n", { mode: 0o600 });
    symlinkSync(resolve(root, "opaque-package-trap"), resolve(extensions, "ms-toolsai.datawrangler-1.24.2"));
    const capture = createDataWranglerConfiguredTemplateCapture(studyRoot, {
      mkdirTarget(path, options) {
        if (stage === "mkdir-call") throw new Error("mkdir-call setup failed");
        mkdirSync(path, options);
      },
      targetSetupCheckpoint(checkpoint) {
        if (stage === checkpoint) throw new Error(`${stage} setup failed`);
      }
    });
    await assert.rejects(
      capture.capture({
        product: "data-wrangler",
        kind: "configured-only",
        privateRoot,
        userData,
        extensions,
        editor: {},
        sandboxArgs: [],
        installedExtensions: ["ms-toolsai.datawrangler@1.24.2"],
        settingsSha256: EMPTY_SETTINGS_SHA256
      }),
      new RegExp(`${stage} setup failed`, "u")
    );
    assert.equal(existsSync(privateRoot), false);
    assert.equal(existsSync(resolve(studyRoot, "templates", "data-wrangler", "configured-only")), false);
  }
});

test("configured capture preserves its target ancestor after nested child cleanup uncertainty", async (t) => {
  const root = withRoot(t, "ow-preparation-configured-child-cleanup-");
  const studyRoot = resolve(root, "study");
  const privateRoot = resolve(root, "bootstrap-profile");
  const userData = resolve(privateRoot, "user");
  const extensions = resolve(privateRoot, "extensions");
  mkdirSync(studyRoot, { mode: 0o700 });
  mkdirSync(resolve(userData, "User"), { recursive: true, mode: 0o700 });
  mkdirSync(extensions, { mode: 0o700 });
  writeFileSync(resolve(userData, "User", "settings.json"), "{}\n", { mode: 0o600 });

  const childCleanup = createDataWranglerComparisonCleanupUnsettledError(
    [new Error("configured child cleanup identity changed")],
    "Configured user capture cleanup is unsettled."
  );
  const nestedError = new AggregateError([childCleanup], "Configured user capture failed.");
  const retirementLabels = [];
  let retainedTarget;
  const capture = createDataWranglerConfiguredTemplateCapture(studyRoot, {
    copyTree(_source, target, label) {
      assert.match(label, /configured user-data capture/u);
      retainedTarget = target;
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(resolve(target, "replacement.txt"), "preserve this tree\n", { mode: 0o600 });
      throw nestedError;
    },
    retire(_receipt, label) {
      retirementLabels.push(label);
    }
  });

  await assert.rejects(
    capture.capture({
      product: "open-wrangler",
      kind: "configured-only",
      privateRoot,
      userData,
      extensions,
      editor: {},
      sandboxArgs: [],
      installedExtensions: ["matt17br.openwrangler@1.2.1"],
      settingsSha256: EMPTY_SETTINGS_SHA256
    }),
    (error) => error === nestedError && dataWranglerComparisonCleanupMayBeUnsettled(error)
  );
  assert.deepEqual(retirementLabels, ["Comparison open-wrangler configured source profile"]);
  assert.equal(readFileSync(resolve(retainedTarget, "replacement.txt"), "utf8"), "preserve this tree\n");
  assert.equal(existsSync(resolve(studyRoot, "templates", "open-wrangler", "configured-only")), true);
});

test("profile copier tags a real operation and child-retirement failure", async (t) => {
  const root = withRoot(t, "ow-preparation-profile-copy-cleanup-");
  const studyRoot = resolve(root, "study");
  const privateRoot = resolve(root, "bootstrap-profile");
  const userData = resolve(privateRoot, "user");
  const extensions = resolve(privateRoot, "extensions");
  const settingsPath = resolve(userData, "User", "settings.json");
  const settingsReferent = resolve(root, "settings-referent.json");
  mkdirSync(studyRoot, { mode: 0o700 });
  mkdirSync(resolve(userData, "User"), { recursive: true, mode: 0o700 });
  mkdirSync(extensions, { mode: 0o700 });
  writeFileSync(settingsReferent, "{}\n", { mode: 0o600 });
  symlinkSync(settingsReferent, settingsPath);

  const childRetirementError = new Error("copied child retirement identity changed");
  const retirementLabels = [];
  const capture = createDataWranglerConfiguredTemplateCapture(studyRoot, {
    captureSettings() {
      return { sha256: EMPTY_SETTINGS_SHA256 };
    },
    retireCopiedTree() {
      throw childRetirementError;
    },
    retire(_receipt, label) {
      retirementLabels.push(label);
    }
  });

  await assert.rejects(
    capture.capture({
      product: "open-wrangler",
      kind: "configured-only",
      privateRoot,
      userData,
      extensions,
      editor: {},
      sandboxArgs: [],
      installedExtensions: ["matt17br.openwrangler@1.2.1"],
      settingsSha256: EMPTY_SETTINGS_SHA256
    }),
    (error) =>
      error instanceof AggregateError &&
      dataWranglerComparisonCleanupMayBeUnsettled(error) &&
      error.errors.includes(childRetirementError) &&
      error.errors.some((nested) => /unowned or linked entry/u.test(String(nested?.message ?? nested)))
  );
  assert.deepEqual(retirementLabels, ["Comparison open-wrangler configured source profile"]);
  assert.equal(existsSync(resolve(studyRoot, "templates", "open-wrangler", "configured-only", "user")), true);
  assert.equal(readFileSync(settingsReferent, "utf8"), "{}\n");
});
