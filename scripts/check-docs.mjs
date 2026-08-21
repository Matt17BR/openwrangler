import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectDataWranglerComparisonReview } from "./data-wrangler-comparison-report.mjs";
import { inspectCandidateAcceptanceWorkflow } from "./candidate-acceptance-workflow.mjs";
import { inspectCompatibilityEvidence } from "./compatibility-evidence.mjs";
import { inspectStablePublicCopy } from "./release-documents.mjs";
import {
  inspectPerformanceSummary,
  inspectReleaseDocumentationSource,
  performanceReportLink
} from "./release-readiness.mjs";
import { inspectReleaseCandidateWorkflow, inspectStableReleaseWorkflow } from "./stable-release-workflow.mjs";
import { inspectMarketplacePromotionPipeline, inspectMarketplaceVsceLock } from "./marketplace-promotion-workflow.mjs";
import { inspectOpenVsxPromotionWorkflow } from "./open-vsx-promotion-workflow.mjs";
import { inspectPublicWriting } from "./public-writing.mjs";
import { inspectPublicRepositoryMetadata } from "./public-repository-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const root = resolve(import.meta.dirname, "..");
const required = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  ".github/repository-metadata.json",
  "docs/architecture.md",
  "docs/feature-parity.md",
  "docs/product-roadmap.md",
  "docs/reference.md",
  "docs/releasing.md",
  "docs/testing.md",
  "docs/writing-style.md"
];

const missing = required.filter((file) => !existsSync(resolve(root, file)));
if (missing.length > 0) {
  throw new Error(`Missing required documentation: ${missing.join(", ")}`);
}

const packageJsonSource = readFileSync(resolve(root, "package.json"), "utf8");
const packageLockSource = readFileSync(resolve(root, "package-lock.json"), "utf8");
const packageJson = parseStrictJson(packageJsonSource, { maxBytes: 1024 * 1024 });
if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
  throw new Error("package.json must contain one bounded JSON object.");
}
const repositoryMetadataProblems = inspectPublicRepositoryMetadata({
  contractSource: readFileSync(resolve(root, ".github/repository-metadata.json"), "utf8"),
  packageSource: packageJsonSource
});
if (repositoryMetadataProblems.length > 0) {
  throw new Error(`Public repository metadata is stale:\n- ${repositoryMetadataProblems.join("\n- ")}`);
}
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const mediaGallery = readFileSync(resolve(root, "docs/media-gallery.md"), "utf8");
const featureParity = readFileSync(resolve(root, "docs/feature-parity.md"), "utf8");
const publicWritingProblems = inspectPublicWriting({
  agentGuide: readFileSync(resolve(root, "AGENTS.md"), "utf8"),
  contributing: readFileSync(resolve(root, "CONTRIBUTING.md"), "utf8"),
  pullRequestTemplate: readFileSync(resolve(root, ".github/pull_request_template.md"), "utf8"),
  styleGuide: readFileSync(resolve(root, "docs/writing-style.md"), "utf8")
});
if (publicWritingProblems.length > 0) {
  throw new Error(`Public writing guidance is disconnected:\n- ${publicWritingProblems.join("\n- ")}`);
}
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
const readmeProblems = inspectReleaseDocumentationSource({
  featureParity,
  preview: packageJson.preview,
  readme,
  trackedEvidencePaths,
  version: packageJson.version
});
if (readmeProblems.length > 0) {
  throw new Error(`Release documentation is stale:\n- ${readmeProblems.join("\n- ")}`);
}
const linkedComparison = performanceReportLink(readme);
const performanceSummaryProblems = inspectPerformanceSummary(readme);
if (performanceSummaryProblems.length > 0) {
  throw new Error(`README performance summary is stale:\n- ${performanceSummaryProblems.join("\n- ")}`);
}
const packageMajor = /^(?<major>0|[1-9]\d*)\./u.exec(packageJson.version ?? "")?.groups?.major;
const requiresVersionedComparison =
  packageJson.preview === false && packageMajor !== undefined && BigInt(packageMajor) >= 2n;
