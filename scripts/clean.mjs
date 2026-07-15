import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

for (const directory of ["dist", "dist-test", "media"]) {
  rmSync(resolve(root, directory), { force: true, recursive: true });
}
