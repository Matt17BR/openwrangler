import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVSIX } from "@vscode/vsce";
import {
  assertJupyterExtensionAcceptanceVsixSnapshot,
  configureEditorAcceptanceTempRoot,
  collectEditorAcceptancePrivateDiagnosticPaths,
  createEditorAcceptanceEnvironment,
  createEditorAcceptanceFailure,
  createAcceptanceProgressEnvelope,
  downloadEditorWithRetry,
  editorDisplayLaunchArgs,
  editorAcceptanceProgressPath,
  editorProcessTreeMayBeLive,
  PINNED_DATA_WRANGLER_EXTENSION_ID,
  PINNED_JUPYTER_EXTENSION_ID,
  PINNED_PYTHON_EXTENSION_ID,
  resolveDownloadedEditorCliPath,
  resolveDataWranglerExtensionAcceptanceInstallTarget,
  resolveJupyterExtensionAcceptanceInstallTarget,
  resolvePythonExtensionAcceptanceInstallTarget,
  runBoundedEditorCommand,
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase,
  stageJupyterExtensionAcceptanceVsix,
  startIsolatedEditorDisplay,
  validateJupyterExtensionAcceptanceVsix,
  validateEditorAcceptancePrivatePathOverrides,
  writeEditorAcceptanceHarness,
  writeAcceptanceProgress,
  writeEditorSettings,
  writeFakeJupyterExtension
} from "./editor-acceptance.mjs";
import { retainEditorAcceptanceEvidence } from "./editor-acceptance-evidence.mjs";
import {
  assertSealedEditorAcceptanceArtifact,
  assertEditorAcceptanceEvidenceStagingRoot,
  captureEditorAcceptanceEvidenceReceipt,
  createEditorAcceptanceArtifactParent,
  createEditorAcceptanceEvidenceStagingRoot,
  removeEditorAcceptanceArtifactParent,
  sealEditorAcceptanceEvidence
} from "./editor-acceptance-artifact.mjs";
import {
  assertEditorAcceptancePrivateRootReceipt,
  cleanupPackagedCursorAcquisition,
  createEditorAcceptancePrivatePathIdentityLatch,
  createEditorAcceptancePrivatePathSafetyPolicy,
  createEditorAcceptancePrivateRootReceipt,
  packagedEditorFailureLeaves,
  retainPackagedEditorFailureLeaves,
  removeEditorAcceptancePrivateRoot,
  runPackagedEditorOrchestration,
  runWithRetainedFailure
} from "./packaged-editor-orchestration.mjs";
import {
  acceptancePythonForPhase,
  appendJupyterAcceptanceRKernelBootstrapStage,
  createRemoteJupyterAcceptanceToken,
  createJupyterAcceptanceKernelPython,
  jupyterAcceptanceRKernelBootstrapStage,
  prepareJupyterAcceptanceREnvironment,
  probeJupyterAcceptanceRKernel,
  writeJupyterAcceptanceEnvironment,
  writeRemoteJupyterAcceptanceDescriptor,
  writeRemoteJupyterAcceptanceEnvironment
} from "./jupyter-acceptance-environment.mjs";
import { acquirePinnedCursor } from "./cursor-acquisition.mjs";
import { preflightPackagedEditorPython } from "./packaged-python-preflight.mjs";
import { prepareREditorAcceptanceTooling, R_EDITOR_ACCEPTANCE_TOOLING } from "./r-editor-acceptance-tooling.mjs";
import {
  REAL_REMOTE_JUPYTER_ENV,
  remoteJupyterAcceptanceEnabled,
  remoteJupyterHostnameForRun,
  remoteJupyterOwnershipMayBeLive,
  runRemoteJupyterAcceptanceLifecycle,
  startRemoteJupyterAcceptanceFixture
} from "./remote-jupyter-acceptance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localEvidenceArtifactBase = resolve(root, "tmp", "editor-acceptance-artifacts");
const orchestrationEditor = {
  name: "Packaged editor orchestration",
  key: "orchestration",
  version: "unknown"
};
let hostHomes = [];
let evidenceStagingReceipt;
let evidencePrivateRootReceipt;
let evidenceRoot;
let temporaryRoot;
let temporaryRootReceipt;
let temporaryRootCleaned = false;
let orchestrationProfile;
let orchestrationProfileReceipt;
let orchestrationResultPath;
let orchestrationResultPaths;
let orchestrationProgressPath;
let orchestrationProgressPaths;
let orchestrationRunId;
let orchestrationStartedAt = Date.now();
const MAX_FAILURE_SUMMARY_BYTES = 8 * 1024;
const OVERSIZED_DIAGNOSTIC_MARKER = "<diagnostic-omitted-size-budget>";
const EXPECTED_ACCEPTANCE_HARNESS = "openwrangler-tests.openwrangler-packaged-test-harness@0.0.0";
const retainedFailures = new Set();
const cleanupFailures = new Set();
const completedEditorNames = [];
const evidenceReceipts = [];
let orchestrationEvidenceAttempt = 0;
let orchestrationTreeMayBeLive = false;
let evidenceCollectionSafe = true;
const privatePathIdentityLatch = createEditorAcceptancePrivatePathIdentityLatch();
const privatePathsVerified = () => privatePathIdentityLatch.isVerified();
const privatePathSafetyPolicy = createEditorAcceptancePrivatePathSafetyPolicy({
  identityLatch: privatePathIdentityLatch,
  processTreeMayBeLive: () => orchestrationTreeMayBeLive
});
const reportedWithheldCategories = new Set();
let editorDisplay;
let cursorAcquisition;
let rEditorTooling;

