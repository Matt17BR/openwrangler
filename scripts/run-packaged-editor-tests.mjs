import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVSIX } from "@vscode/vsce";
import {
  configureEditorAcceptanceTempRoot,
  collectEditorAcceptancePrivateDiagnosticPaths,
  createEditorAcceptanceEnvironment,
  createEditorAcceptanceFailure,
  createAcceptanceProgressEnvelope,
  downloadEditorWithRetry,
  editorDisplayLaunchArgs,
  editorAcceptanceProgressPath,
  editorProcessTreeMayBeLive,
  PINNED_JUPYTER_EXTENSION_ID,
  PINNED_PYTHON_EXTENSION_ID,
  resolveDownloadedEditorCliPath,
  resolveJupyterExtensionAcceptanceInstallTarget,
  resolvePythonExtensionAcceptanceInstallTarget,
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase,
  startIsolatedEditorDisplay,
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
  createEditorAcceptancePrivateRootReceipt,
  editorAcceptancePrivateRootIdentityLost,
  packagedEditorFailureLeaves,
  removeEditorAcceptancePrivateRoot,
  runPackagedEditorOrchestration,
  runWithRetainedFailure
} from "./packaged-editor-orchestration.mjs";
import {
  acceptancePythonForPhase,
  createJupyterAcceptanceKernelPython,
  writeJupyterAcceptanceEnvironment
} from "./jupyter-acceptance-environment.mjs";

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
const evidenceReceipts = [];
let orchestrationEvidenceAttempt = 0;
let orchestrationTreeMayBeLive = false;
let evidenceCollectionSafe = true;
let privatePathsVerified = true;
let editorDisplay;

