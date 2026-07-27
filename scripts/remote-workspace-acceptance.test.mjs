import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRemoteWorkspaceHost,
  createRemoteWorkspaceBwrapArguments,
  createRemoteWorkspaceLayout,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspaceResult
} from "./remote-workspace-acceptance.mjs";
import { PINNED_REMOTE_VSCODE_COMMIT } from "./remote-workspace-acquisition.mjs";

test("Remote workspace layout is short, private, and independently scoped", () => {
  const parent = privateRoot("ow-remote-layout-");
  try {
    const layout = createRemoteWorkspaceLayout(parent);
    assert.equal(layout.root.startsWith(parent), true);
    assert.equal(layout.workspace.startsWith(layout.remoteHome), true);
    assert.equal(layout.remoteExtensions.startsWith(layout.remoteHome), true);
    assert.notEqual(layout.localHome, layout.remoteHome);
    assert.notEqual(layout.localExtensions, layout.remoteExtensions);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Remote host preflight is Linux-only and fails closed without user namespaces", async () => {
  await assert.rejects(
    assertRemoteWorkspaceHost({ platform: "darwin", architecture: "arm64", tools: {} }),
    /only Linux x64/u
  );
  const fakeTools = {
    bwrap: "/usr/bin/true",
    ip: "/usr/bin/true",
    ssh: "/usr/bin/true",
    sshd: "/usr/bin/true",
    sshKeygen: "/usr/bin/true"
  };
  await assert.rejects(
    assertRemoteWorkspaceHost(
      { platform: "linux", architecture: "x64", tools: fakeTools },
      { runCommand: async () => Promise.reject(new Error("unprivileged user namespaces disabled")) }
    ),
    /no desktop-network fallback/u
  );
});

test("Bubblewrap arguments clear the environment and create zero-network PID isolation", () => {
  const parent = privateRoot("ow-remote-bwrap-");
  try {
    const layout = createRemoteWorkspaceLayout(parent);
    const child = join(layout.root, "child.mjs");
    writeFileSync(child, "export {};\n");
    const descriptor = layout.descriptor;
    writeFileSync(descriptor, "{}\n", { mode: 0o600 });
    const args = createRemoteWorkspaceBwrapArguments({
      root: layout.root,
      descriptor,
      childScript: child,
      nodeExecutable: "/usr/bin/node",
      tools: { ip: "/usr/sbin/ip", sshd: "/usr/sbin/sshd" }
    });
    for (const required of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--tmpfs"
    ]) {
      assert.equal(args.includes(required), true, `Expected ${required}.`);
    }
    assert.equal(args.includes(process.env.HOME ?? "<missing>"), false);
    assert.equal(args.at(-3), descriptor);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Remote SSH log attestation proves exact offline reuse and rejects downloads", () => {
  const valid = [
    `Using commit id "${PINNED_REMOTE_VSCODE_COMMIT}" and quality "stable" for server`,
    "Found existing installation at /private/.vscode-server...",
    "didLocalDownload==0=="
  ].join("\n");
  assert.deepEqual(validateRemoteSshLogAttestation(valid), {
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    didLocalDownload: false,
    existingInstallation: true
  });
  for (const mutation of [
    valid.replace("didLocalDownload==0==", "didLocalDownload==1=="),
    `${valid}\nDownloading VS Code server locally...`,
    `${valid}\nvscode-cli-${PINNED_REMOTE_VSCODE_COMMIT}.tar.gz`,
    valid.replace(PINNED_REMOTE_VSCODE_COMMIT, "0".repeat(40)),
    valid.replace("Found existing installation", "Installing server")
  ]) {
    assert.throws(() => validateRemoteSshLogAttestation(mutation), /offline server chain/u);
  }
});

test("Remote result validation rejects authority-loss failures and mis-correlation", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    validateRemoteWorkspaceResult(JSON.stringify({ protocol: 1, runId, phase: "remote-workspace", ok: true }), {
      runId
    }),
    { protocol: 1, runId, phase: "remote-workspace", ok: true }
  );
  for (const result of [
    { protocol: 1, runId: "22222222-2222-4222-8222-222222222222", phase: "remote-workspace", ok: true },
    { protocol: 1, runId, phase: "remote-workspace", ok: false, error: "remote authority lost" },
    { protocol: 1, runId, phase: "verify", ok: true },
    { protocol: 1, runId, phase: "remote-workspace", ok: true, authority: REMOTE_WORKSPACE_AUTHORITY }
  ]) {
    assert.throws(() => validateRemoteWorkspaceResult(JSON.stringify(result), { runId }), /correlated success result/u);
  }
});

test("Remote acceptance deadlines stay bounded and match native-editor ownership rules", () => {
  assert.equal(REMOTE_WORKSPACE_PHASE_TIMEOUT_MS, 300_000);
  assert.equal(REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS, 180_000);
});

function privateRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  return root;
}
