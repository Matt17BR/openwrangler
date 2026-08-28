import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { build, context } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");
const extensionOutputRoot = resolve(repositoryRoot, "dist", "extension");
const sharedOutputRoot = resolve(repositoryRoot, "dist", "shared");
const watch = process.argv[2] === "--watch";

if ((!watch && process.argv.length !== 2) || (watch && process.argv.length !== 3)) {
  throw new Error("build-extension accepts only an optional --watch argument.");
}

const options = {
  absWorkingDir: repositoryRoot,
  bundle: true,
  entryPoints: ["src/extension/activate.ts"],
  external: ["vscode", "./vendor/js-yaml"],
  format: "cjs",
  logLevel: "warning",
  outfile: "dist/extension/activate.js",
  platform: "node",
  sourcemap: true,
  target: "node22",
  tsconfig: "tsconfig.extension.json"
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log("Watching the extension-host bundle.");
} else {
  rmSync(extensionOutputRoot, { force: true, recursive: true });
  rmSync(sharedOutputRoot, { force: true, recursive: true });
  await build(options);
}