try {
  hostHomes = collectEditorAcceptancePrivateDiagnosticPaths([
    resolve(root, process.argv[2] ?? "openwrangler.vsix"),
    process.env.OPEN_WRANGLER_PYTHON_EXTENSION_VSIX,
    process.env.OPEN_WRANGLER_JUPYTER_EXTENSION_VSIX,
    process.env.OPEN_WRANGLER_R_SYNTAX_EXTENSION_VSIX,
    process.env.OPEN_WRANGLER_R_EXTENSION_VSIX,
    process.env.OPEN_WRANGLER_QUARTO_EXTENSION_VSIX,
    process.env.OPEN_WRANGLER_QUARTO_CLI_ARCHIVE,
    process.env.OPEN_WRANGLER_TEST_RSCRIPT
  ]);
  evidenceStagingReceipt = createEditorAcceptanceEvidenceStagingRoot(resolve(root, "tmp", "editor-acceptance-staging"));
  evidenceRoot = evidenceStagingReceipt.root;
  evidencePrivateRootReceipt = capturePrivateRootReceipt(evidenceRoot, dirname(evidenceRoot), {
    scope: "evidence-staging",
    editor: "orchestration"
  });
  const temporaryParent = resolve(root, "tmp", "ow");
  mkdirSync(temporaryParent, { recursive: true, mode: 0o700 });
  temporaryRoot = mkdtempSync(join(temporaryParent, "x-"));
  temporaryRootReceipt = capturePrivateRootReceipt(temporaryRoot, temporaryParent, {
    scope: "temporary-root",
    editor: "orchestration"
  });
  configureEditorAcceptanceTempRoot(temporaryRoot);
  orchestrationProfile = resolve(temporaryRoot, "orchestration");
  mkdirSync(orchestrationProfile, { recursive: true, mode: 0o700 });
  orchestrationProfileReceipt = capturePrivateRootReceipt(orchestrationProfile, temporaryRoot, {
    scope: "orchestration-profile",
    editor: "orchestration"
  });
  orchestrationResultPath = resolve(orchestrationProfile, "setup-result.json");
  orchestrationResultPaths = { setup: orchestrationResultPath };
  orchestrationRunId = randomUUID();
  orchestrationProgressPath = editorAcceptanceProgressPath(orchestrationResultPath, orchestrationRunId, "setup");
  orchestrationProgressPaths = { setup: orchestrationProgressPath };
  orchestrationStartedAt = Date.now();
  await runPackagedEditorOrchestration(
    {
      evidenceRoot,
      run: async () => {
        let runError;
        try {
          writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:validate-package");
          validateEditorAcceptancePrivatePathOverrides();
          const vsix = resolve(root, process.argv[2] ?? "openwrangler.vsix");
          if (!existsSync(vsix)) throw new Error("The packaged extension was not found.");
          const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
          const expectedExtension = `${packageJson.publisher}.${packageJson.name}@${packageJson.version}`.toLowerCase();
          const pythonExtensionInstallTarget = resolvePythonExtensionAcceptanceInstallTarget();
          let jupyterExtensionInstallTarget = resolveJupyterExtensionAcceptanceInstallTarget();
          const dataWranglerExtensionInstallTarget = resolveDataWranglerExtensionAcceptanceInstallTarget();
          const remoteJupyterEnabled = remoteJupyterAcceptanceEnabled(process.env);
          if (remoteJupyterEnabled && process.platform !== "linux") {
            throw new Error("Real remote-Jupyter acceptance is supported only on Linux.");
          }
          if (remoteJupyterEnabled && !jupyterExtensionInstallTarget) {
            throw new Error(
              `Real remote-Jupyter acceptance requires the released Jupyter extension; enable it together with ${REAL_REMOTE_JUPYTER_ENV}=1.`
            );
          }
          if (dataWranglerExtensionInstallTarget && !jupyterExtensionInstallTarget) {
            throw new Error(
              "Real Data Wrangler coexistence acceptance requires the released Jupyter extension; enable both opt-in gates."
            );
          }
          let jupyterExtensionSnapshot;
          if (jupyterExtensionInstallTarget && isAbsolute(jupyterExtensionInstallTarget)) {
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              "setup:validate-jupyter-vsix"
            );
            jupyterExtensionSnapshot = stageJupyterExtensionAcceptanceVsix(
              jupyterExtensionInstallTarget,
              resolve(orchestrationProfile, "released-jupyter.vsix")
            );
            jupyterExtensionInstallTarget = assertJupyterExtensionAcceptanceVsixSnapshot(jupyterExtensionSnapshot);
            await validateJupyterExtensionAcceptanceVsix(jupyterExtensionInstallTarget);
          }

          writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:resolve-editors");
          const requested = process.env.OPEN_WRANGLER_PACKAGED_EDITORS?.split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          const acceptanceMode = process.env.OPEN_WRANGLER_PACKAGED_MODE ?? "full";
          const rJourneySelector = process.env.OPEN_WRANGLER_PACKAGED_R_JOURNEY;
          if (
            acceptanceMode !== "full" &&
            acceptanceMode !== "platform-smoke" &&
            acceptanceMode !== "data-wrangler-coexistence" &&
            acceptanceMode !== "r-jupyter"
          ) {
            throw new Error(
              'OPEN_WRANGLER_PACKAGED_MODE must be "full", "platform-smoke", "data-wrangler-coexistence", or "r-jupyter".'
            );
          }
          if (
            (acceptanceMode === "platform-smoke" || acceptanceMode === "data-wrangler-coexistence") &&
            (requested?.length !== 1 || !["vscode", "cursor"].includes(requested[0]))
          ) {
            throw new Error(
              `OPEN_WRANGLER_PACKAGED_MODE=${JSON.stringify(acceptanceMode)} requires exactly one supported editor in OPEN_WRANGLER_PACKAGED_EDITORS.`
            );
          }
          if (rJourneySelector !== undefined && rJourneySelector !== "interactive-terminal") {
            throw new Error('OPEN_WRANGLER_PACKAGED_R_JOURNEY must be unset or "interactive-terminal".');
          }
          if (rJourneySelector !== undefined && acceptanceMode !== "r-jupyter") {
            throw new Error(
              'OPEN_WRANGLER_PACKAGED_R_JOURNEY="interactive-terminal" requires OPEN_WRANGLER_PACKAGED_MODE="r-jupyter".'
            );
          }
          if (rJourneySelector !== undefined && remoteJupyterEnabled) {
            throw new Error(
              'OPEN_WRANGLER_PACKAGED_R_JOURNEY="interactive-terminal" cannot be combined with remote Jupyter acceptance.'
            );
          }
          if (
            acceptanceMode === "data-wrangler-coexistence" &&
            (requested?.[0] !== "vscode" || !dataWranglerExtensionInstallTarget || !jupyterExtensionInstallTarget)
          ) {
            throw new Error(
              'OPEN_WRANGLER_PACKAGED_MODE="data-wrangler-coexistence" requires VS Code plus both real Jupyter and real Data Wrangler opt-ins.'
            );
          }
          const rscript = process.env.OPEN_WRANGLER_TEST_RSCRIPT;
          if (acceptanceMode === "r-jupyter") {
            if (
              !requested?.length ||
              requested.length > 2 ||
              new Set(requested).size !== requested.length ||
              requested.some((key) => !["vscode", "cursor"].includes(key))
            ) {
              throw new Error(
                'OPEN_WRANGLER_PACKAGED_MODE="r-jupyter" requires an explicit, duplicate-free VS Code/Cursor list in OPEN_WRANGLER_PACKAGED_EDITORS.'
              );
            }
            if (!jupyterExtensionInstallTarget) {
              throw new Error(
                'OPEN_WRANGLER_PACKAGED_MODE="r-jupyter" requires the released Jupyter extension opt-in.'
              );
            }
            if (dataWranglerExtensionInstallTarget) {
              throw new Error(
                'OPEN_WRANGLER_PACKAGED_MODE="r-jupyter" cannot be combined with the Data Wrangler coexistence opt-in.'
              );
            }
            if (remoteJupyterEnabled && !requested.includes("vscode")) {
              throw new Error(
                "Remote R acceptance requires VS Code in OPEN_WRANGLER_PACKAGED_EDITORS; local R acceptance may also include Cursor."
              );
            }
            if (typeof rscript !== "string" || !isAbsolute(rscript) || !existsSync(rscript)) {
              throw new Error(
                'OPEN_WRANGLER_PACKAGED_MODE="r-jupyter" requires OPEN_WRANGLER_TEST_RSCRIPT to name an existing absolute Rscript executable.'
              );
            }
          }
          const supportedEditorKeys = new Set(["vscode", "cursor"]);
          const unknownRequested = requested?.filter((key) => !supportedEditorKeys.has(key)) ?? [];
          if (unknownRequested.length) {
            throw new Error(
              'The packaged editor selection contains an unsupported value; allowed values are "vscode" and "cursor".'
            );
          }
          let candidates = [
            {
              name: "VS Code",
              key: "vscode",
              executable: process.env.OPEN_WRANGLER_VSCODE_EXECUTABLE ?? "/usr/share/code/code",
              cli: process.env.OPEN_WRANGLER_VSCODE_CLI ?? "/usr/share/code/bin/code",
              sharedDataDir: true
            },
            {
              name: "Cursor",
              key: "cursor",
              executable: process.env.OPEN_WRANGLER_CURSOR_EXECUTABLE ?? "/usr/share/cursor/cursor",
              cli: process.env.OPEN_WRANGLER_CURSOR_CLI ?? "/usr/share/cursor/bin/cursor",
              sharedDataDir: false
            }
          ].filter(
            (editor) =>
              existsSync(editor.executable) &&
              existsSync(editor.cli) &&
              (!requested?.length || requested.includes(editor.key))
          );
          if (
            !candidates.some((editor) => editor.key === "vscode") &&
            (!requested?.length || requested.includes("vscode"))
          ) {
            writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:download-vscode");
            const executable = await downloadEditorWithRetry(process.env.VSCODE_TEST_VERSION ?? "stable");
            const downloadedCli = resolveDownloadedEditorCliPath(executable);
            if (!existsSync(downloadedCli)) {
              throw new Error("The downloaded VS Code CLI was not found.");
            }
            candidates.unshift({
              name: "VS Code",
              key: "vscode",
              executable,
              cli: downloadedCli,
              sharedDataDir: true
            });
          }
          if (
            requested?.includes("cursor") &&
            (acceptanceMode === "platform-smoke" || !candidates.some((editor) => editor.key === "cursor"))
          ) {
            writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:acquire-cursor");
            cursorAcquisition = await acquirePinnedCursor(temporaryRoot);
            candidates = candidates.filter((editor) => editor.key !== "cursor");
            candidates.push(cursorAcquisition.editor);
          }
          if (!candidates.length) throw new Error("No supported VS Code or Cursor desktop executable was found.");
          const missingRequested = requested?.filter((key) => !candidates.some((editor) => editor.key === key)) ?? [];
          if (missingRequested.length) {
            throw new Error(
              `Requested packaged editor(s) were not found: ${missingRequested.join(", ")}. Configure the corresponding OPEN_WRANGLER_*_EXECUTABLE and OPEN_WRANGLER_*_CLI paths.`
            );
          }
          const jupyterMarketplaceInstaller =
            jupyterExtensionInstallTarget && !isAbsolute(jupyterExtensionInstallTarget)
              ? candidates.find((editor) => editor.key === "vscode")
              : undefined;
          if (
            jupyterExtensionInstallTarget &&
            !isAbsolute(jupyterExtensionInstallTarget) &&
            !jupyterMarketplaceInstaller
          ) {
            throw new Error(
              "Real Jupyter-extension acceptance needs VS Code to install the pinned Marketplace package, or an absolute OPEN_WRANGLER_JUPYTER_EXTENSION_VSIX override for a Cursor-only run."
            );
          }
          if (dataWranglerExtensionInstallTarget && !jupyterMarketplaceInstaller) {
            throw new Error(
              "Real Data Wrangler coexistence acceptance needs VS Code to install the exact pinned Marketplace package."
            );
          }

          writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:resolve-python");
          const hostedPython = process.env.pythonLocation
            ? process.platform === "win32"
              ? resolve(process.env.pythonLocation, "python.exe")
              : resolve(process.env.pythonLocation, "bin", "python")
            : undefined;
          const localPython =
            process.platform === "win32"
              ? resolve(root, ".venv", "Scripts", "python.exe")
              : resolve(root, ".venv", "bin", "python");
          const testPython =
            process.env.OPEN_WRANGLER_TEST_PYTHON ??
            (hostedPython && existsSync(hostedPython)
              ? hostedPython
              : existsSync(localPython)
                ? localPython
                : process.platform === "win32"
                  ? "python"
                  : "python3");
          process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
          if (jupyterExtensionInstallTarget && (!isAbsolute(testPython) || !existsSync(testPython))) {
            throw new Error(
              "Real Jupyter-extension acceptance requires OPEN_WRANGLER_TEST_PYTHON to resolve to an existing absolute interpreter with jupyter_client."
            );
          }
          if (acceptanceMode !== "data-wrangler-coexistence" && acceptanceMode !== "r-jupyter") {
            writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:preflight-python");
            preflightPackagedEditorPython(testPython);
          }
          let jupyterKernelPython;
          let rAcceptanceEnvironment;
          if (acceptanceMode === "r-jupyter") {
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              "setup:prepare-r-jupyter-environment"
            );
            rAcceptanceEnvironment = await prepareJupyterAcceptanceREnvironment(resolve(temporaryRoot, "rv"), rscript, {
              containedBy: temporaryRoot
            });
            let dependencyProbeResult;
            try {
              dependencyProbeResult = await runBoundedEditorCommand(
                rAcceptanceEnvironment.dependencyProbe.input,
                rAcceptanceEnvironment.dependencyProbe.options
              );
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !/Released-Jupyter private R dependency probe exited with code 10 and signal none/u.test(error.message)
              ) {
                throw error;
              }
              await runBoundedEditorCommand(
                rAcceptanceEnvironment.dependencyInstall.input,
                rAcceptanceEnvironment.dependencyInstall.options
              );
              dependencyProbeResult = await runBoundedEditorCommand(
                rAcceptanceEnvironment.dependencyProbe.input,
                rAcceptanceEnvironment.dependencyProbe.options
              );
            }
            if (dependencyProbeResult.stdout !== rAcceptanceEnvironment.packageRecord) {
              throw new Error("Released-Jupyter R acceptance did not resolve the reviewed package versions.");
            }
            process.stdout.write(`Hosted R packages: ${rAcceptanceEnvironment.packageRecord.replaceAll("\n", ", ")}\n`);
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              "setup:probe-r-kernel-readiness"
            );
            await probeJupyterAcceptanceRKernel(testPython, rAcceptanceEnvironment);
            if (process.platform === "linux" && process.arch === "x64") {
              writeCorrelatedProgress(
                orchestrationProgressPath,
                orchestrationRunId,
                "setup",
                "setup:prepare-r-editor-tooling"
              );
              rEditorTooling = await prepareREditorAcceptanceTooling(temporaryRoot, {
                artifactPaths: {
                  rSyntax: process.env.OPEN_WRANGLER_R_SYNTAX_EXTENSION_VSIX,
                  r: process.env.OPEN_WRANGLER_R_EXTENSION_VSIX,
                  quartoExtension: process.env.OPEN_WRANGLER_QUARTO_EXTENSION_VSIX,
                  quartoCli: process.env.OPEN_WRANGLER_QUARTO_CLI_ARCHIVE
                }
              });
            }
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              "setup:r-jupyter-environment-ready"
            );
          } else if (jupyterExtensionInstallTarget) {
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              "setup:create-jupyter-kernel-environment"
            );
            try {
              jupyterKernelPython = await createJupyterAcceptanceKernelPython(
                resolve(temporaryRoot, "jv"),
                testPython,
                { containedBy: temporaryRoot }
              );
            } catch (error) {
              latchPrivateRootIdentityLoss(error, {
                scope: "jupyter-kernel",
                editor: "orchestration"
              });
              throw error;
            }
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              "setup:jupyter-kernel-environment-ready"
            );
          }

          writeCorrelatedProgress(
            orchestrationProgressPath,
            orchestrationRunId,
            "setup",
            "setup:start-isolated-display"
          );
          editorDisplay = await startIsolatedEditorDisplay();
          writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:display-ready");

          for (const editor of candidates) {
            const dataWranglerCoexistenceEnabled =
              dataWranglerExtensionInstallTarget !== undefined && editor.key === "vscode";
            const remoteRJupyterEnabled =
              acceptanceMode === "r-jupyter" && remoteJupyterEnabled && editor.key === "vscode";
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              `setup:editor-${editor.key}`
            );
            const profile = mkdtempSync(join(temporaryRoot, `p-${editor.key.slice(0, 1)}-`));
            const profileReceipt = capturePrivateRootReceipt(profile, temporaryRoot, {
              scope: "editor-profile",
              editor: editor.key
            });
            const userData = resolve(profile, "u");
            const pythonEnvironmentUserData = resolve(profile, "py");
            const jupyterAllowUserData = resolve(profile, "ja");
            const jupyterDenyUserData = resolve(profile, "jd");
            const jupyterPySparkUserData = resolve(profile, "js");
            const jupyterRemoteUserData = resolve(profile, "jr");
            const jupyterRUserData = resolve(profile, "jz");
            const jupyterRemoteRUserData = resolve(profile, "jq");
            const coexistOpenUserData = resolve(profile, "co");
            const coexistDataUserData = resolve(profile, "cd");
            const restrictedUserData = resolve(profile, "r");
            const extensions = resolve(profile, "extensions");
            const jupyterExtensions = resolve(profile, "jx");
            const coexistenceExtensions = resolve(profile, "cx");
            let jupyterAllowEnvironment;
            let jupyterDenyEnvironment;
            let jupyterPySparkEnvironment;
            let jupyterRemoteEnvironment;
            let jupyterREnvironment;
            let jupyterRemoteREnvironment;
            let coexistOpenEnvironment;
            let coexistDataEnvironment;
            const workspace = resolve(profile, "Open Wrangler Demo");
            const jupyterAllowWorkspace = resolve(profile, "orders-analysis");
            const jupyterDenyWorkspace = resolve(profile, "Open Wrangler Jupyter Deny");
            const jupyterPySparkWorkspace = resolve(profile, "Open Wrangler Jupyter PySpark");
            const jupyterRemoteWorkspace = resolve(profile, "Open Wrangler Jupyter Remote");
            const jupyterRWorkspace = resolve(profile, "Open Wrangler Jupyter R");
            const jupyterRemoteRWorkspace = resolve(profile, "Open Wrangler Jupyter Remote R");
            const coexistOpenWorkspace = resolve(profile, "Open Wrangler Coexist Open");
            const coexistDataWorkspace = resolve(profile, "Open Wrangler Coexist Data");
            const acceptanceHarness = resolve(profile, "acceptance-harness");
            const acceptanceHarnessVsix = resolve(profile, "openwrangler-packaged-test-harness.vsix");
            const resultPaths = {
              setup: resolve(profile, "setup-result.json"),
              ...(acceptanceMode === "full"
                ? {
                    restricted: resolve(profile, "restricted-result.json"),
                    seed: resolve(profile, "seed-result.json"),
                    verify: resolve(profile, "verify-result.json")
                  }
                : acceptanceMode === "platform-smoke"
                  ? { "platform-smoke": resolve(profile, "platform-smoke-result.json") }
                  : {}),
              ...(pythonExtensionInstallTarget
                ? acceptanceMode === "full"
                  ? { "python-environment": resolve(profile, "python-environment-result.json") }
                  : {}
                : {}),
              ...(jupyterExtensionInstallTarget
                ? acceptanceMode === "r-jupyter"
                  ? {
                      "jupyter-r": resolve(profile, "jupyter-r-result.json"),
                      ...(remoteRJupyterEnabled
                        ? {
                            "jupyter-r-remote-setup": resolve(profile, "jupyter-r-remote-setup-result.json"),
                            "jupyter-r-remote": resolve(profile, "jupyter-r-remote-result.json"),
                            "jupyter-r-remote-cleanup": resolve(profile, "jupyter-r-remote-cleanup-result.json")
                          }
                        : {})
                    }
                  : {
                      "jupyter-deny": resolve(profile, "jupyter-deny-result.json"),
                      "jupyter-allow": resolve(profile, "jupyter-allow-result.json"),
                      "jupyter-pyspark": resolve(profile, "jupyter-pyspark-result.json"),
                      ...(remoteJupyterEnabled
                        ? {
                            "jupyter-remote-setup": resolve(profile, "jupyter-remote-setup-result.json"),
                            "jupyter-remote": resolve(profile, "jupyter-remote-result.json"),
                            "jupyter-remote-cleanup": resolve(profile, "jupyter-remote-cleanup-result.json")
                          }
                        : {})
                    }
                : {}),
              ...(dataWranglerCoexistenceEnabled
                ? {
                    "jupyter-coexist-open-select": resolve(profile, "jupyter-coexist-open-select-result.json"),
                    "jupyter-coexist-open-restart": resolve(profile, "jupyter-coexist-open-restart-result.json"),
                    "jupyter-coexist-data-select": resolve(profile, "jupyter-coexist-data-select-result.json"),
                    "jupyter-coexist-data-restart": resolve(profile, "jupyter-coexist-data-restart-result.json")
                  }
                : {})
            };
            const runIds = {
              setup: randomUUID(),
              ...(acceptanceMode === "full"
                ? { restricted: randomUUID(), seed: randomUUID(), verify: randomUUID() }
                : acceptanceMode === "platform-smoke"
                  ? { "platform-smoke": randomUUID() }
                  : {}),
              ...(pythonExtensionInstallTarget && acceptanceMode === "full"
                ? { "python-environment": randomUUID() }
                : {}),
              ...(jupyterExtensionInstallTarget
                ? acceptanceMode === "r-jupyter"
                  ? {
                      "jupyter-r": randomUUID(),
                      ...(remoteRJupyterEnabled
                        ? {
                            "jupyter-r-remote-setup": randomUUID(),
                            "jupyter-r-remote": randomUUID(),
                            "jupyter-r-remote-cleanup": randomUUID()
                          }
                        : {})
                    }
                  : {
                      "jupyter-deny": randomUUID(),
                      "jupyter-allow": randomUUID(),
                      "jupyter-pyspark": randomUUID(),
                      ...(remoteJupyterEnabled
                        ? {
                            "jupyter-remote-setup": randomUUID(),
                            "jupyter-remote": randomUUID(),
                            "jupyter-remote-cleanup": randomUUID()
                          }
                        : {})
                    }
                : {}),
              ...(dataWranglerCoexistenceEnabled
                ? {
                    "jupyter-coexist-open-select": randomUUID(),
                    "jupyter-coexist-open-restart": randomUUID(),
                    "jupyter-coexist-data-select": randomUUID(),
                    "jupyter-coexist-data-restart": randomUUID()
                  }
                : {})
            };
            const progressPaths = Object.fromEntries(
              Object.entries(resultPaths).map(([phase, resultPath]) => [
                phase,
                editorAcceptanceProgressPath(resultPath, runIds[phase], phase)
              ])
            );
            const userDataByPhase = new Map([
              ["setup", userData],
              ["platform-smoke", userData],
              ["restricted", restrictedUserData],
              ["python-environment", pythonEnvironmentUserData],
              ["jupyter-r", jupyterRUserData],
              ["jupyter-r-remote-setup", jupyterRemoteRUserData],
              ["jupyter-r-remote", jupyterRemoteRUserData],
              ["jupyter-r-remote-cleanup", jupyterRemoteRUserData],
              ["jupyter-deny", jupyterDenyUserData],
              ["jupyter-allow", jupyterAllowUserData],
              ["jupyter-pyspark", jupyterPySparkUserData],
              ["jupyter-remote-setup", jupyterRemoteUserData],
              ["jupyter-remote", jupyterRemoteUserData],
              ["jupyter-remote-cleanup", jupyterRemoteUserData],
              ["jupyter-coexist-open-select", coexistOpenUserData],
              ["jupyter-coexist-open-restart", coexistOpenUserData],
              ["jupyter-coexist-data-select", coexistDataUserData],
              ["jupyter-coexist-data-restart", coexistDataUserData],
              ["seed", userData],
              ["verify", userData]
            ]);
            const userDataForPhase = (phase) => {
              const phaseUserData = userDataByPhase.get(phase);
              if (phaseUserData === undefined) {
                throw new Error("A packaged-editor phase is missing its private user-data root.");
              }
              return phaseUserData;
            };
            for (const phase of Object.keys(resultPaths)) userDataForPhase(phase);
            let activePhase = "setup";
            let identifiedEditor = { ...editor, version: "unknown" };
            const editorStartedAt = Date.now();
            let evidenceAttempt = 0;
            let profileTreeMayBeLive = false;
            const latchAcceptanceOwnershipUncertainty = () => {
              profileTreeMayBeLive = true;
              orchestrationTreeMayBeLive = true;
              evidenceCollectionSafe = false;
            };
            const latchRemoteJupyterOwnershipUncertainty = (error) => {
              if (!privatePathSafetyPolicy.failureOwnershipMayBeUnsafe(error, remoteJupyterOwnershipMayBeLive)) {
                return false;
              }
              latchAcceptanceOwnershipUncertainty();
              return true;
            };

            await runWithRetainedFailure({
              run: async () => {
                mkdirSync(workspace, { recursive: true });
                cpSync(resolve(root, "fixtures"), resolve(workspace, "fixtures"), { recursive: true });
                if (jupyterExtensionInstallTarget) {
                  const jupyterWorkspaces =
                    acceptanceMode === "r-jupyter"
                      ? [jupyterRWorkspace, ...(remoteRJupyterEnabled ? [jupyterRemoteRWorkspace] : [])]
                      : [
                          jupyterAllowWorkspace,
                          jupyterDenyWorkspace,
                          jupyterPySparkWorkspace,
                          ...(remoteJupyterEnabled ? [jupyterRemoteWorkspace] : []),
                          ...(dataWranglerCoexistenceEnabled ? [coexistOpenWorkspace, coexistDataWorkspace] : [])
                        ];
                  for (const jupyterWorkspace of jupyterWorkspaces) {
                    mkdirSync(jupyterWorkspace, { recursive: true });
                    cpSync(resolve(root, "fixtures"), resolve(jupyterWorkspace, "fixtures"), {
                      recursive: true
                    });
                  }
                }
                writeEditorAcceptanceHarness(acceptanceHarness);
                writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:package-acceptance-harness");
                await createVSIX({
                  cwd: acceptanceHarness,
                  packagePath: acceptanceHarnessVsix,
                  dependencies: false,
                  skipLicense: true,
                  allowStarActivation: true,
                  allowMissingRepository: true
                });
                writeEditorSettings(userData, {
                  "window.dialogStyle": "custom",
                  "window.menuStyle": "custom",
                  "files.simpleDialog.enable": true
                });
                if (acceptanceMode === "full" && pythonExtensionInstallTarget) {
                  writeEditorSettings(pythonEnvironmentUserData, {
                    "window.dialogStyle": "custom",
                    "window.menuStyle": "custom",
                    "files.simpleDialog.enable": true,
                    "python.useEnvironmentsExtension": false
                  });
                }
                if (jupyterExtensionInstallTarget) {
                  let jupyterUserData;
                  if (acceptanceMode === "r-jupyter") {
                    jupyterREnvironment = rAcceptanceEnvironment.jupyterEnvironment;
                    if (remoteRJupyterEnabled) {
                      jupyterRemoteREnvironment = writeRemoteJupyterAcceptanceEnvironment(resolve(profile, "kq"));
                    }
                    jupyterUserData = [jupyterRUserData, ...(remoteRJupyterEnabled ? [jupyterRemoteRUserData] : [])];
                  } else {
                    jupyterAllowEnvironment = writeJupyterAcceptanceEnvironment(
                      resolve(profile, "ka"),
                      jupyterKernelPython
                    );
                    jupyterDenyEnvironment = writeJupyterAcceptanceEnvironment(
                      resolve(profile, "kd"),
                      jupyterKernelPython
                    );
                    jupyterPySparkEnvironment = writeJupyterAcceptanceEnvironment(
                      resolve(profile, "ks"),
                      jupyterKernelPython
                    );
                    if (dataWranglerCoexistenceEnabled) {
                      coexistOpenEnvironment = writeJupyterAcceptanceEnvironment(
                        resolve(profile, "ko"),
                        jupyterKernelPython
                      );
                      coexistDataEnvironment = writeJupyterAcceptanceEnvironment(
                        resolve(profile, "kw"),
                        jupyterKernelPython
                      );
                    }
                    if (remoteJupyterEnabled) {
                      jupyterRemoteEnvironment = writeRemoteJupyterAcceptanceEnvironment(resolve(profile, "kr"));
                    }
                    jupyterUserData = [
                      jupyterAllowUserData,
                      jupyterDenyUserData,
                      jupyterPySparkUserData,
                      ...(remoteJupyterEnabled ? [jupyterRemoteUserData] : []),
                      ...(dataWranglerCoexistenceEnabled ? [coexistOpenUserData, coexistDataUserData] : [])
                    ];
                  }
                  for (const jupyterUserDataDirectory of jupyterUserData) {
                    writeEditorSettings(jupyterUserDataDirectory, {
                      "window.dialogStyle": "custom",
                      "window.menuStyle": "custom",
                      "files.simpleDialog.enable": true,
                      "extensions.ignoreRecommendations": true,
                      "notebook.globalToolbar": true,
                      "jupyter.askForKernelRestart": false,
                      ...(jupyterUserDataDirectory === jupyterRUserData && rEditorTooling
                        ? {
                            "files.associations": {
                              "*.R": "r",
                              "*.Rmd": "rmd",
                              "*.rmd": "rmd",
                              "*.qmd": "quarto"
                            },
                            "r.rpath.linux": rAcceptanceEnvironment.rExecutable,
                            "r.rterm.linux": rAcceptanceEnvironment.rExecutable,
                            "r.libPaths": [rAcceptanceEnvironment.libraryDir],
                            "r.rmarkdown.knit.useBackgroundProcess": true,
                            "r.rmarkdown.knit.focusOutputChannel": false,
                            "r.rmarkdown.knit.openOutputFile": false,
                            "r.rmarkdown.knit.command": `local({ rmarkdown::find_pandoc(dir = ${JSON.stringify(
                              rEditorTooling.pandocDirectory
                            )}); rmarkdown::render })`,
                            "quarto.path": rEditorTooling.quartoExecutable,
                            "quarto.usePipQuarto": false,
                            "quarto.render.previewType": "internal",
                            "quarto.render.previewReveal": true,
                            "quarto.render.renderOnSave": false
                          }
                        : {})
                    });
                  }
                }
                writeEditorSettings(restrictedUserData, {
                  "window.dialogStyle": "custom",
                  "window.menuStyle": "custom",
                  "files.simpleDialog.enable": true,
                  "security.workspace.trust.enabled": true,
                  "security.workspace.trust.startupPrompt": "never",
                  "security.workspace.trust.banner": "never",
                  "security.workspace.trust.emptyWindow": false
                });
                const fakeJupyter = resolve(profile, "fake-jupyter");
                writeFakeJupyterExtension(fakeJupyter);
                const sandboxArgs = [
                  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
                  ...editorDisplayLaunchArgs()
                ];
                const editorEnvironment = createEditorAcceptanceEnvironment();
                writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:editor-version");
                identifiedEditor = {
                  ...editor,
                  version: await readEditorVersion(editor, userData, extensions, sandboxArgs, editorEnvironment)
                };
                writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:install-extension");
                await runBoundedEditorCliCommand(
                  {
                    editor,
                    args: [
                      "--user-data-dir",
                      userData,
                      "--extensions-dir",
                      extensions,
                      "--install-extension",
                      vsix,
                      "--force",
                      ...sandboxArgs
                    ],
                    environment: editorEnvironment,
                    label: `${editor.name} extension installation`
                  },
                  { timeoutMs: 60_000 }
                );
                writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:install-acceptance-harness");
                await runBoundedEditorCliCommand(
                  {
                    editor,
                    args: [
                      "--user-data-dir",
                      userData,
                      "--extensions-dir",
                      extensions,
                      "--install-extension",
                      acceptanceHarnessVsix,
                      "--force",
                      ...sandboxArgs
                    ],
                    environment: editorEnvironment,
                    label: `${editor.name} acceptance-harness installation`
                  },
                  { timeoutMs: 60_000 }
                );
                if (acceptanceMode === "full" && pythonExtensionInstallTarget) {
                  writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:install-python-extension");
                  await runBoundedEditorCliCommand(
                    {
                      editor,
                      args: [
                        "--user-data-dir",
                        pythonEnvironmentUserData,
                        "--extensions-dir",
                        extensions,
                        "--install-extension",
                        pythonExtensionInstallTarget,
                        "--force",
                        ...sandboxArgs
                      ],
                      environment: editorEnvironment,
                      label: `${editor.name} pinned Python-extension installation`
                    },
                    { timeoutMs: 120_000 }
                  );
                }
                if (jupyterExtensionInstallTarget) {
                  const jupyterInstallUserData =
                    acceptanceMode === "r-jupyter" ? jupyterRUserData : jupyterAllowUserData;
                  writeCorrelatedProgress(
                    progressPaths.setup,
                    runIds.setup,
                    "setup",
                    "setup:install-jupyter-openwrangler"
                  );
                  for (const [installation, target] of [
                    ["Open Wrangler", vsix],
                    ["acceptance harness", acceptanceHarnessVsix]
                  ]) {
                    await runBoundedEditorCliCommand(
                      {
                        editor,
                        args: [
                          "--user-data-dir",
                          jupyterInstallUserData,
                          "--extensions-dir",
                          jupyterExtensions,
                          "--install-extension",
                          target,
                          "--force",
                          ...sandboxArgs
                        ],
                        environment: editorEnvironment,
                        label: `${editor.name} released-Jupyter ${installation} installation`
                      },
                      { timeoutMs: 60_000 }
                    );
                  }
                  writeCorrelatedProgress(
                    progressPaths.setup,
                    runIds.setup,
                    "setup",
                    "setup:install-jupyter-extension"
                  );
                  if (jupyterExtensionSnapshot) {
                    jupyterExtensionInstallTarget =
                      assertJupyterExtensionAcceptanceVsixSnapshot(jupyterExtensionSnapshot);
                  }
                  await runBoundedEditorCliCommand(
                    {
                      editor: isAbsolute(jupyterExtensionInstallTarget) ? editor : jupyterMarketplaceInstaller,
                      args: [
                        "--user-data-dir",
                        jupyterInstallUserData,
                        "--extensions-dir",
                        jupyterExtensions,
                        "--install-extension",
                        jupyterExtensionInstallTarget,
                        "--force",
                        ...sandboxArgs
                      ],
                      environment: editorEnvironment,
                      label: `${editor.name} pinned Jupyter-extension installation`
                    },
                    { timeoutMs: 180_000 }
                  );
                  if (acceptanceMode === "r-jupyter" && rEditorTooling) {
                    writeCorrelatedProgress(
                      progressPaths.setup,
                      runIds.setup,
                      "setup",
                      "setup:install-r-quarto-extensions"
                    );
                    for (const target of rEditorTooling.extensionVsixes) {
                      await runBoundedEditorCliCommand(
                        {
                          editor,
                          args: [
                            "--user-data-dir",
                            jupyterRUserData,
                            "--extensions-dir",
                            jupyterExtensions,
                            "--install-extension",
                            target,
                            "--force",
                            ...sandboxArgs
                          ],
                          environment: editorEnvironment,
                          label: `${editor.name} native R and Quarto extension installation`
                        },
                        { timeoutMs: 120_000 }
                      );
                    }
                  }
                }
                if (dataWranglerCoexistenceEnabled) {
                  writeCorrelatedProgress(
                    progressPaths.setup,
                    runIds.setup,
                    "setup",
                    "setup:install-coexistence-extensions"
                  );
                  for (const [installation, target] of [
                    ["Open Wrangler", vsix],
                    ["acceptance harness", acceptanceHarnessVsix]
                  ]) {
                    await runBoundedEditorCliCommand(
                      {
                        editor,
                        args: [
                          "--user-data-dir",
                          coexistOpenUserData,
                          "--extensions-dir",
                          coexistenceExtensions,
                          "--install-extension",
                          target,
                          "--force",
                          ...sandboxArgs
                        ],
                        environment: editorEnvironment,
                        label: `${editor.name} Data Wrangler coexistence ${installation} installation`
                      },
                      { timeoutMs: 60_000 }
                    );
                  }
                  if (jupyterExtensionSnapshot) {
                    jupyterExtensionInstallTarget =
                      assertJupyterExtensionAcceptanceVsixSnapshot(jupyterExtensionSnapshot);
                  }
                  await runBoundedEditorCliCommand(
                    {
                      editor: isAbsolute(jupyterExtensionInstallTarget) ? editor : jupyterMarketplaceInstaller,
                      args: [
                        "--user-data-dir",
                        coexistOpenUserData,
                        "--extensions-dir",
                        coexistenceExtensions,
                        "--install-extension",
                        jupyterExtensionInstallTarget,
                        "--force",
                        ...sandboxArgs
                      ],
                      environment: editorEnvironment,
                      label: `${editor.name} Data Wrangler coexistence Jupyter installation`
                    },
                    { timeoutMs: 180_000 }
                  );
                  await runBoundedEditorCliCommand(
                    {
                      editor: jupyterMarketplaceInstaller,
                      args: [
                        "--user-data-dir",
                        coexistOpenUserData,
                        "--extensions-dir",
                        coexistenceExtensions,
                        "--install-extension",
                        dataWranglerExtensionInstallTarget,
                        "--force",
                        ...sandboxArgs
                      ],
                      environment: editorEnvironment,
                      label: `${editor.name} exact Data Wrangler coexistence installation`
                    },
                    { timeoutMs: 180_000 }
                  );
                }
                writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:verify-installation");
                const { stdout: installed } = await runBoundedEditorCliCommand(
                  {
                    editor,
                    args: [
                      "--user-data-dir",
                      userData,
                      "--extensions-dir",
                      extensions,
                      "--list-extensions",
                      "--show-versions",
                      ...sandboxArgs
                    ],
                    environment: editorEnvironment,
                    label: `${editor.name} installed-extension query`
                  },
                  { timeoutMs: 60_000 }
                );
                if (!installed.toLowerCase().includes(expectedExtension)) {
                  throw new Error(
                    `${editor.name} did not report the installed Open Wrangler package. Output: ${installed}`
                  );
                }
                if (!installed.toLowerCase().includes(EXPECTED_ACCEPTANCE_HARNESS)) {
                  throw new Error(
                    `${editor.name} did not report the installed acceptance harness. Output: ${installed}`
                  );
                }
                if (
                  acceptanceMode === "full" &&
                  pythonExtensionInstallTarget &&
                  !installed
                    .split(/\r?\n/u)
                    .map((line) => line.trim().toLowerCase())
                    .includes(PINNED_PYTHON_EXTENSION_ID)
                ) {
                  throw new Error(
                    `${editor.name} did not report the pinned ${PINNED_PYTHON_EXTENSION_ID} package. Output: ${installed}`
                  );
                }
                if (jupyterExtensionInstallTarget) {
                  const jupyterInstallUserData =
                    acceptanceMode === "r-jupyter" ? jupyterRUserData : jupyterAllowUserData;
                  const { stdout: jupyterInstalled } = await runBoundedEditorCliCommand(
                    {
                      editor,
                      args: [
                        "--user-data-dir",
                        jupyterInstallUserData,
                        "--extensions-dir",
                        jupyterExtensions,
                        "--list-extensions",
                        "--show-versions",
                        ...sandboxArgs
                      ],
                      environment: editorEnvironment,
                      label: `${editor.name} released-Jupyter installed-extension query`
                    },
                    { timeoutMs: 60_000 }
                  );
                  const installedJupyterLines = jupyterInstalled
                    .split(/\r?\n/u)
                    .map((line) => line.trim().toLowerCase())
                    .filter(Boolean);
                  for (const expected of [
                    expectedExtension,
                    EXPECTED_ACCEPTANCE_HARNESS,
                    PINNED_JUPYTER_EXTENSION_ID,
                    ...(acceptanceMode === "r-jupyter" && rEditorTooling
                      ? [
                          R_EDITOR_ACCEPTANCE_TOOLING.rSyntax.id,
                          R_EDITOR_ACCEPTANCE_TOOLING.r.id,
                          R_EDITOR_ACCEPTANCE_TOOLING.quartoExtension.id
                        ]
                      : [])
                  ]) {
                    if (!installedJupyterLines.includes(expected)) {
                      throw new Error(
                        `${editor.name} did not report the released-Jupyter package ${expected}. Output: ${jupyterInstalled}`
                      );
                    }
                  }
                }
                if (dataWranglerCoexistenceEnabled) {
                  const { stdout: coexistenceInstalled } = await runBoundedEditorCliCommand(
                    {
                      editor,
                      args: [
                        "--user-data-dir",
                        coexistOpenUserData,
                        "--extensions-dir",
                        coexistenceExtensions,
                        "--list-extensions",
                        "--show-versions",
                        ...sandboxArgs
                      ],
                      environment: editorEnvironment,
                      label: `${editor.name} Data Wrangler coexistence installed-extension query`
                    },
                    { timeoutMs: 60_000 }
                  );
                  const installedCoexistenceLines = coexistenceInstalled
                    .split(/\r?\n/u)
                    .map((line) => line.trim().toLowerCase())
                    .filter(Boolean);
                  for (const expected of [
                    expectedExtension,
                    EXPECTED_ACCEPTANCE_HARNESS,
                    PINNED_JUPYTER_EXTENSION_ID,
                    PINNED_DATA_WRANGLER_EXTENSION_ID
                  ]) {
                    if (!installedCoexistenceLines.includes(expected)) {
                      throw new Error(
                        `${editor.name} did not report the coexistence package ${expected}. Output: ${coexistenceInstalled}`
                      );
                    }
                  }
                }
                writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:complete");

                const testModule = resolve(root, "dist-test", "test", "extensionHost", "index.js");
                const runRemoteJupyterPhase = async ({
                  phaseNames,
                  privatePaths,
                  fixtureKind,
                  workspace: remoteWorkspace,
                  userData: remoteUserData,
                  jupyterEnvironment: remoteJupyterEnvironment,
                  errorLabel
                }) => {
                  const {
                    setup: remoteSetupPhase,
                    editor: remoteEditorPhase,
                    cleanup: remoteCleanupPhase
                  } = phaseNames;
                  const remoteSetupRunId = runIds[remoteSetupPhase];
                  const remoteRunId = runIds[remoteEditorPhase];
                  const remoteCleanupRunId = runIds[remoteCleanupPhase];
                  const publishRemoteProgress = (progressPath, runId, phase, checkpoint) => {
                    try {
                      writeCorrelatedProgress(progressPath, runId, phase, checkpoint);
                    } catch (error) {
                      latchAcceptanceOwnershipUncertainty();
                      throw error;
                    }
                  };
                  const publishRemoteCleanupCheckpoint = (
                    checkpoint,
                    originatingPhase,
                    resumePhase = originatingPhase
                  ) => {
                    activePhase = remoteCleanupPhase;
                    publishRemoteProgress(
                      progressPaths[remoteCleanupPhase],
                      remoteCleanupRunId,
                      remoteCleanupPhase,
                      `${remoteCleanupPhase}:${checkpoint}:${originatingPhase}`
                    );
                    if (checkpoint === "complete") activePhase = resumePhase;
                  };

                  activePhase = remoteSetupPhase;
                  const dockerPrivateDirectory = resolve(profile, privatePaths.docker);
                  const descriptorDirectory = resolve(profile, privatePaths.descriptor);
                  mkdirSync(dockerPrivateDirectory, { mode: 0o700 });
                  mkdirSync(descriptorDirectory, { mode: 0o700 });
                  const token = createRemoteJupyterAcceptanceToken();
                  let fixture;
                  publishRemoteProgress(
                    progressPaths[remoteSetupPhase],
                    remoteSetupRunId,
                    remoteSetupPhase,
                    `${remoteSetupPhase}:start`
                  );
                  try {
                    fixture = await startRemoteJupyterAcceptanceFixture(
                      { token, runId: remoteRunId },
                      {
                        dockerPrivateDirectory,
                        fixtureKind,
                        onSetupCheckpoint: (checkpoint) =>
                          publishRemoteProgress(
                            progressPaths[remoteSetupPhase],
                            remoteSetupRunId,
                            remoteSetupPhase,
                            `${remoteSetupPhase}:${checkpoint}`
                          ),
                        onCleanupCheckpoint: (checkpoint) =>
                          publishRemoteCleanupCheckpoint(checkpoint, remoteSetupPhase)
                      }
                    );
                  } catch (error) {
                    latchRemoteJupyterOwnershipUncertainty(error);
                    throw error;
                  }
                  if (!fixture) {
                    throw new Error(`${errorLabel} did not start its explicitly enabled fixture.`);
                  }

                  activePhase = remoteEditorPhase;
                  try {
                    await runRemoteJupyterAcceptanceLifecycle(
                      fixture,
                      async () => {
                        try {
                          const remoteJupyterDescriptorPath = writeRemoteJupyterAcceptanceDescriptor(
                            descriptorDirectory,
                            {
                              baseUrl: fixture.baseUrl,
                              token,
                              runId: remoteRunId,
                              hostname: remoteJupyterHostnameForRun(remoteRunId)
                            },
                            { containedBy: profile }
                          );
                          await runEditorAcceptancePhase({
                            editor: identifiedEditor,
                            workspace: remoteWorkspace,
                            userData: remoteUserData,
                            extensions: jupyterExtensions,
                            developmentPaths: [],
                            testModule,
                            python: acceptancePythonForPhase(remoteEditorPhase, testPython, jupyterKernelPython),
                            phase: remoteEditorPhase,
                            resultPath: resultPaths[remoteEditorPhase],
                            runId: remoteRunId,
                            progressPath: progressPaths[remoteEditorPhase],
                            requiresWorkbenchCdp: true,
                            jupyterEnvironment: remoteJupyterEnvironment,
                            remoteJupyterDescriptorPath
                          });
                        } catch (error) {
                          const identityLost = latchPrivateRootIdentityLoss(error, {
                            scope: "editor-profile",
                            editor: identifiedEditor.key,
                            cleanupOfPhase: remoteEditorPhase
                          });
                          if (identityLost) latchAcceptanceOwnershipUncertainty();
                          throw error;
                        }
                      },
                      {
                        phaseProcessTreeMayBeLive: (error) =>
                          privatePathSafetyPolicy.failureOwnershipMayBeUnsafe(error, editorProcessTreeMayBeLive),
                        onOwnershipUncertain: latchAcceptanceOwnershipUncertainty,
                        onCleanupCheckpoint: (checkpoint, { phaseFailed }) =>
                          publishRemoteCleanupCheckpoint(
                            checkpoint,
                            remoteEditorPhase,
                            phaseFailed ? remoteEditorPhase : remoteCleanupPhase
                          )
                      }
                    );
                  } catch (error) {
                    latchRemoteJupyterOwnershipUncertainty(error);
                    throw error;
                  }
                };
                if (acceptanceMode === "platform-smoke") {
                  activePhase = "platform-smoke";
                  await runEditorAcceptancePhase({
                    editor: identifiedEditor,
                    workspace,
                    userData,
                    extensions,
                    developmentPaths: [fakeJupyter],
                    testModule,
                    python: acceptancePythonForPhase("platform-smoke", testPython, jupyterKernelPython),
                    phase: "platform-smoke",
                    resultPath: resultPaths["platform-smoke"],
                    runId: runIds["platform-smoke"],
                    progressPath: progressPaths["platform-smoke"],
                    requiresWorkbenchCdp: true
                  });
                } else if (acceptanceMode === "full") {
                  activePhase = "restricted";
                  await runEditorAcceptancePhase({
                    editor: identifiedEditor,
                    workspace,
                    userData: restrictedUserData,
                    extensions,
                    developmentPaths: [],
                    testModule: resolve(root, "dist-test", "test", "extensionHost", "restricted.js"),
                    python: acceptancePythonForPhase("restricted", testPython, jupyterKernelPython),
                    phase: "restricted",
                    workspaceTrust: "restricted",
                    resultPath: resultPaths.restricted,
                    runId: runIds.restricted,
                    progressPath: progressPaths.restricted
                  });
                }

                if (acceptanceMode === "full" && pythonExtensionInstallTarget) {
                  activePhase = "python-environment";
                  await runEditorAcceptancePhase({
                    editor: identifiedEditor,
                    workspace,
                    userData: pythonEnvironmentUserData,
                    extensions,
                    developmentPaths: [fakeJupyter],
                    testModule,
                    python: acceptancePythonForPhase("python-environment", testPython, jupyterKernelPython),
                    phase: "python-environment",
                    resultPath: resultPaths["python-environment"],
                    runId: runIds["python-environment"],
                    progressPath: progressPaths["python-environment"]
                  });
                }
                if (jupyterExtensionInstallTarget && acceptanceMode === "r-jupyter") {
                  activePhase = "jupyter-r";
                  try {
                    await runEditorAcceptancePhase({
                      editor: identifiedEditor,
                      workspace: jupyterRWorkspace,
                      userData: jupyterRUserData,
                      extensions: jupyterExtensions,
                      developmentPaths: [],
                      testModule,
                      python: acceptancePythonForPhase("jupyter-r", testPython, jupyterKernelPython),
                      phase: "jupyter-r",
                      testSelector: rJourneySelector,
                      resultPath: resultPaths["jupyter-r"],
                      runId: runIds["jupyter-r"],
                      progressPath: progressPaths["jupyter-r"],
                      requiresWorkbenchCdp: true,
                      jupyterEnvironment: jupyterREnvironment
                    });
                  } catch (error) {
                    if (editorProcessTreeMayBeLive(error)) throw error;
                    let bootstrapStage;
                    try {
                      bootstrapStage = jupyterAcceptanceRKernelBootstrapStage(rAcceptanceEnvironment);
                    } catch (bootstrapStageError) {
                      throw new AggregateError(
                        [error, bootstrapStageError],
                        "Released-Jupyter R failed and its bootstrap stage could not be verified."
                      );
                    }
                    throw appendJupyterAcceptanceRKernelBootstrapStage(error, bootstrapStage);
                  }
                  if (remoteRJupyterEnabled) {
                    await runRemoteJupyterPhase({
                      phaseNames: {
                        setup: "jupyter-r-remote-setup",
                        editor: "jupyter-r-remote",
                        cleanup: "jupyter-r-remote-cleanup"
                      },
                      privatePaths: { docker: "drr", descriptor: "rrd" },
                      fixtureKind: "r",
                      workspace: jupyterRemoteRWorkspace,
                      userData: jupyterRemoteRUserData,
                      jupyterEnvironment: jupyterRemoteREnvironment,
                      errorLabel: "Remote R acceptance"
                    });
                  }
                } else if (jupyterExtensionInstallTarget && acceptanceMode !== "data-wrangler-coexistence") {
                  for (const phase of ["jupyter-deny", "jupyter-allow", "jupyter-pyspark"]) {
                    const phaseWorkspace =
                      phase === "jupyter-deny"
                        ? jupyterDenyWorkspace
                        : phase === "jupyter-allow"
                          ? jupyterAllowWorkspace
                          : jupyterPySparkWorkspace;
                    const phaseUserData =
                      phase === "jupyter-deny"
                        ? jupyterDenyUserData
                        : phase === "jupyter-allow"
                          ? jupyterAllowUserData
                          : jupyterPySparkUserData;
                    const phaseJupyterEnvironment =
                      phase === "jupyter-deny"
                        ? jupyterDenyEnvironment
                        : phase === "jupyter-allow"
                          ? jupyterAllowEnvironment
                          : jupyterPySparkEnvironment;
                    activePhase = phase;
                    await runEditorAcceptancePhase({
                      editor: identifiedEditor,
                      workspace: phaseWorkspace,
                      userData: phaseUserData,
                      extensions: jupyterExtensions,
                      developmentPaths: [],
                      testModule,
                      python: acceptancePythonForPhase(phase, testPython, jupyterKernelPython),
                      phase,
                      resultPath: resultPaths[phase],
                      runId: runIds[phase],
                      progressPath: progressPaths[phase],
                      requiresWorkbenchCdp: true,
                      jupyterEnvironment: phaseJupyterEnvironment
                    });
                  }
                  if (remoteJupyterEnabled) {
                    await runRemoteJupyterPhase({
                      phaseNames: {
                        setup: "jupyter-remote-setup",
                        editor: "jupyter-remote",
                        cleanup: "jupyter-remote-cleanup"
                      },
                      privatePaths: { docker: "dr", descriptor: "rd" },
                      fixtureKind: "python",
                      workspace: jupyterRemoteWorkspace,
                      userData: jupyterRemoteUserData,
                      jupyterEnvironment: jupyterRemoteEnvironment,
                      errorLabel: "Remote Jupyter acceptance"
                    });
                  }
                }
                if (dataWranglerCoexistenceEnabled) {
                  for (const phase of [
                    "jupyter-coexist-open-select",
                    "jupyter-coexist-open-restart",
                    "jupyter-coexist-data-select",
                    "jupyter-coexist-data-restart"
                  ]) {
                    const openWranglerChoice = phase.startsWith("jupyter-coexist-open-");
                    activePhase = phase;
                    await runEditorAcceptancePhase({
                      editor: identifiedEditor,
                      workspace: openWranglerChoice ? coexistOpenWorkspace : coexistDataWorkspace,
                      userData: openWranglerChoice ? coexistOpenUserData : coexistDataUserData,
                      extensions: coexistenceExtensions,
                      developmentPaths: [],
                      testModule,
                      python: acceptancePythonForPhase(phase, testPython, jupyterKernelPython),
                      phase,
                      resultPath: resultPaths[phase],
                      runId: runIds[phase],
                      progressPath: progressPaths[phase],
                      requiresWorkbenchCdp: true,
                      jupyterEnvironment: openWranglerChoice ? coexistOpenEnvironment : coexistDataEnvironment
                    });
                  }
                }
                if (acceptanceMode === "full") {
                  for (const phase of ["seed", "verify"]) {
                    activePhase = phase;
                    await runEditorAcceptancePhase({
                      editor: identifiedEditor,
                      workspace,
                      userData,
                      extensions,
                      developmentPaths: [fakeJupyter],
                      testModule,
                      python: acceptancePythonForPhase(phase, testPython, jupyterKernelPython),
                      phase,
                      resultPath: resultPaths[phase],
                      runId: runIds[phase],
                      progressPath: progressPaths[phase]
                    });
                  }
                }
              },
              retainFailure: (error, { stage } = { stage: "run" }) => {
                if (!privatePathsVerified()) {
                  retainedFailures.add(error);
                  reportWithheldDiagnostics("private-path-identity");
                  return;
                }
                const identityLost = latchPrivateRootIdentityLoss(error, {
                  scope: "editor-profile",
                  editor: identifiedEditor.key,
                  cleanupOfPhase: activePhase
                });
                if (identityLost) {
                  retainedFailures.add(error);
                  reportWithheldDiagnostics("private-path-identity");
                  return;
                }
                profileTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
                orchestrationTreeMayBeLive ||= profileTreeMayBeLive;
                if (stage === "cleanup") markFailureTree(error, cleanupFailures);
                if (profileTreeMayBeLive) {
                  for (const failure of packagedEditorFailureLeaves(error)) retainedFailures.add(failure);
                  reportWithheldDiagnostics("process-ownership");
                  return;
                }
                retainPackagedEditorFailureLeaves(error, {
                  handledFailures: retainedFailures,
                  identityLatch: privatePathIdentityLatch,
                  identityContext: {
                    scope: "orchestration-evidence",
                    editor: identifiedEditor.key,
                    cleanupOfPhase: activePhase
                  },
                  onIdentityWithheld: () => reportWithheldDiagnostics("private-path-identity"),
                  onRetentionError: () => {
                    evidenceCollectionSafe = false;
                  },
                  retainLeaf: (failure) => {
                    const failureIsCleanup =
                      stage === "cleanup" ||
                      (failure && typeof failure === "object" && failure.details?.phase === "cleanup");
                    const evidencePhase = failureIsCleanup ? "cleanup" : activePhase;
                    const cleanupOfPhase = failureIsCleanup
                      ? (failure && typeof failure === "object" && failure.details?.cleanupOfPhase) || activePhase
                      : undefined;
                    const diagnosticError = acceptanceDiagnostic({
                      error: failure,
                      editor: identifiedEditor,
                      phase: evidencePhase,
                      startedAt: editorStartedAt,
                      resultPath: resultPaths[activePhase],
                      progressPath: progressPaths[activePhase],
                      runId: runIds[activePhase],
                      preferPrimary: stage !== "cleanup",
                      cleanupOfPhase,
                      readProgress: true
                    });
                    retainVerifiedEditorEvidence({
                      temporaryRootReceipt,
                      profileReceipt,
                      evidenceRoot,
                      temporaryRoot,
                      profile,
                      editor: identifiedEditor,
                      phase: evidencePhase,
                      error: diagnosticError,
                      attempt: (evidenceAttempt += 1),
                      resultPath: resultPaths[activePhase],
                      resultPaths,
                      progressPath: progressPaths[activePhase],
                      progressPaths,
                      logRoot: resolve(userDataForPhase(activePhase), "logs"),
                      identityOriginPhase: activePhase,
                      hostHomes
                    });
                    console.error("Sanitized packaged-editor diagnostics were retained for sealed upload.");
                  }
                });
              },
              cleanup: () => {
                try {
                  removeEditorAcceptancePrivateRoot(profileReceipt, {
                    processTreeVerifiedStopped: !profileTreeMayBeLive,
                    privatePathsVerified: privatePathsVerified()
                  });
                } catch (error) {
                  latchPrivateRootIdentityLoss(error, {
                    scope: "editor-profile",
                    editor: identifiedEditor.key,
                    cleanupOfPhase: activePhase
                  });
                  throw error;
                }
              },
              failureMessage: `${identifiedEditor.name} packaged acceptance failed during evidence retention or cleanup.`
            });
            completedEditorNames.push(identifiedEditor.name);
          }
          writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:complete");
        } catch (error) {
          runError = error;
        }
        if (privatePathsVerified()) {
          const identityLost = latchPrivateRootIdentityLoss(runError, {
            scope: "orchestration",
            editor: "orchestration",
            cleanupOfPhase: "setup"
          });
          if (!identityLost) orchestrationTreeMayBeLive ||= editorProcessTreeMayBeLive(runError);
        }
        let cursorCleanupError;
        try {
          await cleanupPackagedCursorAcquisition(cursorAcquisition, {
            processTreeVerifiedStopped: !orchestrationTreeMayBeLive,
            privatePathsVerified: privatePathsVerified()
          });
        } catch (error) {
          cursorCleanupError = error;
          if (privatePathsVerified()) {
            const identityLost = latchPrivateRootIdentityLoss(error, {
              scope: "cursor-acquisition",
              editor: "cursor",
              cleanupOfPhase: "setup"
            });
            if (!identityLost) {
              orchestrationTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
              markFailureTree(error, cleanupFailures);
            }
          }
        }
        let displayStopError;
        try {
          await editorDisplay?.stop(privatePathSafetyPolicy.displayStopOptions());
        } catch (error) {
          displayStopError = error;
          if (privatePathsVerified()) {
            const identityLost = latchPrivateRootIdentityLoss(error, {
              scope: "display-runtime",
              editor: "orchestration",
              cleanupOfPhase: "setup"
            });
            if (!identityLost) {
              orchestrationTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
              markFailureTree(error, cleanupFailures);
            }
          }
        }
        if (runError && (cursorCleanupError || displayStopError)) {
          throw new AggregateError(
            [runError, cursorCleanupError, displayStopError].filter(Boolean),
            "Packaged editor acceptance and owned-resource cleanup failed."
          );
        }
        if (runError) throw runError;
        if (cursorCleanupError && displayStopError) {
          throw new AggregateError(
            [cursorCleanupError, displayStopError],
            "Packaged editor owned-resource cleanup failed."
          );
        }
        if (cursorCleanupError) throw cursorCleanupError;
        if (displayStopError) throw displayStopError;
      },
      retainFailure: (error, { stage } = { stage: "run" }) => {
        if (!privatePathsVerified()) {
          retainedFailures.add(error);
          reportWithheldDiagnostics("private-path-identity");
          return;
        }
        const identityLost = latchPrivateRootIdentityLoss(error, {
          scope: "orchestration",
          editor: "orchestration",
          cleanupOfPhase: "setup"
        });
        if (identityLost) {
          retainedFailures.add(error);
          reportWithheldDiagnostics("private-path-identity");
          return;
        }
        orchestrationTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
        const unretained = unretainedFailures(error, retainedFailures);
        if (unretained.length === 0) return;
        if (orchestrationTreeMayBeLive) {
          for (const failure of unretained) retainedFailures.add(failure);
          reportWithheldDiagnostics("process-ownership");
          return;
        }
        for (const unretainedFailure of unretained) {
          if (!privatePathsVerified()) {
            retainedFailures.add(unretainedFailure);
            reportWithheldDiagnostics("private-path-identity");
            continue;
          }
          const isCleanup = stage === "cleanup" || cleanupFailures.has(unretainedFailure);
          const evidencePhase = isCleanup ? "cleanup" : "setup";
          const diagnosticError = acceptanceDiagnostic({
            error: unretainedFailure,
            editor: orchestrationEditor,
            phase: evidencePhase,
            startedAt: orchestrationStartedAt,
            resultPath: orchestrationResultPath,
            progressPath: orchestrationProgressPath,
            runId: orchestrationRunId,
            preferPrimary: false,
            cleanupOfPhase: isCleanup ? "setup" : undefined,
            readProgress: true
          });
          try {
            retainVerifiedEditorEvidence({
              temporaryRootReceipt,
              profileReceipt: orchestrationProfileReceipt,
              evidenceRoot,
              temporaryRoot,
              profile: orchestrationProfile,
              editor: orchestrationEditor,
              phase: evidencePhase,
              error: diagnosticError,
              attempt: (orchestrationEvidenceAttempt += 1),
              resultPath: orchestrationResultPath,
              resultPaths: orchestrationResultPaths,
              progressPath: orchestrationProgressPath,
              progressPaths: orchestrationProgressPaths,
              hostHomes
            });
            retainedFailures.add(unretainedFailure);
            console.error("Sanitized packaged-editor diagnostics were retained for sealed upload.");
          } catch (retentionError) {
            latchPrivateRootIdentityLoss(retentionError, {
              scope: "orchestration-evidence",
              editor: "orchestration"
            });
            evidenceCollectionSafe = false;
            throw retentionError;
          }
        }
      },
      cleanup: () => {
        try {
          removeEditorAcceptancePrivateRoot(temporaryRootReceipt, {
            processTreeVerifiedStopped: !orchestrationTreeMayBeLive,
            privatePathsVerified: privatePathsVerified()
          });
          temporaryRootCleaned = true;
        } catch (error) {
          latchPrivateRootIdentityLoss(error, {
            scope: "temporary-root",
            editor: "orchestration"
          });
          throw error;
        }
      },
      failureMessage: "Packaged editor orchestration failed during evidence retention or cleanup."
    },
    {
      clearEvidence: () =>
        assertVerifiedEvidenceStagingRoot(
          { requireEmpty: true },
          { scope: "evidence-staging", editor: "orchestration", cleanupOfPhase: "setup" }
        ),
      finalizeSuccess: () =>
        privatePathSafetyPolicy.runRequired(() => removeEvidenceStagingRoot({ requireEmpty: true })),
      reportSuccess: () => console.log(`${completedEditorNames.join(" and ")} packaged acceptance passed.`)
    }
  );
} catch {
  privatePathSafetyPolicy.runCleanupIfSafe(() => {
    if (!temporaryRootReceipt || temporaryRootCleaned) return;
    try {
      removeEditorAcceptancePrivateRoot(temporaryRootReceipt);
      temporaryRootCleaned = true;
    } catch (error) {
      latchPrivateRootIdentityLoss(error, {
        scope: "temporary-root",
        editor: "orchestration"
      });
      // The public diagnostic remains fixed and content-free on preflight cleanup faults.
    }
  });
  if (!privatePathsVerified()) reportWithheldDiagnostics("private-path-identity");
  if (orchestrationTreeMayBeLive) reportWithheldDiagnostics("process-ownership");
  const publishedEvidencePath = publishSealedEditorEvidence();
  const evidenceReady = publishedEvidencePath !== undefined;
  privatePathSafetyPolicy.runCleanupIfSafe(() => {
    if (!evidenceReady && evidenceStagingReceipt) {
      try {
        removeEvidenceStagingRoot();
      } catch {
        // Never touch a staging root whose prelaunch identity is no longer proven.
      }
    }
  });
  const localEvidenceHint =
    evidenceReady && process.env.GITHUB_ACTIONS !== "true"
      ? ` at ${relative(root, publishedEvidencePath).replaceAll("\\", "/")}`
      : "";
  console.error(
    evidenceReady
      ? `Packaged editor acceptance failed. A sealed sanitized diagnostic artifact is ready${localEvidenceHint}.`
      : "Packaged editor acceptance failed. No diagnostic artifact was published."
  );
  process.exitCode = 1;
}

