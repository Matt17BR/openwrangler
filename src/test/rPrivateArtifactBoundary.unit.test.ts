// @vitest-environment node

import {
  lstat,
  link,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeRPrivateArtifactOperations,
  readRPrivateArtifact,
  removeRPrivateArtifactAtPath,
  RPrivateArtifactCleanupError,
  rPrivateArtifactFailureRequiresContainerPreservation,
  rPrivateCleanupDirectoryModeIsPrivate,
  streamAndRemoveRPrivateArtifact,
  type RPrivateArtifactOperations
} from "../extension/r/rPrivateArtifactBoundary";

describe("R private artifact boundary", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), "ow-r-private-artifact-unit-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts Windows directory modes without weakening POSIX private-mode checks", () => {
    expect(rPrivateCleanupDirectoryModeIsPrivate(0o40755n, "win32")).toBe(true);
    expect(rPrivateCleanupDirectoryModeIsPrivate(0o40700n, "linux")).toBe(true);
    expect(rPrivateCleanupDirectoryModeIsPrivate(0o40755n, "linux")).toBe(false);
  });

  it("completes identified cleanup under Windows-synthesized directory mode bits", async () => {
    const artifactPath = resolve(directory, "windows-response.json");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const base = createNodeRPrivateArtifactOperations();
    const operations: RPrivateArtifactOperations = {
      ...base,
      platform: "win32",
      async lstat(filePath) {
        const metadata = await base.lstat(filePath);
        if (!basename(filePath).startsWith(".openwrangler-cleanup-")) return metadata;
        return new Proxy(metadata, {
          get(target, property) {
            if (property === "mode") return target.mode | 0o077n;
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    };

    await expect(
      removeRPrivateArtifactAtPath({
        filePath: artifactPath,
        maximumBytes: 5,
        expectedBytes: 5,
        label: "test Windows R response",
        operations
      })
    ).resolves.toBeUndefined();

    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(await soleQuarantinedArtifact(directory))).toEqual(Buffer.alloc(0));
  });

  it("reads and descriptor-scrubs the exact artifact outside its public pathname", async () => {
    const artifactPath = resolve(directory, "response.json");
    await writeFile(artifactPath, '{"status":"ready"}', { mode: 0o600 });

    const contents = await readRPrivateArtifact({
      filePath: artifactPath,
      maximumBytes: 1_024,
      label: "test R response",
      removeAfterRead: "success"
    });

    expect(contents?.toString("utf8")).toBe('{"status":"ready"}');
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(await soleQuarantinedArtifact(directory))).toEqual(Buffer.alloc(0));
  });

  it("scrubs the exact artifact when the directory link count includes its new file entry", async () => {
    const artifactPath = resolve(directory, "response.json");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const base = createNodeRPrivateArtifactOperations();
    const directoryLinkCounts = new Set<bigint>();
    const operations: RPrivateArtifactOperations = {
      ...base,
      async lstat(filePath) {
        const metadata = await base.lstat(filePath);
        if (!basename(filePath).startsWith(".openwrangler-cleanup-")) return metadata;
        const nlink = 2n + BigInt((await readdir(filePath)).length);
        directoryLinkCounts.add(nlink);
        return new Proxy(metadata, {
          get(target, property) {
            if (property === "nlink") return nlink;
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    };

    const contents = await readRPrivateArtifact({
      filePath: artifactPath,
      maximumBytes: 5,
      label: "test R response",
      removeAfterRead: "success",
      operations
    });

    expect(contents?.toString("utf8")).toBe("owned");
    expect(directoryLinkCounts).toEqual(new Set([2n, 3n]));
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(await soleQuarantinedArtifact(directory))).toEqual(Buffer.alloc(0));
  });

  it("refuses a replacement cleanup directory even when it contains the exact owned artifact", async () => {
    const artifactPath = resolve(directory, "response.json");
    const displacedDirectory = resolve(directory, "displaced-cleanup");
    const unrelatedPath = resolve(displacedDirectory, "unrelated.txt");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const base = createNodeRPrivateArtifactOperations();
    let quarantinePath: string | undefined;
    let openedQuarantinedArtifact = false;
    const operations: RPrivateArtifactOperations = {
      ...base,
      async rename(sourcePath, destinationPath) {
        await base.rename(sourcePath, destinationPath);
        quarantinePath = destinationPath;
        const cleanupDirectory = dirname(destinationPath);
        await rename(cleanupDirectory, displacedDirectory);
        await mkdir(cleanupDirectory, { mode: 0o700 });
        await rename(resolve(displacedDirectory, "artifact"), destinationPath);
        await writeFile(unrelatedPath, "other", { mode: 0o600 });
      },
      async open(filePath, flags) {
        if (filePath === quarantinePath) openedQuarantinedArtifact = true;
        return base.open(filePath, flags);
      }
    };

    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        label: "test R response",
        removeAfterRead: "success",
        operations
      })
    );

    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect(openedQuarantinedArtifact).toBe(false);
    expect(quarantinePath).toBeDefined();
    expect(await readFile(quarantinePath!, "utf8")).toBe("owned");
    expect(await readFile(unrelatedPath, "utf8")).toBe("other");
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("descriptor-scrubs an unread exact artifact through the same boundary", async () => {
    const artifactPath = resolve(directory, "export.csv");
    await writeFile(artifactPath, "value\n1\n", { mode: 0o600 });

    await removeRPrivateArtifactAtPath({
      filePath: artifactPath,
      maximumBytes: 1_024,
      label: "test R export"
    });

    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(await soleQuarantinedArtifact(directory))).toEqual(Buffer.alloc(0));
  });

  it("leaves a same-size pathname substitution and its displaced owned file intact", async () => {
    const artifactPath = resolve(directory, "response.json");
    const displacedPath = resolve(directory, "owned-response.json");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const operations = operationsWithClose(async () => {
      await rename(artifactPath, displacedPath);
      await writeFile(artifactPath, "other", { mode: 0o600 });
    });

    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        expectedBytes: 5,
        label: "test R response",
        removeAfterRead: "success",
        operations
      })
    );

    expect(error).toBeInstanceOf(RPrivateArtifactCleanupError);
    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect(await readFile(artifactPath, "utf8")).toBe("other");
    expect(await readFile(displacedPath, "utf8")).toBe("owned");
  });

  it("quarantines without deleting a replacement swapped after the initial identity check", async () => {
    const artifactPath = resolve(directory, "response.json");
    const displacedPath = resolve(directory, "owned-response.json");
    let quarantinePath: string | undefined;
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const base = createNodeRPrivateArtifactOperations();
    const operations: RPrivateArtifactOperations = {
      ...base,
      async rename(sourcePath, destinationPath) {
        await rename(sourcePath, displacedPath);
        await writeFile(sourcePath, "other", { mode: 0o600 });
        quarantinePath = destinationPath;
        await rename(sourcePath, destinationPath);
      }
    };

    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        expectedBytes: 5,
        label: "test R response",
        removeAfterRead: "success",
        operations
      })
    );

    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect(quarantinePath).toBeDefined();
    expect(await readFile(displacedPath, "utf8")).toBe("owned");
    expect(await readFile(quarantinePath!, "utf8")).toBe("other");
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a quarantined replacement instead of path-unlinking after a swap", async () => {
    const artifactPath = resolve(directory, "response.json");
    const displacedPath = resolve(directory, "quarantined-owned-response.json");
    let replacementPath: string | undefined;
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const base = createNodeRPrivateArtifactOperations();
    const operations: RPrivateArtifactOperations = {
      ...base,
      async open(filePath, flags) {
        if (
          !replacementPath &&
          basename(filePath) === "artifact" &&
          basename(dirname(filePath)).startsWith(".openwrangler-cleanup-")
        ) {
          replacementPath = filePath;
          await rename(filePath, displacedPath);
          await writeFile(filePath, "other", { mode: 0o600 });
        }
        return base.open(filePath, flags);
      }
    };

    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        expectedBytes: 5,
        label: "test R response",
        removeAfterRead: "success",
        operations
      })
    );

    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect(replacementPath).toBeDefined();
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(displacedPath, "utf8")).toBe("owned");
    expect(await readFile(replacementPath!, "utf8")).toBe("other");
  });

  it("does not follow or remove a substituted symlink", async (context) => {
    const artifactPath = resolve(directory, "response.json");
    const displacedPath = resolve(directory, "owned-response.json");
    const attackerPath = resolve(directory, "attacker.json");
    const replacementPath = resolve(directory, "replacement-link.json");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    await writeFile(attackerPath, "other", { mode: 0o600 });
    try {
      await symlink(attackerPath, replacementPath);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows refused file-symlink creation on this host");
      }
      throw error;
    }
    const operations = operationsWithClose(async () => {
      await rename(artifactPath, displacedPath);
      await rename(replacementPath, artifactPath);
    });

    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        label: "test R response",
        removeAfterRead: "success",
        operations
      })
    );

    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect((await lstat(artifactPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(attackerPath, "utf8")).toBe("other");
    expect(await readFile(displacedPath, "utf8")).toBe("owned");
  });

  it("leaves an artifact untouched when its link count changes after close", async () => {
    const artifactPath = resolve(directory, "response.json");
    const linkedPath = resolve(directory, "linked-response.json");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const operations = operationsWithClose(async () => {
      await link(artifactPath, linkedPath);
    });

    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        label: "test R response",
        removeAfterRead: "success",
        operations
      })
    );

    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect((await lstat(artifactPath, { bigint: true })).nlink).toBe(2n);
    expect((await lstat(linkedPath, { bigint: true })).nlink).toBe(2n);
  });

  it.each([
    ["after open", false],
    ["after initial stat", false],
    ["during read", false],
    ["after final stat", false],
    ["after open", true],
    ["after initial stat", true],
    ["during read", true],
    ["after final stat", true]
  ] as const)(
    "rejects atomic replacement %s without changing immutable ownership (replaceable: %s)",
    async (stage, allowAtomicReplacement) => {
      const artifactPath = resolve(directory, "notification.json");
      const nextPath = resolve(directory, "notification.json.tmp");
      await writeFile(artifactPath, "owned", { mode: 0o600 });
      await writeFile(nextPath, "newer", { mode: 0o644 });
      const base = createNodeRPrivateArtifactOperations();
      let renamed = false;
      let closed = 0;
      const replace = async () => {
        await rename(nextPath, artifactPath);
        renamed = true;
      };
      const operations: RPrivateArtifactOperations = {
        ...base,
        async open(filePath, flags) {
          const handle = await base.open(filePath, flags);
          if (stage === "after open") await replace();
          let stats = 0;
          return {
            async stat(options) {
              const metadata = await handle.stat(options);
              stats += 1;
              if ((stage === "after initial stat" && stats === 1) || (stage === "after final stat" && stats === 2))
                await replace();
              return metadata;
            },
            async read(...args) {
              const result = await handle.read(...args);
              if (stage === "during read" && !renamed) await replace();
              return result;
            },
            truncate: (length) => handle.truncate(length),
            async close() {
              closed += 1;
              await handle.close();
            }
          };
        }
      };
      const error = await captureFailure(() =>
        readRPrivateArtifact({
          filePath: artifactPath,
          maximumBytes: 5,
          label: "test R notification",
          allowAtomicReplacement,
          operations
        })
      );
      expect(renamed).toBe(true);
      expect(closed).toBe(1);
      expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(!allowAtomicReplacement);
      expect(
        await readRPrivateArtifact({
          filePath: artifactPath,
          maximumBytes: 5,
          label: "test R notification",
          allowAtomicReplacement
        })
      ).toEqual(Buffer.from("newer"));
    }
  );

  it.for([
    "symlink",
    "hardlink",
    "directory",
    "retained old inode",
    "changed owner",
    "changed descriptor mode",
    "unreadable retired descriptor"
  ] as const)("preserves an unsafe %s during a replaceable notification read", async (replacement, context) => {
    if (replacement === "changed descriptor mode" && process.platform === "win32")
      context.skip("POSIX file-mode transition");
    const artifactPath = resolve(directory, "notification.json");
    const nextPath = resolve(directory, "next");
    const otherPath = resolve(directory, "other");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    await writeFile(otherPath, "other", { mode: 0o600 });
    if (replacement === "symlink") {
      try {
        await symlink(otherPath, nextPath);
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
          context.skip("Windows refused file-symlink creation on this host");
        throw error;
      }
    } else if (replacement === "hardlink") await link(otherPath, nextPath);
    else if (replacement === "directory") await mkdir(nextPath);
    else await writeFile(nextPath, "newer", { mode: 0o600 });
    const base = createNodeRPrivateArtifactOperations();
    let swapped = false;
    const operations: RPrivateArtifactOperations = {
      ...base,
      async open(filePath, flags) {
        const handle = await base.open(filePath, flags);
        if (replacement !== "unreadable retired descriptor") return handle;
        let stats = 0;
        return {
          stat: async (options) => {
            if (++stats > 1) throw new Error("retired descriptor stat failed");
            return handle.stat(options);
          },
          read: handle.read.bind(handle),
          truncate: handle.truncate.bind(handle),
          close: handle.close.bind(handle)
        };
      },
      async lstat(filePath) {
        if (filePath === artifactPath && !swapped) {
          swapped = true;
          if (replacement === "changed descriptor mode") await chmod(artifactPath, 0o644);
          if (replacement === "retained old inode" || replacement === "directory")
            await rename(artifactPath, resolve(directory, "retired"));
          await rename(nextPath, artifactPath);
        }
        const metadata = await base.lstat(filePath);
        if (replacement !== "changed owner") return metadata;
        return new Proxy(metadata, {
          get(target, property) {
            if (property === "uid") return target.uid + 1n;
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    };
    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        label: "test R notification",
        allowAtomicReplacement: true,
        operations
      })
    );
    expect(swapped).toBe(true);
    if (replacement === "unreadable retired descriptor")
      expect((error as Error).cause).toEqual(new Error("retired descriptor stat failed"));
    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect(await lstat(artifactPath)).toBeDefined();
    expect(await readFile(otherPath, "utf8")).toBe("other");
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "preserves an artifact refused by no-follow open (replaceable: %s)",
    async (allowAtomicReplacement) => {
      const artifactPath = resolve(directory, "notification.json");
      const otherPath = resolve(directory, "other.json");
      await writeFile(otherPath, "other", { mode: 0o600 });
      await symlink(otherPath, artifactPath);
      const error = await captureFailure(() =>
        readRPrivateArtifact({
          filePath: artifactPath,
          maximumBytes: 5,
          label: "test R notification",
          allowAtomicReplacement
        })
      );
      expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
      expect((error as Error).cause).toMatchObject({ code: "ELOOP" });
      expect((await lstat(artifactPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(otherPath, "utf8")).toBe("other");
    }
  );

  it("keeps replacement semantics unavailable for removal and preserves byte bounds", async () => {
    const artifactPath = resolve(directory, "notification.json");
    await writeFile(artifactPath, "too-large", { mode: 0o600 });
    await expect(
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        label: "test R notification",
        allowAtomicReplacement: true,
        removeAfterRead: "success"
      })
    ).rejects.toThrow("can only be read without removal");
    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        label: "test R notification",
        allowAtomicReplacement: true
      })
    );
    expect((error as Error).message).toContain("invalid test R notification");
    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(false);
    expect(await readFile(artifactPath, "utf8")).toBe("too-large");
  });

  it("reports a descriptor close failure while still scrubbing the matching owned artifact", async () => {
    const artifactPath = resolve(directory, "response.json");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const operations = operationsWithClose(async () => {
      throw new Error("reported close failure");
    });

    const error = await captureFailure(() =>
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 5,
        label: "test R response",
        removeAfterRead: "success",
        operations
      })
    );

    expect(error).toBeInstanceOf(RPrivateArtifactCleanupError);
    expect((error as Error).message).toContain("could not completely clean up");
    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(false);
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(await soleQuarantinedArtifact(directory))).toEqual(Buffer.alloc(0));
  });

  it("rejects a metadata-visible same-inode rewrite but still removes that exact owned artifact", async () => {
    const artifactPath = resolve(directory, "export.csv");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    // Separate the initial mtime from the write even on coarse filesystem clocks.
    const initialTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(artifactPath, initialTime, initialTime);
    let rewritten = false;

    const error = await captureFailure(() =>
      streamAndRemoveRPrivateArtifact(
        {
          filePath: artifactPath,
          maximumBytes: 5,
          expectedBytes: 5,
          label: "test R export",
          chunkBytes: 2
        },
        async () => {
          if (rewritten) return;
          await writeFile(artifactPath, "other", { flag: "r+" });
          rewritten = true;
        }
      )
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("changing test R export artifact");
    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(false);
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(await soleQuarantinedArtifact(directory))).toEqual(Buffer.alloc(0));
  });

  it("aggregates streaming, close, and identity cleanup failures without deleting a replacement", async () => {
    const artifactPath = resolve(directory, "export.csv");
    const displacedPath = resolve(directory, "owned-export.csv");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    const operations = operationsWithClose(async () => {
      await rename(artifactPath, displacedPath);
      await writeFile(artifactPath, "other", { mode: 0o600 });
      throw new Error("reported close failure");
    });

    const error = await captureFailure(() =>
      streamAndRemoveRPrivateArtifact(
        {
          filePath: artifactPath,
          maximumBytes: 5,
          expectedBytes: 5,
          label: "test R export",
          chunkBytes: 2,
          operations
        },
        async () => {
          throw new Error("host writer failure");
        }
      )
    );

    expect(error).toBeInstanceOf(RPrivateArtifactCleanupError);
    expect((error as RPrivateArtifactCleanupError).errors).toHaveLength(3);
    expect(rPrivateArtifactFailureRequiresContainerPreservation(error)).toBe(true);
    expect(await readFile(artifactPath, "utf8")).toBe("other");
    expect(await readFile(displacedPath, "utf8")).toBe("owned");
  });

  it("rejects an oversized artifact without removing it", async () => {
    const artifactPath = resolve(directory, "response.json");
    await writeFile(artifactPath, "oversized", { mode: 0o600 });

    await expect(
      readRPrivateArtifact({
        filePath: artifactPath,
        maximumBytes: 4,
        label: "test R response",
        removeAfterRead: "success"
      })
    ).rejects.toThrow("invalid test R response artifact");
    expect(await readFile(artifactPath, "utf8")).toBe("oversized");
  });
});

function operationsWithClose(afterClose: () => Promise<void>): RPrivateArtifactOperations {
  const base = createNodeRPrivateArtifactOperations();
  return {
    ...base,
    async open(filePath, flags) {
      const handle = await base.open(filePath, flags);
      return {
        stat: (options) => handle.stat(options),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        truncate: (length) => handle.truncate(length),
        async close() {
          await handle.close();
          await afterClose();
        }
      };
    }
  };
}

async function soleQuarantinedArtifact(root: string): Promise<string> {
  const entries = await readdir(root);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatch(/^\.openwrangler-cleanup-/);
  return resolve(root, entries[0]!, "artifact");
}

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the private artifact operation to fail.");
}
