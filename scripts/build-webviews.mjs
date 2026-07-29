import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

rmSync(resolve("media"), { force: true, recursive: true });
await build({ mode: "production" });
await build({ mode: "notebook-renderer" });

const packagedBrandAssets = ["activity-icon.svg", "icon.svg", "icon-128.png", "icon-256.png", "icon.png"];
for (const asset of packagedBrandAssets) {
  const source = readFileSync(resolve("assets", asset));
  const packaged = readFileSync(resolve("media", asset));
  if (!packaged.equals(source)) {
    throw new Error(`The packaged ${asset} differs from its canonical brand asset.`);
  }
}
