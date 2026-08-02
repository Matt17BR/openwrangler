import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDataWranglerComparisonProcessEvidence } from "./data-wrangler-comparison-process-evidence.mjs";
import { LINUX_PSS_OWNERSHIP_PROTOCOL } from "./linux-pss-sampler.mjs";

const KERNEL = Object.freeze({
  name: "openwrangler-study-evidence",
  displayName: "Open Wrangler study CPython 3.12"
});

test("owned processes receive exact study categories without retaining command or environment secrets", () => {
  withFixture((fixture) => {
    writeProcess(fixture, 100, { command: ["/editor", "--unity-launch"], start: "1000" });
    writeProcess(fixture, 101, {
      command: ["/editor", "--type=renderer", "--private=renderer-secret"],
      start: "1010"
    });
    writeProcess(fixture, 102, { command: ["/editor", "--type=gpu-process"], start: "1020" });
    writeProcess(fixture, 103, {
      command: ["/editor", "--type=utility"],
      environment: [
        "PRIVATE_TOKEN=extension-host-secret",
        "VSCODE_AMD_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess"
      ],
      start: "1030"
    });
    writeProcess(fixture, 104, {
      command: [
        fixture.python,
        "-I",
        "-m",
        "ipykernel_launcher",
        "-f",
        resolve(fixture.root, "runtime", "kernel-study-alpha.json")
      ],
      executable: fixture.python,
      environment: ["PRIVATE_TOKEN=kernel-secret"],
      start: "1040"
    });
    writeProcess(fixture, 105, {
      command: [fixture.python, "-s", "-m", "openwrangler_runtime.server"],
      executable: fixture.python,
      environment: ["PRIVATE_TOKEN=runtime-secret"],
      start: "1050"
    });
    writeProcess(fixture, 106, {
      command: ["/helper", "--token=other-child-secret"],
      environment: ["PRIVATE_TOKEN=other-environment-secret"],
      start: "1060"
    });

    const evidence = createEvidence(fixture, { product: "open-wrangler" });
    assert.deepEqual(evidence.snapshotLaunchProcessProofs(), {
      editorRoot: { pid: 100, startTimeTicks: "1000", capturedAtLaunch: true },
      configuredKernel: null,
      openWranglerRuntime: null
    });
    assert.deepEqual(evidence.snapshotPreActionProcessProofs({ selectedKernel: KERNEL }), {
      editorRoot: { pid: 100, startTimeTicks: "1000", capturedAtLaunch: true },
      configuredKernel: null,
      openWranglerRuntime: null
    });
    const categories = [100, 101, 102, 103, 104, 105, 106].map((pid) =>
      evidence.classify(classificationInput(pid, `${pid}0`))
    );
    assert.deepEqual(categories, [
      "editor-main",
      "renderer-gpu",
      "renderer-gpu",
      "extension-host",
      "configured-kernel",
      "open-wrangler-runtime",
      "other-owned-child"
    ]);

    const proofs = evidence.snapshotProcessProofs({ selectedKernel: KERNEL });
    assert.deepEqual(proofs, {
      editorRoot: { pid: 100, startTimeTicks: "1000", capturedAtLaunch: true },
      configuredKernel: {
        pid: 104,
        startTimeTicks: "1040",
        executableSha256: fixture.pythonSha256,
        kernelIdSha256: sha256("study-alpha"),
        observedBeforeAction: true
      },
      openWranglerRuntime: { status: "observed", pid: 105, startTimeTicks: "1050" }
    });
    const serialized = `${JSON.stringify(evidence)}\n${JSON.stringify(proofs)}`;
    for (const secret of [
      "renderer-secret",
      "extension-host-secret",
      "kernel-secret",
      "runtime-secret",
      "other-child-secret",
      "other-environment-secret",
      fixture.python,
      "kernel-study-alpha.json"
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});

test("real ipykernel connection argument variants bind one configured kernel", () => {
  const variants = [
    ["-m", "ipykernel_launcher", "-f"],
    ["-m", "ipykernel_launcher", "--f"],
    ["-I", "-m", "ipykernel_launcher", "-f"],
    ["-Xfrozen_modules=off", "-m", "ipykernel_launcher", "--f"],
    ["-I", "-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f"]
  ];
  for (const [index, prefix] of variants.entries()) {
    withFixture((fixture) => {
      writeProcess(fixture, 100, { command: ["/editor"], start: "1000" });
      const token = `kernel-variant-${index}.json`;
      const path = resolve(fixture.root, "runtime", token);
      const command = prefix.at(-1) === "--f" ? [fixture.python, ...prefix, path] : [fixture.python, ...prefix, path];
      writeProcess(fixture, 110, {
        command,
        executable: fixture.python,
        start: "1100"
      });
      const evidence = createEvidence(fixture, { expectedConnectionFileToken: token });
      assert.equal(evidence.classify(classificationInput(100, "1000")), "editor-main");
      assert.equal(evidence.classify(classificationInput(110, "1100")), "configured-kernel");
      assert.equal(
        evidence.snapshotProcessProofs({ selectedKernel: KERNEL }).configuredKernel.kernelIdSha256,
        sha256(`variant-${index}`)
      );
    });
  }

  withFixture((fixture) => {
    writeProcess(fixture, 100, { command: ["/editor"], start: "1000" });
    writeProcess(fixture, 110, {
      command: [
        fixture.python,
        "-I",
        "-m",
        "ipykernel_launcher",
        `--f=${resolve(fixture.root, "runtime", "kernel-equals.json")}`
      ],
      executable: fixture.python,
      start: "1100"
    });
    const evidence = createEvidence(fixture, { expectedConnectionFileToken: "kernel-equals.json" });
    evidence.classify(classificationInput(100, "1000"));
    assert.equal(evidence.classify(classificationInput(110, "1100")), "configured-kernel");
  });
});

test("kernel mismatches, wrong executables, and duplicate configured kernels fail closed", () => {
  withFixture((fixture) => {
    writeProcess(fixture, 100, { command: ["/editor"], start: "1000" });
    const path = resolve(fixture.root, "runtime", "kernel-actual.json");
    writeProcess(fixture, 110, {
      command: [fixture.python, "-m", "ipykernel_launcher", "-f", path],
      executable: fixture.python,
      start: "1100"
    });
    const mismatch = createEvidence(fixture, { expectedConnectionFileToken: "kernel-expected.json" });
    mismatch.classify(classificationInput(100, "1000"));
    assert.throws(() => mismatch.classify(classificationInput(110, "1100")), /does not match the trial binding/u);

    const wrongPython = resolve(fixture.root, "wrong-python");
    writeFileSync(wrongPython, "wrong", { mode: 0o700 });
    writeProcess(fixture, 111, {
      command: [wrongPython, "-m", "ipykernel_launcher", "-f", path],
      executable: wrongPython,
      start: "1110"
    });
    const wrong = createEvidence(fixture);
    assert.throws(() => wrong.classify(classificationInput(111, "1110")), /manifest-pinned executable/u);

    const duplicate = createEvidence(fixture);
    duplicate.classify(classificationInput(110, "1100"));
    writeProcess(fixture, 112, {
      command: [
        fixture.python,
        "-m",
        "ipykernel_launcher",
        "--f",
        resolve(fixture.root, "runtime", "kernel-second.json")
      ],
      executable: fixture.python,
      start: "1120"
    });
    assert.throws(() => duplicate.classify(classificationInput(112, "1120")), /More than one configured kernel/u);
  });
});

test("process identity reuse and category changes cannot alter retained evidence", () => {
  withFixture((fixture) => {
    writeProcess(fixture, 100, { command: ["/editor"], start: "1000" });
    writeProcess(fixture, 120, { command: ["/helper", "--one"], start: "1200" });
    const evidence = createEvidence(fixture);
    assert.equal(evidence.classify(classificationInput(120, "1200")), "other-owned-child");

    writeProcess(fixture, 120, { command: ["/helper", "--one"], start: "1201" });
    assert.throws(() => evidence.classify(classificationInput(120, "1201")), /PID was reused/u);

    writeProcess(fixture, 121, { command: ["/helper", "--one"], start: "1210" });
    assert.equal(evidence.classify(classificationInput(121, "1210")), "other-owned-child");
    writeProcess(fixture, 121, { command: ["/helper", "--type=renderer"], start: "1210" });
    assert.throws(() => evidence.classify(classificationInput(121, "1210")), /changed classification evidence/u);
  });
});

test("malformed and oversized proc evidence is rejected without echoing its contents", () => {
  withFixture((fixture) => {
    writeProcess(fixture, 100, { command: ["/editor"], start: "1000" });
    writeProcess(fixture, 130, { command: ["/helper"], start: "1300" });
    writeFileSync(resolve(fixture.procRoot, "130", "cmdline"), Buffer.alloc(64 * 1024 + 1, 0x73));
    const evidence = createEvidence(fixture);
    assert.throws(
      () => evidence.classify(classificationInput(130, "1300")),
      (error) => /exceeds its fixed bound/u.test(error.message) && !error.message.includes("ssss")
    );

    writeProcess(fixture, 131, { command: ["/helper"], start: "1310" });
    writeFileSync(resolve(fixture.procRoot, "131", "stat"), "private malformed stat payload", {
      mode: 0o600
    });
    assert.throws(
      () => evidence.classify(classificationInput(131, "1310")),
      (error) => /identity is malformed/u.test(error.message) && !error.message.includes("private malformed")
    );
  });
});

test("pre-action proofs require the exact selected kernel and classify Data Wrangler runtime as inapplicable", () => {
  withFixture((fixture) => {
    writeProcess(fixture, 100, { command: ["/editor"], start: "1000" });
    const evidence = createEvidence(fixture, { product: "data-wrangler" });
    evidence.classify(classificationInput(100, "1000"));
    assert.throws(
      () => evidence.snapshotProcessProofs({ selectedKernel: KERNEL }),
      /configured kernel was not observed/u
    );
    writeProcess(fixture, 110, {
      command: [
        fixture.python,
        "-m",
        "ipykernel_launcher",
        "-f",
        resolve(fixture.root, "runtime", "kernel-data-wrangler.json")
      ],
      executable: fixture.python,
      start: "1100"
    });
    evidence.classify(classificationInput(110, "1100"));
    assert.throws(
      () =>
        evidence.snapshotProcessProofs({
          selectedKernel: { ...KERNEL, displayName: "Another CPython 3.12" }
        }),
      /does not match the notebook-selected kernel/u
    );
    assert.deepEqual(evidence.snapshotProcessProofs({ selectedKernel: KERNEL }).openWranglerRuntime, {
      status: "not-applicable",
      pid: null,
      startTimeTicks: null
    });
  });
});

test("launch proof remains available before a kernel exists", () => {
  withFixture((fixture) => {
    writeProcess(fixture, 100, { command: ["/editor"], start: "1000" });
    const evidence = createEvidence(fixture);
    assert.deepEqual(evidence.snapshotLaunchProcessProofs(), {
      editorRoot: { pid: 100, startTimeTicks: "1000", capturedAtLaunch: true },
      configuredKernel: null,
      openWranglerRuntime: null
    });
    assert.throws(
      () => evidence.snapshotProcessProofs({ selectedKernel: KERNEL }),
      /configured kernel was not observed/u
    );
  });
});

function createEvidence(fixture, overrides = {}) {
  return createDataWranglerComparisonProcessEvidence({
    launchReceipt: fixture.launchReceipt,
    pythonExecutablePath: fixture.python,
    pythonExecutableSha256: fixture.pythonSha256,
    product: "open-wrangler",
    expectedKernel: KERNEL,
    procRoot: fixture.procRoot,
    ...overrides
  });
}

function classificationInput(pid, startTimeTicks) {
  return { pid, startTimeTicks, rootPid: 100, rootStartTimeTicks: "1000" };
}

function withFixture(callback) {
  const root = mkdtempSync(resolve(tmpdir(), "openwrangler-process-evidence-"));
  try {
    const procRoot = resolve(root, "proc");
    mkdirSync(procRoot, { mode: 0o700 });
    mkdirSync(resolve(root, "runtime"), { mode: 0o700 });
    const python = resolve(root, "python-study");
    writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(python, 0o700);
    const pythonSha256 = sha256(Buffer.from("#!/bin/sh\nexit 0\n"));
    const launchReceipt = makeLaunchReceipt(python, pythonSha256);
    callback({ root, procRoot, python, pythonSha256, launchReceipt });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeLaunchReceipt(python, pythonSha256) {
  const metadata = lstatSync(python, { bigint: true });
  const identity = {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    sizeBytes: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString()
  };
  return {
    protocol: LINUX_PSS_OWNERSHIP_PROTOCOL,
    kind: "launch",
    nonce: "0".repeat(64),
    supervisor: {
      pid: 99,
      startTimeTicks: "990",
      subreaperVerified: true,
      pidfdVerified: true
    },
    editorRoot: { pid: 100, startTimeTicks: "1000", processGroupId: 100, sessionId: 100 },
    supervisorSource: {
      sha256: "1".repeat(64),
      filesystemIdentity: { device: "1", inode: "2", sizeBytes: 3, mtimeNs: "4" }
    },
    pythonExecutable: {
      implementation: "CPython",
      version: "3.12.13",
      sha256: pythonSha256,
      filesystemIdentity: identity
    },
    invocationPolicySha256: "2".repeat(64),
    invocationSha256: "3".repeat(64),
    payloadArgvSha256: "4".repeat(64),
    payloadEnvironmentSha256: "5".repeat(64)
  };
}

function writeProcess(fixture, pid, { command, executable = "/editor", environment = ["LANG=C"], start }) {
  const directory = resolve(fixture.procRoot, String(pid));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = "S";
  fields[1] = pid === 100 ? "99" : "100";
  fields[2] = "100";
  fields[3] = "100";
  fields[19] = start;
  writeFileSync(resolve(directory, "stat"), `${pid} (study process) ${fields.join(" ")}\n`, { mode: 0o600 });
  writeFileSync(resolve(directory, "cmdline"), Buffer.from(`${command.join("\0")}\0`, "utf8"), { mode: 0o600 });
  writeFileSync(resolve(directory, "environ"), Buffer.from(`${environment.join("\0")}\0`, "utf8"), {
    mode: 0o600
  });
  rmSync(resolve(directory, "exe"), { force: true });
  symlinkSync(executable, resolve(directory, "exe"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
