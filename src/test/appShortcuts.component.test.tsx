import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata, TransformStep } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App } from "../webviews/App";

const step: TransformStep = {
  id: "formula-step",
  kind: "formula",
  params: { leftColumn: { id: "c:1", name: "sales" }, operator: "multiply", value: 2, newColumn: "score" }
};

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 1,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 3 },
  filteredShape: { rows: 1, columns: 3 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  draftStep: step,
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false },
    { id: "c:step", name: "score", position: 2, rawType: "Float64", type: "float", nullable: false }
  ]
};
const { draftStep: _draftStep, ...metadataWithoutDraft } = metadata;
const appliedMetadata: SessionMetadata = {
  ...metadataWithoutDraft,
  steps: [step],
  latestStepInputSchema: metadata.schema.slice(0, 2)
};

const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 1,
  columnIds: metadata.schema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false },
        { kind: "number", raw: 12, display: "12", isNull: false, isNaN: false },
        { kind: "number", raw: 24, display: "24", isNull: false, isNaN: false }
      ]
    }
  ]
};

describe("App cleaning-plan keyboard shortcuts", () => {
  beforeEach(() => postMessage.mockClear());

  it("applies, discards, edits, and undoes without stealing editable-field undo", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    const apply = await screen.findByRole("button", { name: "Apply step" });
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(apply).toHaveAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    expect(discard).toHaveAttribute("aria-keyshortcuts", "Escape");

    postMessage.mockClear();
    fireEvent.keyDown(apply, { key: "Enter", ctrlKey: true });
    expect(runtimeRequestKinds()).toContain("applyDraft");
    fireEvent.keyDown(discard, { key: "Escape" });
    expect(runtimeRequestKinds()).not.toContain("discardDraft");
    expect(apply).toBeDisabled();
    expect(discard).toBeDisabled();

    dispatch({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: { ...appliedMetadata, revision: 2 },
      page,
      code: "def clean_data(df):\n"
    });
    const undo = await screen.findByRole("button", { name: "Undo" });
    const edit = screen.getByRole("button", { name: "Edit latest" });
    expect(undo).toHaveAttribute("aria-keyshortcuts", "Control+Alt+Z Meta+Alt+Z");
    expect(edit).toHaveAttribute("aria-keyshortcuts", "Control+Shift+E Meta+Shift+E");
    edit.focus();

    postMessage.mockClear();
    const columnSearch = screen.getByPlaceholderText("Search columns");
    fireEvent.keyDown(columnSearch, { key: "z", ctrlKey: true, altKey: true });
    expect(runtimeRequestKinds()).not.toContain("undoStep");

    fireEvent.keyDown(edit, { key: "e", ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Edit cleaning step" })).toBeInTheDocument();
    expect(screen.getByTestId("app-workspace")).toHaveAttribute("inert");
    expect(screen.getByTestId("app-workspace")).toHaveAttribute("aria-hidden", "true");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      fireEvent.keyDown(screen.getByPlaceholderText("Search operations"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit cleaning step" })).toBeNull());
      await waitFor(() => expect(edit).toHaveFocus());
    } finally {
      hasFocus.mockRestore();
    }
    expect(screen.getByTestId("app-workspace")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("app-workspace")).not.toHaveAttribute("aria-hidden");

    fireEvent.keyDown(undo, { key: "z", ctrlKey: true, altKey: true });
    fireEvent.keyDown(undo, { key: "z", ctrlKey: true, altKey: true });
    expect(runtimeRequestKinds().filter((kind) => kind === "undoStep")).toHaveLength(1);
    expect(undo).toBeDisabled();
  });

  it("does not restore operation focus when the host owns focus as the close frame is scheduled", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: appliedMetadata, page, summaries: [] });
    const edit = await screen.findByRole("button", { name: "Edit latest" });
    edit.focus();
    fireEvent.keyDown(edit, { key: "e", ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Edit cleaning step" })).toBeInTheDocument();

    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      fireEvent.keyDown(screen.getByPlaceholderText("Search operations"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit cleaning step" })).toBeNull());
      expect(frames).toHaveLength(1);
      focus.mockClear();
      hasFocus.mockReturnValue(true);
      act(() => {
        for (const frame of frames) frame(performance.now());
      });
      expect(focus).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
      hasFocus.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("restores focused Undo to Add step only after the last applied step is removed", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: appliedMetadata, page, summaries: [] });
    const undo = await screen.findByRole("button", { name: "Undo" });
    undo.focus();

    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      fireEvent.click(undo);
      expect(runtimeRequestKinds()).toContain("undoStep");
      dispatch({
        kind: "planUpdated",
        action: "undo",
        revision: 2,
        metadata: { ...appliedMetadata, revision: 2, steps: [] },
        page,
        code: "def clean_data(df):\n"
      });

      const addStep = await screen.findByRole("button", { name: "Add step" });
      await waitFor(() => expect(addStep).toHaveFocus());
      expect(screen.queryByRole("group", { name: "Cleaning plan" })).toBeNull();
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("restores focused shortcut Undo to Add step only after the last applied step is removed", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: appliedMetadata, page, summaries: [] });
    const undo = await screen.findByRole("button", { name: "Undo" });
    undo.focus();

    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      fireEvent.keyDown(undo, { key: "z", ctrlKey: true, altKey: true });
      expect(runtimeRequestKinds()).toContain("undoStep");
      dispatch({
        kind: "planUpdated",
        action: "undo",
        revision: 2,
        metadata: { ...appliedMetadata, revision: 2, steps: [] },
        page,
        code: "def clean_data(df):\n"
      });

      await waitFor(() => expect(screen.getByRole("button", { name: "Add step" })).toHaveFocus());
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("does not reclaim focus after the last-step undo when the webview no longer owns it", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: appliedMetadata, page, summaries: [] });
    const undo = await screen.findByRole("button", { name: "Undo" });
    undo.focus();

    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    try {
      fireEvent.click(undo);
      hasFocus.mockReturnValue(false);
      requestFrame.mockClear();
      dispatch({
        kind: "planUpdated",
        action: "undo",
        revision: 2,
        metadata: { ...appliedMetadata, revision: 2, steps: [] },
        page,
        code: "def clean_data(df):\n"
      });

      const addStep = await screen.findByRole("button", { name: "Add step" });
      expect(addStep).not.toHaveFocus();
      expect(requestFrame).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
      hasFocus.mockRestore();
    }
  });

  it("does not reclaim focus after the user leaves Undo for another webview control", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: appliedMetadata, page, summaries: [] });
    const undo = await screen.findByRole("button", { name: "Undo" });
    const app = screen.getByRole("main");
    undo.focus();

    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    try {
      fireEvent.click(undo);
      app.focus();
      requestFrame.mockClear();
      dispatch({
        kind: "planUpdated",
        action: "undo",
        revision: 2,
        metadata: { ...appliedMetadata, revision: 2, steps: [] },
        page,
        code: "def clean_data(df):\n"
      });

      expect(app).toHaveFocus();
      expect(screen.getByRole("button", { name: "Add step" })).not.toHaveFocus();
      expect(requestFrame).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
      hasFocus.mockRestore();
    }
  });
});

function dispatch(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

function runtimeRequestKinds(): string[] {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.kind === "runtimeRequest")
    .map((message) => message.request.kind);
}
