import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inspectVsixArchive, MAX_VSIX_BYTES } from "./vsix-archive.mjs";
import {
  inspectNotebookRendererBundle,
  inspectReadmeSourceSrcsets,
  inspectVsixPreReleaseMetadata
} from "./vsix-contents.mjs";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv[2];
if (!requested) {
  throw new Error("Pass the exact VSIX path to verify; implicit artifact selection is intentionally disabled.");
}
const vsix = resolve(root, requested);

if (!existsSync(vsix)) {
  throw new Error(`VSIX not found: ${requested}`);
}

const file = statSync(vsix);
if (!file.isFile() || file.size <= 0 || file.size > MAX_VSIX_BYTES) {
  throw new Error(`Invalid ${basename(vsix)}. VSIX must be a bounded regular file.`);
}
const payload = await inspectVsixArchive(readFileSync(vsix));
const {
  archiveEntries,
  packagedPackageJson,
  packagedReadme,
  vsixManifest,
  webviewCss,
  webviewPanel,
  notebookRenderer
} = payload;
const preReleaseProblems = inspectVsixPreReleaseMetadata(packagedPackageJson, vsixManifest);
if (preReleaseProblems.length > 0) {
  throw new Error(`Invalid ${basename(vsix)}. ${preReleaseProblems.join(" ")}`);
}

const bundleRelativeCodicon = /url\((?:["'])?\.\/codicon\.ttf(?:\?[^)"']*)?(?:["'])?\)/u;
const webviewFontPolicy = /font-src \$\{webview\.cspSource\};/u;
const readmeSourceProblems = inspectReadmeSourceSrcsets(packagedReadme);
const notebookRendererProblems = inspectNotebookRendererBundle(notebookRenderer);

if (!bundleRelativeCodicon.test(webviewCss)) {
  throw new Error(`Invalid ${basename(vsix)}. webview.css must load codicon.ttf from its own bundle directory.`);
}
if (!webviewFontPolicy.test(webviewPanel)) {
  throw new Error(`Invalid ${basename(vsix)}. The main webview CSP must allow its bundled font origin.`);
}
if (readmeSourceProblems.length > 0) {
  throw new Error(`Invalid ${basename(vsix)}. ${readmeSourceProblems.join(" ")}`);
}
if (notebookRendererProblems.length > 0) {
  throw new Error(`Invalid ${basename(vsix)}. ${notebookRendererProblems.join(" ")}`);
}

console.log(`Verified ${basename(vsix)} (${archiveEntries.length} archive entries).`);
