import { lstatSync, rmSync, type BigIntStats } from "node:fs";

function sameOwnedRegularFile(actual: BigIntStats, expected: BigIntStats): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.nlink === 1n &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

export function removeIdentifiedTemporary(file: string, expected: BigIntStats): boolean {
  try {
    const current = lstatSync(file, { bigint: true });
    if (!sameOwnedRegularFile(current, expected)) {
      throw new Error("Owned fragment temporary cleanup was withheld after an identity change.");
    }
    rmSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
