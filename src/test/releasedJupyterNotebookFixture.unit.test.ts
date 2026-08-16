import { describe, expect, it } from "vitest";
import {
  RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
  RELEASED_JUPYTER_RESTART_RESULT,
  RELEASED_JUPYTER_RUNTIME_RESULT,
  RELEASED_JUPYTER_SESSION_COUNT_RESULT,
  RELEASED_JUPYTER_SETUP_RESULT,
  releasedJupyterNotebookFixture
} from "./extensionHost/releasedJupyterNotebookFixture";

function cellSource(fixture: ReturnType<typeof releasedJupyterNotebookFixture>, index: number): string {
  return fixture.cells[index]!.source.join("");
}

describe("released Jupyter notebook fixture", () => {
  it("builds the exact notebook and kernel schema", () => {
    const fixture = releasedJupyterNotebookFixture(
      "setup-marker",
      { label: "Open Wrangler Python", name: "openwrangler-acceptance" },
      "/extension"
    );

    expect(fixture).toMatchObject({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: "Open Wrangler Python",
          language: "python",
          name: "openwrangler-acceptance"
        },
        language_info: { name: "python" }
      }
    });
    expect(fixture.cells).toHaveLength(9);
    for (const cell of fixture.cells) {
      expect(cell).toMatchObject({ cell_type: "code", execution_count: null, metadata: {}, outputs: [] });
      expect(cell.source.length).toBeGreaterThan(0);
      expect(cell.source.every((line) => line.endsWith("\n"))).toBe(true);
    }
  });

  it("owns bounded Pandas and Polars showcase frames plus DuckDB native-conversion guards", () => {
    const hostExtensionPath = '/extension/"quoted"';
    const fixture = releasedJupyterNotebookFixture(
      "setup-marker",
      { label: "Python", name: "python" },
      hostExtensionPath
    );
    const setup = cellSource(fixture, 0);

    expect(setup).toContain("showcase_rows = 100000");
    expect(setup).toContain("'order_id': list(range(2400001, 2400001 + showcase_rows))");
    expect(setup).toContain("orders_preview_df = orders_df.loc[:, showcase_preview_columns].copy()");
    expect(setup).toContain("polars_frame = pl.DataFrame({");
    expect(setup).toContain("3400001 + row_index AS order_id");
    expect(setup).toContain("duckdb_relation = duckdb_connection.table('private_duck_orders')");
    expect(setup).toContain("for _duckdb_conversion_name in ('df', 'to_df', 'fetchdf', 'pl', 'arrow'):");
    expect(setup).toContain(`openwrangler_restart_marker = ${JSON.stringify("setup-marker")}`);
    expect(setup).toContain(`'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)})`);
    expect(setup).toContain(JSON.stringify(RELEASED_JUPYTER_SETUP_RESULT));
  });

  it("preserves the executable preview, restart, runtime, relation, and session probe order", () => {
    const fixture = releasedJupyterNotebookFixture("setup-marker", { label: "Python", name: "python" }, "/extension");

    expect(cellSource(fixture, 1)).toBe("# Explore recent orders in Open Wrangler\norders_preview_df\n\n");
    expect(cellSource(fixture, 2)).toContain("orders_preview_df.tail(3)");
    expect(cellSource(fixture, 3)).toContain(JSON.stringify(RELEASED_JUPYTER_RESTART_RESULT));
    expect(cellSource(fixture, 3)).toContain("'setup': globals().get('openwrangler_restart_marker')");
    expect(cellSource(fixture, 4)).toContain(JSON.stringify(RELEASED_JUPYTER_RUNTIME_RESULT));
    expect(cellSource(fixture, 4)).toContain("'runtimeFile': openwrangler_runtime.__file__");
    expect(cellSource(fixture, 5)).toBe("duckdb_relation\n");
    expect(cellSource(fixture, 6)).toContain(JSON.stringify(RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT));
    expect(cellSource(fixture, 6)).toContain("'connectionCount'");
    expect(cellSource(fixture, 7)).toContain(JSON.stringify(RELEASED_JUPYTER_SESSION_COUNT_RESULT));
    expect(cellSource(fixture, 7)).toContain("len(__ow_kernel_agent._manager.sessions)");
    expect(cellSource(fixture, 8)).toContain("orders_preview_df.tail(3)");
  });
});