function retainVerifiedEditorEvidence({
  temporaryRootReceipt,
  profileReceipt,
  identityOriginPhase = "setup",
  ...options
}) {
  const profileScope = options.editor.key === "orchestration" ? "orchestration-profile" : "editor-profile";
  const attestEvidenceRoots = (requireEmpty) => {
    assertVerifiedPrivateRootReceipt(temporaryRootReceipt, {
      scope: "temporary-root",
      editor: "orchestration",
      cleanupOfPhase: identityOriginPhase
    });
    assertVerifiedPrivateRootReceipt(profileReceipt, {
      scope: profileScope,
      editor: options.editor.key,
      cleanupOfPhase: identityOriginPhase
    });
    assertVerifiedEvidenceStagingRoot(
      { requireEmpty },
      {
        scope: "evidence-staging",
        editor: "orchestration",
        cleanupOfPhase: identityOriginPhase
      }
    );
  };
  attestEvidenceRoots(evidenceReceipts.length === 0);
  let target;
  let receipt;
  try {
    target = retainEditorAcceptanceEvidence(options);
    receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
  } catch (error) {
    if (
      latchPrivateRootIdentityLoss(error, {
        scope: "orchestration-evidence",
        editor: options.editor.key,
        cleanupOfPhase: identityOriginPhase
      })
    ) {
      throw error;
    }
    try {
      attestEvidenceRoots(false);
    } catch (attestationError) {
      throw new AggregateError(
        [error, attestationError],
        "Packaged-editor evidence retention failed while its private-root identity became uncertain."
      );
    }
    throw error;
  }
  attestEvidenceRoots(false);
  evidenceReceipts.push(receipt);
  return target;
}

