import assert from "node:assert/strict";
import { link, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTANCE_PROGRESS_MAX_BYTES,
  ACCEPTANCE_PROGRESS_PROTOCOL,
  acceptanceProgressSignalPath,
  writeAcceptanceProgressCheckpoint,
  type AcceptanceProgressEnvelope
} from "./extensionHost/progress";

const RUN_ID = "8be8c321-d21d-4de8-a890-13d18844a3c7";
const envelope = (checkpoint: string): AcceptanceProgressEnvelope => ({
  protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
  runId: RUN_ID,
  phase: "verify",
  checkpoint
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("extension-host acceptance progress", () => {
  it("publishes one bounded checkpoint through an exclusive randomized sibling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-host-progress-"));
    temporaryDirectories.push(directory);
    const progressPath = join(directory, "progress.txt");

    writeAcceptanceProgressCheckpoint(progressPath, envelope("verify:first"), { randomId: () => "first" });
    expect(JSON.parse(await readFile(progressPath, "utf8"))).toEqual(envelope("verify:first"));
    writeAcceptanceProgressCheckpoint(progressPath, envelope("verify:second"), { randomId: () => "second" });
    expect(JSON.parse(await readFile(progressPath, "utf8"))).toEqual(envelope("verify:second"));
    const heartbeatPath = acceptanceProgressSignalPath(progressPath, RUN_ID, "verify");
    expect((await stat(heartbeatPath)).size).toBe(0);
    expect((await readdir(directory)).sort()).toEqual(["progress.txt", heartbeatPath.slice(directory.length + 1)]);
  });

  it("rejects multiline and oversized checkpoints before touching the destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-host-progress-"));
    temporaryDirectories.push(directory);
    const progressPath = join(directory, "progress.txt");

    for (const checkpoint of ["", "verify:first\nverify:second", "x".repeat(ACCEPTANCE_PROGRESS_MAX_BYTES)]) {
      assert.throws(
        () => writeAcceptanceProgressCheckpoint(progressPath, envelope(checkpoint)),
        /exact protocol\/runId\/phase\/checkpoint envelope|at most 1024 UTF-8 bytes/u
      );
    }
    for (const malformed of [
      { ...envelope("verify:first"), extra: true },
      { ...envelope("verify:first"), protocol: 2 },
      { ...envelope("verify:first"), runId: "wrong-run" },
      { ...envelope("verify:first"), phase: "wrong phase" }
    ]) {
      assert.throws(
        () => writeAcceptanceProgressCheckpoint(progressPath, malformed as AcceptanceProgressEnvelope),
        /exact protocol\/runId\/phase\/checkpoint envelope/u
      );
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it("never truncates or removes a pre-existing temporary hard-link trap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-host-progress-"));
    temporaryDirectories.push(directory);
    const progressPath = join(directory, "progress.txt");
    const victimPath = join(directory, "victim.txt");
    const trapPath = `${progressPath}.${process.pid}.trapped.tmp`;
    await writeFile(victimPath, "keep me", "utf8");
    await link(victimPath, trapPath);

    assert.throws(
      () =>
        writeAcceptanceProgressCheckpoint(progressPath, envelope("verify:checkpoint"), { randomId: () => "trapped" }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST")
    );
    expect(await readFile(victimPath, "utf8")).toBe("keep me");
    expect(await readFile(trapPath, "utf8")).toBe("keep me");
    expect((await stat(victimPath)).nlink).toBe(2);
  });
});
