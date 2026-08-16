import { describe, expect, it } from "vitest";
import { RELEASED_JUPYTER_RESTART_RESULT } from "./extensionHost/releasedJupyterNotebookFixture";
import {
  RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
  RELEASED_JUPYTER_PYSPARK_REBIND_RESULT,
  RELEASED_JUPYTER_PYSPARK_SCHEMA_REBIND_RESULT,
  RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
  releasedPySparkNotebookFixture
} from "./extensionHost/releasedPySparkNotebookFixture";

function cellSource(fixture: ReturnType<typeof releasedPySparkNotebookFixture>, index: number): string {
  return fixture.cells[index]!.source.join("");
}

describe("released PySpark notebook fixture", () => {
  it("builds the exact notebook and private kernel schema", () => {
    const fixture = releasedPySparkNotebookFixture("/extension", {
      label: "Open Wrangler PySpark",
      name: "openwrangler-pyspark"
    });

    expect(fixture).toMatchObject({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: "Open Wrangler PySpark",
          language: "python",
          name: "openwrangler-pyspark"
        },
        language_info: { name: "python" }
      }
    });
    expect(fixture.cells).toHaveLength(8);
    for (const cell of fixture.cells) {
      expect(cell).toMatchObject({ cell_type: "code", execution_count: null, metadata: {}, outputs: [] });
      expect(cell.source.every((line) => line.endsWith("\n"))).toBe(true);
    }
  });

  it("owns the native Classic frame, conversion traps, variant probe, and bounded showcase", () => {
    const hostExtensionPath = '/extension/"quoted"';
    const fixture = releasedPySparkNotebookFixture(hostExtensionPath, { label: "PySpark", name: "pyspark" });
    const warmup = cellSource(fixture, 0);
    const classic = cellSource(fixture, 1);

    expect(warmup).toContain(JSON.stringify(RELEASED_JUPYTER_RESTART_RESULT));
    expect(warmup).toContain(`os.path.exists(${JSON.stringify(hostExtensionPath)})`);
    expect(classic).toContain("os.environ['PYSPARK_PYTHON'] = sys.executable");
    expect(classic).toContain("os.environ['PYSPARK_DRIVER_PYTHON'] = sys.executable");
    expect(classic).toContain("for method_name in ('toPandas', 'toArrow', 'mapInPandas', 'mapInArrow'):");
    expect(classic).toContain('parse_json(\'{\\"region\\":\\"eu\\"}\')');
    expect(classic).toContain("spark_orders_frame = spark.range(100000).select(");
    expect(classic).toContain("F.lit(2400001)).alias('order_id')");
    expect(classic).toContain(JSON.stringify(RELEASED_JUPYTER_PYSPARK_SETUP_RESULT));
    expect(classic).toContain("'variantConversionTraps': _open_wrangler_variant_conversion_traps");
  });

  it("preserves Classic and Connect rebind, schema, session, and close evidence order", () => {
    const fixture = releasedPySparkNotebookFixture("/extension", { label: "PySpark", name: "pyspark" });

    expect(cellSource(fixture, 2)).toContain("open-wrangler-packaged-classic-rebound");
    expect(cellSource(fixture, 2)).toContain(JSON.stringify(RELEASED_JUPYTER_PYSPARK_REBIND_RESULT));
    expect(cellSource(fixture, 3)).toContain("record_id long, category_label string, amount double");
    expect(cellSource(fixture, 3)).toContain(JSON.stringify(RELEASED_JUPYTER_PYSPARK_SCHEMA_REBIND_RESULT));
    expect(cellSource(fixture, 4)).toContain("len(__ow_kernel_agent._manager.sessions)");
    expect(cellSource(fixture, 4)).toContain(JSON.stringify(RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT));
    expect(cellSource(fixture, 5)).toContain(".remote('local[2]')");
    expect(cellSource(fixture, 5)).toContain(JSON.stringify(RELEASED_JUPYTER_PYSPARK_SETUP_RESULT));
    expect(cellSource(fixture, 6)).toContain(JSON.stringify(RELEASED_JUPYTER_PYSPARK_REBIND_RESULT));
    expect(cellSource(fixture, 7)).toContain("connect_spark.stop()");
    expect(cellSource(fixture, 7)).toContain(JSON.stringify(RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT));
  });
});
