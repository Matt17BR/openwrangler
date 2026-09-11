import * as assert from "node:assert/strict";
import { lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

interface AcceptanceDirectoryMetadata {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface AcceptanceTemporaryDirectoryDependencies {
  readonly platform: NodeJS.Platform;
  readonly isolatedTempRoot: string;
  readonly editorTempRoot: string | undefined;
  readonly extensionTests: string | undefined;
  readonly lstat: (candidate: string) => AcceptanceDirectoryMetadata;
  readonly remove: (
    candidate: string,
    options: Readonly<{ recursive: true; force: true; maxRetries: 5; retryDelay: 100 }>
  ) => void;
}

function acceptanceTemporaryDirectoryDependencies(): AcceptanceTemporaryDirectoryDependencies {
  return {
    platform: process.platform,
    isolatedTempRoot: tmpdir(),
    editorTempRoot: process.env.OPEN_WRANGLER_EDITOR_TEMP_ROOT,
    extensionTests: process.env.OPEN_WRANGLER_EXTENSION_TESTS,
    lstat: lstatSync,
    remove: rmSync
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
    const editorTempRoot = dependencies.editorTempRoot;
    assert.ok(
      typeof editorTempRoot === "string" && path.isAbsolute(editorTempRoot),
      "Deferred Windows acceptance fixtures require the absolute runner-owned temp root."
    );
    assert.match(
      path.basename(path.resolve(editorTempRoot)),
      /^x-[A-Za-z0-9]+$/u,
      "Deferred Windows acceptance fixtures require the runner-owned random temp root."
    );
    assert.equal(
      path.relative(path.join(editorTempRoot, "home", "AppData", "Local", "Temp"), isolatedTempRoot),
      "",
      "Deferred Windows acceptance fixtures require the runner-owned profile Temp directory."
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