try {
  hostHomes = collectEditorAcceptancePrivateDiagnosticPaths([
    resolve(root, process.argv[2] ?? "openwrangler.vsix"),
    process.env.OPEN_WRANGLER_PYTHON_EXTENSION_VSIX,
    process.env.OPEN_WRANGLER_JUPYTER_EXTENSION_VSIX
  ]);
  evidenceStagingReceipt = createEditorAcceptanceEvidenceStagingRoot(resolve(root, "tmp", "editor-acceptance-staging"));
  evidenceRoot = evidenceStagingReceipt.root;
  evidencePrivateRootReceipt = capturePrivateRootReceipt(evidenceRoot, dirname(evidenceRoot));
  const temporaryParent = resolve(root, "tmp", "ow");
  mkdirSync(temporaryParent, { recursive: true, mode: 0o700 });
  temporaryRoot = mkdtempSync(join(temporaryParent, "x-"));
  temporaryRootReceipt = capturePrivateRootReceipt(temporaryRoot, temporaryParent);
  configureEditorAcceptanceTempRoot(temporaryRoot);
  orchestrationProfile = resolve(temporaryRoot, "orchestration");
  mkdirSync(orchestrationProfile, { recursive: true, mode: 0o700 });
  orchestrationProfileReceipt = capturePrivateRootReceipt(orchestrationProfile, temporaryRoot);
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
          const jupyterExtensionInstallTarget = resolveJupyterExtensionAcceptanceInstallTarget();

          writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:resolve-editors");
          const requested = process.env.OPEN_WRANGLER_PACKAGED_EDITORS?.split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          const supportedEditorKeys = new Set(["vscode", "cursor"]);
          const unknownRequested = requested?.filter((key) => !supportedEditorKeys.has(key)) ?? [];
          if (unknownRequested.length) {
            throw new Error(
              'The packaged editor selection contains an unsupported value; allowed values are "vscode" and "cursor".'
            );
          }
          const candidates = [
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
              "Real Jupyter-extension acceptance requires OPEN_WRANGLER_TEST_PYTHON to resolve to an existing absolute interpreter."
            );
          }
          let jupyterKernelPython;
          if (jupyterExtensionInstallTarget) {
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
              latchPrivateRootIdentityLoss(error);
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
            writeCorrelatedProgress(
              orchestrationProgressPath,
              orchestrationRunId,
              "setup",
              `setup:editor-${editor.key}`
            );
            const profile = mkdtempSync(join(temporaryRoot, `p-${editor.key.slice(0, 1)}-`));
            const profileReceipt = capturePrivateRootReceipt(profile, temporaryRoot);
            const userData = resolve(profile, "u");
            const pythonEnvironmentUserData = resolve(profile, "py");
            const jupyterAllowUserData = resolve(profile, "ja");
            const jupyterDenyUserData = resolve(profile, "jd");
            const restrictedUserData = resolve(profile, "r");
            const extensions = resolve(profile, "extensions");
            const jupyterExtensions = resolve(profile, "jx");
            let jupyterAllowEnvironment;
            let jupyterDenyEnvironment;
            const workspace = resolve(profile, "Open Wrangler Demo");
            const jupyterAllowWorkspace = resolve(profile, "Open Wrangler Jupyter Allow");
            const jupyterDenyWorkspace = resolve(profile, "Open Wrangler Jupyter Deny");
            const acceptanceHarness = resolve(profile, "acceptance-harness");
            const acceptanceHarnessVsix = resolve(profile, "openwrangler-packaged-test-harness.vsix");
            const resultPaths = {
              setup: resolve(profile, "setup-result.json"),
              restricted: resolve(profile, "restricted-result.json"),
              ...(pythonExtensionInstallTarget
                ? { "python-environment": resolve(profile, "python-environment-result.json") }
                : {}),
              ...(jupyterExtensionInstallTarget
                ? {
                    "jupyter-deny": resolve(profile, "jupyter-deny-result.json"),
                    "jupyter-allow": resolve(profile, "jupyter-allow-result.json")
                  }
                : {}),
              seed: resolve(profile, "seed-result.json"),
              verify: resolve(profile, "verify-result.json")
            };
            const runIds = {
              setup: randomUUID(),
              restricted: randomUUID(),
              ...(pythonExtensionInstallTarget ? { "python-environment": randomUUID() } : {}),
              ...(jupyterExtensionInstallTarget ? { "jupyter-deny": randomUUID(), "jupyter-allow": randomUUID() } : {}),
              seed: randomUUID(),
              verify: randomUUID()
            };
            const progressPaths = Object.fromEntries(
              Object.entries(resultPaths).map(([phase, resultPath]) => [
                phase,
                editorAcceptanceProgressPath(resultPath, runIds[phase], phase)
              ])
            );
            let activePhase = "setup";
            let identifiedEditor = { ...editor, version: "unknown" };
            const editorStartedAt = Date.now();
            let evidenceAttempt = 0;
            let profileTreeMayBeLive = false;

            await runWithRetainedFailure({
              run: async () => {
                mkdirSync(workspace, { recursive: true });
                cpSync(resolve(root, "fixtures"), resolve(workspace, "fixtures"), { recursive: true });
                if (jupyterExtensionInstallTarget) {
                  for (const jupyterWorkspace of [jupyterAllowWorkspace, jupyterDenyWorkspace]) {
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
                if (pythonExtensionInstallTarget) {
                  writeEditorSettings(pythonEnvironmentUserData, {
                    "window.dialogStyle": "custom",
                    "window.menuStyle": "custom",
                    "files.simpleDialog.enable": true,
                    "python.useEnvironmentsExtension": false
                  });
                }
                if (jupyterExtensionInstallTarget) {
                  jupyterAllowEnvironment = writeJupyterAcceptanceEnvironment(
                    resolve(profile, "ka"),
                    jupyterKernelPython
                  );
                  jupyterDenyEnvironment = writeJupyterAcceptanceEnvironment(
                    resolve(profile, "kd"),
                    jupyterKernelPython
                  );
                  for (const jupyterUserData of [jupyterAllowUserData, jupyterDenyUserData]) {
                    writeEditorSettings(jupyterUserData, {
                      "window.dialogStyle": "custom",
                      "window.menuStyle": "custom",
                      "files.simpleDialog.enable": true,
                      "notebook.globalToolbar": true,
                      "jupyter.askForKernelRestart": false
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
                if (pythonExtensionInstallTarget) {
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
                          jupyterAllowUserData,
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
                  await runBoundedEditorCliCommand(
                    {
                      editor: isAbsolute(jupyterExtensionInstallTarget) ? editor : jupyterMarketplaceInstaller,
                      args: [
                        "--user-data-dir",
                        jupyterAllowUserData,
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
                  const { stdout: jupyterInstalled } = await runBoundedEditorCliCommand(
                    {
                      editor,
                      args: [
                        "--user-data-dir",
                        jupyterAllowUserData,
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
                    PINNED_JUPYTER_EXTENSION_ID
                  ]) {
                    if (!installedJupyterLines.includes(expected)) {
                      throw new Error(
                        `${editor.name} did not report the released-Jupyter package ${expected}. Output: ${jupyterInstalled}`
                      );
                    }
                  }
                }
                writeCorrelatedProgress(progressPaths.setup, runIds.setup, "setup", "setup:complete");

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

                const testModule = resolve(root, "dist-test", "test", "extensionHost", "index.js");
                if (pythonExtensionInstallTarget) {
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
                if (jupyterExtensionInstallTarget) {
                  for (const phase of ["jupyter-deny", "jupyter-allow"]) {
                    activePhase = phase;
                    await runEditorAcceptancePhase({
                      editor: identifiedEditor,
                      workspace: phase === "jupyter-deny" ? jupyterDenyWorkspace : jupyterAllowWorkspace,
                      userData: phase === "jupyter-deny" ? jupyterDenyUserData : jupyterAllowUserData,
                      extensions: jupyterExtensions,
                      developmentPaths: [],
                      testModule,
                      python: acceptancePythonForPhase(phase, testPython, jupyterKernelPython),
                      phase,
                      resultPath: resultPaths[phase],
                      runId: runIds[phase],
                      progressPath: progressPaths[phase],
                      requiresWorkbenchCdp: true,
                      jupyterEnvironment: phase === "jupyter-deny" ? jupyterDenyEnvironment : jupyterAllowEnvironment
                    });
                  }
                }
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
                console.log(`${identifiedEditor.name} packaged acceptance passed.`);
              },
              retainFailure: (error, { stage } = { stage: "run" }) => {
                profileTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
                orchestrationTreeMayBeLive ||= profileTreeMayBeLive;
                if (stage === "cleanup") markFailureTree(error, cleanupFailures);
                if (profileTreeMayBeLive || !privatePathsVerified) {
                  for (const failure of packagedEditorFailureLeaves(error)) retainedFailures.add(failure);
                  console.error(
                    profileTreeMayBeLive
                      ? "Packaged-editor diagnostics were withheld because process ownership is unverified."
                      : "Packaged-editor diagnostics were withheld because private-path identity is unverified."
                  );
                  return;
                }
                const retentionErrors = [];
                for (const failure of packagedEditorFailureLeaves(error)) {
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
                  try {
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
                      hostHomes
                    });
                    retainedFailures.add(failure);
                    console.error("Sanitized packaged-editor diagnostics were retained for sealed upload.");
                  } catch (retentionError) {
                    latchPrivateRootIdentityLoss(retentionError);
                    evidenceCollectionSafe = false;
                    retentionErrors.push(retentionError);
                  }
                }
                if (retentionErrors.length === 1) throw retentionErrors[0];
                if (retentionErrors.length > 1) {
                  throw new AggregateError(
                    retentionErrors,
                    "Multiple packaged-editor diagnostics could not be retained."
                  );
                }
              },
              cleanup: () => {
                try {
                  removeEditorAcceptancePrivateRoot(profileReceipt, {
                    processTreeVerifiedStopped: !profileTreeMayBeLive,
                    privatePathsVerified
                  });
                } catch (error) {
                  latchPrivateRootIdentityLoss(error);
                  throw error;
                }
              },
              failureMessage: `${identifiedEditor.name} packaged acceptance failed during evidence retention or cleanup.`
            });
          }
          writeCorrelatedProgress(orchestrationProgressPath, orchestrationRunId, "setup", "setup:complete");
        } catch (error) {
          runError = error;
        }
        let displayStopError;
        try {
          await editorDisplay?.stop({
            preservePrivateFiles: orchestrationTreeMayBeLive || editorProcessTreeMayBeLive(runError)
          });
        } catch (error) {
          displayStopError = error;
          orchestrationTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
          markFailureTree(error, cleanupFailures);
        }
        if (runError && displayStopError) {
          throw new AggregateError(
            [runError, displayStopError],
            "Packaged editor acceptance and display cleanup failed."
          );
        }
        if (runError) throw runError;
        if (displayStopError) throw displayStopError;
      },
      retainFailure: (error, { stage } = { stage: "run" }) => {
        orchestrationTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
        const unretained = unretainedFailures(error, retainedFailures);
        if (unretained.length === 0) return;
        if (orchestrationTreeMayBeLive || !privatePathsVerified) {
          for (const failure of unretained) retainedFailures.add(failure);
          console.error(
            orchestrationTreeMayBeLive
              ? "Packaged-editor diagnostics were withheld because process ownership is unverified."
              : "Packaged-editor diagnostics were withheld because private-path identity is unverified."
          );
          return;
        }
        for (const unretainedFailure of unretained) {
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
            latchPrivateRootIdentityLoss(retentionError);
            evidenceCollectionSafe = false;
            throw retentionError;
          }
        }
      },
      cleanup: () => {
        try {
          removeEditorAcceptancePrivateRoot(temporaryRootReceipt, {
            processTreeVerifiedStopped: !orchestrationTreeMayBeLive,
            privatePathsVerified
          });
          temporaryRootCleaned = true;
        } catch (error) {
          latchPrivateRootIdentityLoss(error);
          throw error;
        }
      },
      failureMessage: "Packaged editor orchestration failed during evidence retention or cleanup."
    },
    {
      clearEvidence: () => assertEditorAcceptanceEvidenceStagingRoot(evidenceStagingReceipt, { requireEmpty: true })
    }
  );
  removeEvidenceStagingRoot({ requireEmpty: true });
} catch {
  if (!orchestrationTreeMayBeLive && privatePathsVerified && temporaryRootReceipt && !temporaryRootCleaned) {
    try {
      removeEditorAcceptancePrivateRoot(temporaryRootReceipt);
      temporaryRootCleaned = true;
    } catch (error) {
      latchPrivateRootIdentityLoss(error);
      // The public diagnostic remains fixed and content-free on preflight cleanup faults.
    }
  }
  const publishedEvidencePath = publishSealedEditorEvidence();
  const evidenceReady = publishedEvidencePath !== undefined;
  if (!orchestrationTreeMayBeLive && !evidenceReady && evidenceStagingReceipt) {
    try {
      removeEvidenceStagingRoot();
    } catch {
      // Never touch a staging root whose prelaunch identity is no longer proven.
    }
  }
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

function retainVerifiedEditorEvidence({ temporaryRootReceipt, profileReceipt, ...options }) {
  assertEditorAcceptancePrivateRootReceipt(temporaryRootReceipt);
  assertEditorAcceptancePrivateRootReceipt(profileReceipt);
  assertEditorAcceptanceEvidenceStagingRoot(evidenceStagingReceipt, {
    requireEmpty: evidenceReceipts.length === 0
  });
  const target = retainEditorAcceptanceEvidence(options);
  assertEditorAcceptancePrivateRootReceipt(temporaryRootReceipt);
  assertEditorAcceptancePrivateRootReceipt(profileReceipt);
  assertEditorAcceptanceEvidenceStagingRoot(evidenceStagingReceipt);
  const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
  evidenceReceipts.push(receipt);
  return target;
}

function publishSealedEditorEvidence() {
  if (
    orchestrationTreeMayBeLive ||
    !privatePathsVerified ||
    !temporaryRootReceipt ||
    !evidenceCollectionSafe ||
    evidenceReceipts.length === 0
  ) {
    return undefined;
  }
  if (!temporaryRootCleaned) {
    try {
      assertEditorAcceptancePrivateRootReceipt(temporaryRootReceipt);
    } catch (error) {
      latchPrivateRootIdentityLoss(error);
      return undefined;
    }
  }
  let artifactParentReceipt;
  let artifactReceipt;
  try {
    assertEditorAcceptanceEvidenceStagingRoot(evidenceStagingReceipt);
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
  } catch {
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

function capturePrivateRootReceipt(path, containedBy) {
  try {
    return createEditorAcceptancePrivateRootReceipt(path, { containedBy });
  } catch (error) {
    latchPrivateRootIdentityLoss(error);
    throw error;
  }
}

function removeEvidenceStagingRoot({ requireEmpty = false } = {}) {
  if (!evidencePrivateRootReceipt) return;
  assertEditorAcceptanceEvidenceStagingRoot(evidenceStagingReceipt, { requireEmpty });
  removeEditorAcceptancePrivateRoot(evidencePrivateRootReceipt, {
    processTreeVerifiedStopped: !orchestrationTreeMayBeLive,
    privatePathsVerified
  });
  evidencePrivateRootReceipt = undefined;
}

function latchPrivateRootIdentityLoss(error) {
  if (!editorAcceptancePrivateRootIdentityLost(error)) return false;
  privatePathsVerified = false;
  evidenceCollectionSafe = false;
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