function publishSealedEditorEvidence() {
  return privatePathSafetyPolicy.publishIfSafe(
    {
      evidenceCollectionSafe,
      hasTemporaryRootReceipt: temporaryRootReceipt !== undefined,
      evidenceReceiptCount: evidenceReceipts.length
    },
    () => {
      if (!temporaryRootCleaned) {
        try {
          assertVerifiedPrivateRootReceipt(temporaryRootReceipt, {
            scope: "temporary-root",
            editor: "orchestration",
            cleanupOfPhase: "setup"
          });
        } catch (error) {
          latchPrivateRootIdentityLoss(error, {
            scope: "temporary-root",
            editor: "orchestration"
          });
          return undefined;
        }
      }
      let artifactParentReceipt;
      let artifactReceipt;
      try {
        assertVerifiedEvidenceStagingRoot(
          {},
          { scope: "evidence-staging", editor: "orchestration", cleanupOfPhase: "setup" }
        );
        artifactParentReceipt = createEditorAcceptanceArtifactParent(editorEvidenceArtifactBase());
        artifactReceipt = sealEditorAcceptanceEvidence({
          evidenceRoot,
          artifactParent: artifactParentReceipt,
          receipts: evidenceReceipts
        });
        const artifactPath = assertSealedEditorAcceptanceArtifact(artifactReceipt);
        removeEvidenceStagingRoot();
        if (process.env.GITHUB_OUTPUT) {
          assertSealedEditorAcceptanceArtifact(artifactReceipt);
          appendFileSync(
            process.env.GITHUB_OUTPUT,
            `evidence_ready=true\nevidence_path=${artifactPath}\nevidence_sha256=${artifactReceipt.sha256}\nevidence_size=${String(artifactReceipt.snapshot.size)}\n`,
            "utf8"
          );
        }
        return artifactPath;
      } catch (error) {
        latchPrivateRootIdentityLoss(error, {
          scope: "evidence-staging",
          editor: "orchestration"
        });
        if (!privatePathsVerified()) return undefined;
        if (artifactReceipt) {
          try {
            const artifactPath = assertSealedEditorAcceptanceArtifact(artifactReceipt);
            rmSync(artifactPath, { force: true });
            removeEditorAcceptanceArtifactParent(artifactReceipt.parent);
          } catch {
            // The receipt no longer proves a safe artifact path to remove.
          }
        } else if (artifactParentReceipt) {
          try {
            removeEditorAcceptanceArtifactParent(artifactParentReceipt);
          } catch {
            // The parent is removed only while its creation identity and emptiness remain proven.
          }
        }
        try {
          removeEvidenceStagingRoot();
        } catch {
          // Never touch an evidence root whose prelaunch identity is no longer proven.
        }
        return undefined;
      }
    }
  );
}

