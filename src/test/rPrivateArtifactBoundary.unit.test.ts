import { lstat, link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeRPrivateArtifactOperations,
  readRPrivateArtifact,
  removeRPrivateArtifactAtPath,
  RPrivateArtifactCleanupError,
  rPrivateArtifactFailureRequiresContainerPreservation,
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

  it("reads and removes the exact descriptor-validated artifact", async () => {
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
  });

  it("removes an unread exact artifact through the same descriptor boundary", async () => {
    const artifactPath = resolve(directory, "export.csv");
    await writeFile(artifactPath, "value\n1\n", { mode: 0o600 });

    await removeRPrivateArtifactAtPath({
      filePath: artifactPath,
      maximumBytes: 1_024,
      label: "test R export"
    });

    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
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

  it.skipIf(process.platform === "win32")("does not follow or remove a substituted symlink", async () => {
    const artifactPath = resolve(directory, "response.json");
    const displacedPath = resolve(directory, "owned-response.json");
    const attackerPath = resolve(directory, "attacker.json");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
    await writeFile(attackerPath, "other", { mode: 0o600 });
    const operations = operationsWithClose(async () => {
      await rename(artifactPath, displacedPath);
      await symlink(attackerPath, artifactPath);
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

  it("reports a descriptor close failure while still removing the matching owned artifact", async () => {
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
  });

  it("rejects a same-inode rewrite but still removes that exact owned artifact", async () => {
    const artifactPath = resolve(directory, "export.csv");
    await writeFile(artifactPath, "owned", { mode: 0o600 });
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
        async close() {
          await handle.close();
          await afterClose();
        }
      };
    }
  };
}

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the private artifact operation to fail.");
}
