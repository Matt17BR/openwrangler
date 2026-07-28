import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectPreviewReadme } from "./release-documents.mjs";
import { inspectPerformanceEvidenceSourceReadiness, inspectStableSourceReadiness } from "./release-readiness.mjs";
import { inspectReleaseWorkflow, inspectStableCandidateWorkflow } from "./release-workflow.mjs";
import { inspectStableReleaseWorkflow } from "./stable-release-workflow.mjs";
import { inspectMarketplacePromotionPipeline, inspectMarketplaceVsceLock } from "./marketplace-promotion-workflow.mjs";
import { inspectOpenVsxPromotionWorkflow } from "./open-vsx-promotion-workflow.mjs";

const root = resolve(import.meta.dirname, "..");
const required = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/architecture.md",
  "docs/feature-parity.md",
  "docs/reference.md",
  "docs/releasing.md",
  "docs/testing.md"
];

const missing = required.filter((file) => !existsSync(resolve(root, file)));
if (missing.length > 0) {
  throw new Error(`Missing required documentation: ${missing.join(", ")}`);
}

const packageJsonSource = readFileSync(resolve(root, "package.json"), "utf8");
const packageLockSource = readFileSync(resolve(root, "package-lock.json"), "utf8");
const packageJson = JSON.parse(packageJsonSource);
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const featureParity = readFileSync(resolve(root, "docs/feature-parity.md"), "utf8");
const trackedEvidencePaths = new Set(
  execFileSync("git", ["ls-files", "-z", "--"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
    .split("\0")
    .filter(Boolean)
);
const readmeProblems = packageJson.preview
  ? inspectPreviewReadme(readme)
  : (() => {
      const stableProblems = inspectStableSourceReadiness({
        featureParity,
        readme,
        trackedEvidencePaths
      });
      if (stableProblems.length === 0) {
        return [];
      }
      const evidenceProblems = inspectPerformanceEvidenceSourceReadiness({
        featureParity,
        readme,
        trackedEvidencePaths,
        version: packageJson.version
      });
      return evidenceProblems.length === 0
        ? []
        : [
            "Non-preview documentation must be either an all-green stable source or the exact two-row performance-evidence source.",
            ...stableProblems,
            ...evidenceProblems
          ];
    })();
if (readmeProblems.length > 0) {
  throw new Error(`README release/install region is stale:\n- ${readmeProblems.join("\n- ")}`);
}
const releaseWorkflowProblems = inspectReleaseWorkflow(
  readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8")
);
if (releaseWorkflowProblems.length > 0) {
  throw new Error(`Release workflow contract is stale:\n- ${releaseWorkflowProblems.join("\n- ")}`);
}
const stableCandidateWorkflowProblems = inspectStableCandidateWorkflow(
  readFileSync(resolve(root, ".github/workflows/stable-candidate.yml"), "utf8")
);
if (stableCandidateWorkflowProblems.length > 0) {
  throw new Error(`Stable candidate workflow contract is stale:\n- ${stableCandidateWorkflowProblems.join("\n- ")}`);
}
const stableReleaseWorkflowProblems = inspectStableReleaseWorkflow(
  readFileSync(resolve(root, ".github/workflows/stable-release.yml"), "utf8")
);
if (stableReleaseWorkflowProblems.length > 0) {
  throw new Error(`Stable release workflow contract is stale:\n- ${stableReleaseWorkflowProblems.join("\n- ")}`);
}
const marketplacePromotionProblems = inspectMarketplacePromotionPipeline(
  readFileSync(resolve(root, "azure-pipelines-marketplace.yml"), "utf8")
);
if (marketplacePromotionProblems.length > 0) {
  throw new Error(`Marketplace promotion pipeline contract is stale:\n- ${marketplacePromotionProblems.join("\n- ")}`);
}
const marketplaceVsceLockProblems = inspectMarketplaceVsceLock({
  packageJson: packageJsonSource,
  packageLock: packageLockSource
});
if (marketplaceVsceLockProblems.length > 0) {
  throw new Error(`Marketplace VSCE dependency lock is stale:\n- ${marketplaceVsceLockProblems.join("\n- ")}`);
}
const openVsxPromotionProblems = inspectOpenVsxPromotionWorkflow(
  readFileSync(resolve(root, ".github/workflows/open-vsx-promotion.yml"), "utf8")
);
if (openVsxPromotionProblems.length > 0) {
  throw new Error(`Open VSX promotion workflow contract is stale:\n- ${openVsxPromotionProblems.join("\n- ")}`);
}
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${packageJson.version}]`)) {
  throw new Error(`CHANGELOG.md does not contain an entry for ${packageJson.version}`);
}

const runtimeVersionSource = readFileSync(resolve(root, "python/openwrangler_runtime/version.py"), "utf8");
const runtimeVersion = runtimeVersionSource.match(/^__version__ = "([^"]+)"$/m)?.[1];
const expectedRuntimeVersion = packageJson.version
  .replace(/-alpha\.(\d+)$/, "a$1")
  .replace(/-beta\.(\d+)$/, "b$1")
  .replace(/-rc\.(\d+)$/, "rc$1");
if (runtimeVersion !== expectedRuntimeVersion) {
  throw new Error(
    `Python runtime version ${runtimeVersion ?? "is missing"}; expected ${expectedRuntimeVersion} from package.json`
  );
}

const notebookOutputSource = readFileSync(resolve(root, "src/shared/notebookOutput.ts"), "utf8");
const notebookRuntimeSource = readFileSync(resolve(root, "python/openwrangler_runtime/notebook.py"), "utf8");
for (const [typescriptName, pythonName] of [
  ["rows", "MAX_SAVED_ROWS"],
  ["columns", "MAX_SAVED_COLUMNS"],
  ["cells", "MAX_SAVED_CELLS"],
  ["bytes", "MAX_SAVED_PAYLOAD_BYTES"],
  ["labelCharacters", "MAX_SAVED_LABEL_CHARACTERS"],
  ["columnCharacters", "MAX_SAVED_COLUMN_CHARACTERS"],
  ["cellCharacters", "MAX_SAVED_CELL_CHARACTERS"]
]) {
  const typescriptValue = notebookOutputSource.match(new RegExp(`\\b${typescriptName}:\\s*([\\d_]+)`))?.[1];
  const pythonValue = notebookRuntimeSource.match(new RegExp(`^${pythonName}\\s*=\\s*([\\d_]+)$`, "m"))?.[1];
  if (
    !typescriptValue ||
    !pythonValue ||
    Number(typescriptValue.replaceAll("_", "")) !== Number(pythonValue.replaceAll("_", ""))
  ) {
    throw new Error(`Notebook output limit ${typescriptName}/${pythonName} differs between TypeScript and Python.`);
  }
}
for (const limitName of ["MAX_SAVED_PAYLOAD_NODES", "MAX_SAVED_PAYLOAD_DEPTH"]) {
  const typescriptValue = notebookOutputSource.match(new RegExp(`^const ${limitName}\\s*=\\s*([\\d_]+)`, "m"))?.[1];
  const pythonValue = notebookRuntimeSource.match(new RegExp(`^${limitName}\\s*=\\s*([\\d_]+)$`, "m"))?.[1];
  if (
    !typescriptValue ||
    !pythonValue ||
    Number(typescriptValue.replaceAll("_", "")) !== Number(pythonValue.replaceAll("_", ""))
  ) {
    throw new Error(`Notebook output structural limit ${limitName} differs between TypeScript and Python.`);
  }
}

const agentGuide = readFileSync(resolve(root, "AGENTS.md"), "utf8");
for (const file of required.filter((file) => file.startsWith("docs/"))) {
  if (!agentGuide.includes(file)) {
    throw new Error(`AGENTS.md must route agents to ${file}`);
  }
}