function capturePrivateRootReceipt(path, containedBy, classifier) {
  try {
    return createEditorAcceptancePrivateRootReceipt(path, { containedBy });
  } catch (error) {
    latchPrivateRootIdentityLoss(error, classifier);
    throw error;
  }
}

function removeEvidenceStagingRoot({ requireEmpty = false } = {}) {
  if (!privatePathsVerified()) {
    removeEditorAcceptancePrivateRoot(undefined, {
      processTreeVerifiedStopped: !orchestrationTreeMayBeLive,
      privatePathsVerified: false
    });
  }
  if (!evidencePrivateRootReceipt) return;
  try {
    assertVerifiedEvidenceStagingRoot(
      { requireEmpty },
      { scope: "evidence-staging", editor: "orchestration", cleanupOfPhase: "setup" }
    );
    removeEditorAcceptancePrivateRoot(evidencePrivateRootReceipt, {
      processTreeVerifiedStopped: !orchestrationTreeMayBeLive,
      privatePathsVerified: privatePathsVerified()
    });
    evidencePrivateRootReceipt = undefined;
  } catch (error) {
    latchPrivateRootIdentityLoss(error, {
      scope: "evidence-staging",
      editor: "orchestration"
    });
    throw error;
  }
}

function assertVerifiedPrivateRootReceipt(receipt, classifier) {
  try {
    return assertEditorAcceptancePrivateRootReceipt(receipt);
  } catch (error) {
    latchPrivateRootIdentityLoss(error, classifier);
    throw error;
  }
}

