import * as assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

interface AcceptanceDirectoryMetadata {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface AcceptanceTemporaryDirectoryDependencies {
  readonly platform: NodeJS.Platform;
  readonly isolatedTempRoot: string;
  readonly extensionTests: string | undefined;
  readonly lstat: (candidate: string) => AcceptanceDirectoryMetadata;
  readonly remove: (
    candidate: string,
    options: Readonly<{ recursive: true; force: true; maxRetries: 5; retryDelay: 100 }>
  ) => void;
  readonly makeTemp: (prefix: string) => string;
  readonly exists: (candidate: string) => boolean;
}

function acceptanceTemporaryDirectoryDependencies(): AcceptanceTemporaryDirectoryDependencies {
  return {
    platform: process.platform,
    isolatedTempRoot: tmpdir(),
    extensionTests: process.env.OPEN_WRANGLER_EXTENSION_TESTS,
    lstat: lstatSync,
    remove: rmSync,
    makeTemp: mkdtempSync,
    exists: existsSync
  };
}

export function resolveAcceptanceTemporaryDirectory(
  directory: string,
  dependencies = acceptanceTemporaryDirectoryDependencies()
): string {
  const isolatedTempRoot = path.resolve(dependencies.isolatedTempRoot);
  const candidate = path.resolve(directory);
  const relative = path.relative(isolatedTempRoot, candidate);
  assert.ok(
    relative.length > 0 &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !relative.includes(path.sep),
    "Acceptance fixture directories must be direct children of the isolated editor temp root."
  );
  const metadata = dependencies.lstat(candidate);
  assert.ok(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    "An acceptance fixture root must remain a real directory."
  );
  return candidate;
}

export function cleanupAcceptanceTemporaryDirectory(
  directory: string,
  dependencies = acceptanceTemporaryDirectoryDependencies()
): void {
  const ownedDirectory = resolveAcceptanceTemporaryDirectory(directory, dependencies);
  if (dependencies.platform === "win32") {
    const isolatedTempRoot = path.resolve(dependencies.isolatedTempRoot);
    assert.equal(
      dependencies.extensionTests,
      "1",
      "Windows fixture cleanup may be deferred only inside the editor acceptance harness."
    );
    assert.equal(
      path.basename(path.dirname(isolatedTempRoot)).toLowerCase(),
      "ow",
      "Deferred Windows acceptance fixtures require the runner-owned temp parent."
    );
    assert.match(
      path.basename(isolatedTempRoot),
      /^x-[A-Za-z0-9]+$/u,
      "Deferred Windows acceptance fixtures require the runner-owned random temp root."
    );
    assert.match(
      path.basename(ownedDirectory),
      /^openwrangler-[A-Za-z0-9-]+$/u,
      "Deferred Windows acceptance fixtures must use an Open Wrangler-owned random directory name."
    );
    // VS Code's Windows file service may retain a fixture-directory handle until
    // the workbench exits even after its custom editor and runtime are closed.
    // The outer acceptance runner owns this temp root and removes it only after
    // the Job Object is proven empty, which is the first safe deletion boundary.
    return;
  }
  dependencies.remove(ownedDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function exerciseAcceptanceTemporaryDirectoryCleanupContract(
  dependencies = acceptanceTemporaryDirectoryDependencies()
): void {
  const directory = dependencies.makeTemp(path.join(dependencies.isolatedTempRoot, "openwrangler-cleanup-contract-"));
  assert.throws(
    () => cleanupAcceptanceTemporaryDirectory(path.join(directory, "nested"), dependencies),
    /direct children of the isolated editor temp root/u
  );
  cleanupAcceptanceTemporaryDirectory(directory, dependencies);
  assert.equal(
    dependencies.exists(directory),
    dependencies.platform === "win32",
    "Windows retains fixture roots until job-empty cleanup; other platforms remove them immediately."
  );
}
