import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadata, TransformStep } from "../shared/protocol";
import { SessionModeControl } from "../webviews/SessionModeControl";

const appliedStep = {
  id: "step-1",
  kind: "sortRows",
  params: {
    rules: [{ column: { id: "c:value", name: "value" }, direction: "asc", nulls: "last" }]
  }
} as TransformStep;

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
  backend: "pandas",
  mode: "viewing",
  source: {
    kind: "notebookVariable",
    label: "orders",
    variableName: "orders",
    uri: "file:///workspace/orders.ipynb"
  },
  capabilities: {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: true,
    filter: true,
    sort: true,
    profile: true,
    columnValues: true,
    supportedOperations: ["sortRows"]
  },
  shape: { rows: 3, columns: 1 },
  filteredShape: { rows: 3, columns: 1 },
  schema: [{ id: "c:value", name: "value", position: 0, rawType: "int64", type: "integer", nullable: false }],
  filterModel: { filters: [], sort: [] },
  steps: []
};

describe("SessionModeControl", () => {
  it("explains Viewing and offers an accessible Editing transition", () => {
    const onSwitch = vi.fn();
    render(<SessionModeControl metadata={metadata} busy={false} onSwitch={onSwitch} />);

    const action = screen.getByRole("button", { name: "Switch to Editing" });
    expect(action).toHaveAttribute("aria-describedby", "openwrangler-session-mode-help");
    fireEvent.click(action);
    expect(onSwitch).toHaveBeenCalledWith("editing", action);

    const mode = screen.getByText("viewing").closest("summary");
    expect(mode).toHaveAttribute("data-session-badge", "mode");
    fireEvent.click(mode!);
    expect(
      screen.getByText(/Viewing lets you explore this live dataframe without creating a cleaning plan/u)
    ).toBeVisible();
    expect(screen.getByText(/source stays unchanged/u)).toBeVisible();
  });

  it("offers Viewing only while no cleaning work would be lost", () => {
    const onSwitch = vi.fn();
    const { rerender } = render(
      <SessionModeControl metadata={{ ...metadata, mode: "editing" }} busy={false} onSwitch={onSwitch} />
    );

    const safeAction = screen.getByRole("button", { name: "Switch to Viewing" });
    expect(safeAction).toBeEnabled();
    fireEvent.click(safeAction);
    expect(onSwitch).toHaveBeenCalledWith("viewing", safeAction);

    rerender(
      <SessionModeControl
        metadata={{ ...metadata, mode: "editing", steps: [appliedStep], draftStep: appliedStep }}
        busy={false}
        onSwitch={onSwitch}
      />
    );
    const blockedAction = screen.getByRole("button", { name: "Switch to Viewing" });
    expect(blockedAction).toBeDisabled();
    expect(blockedAction).toHaveAttribute(
      "title",
      "Discard the current draft, then undo the applied step before switching to Viewing."
    );
    fireEvent.click(screen.getByText("editing").closest("summary")!);
    expect(screen.getByText(/Discard the current draft, then undo the applied step/u)).toBeVisible();
  });

  it("does not advertise unavailable mode switches for ordinary editing sources", () => {
    const sources: SessionMetadata["source"][] = [
      { kind: "file", label: "orders.csv", path: "/workspace/orders.csv" },
      {
        kind: "documentVariable",
        label: "orders",
        variableName: "orders",
        uri: "file:///workspace/orders.R"
      }
    ];

    for (const source of sources) {
      const view = render(
        <SessionModeControl
          metadata={{ ...metadata, mode: "editing", source, steps: [appliedStep], draftStep: appliedStep }}
          busy={false}
          onSwitch={() => undefined}
        />
      );

      expect(screen.queryByRole("button", { name: /Switch to/iu })).toBeNull();
      fireEvent.click(screen.getByText("editing").closest("summary")!);
      expect(
        screen.getByText("Editing builds a separate cleaning plan. Open Wrangler keeps the source unchanged.")
      ).toBeVisible();
      expect(screen.queryByText(/Switch to Viewing|Discard the current draft|undo the applied step/iu)).toBeNull();
      view.unmount();
    }
  });

  it("explains read-only PySpark and DuckDB live sessions", () => {
    const onSwitch = vi.fn();
    const pyspark = render(
      <SessionModeControl
        metadata={{
          ...metadata,
          backend: "pyspark",
          capabilities: { ...metadata.capabilities, notebookInsert: false, supportedOperations: [] }
        }}
        busy={false}
        onSwitch={onSwitch}
      />
    );

    expect(screen.queryByRole("button", { name: /Switch to/iu })).toBeNull();
    expect(screen.getByText("Viewing only")).toBeVisible();
    fireEvent.click(screen.getByText("Viewing only").closest("summary")!);
    expect(screen.getByText(/Cleaning steps, generated code, and data export are not available/u)).toBeVisible();
    pyspark.unmount();

    render(
      <SessionModeControl
        metadata={{
          ...metadata,
          backend: "duckdb",
          capabilities: { ...metadata.capabilities, notebookInsert: false, supportedOperations: [] }
        }}
        busy={false}
        onSwitch={onSwitch}
      />
    );
    fireEvent.click(screen.getByText("Viewing only").closest("summary")!);
    expect(screen.getByText(/live DuckDB notebook relations/u)).toBeVisible();
    expect(screen.getByText(/code insertion, and data export are not available/u)).toBeVisible();
  });

  it("distinguishes a saved snapshot from a live editable dataframe", () => {
    render(
      <SessionModeControl
        metadata={{
          ...metadata,
          source: { kind: "notebookOutput", label: "Saved orders" },
          capabilities: { ...metadata.capabilities, notebookInsert: false, supportedOperations: [] }
        }}
        busy={false}
        onSwitch={() => undefined}
      />
    );

    expect(screen.queryByRole("button", { name: /Switch to/iu })).toBeNull();
    fireEvent.click(screen.getByText("Viewing only").closest("summary")!);
    expect(screen.getByText(/saved notebook snapshot, not a live dataframe/u)).toBeVisible();
  });
});
