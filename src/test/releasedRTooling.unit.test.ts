import { describe, expect, it, vi } from "vitest";
import {
  assertReleasedNativeREditorTooling,
  type ReleasedRToolingDependencies
} from "./extensionHost/releasedRTooling";
import { createFocusedReleasedRAcceptanceHandlers } from "./extensionHost/focusedReleasedRAcceptance";

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
      testPython: "/private/python",
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
