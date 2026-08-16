import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadata, TransformStep } from "../shared/protocol";
import { OperationBuilder } from "../webviews/operations/OperationBuilder";

const columns = [
  { id: "c:0", name: "value", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:1", name: "value", position: 1, rawType: "String", type: "string", nullable: true },
  { id: "c:2", name: "7", position: 2, rawType: "Float64", type: "float", nullable: true }
] satisfies SessionMetadata["schema"];

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
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
  shape: { rows: 2, columns: columns.length },
  filteredShape: { rows: 2, columns: columns.length },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: columns,
  latestStepInputSchema: columns
};

describe("OperationBuilder saved-step forms", () => {
  it("restores saved group references from the recorded input schema", () => {
    const onPreview = vi.fn();
    const savedStep = {
      id: "saved-group",
      kind: "groupBy",
      params: {
        keys: [{ id: "c:1", name: "value" }],
        aggregations: [{ column: { id: "c:2", name: "7" }, operation: "sum", alias: "total" }]
      }
    } satisfies TransformStep;

    render(
      <OperationBuilder
        metadata={{ ...metadata, steps: [savedStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={savedStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByText("Selected order: value, column 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Value 1")).toHaveValue("c:2");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("restores saved by-example source IDs without retaining synthesis-only fields", () => {
    const onPreview = vi.fn();
    const savedStep = {
      id: "saved-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c:1", name: "value" }],
        newColumn: "upper",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "case", style: "upper", input: { kind: "column", column: { id: "c:1", name: "value" } } },
        warnings: ["Ambiguous examples: preview carefully."],
        candidateCount: 2
      }
    } satisfies TransformStep;

    render(
      <OperationBuilder
        metadata={{ ...metadata, steps: [savedStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={savedStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByText("Selected order: value, column 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });
});
