import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";
import {
  inspectNotebookRendererBundle,
  inspectPackagedReadmeSource,
  inspectReadmeSourceSrcsets,
  inspectVsixPreReleaseMetadata
} from "./vsix-contents.mjs";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv[2];
if (!requested) {
  throw new Error("Pass the exact VSIX path to verify; implicit artifact selection is intentionally disabled.");
}
const vsix = resolve(root, requested);
const snapshot = readBoundedVsixFileSnapshot(vsix);
const payload = await inspectVsixArchive(snapshot.bytes);
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
const sourceReadme = readFileSync(resolve(root, "README.md"), "utf8");
const readmeSourceProblems = [
  ...inspectPackagedReadmeSource(sourceReadme, packagedReadme),
  ...inspectReadmeSourceSrcsets(packagedReadme)
];
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
