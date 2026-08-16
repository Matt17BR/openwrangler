import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadata, TransformStep } from "../shared/protocol";
import { OperationBuilder } from "../webviews/operations/OperationBuilder";

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
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

describe("Fill Missing operation fields", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fills a numeric column with its median by default", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Method")).toHaveValue("median");
    expect(screen.getByLabelText("Column")).toHaveValue("c:1");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        kind: "fillMissingValues",
        params: { column: { id: "c:1", name: "sales" }, replacement: { kind: "median" } }
      })
    );
  });

  it("offers mean only for float columns and serializes the selected method", () => {
    const onPreview = vi.fn();
    const columns = [
      metadata.schema[0],
      metadata.schema[1],
      { id: "c:2", name: "units", position: 2, rawType: "Int64", type: "integer", nullable: true }
    ] satisfies SessionMetadata["schema"];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const column = screen.getByLabelText("Column");
    const method = screen.getByLabelText("Method");
    expect(method).toHaveValue("median");
    expect(within(method).getByRole("option", { name: "Mean" })).toBeInTheDocument();

    fireEvent.change(method, { target: { value: "mean" } });
    expect(screen.getByText(/Uses the mean of all non-missing values/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      column: { id: "c:1", name: "sales" },
      replacement: { kind: "mean" }
    });

    fireEvent.change(column, { target: { value: "c:2" } });
    expect(method).toHaveValue("median");
    expect(within(method).queryByRole("option", { name: "Mean" })).toBeNull();
  });

  it("restores a saved mean fill without changing its column identity", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "fill-sales",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:1", name: "sales" },
        replacement: { kind: "mean" }
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Column")).toHaveValue("c:1");
    expect(screen.getByLabelText("Method")).toHaveValue("mean");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it("builds linear interpolation from a typed coordinate and ignores the current view", () => {
    const onPreview = vi.fn();
    const columns = [
      { id: "c:0", name: "amount", position: 0, rawType: "Float64", type: "float", nullable: true },
      { id: "c:1", name: "event_date", position: 1, rawType: "Date", type: "date", nullable: false },
      { id: "c:2", name: "sequence", position: 2, rawType: "Int64", type: "integer", nullable: false },
      { id: "c:3", name: "r_wide", position: 3, rawType: "integer64", type: "integer", nullable: false },
      { id: "c:4", name: "duckdb_wide", position: 4, rawType: "UHUGEINT", type: "integer", nullable: false },
      { id: "c:5", name: "label", position: 5, rawType: "String", type: "string", nullable: false }
    ] satisfies SessionMetadata["schema"];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 5, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns
        }}
        filterModel={{
          filters: [],
          sort: [{ column: "sequence", direction: "desc", nulls: "first" }]
        }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const method = screen.getByLabelText("Method");
    expect(within(method).getByRole("option", { name: "Linear interpolation" })).toBeInTheDocument();
    fireEvent.change(method, { target: { value: "linearInterpolation" } });

    const coordinate = screen.getByLabelText("Coordinate column");
    expect(coordinate).toHaveValue("c:1");
    expect(within(coordinate).getByRole("option", { name: "event_date" })).toBeInTheDocument();
    expect(within(coordinate).getByRole("option", { name: "sequence" })).toBeInTheDocument();
    expect(within(coordinate).queryByRole("option", { name: "amount" })).toBeNull();
    expect(within(coordinate).queryByRole("option", { name: "r_wide" })).toBeNull();
    expect(within(coordinate).queryByRole("option", { name: "duckdb_wide" })).toBeNull();
    expect(within(coordinate).queryByRole("option", { name: "label" })).toBeNull();
    fireEvent.change(coordinate, { target: { value: "c:2" } });

    const maximumGap = screen.getByLabelText("Maximum missing cells in a run (optional)");
    expect(maximumGap).toHaveAccessibleDescription(
      "Leave this blank to interpolate runs of any length. A longer run stays missing."
    );
    fireEvent.change(maximumGap, { target: { value: "4" } });
    expect(screen.getByText(/finite values exist on both sides/u)).toBeInTheDocument();
    expect(screen.getByText(/Current view filters and sorts are ignored/u)).toBeInTheDocument();
    expect(screen.getByText(/row order does not change/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      column: { id: "c:0", name: "amount" },
      replacement: {
        kind: "linearInterpolation",
        coordinate: { id: "c:2", name: "sequence" },
        maxGap: 4
      }
    });
  });

  it("restores interpolation settings and rejects an invalid maximum run", () => {
    const columns = [
      { id: "c:0", name: "amount", position: 0, rawType: "Float64", type: "float", nullable: true },
      { id: "c:1", name: "event_time", position: 1, rawType: "Datetime", type: "datetime", nullable: false }
    ] satisfies SessionMetadata["schema"];
    const initialStep = {
      id: "interpolate-amount",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:0", name: "amount" },
        replacement: {
          kind: "linearInterpolation",
          coordinate: { id: "c:1", name: "event_time" },
          maxGap: 8
        }
      }
    } satisfies TransformStep;
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 5, columns: columns.length },
          filteredShape: { rows: 5, columns: columns.length },
          schema: columns,
          latestStepInputSchema: columns,
          steps: [initialStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Method")).toHaveValue("linearInterpolation");
    expect(screen.getByLabelText("Coordinate column")).toHaveValue("c:1");
    const maximumGap = screen.getByLabelText("Maximum missing cells in a run (optional)");
    expect(maximumGap).toHaveValue(8);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);

    const form = screen.getByRole("button", { name: "Preview changes" }).closest("form") as HTMLFormElement;
    for (const invalid of ["0", "1.5", "1000001"]) {
      fireEvent.change(maximumGap, { target: { value: invalid } });
      fireEvent.submit(form);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Maximum missing cells in a run must be a whole number from 1 to 1,000,000."
      );
    }
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("builds a grouped numeric fill with multiple compatible keys", () => {
    const onPreview = vi.fn();
    const columns = [
      { id: "c:0", name: "amount", position: 0, rawType: "Float64", type: "float", nullable: true },
      { id: "c:1", name: "region", position: 1, rawType: "String", type: "string", nullable: false },
      { id: "c:2", name: "cohort", position: 2, rawType: "Int64", type: "integer", nullable: false },
      { id: "c:3", name: "payload", position: 3, rawType: "Binary", type: "binary", nullable: false }
    ] satisfies SessionMetadata["schema"];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns
        }}
        filterModel={{
          filters: [],
          sort: [{ column: "region", direction: "desc", nulls: "first" }]
        }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const method = screen.getByLabelText("Method");
    expect(within(method).getByRole("option", { name: "Median within groups" })).toBeInTheDocument();
    expect(within(method).getByRole("option", { name: "Mean within groups" })).toBeInTheDocument();
    fireEvent.change(method, { target: { value: "groupedMean" } });

    const groupBy = screen.getByRole("group", { name: "Group by" });
    expect(within(groupBy).queryByRole("checkbox", { name: "amount" })).toBeNull();
    expect(within(groupBy).queryByRole("checkbox", { name: "payload" })).toBeNull();
    expect(within(groupBy).getByRole("checkbox", { name: "region" })).toBeChecked();
    expect(within(groupBy).getByRole("checkbox", { name: "cohort" })).not.toBeChecked();
    const groupSearch = within(groupBy).getByRole("searchbox", { name: "Search group columns" });
    fireEvent.change(groupSearch, { target: { value: "cohort" } });
    expect(within(groupBy).queryByRole("checkbox", { name: "region" })).toBeNull();
    expect(within(groupBy).getByRole("checkbox", { name: "cohort" })).toBeInTheDocument();
    fireEvent.click(within(groupBy).getByRole("checkbox", { name: "cohort" }));
    expect(within(groupBy).getByText("Selected (2): region, cohort", { exact: true })).toBeInTheDocument();
    fireEvent.change(groupSearch, { target: { value: "" } });
    expect(screen.getByText(/Uses data after earlier cleaning steps/u)).toBeInTheDocument();
    expect(screen.getByText(/Filters and sorts in the current view are ignored/u)).toBeInTheDocument();
    expect(screen.getByText(/row order stays unchanged/u)).toBeInTheDocument();
    expect(screen.getByText(/Missing values in a grouping column match/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      column: { id: "c:0", name: "amount" },
      replacement: {
        kind: "groupedStatistic",
        statistic: "mean",
        keys: [
          { id: "c:1", name: "region" },
          { id: "c:2", name: "cohort" }
        ]
      }
    });

    fireEvent.click(within(groupBy).getByRole("checkbox", { name: "region" }));
    fireEvent.click(within(groupBy).getByRole("checkbox", { name: "cohort" }));
    fireEvent.submit(screen.getByRole("button", { name: "Preview changes" }).closest("form") as HTMLFormElement);
    expect(screen.getByRole("alert")).toHaveTextContent("Grouped fill requires at least one compatible column.");
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("offers grouped methods by target type and explains bounded medians", () => {
    const columns = [
      { id: "c:0", name: "units", position: 0, rawType: "Int64", type: "integer", nullable: true },
      { id: "c:1", name: "ratio", position: 1, rawType: "Float64", type: "float", nullable: true },
      { id: "c:2", name: "label", position: 2, rawType: "factor", type: "string", nullable: true },
      { id: "c:3", name: "active", position: 3, rawType: "Boolean", type: "boolean", nullable: true },
      { id: "c:4", name: "group", position: 4, rawType: "Date", type: "date", nullable: false }
    ] satisfies SessionMetadata["schema"];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    const column = screen.getByLabelText("Column");
    const method = screen.getByLabelText("Method");
    expect(method).toHaveAccessibleDescription("Available methods are based on the selected integer column.");
    expect(Array.from(method.querySelectorAll("optgroup"), (group) => group.label)).toEqual([
      "Column statistics",
      "Within groups",
      "Ordered data",
      "Manual"
    ]);
    fireEvent.change(method, { target: { value: "groupedMedian" } });
    expect(screen.getByText(/Preview fails if a group median cannot fit the column type/u)).toBeInTheDocument();
    expect(within(method).queryByRole("option", { name: "Mean within groups" })).toBeNull();

    fireEvent.change(column, { target: { value: "c:1" } });
    expect(method).toHaveAccessibleDescription("Available methods are based on the selected number column.");
    expect(within(method).getByRole("option", { name: "Mean within groups" })).toBeInTheDocument();
    fireEvent.change(column, { target: { value: "c:2" } });
    expect(method).toHaveAccessibleDescription("Available methods are based on the selected category column.");
    expect(within(method).getByRole("option", { name: "Most common value within groups" })).toBeInTheDocument();
    expect(within(method).queryByRole("option", { name: "Median within groups" })).toBeNull();
    fireEvent.change(method, { target: { value: "groupedMostFrequent" } });
    expect(screen.getByText(/no non-missing value or a tie stays missing/u)).toBeInTheDocument();
    fireEvent.change(column, { target: { value: "c:3" } });
    expect(within(method).getByRole("option", { name: "Most common value within groups" })).toBeInTheDocument();
  });

  it("restores grouped keys and prunes a key that becomes the target", () => {
    const columns = [
      { id: "c:0", name: "amount", position: 0, rawType: "Float64", type: "float", nullable: true },
      { id: "c:1", name: "region", position: 1, rawType: "String", type: "string", nullable: false },
      { id: "c:2", name: "segment", position: 2, rawType: "String", type: "string", nullable: true }
    ] satisfies SessionMetadata["schema"];
    const initialStep = {
      id: "fill-amount-by-group",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:0", name: "amount" },
        replacement: {
          kind: "groupedStatistic",
          statistic: "median",
          keys: [
            { id: "c:2", name: "segment" },
            { id: "c:1", name: "region" }
          ]
        }
      }
    } satisfies TransformStep;
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns,
          latestStepInputSchema: columns,
          steps: [initialStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Method")).toHaveValue("groupedMedian");
    let groupBy = screen.getByRole("group", { name: "Group by" });
    expect(within(groupBy).getByRole("checkbox", { name: "segment" })).toBeChecked();
    expect(within(groupBy).getByRole("checkbox", { name: "region" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);

    fireEvent.change(screen.getByLabelText("Column"), { target: { value: "c:2" } });
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "groupedMostFrequent" } });
    groupBy = screen.getByRole("group", { name: "Group by" });
    expect(within(groupBy).queryByRole("checkbox", { name: "segment" })).toBeNull();
    expect(within(groupBy).getByRole("checkbox", { name: "region" })).toBeChecked();
    expect(within(groupBy).getByRole("checkbox", { name: "amount" })).not.toBeChecked();
  });

  it("offers the most common value for text columns and uses their full-column method", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText("Column"), { target: { value: "c:0" } });
    expect(screen.getByLabelText("Method")).toHaveAccessibleName("Method");
    expect(screen.getByLabelText("Method")).toHaveValue("mostFrequent");
    expect(screen.getByRole("option", { name: "Most common value" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Median" })).toBeNull();
    expect(screen.getByText(/Filters in the current view do not affect/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      column: { id: "c:0", name: "city" },
      replacement: { kind: "mostFrequent" }
    });
  });

  it("restores a saved most-common fill without changing its column identity", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "fill-city",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:0", name: "city" },
        replacement: { kind: "mostFrequent" }
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Column")).toHaveValue("c:0");
    expect(screen.getByLabelText("Method")).toHaveValue("mostFrequent");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it("builds an ordered previous-value fill independently of the current view sort", () => {
    const onPreview = vi.fn();
    const columns = [
      { id: "c:0", name: "amount", position: 0, rawType: "Float64", type: "float", nullable: true },
      { id: "c:1", name: "event_time", position: 1, rawType: "Datetime", type: "datetime", nullable: false },
      { id: "c:2", name: "account", position: 2, rawType: "String", type: "string", nullable: false },
      { id: "c:3", name: "payload", position: 3, rawType: "Binary", type: "binary", nullable: false }
    ] satisfies SessionMetadata["schema"];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns
        }}
        filterModel={{
          filters: [],
          sort: [{ column: "account", direction: "desc", nulls: "first" }]
        }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "directionalForward" } });
    const firstOrderColumn = screen.getByLabelText("Order column 1");
    expect(firstOrderColumn).toHaveValue("c:1");
    expect(within(firstOrderColumn).queryByRole("option", { name: "amount" })).toBeNull();
    expect(within(firstOrderColumn).queryByRole("option", { name: "payload" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add order column" }));
    expect(screen.getByLabelText("Order column 2")).toHaveValue("c:2");
    expect(screen.getByRole("button", { name: "Add order column" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Direction 2"), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText("Order missing values 2"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Move fill order rule 2 up" }));

    const maximumGap = screen.getByLabelText("Maximum gap length (optional)");
    expect(maximumGap).toHaveAttribute("min", "1");
    expect(maximumGap).toHaveAttribute("max", "1000000");
    expect(maximumGap).toHaveAccessibleDescription(
      "Leave this blank to fill runs of any length. If a missing run is longer than the limit, the whole run stays missing."
    );
    fireEvent.change(maximumGap, { target: { value: "3" } });
    expect(
      screen.getByText(/If a missing run is longer than the limit, the whole run stays missing/u)
    ).toBeInTheDocument();
    expect(screen.getByText(/Current view filters and sorts do not affect the calculation/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      column: { id: "c:0", name: "amount" },
      replacement: {
        kind: "directional",
        direction: "forward",
        orderBy: [
          { column: { id: "c:2", name: "account" }, direction: "desc", nulls: "first" },
          { column: { id: "c:1", name: "event_time" }, direction: "asc", nulls: "last" }
        ],
        maxGap: 3
      }
    });
  });

  it("rejects an invalid maximum gap before previewing", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "directionalForward" } });
    const maximumGap = screen.getByLabelText("Maximum gap length (optional)");
    const form = screen.getByRole("button", { name: "Preview changes" }).closest("form") as HTMLFormElement;
    for (const invalid of ["0", "1.5", "1000001"]) {
      fireEvent.change(maximumGap, { target: { value: invalid } });
      fireEvent.submit(form);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Maximum gap length must be a whole number from 1 to 1,000,000."
      );
      expect(onPreview).not.toHaveBeenCalled();
    }

    fireEvent.change(maximumGap, { target: { value: "2" } });
    fireEvent.submit(form);
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("restores a saved next-value fill with its compound calculation order", () => {
    const columns = [
      { id: "c:0", name: "amount", position: 0, rawType: "Float64", type: "float", nullable: true },
      { id: "c:1", name: "event_time", position: 1, rawType: "Datetime", type: "datetime", nullable: false },
      { id: "c:2", name: "account", position: 2, rawType: "String", type: "string", nullable: false }
    ] satisfies SessionMetadata["schema"];
    const initialStep = {
      id: "fill-amount",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:0", name: "amount" },
        replacement: {
          kind: "directional",
          direction: "backward",
          orderBy: [
            { column: { id: "c:2", name: "account" }, direction: "desc", nulls: "first" },
            { column: { id: "c:1", name: "event_time" }, direction: "asc", nulls: "last" }
          ],
          maxGap: 8
        }
      }
    } satisfies TransformStep;
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns,
          latestStepInputSchema: columns,
          steps: [initialStep]
        }}
        filterModel={{
          filters: [],
          sort: [{ column: "event_time", direction: "desc", nulls: "first" }]
        }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Method")).toHaveValue("directionalBackward");
    expect(screen.getByLabelText("Order column 1")).toHaveValue("c:2");
    expect(screen.getByLabelText("Direction 1")).toHaveValue("desc");
    expect(screen.getByLabelText("Order missing values 1")).toHaveValue("first");
    expect(screen.getByLabelText("Order column 2")).toHaveValue("c:1");
    expect(screen.getByLabelText("Direction 2")).toHaveValue("asc");
    expect(screen.getByLabelText("Order missing values 2")).toHaveValue("last");
    expect(screen.getByLabelText("Maximum gap length (optional)")).toHaveValue(8);
    expect(screen.getByText(/A missing run at the end can stay missing/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it("orders same-row fallback columns and serializes their stable references", () => {
    const onPreview = vi.fn();
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0, nullable: true },
      { ...metadata.schema[0], id: "c:1", name: "backup", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "backup", position: 2 },
      { ...metadata.schema[1], id: "c:3", name: "amount", position: 3 }
    ];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const method = screen.getByLabelText("Method");
    expect(within(method).getByRole("option", { name: "Fallback columns (same row)" })).toBeInTheDocument();
    fireEvent.change(method, { target: { value: "fallbackColumns" } });
    const first = screen.getByLabelText("Fallback 1");
    expect(first).toHaveValue("c:1");
    expect(within(first).queryByRole("option", { name: "value" })).toBeNull();
    expect(within(first).queryByRole("option", { name: "amount" })).toBeNull();
    expect(screen.getByText(/Only columns with the same type are available/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add fallback column" }));
    expect(screen.getByLabelText("Fallback 2")).toHaveValue("c:2");
    fireEvent.click(screen.getByRole("button", { name: "Move fallback column 2 up" }));
    expect(screen.getByLabelText("Fallback 1")).toHaveValue("c:2");
    expect(screen.getByLabelText("Fallback 2")).toHaveValue("c:1");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview.mock.calls[0][0].params).toEqual({
      column: { id: "c:0", name: "value" },
      replacement: {
        kind: "fallbackColumns",
        columns: [
          { id: "c:2", name: "backup" },
          { id: "c:1", name: "backup" }
        ]
      }
    });
  });

  it("restores fallback order when editing and prunes incompatible rows after a target change", () => {
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0, nullable: true },
      { ...metadata.schema[0], id: "c:1", name: "backup_a", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "backup_b", position: 2 },
      { ...metadata.schema[1], id: "c:3", name: "amount", position: 3, nullable: true },
      { ...metadata.schema[1], id: "c:4", name: "amount_backup", position: 4 }
    ];
    const initialStep = {
      id: "fill-value",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:0", name: "value" },
        replacement: {
          kind: "fallbackColumns",
          columns: [
            { id: "c:2", name: "backup_b" },
            { id: "c:1", name: "backup_a" }
          ]
        }
      }
    } satisfies TransformStep;
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: columns.length },
          filteredShape: { rows: 2, columns: columns.length },
          schema: columns,
          latestStepInputSchema: columns,
          steps: [initialStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Method")).toHaveValue("fallbackColumns");
    expect(screen.getByLabelText("Fallback 1")).toHaveValue("c:2");
    expect(screen.getByLabelText("Fallback 2")).toHaveValue("c:1");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);

    fireEvent.change(screen.getByLabelText("Column"), { target: { value: "c:3" } });
    expect(screen.getByLabelText("Method")).toHaveValue("fallbackColumns");
    expect(screen.getByLabelText("Fallback 1")).toHaveValue("c:4");
    expect(screen.queryByLabelText("Fallback 2")).toBeNull();
    expect(within(screen.getByLabelText("Fallback 1")).queryByRole("option", { name: "backup_a" })).toBeNull();
  });

  it("shows only methods valid for the selected datatype", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: 6 },
          filteredShape: { rows: 2, columns: 6 },
          schema: [
            { id: "c:0", name: "active", position: 0, rawType: "Boolean", type: "boolean", nullable: true },
            { id: "c:1", name: "joined", position: 1, rawType: "Date", type: "date", nullable: true },
            { id: "c:2", name: "mystery", position: 2, rawType: "Null", type: "unknown", nullable: true },
            { id: "c:3", name: "payload", position: 3, rawType: "Binary", type: "binary", nullable: true },
            { id: "c:4", name: "tags", position: 4, rawType: "List(String)", type: "list", nullable: true },
            { id: "c:5", name: "elapsed", position: 5, rawType: "Duration", type: "duration", nullable: true }
          ]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const column = screen.getByLabelText("Column");
    const method = screen.getByLabelText("Method");
    expect(column.compareDocumentPosition(method) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(column).toHaveValue("c:0");
    expect(method).toHaveValue("mostFrequent");
    expect(
      within(column)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["active", "joined", "mystery", "payload", "elapsed"]);

    fireEvent.change(method, { target: { value: "value" } });
    expect(column).toHaveValue("c:0");
    fireEvent.change(column, { target: { value: "c:1" } });
    expect(method).toHaveValue("value");
    expect(
      within(method)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["Previous value", "Next value", "Specific value"]);

    fireEvent.change(column, { target: { value: "c:2" } });
    expect(screen.getByLabelText("Value type")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params.column).toEqual({ id: "c:2", name: "mystery" });

    for (const id of ["c:3", "c:5"]) {
      fireEvent.change(column, { target: { value: id } });
      expect(method).toHaveValue("directionalForward");
      expect(
        within(method)
          .getAllByRole("option")
          .map((option) => option.textContent)
      ).toEqual(["Previous value", "Next value"]);
    }
  });

  it("keeps an empty text replacement when editing a fill step", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "fill-city",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:0", name: "city" },
        replacement: { kind: "string", value: "" }
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Method")).toHaveValue("value");
    expect(screen.getByLabelText("Column")).toHaveValue("c:0");
    expect(screen.getByLabelText("Replacement value")).toHaveValue("");
    expect(screen.getByText(/specific value may convert the column to text/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it("shows and enforces the native R text replacement limit before preview", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "fill-city",
      kind: "fillMissingValues",
      params: {
        column: { id: "c:0", name: "city" },
        replacement: { kind: "string", value: "missing" }
      }
    };
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          backend: "r",
          rDataframeFlavor: "r.data.frame",
          latestStepInputSchema: metadata.schema,
          steps: [initialStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const input = screen.getByLabelText("Replacement value");
    expect(screen.getByText("R text replacements can use up to 8,192 UTF-8 bytes.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Character columns stay character. For factor columns, a new value is added as a level and the factor type is kept."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/may convert the column to text/u)).toBeNull();

    fireEvent.input(input, { target: { value: "🙂".repeat(3_000) } });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("R text replacements can use up to 8,192 UTF-8 bytes.");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).not.toHaveBeenCalled();

    fireEvent.input(input, { target: { value: "missing" } });
    expect(input).toBeValid();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("normalizes common numeric fill values before preview", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="fillMissingValues"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "value" } });
    const input = screen.getByLabelText("Replacement number");
    for (const [entered, normalized] of [
      [".5", "0.5"],
      ["1.", "1.0"],
      ["+1", "1"]
    ]) {
      fireEvent.change(input, { target: { value: entered } });
      fireEvent.blur(input);
      expect(input).toHaveValue(normalized);
      fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
      expect(onPreview.mock.calls.at(-1)?.[0].params).toEqual({
        column: { id: "c:1", name: "sales" },
        replacement: { kind: "float", value: normalized }
      });
    }
  });
});
