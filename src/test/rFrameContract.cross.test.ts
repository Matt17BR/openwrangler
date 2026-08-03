import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRFramePageJson, type RDataframeFlavor } from "../extension/r/rFrameContract";

const enabled = process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1";
const rscript = process.env.RSCRIPT ?? "Rscript";

function emitFrame(flavor: "data.frame" | "tibble" | "data.table") {
  const result = spawnSync(rscript, ["--vanilla", "r/tests/emit_frame_contract.R", flavor], {
    cwd: resolve(__dirname, "../.."),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 20 * 1_024 * 1_024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      R_LIBS_USER: process.env.R_LIBS_USER,
      R_LIBS_SITE: process.env.R_LIBS_SITE,
      R_PROFILE_USER: "",
      R_ENVIRON_USER: ""
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`R frame emitter failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  }
  expect(result.stderr).toBe("");
  return decodeRFramePageJson(result.stdout);
}

describe.skipIf(!enabled)("R to TypeScript frame contract", () => {
  it.each([
    ["data.frame", "r.data.frame"],
    ["tibble", "r.tibble"],
    ["data.table", "r.data.table"]
  ] as const)("decodes a native %s page without a Python compatibility layer", (fixture, expectedFlavor) => {
    const frame = emitFrame(fixture);

    expect(frame.dataframeFlavor).toBe(expectedFlavor satisfies RDataframeFlavor);
    expect(frame.frameSemantics.classes).toEqual(
      expectedFlavor === "r.data.frame"
        ? ["data.frame"]
        : expectedFlavor === "r.tibble"
          ? ["tbl_df", "tbl", "data.frame"]
          : ["data.table", "data.frame"]
    );
    expect(frame.page.rows).toHaveLength(3);
    expect(frame.page.columnIds).toEqual(frame.schema.map((column) => column.id));
  });

  it("round-trips R-specific values and metadata", () => {
    const frame = emitFrame("data.frame");

    expect(frame.schema.slice(0, 2).map((column) => column.name)).toEqual(["duplicate", "duplicate"]);
    expect(frame.schema.find((column) => column.name === "category")?.semantics).toMatchObject({
      kind: "factor",
      levels: ["A", "B"],
      ordered: false
    });
    expect(frame.schema.find((column) => column.name === "instant")?.semantics).toMatchObject({
      kind: "datetime",
      timezone: "UTC"
    });
    expect(frame.schema.find((column) => column.name === "local_instant")?.semantics).toMatchObject({
      kind: "datetime",
      timezone: null
    });
    const wideIndex = frame.schema.findIndex((column) => column.name === "wide");
    const amountIndex = frame.schema.findIndex((column) => column.name === "duplicate" && column.type === "float");
    expect(frame.page.rows[0]?.values[wideIndex]).toMatchObject({
      kind: "integer",
      raw: "9223372036854775806"
    });
    expect(frame.page.rows[1]?.values[amountIndex]).toMatchObject({ kind: "nan", isNaN: true, isNull: false });
    expect(frame.page.rows[2]?.values[amountIndex]).toMatchObject({
      kind: "infinity",
      sign: -1,
      isNaN: false,
      isNull: false
    });
  });

  it("retains data.table key identity", () => {
    const frame = emitFrame("data.table");
    expect(frame.frameSemantics.keyColumnIds).toEqual(["r:c:0"]);
  });
});
