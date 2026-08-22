import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODE_PREVIEW_EMPTY_ACTION_MESSAGE,
  CODE_PREVIEW_INVALID_EXPORT_MESSAGE,
  CODE_PREVIEW_SNAPSHOT_TIMEOUT_MS,
  CODE_PREVIEW_TIMEOUT_ACTION_MESSAGE
} from "../shared/codePreviewLimits";
import {
  command,
  nativeMocks,
  notebookDocument,
  notebookVariableSnapshot,
  register,
  resetNativeViewMocks,
  rDocumentSnapshot,
  rNotebookSnapshot
} from "./nativeViews.testFixtures";

describe("native notebook and document insertion commands", () => {
  beforeEach(resetNativeViewMocks);

  it("inserts notebook code into the exact originating document while another notebook is active", async () => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    const other = notebookDocument("file:///workspace/other.ipynb", 5);
    nativeMocks.notebookDocuments.push(origin, other);
    nativeMocks.activeNotebookEditor = { notebook: other, selections: [{ end: 1 }] };
    register(notebookVariableSnapshot(), origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledWith(
      origin,
      3,
      "def clean_data(df):\n    return df\n",
      { source: "frame", backend: "pandas", languageId: "python" }
    );
  });

  it("inserts the acknowledged pending edit instead of the prior generated buffer", async () => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    nativeMocks.notebookDocuments.push(origin);
    const registered = register(notebookVariableSnapshot(), origin);
    const latest = "def clean_data(df):\n    return df.dropna()\n";
    registered.codePreview.edit(latest);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledWith(origin, 3, latest, {
      source: "frame",
      backend: "pandas",
      languageId: "python"
    });
  });

  it.each(["utf8Bytes", "invalidUnicode"] as const)(
    "reports a %s current edit exactly and never relabels it as missing generated code",
    async (reason) => {
      const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
      nativeMocks.notebookDocuments.push(origin);
      const registered = register(notebookVariableSnapshot(), origin);
      registered.codePreview.editInvalid(reason);

      await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

      expect(registered.notebookInsertionStatus()).toBe("invalid-code");
      expect(nativeMocks.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(CODE_PREVIEW_INVALID_EXPORT_MESSAGE);
      expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
        "Add a cleaning step before inserting generated code."
      );
      expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
    }
  );

  it("distinguishes an acknowledged empty edit from absent generated code", async () => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    nativeMocks.notebookDocuments.push(origin);
    const registered = register(notebookVariableSnapshot(), origin);
    registered.codePreview.edit("");

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(registered.notebookInsertionStatus()).toBe("empty-code");
    expect(nativeMocks.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(CODE_PREVIEW_EMPTY_ACTION_MESSAGE);
    expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
      "Add a cleaning step before inserting generated code."
    );
    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
  });

  it("reports a current-edit timeout exactly and never relabels it as missing generated code", async () => {
    vi.useFakeTimers();
    try {
      const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
      nativeMocks.notebookDocuments.push(origin);
      const registered = register(notebookVariableSnapshot(), origin);
      registered.codePreview.setAutoRespond(false);
      const insertion = command("openWrangler.insertNotebookCode")();

      await vi.advanceTimersByTimeAsync(CODE_PREVIEW_SNAPSHOT_TIMEOUT_MS);
      await expect(insertion).resolves.toBe(false);

      expect(registered.notebookInsertionStatus()).toBe("code-timeout");
      expect(nativeMocks.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(CODE_PREVIEW_TIMEOUT_ACTION_MESSAGE);
      expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
        "Add a cleaning step before inserting generated code."
      );
      expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("inserts generated R into its originating notebook with the R cell language", async () => {
    const origin = notebookDocument("file:///workspace/orders.ipynb", 4);
    const active = rNotebookSnapshot();
    nativeMocks.notebookDocuments.push(origin);
    nativeMocks.activeNotebookEditor = { notebook: origin, selections: [{ end: 2 }] };
    register(active, origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledWith(origin, 2, active.code, {
      source: "orders",
      backend: "r",
      languageId: "r"
    });
  });

  it("uses the R-file insertion command only for a document-variable session", async () => {
    const active = rDocumentSnapshot();
    const origin = {
      kind: "textDocument" as const,
      document: {
        uri: { fsPath: "/workspace/analysis.R", toString: () => "file:///workspace/analysis.R" },
        version: 1
      },
      version: 1
    };
    register(active, undefined, origin);

    await expect(command("openWrangler.insertRDocumentCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedRDocumentCode).toHaveBeenCalledWith(origin, active.code);
    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith("Inserted generated R into analysis.R.");
  });

  it("does not wait for an actionless missing-code notification", async () => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    const active = notebookVariableSnapshot();
    active.code = "";
    nativeMocks.notebookDocuments.push(origin);
    nativeMocks.showInformationMessage.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const registered = register(active, origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(registered.notebookInsertionStatus()).toBe("missing-code");
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith(
      "Add a cleaning step before inserting generated code."
    );
    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
  });

  it("rejects a same-URI replacement instead of retargeting notebook insertion", async () => {
    const origin = notebookDocument("file:///workspace/shared.ipynb", 3, true);
    const replacement = notebookDocument("file:///workspace/shared.ipynb", 4);
    nativeMocks.notebookDocuments.push(replacement);
    nativeMocks.activeNotebookEditor = { notebook: replacement, selections: [{ end: 2 }] };
    nativeMocks.showWarningMessage.mockImplementationOnce(() => new Promise<never>(() => undefined));
    register(notebookVariableSnapshot(), origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Reopen the originating notebook before inserting generated code."
    );
  });

  it.each([
    {
      status: "stale" as const,
      channel: "warning" as const,
      message: "changed or was replaced"
    },
    {
      status: "indeterminate" as const,
      channel: "warning" as const,
      message: "Inspect the notebook before retrying"
    },
    {
      status: "rejected" as const,
      channel: "error" as const,
      message: "VS Code could not insert"
    }
  ])("does not report insertion success when the helper result is $status", async ({ status, channel, message }) => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    nativeMocks.notebookDocuments.push(origin);
    nativeMocks.insertGeneratedNotebookCell.mockResolvedValueOnce({ status });
    const registered = register(notebookVariableSnapshot(), origin);
    const messageMock = channel === "warning" ? nativeMocks.showWarningMessage : nativeMocks.showErrorMessage;
    messageMock.mockImplementationOnce(() => new Promise<never>(() => undefined));

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(registered.notebookInsertionStatus()).toBe(status);
    expect(messageMock).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
      "Inserted the generated cleaning code into its notebook."
    );
    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledOnce();
  });
});