function assertVerifiedEvidenceStagingRoot(options, classifier) {
  try {
    return assertEditorAcceptanceEvidenceStagingRoot(evidenceStagingReceipt, options);
  } catch (error) {
    latchPrivateRootIdentityLoss(error, classifier);
    throw error;
  }
}

function latchPrivateRootIdentityLoss(error, classifier = undefined) {
  if (!privatePathIdentityLatch.isVerified()) {
    evidenceCollectionSafe = false;
    return true;
  }
  if (!privatePathIdentityLatch.latch(error, classifier)) return false;
  evidenceCollectionSafe = false;
  return true;
}

function reportWithheldDiagnostics(category) {
  if (reportedWithheldCategories.has(category)) return false;
  reportedWithheldCategories.add(category);
  if (category === "private-path-identity") return privatePathIdentityLatch.reportWithheld();
  console.error("Packaged-editor diagnostics were withheld because process ownership is unverified.");
  return true;
}

function editorEvidenceArtifactBase() {
  if (process.env.GITHUB_ACTIONS !== "true") return localEvidenceArtifactBase;
  const runnerTemp = process.env.RUNNER_TEMP;
  if (typeof runnerTemp !== "string" || !isAbsolute(runnerTemp) || /[\0\r\n]/u.test(runnerTemp)) {
    throw new Error("GitHub Actions editor evidence requires one absolute RUNNER_TEMP path.");
  }
  return resolve(runnerTemp, "openwrangler-editor-acceptance-artifacts");
}

