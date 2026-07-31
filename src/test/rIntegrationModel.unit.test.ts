import { describe, expect, it } from "vitest";
import {
  JUPYTER_EXTENSION_ID,
  QUARTO_EXTENSION_ID,
  R_EXTENSION_ID,
  classifyRDocument,
  issueNativeRSessionHelperReceipt,
  planNativeRLaunch,
  readQuartoExtensionApi,
  revokeNativeRSessionHelperReceipt,
  type NativeRSessionHelperReceipt
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
    const documentIdentity = {};
    expect(
      planNativeRLaunch({
        document: {
          kind: "notebook",
          notebookType: "jupyter-notebook",
          kernelLanguage: "r"
        },
        documentIdentity,
        installedExtensionIds: [JUPYTER_EXTENSION_ID]
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
      const documentIdentity = {};
      const plan = planNativeRLaunch({
        document: { kind: "text", fileName },
        documentIdentity,
        installedExtensionIds
      });
      expect(plan.available).toBe(false);
      expect(plan.transport).toBeUndefined();
      expect(plan.missingExtensionIds).toEqual([]);
      expect(plan.reason).toContain("public API does not expose the live R environment");
      expect(plan.reason.toLowerCase()).not.toContain("python");
    }
  });

  it("allows only an explicit helper to bridge a source-editor R session", () => {
    const documentIdentity = {};
    const processIdentity = {};
    const helperIdentity = {};
    const receipt = issueNativeRSessionHelperReceipt(documentIdentity, processIdentity, helperIdentity);
    expect(
      planNativeRLaunch({
        document: { kind: "text", fileName: "analysis.qmd" },
        documentIdentity,
        installedExtensionIds: [QUARTO_EXTENSION_ID],
        sessionHelper: { receipt, processIdentity, helperIdentity }
      })
    ).toEqual({
      surface: "quarto",
      transport: "sessionHelper",
      available: true,
      missingExtensionIds: [],
      reason: "Use the explicit Open Wrangler helper connected to this exact R session."
    });
  });

  it("rejects stale, forged, cross-document, cross-process, and cross-helper receipts", () => {
    const documentIdentity = {};
    const processIdentity = {};
    const helperIdentity = {};
    const receipt = issueNativeRSessionHelperReceipt(documentIdentity, processIdentity, helperIdentity);

    for (const [candidateDocument, candidateReceipt, candidateProcess, candidateHelper] of [
      [{}, receipt, processIdentity, helperIdentity],
      [documentIdentity, receipt, {}, helperIdentity],
      [documentIdentity, receipt, processIdentity, {}],
      [documentIdentity, Object.freeze({}) as NativeRSessionHelperReceipt, processIdentity, helperIdentity]
    ] as const) {
      const plan = planNativeRLaunch({
        document: { kind: "text", fileName: "analysis.Rmd" },
        documentIdentity: candidateDocument,
        installedExtensionIds: [QUARTO_EXTENSION_ID],
        sessionHelper: {
          receipt: candidateReceipt,
          processIdentity: candidateProcess,
          helperIdentity: candidateHelper
        }
      });
      expect(plan.available).toBe(false);
      expect(plan.transport).toBeUndefined();
      expect(plan.reason).toContain("stale or belongs to a different document, R process, or helper instance");
    }

    revokeNativeRSessionHelperReceipt(receipt);
    const stalePlan = planNativeRLaunch({
      document: { kind: "text", fileName: "analysis.R" },
      documentIdentity,
      installedExtensionIds: [R_EXTENSION_ID],
      sessionHelper: { receipt, processIdentity, helperIdentity }
    });
    expect(stalePlan.available).toBe(false);
    expect(stalePlan.reason).toContain("stale or belongs to a different document, R process, or helper instance");
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

  it("fails closed when documented API properties are hostile getters or proxy traps", () => {
    const throwingGetter = Object.defineProperty(
      {
        getQuartoVersion: () => "1.9.0",
        isQuartoAvailable: () => true
      },
      "getQuartoPath",
      {
        get() {
          throw new Error("hostile getter");
        }
      }
    );
    expect(readQuartoExtensionApi(throwingGetter)).toBeUndefined();

    const throwingProxy = new Proxy(Object.create(null) as Record<string, unknown>, {
      get() {
        throw new Error("hostile proxy");
      }
    });
    expect(readQuartoExtensionApi(throwingProxy)).toBeUndefined();
  });
});
