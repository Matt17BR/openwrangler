import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadata } from "../shared/protocol";
import { App } from "../webviews/App";
import { WebviewErrorBoundary } from "../webviews/WebviewErrorBoundary";
import { useWholeColumnClipboard } from "../webviews/grid/useWholeColumnClipboard";
import { vscode } from "../webviews/vscodeApi";

describe("WebviewErrorBoundary", () => {
  let postMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves ordinary child state and focus without publishing a diagnostic", () => {
    function StatefulChild() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount((current) => current + 1)}>Count {count}</button>;
    }

    render(
      <WebviewErrorBoundary>
        <StatefulChild />
      </WebviewErrorBoundary>
    );
    const button = screen.getByRole("button", { name: "Count 0" });
    button.focus();
    fireEvent.click(button);

    expect(screen.getByRole("button", { name: "Count 1" })).toHaveFocus();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("replaces a render failure with one focused, data-free recovery surface", () => {
    const reload = vi.fn();

    render(
      <WebviewErrorBoundary reload={reload}>
        <RenderFailure />
      </WebviewErrorBoundary>
    );

    const action = screen.getByRole("button", { name: "Reload Open Wrangler" });
    expect(screen.getByRole("alert")).toHaveAccessibleName("Open Wrangler needs to reload");
    expect(action).toHaveFocus();
    expect(screen.queryByText(/private render value/u)).not.toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ kind: "webviewFailure", phase: "react" });

    fireEvent.click(action);
    fireEvent.click(action);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Reload requested" })).toBeDisabled();
  });

  it("contains an effect failure without leaving a blank workbench", async () => {
    function EffectFailure() {
      useEffect(() => {
        throw new Error("private effect value");
      }, []);
      return <span>Effect pending</span>;
    }

    render(
      <WebviewErrorBoundary reload={() => undefined}>
        <EffectFailure />
      </WebviewErrorBoundary>
    );

    expect(await screen.findByRole("button", { name: "Reload Open Wrangler" })).toHaveFocus();
    expect(screen.queryByText(/private effect value/u)).not.toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ kind: "webviewFailure", phase: "react" });
  });

  it("contains a same-origin message-handler failure and keeps its payload out of diagnostics", async () => {
    render(
      <WebviewErrorBoundary reload={() => undefined}>
        <App />
      </WebviewErrorBoundary>
    );
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: "ready" }));

    const hostileMessage = {};
    Object.defineProperty(hostileMessage, "kind", {
      get: () => {
        throw new Error("private message payload");
      }
    });
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: hostileMessage, origin: window.location.origin }));
    });

    expect(await screen.findByRole("button", { name: "Reload Open Wrangler" })).toHaveFocus();
    expect(postMessage).toHaveBeenCalledWith({ kind: "webviewFailure", phase: "message" });
    expect(postMessage.mock.calls).not.toContainEqual([expect.objectContaining({ message: expect.anything() })]);
    expect(screen.queryByText(/private message payload/u)).not.toBeInTheDocument();
  });

  it("contains a failure from the whole-column response listener", async () => {
    render(
      <WebviewErrorBoundary reload={() => undefined}>
        <WholeColumnClipboardListener />
      </WebviewErrorBoundary>
    );
    expect(screen.getByText("Whole-column listener ready")).toBeInTheDocument();

    const hostileMessage = {};
    Object.defineProperty(hostileMessage, "kind", {
      get: () => {
        throw new Error("private whole-column payload");
      }
    });
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: hostileMessage, origin: window.location.origin }));
    });

    expect(await screen.findByRole("button", { name: "Reload Open Wrangler" })).toHaveFocus();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ kind: "webviewFailure", phase: "message" });
    expect(screen.queryByText(/private whole-column payload/u)).not.toBeInTheDocument();
  });
});

function RenderFailure(): never {
  throw new Error("private render value");
}

function WholeColumnClipboardListener() {
  useWholeColumnClipboard({ metadata: clipboardMetadata, pageSize: 2, viewContextId: "view-a" });
  return <span>Whole-column listener ready</span>;
}

const clipboardMetadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "clipboard-session",
  revision: 0,
  backend: "pandas",
  mode: "editing",
  source: { kind: "file", label: "clipboard.csv", path: "clipboard.csv" },
  capabilities: {
    editable: true,
    lazy: false,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 1 },
  filteredShape: { rows: 2, columns: 1 },
  rowAxis: { kind: "positional", levelNames: [] },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [{ id: "c:0", name: "city", position: 0, rawType: "object", type: "string", nullable: false }]
};
