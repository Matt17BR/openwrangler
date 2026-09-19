import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as vscode from "vscode";
import type { JupyterServerCollection } from "@vscode/jupyter-extension";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  assertReleasedNativeREditorTooling,
  type ReleasedRToolingDependencies
} from "./extensionHost/releasedRTooling";
import { createFocusedReleasedRAcceptanceHandlers } from "./extensionHost/focusedReleasedRAcceptance";
import {
  releasedRAcceptanceCoverageProfile,
  RELEASED_R_COMPREHENSIVE_COVERAGE,
  RELEASED_R_PLATFORM_LIFECYCLE_COVERAGE,
  RELEASED_R_REPRESENTATIVE_COVERAGE
} from "./extensionHost/releasedRAcceptanceCoverage";
import { createReleasedRJupyterExtensionJourney } from "./extensionHost/releasedRJupyterExtensionJourney";
import { cleanupAcceptanceTemporaryDirectory } from "./extensionHost/acceptanceTemporaryDirectory";
import { RELEASED_JUPYTER_R_SETUP_RESULT } from "./extensionHost/releasedDocumentFixtures";
import type { TestApi, ExtensionApi } from "./extensionHost/extensionHostTestApi";

const notebookApi = vi.hoisted(() => ({
  configuration: { inspect: vi.fn(() => undefined), update: vi.fn(async () => {}) },
  open: vi.fn(),
  show: vi.fn(async () => ({})),
  extension: { packageJSON: { version: "test-version" }, activate: vi.fn(async () => ({})) }
}));
vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  extensions: { getExtension: () => notebookApi.extension },
  workspace: { getConfiguration: () => notebookApi.configuration, openNotebookDocument: notebookApi.open },
  window: { showNotebookDocument: notebookApi.show },
  ViewColumn: { One: 1 },
  ConfigurationTarget: { Workspace: 2 }
}));
vi.mock("./extensionHost/acceptanceTemporaryDirectory", async () => {
  const { rmSync } = await import("node:fs");
  return {
    // These routing tests use local temporary files even when selecting a Windows journey.
    cleanupAcceptanceTemporaryDirectory: vi.fn((directory: string) => rmSync(directory, { recursive: true }))
  };
});

type NotebookJourneyDependencies = Parameters<typeof createReleasedRJupyterExtensionJourney>[0];
function notebookJourney(platform: NodeJS.Platform, phase: "jupyter-r" | "jupyter-r-remote" = "jupyter-r") {
  const notebook = { cellAt: () => ({ outputs: [] }) } as unknown as vscode.NotebookDocument;
  notebookApi.open.mockReset().mockImplementation(async (uri: vscode.Uri) => {
    Object.assign(notebook, { uri });
    expect(existsSync(uri.fsPath)).toBe(true);
    return notebook;
  });
  notebookApi.configuration.update.mockClear();
  vi.mocked(cleanupAcceptanceTemporaryDirectory).mockClear();
  const testing = { diagnostics: () => ({ sessionCount: 0 }) } as TestApi;
  const extension = { packageJSON: {} } as vscode.Extension<ExtensionApi>;
  const workbench = {} as Page;
  const base = { sessionId: "notebook-base" } as NonNullable<ReturnType<TestApi["activeSession"]>>;
  const remote = { dispose: vi.fn() } as unknown as JupyterServerCollection;
  const dependencies = {
    platform,
    RELEASED_JUPYTER_EXTENSION_VERSION: "test-version",
    RELEASED_JUPYTER_R_KERNEL_CELL: 0,
    RELEASED_JUPYTER_R_SETUP_CELL: 1,
    assertReleasedRPrivateLibrary: vi.fn(),
    assertReleasedRRuntimeBinding: vi.fn(async () => {}),
    assertReleasedRSetupVersions: vi.fn(),
    bestEffortReleasedJupyterCleanup: vi.fn(async () => {}),
    connectToEditorWorkbench: vi.fn(async () => workbench),
    executeReleasedNotebookCell: vi.fn(async () => {}),
    exerciseReleasedRCollapseFrameSessions: vi.fn(async () => {}),
    exerciseReleasedRDocumentJourney: vi.fn<NotebookJourneyDependencies["exerciseReleasedRDocumentJourney"]>(
      async () => {}
    ),
    exerciseReleasedREditingCoverage: vi.fn(async () => {}),
    exerciseReleasedREditingModeTransition: vi.fn(async () => {}),
    exerciseReleasedRGridJourney: vi.fn(async () => {}),
    exerciseReleasedRKernelLifecycle: vi.fn(async () => {}),
    exerciseReleasedRKernelRestartExtension: vi.fn(async () => {}),
    exerciseReleasedRNativeFrameSessions: vi.fn(async () => {}),
    exerciseReleasedRNativeFramesExtension: vi.fn(async () => {}),
    exerciseReleasedRNotebookMedia: vi.fn(async () => base),
    exerciseReleasedRVariableDiscovery: vi.fn(async () => base),
    getLastAcceptanceProgressCheckpoint: () => undefined,
    notebookCellOutputText: () => RELEASED_JUPYTER_R_SETUP_RESULT,
    recordAcceptanceProgress: vi.fn(),
    recordReleasedRAcceptanceSection: vi.fn(),
    registerReleasedRemoteJupyterServer: vi.fn(() => remote),
    releasedJupyterKernelTarget: () => ({
      name: "r-test",
      label: "R test",
      routeLabels: [],
      ...(phase === "jupyter-r-remote"
        ? {
            remote: { baseUrl: { fsPath: "unused" } as vscode.Uri, token: "", runId: "test-run", hostname: "test-host" }
          }
        : {})
    }),
    releasedNotebookJsonResult: () => ({
      rows: 1_205,
      columns: 25,
      pid: 4321,
      remoteRunId: "test-run",
      hostname: "test-host"
    }),
    selectReleasedJupyterKernel: vi.fn(async () => {})
  } satisfies NotebookJourneyDependencies;
  const run = createReleasedRJupyterExtensionJourney(dependencies);
  return {
    dependencies,
    testing,
    workbench,
    base,
    notebook,
    run: (coverage: Parameters<typeof run>[3]) => run(testing, extension, phase, coverage),
    assertCleanup() {
      expect(dependencies.bestEffortReleasedJupyterCleanup).toHaveBeenCalledExactlyOnceWith(testing, notebook, phase);
      expect(notebookApi.configuration.update.mock.calls.slice(-2)).toEqual([
        ["notebookStartMode", undefined, 2],
        ["notebookPreviewProvider", undefined, 2]
      ]);
      expect(cleanupAcceptanceTemporaryDirectory).toHaveBeenCalledExactlyOnceWith(dirname(notebook.uri.fsPath));
      expect(existsSync(dirname(notebook.uri.fsPath))).toBe(false);
      expect(remote.dispose).toHaveBeenCalledTimes(phase === "jupyter-r-remote" ? 1 : 0);
    }
  };
}

