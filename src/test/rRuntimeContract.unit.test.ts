import { describe, expect, it } from "vitest";
import { isRFramePageContract, type RFramePageContract } from "../shared/rRuntimeContract";

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

const validContract = (): DeepMutable<RFramePageContract> => ({
  contractVersion: 1,
  runtimeLanguage: "r",
  frameFlavor: "data.frame",
  codeDialect: null,
  shape: { rows: 2, columns: 2 },
  schema: [
    { id: "r:c:0", name: "value", position: 0, rawType: "double<numeric>", type: "float", nullable: false },
    { id: "r:c:1", name: "value", position: 1, rawType: "integer<factor>", type: "string", nullable: true }
  ],
  columnMetadata: [
    { columnId: "r:c:0", classNames: ["numeric"], storageType: "double" },
    {
      columnId: "r:c:1",
      classNames: ["factor"],
      storageType: "integer",
      levels: ["alpha", "beta"],
      ordered: false
    }
  ],
  frameMetadata: { classNames: ["data.frame"] },
  page: {
    offset: 0,
    limit: 2,
    totalRows: 2,
    columnIds: ["r:c:0", "r:c:1"],
    rows: [
      {
        id: "session:0",
        rowNumber: 0,
        values: [
          { kind: "number", raw: 1.5, display: "1.5", isNull: false, isNaN: false },
          { kind: "string", raw: "alpha", display: "alpha", isNull: false, isNaN: false }
        ]
      },
      {
        id: "session:1",
        rowNumber: 1,
        values: [
          { kind: "nan", display: "NaN", isNull: false, isNaN: true },
          { kind: "null", display: "", isNull: true, isNaN: false }
        ]
      }
    ]
  },
  rowNames: ["1", "2"]
});

