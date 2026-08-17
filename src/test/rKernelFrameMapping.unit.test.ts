import { describe, expect, it } from "vitest";
import {
  copyRSchema,
  emptyRViewQuery,
  gridPageFromRContract,
  rPageWindow,
  sameRSchema,
  schemaFromRContract,
  validateRPageWindow
} from "../extension/r/rKernelFrameMapping";
import { R_FRAME_CONTRACT_LIMITS, type RFramePageContract } from "../extension/r/rFrameContract";

describe("R kernel frame mapping", () => {
  it("owns the exact bounded two-dimensional page window", () => {
    const view = emptyRViewQuery();
    const page = rPageWindow(2, 20, 3, 8, view);

    expect(page).toEqual({ rowOffset: 2, rowLimit: 20, columnOffset: 3, columnLimit: 8, view });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.filters)).toBe(true);
    expect(Object.isFrozen(view.sorts)).toBe(true);
    expect(() => validateRPageWindow(2, 20, 3, 8)).not.toThrow();
  });

  it("rejects every independent page bound and the combined cell budget", () => {
    expect(() => validateRPageWindow(-1, 1, 0, 1)).toThrow("row offset");
    expect(() => validateRPageWindow(R_FRAME_CONTRACT_LIMITS.rows + 1, 1, 0, 1)).toThrow("row offset");
    expect(() => validateRPageWindow(0, 0, 0, 1)).toThrow("rows");
    expect(() => validateRPageWindow(0, R_FRAME_CONTRACT_LIMITS.pageRows + 1, 0, 1)).toThrow("rows");
    expect(() => validateRPageWindow(0, 1, -1, 1)).toThrow("column offset");
    expect(() => validateRPageWindow(0, 1, R_FRAME_CONTRACT_LIMITS.columns + 1, 1)).toThrow("column offset");
    expect(() => validateRPageWindow(0, 1, 0, 0)).toThrow("columns");
    expect(() => validateRPageWindow(0, 1, 0, R_FRAME_CONTRACT_LIMITS.pageColumns + 1)).toThrow("columns");
    expect(() =>
      validateRPageWindow(0, R_FRAME_CONTRACT_LIMITS.pageRows, 0, R_FRAME_CONTRACT_LIMITS.pageColumns)
    ).toThrow("cells");
  });

  it("maps schema and row payloads without exposing R numeric strings", () => {
    const contract = frameContract();
    const schema = schemaFromRContract(contract);
    const copied = copyRSchema(schema);

    expect(schema).toEqual([
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "double",
        type: "float",
        nullable: true
      }
    ]);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(copied).toEqual(schema);
    expect(copied).not.toBe(schema);
    expect(copied[0]).not.toBe(schema[0]);
    expect(sameRSchema(schema, contract.schema)).toBe(true);
    expect(sameRSchema(schema, [{ ...contract.schema[0]!, nullable: false }])).toBe(false);
    expect(gridPageFromRContract(contract)).toEqual({
      offset: 4,
      limit: 1,
      totalRows: 9,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:4",
          rowNumber: 4,
          rowLabel: "order-5",
          values: [{ kind: "number", raw: 12.5, display: "12.5", isNull: false, isNaN: false }]
        }
      ]
    });
  });

  it("fails closed when R labels a non-finite value as a finite number", () => {
    const contract = frameContract();
    const row = contract.page.rows[0]!;
    const changed: RFramePageContract = {
      ...contract,
      page: {
        ...contract.page,
        rows: [
          {
            ...row,
            values: [{ kind: "number", raw: "Infinity", display: "Inf", isNull: false, isNaN: false }]
          }
        ]
      }
    };

    expect(() => gridPageFromRContract(changed)).toThrow("non-finite value as a finite double");
  });
});

function frameContract(): RFramePageContract {
  const schema = [
    {
      id: "r:c:0",
      name: "value",
      position: 0,
      rawType: "double",
      type: "float",
      nullable: true,
      semantics: { kind: "double", storageMode: "double", classes: ["numeric"] }
    }
  ] as const;
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 9, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "explicit", keyColumnIds: [] },
    schema,
    page: {
      offset: 4,
      limit: 1,
      totalRows: 9,
      columnOffset: 0,
      columnLimit: 1,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:4",
          rowNumber: 4,
          rowLabel: "order-5",
          values: [{ kind: "number", raw: "12.5", display: "12.5", isNull: false, isNaN: false }]
        }
      ]
    }
  };
}
