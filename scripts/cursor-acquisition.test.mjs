import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { readBoundedRegularFile } from "./bounded-file-read.mjs";
import {
  createCursorAcquisitionRootReceipt,
  assertCursorAcquisitionRootReceipt,
  downloadPinnedCursorArtifact,
  PINNED_CURSOR_PRODUCT_COMMIT,
  PINNED_CURSOR_TARGETS,
  PINNED_CURSOR_VERSION,
  resolvePinnedCursorTarget,
  validatePinnedCursorInstallation,
  validatePinnedCursorTarget
} from "./cursor-acquisition.mjs";

test("Cursor acceptance pins official macOS and Windows artifacts exactly", () => {
  const mac = resolvePinnedCursorTarget("darwin", "arm64");
  assert.equal(mac, PINNED_CURSOR_TARGETS["darwin-universal"]);
  assert.equal(mac.version, "3.13.10");
  assert.equal(mac.bytes, 430_139_751);
  assert.equal(mac.sha256, "42b1edea8912eb0b2fc686ea89a4a0047aaaf43da4f7d8eb34a4bafa35d477b1");
  assert.equal(new URL(mac.url).hostname, "downloads.cursor.com");

  const windows = resolvePinnedCursorTarget("win32", "x64");
  assert.equal(windows, PINNED_CURSOR_TARGETS["win32-x64"]);
  assert.equal(windows.bytes, 199_233_712);
  assert.equal(windows.sha256, "2f99ebb41bcce62cd6c8e4611e56a613b9abaf2399a8ce02e7925798e0f64522");
  assert.equal(windows.productCommit, PINNED_CURSOR_PRODUCT_COMMIT);
  assert.throws(() => resolvePinnedCursorTarget("win32", "arm64"), /does not support/u);
  assert.throws(() => resolvePinnedCursorTarget("linux", "x64"), /does not support/u);
});

test("Cursor target validation rejects moving, credentialed, and malformed acquisition inputs", () => {
  const target = {
    ...PINNED_CURSOR_TARGETS["win32-x64"],
    url: PINNED_CURSOR_TARGETS["win32-x64"].url
  };
  assert.equal(validatePinnedCursorTarget(target), target);
  for (const mutation of [
    { version: "latest" },
    { bytes: 0 },
    { sha256: "a".repeat(63) },
    { artifactName: "../cursor.exe" },
    { url: "https://example.invalid/cursor.exe" },
    { url: "https://token@downloads.cursor.com/cursor.exe" }
  ]) {
    assert.throws(() => validatePinnedCursorTarget({ ...target, ...mutation }), /target is malformed/u);
  }
});