describe("native R frame contract", () => {
  it("accepts typed R pages without requiring a Python backend", () => {
    expect(isRFramePageContract(validContract())).toBe(true);
  });

  it("keeps frame flavor and code dialect independent", () => {
    const contract = {
      ...validContract(),
      frameFlavor: "data.table",
      codeDialect: "base-r",
      frameMetadata: { classNames: ["data.table", "data.frame"] }
    };
    expect(isRFramePageContract(contract)).toBe(true);
  });

  it("accepts R temporal NaN and infinity without non-JSON numbers", () => {
    const contract = validContract();
    contract.schema.splice(0, 2, {
      id: "r:c:0",
      name: "when",
      position: 0,
      rawType: "double<Date>",
      type: "date",
      nullable: true
    });
    contract.columnMetadata.splice(0, 2, { columnId: "r:c:0", classNames: ["Date"], storageType: "double" });
    contract.shape = { rows: 2, columns: 1 };
    contract.page.columnIds = ["r:c:0"];
    contract.page.rows[0]!.values = [{ kind: "nan", display: "NaN", isNull: false, isNaN: true }];
    contract.page.rows[1]!.values = [{ kind: "infinity", display: "-Infinity", isNull: false, isNaN: false, sign: -1 }];
    expect(isRFramePageContract(contract)).toBe(true);
  });

  it("rejects schema identity, projection, and typed-missing inconsistencies", () => {
    const duplicateId = structuredClone(validContract());
    duplicateId.schema[1]!.id = "r:c:0";
    expect(isRFramePageContract(duplicateId)).toBe(false);

    const wrongProjection = structuredClone(validContract());
    wrongProjection.page.columnIds.reverse();
    expect(isRFramePageContract(wrongProjection)).toBe(false);

    const conflatedMissing = structuredClone(validContract());
    conflatedMissing.page.rows[1]!.values[0] = {
      kind: "nan",
      display: "NaN",
      isNull: true,
      isNaN: true
    };
    expect(isRFramePageContract(conflatedMissing)).toBe(false);

    const nullInNonNullable = structuredClone(validContract());
    nullInNonNullable.page.rows[0]!.values[0] = { kind: "null", display: "", isNull: true, isNaN: false };
    expect(isRFramePageContract(nullInNonNullable)).toBe(false);

    const missingRaw = structuredClone(validContract());
    delete missingRaw.page.rows[0]!.values[0]!.raw;
    expect(isRFramePageContract(missingRaw)).toBe(false);

    const sparseValues = structuredClone(validContract());
    delete sparseValues.page.rows[0]!.values[0];
    expect(isRFramePageContract(sparseValues)).toBe(false);

    const explicitUndefined = structuredClone(validContract());
    (explicitUndefined.columnMetadata[0] as unknown as Record<string, unknown>).timezone = undefined;
    expect(isRFramePageContract(explicitUndefined)).toBe(false);

    const oversizedPage = structuredClone(validContract());
    oversizedPage.page.limit = 10_001;
    expect(isRFramePageContract(oversizedPage)).toBe(false);
  });

  it("rejects cells, classes, raw types, and options that contradict the schema", () => {
    const wrongCell = structuredClone(validContract());
    wrongCell.page.rows[0]!.values[0] = {
      kind: "string",
      raw: "1.5",
      display: "1.5",
      isNull: false,
      isNaN: false
    };
    expect(isRFramePageContract(wrongCell)).toBe(false);

    const wrongFlavorClass = { ...validContract(), frameFlavor: "data.table" };
    expect(isRFramePageContract(wrongFlavorClass)).toBe(false);

    const wrongRawType = structuredClone(validContract());
    wrongRawType.schema[0]!.rawType = "integer<numeric>";
    expect(isRFramePageContract(wrongRawType)).toBe(false);

    const factorWithoutLevels = structuredClone(validContract());
    delete factorWithoutLevels.columnMetadata[1]!.levels;
    expect(isRFramePageContract(factorWithoutLevels)).toBe(false);

    const timezoneOnNumber = structuredClone(validContract());
    timezoneOnNumber.columnMetadata[0]!.timezone = "UTC";
    expect(isRFramePageContract(timezoneOnNumber)).toBe(false);
  });

  it("accepts only the canonical R wire form for exact cell classes", () => {
    const integer64 = validContract();
    integer64.schema[0] = {
      id: "r:c:0",
      name: "wide",
      position: 0,
      rawType: "double<integer64>",
      type: "integer",
      nullable: true
    };
    integer64.columnMetadata[0] = { columnId: "r:c:0", classNames: ["integer64"], storageType: "double" };
    integer64.page.rows[0]!.values[0] = {
      kind: "integer",
      raw: "9007199254740993",
      display: "9007199254740993",
      isNull: false,
      isNaN: false
    };
    integer64.page.rows[1]!.values[0] = { kind: "null", display: "", isNull: true, isNaN: false };
    expect(isRFramePageContract(integer64)).toBe(true);

    const numericInteger64 = structuredClone(integer64);
    numericInteger64.page.rows[0]!.values[0]!.raw = 1;
    numericInteger64.page.rows[0]!.values[0]!.display = "1";
    expect(isRFramePageContract(numericInteger64)).toBe(false);

    const outOfRangeInteger64 = structuredClone(integer64);
    outOfRangeInteger64.page.rows[0]!.values[0]!.raw = "9223372036854775808";
    outOfRangeInteger64.page.rows[0]!.values[0]!.display = "9223372036854775808";
    expect(isRFramePageContract(outOfRangeInteger64)).toBe(false);

    const date = validContract();
    date.schema[0] = {
      id: "r:c:0",
      name: "when",
      position: 0,
      rawType: "double<Date>",
      type: "date",
      nullable: false
    };
    date.columnMetadata[0] = { columnId: "r:c:0", classNames: ["Date"], storageType: "double" };
    date.page.rows[0]!.values[0] = {
      kind: "date",
      raw: "not-a-date",
      display: "not-a-date",
      isNull: false,
      isNaN: false
    };
    date.page.rows[1]!.values[0] = {
      kind: "date",
      raw: "2025-01-01",
      display: "2025-01-01",
      isNull: false,
      isNaN: false
    };
    expect(isRFramePageContract(date)).toBe(false);

    const list = validContract();
    list.schema[0] = {
      id: "r:c:0",
      name: "nested",
      position: 0,
      rawType: "list<AsIs>",
      type: "list",
      nullable: false
    };
    list.columnMetadata[0] = { columnId: "r:c:0", classNames: ["AsIs"], storageType: "list" };
    list.page.rows[0]!.values[0] = {
      kind: "list",
      raw: "<NULL>",
      display: "<NULL>",
      isNull: false,
      isNaN: false
    };
    list.page.rows[1]!.values[0] = {
      kind: "list",
      raw: "arbitrary",
      display: "arbitrary",
      isNull: false,
      isNaN: false
    };
    expect(isRFramePageContract(list)).toBe(false);
  });

  it("requires stable, schema-matched references for grouped and keyed metadata", () => {
    const grouped = {
      ...validContract(),
      frameFlavor: "grouped-tibble",
      frameMetadata: {
        classNames: ["grouped_df", "tbl_df", "tbl", "data.frame"],
        groupColumns: [{ id: "r:c:0", name: "value" }]
      }
    };
    expect(isRFramePageContract(grouped)).toBe(true);

    const wrongName = structuredClone(grouped);
    wrongName.frameMetadata.groupColumns[0]!.name = "other";
    expect(isRFramePageContract(wrongName)).toBe(false);

    const repeated = structuredClone(grouped);
    repeated.frameMetadata.groupColumns.push({ id: "r:c:0", name: "value" });
    expect(isRFramePageContract(repeated)).toBe(false);

    const groupsOnBase = structuredClone(validContract()) as RFramePageContract & {
      frameMetadata: { classNames: readonly string[]; groupColumns: readonly { id: string; name: string }[] };
    };
    groupsOnBase.frameMetadata = {
      classNames: ["data.frame"],
      groupColumns: [{ id: "r:c:0", name: "value" }]
    };
    expect(isRFramePageContract(groupsOnBase)).toBe(false);
  });

  it("uses strict UTF-8 byte and aggregate text limits", () => {
    const loneSurrogate = structuredClone(validContract());
    loneSurrogate.schema[0]!.name = "\ud800";
    expect(isRFramePageContract(loneSurrogate)).toBe(false);

    const tooManyUtf8Bytes = structuredClone(validContract());
    tooManyUtf8Bytes.schema[0]!.name = "😀".repeat(16_385);
    expect(isRFramePageContract(tooManyUtf8Bytes)).toBe(false);

    const text = "x".repeat(65_536);
    const oversizedAggregate: RFramePageContract = {
      contractVersion: 1,
      runtimeLanguage: "r",
      frameFlavor: "data.frame",
      codeDialect: null,
      shape: { rows: 65, columns: 1 },
      schema: [
        { id: "r:c:0", name: "value", position: 0, rawType: "character<character>", type: "string", nullable: false }
      ],
      columnMetadata: [{ columnId: "r:c:0", classNames: ["character"], storageType: "character" }],
      frameMetadata: { classNames: ["data.frame"] },
      page: {
        offset: 0,
        limit: 65,
        totalRows: 65,
        columnIds: ["r:c:0"],
        rows: Array.from({ length: 65 }, (_, index) => ({
          id: `session:${index}`,
          rowNumber: index,
          values: [{ kind: "string", raw: text, display: text, isNull: false, isNaN: false }]
        }))
      },
      rowNames: Array.from({ length: 65 }, (_, index) => `${index + 1}`)
    };
    expect(isRFramePageContract(oversizedAggregate)).toBe(false);
  });

  it("rejects unversioned or Python-shaped compatibility payloads", () => {
    const contract = validContract() as unknown as Record<string, unknown>;
    contract.runtimeLanguage = "python";
    expect(isRFramePageContract(contract)).toBe(false);

    const withBackend = { ...validContract(), backend: "pandas" };
    expect(isRFramePageContract(withBackend)).toBe(false);
  });
});