async function readEditorVersion(editor, userData, extensions, sandboxArgs, environment) {
  const { stdout } = await runBoundedEditorCliCommand(
    {
      editor,
      args: ["--user-data-dir", userData, "--extensions-dir", extensions, "--version", ...sandboxArgs],
      environment,
      label: `${editor.name} version probe`
    },
    { timeoutMs: 30_000 }
  );
  const version = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(line));
  if (!version) {
    throw new Error(`${editor.name} did not report a numeric major.minor.patch version from its CLI.`);
  }
  return version;
}

function acceptanceDiagnostic({
  error,
  editor,
  phase,
  startedAt,
  resultPath,
  progressPath,
  runId,
  preferPrimary = true,
  cleanupOfPhase,
  readProgress = true
}) {
  const primaryError = preferPrimary ? primaryAcceptanceError(error) : undefined;
  if (primaryError && typeof primaryError === "object" && "kind" in primaryError) return primaryError;
  const diagnostic = createEditorAcceptanceFailure(
    "runner-failure",
    `${editor.name} packaged acceptance ${phase} failed: ${error instanceof Error ? error.message : String(error)}`,
    {
      editor,
      phase,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      resultPath,
      progressPath,
      runId,
      cleanupOfPhase,
      readProgress,
      ...(readProgress ? {} : { treeVerifiedStopped: false })
    },
    error
  );
  diagnostic.details.nestedErrors = failureSummaries(error);
  if (cleanupOfPhase) diagnostic.details.cleanupOfPhase = cleanupOfPhase;
  return diagnostic;
}