const rCommands = ["r.runSelection", "r.runSource", "r.knitRmdToHtml"];
const quartoCommands = ["quarto.runCurrentCell", "quarto.renderDocument", "quarto.preview"];

function tooling(literateDocuments: boolean) {
  const extensions = new Map(
    [
      ["reditorsupport.r-syntax", "0.1.4"],
      ["reditorsupport.r", "2.8.8"],
      ...(literateDocuments ? [["quarto.quarto", "1.135.0"]] : [])
    ].map(([id, version]) => {
      const extension = {
        packageJSON: { version },
        isActive: false,
        activate: vi.fn(async () => {
          extension.isActive = true;
        })
      };
      return [id, extension] as const;
    })
  );
  const configuration = new Map<string, unknown>([
    ["path", "/private/quarto"],
    ["render.previewType", "internal"],
    ["render.previewReveal", true]
  ]);
  const configurationReads = vi.fn((_section: string, key: string) => configuration.get(key));
  const boundedCalls = vi.fn((_timeoutMs: number, _description: string) => {});
  const dependencies = {
    getExtension: vi.fn((id: string) => extensions.get(id)),
    getCommands: vi.fn(async () => [...rCommands, ...(literateDocuments ? quartoCommands : [])]),
    getConfiguration: <T>(section: string, key: string) => configurationReads(section, key) as T | undefined,
    pathIsAbsolute: vi.fn(() => true),
    pathExists: vi.fn(() => true),
    quartoVersion: vi.fn(() => "1.10.18"),
    withBoundedPromise: async <T>(promise: PromiseLike<T>, timeoutMs: number, description: string) => {
      boundedCalls(timeoutMs, description);
      return await promise;
    }
  } satisfies ReleasedRToolingDependencies;
  return { extensions, configuration, configurationReads, boundedCalls, dependencies };
}

