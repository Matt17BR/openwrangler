import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

rmSync(resolve("media"), { force: true, recursive: true });
await build({ mode: "production" });
await build({ mode: "notebook-renderer" });
