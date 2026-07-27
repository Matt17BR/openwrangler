import { lstatSync, unlinkSync, type BigIntStats } from "node:fs";

interface IdentifiedFileRemovalOptions {
  allowedLinkCounts?: readonly bigint[];
  description?: string;
}

function sameOwnedRegularFile(
  actual: BigIntStats,
  expected: BigIntStats,
  allowedLinkCounts: readonly bigint[]
): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    allowedLinkCounts.includes(actual.nlink) &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

export function removeIdentifiedFile(
  file: string,
  expected: BigIntStats,
  { allowedLinkCounts = [1n], description = "file" }: IdentifiedFileRemovalOptions = {}
): boolean {
  try {
    const current = lstatSync(file, { bigint: true });
    if (!sameOwnedRegularFile(current, expected, allowedLinkCounts)) {
      throw new Error(`Owned fragment ${description} cleanup was withheld after an identity change.`);
    }
    unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function removeIdentifiedTemporary(file: string, expected: BigIntStats): boolean {
  return removeIdentifiedFile(file, expected, { description: "temporary" });
}
