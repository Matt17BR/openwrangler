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
  extractPinnedCursorTarget,
  PINNED_CURSOR_PRODUCT_COMMIT,
  PINNED_CURSOR_TARGETS,
  PINNED_CURSOR_VERSION,
  resolvePinnedCursorTarget,
  validatePinnedCursorInstallation,
  validatePinnedCursorTarget
} from "./cursor-acquisition.mjs";

test("Cursor acceptance pins official macOS, Linux, and Windows artifacts exactly", () => {
  const mac = resolvePinnedCursorTarget("darwin", "arm64");
  assert.equal(mac, PINNED_CURSOR_TARGETS["darwin-universal"]);
  assert.equal(mac.version, "3.13.10");
  assert.equal(mac.bytes, 430_139_751);
  assert.equal(mac.sha256, "42b1edea8912eb0b2fc686ea89a4a0047aaaf43da4f7d8eb34a4bafa35d477b1");
  assert.equal(new URL(mac.url).hostname, "downloads.cursor.com");

  const linux = resolvePinnedCursorTarget("linux", "x64");
  assert.equal(linux, PINNED_CURSOR_TARGETS["linux-x64"]);
  assert.equal(linux.bytes, 209_277_476);
  assert.equal(linux.sha256, "8a5b734be3bccc3de6daf96c536daa644c715e5fe3e5eaf21721538072ea104c");
  assert.equal(linux.format, "deb");
  assert.equal(linux.productCommit, PINNED_CURSOR_PRODUCT_COMMIT);

  const windows = resolvePinnedCursorTarget("win32", "x64");
  assert.equal(windows, PINNED_CURSOR_TARGETS["win32-x64"]);
  assert.equal(windows.bytes, 199_233_712);
  assert.equal(windows.sha256, "2f99ebb41bcce62cd6c8e4611e56a613b9abaf2399a8ce02e7925798e0f64522");
  assert.equal(windows.productCommit, PINNED_CURSOR_PRODUCT_COMMIT);
  assert.throws(() => resolvePinnedCursorTarget("win32", "arm64"), /does not support/u);
  assert.throws(() => resolvePinnedCursorTarget("linux", "arm64"), /does not support/u);
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

test("Cursor artifact hashing rejects a same-path replacement before extraction", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openwrangler-cursor-hash-race-")));
  chmodSync(directory, 0o700);
  try {
    const body = Buffer.from("pinned-cursor-test-body", "utf8");
    const target = testTarget(body);
    const finalPath = join(directory, target.artifactName);
    const displaced = join(directory, "displaced-artifact");
    await assert.rejects(
      downloadPinnedCursorArtifact(target, createCursorAcquisitionRootReceipt(directory), {
        afterHashReadForTest({ path }) {
          assert.equal(path, finalPath);
          renameSync(path, displaced);
          writeFileSync(path, "replacement", { mode: 0o600 });
        },
        openResponse: async () => cursorResponse(body),
        timeoutMs: 1_000
      }),
      /changed while it was hashed/u
    );
    assert.deepEqual(readFileSync(displaced), body);
    assert.equal(readFileSync(finalPath, "utf8"), "replacement");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor extraction revalidates the artifact at every consuming command spawn", async () => {
  for (const scenario of [
    {
      label: "darwin-attachment",
      platform: "darwin",
      swapAt: "Pinned Cursor DMG attachment"
    },
    {
      label: "linux-package",
      platform: "linux",
      swapAt: "Pinned Cursor Debian package extraction"
    },
    {
      label: "windows-authenticode",
      platform: "win32",
      swapAt: "Pinned Cursor Authenticode verification"
    },
    {
      label: "windows-installer",
      platform: "win32",
      swapAt: "Pinned Cursor private installation"
    }
  ]) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `openwrangler-cursor-${scenario.label}-`)));
    chmodSync(directory, 0o700);
    try {
      const body = Buffer.from(`pinned-cursor-${scenario.label}`, "utf8");
      const target =
        scenario.platform === "darwin"
          ? {
              ...testTarget(body),
              architecture: "universal",
              artifactName: "cursor-test.dmg",
              format: "dmg",
              platform: "darwin"
            }
          : scenario.platform === "linux"
            ? testLinuxTarget(body)
            : testTarget(body);
      const rootReceipt = createCursorAcquisitionRootReceipt(directory);
      const artifact = await downloadPinnedCursorArtifact(target, rootReceipt, {
        openResponse: async () => cursorResponse(body),
        timeoutMs: 1_000
      });
      const displaced = join(directory, `displaced-${scenario.label}`);
      const commands = [];
      let swapped = false;
      await assert.rejects(
        extractPinnedCursorTarget(target, artifact, rootReceipt, {
          environment: scenario.platform === "win32" ? { SYSTEMROOT: "C:\\Windows" } : {},
          beforeArtifactSpawnForTest({ label, path }) {
            if (label !== scenario.swapAt) return;
            assert.equal(swapped, false);
            swapped = true;
            renameSync(path, displaced);
            writeFileSync(path, Buffer.alloc(body.length, 0x78), { mode: 0o600 });
          },
          async runCommand(command) {
            command.beforeSpawnCheck?.();
            commands.push(command.label);
            return { stdout: "", stderr: "" };
          }
        }),
        /changed at a command launch boundary/u
      );
      assert.equal(swapped, true);
      assert.deepEqual(readFileSync(displaced), body);
      assert.equal(commands.includes(scenario.swapAt), false);
      if (scenario.swapAt === "Pinned Cursor private installation") {
        assert.deepEqual(commands, ["Pinned Cursor Authenticode verification"]);
      } else {
        assert.deepEqual(commands, []);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Cursor macOS extraction separates integrity verification from exact signing-team inspection", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openwrangler-cursor-macos-signature-")));
  chmodSync(directory, 0o700);
  try {
    const body = Buffer.from("pinned-cursor-macos-signature", "utf8");
    const target = {
      ...testTarget(body),
      architecture: "universal",
      artifactName: "cursor-test.dmg",
      format: "dmg",
      platform: "darwin"
    };
    const rootReceipt = createCursorAcquisitionRootReceipt(directory);
    const artifact = await downloadPinnedCursorArtifact(target, rootReceipt, {
      openResponse: async () => cursorResponse(body),
      timeoutMs: 1_000
    });
    const commands = [];
    const extraction = await extractPinnedCursorTarget(target, artifact, rootReceipt, {
      environment: {},
      async runCommand(command) {
        command.beforeSpawnCheck?.();
        commands.push(command);
        if (command.label === "Pinned Cursor DMG attachment") {
          const mountPoint = command.args[command.args.indexOf("-mountpoint") + 1];
          mkdirSync(join(mountPoint, "Cursor.app"));
        } else if (command.label === "Pinned Cursor application extraction") {
          mkdirSync(command.args.at(-1));
        } else if (command.label === "Pinned Cursor signing-team inspection") {
          return { stdout: "", stderr: "TeamIdentifier=VDXQ22DGB9\n" };
        }
        return { stdout: "", stderr: "" };
      }
    });
    assert.equal(extraction.installationRoot, join(directory, "installation"));
    const signature = commands.find((command) => command.label === "Pinned Cursor code-signature verification");
    assert.deepEqual(signature, {
      executable: "/usr/bin/codesign",
      args: ["--verify", "--deep", "--strict", join(directory, "installation", "Cursor.app")],
      environment: {},
      label: "Pinned Cursor code-signature verification"
    });
    assert.deepEqual(
      commands.find((command) => command.label === "Pinned Cursor signing-team inspection"),
      {
        executable: "/usr/bin/codesign",
        args: ["--display", "--verbose=4", join(directory, "installation", "Cursor.app")],
        environment: {},
        label: "Pinned Cursor signing-team inspection"
      }
    );
    assert.deepEqual(
      commands.map((command) => command.label),
      [
        "Pinned Cursor DMG attachment",
        "Pinned Cursor application extraction",
        "Pinned Cursor code-signature verification",
        "Pinned Cursor signing-team inspection",
        "Pinned Cursor DMG detachment"
      ]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor Linux extraction uses dpkg-deb without package scripts and returns only the application root", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openwrangler-cursor-linux-package-")));
  chmodSync(directory, 0o700);
  try {
    const body = Buffer.from("pinned-cursor-linux-package", "utf8");
    const target = testLinuxTarget(body);
    const rootReceipt = createCursorAcquisitionRootReceipt(directory);
    const artifact = await downloadPinnedCursorArtifact(target, rootReceipt, {
      openResponse: async () => cursorResponse(body),
      timeoutMs: 1_000
    });
    const commands = [];
    const extraction = await extractPinnedCursorTarget(target, artifact, rootReceipt, {
      environment: {},
      async runCommand(command, options) {
        command.beforeSpawnCheck?.();
        commands.push({ command, options });
        const destination = command.args.at(-1);
        mkdirSync(join(destination, "usr", "share", "cursor"), { recursive: true });
        return { stdout: "", stderr: "" };
      }
    });
    assert.equal(extraction.installationRoot, join(directory, "installation", "usr", "share", "cursor"));
    assert.deepEqual(commands, [
      {
        command: {
          executable: "/usr/bin/dpkg-deb",
          args: ["--extract", artifact.path, join(directory, "installation")],
          beforeSpawnCheck: commands[0].command.beforeSpawnCheck,
          environment: {},
          label: "Pinned Cursor Debian package extraction"
        },
        options: { timeoutMs: 300_000, maxOutputBytes: 16 * 1024 }
      }
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor Windows extraction binds the artifact and exact leaf identity inside bounded Authenticode verification", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openwrangler-cursor-windows-signature-")));
  chmodSync(directory, 0o700);
  try {
    const body = Buffer.from("pinned-cursor-windows-signature", "utf8");
    const target = testTarget(body);
    const rootReceipt = createCursorAcquisitionRootReceipt(directory);
    const artifact = await downloadPinnedCursorArtifact(target, rootReceipt, {
      openResponse: async () => cursorResponse(body),
      timeoutMs: 1_000
    });
    const commands = [];
    let signatureOptions;
    const environment = { SYSTEMROOT: "C:\\Windows" };
    const extraction = await extractPinnedCursorTarget(target, artifact, rootReceipt, {
      environment,
      async runCommand(command, options) {
        command.beforeSpawnCheck?.();
        commands.push(command);
        if (command.label === "Pinned Cursor Authenticode verification") {
          signatureOptions = options;
        }
        if (command.label === "Pinned Cursor private installation") {
          writeFileSync(join(directory, "installation", "unins000.exe"), "uninstaller");
        }
        return { stdout: "", stderr: "" };
      }
    });
    assert.equal(extraction.installationRoot, join(directory, "installation"));
    const signature = commands.find((command) => command.label === "Pinned Cursor Authenticode verification");
    assert.equal(
      signature.executable,
      join(environment.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    );
    assert.deepEqual(signature.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const decodedCommand = Buffer.from(signature.args.at(-1), "base64").toString("utf16le");
    const encodedArtifactPath = Buffer.from(artifact.path, "utf16le").toString("base64");
    assert.match(decodedCommand, /Get-AuthenticodeSignature -LiteralPath \$literalPath/u);
    assert.match(decodedCommand, /\$null -eq \$certificate/u);
    assert.match(decodedCommand, /Status -ne 'Valid'/u);
    assert.match(decodedCommand, /X509NameType\]::SimpleName/u);
    assert.match(decodedCommand, /\$simpleName -cne 'Anysphere, Inc\.'/u);
    assert.match(decodedCommand, /SHA256\]::Create\(\)/u);
    assert.match(decodedCommand, /ComputeHash\(\$certificate\.RawData\)/u);
    assert.match(decodedCommand, /A64BA881C8D4EEAA0E9556856B750CB3C658E0C9765BABFDCEAB3A2797B905AB/u);
    assert.match(decodedCommand, /finally \{ \$sha256\.Dispose\(\) \}/u);
    assert.deepEqual(
      [...decodedCommand.matchAll(/\bexit (4[1-4])\b/gu)].map((match) => match[1]),
      ["41", "42", "43", "44"]
    );
    assert.doesNotMatch(decodedCommand, /SignerCertificate\.Subject|-notlike|Write-(?:Error|Host|Output)/u);
    assert.equal(decodedCommand.includes(encodedArtifactPath), true);
    assert.doesNotMatch(decodedCommand, /\$args/u);
    assert.equal(signature.args.includes(artifact.path), false);
    assert.deepEqual(signature.environment, environment);
    assert.deepEqual(signatureOptions, { timeoutMs: 120_000, maxOutputBytes: 16 * 1024 });
    assert.deepEqual(
      commands.map((command) => command.label),
      ["Pinned Cursor Authenticode verification", "Pinned Cursor private installation"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor installation validation binds product, version, commit, target files, and containment", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const directory = mkdtempSync(join(tmpdir(), `openwrangler-cursor-${platform}-`));
    chmodSync(directory, 0o700);
    try {
      const target =
        platform === "darwin"
          ? PINNED_CURSOR_TARGETS["darwin-universal"]
          : platform === "linux"
            ? PINNED_CURSOR_TARGETS["linux-x64"]
            : PINNED_CURSOR_TARGETS["win32-x64"];
      const appRoot =
        platform === "darwin"
          ? join(directory, "Cursor.app", "Contents", "Resources", "app")
          : join(directory, "resources", "app");
      const executable =
        platform === "darwin"
          ? join(directory, "Cursor.app", "Contents", "MacOS", "Cursor")
          : platform === "linux"
            ? join(directory, "cursor")
            : join(directory, "Cursor.exe");
      const cli =
        platform === "darwin"
          ? join(appRoot, "bin", "cursor")
          : platform === "linux"
            ? join(directory, "bin", "cursor")
            : join(appRoot, "bin", "cursor.cmd");
      mkdirSync(join(appRoot, "bin"), { recursive: true });
      mkdirSync(join(executable, ".."), { recursive: true });
      mkdirSync(join(cli, ".."), { recursive: true });
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

function testLinuxTarget(body) {
  return {
    ...PINNED_CURSOR_TARGETS["linux-x64"],
    artifactName: "cursor-test.deb",
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    url: "https://downloads.cursor.com/acceptance/cursor-test.deb"
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
