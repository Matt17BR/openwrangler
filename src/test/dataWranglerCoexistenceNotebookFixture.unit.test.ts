import { describe, expect, it } from "vitest";
import {
  DATA_WRANGLER_COEXISTENCE_SETUP_RESULT,
  DATA_WRANGLER_COEXISTENCE_VARIABLE,
  dataWranglerCoexistenceNotebookFixture
} from "./extensionHost/dataWranglerCoexistenceNotebookFixture";

function cellSource(fixture: ReturnType<typeof dataWranglerCoexistenceNotebookFixture>, index: number): string {
  return fixture.cells[index]!.source.join("");
}

describe("Data Wrangler coexistence notebook fixture", () => {
  it("owns the exact portable notebook and kernel schema", () => {
    const fixture = dataWranglerCoexistenceNotebookFixture({
      label: "Open Wrangler private Python",
      name: "openwrangler-private-python"
    });

    expect(fixture).toMatchObject({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: "Open Wrangler private Python",
          language: "python",
          name: "openwrangler-private-python"
        },
        language_info: { name: "python" }
      }
    });
    expect(fixture.cells).toHaveLength(2);
    for (const cell of fixture.cells) {
      expect(cell).toMatchObject({ cell_type: "code", execution_count: null, metadata: {}, outputs: [] });
      expect(cell.source.every((line) => line.endsWith("\n"))).toBe(true);
    }
  });

  it("defines one deterministic Pandas frame before exposing that exact variable", () => {
    const fixture = dataWranglerCoexistenceNotebookFixture({ label: "Python", name: "python" });
    const setup = cellSource(fixture, 0);

    expect(setup).toContain(`${DATA_WRANGLER_COEXISTENCE_VARIABLE} = pd.DataFrame({`);
    expect(setup).toContain("'order_id': [2400001, 2400002, 2400003, 2400004]");
    expect(setup).toContain("'market': ['DACH', 'Nordics', 'Iberia', 'France']");
    expect(setup).toContain("'revenue': [620.50, 1840.75, 991.00, 2420.25]");
    expect(setup).toContain(JSON.stringify(DATA_WRANGLER_COEXISTENCE_SETUP_RESULT));
    expect(setup.indexOf(`${DATA_WRANGLER_COEXISTENCE_VARIABLE} =`)).toBeLessThan(
      setup.indexOf(DATA_WRANGLER_COEXISTENCE_SETUP_RESULT)
    );
    expect(cellSource(fixture, 1)).toBe(`${DATA_WRANGLER_COEXISTENCE_VARIABLE}\n`);
  });
});
