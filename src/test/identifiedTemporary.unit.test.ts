import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeIdentifiedTemporary } from "./extensionHost/identifiedTemporary";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function readDescriptor(file: number, size: number): string {
  const buffer = Buffer.alloc(size);
  const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
  return buffer.toString("utf8", 0, bytesRead);
}

describe("identified fragment temporary cleanup", () => {
  it("withholds cleanup after path substitution and retains the replacement", () => {
    const root = join(tmpdir(), `ow-fragment-cleanup-${process.pid}-${randomUUID()}`);
    roots.push(root);
    mkdirSync(root, { mode: 0o700 });
    const temporary = join(root, "fragment.tmp");
    const retained = join(root, "retained.tmp");
    writeFileSync(temporary, "owned temporary", { flag: "wx", mode: 0o600 });
    renameSync(temporary, retained);
    writeFileSync(temporary, "replacement must survive", { flag: "wx", mode: 0o600 });

    const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const retainedDescriptor = openSync(retained, openFlags);
    const replacementDescriptor = openSync(temporary, openFlags);
    try {
      const retainedIdentity = fstatSync(retainedDescriptor, { bigint: true });
      expect(() => removeIdentifiedTemporary(temporary, retainedIdentity)).toThrow(
        /cleanup was withheld after an identity change/u
      );

      expect(fstatSync(replacementDescriptor, { bigint: true }).nlink).toBe(1n);
      expect(readDescriptor(replacementDescriptor, 24)).toBe("replacement must survive");
      expect(readDescriptor(retainedDescriptor, 15)).toBe("owned temporary");
    } finally {
      closeSync(replacementDescriptor);
      closeSync(retainedDescriptor);
    }
  });
});