test("Cursor private-root receipts retain identity while owned children are added", () => {
  const directory = mkdtempSync(join(tmpdir(), "openwrangler-cursor-root-"));
  chmodSync(directory, 0o700);
  try {
    const receipt = createCursorAcquisitionRootReceipt(directory);
    writeFileSync(join(directory, "owned-child"), "owned");
    assert.doesNotThrow(() => assertCursorAcquisitionRootReceipt(receipt));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor metadata reads reject a named-path replacement after descriptor open", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openwrangler-cursor-metadata-race-")));
  chmodSync(directory, 0o700);
  try {
    const path = join(directory, "product.json");
    const displaced = join(directory, "displaced.json");
    const replacement = join(directory, "replacement.json");
    writeFileSync(path, '{"name":"Cursor"}');
    writeFileSync(replacement, '{"name":"Attacker"}');
    assert.throws(
      () =>
        readBoundedRegularFile(path, 1024, {
          containedBy: directory,
          label: "Extracted Cursor metadata",
          afterOpenForTest() {
            renameSync(path, displaced);
            renameSync(replacement, path);
          }
        }),
      /changed during its descriptor-bound read/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor artifact download publishes only exact size and SHA-256 bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openwrangler-cursor-download-"));
  chmodSync(directory, 0o700);
  try {
    const body = Buffer.from("pinned-cursor-test-body", "utf8");
    const target = testTarget(body);
    const receipt = await downloadPinnedCursorArtifact(target, createCursorAcquisitionRootReceipt(directory), {
      openResponse: async () => cursorResponse(body),
      timeoutMs: 1_000
    });
    assert.equal(receipt.sha256, target.sha256);
    assert.deepEqual(readFileSync(receipt.path), body);
    assert.equal(receipt.path, join(directory, target.artifactName));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor artifact download fails closed on truncated or altered content", async () => {
  for (const [label, body, declared] of [
    ["truncated", Buffer.from("short"), Buffer.from("expected")],
    ["altered", Buffer.from("altered!"), Buffer.from("expected")]
  ]) {
    const directory = mkdtempSync(join(tmpdir(), `openwrangler-cursor-${label}-`));
    chmodSync(directory, 0o700);
    try {
      const target = testTarget(declared);
      await assert.rejects(
        downloadPinnedCursorArtifact(target, createCursorAcquisitionRootReceipt(directory), {
          openResponse: async () =>
            cursorResponse(body, {
              "content-length": String(target.bytes)
            }),
          timeoutMs: 1_000
        }),
        /exact size and SHA-256 receipt|unexpected content length/u
      );
      assert.equal(existsSync(join(directory, target.artifactName)), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Cursor artifact download rejects ambiguous responses and disposes every rejected body", async () => {
  const payload = Buffer.from("pinned-cursor-test-body", "utf8");
  const target = testTarget(payload);
  for (const [label, responseFactory, expected] of [
    [
      "status",
      (body) => ({ statusCode: 302, headers: { "content-length": String(payload.length) }, body }),
      /successful bounded body/u
    ],
    [
      "array-header",
      (body) => ({ statusCode: 200, headers: { "content-length": [String(payload.length)] }, body }),
      /ambiguous content length/u
    ],
    [
      "duplicate-header",
      (body) => ({
        statusCode: 200,
        headers: { "Content-Length": String(payload.length), "content-length": String(payload.length) },
        body
      }),
      /ambiguous content length/u
    ],
    [
      "malformed-body",
      (body) => ({ statusCode: 200, headers: { "content-length": String(payload.length) }, body }),
      /successful bounded body/u
    ]
  ]) {
    const directory = mkdtempSync(join(tmpdir(), `openwrangler-cursor-response-${label}-`));
    chmodSync(directory, 0o700);
    try {
      const tracked = trackedResponseBody(payload, { iterable: label !== "malformed-body" });
      await assert.rejects(
        downloadPinnedCursorArtifact(target, createCursorAcquisitionRootReceipt(directory), {
          openResponse: async () => responseFactory(tracked.body),
          timeoutMs: 1_000
        }),
        expected
      );
      assert.equal(tracked.destructions(), 1);
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Cursor artifact download stays bound to its no-follow descriptor across a path swap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openwrangler-cursor-download-race-"));
  chmodSync(directory, 0o700);
  try {
    const body = Buffer.from("pinned-cursor-test-body", "utf8");
    const target = testTarget(body);
    let plantedPath;
    await assert.rejects(
      downloadPinnedCursorArtifact(target, createCursorAcquisitionRootReceipt(directory), {
        afterTemporaryOpenForTest({ temporaryPath }) {
          plantedPath = temporaryPath;
          renameSync(temporaryPath, join(directory, "displaced-download"));
          writeFileSync(temporaryPath, "planted", { mode: 0o600 });
        },
        openResponse: async () => cursorResponse(body),
        timeoutMs: 1_000
      }),
      /changed while it was downloaded/u
    );
    assert.equal(readFileSync(plantedPath, "utf8"), "planted");
    assert.equal(existsSync(join(directory, target.artifactName)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor installation validation binds product, version, commit, target files, and containment", () => {
  for (const platform of ["darwin", "win32"]) {
    const directory = mkdtempSync(join(tmpdir(), `openwrangler-cursor-${platform}-`));
    chmodSync(directory, 0o700);
    try {
      const target =
        platform === "darwin" ? PINNED_CURSOR_TARGETS["darwin-universal"] : PINNED_CURSOR_TARGETS["win32-x64"];
      const appRoot =
        platform === "darwin"
          ? join(directory, "Cursor.app", "Contents", "Resources", "app")
          : join(directory, "resources", "app");
      const executable =
        platform === "darwin"
          ? join(directory, "Cursor.app", "Contents", "MacOS", "Cursor")
          : join(directory, "Cursor.exe");
      const cli = platform === "darwin" ? join(appRoot, "bin", "cursor") : join(appRoot, "bin", "cursor.cmd");
      mkdirSync(join(appRoot, "bin"), { recursive: true });
      mkdirSync(join(executable, ".."), { recursive: true });
      writeFileSync(executable, "binary");
      writeFileSync(cli, "cli");
      writeFileSync(join(appRoot, "package.json"), JSON.stringify({ name: "Cursor", version: PINNED_CURSOR_VERSION }));
      writeFileSync(
        join(appRoot, "product.json"),
        JSON.stringify({
          nameLong: "Cursor",
          nameShort: "Cursor",
          applicationName: "cursor",
          version: PINNED_CURSOR_VERSION,
          commit: PINNED_CURSOR_PRODUCT_COMMIT,
          quality: "stable"
        })
      );
      assert.deepEqual(validatePinnedCursorInstallation(target, directory), {
        executable,
        cli,
        installationRoot: directory
      });
      writeFileSync(
        join(appRoot, "product.json"),
        JSON.stringify({
          nameLong: "Cursor",
          nameShort: "Cursor",
          applicationName: "cursor",
          version: PINNED_CURSOR_VERSION,
          commit: "0".repeat(40),
          quality: "stable"
        })
      );
      assert.throws(() => validatePinnedCursorInstallation(target, directory), /product identity/u);
      writeFileSync(
        join(appRoot, "product.json"),
        JSON.stringify({
          nameLong: "Cursor",
          nameShort: "Cursor",
          applicationName: "cursor",
          version: PINNED_CURSOR_VERSION,
          commit: PINNED_CURSOR_PRODUCT_COMMIT,
          quality: "stable"
        })
      );
      const outside = join(directory, "..", `outside-${platform}`);
      writeFileSync(outside, "outside");
      rmSync(cli);
      symlinkSync(outside, cli);
      assert.throws(() => validatePinnedCursorInstallation(target, directory), /installation is incomplete/u);
      rmSync(outside);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function testTarget(body) {
  return {
    ...PINNED_CURSOR_TARGETS["win32-x64"],
    artifactName: "cursor-test.exe",
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    url: "https://downloads.cursor.com/acceptance/cursor-test.exe"
  };
}

function cursorResponse(body, headers = {}) {
  return {
    statusCode: 200,
    headers: {
      "content-length": String(body.length),
      ...headers
    },
    body: Readable.from([body])
  };
}

function trackedResponseBody(payload, { iterable }) {
  let destructions = 0;
  if (!iterable) {
    return {
      body: {
        destroy() {
          destructions += 1;
        }
      },
      destructions: () => destructions
    };
  }
  const body = Readable.from([payload]);
  const destroy = body.destroy.bind(body);
  body.destroy = (...args) => {
    destructions += 1;
    return destroy(...args);
  };
  return { body, destructions: () => destructions };
}
