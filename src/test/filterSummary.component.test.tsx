import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSummary, SessionMetadata } from "../shared/protocol";
import type { ProfileValueMode } from "../webviews/profileValueMode";
import { SummaryPanel } from "../webviews/summary/SummaryPanel";
import { metadata } from "./filterSummary.testFixtures";

describe("SummaryPanel", () => {
  const numericSummary: ColumnSummary = {
    columnId: "c:1",
    column: "sales",
    type: "float",
    rawType: "Float64",
    totalCount: 4,
    nullCount: 1,
    nanCount: 2,
    distinctCount: 2,
    topValues: [
      { value: "12", count: 2 },
      { value: "10", count: 1 }
    ],
    numeric: { min: 10, max: 12, mean: Number.NaN, median: 12 },
    visualization: {
      kind: "numeric",
      bins: [
        { min: 10, max: 11, count: 1 },
        { min: 11, max: 12, count: 2 }
      ],
      sampled: true
    }
  };

  const categoricalSummary: ColumnSummary = {
    columnId: "c:0",
    column: "city",
    type: "string",
    rawType: "String",
    totalCount: 4,
    nullCount: 0,
    nanCount: 0,
    distinctCount: 3,
    text: { emptyCount: 1, minLength: 0, maxLength: 6, meanLength: 3.25 },
    topValues: [
      { value: "Berlin", count: 2 },
      { value: "", count: 1 }
    ],
    visualization: {
      kind: "categorical",
      categories: [
        { value: "Berlin", count: 2 },
        { value: "", count: 1 }
      ],
      otherCount: 1
    }
  };

  const renderSummary = (
    options: {
      activeView?: "column" | "dataset" | "filters";
      selectedColumnId?: string;
      metadataValue?: SessionMetadata;
      summaries?: ColumnSummary[];
      profileSupported?: boolean;
      filtersSupported?: boolean;
      viewFiltersSupported?: boolean;
      filtersDisabled?: boolean;
      filtersLabel?: string;
      filterModel?: FilterModel;
      profileValueMode?: ProfileValueMode;
      onSelectView?: (view: "column" | "dataset" | "filters") => void;
      onProfileValueModeChange?: (mode: ProfileValueMode) => void;
      onShowMoreValues?: (column: string) => void;
      onApplyFilterModel?: (model: FilterModel) => void;
    } = {}
  ) => {
    const metadataValue = options.metadataValue ?? metadata;
    return render(
      <SummaryPanel
        metadata={metadataValue}
        summaries={options.summaries ?? [categoricalSummary, numericSummary]}
        schemaById={new Map(metadataValue.schema.map((column) => [column.id, column]))}
        selectedColumnId={options.selectedColumnId}
        activeView={options.activeView ?? "column"}
        profileSupported={options.profileSupported}
        filtersSupported={options.filtersSupported}
        viewFiltersSupported={options.viewFiltersSupported}
        filtersDisabled={options.filtersDisabled}
        filtersLabel={options.filtersLabel}
        filterModel={options.filterModel}
        profileValueMode={options.profileValueMode}
        onSelectView={options.onSelectView ?? (() => undefined)}
        onProfileValueModeChange={options.onProfileValueModeChange}
        onShowMoreValues={options.onShowMoreValues}
        onApplyFilterModel={options.onApplyFilterModel}
      />
    );
  };

  it("exposes one keyboard-operable Column, Dataset, and Filters tablist", () => {
    const onSelectView = vi.fn();
    renderSummary({ activeView: "column", onSelectView });

    expect(screen.getByRole("tablist", { name: "Column profiles and filters view" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Column", "Dataset", "Filters"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(onSelectView).toHaveBeenLastCalledWith("dataset");
    expect(tabs[1]).toHaveFocus();
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(onSelectView).toHaveBeenLastCalledWith("filters");
    expect(tabs[2]).toHaveFocus();
  });

  it("keeps keyboard navigation inside the visible sort-only tab", () => {
    const onSelectView = vi.fn();
    renderSummary({
      activeView: "filters",
      profileSupported: false,
      filtersSupported: true,
      filtersLabel: "Sorts",
      onSelectView
    });

    const sorts = screen.getByRole("tab", { name: "Sorts" });
    sorts.focus();
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      fireEvent.keyDown(sorts, { key });
      expect(onSelectView).toHaveBeenLastCalledWith("filters");
      expect(sorts).toHaveFocus();
    }
    expect(screen.queryByRole("tab", { name: "Column" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Dataset" })).not.toBeInTheDocument();
  });

  it("keeps exact profiles quiet while labeling a sampled distribution", () => {
    renderSummary({ selectedColumnId: "c:1" });

    expect(screen.getByRole("tabpanel", { name: "Column" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "sales" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "city" })).not.toBeInTheDocument();
    expect(screen.getByText("Float64")).toBeInTheDocument();
    expect(screen.queryByText("Exact statistics")).not.toBeInTheDocument();
    expect(screen.queryByText("Exact distribution")).not.toBeInTheDocument();
    expect(screen.getByText("Distribution based on a sample")).toHaveAttribute(
      "title",
      "The chart uses a sample. The statistics above it use all visible rows."
    );
    expect(screen.getByText("Null").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("NaN").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Min").nextElementSibling).toHaveTextContent("10");
    expect(screen.getByText("Max").nextElementSibling).toHaveTextContent("12");
    expect(screen.getByText("Mean").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.getByRole("heading", { name: "Distribution" })).toBeInTheDocument();
    const distribution = screen.getByRole("img", {
      name: "Sampled numeric distribution with 2 bins; range 10 to 12."
    });
    expect(distribution).toBeVisible();
    expect(distribution.querySelectorAll(".numericHistogramBar")).toHaveLength(2);
    expect(distribution.closest(".numericHistogram")?.querySelector(".numericHistogramHitTarget")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Top values" })).not.toBeInTheDocument();
  });

  it("uses sampled numeric and string denominators without displaying a fake distinct zero", () => {
    const totalRows = 4_000_017;
    const largeMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: totalRows, columns: 2 },
      filteredShape: { rows: totalRows, columns: 2 }
    };
    const sampledNumeric: ColumnSummary = {
      columnId: "c:1",
      column: "sales",
      type: "float",
      rawType: "Float64",
      totalCount: totalRows,
      nullCount: 0,
      nanCount: 0,
      topValues: [],
      numeric: { min: 1, max: 3, mean: 2 },
      visualization: {
        kind: "numeric",
        bins: [
          { min: 1, max: 2, count: 60_000 },
          { min: 2, max: 3, count: 40_000 }
        ],
        sampled: true
      }
    };
    const numeric = renderSummary({
      metadataValue: largeMetadata,
      summaries: [sampledNumeric],
      selectedColumnId: "c:1",
      profileValueMode: "percent",
      onProfileValueModeChange: vi.fn(),
      onApplyFilterModel: vi.fn()
    });

    expect(screen.getByText("Distinct").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.queryByText("Distinct 0")).not.toBeInTheDocument();
    const numericPercent = screen.getByRole("button", { name: "%" });
    expect(numericPercent).not.toHaveAttribute("title");
    expect(numericPercent).not.toHaveAttribute("aria-description");
    expect(numericPercent).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /1-2: 60% \(60,000 rows\)/u })).toBeVisible();
    numeric.unmount();

    const sampledCategorical: ColumnSummary = {
      columnId: "c:0",
      column: "city",
      type: "string",
      rawType: "String",
      totalCount: totalRows,
      nullCount: 0,
      nanCount: 0,
      text: { emptyCount: 0, minLength: 5, maxLength: 6, meanLength: 5.5 },
      topValues: [
        { value: "Berlin", count: 60_000 },
        { value: "Milan", count: 40_000 }
      ],
      visualization: {
        kind: "categorical",
        categories: [
          { value: "Berlin", count: 60_000 },
          { value: "Milan", count: 40_000 }
        ],
        otherCount: 0,
        sampled: true
      }
    };
    renderSummary({
      metadataValue: largeMetadata,
      summaries: [sampledCategorical],
      selectedColumnId: "c:0",
      profileValueMode: "percent",
      onProfileValueModeChange: vi.fn()
    });

    expect(screen.getByText("Distinct").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.queryByText("Distinct 0")).not.toBeInTheDocument();
    const categoricalPercent = screen.getByRole("button", { name: "%" });
    expect(categoricalPercent).not.toHaveAttribute("title");
    expect(categoricalPercent).not.toHaveAttribute("aria-description");
    expect(categoricalPercent).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Berlin").closest(".barRow")).toHaveTextContent("60%");
  });

  it("shows full typed extrema in Column profiles with exact titles and accessible names", () => {
    const minimum = "-12345678901234567890.123456789012345678";
    const maximum = "98765432109876543210.987654321098765432";
    const decimalMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [
        {
          id: "c:amount",
          name: "amount",
          position: 0,
          rawType: "Decimal(38,18)",
          type: "decimal",
          nullable: false
        }
      ]
    };
    const decimalSummary: ColumnSummary = {
      columnId: "c:amount",
      column: "amount",
      type: "decimal",
      rawType: "Decimal(38,18)",
      totalCount: 2,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 2,
      numeric: {
        min: Number(minimum),
        max: Number(maximum),
        exactMin: { kind: "decimal", raw: minimum, display: minimum, isNull: false, isNaN: false },
        exactMax: { kind: "decimal", raw: maximum, display: maximum, isNull: false, isNaN: false }
      },
      visualization: {
        kind: "numeric",
        bins: [{ min: Number(minimum), max: Number(maximum), count: 2 }]
      },
      topValues: []
    };

    renderSummary({
      metadataValue: decimalMetadata,
      summaries: [decimalSummary],
      selectedColumnId: "c:amount"
    });

    const minimumValue = screen.getByText("Min").nextElementSibling;
    const maximumValue = screen.getByText("Max").nextElementSibling;
    expect(minimumValue).toHaveTextContent(minimum);
    expect(maximumValue).toHaveTextContent(maximum);
    expect(minimumValue).toHaveAttribute("title", `Minimum: ${minimum}`);
    expect(maximumValue).toHaveAttribute("title", `Maximum: ${maximum}`);
    expect(minimumValue).toHaveAccessibleName(`Minimum ${minimum}`);
    expect(maximumValue).toHaveAccessibleName(`Maximum ${maximum}`);
    expect(minimumValue).toHaveClass("exactNumericExtremum");
  });

  it("bounds protocol-maximum exact extrema visually while preserving their full accessible values", () => {
    const minimum = `-${"9".repeat(65_535)}`;
    const maximum = "9".repeat(65_536);
    const decimalMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [
        {
          id: "c:amount",
          name: "amount",
          position: 0,
          rawType: "Decimal",
          type: "decimal",
          nullable: false
        }
      ]
    };
    const decimalSummary: ColumnSummary = {
      columnId: "c:amount",
      column: "amount",
      type: "decimal",
      rawType: "Decimal",
      totalCount: 2,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 2,
      numeric: {
        exactMin: { kind: "decimal", raw: minimum, display: minimum, isNull: false, isNaN: false },
        exactMax: { kind: "decimal", raw: maximum, display: maximum, isNull: false, isNaN: false }
      },
      visualization: { kind: "numeric", bins: [] },
      topValues: []
    };

    renderSummary({
      metadataValue: decimalMetadata,
      summaries: [decimalSummary],
      selectedColumnId: "c:amount"
    });

    const minimumValue = screen.getByText("Min").nextElementSibling;
    const maximumValue = screen.getByText("Max").nextElementSibling;
    expect(minimumValue?.textContent).toHaveLength(96);
    expect(maximumValue?.textContent).toHaveLength(96);
    expect(minimumValue).toHaveTextContent("…");
    expect(maximumValue).toHaveTextContent("…");
    expect(minimumValue).toHaveAttribute("title", `Minimum: ${minimum}`);
    expect(maximumValue).toHaveAttribute("title", `Maximum: ${maximum}`);
    expect(minimumValue).toHaveAccessibleName(`Minimum ${minimum}`);
    expect(maximumValue).toHaveAccessibleName(`Maximum ${maximum}`);
  });

  it("falls back to the first schema column and labels categorical values and the remainder", () => {
    renderSummary();

    expect(screen.getByRole("heading", { name: "city" })).toBeInTheDocument();
    expect(screen.queryByText("Exact distribution")).not.toBeInTheDocument();
    expect(screen.getByText("Distinct").nextElementSibling).toHaveTextContent("3");
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Min length").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Max length").nextElementSibling).toHaveTextContent("6");
    expect(screen.getByText("Mean length").nextElementSibling).toHaveTextContent("3.25");
    expect(screen.getByText("Other values").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByRole("heading", { name: "Top values" })).toBeInTheDocument();
    expect(screen.getByText("Berlin")).toBeInTheDocument();
    expect(screen.getByText("Empty string")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("Other").closest("button")).toBeNull();
    expect(screen.getByRole("meter", { name: "Berlin: 2 rows, 50%" })).toHaveValue(2);
  });

  it("uses the fuller top-value list in the drawer before offering the value browser", () => {
    const topValues = Array.from({ length: 10 }, (_, index) => ({ value: `value-${index + 1}`, count: 1 }));
    renderSummary({
      summaries: [
        {
          ...categoricalSummary,
          totalCount: 20,
          distinctCount: 20,
          topValues,
          visualization: {
            kind: "categorical",
            categories: topValues.slice(0, 6),
            otherCount: 14
          }
        }
      ],
      onShowMoreValues: () => undefined,
      onApplyFilterModel: () => undefined
    });

    expect(screen.getByText("value-10")).toBeVisible();
    expect(screen.getByRole("meter", { name: "Other: 10 rows, 50%" })).toHaveValue(10);
    expect(screen.getByRole("button", { name: "More values…" })).toBeVisible();
  });

  it.each([
    {
      label: "duplicate display names",
      metadataValue: {
        ...metadata,
        shape: { rows: 20, columns: 2 },
        filteredShape: { rows: 20, columns: 2 },
        schema: [
          { id: "c:left", name: "city", position: 0, rawType: "String", type: "string" as const, nullable: false },
          { id: "c:right", name: "city", position: 1, rawType: "String", type: "string" as const, nullable: false }
        ]
      },
      selectedColumnId: "c:left"
    },
    {
      label: "complex values",
      metadataValue: {
        ...metadata,
        shape: { rows: 20, columns: 1 },
        filteredShape: { rows: 20, columns: 1 },
        schema: [
          { id: "c:0", name: "city", position: 0, rawType: "List(String)", type: "list" as const, nullable: false }
        ]
      },
      selectedColumnId: "c:0"
    }
  ])("does not offer the filter value browser for $label", ({ metadataValue, selectedColumnId }) => {
    renderSummary({
      metadataValue,
      selectedColumnId,
      summaries: [
        {
          ...categoricalSummary,
          columnId: selectedColumnId,
          totalCount: 20,
          distinctCount: 20,
          topValues: Array.from({ length: 10 }, (_, index) => ({ value: `value-${index + 1}`, count: 1 })),
          visualization: {
            kind: "categorical",
            categories: Array.from({ length: 6 }, (_, index) => ({ value: `value-${index + 1}`, count: 1 })),
            otherCount: 14
          }
        }
      ],
      onShowMoreValues: () => undefined,
      onApplyFilterModel: () => undefined
    });

    expect(screen.queryByRole("button", { name: "More values…" })).not.toBeInTheDocument();
  });

  it("switches counts to percentages and filters a categorical value through the shared view model", () => {
    const onApply = vi.fn();
    const onShowMoreValues = vi.fn();
    const Harness = () => {
      const [model, setModel] = useState<FilterModel>({
        logic: "and",
        filters: [
          {
            column: "sales",
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
          }
        ],
        sort: [{ column: "sales", direction: "desc", nulls: "last" }]
      });
      const [profileValueMode, setProfileValueMode] = useState<ProfileValueMode>("count");
      return (
        <SummaryPanel
          metadata={metadata}
          summaries={[categoricalSummary, numericSummary]}
          schemaById={new Map(metadata.schema.map((column) => [column.id, column]))}
          selectedColumnId="c:0"
          activeView="column"
          filterModel={model}
          profileValueMode={profileValueMode}
          onSelectView={() => undefined}
          onProfileValueModeChange={setProfileValueMode}
          onShowMoreValues={onShowMoreValues}
          onApplyFilterModel={(next) => {
            onApply(next);
            setModel(next);
          }}
        />
      );
    };
    render(<Harness />);

    const percentButton = screen.getByRole("button", { name: "%" });
    expect(percentButton).not.toHaveAttribute("title");
    expect(percentButton).not.toHaveAttribute("aria-description");
    expect(screen.getByText("Null").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Distinct").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Other values").nextElementSibling).toHaveTextContent("1");

    fireEvent.click(percentButton);
    expect(percentButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Counts" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Null").nextElementSibling).toHaveTextContent("0%");
    expect(screen.getByText("Distinct").nextElementSibling).toHaveTextContent("75%");
    expect(screen.getByText("Distinct").nextElementSibling).toHaveAttribute("title", "Distinct: 3 (75%)");
    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("25%");
    expect(screen.getByText("Other values").nextElementSibling).toHaveTextContent("25%");
    expect(screen.getByText("50%", { selector: ".profileDistributionRow small" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "More values…" }));
    expect(onShowMoreValues).toHaveBeenCalledWith("city");

    fireEvent.click(screen.getByRole("button", { name: "Filter to Berlin; 2 rows, 50%" }));
    expect(onApply).toHaveBeenLastCalledWith({
      logic: "and",
      filters: [
        {
          column: "sales",
          type: "float",
          predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
        },
        {
          column: "city",
          type: "string",
          logic: "and",
          valueFilter: {
            kind: "values",
            selectedValues: ["Berlin"],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    });
    expect(screen.getByText("Filter: Berlin")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter for city" }));
    expect(onApply).toHaveBeenLastCalledWith({
      logic: "and",
      filters: [
        {
          column: "sales",
          type: "float",
          predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
        }
      ],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    });
  });

  it("lets users choose count or percent while the selected column is still profiling", () => {
    const onProfileValueModeChange = vi.fn();
    renderSummary({
      summaries: [],
      selectedColumnId: "c:0",
      profileValueMode: "count",
      onProfileValueModeChange
    });

    expect(screen.getByText("Profiling selected column...")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "%" }));
    expect(onProfileValueModeChange).toHaveBeenCalledWith("percent");
    expect(screen.getByRole("button", { name: "%" })).not.toHaveAttribute("title");
  });

  it("uses non-overlapping numeric bin filters and makes the final upper edge inclusive", () => {
    const onApply = vi.fn();
    const Harness = () => {
      const [model, setModel] = useState<FilterModel>({ filters: [], sort: [] });
      return (
        <SummaryPanel
          metadata={metadata}
          summaries={[numericSummary]}
          schemaById={new Map(metadata.schema.map((column) => [column.id, column]))}
          selectedColumnId="c:1"
          activeView="column"
          filterModel={model}
          onSelectView={() => undefined}
          onApplyFilterModel={(next) => {
            onApply(next);
            setModel(next);
          }}
        />
      );
    };
    render(<Harness />);

    const firstBin = screen.getByRole("button", {
      name: "10-11: 1 row (33.3%); lower bound included, upper bound excluded"
    });
    fireEvent.click(firstBin);
    expect(onApply).toHaveBeenLastCalledWith({
      filters: [
        {
          column: "sales",
          type: "float",
          logic: "and",
          predicates: [
            { kind: "predicate", operator: "gte", value: 10 },
            { kind: "predicate", operator: "lt", value: 11 }
          ]
        }
      ],
      sort: []
    });
    expect(screen.getByText("Filter: 10–11")).toBeVisible();

    firstBin.focus();
    fireEvent.keyDown(firstBin, { key: "End" });
    expect(firstBin).toHaveAccessibleName("11-12: 2 rows (66.7%); both bounds included");
    fireEvent.keyDown(firstBin, { key: "Home" });
    expect(firstBin).toHaveAccessibleName("10-11: 1 row (33.3%); lower bound included, upper bound excluded");
    fireEvent.keyDown(firstBin, { key: "ArrowRight" });
    expect(firstBin).toHaveAccessibleName("11-12: 2 rows (66.7%); both bounds included");
    fireEvent.keyDown(firstBin, { key: "ArrowLeft" });
    expect(firstBin).toHaveAccessibleName("10-11: 1 row (33.3%); lower bound included, upper bound excluded");
    fireEvent.keyDown(firstBin, { key: "ArrowRight" });
    fireEvent.keyDown(firstBin, { key: "Enter" });
    expect(onApply).toHaveBeenLastCalledWith({
      filters: [
        {
          column: "sales",
          type: "float",
          logic: "and",
          predicates: [
            { kind: "predicate", operator: "gte", value: 11 },
            { kind: "predicate", operator: "lte", value: 12 }
          ]
        }
      ],
      sort: []
    });
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("renders all-null text metrics without inventing length bounds", () => {
    renderSummary({
      summaries: [
        {
          ...categoricalSummary,
          totalCount: 4,
          nullCount: 4,
          distinctCount: 0,
          text: { emptyCount: 0 },
          topValues: [],
          visualization: { kind: "categorical", categories: [], otherCount: 0 }
        }
      ]
    });

    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Min length").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.getByText("Max length").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.getByText("Mean length").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("keeps a nonzero Pandas NaN count visible for semantic text columns", () => {
    renderSummary({
      summaries: [
        {
          ...categoricalSummary,
          totalCount: 6,
          nanCount: 2
        }
      ]
    });

    expect(screen.getByText("Null").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("NaN").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("1");
  });

  it("filters Boolean values from Column profiles and exposes the active filter clear action", () => {
    const familyMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 2 },
      filteredShape: { rows: 4, columns: 2 },
      schema: [
        { id: "c:flag", name: "flag", position: 0, rawType: "Boolean", type: "boolean", nullable: false },
        { id: "c:when", name: "when", position: 1, rawType: "Datetime", type: "datetime", nullable: true }
      ]
    };
    const familySummaries: ColumnSummary[] = [
      {
        columnId: "c:flag",
        column: "flag",
        type: "boolean",
        rawType: "Boolean",
        totalCount: 4,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 2,
        topValues: [],
        visualization: { kind: "boolean", trueCount: 3, falseCount: 1 }
      },
      {
        columnId: "c:when",
        column: "when",
        type: "datetime",
        rawType: "Datetime",
        totalCount: 4,
        nullCount: 1,
        nanCount: 0,
        distinctCount: 3,
        topValues: [],
        visualization: { kind: "datetime", min: "2024-01-01", max: "2024-04-01" }
      }
    ];
    const onApply = vi.fn();
    const Harness = () => {
      const [model, setModel] = useState<FilterModel>({
        filters: [],
        sort: [{ column: "when", direction: "asc", nulls: "last" }]
      });
      return (
        <SummaryPanel
          metadata={familyMetadata}
          summaries={familySummaries}
          schemaById={new Map(familyMetadata.schema.map((column) => [column.id, column]))}
          selectedColumnId="c:flag"
          activeView="column"
          filterModel={model}
          onSelectView={() => undefined}
          onApplyFilterModel={(next) => {
            onApply(next);
            setModel(next);
          }}
        />
      );
    };
    render(<Harness />);

    const trueButton = screen.getByRole("button", { name: "Filter to True; True: 3 (75%)" });
    const falseButton = screen.getByRole("button", { name: "Filter to False; False: 1 (25%)" });
    expect(trueButton).toHaveTextContent("3");
    expect(falseButton).toHaveTextContent("1");
    falseButton.focus();
    expect(falseButton).toHaveFocus();

    fireEvent.click(falseButton);
    expect(onApply).toHaveBeenLastCalledWith({
      filters: [
        {
          column: "flag",
          type: "boolean",
          logic: "and",
          valueFilter: {
            kind: "values",
            selectedValues: [false],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: [{ column: "when", direction: "asc", nulls: "last" }]
    });
    expect(screen.getByText("Filter: false")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Clear filter for flag" }));
    expect(onApply).toHaveBeenLastCalledWith({
      filters: [],
      sort: [{ column: "when", direction: "asc", nulls: "last" }]
    });
  });

  it("renders explicit datetime bounds from existing profile metadata", () => {
    const familyMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 1 },
      filteredShape: { rows: 4, columns: 1 },
      schema: [{ id: "c:when", name: "when", position: 0, rawType: "Datetime", type: "datetime", nullable: true }]
    };
    const familySummaries: ColumnSummary[] = [
      {
        columnId: "c:when",
        column: "when",
        type: "datetime",
        rawType: "Datetime",
        totalCount: 4,
        nullCount: 1,
        nanCount: 0,
        distinctCount: 3,
        topValues: [],
        visualization: { kind: "datetime", min: "2024-01-01", max: "2024-04-01" }
      }
    ];

    render(
      <SummaryPanel
        metadata={familyMetadata}
        summaries={familySummaries}
        schemaById={new Map(familyMetadata.schema.map((column) => [column.id, column]))}
        selectedColumnId="c:when"
        activeView="column"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("Min").nextElementSibling).toHaveTextContent("2024-01-01");
    expect(screen.getByText("Max").nextElementSibling).toHaveTextContent("2024-04-01");
  });

  it("renders dataset shape and missing and duplicate statistics only in Dataset view", () => {
    renderSummary({ activeView: "dataset" });

    expect(screen.getByRole("tabpanel", { name: "Dataset" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dataset" })).toBeInTheDocument();
    expect(screen.getByText("Rows").nextElementSibling).toHaveTextContent("4");
    expect(screen.getByText("Columns").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Missing cells").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Rows with missing values").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Duplicate rows").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("sales")).toBeInTheDocument();
    expect(screen.queryByText("Profiling selected column...")).not.toBeInTheDocument();
  });

  it("labels a sampled duplicate count with its sample size", () => {
    renderSummary({
      activeView: "dataset",
      metadataValue: {
        ...metadata,
        stats: { ...metadata.stats!, duplicateRows: 3, duplicateRowsSampleSize: 25_000 }
      }
    });

    expect(screen.getByText("Duplicate rows (sample of 25,000)").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Missing cells").nextElementSibling).toHaveTextContent("1");
  });

  it("renders bounded loading and empty states without implying missing profile data is exact", () => {
    const { rerender } = render(
      <SummaryPanel
        metadata={undefined}
        summaries={[]}
        schemaById={new Map()}
        activeView="column"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("Preparing column summary...")).toHaveAttribute("role", "status");

    const withoutStats = { ...metadata, stats: undefined };
    rerender(
      <SummaryPanel
        metadata={withoutStats}
        summaries={[]}
        schemaById={new Map(withoutStats.schema.map((column) => [column.id, column]))}
        selectedColumnId="c:1"
        activeView="dataset"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("Profiling dataset statistics...")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Exact statistics")).not.toBeInTheDocument();

    const zeroColumnMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 0, columns: 0 },
      filteredShape: { rows: 0, columns: 0 },
      schema: []
    };
    rerender(
      <SummaryPanel
        metadata={zeroColumnMetadata}
        summaries={[]}
        schemaById={new Map()}
        activeView="column"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("This dataset has no columns.")).toBeInTheDocument();
  });

  it("renders only the selected duplicate label with positional disambiguation", () => {
    const duplicateMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 2 },
      filteredShape: { rows: 4, columns: 2 },
      schema: [
        { id: "c:left", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false },
        { id: "c:right", name: "value", position: 1, rawType: "Float64", type: "float", nullable: false }
      ]
    };
    const summary = (columnId: string, rawType: string, min: number): ColumnSummary => ({
      columnId,
      column: "value",
      type: rawType === "Int64" ? "integer" : "float",
      rawType,
      totalCount: 4,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 4,
      numeric: { min, max: min + 3 },
      topValues: []
    });
    renderSummary({
      metadataValue: duplicateMetadata,
      summaries: [summary("c:right", "Float64", 10), summary("c:left", "Int64", 1)],
      selectedColumnId: "c:right"
    });

    expect(screen.getByRole("heading", { name: "value (column 2)" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "value (column 1)" })).not.toBeInTheDocument();
    expect(screen.getByText("Min").nextElementSibling).toHaveTextContent("10");
  });

  it("renders only the shared tablist for the Filters view", () => {
    renderSummary({ activeView: "filters" });
    expect(screen.getByRole("tab", { name: "Filters" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