function writeCorrelatedProgress(progressPath, runId, phase, checkpoint) {
  writeAcceptanceProgress(progressPath, createAcceptanceProgressEnvelope(runId, phase, checkpoint));
}

function primaryAcceptanceError(error, seen = new Set()) {
  if (seen.has(error)) return undefined;
  seen.add(error);
  if (error && typeof error === "object" && "kind" in error) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const primary = primaryAcceptanceError(nested, seen);
      if (primary) return primary;
    }
  }
  return undefined;
}

function unretainedFailures(error, retained, seen = new Set()) {
  if (retained.has(error) || seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) {
    const leaves = error.errors.flatMap((nested) => unretainedFailures(nested, retained, seen));
    return leaves.length > 0 ? leaves : [error];
  }
  return [error];
}

function markFailureTree(error, target, seen = new Set()) {
  if (seen.has(error)) return;
  seen.add(error);
  target.add(error);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) markFailureTree(nested, target, seen);
  }
}

function failureSummaries(error, depth = 0, seen = new Set()) {
  if (depth >= 4 || seen.has(error)) return ["<truncated-or-circular>"];
  seen.add(error);
  if (error instanceof AggregateError) {
    return error.errors.slice(0, 16).flatMap((nested) => failureSummaries(nested, depth + 1, seen));
  }
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Do not truncate raw diagnostics before the evidence redactor sees their
  // complete security syntax. Oversized leaves retain no source content.
  if (summary.length > MAX_FAILURE_SUMMARY_BYTES || Buffer.byteLength(summary, "utf8") > MAX_FAILURE_SUMMARY_BYTES) {
    return [OVERSIZED_DIAGNOSTIC_MARKER];
  }
  return [summary];
}
