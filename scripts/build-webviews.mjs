import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

rmSync(resolve("media"), { force: true, recursive: true });
await build({ mode: "production" });
await build({ mode: "notebook-renderer" });

const sourceIcon = readFileSync(resolve("assets", "icon.png"));
const packagedIcon = readFileSync(resolve("media", "icon.png"));
if (!packagedIcon.equals(sourceIcon)) {
  throw new Error("The packaged gallery icon differs from the generated 512 pixel brand asset.");
}
