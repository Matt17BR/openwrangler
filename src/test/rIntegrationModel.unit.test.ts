import { describe, expect, it } from "vitest";
import {
  JUPYTER_EXTENSION_ID,
  QUARTO_EXTENSION_ID,
  R_EXTENSION_ID,
  classifyRDocument,
  planNativeRLaunch,
  readQuartoExtensionApi
} from "../extension/r/rIntegrationModel";

describe("native R integration model", () => {
  it.each([
    [{ kind: "text" as const, fileName: "/workspace/analysis.R" }, "rSource"],
    [{ kind: "text" as const, fileName: "analysis.Rmd", languageId: "quarto" }, "rMarkdown"],
    [{ kind: "text" as const, fileName: "analysis.qmd", languageId: "quarto" }, "quarto"],
    [{ kind: "text" as const, languageId: "rmd" }, "rMarkdown"],
    [
      {
        kind: "notebook" as const,
        fileName: "analysis.ipynb",
        notebookType: "jupyter-notebook",
        kernelLanguage: "R"
      },
      "jupyterR"
    ]
  ])("classifies a supported document without relying on editor-private state", (context, expected) => {
    expect(classifyRDocument(context)).toBe(expected);
  });

  it("does not mistake a Python notebook or ordinary Markdown document for an R surface", () => {
    expect(
      classifyRDocument({
        kind: "notebook",
        notebookType: "jupyter-notebook",
        kernelLanguage: "python"
      })
    ).toBeUndefined();
    expect(classifyRDocument({ kind: "text", fileName: "notes.md", languageId: "markdown" })).toBeUndefined();
  });

  it("uses the stable Jupyter API for an R kernel without requiring vscode-R or Quarto", () => {
    expect(
      planNativeRLaunch({
        document: {
          kind: "notebook",
          notebookType: "jupyter-notebook",
          kernelLanguage: "r"
        },
        installedExtensionIds: [JUPYTER_EXTENSION_ID],
        sessionHelperConnected: false
      })
    ).toEqual({
      surface: "jupyterR",
      transport: "jupyterKernel",
      available: true,
      missingExtensionIds: [],
      reason: "Use the selected R Jupyter kernel through the stable Jupyter extension API."
    });
  });

  it("never treats authoring extensions as permission to inspect a live R environment", () => {
    for (const [fileName, installedExtensionIds] of [
      ["analysis.R", [R_EXTENSION_ID]],
      ["analysis.Rmd", [R_EXTENSION_ID, QUARTO_EXTENSION_ID]],
      ["analysis.qmd", [QUARTO_EXTENSION_ID]]
    ] as const) {
      const plan = planNativeRLaunch({
        document: { kind: "text", fileName },
        installedExtensionIds,
        sessionHelperConnected: false
      });
      expect(plan.available).toBe(false);
      expect(plan.transport).toBeUndefined();
      expect(plan.missingExtensionIds).toEqual([]);
      expect(plan.reason).toContain("public API does not expose the live R environment");
      expect(plan.reason.toLowerCase()).not.toContain("python");
    }
  });

  it("allows only an explicit helper to bridge a source-editor R session", () => {
    expect(
      planNativeRLaunch({
        document: { kind: "text", fileName: "analysis.qmd" },
        installedExtensionIds: [QUARTO_EXTENSION_ID],
        sessionHelperConnected: true
      })
    ).toEqual({
      surface: "quarto",
      transport: "sessionHelper",
      available: true,
      missingExtensionIds: [],
      reason: "Use the explicit Open Wrangler helper connected to this exact R session."
    });
  });
});

describe("Quarto public API guard", () => {
  it("reads only documented CLI metadata", () => {
    expect(
      readQuartoExtensionApi({
        getQuartoPath: () => "/opt/quarto/bin/quarto",
        getQuartoVersion: () => "1.9.0",
        isQuartoAvailable: () => true,
        futureAdditiveField: "ignored"
      })
    ).toEqual({
      available: true,
      path: "/opt/quarto/bin/quarto",
      version: "1.9.0"
    });
  });

  it("rejects malformed, internally inconsistent, and throwing exports", () => {
    expect(readQuartoExtensionApi({})).toBeUndefined();
    expect(
      readQuartoExtensionApi({
        getQuartoPath: () => "/opt/quarto/bin/quarto",
        getQuartoVersion: () => undefined,
        isQuartoAvailable: () => false
      })
    ).toBeUndefined();
    expect(
      readQuartoExtensionApi({
        getQuartoPath: () => {
          throw new Error("activation failed");
        },
        getQuartoVersion: () => undefined,
        isQuartoAvailable: () => true
      })
    ).toBeUndefined();
  });
});