if (requiresVersionedComparison && linkedComparison === undefined) {
  throw new Error("Stable version 2 documentation must link its versioned Data Wrangler comparison.");
}
if (linkedComparison !== undefined) {
  const reviewPath = resolve(root, linkedComparison.path);
  const reportPath = join(dirname(reviewPath), "report.json");
  if (!existsSync(reportPath)) {
    if (requiresVersionedComparison) {
      throw new Error(
        `Stable version 2 documentation is missing ${join(dirname(linkedComparison.path), "report.json")}.`
      );
    }
  } else {
    const report = parseStrictJson(readFileSync(reportPath, "utf8"));
    if (report?.provenance?.openWrangler?.version !== linkedComparison.version) {
      throw new Error(
        `Data Wrangler comparison report version ${String(report?.provenance?.openWrangler?.version)} does not match its ${linkedComparison.version} directory.`
      );
    }
    const comparisonProblems = inspectDataWranglerComparisonReview(readFileSync(reviewPath, "utf8"), report);
    if (comparisonProblems.length > 0) {
      throw new Error(`Data Wrangler comparison review is stale:\n- ${comparisonProblems.join("\n- ")}`);
    }
  }
}
if (!packageJson.preview) {
  const galleryProblems = inspectStablePublicCopy(mediaGallery, "docs/media-gallery.md");
  if (galleryProblems.length > 0) {
    throw new Error(`Public gallery copy is stale:\n- ${galleryProblems.join("\n- ")}`);
  }
}
const releaseCandidateWorkflowProblems = inspectReleaseCandidateWorkflow(
  readFileSync(resolve(root, ".github/workflows/release-candidate.yml"), "utf8")
);
if (releaseCandidateWorkflowProblems.length > 0) {
  throw new Error(`Release-candidate workflow contract is stale:\n- ${releaseCandidateWorkflowProblems.join("\n- ")}`);
}
const stableReleaseWorkflowProblems = inspectStableReleaseWorkflow(
  readFileSync(resolve(root, ".github/workflows/stable-release.yml"), "utf8")
);
if (stableReleaseWorkflowProblems.length > 0) {
  throw new Error(`Stable release workflow contract is stale:\n- ${stableReleaseWorkflowProblems.join("\n- ")}`);
}
const candidateAcceptanceProblems = inspectCandidateAcceptanceWorkflow(
  readFileSync(resolve(root, ".github/workflows/candidate-acceptance.yml"), "utf8")
);
if (candidateAcceptanceProblems.length > 0) {
  throw new Error(`Candidate acceptance workflow contract is stale:\n- ${candidateAcceptanceProblems.join("\n- ")}`);
}
const compatibilityEvidenceProblems = inspectCompatibilityEvidence({
  authoritySource: readFileSync(resolve(root, "fixtures/compatibility-evidence.json"), "utf8"),
  packageSource: packageJsonSource,
  remoteWorkspaceContractSource: readFileSync(resolve(root, "scripts/remote-workspace-contract.mjs"), "utf8"),
  cursorAcquisitionSource: readFileSync(resolve(root, "scripts/cursor-acquisition.mjs"), "utf8"),
  candidateWorkflowSource: readFileSync(resolve(root, ".github/workflows/candidate-acceptance.yml"), "utf8"),
  ciWorkflowSource: readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"),
  readmeSource: readme,
  releasingSource: readFileSync(resolve(root, "docs/releasing.md"), "utf8"),
  architectureSource: readFileSync(resolve(root, "docs/architecture.md"), "utf8"),
  featureParitySource: featureParity
});
if (compatibilityEvidenceProblems.length > 0) {
  throw new Error(`Compatibility evidence is stale:\n- ${compatibilityEvidenceProblems.join("\n- ")}`);
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
