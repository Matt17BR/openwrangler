import { rmdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

for (const directory of [
  "dist",
  "dist-test",
  "media",
  "python/build",
  "tmp/screenshots",
  "tmp/screenshots-actual",
  "tmp/screenshots-diff"
]) {
  rmSync(resolve(root, directory), { force: true, recursive: true });
}

try {
  rmdirSync(resolve(root, "tmp"));
} catch (error) {
  if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
}