describe("released native R editor tooling", () => {
  it("opens collapse sessions in the Windows desktop default without broadening focused or remote coverage", () => {
    const request = { editor: "vscode", phase: "jupyter-r", platform: "win32", selector: undefined } as const;
    expect(releasedRAcceptanceCoverageProfile(request)).toEqual({
      ...RELEASED_R_REPRESENTATIVE_COVERAGE,
      openCollapseSessions: true
    });
    expect(releasedRAcceptanceCoverageProfile({ ...request, editor: "cursor" })).toEqual(
      RELEASED_R_REPRESENTATIVE_COVERAGE
    );
    expect(releasedRAcceptanceCoverageProfile({ ...request, phase: "jupyter-r-remote" })).toEqual(
      RELEASED_R_REPRESENTATIVE_COVERAGE
    );
    for (const selector of ["core-operations", "native-frames"] as const) {
      expect(releasedRAcceptanceCoverageProfile({ ...request, selector }).openCollapseSessions).toBe(false);
    }
    expect(releasedRAcceptanceCoverageProfile({ ...request, platform: "linux" })).toEqual({
      ...RELEASED_R_COMPREHENSIVE_COVERAGE,
      nativeFrameEditing: "one-operation-per-flavor"
    });
    expect(releasedRAcceptanceCoverageProfile({ ...request, platform: "darwin" })).toEqual(
      RELEASED_R_PLATFORM_LIFECYCLE_COVERAGE
    );
  });

  for (const platform of ["darwin", "win32"] as const) {
    it.each(["categorical-operations", "value-operations", "pivot-wider"] as const)(
      `keeps focused %s editing without document or file stages on ${platform}`,
      async (selector) => {
        const fixture = notebookJourney(platform);
        const coverage = releasedRAcceptanceCoverageProfile({
          editor: "vscode",
          phase: "jupyter-r",
          platform,
          selector
        });
        await fixture.run(coverage);
        expect(fixture.dependencies.exerciseReleasedREditingCoverage).toHaveBeenCalledExactlyOnceWith(
          fixture.testing,
          fixture.workbench,
          fixture.base,
          fixture.notebook,
          fixture.notebook.uri.fsPath,
          dirname(fixture.notebook.uri.fsPath),
          "jupyter-r",
          coverage,
          undefined
        );
        fixture.assertCleanup();
        expect(fixture.dependencies.exerciseReleasedRDocumentJourney).not.toHaveBeenCalled();
      }
    );
  }

  it.each([
    ["darwin", "vscode", "jupyter-r", undefined, "document-and-file"],
    ["darwin", "cursor", "jupyter-r", undefined, "document"],
    ["darwin", "vscode", "jupyter-r", "core-operations", "document"],
    ["win32", "vscode", "jupyter-r", undefined, "file"],
    ["win32", "cursor", "jupyter-r", undefined, "file"],
    ["win32", "vscode", "jupyter-r", "core-operations", "file"],
    ["linux", "vscode", "jupyter-r", undefined, undefined],
    ["linux", "vscode", "jupyter-r-remote", undefined, undefined]
  ] as const)("retains ordinary %s %s %s %s stage %s", async (platform, editor, phase, selector, entry) => {
    const fixture = notebookJourney(platform, phase);
    const coverage = releasedRAcceptanceCoverageProfile({ editor, phase, platform, selector });
    await fixture.run(coverage);
    const document = fixture.dependencies.exerciseReleasedRDocumentJourney;
    if (entry === undefined) expect(document).not.toHaveBeenCalled();
    else {
      const directory = dirname(fixture.notebook.uri.fsPath);
      expect(document.mock.calls).toEqual([
        entry === "file"
          ? [
              fixture.testing,
              fixture.workbench,
              join(directory, "R files café"),
              entry,
              { document: fixture.notebook, processId: 4321 }
            ]
          : [fixture.testing, fixture.workbench, directory, entry]
      ]);
    }
    fixture.assertCleanup();
  });

  it("requires only pinned R tooling for the explicit terminal scope", async () => {
    const { dependencies, extensions, configurationReads, boundedCalls } = tooling(false);
    await expect(assertReleasedNativeREditorTooling(dependencies, false)).resolves.toBe(true);
    expect(new Set(dependencies.getExtension.mock.calls.map(([id]) => id))).toEqual(
      new Set(["reditorsupport.r-syntax", "reditorsupport.r"])
    );
    expect(extensions.get("reditorsupport.r")?.activate).toHaveBeenCalledOnce();
    expect(boundedCalls).toHaveBeenCalledWith(30_000, "activating reditorsupport.r");
    expect(dependencies.getCommands).toHaveBeenCalledOnce();
    expect(configurationReads).not.toHaveBeenCalled();
    expect(dependencies.pathExists).not.toHaveBeenCalled();
    expect(dependencies.quartoVersion).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("retains complete Quarto checks for literate scope %s", async (scope) => {
    const { dependencies, extensions, configurationReads } = tooling(true);
    await expect(assertReleasedNativeREditorTooling(dependencies, scope)).resolves.toBe(true);
    expect(extensions.get("reditorsupport.r")?.activate).toHaveBeenCalledOnce();
    expect(extensions.get("quarto.quarto")?.activate).toHaveBeenCalledOnce();
    expect(dependencies.quartoVersion).toHaveBeenCalledWith("/private/quarto");
    expect(configurationReads.mock.calls).toEqual([
      ["quarto", "path"],
      ["quarto", "render.previewType"],
      ["quarto", "render.previewReveal"]
    ]);
  });

  it("does not infer terminal scope from missing Quarto", async () => {
    await expect(assertReleasedNativeREditorTooling(tooling(false).dependencies)).rejects.toThrow(
      "quarto.quarto@1.135.0"
    );
  });

  it.each([false, true])("preserves the all-absent optional fallback for scope %s", async (scope) => {
    const { dependencies, extensions } = tooling(scope);
    extensions.clear();
    await expect(assertReleasedNativeREditorTooling(dependencies, scope)).resolves.toBe(false);
    expect(dependencies.getCommands).not.toHaveBeenCalled();
  });

  for (const scope of [false, true]) {
    for (const id of ["reditorsupport.r-syntax", "reditorsupport.r", ...(scope ? ["quarto.quarto"] : [])]) {
      it(`rejects missing or mismatched ${id} in scope ${scope}`, async () => {
        const fixture = tooling(scope);
        fixture.extensions.get(id)!.packageJSON.version = "0.0.0";
        await expect(assertReleasedNativeREditorTooling(fixture.dependencies, scope)).rejects.toThrow(id);
        fixture.extensions.delete(id);
        await expect(assertReleasedNativeREditorTooling(fixture.dependencies, scope)).rejects.toThrow(id);
        expect(fixture.dependencies.getCommands).not.toHaveBeenCalled();
      });
    }
    for (const command of [...rCommands, ...(scope ? quartoCommands : [])]) {
      it(`requires ${command} in scope ${scope}`, async () => {
        const { dependencies } = tooling(scope);
        dependencies.getCommands.mockResolvedValue(
          [...rCommands, ...quartoCommands].filter((item) => item !== command)
        );
        await expect(assertReleasedNativeREditorTooling(dependencies, scope)).rejects.toThrow(command);
      });
    }
  }

  it("retains the Quarto path, preview and CLI refusal controls", async () => {
    for (const [key, value] of [
      ["path", undefined],
      ["render.previewType", "external"],
      ["render.previewReveal", false]
    ] as const) {
      const { dependencies, configuration } = tooling(true);
      configuration.set(key, value);
      await expect(assertReleasedNativeREditorTooling(dependencies)).rejects.toThrow();
    }
    for (const guard of ["pathIsAbsolute", "pathExists"] as const) {
      const { dependencies } = tooling(true);
      dependencies[guard].mockReturnValue(false);
      await expect(assertReleasedNativeREditorTooling(dependencies)).rejects.toThrow("pinned private CLI");
    }
    const { dependencies } = tooling(true);
    dependencies.quartoVersion.mockReturnValue("0.0.0");
    await expect(assertReleasedNativeREditorTooling(dependencies)).rejects.toThrow("1.10.18");
  });

  it("rejects malformed scope before inspecting or activating any extension", async () => {
    const { dependencies } = tooling(true);
    for (const value of [null, 0, 1, "false", [], {}]) {
      await expect(assertReleasedNativeREditorTooling(dependencies, value as boolean)).rejects.toThrow(
        "boolean literate documents decision"
      );
    }
    expect(dependencies.getExtension).not.toHaveBeenCalled();
  });

  it.each([false, true])("routes the focused journey with its exact tooling scope %s", async (literate) => {
    const { dependencies } = tooling(literate);
    const trace: string[] = [];
    const assertNativeEditorTooling = vi.fn((scope?: boolean) =>
      assertReleasedNativeREditorTooling(dependencies, scope)
    );
    const handlers = createFocusedReleasedRAcceptanceHandlers({
      testing: "testing",
      platform: "linux",
      screenshotOutput: undefined,
      assertNativeEditorTooling,
      connectToEditorWorkbench: async () => {
        trace.push("connect");
        return "workbench";
      },
      createLiterateDirectory: () => {
        trace.push("create");
        return "/private/literate";
      },
      cleanupLiterateDirectory: () => {
        trace.push("cleanup");
      },
      exerciseInteractiveTerminalJourney: async (testing, workbench) => {
        expect([testing, workbench]).toEqual(["testing", "workbench"]);
        trace.push("terminal");
      },
      exerciseLiterateDocumentJourneys: async () => {
        trace.push("literate");
      },
      log: () => {},
      recordProgress: () => {}
    });
    await handlers[literate ? "focusedRLiterateDocuments" : "focusedRInteractive"]();
    expect(assertNativeEditorTooling.mock.calls).toEqual(literate ? [[]] : [[false]]);
    expect(trace).toEqual(literate ? ["create", "connect", "literate", "cleanup"] : ["connect", "terminal"]);
  });
});
