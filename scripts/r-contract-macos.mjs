import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertEditorAcceptancePrivateRootReceipt,
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";

const SOURCE_PATH = fileURLToPath(new URL("./r-contract-macos.c", import.meta.url));
const RECORD_KEYS = [
  "beforeIdVersion",
  "beforeParentUniqueId",
  "idVersion",
  "marker",
  "originalParentVersion",
  "parentPid",
  "parentUniqueId",
  "pid",
  "startIdentity"
].sort();
const UINT64 = /^(?:0|[1-9][0-9]{0,19})$/u;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function nativeAdapter(binary, owner, execute, assertPrepared) {
  assert.match(owner, /^[A-Za-z0-9_-]{1,128}$/u);
  const invoke = (args, allowRefusal = false) => {
    assertPrepared();
    let output;
    try {
      output = execute(binary, args, {
        encoding: "utf8",
        timeout: 250,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      if (!allowRefusal || error.status !== 3) {
        const reason =
          new Map([
            ["ETIMEDOUT", "helper-timeout"],
            ["ENOENT", "helper-missing"],
            ["EACCES", "helper-access"],
            ["ENOBUFS", "helper-output-bound"]
          ]).get(error.code) ??
          new Map([
            ["identity-before-unavailable", "identity-before-unavailable"],
            ["identity-after-unavailable", "identity-after-unavailable"],
            ["unique-identity-changed", "unique-identity-changed"],
            ["elapsed-bound", "elapsed-bound"],
            ["metadata-bound", "metadata-bound"],
            ["PID enumeration refused", "pid-enumeration"],
            ["allocation refused", "allocation"],
            ["observation bound exceeded", "observation-bound"],
            ["identity observation refused", "identity-observation"]
          ]).get(error.stderr?.toString().trim()) ??
          (Number.isInteger(error.status) || typeof error.signal === "string"
            ? "helper-unknown-exit"
            : "helper-unknown-launch");
        throw new Error(`Native macOS ${args[0]} refused: ${reason}`, { cause: error });
      }
      output = error.stdout.toString();
    }
    return JSON.parse(output);
  };
  const records = (value) => {
    assert.deepEqual(Object.keys(value).sort(), ["cpuMs", "metadataBytes", "records", "wallMs"]);
    assert.ok(
      Number.isSafeInteger(value.metadataBytes) && value.metadataBytes >= 0 && value.metadataBytes <= 32 * 1024 * 1024
    );
    for (const key of ["cpuMs", "wallMs"]) assert.ok(Number.isFinite(value[key]) && value[key] >= 0);
    assert.ok(Array.isArray(value.records) && value.records.length <= 4096);
    const pids = new Set();
    return value.records.map((record) => {
      assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
      assert.ok(Number.isInteger(record.pid) && record.pid > 0 && record.pid <= 2147483647 && !pids.has(record.pid));
      pids.add(record.pid);
      assert.ok(Number.isInteger(record.parentPid) && record.parentPid >= 0 && record.parentPid <= 2147483647);
      for (const key of ["beforeIdVersion", "idVersion", "originalParentVersion"])
        assert.ok(Number.isInteger(record[key]) && record[key] >= 0 && record[key] <= 0xffffffff);
      for (const key of ["startIdentity", "parentUniqueId", "beforeParentUniqueId"])
        assert.ok(typeof record[key] === "string" && UINT64.test(record[key]) && BigInt(record[key]) < 2n ** 64n);
      assert.notEqual(record.startIdentity, "0");
      assert.ok([-1, 0, 1].includes(record.marker));
      return Object.freeze({
        ...record,
        ownerMarked: record.marker === 1,
        state: "?",
        identityResolution: "macos-unique-id"
      });
    });
  };
  const readProcessIdentity = (pid) => {
    const result = records(invoke(["inspect", owner, String(pid)]));
    assert.ok(result.length <= 1 && (!result.length || result[0].pid === pid));
    return result[0];
  };
  const listProcessIdentities = () => records(invoke(["scan", owner]));
  const signalVerifiedProcesses = (targets, suppliedOwner, signal) => {
    assert.equal(suppliedOwner, owner);
    assert.ok(["SIGINT", "SIGTERM", "SIGKILL"].includes(signal) && targets.length <= 256);
    const admitted = [];
    for (const target of targets) {
      const current = readProcessIdentity(target.pid);
      if (current && current.startIdentity === target.startIdentity) admitted.push(current);
    }
    if (!admitted.length) return [];
    const result = invoke(
      [
        "signal",
        signal,
        ...admitted.flatMap((value) => [String(value.pid), value.startIdentity, String(value.idVersion)])
      ],
      true
    );
    assert.deepEqual(Object.keys(result), ["results"]);
    assert.ok(Array.isArray(result.results) && result.results.length === admitted.length);
    for (let i = 0; i < admitted.length; i++) {
      assert.deepEqual(Object.keys(result.results[i]).sort(), ["pid", "result"]);
      assert.equal(result.results[i].pid, admitted[i].pid);
      assert.ok([0, 1, 2].includes(result.results[i].result));
      if (result.results[i].result === 2)
        throw new Error("Exact native signal refused while original identity may remain live");
    }
    return admitted;
  };
  return Object.freeze({ readProcessIdentity, listProcessIdentities, signalVerifiedProcesses, invoke });
}

function fileSnapshot(path, maximumBytes, { executable = false, privateFile = true } = {}) {
  const value = lstatSync(path, { bigint: true });
  assert.ok(
    value.isFile() && value.size > 0n && value.size <= BigInt(maximumBytes),
    "bounded regular helper file required"
  );
  if (privateFile)
    assert.ok(
      value.uid === BigInt(process.getuid()) && (value.mode & 0o022n) === 0n && value.nlink === 1n,
      "owned private helper file required"
    );
  if (executable) assert.ok((value.mode & 0o100n) !== 0n, "executable helper required");
  return Object.freeze(
    Object.fromEntries(
      ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map((key) => [key, value[key]])
    )
  );
}

function checkCancellation(signal) {
  if (signal?.aborted) throw new Error(`macOS R helper preparation was interrupted by ${signal.reason}.`);
}

export async function prepareMacProcessOwner(
  environment = process.env,
  { platform = process.platform, terminationSignal, signalSource = process, runCommand, execute = execFileSync } = {}
) {
  assert.equal(platform, "darwin", "native macOS process ownership requires macOS");
  checkCancellation(terminationSignal);
  // Other source platforms do not load the editor command's optional dependencies.
  const { runBoundedEditorCommand, editorProcessTreeMayBeLive } = await import("./editor-acceptance.mjs");
  checkCancellation(terminationSignal);
  const parent = realpathSync(environment.TMPDIR || tmpdir());
  const directory = mkdtempSync(join(parent, "openwrangler-r-helper-"));
  let rootReceipt;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    try {
      removeEditorAcceptancePrivateRoot(rootReceipt, { platform });
    } catch (error) {
      error.macHelperRetainedRoot = directory;
      throw error;
    }
    disposed = true;
  };
  try {
    rootReceipt = createEditorAcceptancePrivateRootReceipt(directory, { containedBy: parent });
    assert.equal(lstatSync(directory).mode & 0o077, 0, "private helper directory required");
    const sourceSnapshot = fileSnapshot(SOURCE_PATH, 64 * 1024, { privateFile: false });
    const source = readFileSync(SOURCE_PATH);
    assert.deepEqual(
      fileSnapshot(SOURCE_PATH, 64 * 1024, { privateFile: false }),
      sourceSnapshot,
      "native source changed while reading"
    );
    const privateSource = join(directory, "process-owner.c");
    const binary = join(directory, "process-owner");
    writeFileSync(privateSource, source, { flag: "wx", mode: 0o400 });
    const copiedSourceSnapshot = fileSnapshot(privateSource, 64 * 1024);
    const assertSource = () => {
      assertEditorAcceptancePrivateRootReceipt(rootReceipt);
      assert.deepEqual(
        fileSnapshot(privateSource, 64 * 1024),
        copiedSourceSnapshot,
        "prepared source identity changed"
      );
    };
    await (runCommand ?? runBoundedEditorCommand)(
      {
        executable: "/usr/bin/xcrun",
        args: ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", privateSource, "-o", binary],
        environment,
        label: "macOS R cleanup helper compilation",
        beforeSpawnCheck: () => {
          checkCancellation(terminationSignal);
          assertSource();
        }
      },
      { platform, signalSource, timeoutMs: 20_000, maxOutputBytes: 16 * 1024 }
    );
    checkCancellation(terminationSignal);
    assertSource();
    const compiled = fileSnapshot(binary, 2 * 1024 * 1024, { executable: true, privateFile: false });
    assert.ok(compiled.uid === BigInt(process.getuid()) && compiled.nlink === 1n, "owned compiler output required");
    chmodSync(binary, 0o500);
    const binarySnapshot = fileSnapshot(binary, 2 * 1024 * 1024, { executable: true });
    const binarySha256 = digest(readFileSync(binary));
    const assertPrepared = () => {
      assert.ok(!disposed, "native helper has already retired");
      assertSource();
      assert.deepEqual(
        fileSnapshot(binary, 2 * 1024 * 1024, { executable: true }),
        binarySnapshot,
        "prepared helper identity changed"
      );
    };
    assertPrepared();
    assert.deepEqual(nativeAdapter(binary, "preflight", execute, assertPrepared).invoke(["preflight"]), {
      capability: "native-identity-signal",
      staleSelfRefusedLive: true
    });
    checkCancellation(terminationSignal);
    return Object.freeze({
      directory,
      binary,
      sourceSha256: digest(source),
      binarySha256,
      createProcessOwner: (owner) => {
        assertPrepared();
        return nativeAdapter(binary, owner, execute, assertPrepared);
      },
      dispose
    });
  } catch (error) {
    if (editorProcessTreeMayBeLive(error) || !rootReceipt) {
      error.macHelperRetainedRoot = directory;
      throw error;
    }
    try {
      dispose();
    } catch (cleanup) {
      const failure = new AggregateError(
        [error, cleanup],
        "macOS R helper preparation could not retire its private root."
      );
      failure.macHelperRetainedRoot = directory;
      throw failure;
    }
    throw error;
  }
}
