import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColumnSummary } from "../shared/protocol";
import { SummaryPanel } from "../webviews/summary/SummaryPanel";
import { metadata, summaries } from "./protocolValidation.fixtures";

function renderSummary(summary: ColumnSummary) {
  render(
    <SummaryPanel
      metadata={metadata}
      summaries={[summary]}
      schemaById={new Map(metadata.schema.map((column) => [column.id, column]))}
      activeView="column"
      onSelectView={() => undefined}
    />
  );
}

describe("SummaryPanel numeric sum", () => {
  it("renders the lossless typed value before its approximate fallback", () => {
    renderSummary({
      ...summaries[0],
      numeric: {
        ...summaries[0].numeric,
        sum: 9.007199254740994e24,
        exactSum: {
          kind: "integer",
          raw: "9007199254740993123456789",
          display: "9007199254740993123456789",
          isNull: false,
          isNaN: false
        }
      }
    });

    const value = screen.getByText("Sum").nextElementSibling;
    expect(value).toHaveTextContent("9007199254740993123456789");
    expect(value).toHaveAttribute("aria-label", "Sum 9007199254740993123456789");
    expect(value).toHaveClass("exactNumericExtremum");
  });

  it("shows an unavailable sum without implying that sampled distribution values were aggregated", () => {
    renderSummary({ ...summaries[0], numeric: {} });
    expect(screen.getByText("Sum").nextElementSibling).toHaveTextContent("n/a");
  });
});
