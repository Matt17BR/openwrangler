import { describe, expect, it } from "vitest";
import { metadataFor, sessionFromContract } from "../extension/r/rKernelBridgeContract";
import { gridPageFromRContract, sameRSchema, schemaFromRContract } from "../extension/r/rKernelFrameMapping";
import { resolveRViewQuery } from "../extension/r/rKernelViewContract";
import { canStartOperation } from "../shared/operations";
import { isOpenWranglerResponse } from "../shared/protocolValidation";
import { decodeRFramePageJson, R_FRAME_CONTRACT_LIMITS } from "../extension/r/rFrameContract";

function decodeCandidate(candidate: Record<string, unknown>) {
  return decodeRFramePageJson(JSON.stringify(candidate));
}

function minimalContract(): Record<string, unknown> {
  return {
    contractVersion: 7,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 1, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
    schema: [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "integer",
        type: "integer",
        nullable: false,
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      }
    ],
    page: {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnOffset: 0,
      columnLimit: 1,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }]
        }
      ]
    }
  };
}

function dateContract(raw: string): Record<string, unknown> {
  const candidate = minimalContract();
  const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
  column.rawType = "Date";
  column.type = "date";
  column.semantics = { kind: "date", storageMode: "double", classes: ["Date"] };
  const page = candidate.page as Record<string, unknown>;
  (page.rows as Array<Record<string, unknown>>)[0]!.values = [
    { kind: "date", raw, display: raw, isNull: false, isNaN: false }
  ];
  return candidate;
}

function clockContract(clock = "naive", precision = "nanosecond", unit = "ns"): Record<string, unknown> {
  const candidate = minimalContract();
  const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
  column.rawType = `clock_${clock}_time[${unit}]`;
  column.type = "datetime";
  column.nullable = true;
  column.semantics = {
    kind: "clock_datetime",
    storageMode: "list",
    classes: [`clock_${clock}_time`, "clock_time_point", "clock_rcrd", "vctrs_rcrd", "vctrs_vctr"],
    clock,
    precision
  };
  const row = ((candidate.page as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!;
  row.values = [
    {
      kind: "datetime",
      raw: "1",
      display: `1970-01-01T00:00:00.${unit === "ms" ? "001" : unit === "us" ? "000001" : "000000001"}${clock === "sys" ? "Z" : ""}`,
      isNull: false,
      isNaN: false
    }
  ];
  return candidate;
}

describe("native R frame contract decoder", () => {
  it.each(["naive", "sys"])("preserves the %s clock timestamp unit and meaning in public column identity", (clock) => {
    for (const [precision, unit] of [
      ["millisecond", "ms"],
      ["microsecond", "us"],
      ["nanosecond", "ns"]
    ]) {
      const contract = decodeCandidate(clockContract(clock, precision, unit));
      const schema = schemaFromRContract(contract);
      expect(schema[0]).toMatchObject({ type: "datetime", rawType: `clock_${clock}_time[${unit}]` });
      expect(contract.schema[0]!.semantics).toMatchObject({ clock, precision });
      expect(gridPageFromRContract(contract).rows[0]!.values[0]).toMatchObject({ kind: "datetime", raw: "1" });
      expect(
        sameRSchema(schema, [
          { ...contract.schema[0]!, rawType: `clock_${clock === "sys" ? "naive" : "sys"}_time[${unit}]` }
        ])
      ).toBe(false);
      expect(
        sameRSchema(schema, [
          { ...contract.schema[0]!, rawType: `clock_${clock}_time[${unit === "ns" ? "us" : "ns"}]` }
        ])
      ).toBe(false);
    }
  });

  it("keeps adjacent nanoseconds, the present minimum tick and null distinct through public pages and selections", () => {
    const candidate = clockContract();
    const values = [
      { raw: "1700000000000000000", display: "2023-11-14T22:13:20.000000000" },
      { raw: "1700000000000000001", display: "2023-11-14T22:13:20.000000001" },
      { raw: "-9223372036854775808", display: "1677-09-21T00:12:43.145224192" },
      { raw: "9223372036854775807", display: "2262-04-11T23:47:16.854775807" },
      { raw: "-1", display: "1969-12-31T23:59:59.999999999" }
    ];
    const cells = [
      ...values.map((value) => ({ kind: "datetime", ...value, isNull: false, isNaN: false })),
      { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false }
    ];
    candidate.shape = { rows: cells.length, columns: 1 };
    Object.assign(candidate.page as object, {
      limit: cells.length,
      totalRows: cells.length,
      rows: cells.map((cell, index) => ({ id: `r:r:${index}`, rowNumber: index, values: [cell] }))
    });
    const contract = decodeCandidate(candidate);
    const page = gridPageFromRContract(contract);
    expect(page.rows.map((row) => row.values[0]!.raw)).toEqual([...values.map((value) => value.raw), null]);
    expect(page.rows.map((row) => row.values[0]!.display)).toEqual([...values.map((value) => value.display), "NA"]);
    for (const library of ["base", "dplyr", "data.table", "collapse"] as const) {
      const metadata = metadataFor(
        sessionFromContract(
          "clock",
          {
            kind: "file",
            label: "time.parquet",
            path: "/workspace/time.parquet",
            uri: "file:///workspace/time.parquet"
          },
          "viewing",
          contract,
          ["csv", "parquet"],
          library
        )
      );
      expect(isOpenWranglerResponse({ kind: "page", revision: 0, viewRequestId: "clock-page", metadata, page })).toBe(
        true
      );
    }
    const selection = {
      kind: "typedSelection" as const,
      version: 1 as const,
      columnType: "datetime" as const,
      cell: page.rows[1]!.values[0]!
    };
    const query = resolveRViewQuery(
      {
        filters: [
          {
            column: "value",
            type: "datetime",
            predicates: [],
            valueFilter: { kind: "values", selectedValues: [selection], includeNulls: false, includeNaN: false }
          }
        ],
        sort: []
      },
      schemaFromRContract(contract)
    );
    expect(query.filters[0]!.valueFilter!.selectedValues[0]).toEqual(selection);
    expect(
      isOpenWranglerResponse({
        kind: "columnValues",
        revision: 0,
        viewRequestId: "clock-values",
        column: "value",
        values: [{ value: selection.cell.display, count: 1, selectionValue: selection }],
        hasMore: false
      })
    ).toBe(true);
  });

  it.each([
    ["storage", { storageMode: "double" }],
    ["class", { classes: ["clock_naive_time", "vctrs_vctr"] }],
    ["clock", { clock: "local" }],
    ["meaning", { clock: "sys" }],
    ["precision", { precision: "second" }],
    ["extra metadata", { timezone: "UTC" }]
  ])("rejects malformed clock %s metadata", (_name, change) => {
    const candidate = clockContract();
    const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
    Object.assign(column.semantics as object, change);
    expect(() => decodeCandidate(candidate)).toThrow(TypeError);
  });

  it.each(["9223372036854775808", "-9223372036854775809", "1.0", "1e9", "01", "-0", "NaN", 1, null])(
    "rejects the invalid clock tick payload %s",
    (raw) => {
      const candidate = clockContract();
      const row = ((candidate.page as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!;
      (row.values as Array<Record<string, unknown>>)[0]!.raw = raw;
      expect(() => decodeCandidate(candidate)).toThrow(TypeError);
    }
  );

  it.each([
    ["millisecond", "ms", "-62167219200000", "253402300799999"],
    ["microsecond", "us", "-62167219200000000", "253402300799999999"]
  ] as const)("admits only ISO years 0000 through 9999 at %s precision", (precision, unit, minimum, maximum) => {
    for (const clock of ["naive", "sys"]) {
      const candidate = clockContract(clock, precision, unit);
      const row = ((candidate.page as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!;
      const cell = (row.values as Array<Record<string, unknown>>)[0]!;
      const suffix = clock === "sys" ? "Z" : "";
      const digits = unit === "ms" ? 3 : 6;
      for (const [raw, display] of [
        [minimum, `0000-01-01T00:00:00.${"0".repeat(digits)}${suffix}`],
        [maximum, `9999-12-31T23:59:59.${"9".repeat(digits)}${suffix}`]
      ]) {
        cell.raw = raw;
        cell.display = display;
        expect(decodeCandidate(candidate).page.rows[0]!.values[0]!.raw).toBe(raw);
      }
      for (const raw of [String(BigInt(minimum) - 1n), String(BigInt(maximum) + 1n)]) {
        cell.raw = raw;
        expect(() => decodeCandidate(candidate)).toThrow("ISO calendar years");
      }
    }
  });

  it("retains viewing and export while restricting incompatible cleaning libraries", () => {
    const contract = decodeCandidate(clockContract());
    for (const library of ["base", "dplyr", "data.table", "collapse"] as const) {
      const session = sessionFromContract(
        "clock",
        {
          kind: "file",
          label: "time.parquet",
          path: "/workspace/time.parquet",
          uri: "file:///workspace/time.parquet"
        },
        "editing",
        contract,
        ["csv", "parquet"],
        library
      );
      const metadata = metadataFor(session);
      expect(metadata.rLibrary).toBe(library);
      expect(metadata.capabilities).toMatchObject({
        editable: true,
        filter: true,
        sort: true,
        profile: true,
        columnValues: true,
        exportCsv: true,
        exportParquet: true
      });
      const cleaningSupported = library === "base" || library === "dplyr";
      expect(canStartOperation(metadata)).toBe(cleaningSupported);
      if (!cleaningSupported) expect(metadata.capabilities.supportedOperations).toEqual([]);
      session.mode = "viewing";
      expect(metadataFor(session).capabilities).toMatchObject({
        editable: true,
        exportCsv: false,
        exportParquet: false
      });
      const ordinary = sessionFromContract(
        "ordinary",
        session.source,
        "editing",
        decodeCandidate(minimalContract()),
        [],
        library
      );
      expect(canStartOperation(metadataFor(ordinary))).toBe(true);
    }
  });

  it("refuses clock columns in unsupported native frames and nested prototypes", () => {
    expect(() => decodeCandidate(clockContract("naive", "millisecond", "ns"))).toThrow("type metadata");
    expect(() => decodeCandidate(clockContract("naive", "nanosecond", "ps"))).toThrow("type metadata");
    const candidate = clockContract();
    candidate.dataframeFlavor = "r.data.table";
    (candidate.frameSemantics as Record<string, unknown>).classes = ["data.table", "data.frame"];
    expect(() => decodeCandidate(candidate)).toThrow("base data.frame or tibble");
    const nested = clockContract();
    const column = (nested.schema as Array<Record<string, unknown>>)[0]!;
    column.semantics = { kind: "list", storageMode: "list", classes: ["list"], element: column.semantics };
    column.type = "list";
    column.rawType = "list";
    expect(() => decodeCandidate(nested)).toThrow("top-level");
  });

  it("decodes bounded native list prototypes, names, typed children and present empties", () => {
    const candidate = minimalContract();
    const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
    const row = ((candidate.page as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!;
    column.type = "list";
    column.rawType = "list";
    column.semantics = {
      kind: "list",
      storageMode: "list",
      classes: ["AsIs"],
      element: { kind: "integer64", storageMode: "double", classes: ["integer64"] }
    };
    row.values = [
      {
        kind: "list",
        raw: [
          { kind: "integer", raw: "9223372036854775807", display: "9223372036854775807", isNull: false, isNaN: false },
          { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false }
        ],
        names: ["__proto__", null],
        display: "[9223372036854775807, NA]",
        isNull: false,
        isNaN: false
      }
    ];
    const contract = decodeCandidate(candidate);
    const publicPage = gridPageFromRContract(contract);
    expect(publicPage.rows[0]!.values[0]).toMatchObject({ raw: { names: ["__proto__", null] } });
    expect(publicPage.rows[0]!.values[0]).not.toHaveProperty("names");
    const metadata = metadataFor(
      sessionFromContract(
        "nested",
        { kind: "file", label: "frame.csv", path: "/workspace/frame.csv", uri: "file:///workspace/frame.csv" },
        "viewing",
        contract,
        ["csv"],
        "base"
      )
    );
    expect(
      isOpenWranglerResponse({ kind: "page", revision: 0, viewRequestId: "nested-page", metadata, page: publicPage })
    ).toBe(true);
    const decoded = contract.page.rows[0]!.values[0]!;
    expect(decoded).toMatchObject({
      kind: "list",
      names: ["__proto__", null],
      raw: [{ raw: "9223372036854775807" }, { isNull: true }]
    });
    expect(Object.isFrozen(decoded.raw)).toBe(true);
    expect(Object.isFrozen((decoded.raw as unknown[])[0])).toBe(true);
    const cell = (row.values as Array<Record<string, unknown>>)[0]!;
    cell.names = ["__proto__"];
    expect(() => decodeCandidate(candidate)).toThrow("names");
    cell.names = ["__proto__", null];
    cell.raw = [{ kind: "number", raw: "1", display: "1", isNull: false, isNaN: false }];
    delete cell.names;
    expect(() => decodeCandidate(candidate)).toThrow("kind does not match");
    (column.semantics as Record<string, unknown>).element = null;
    expect(() => decodeCandidate(candidate)).toThrow("captured prototype");
    cell.raw = [];
    cell.display = "[]";
    expect(decodeCandidate(candidate).page.rows[0]!.values[0]).toMatchObject({ kind: "list", raw: [], isNull: false });
  });

  it("aligns flat record children with validated unique field prototypes and refuses recursion", () => {
    const candidate = minimalContract();
    const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
    const row = ((candidate.page as Record<string, unknown>).rows as Array<Record<string, unknown>>)[0]!;
    column.type = "struct";
    column.rawType = "list";
    const leaf = { kind: "integer", storageMode: "integer", classes: ["integer"] };
    const fields = [
      { name: "__proto__", semantics: leaf },
      { name: "count", semantics: leaf }
    ];
    column.semantics = { kind: "struct", storageMode: "list", classes: ["list"], fields };
    row.values = [
      {
        kind: "struct",
        raw: [
          { kind: "integer", raw: "2", display: "2", isNull: false, isNaN: false },
          { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false }
        ],
        display: "{__proto__ = 2, count = NA}",
        isNull: false,
        isNaN: false
      }
    ];
    const decoded = decodeCandidate(candidate);
    expect(decoded.schema[0]!.semantics).toMatchObject({ fields });
    expect(Object.isFrozen((decoded.schema[0]!.semantics as { fields: readonly unknown[] }).fields[0])).toBe(true);
    fields[1]!.name = "__proto__";
    expect(() => decodeCandidate(candidate)).toThrow("unique nonempty");
    fields[1]!.name = "count";
    expect(() =>
      decodeRFramePageJson(
        JSON.stringify({
          ...candidate,
          schema: [
            {
              ...column,
              semantics: {
                kind: "list",
                storageMode: "list",
                classes: ["list"],
                element: { kind: "list", storageMode: "list", classes: ["list"], element: null }
              }
            }
          ]
        })
      )
    ).toThrow("atomic leaf");
  });

  it("accepts a strict frame page and freezes it", () => {
    const decoded = decodeRFramePageJson(JSON.stringify(minimalContract()));

    expect(decoded.dataframeFlavor).toBe("r.data.frame");
    expect(decoded.schema[0]).toMatchObject({ id: "r:c:0", name: "value", type: "integer" });
    expect(decoded.page.rows[0]?.values[0]).toMatchObject({ kind: "integer", raw: "1" });
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.schema)).toBe(true);
    expect(Object.isFrozen(decoded.page.rows[0]?.values)).toBe(true);
  });

  it("keeps duplicate names safe while retained source identities become sparse", () => {
    const candidate = minimalContract();
    candidate.shape = { rows: 1, columns: 2 };
    candidate.schema = [
      ...(candidate.schema as unknown[]),
      {
        id: "r:c:2",
        name: "value",
        position: 1,
        rawType: "character",
        type: "string",
        nullable: false,
        semantics: { kind: "character", storageMode: "character", classes: ["character"] }
      }
    ];
    const page = candidate.page as Record<string, unknown>;
    page.columnLimit = 2;
    page.columnIds = ["r:c:0", "r:c:2"];
    const row = (page.rows as Array<Record<string, unknown>>)[0];
    if (!row) throw new Error("test row missing");
    row.values = [
      { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false },
      { kind: "string", raw: "one", display: "one", isNull: false, isNaN: false }
    ];

    const decoded = decodeCandidate(candidate);
    expect(decoded.schema.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "r:c:0", name: "value" },
      { id: "r:c:2", name: "value" }
    ]);
  });

  it("accepts a bounded step-derived column identity", () => {
    const candidate = minimalContract();
    candidate.shape = { rows: 1, columns: 2 };
    candidate.schema = [
      ...(candidate.schema as unknown[]),
      {
        id: "c:step:clone:with:colons:0",
        name: "value copy",
        position: 1,
        rawType: "integer",
        type: "integer",
        nullable: false,
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      }
    ];
    const page = candidate.page as Record<string, unknown>;
    page.columnLimit = 2;
    page.columnIds = ["r:c:0", "c:step:clone:with:colons:0"];
    const row = (page.rows as Array<Record<string, unknown>>)[0];
    if (!row) throw new Error("test row missing");
    row.values = [
      { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false },
      { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }
    ];

    expect(decodeCandidate(candidate).schema.map(({ id }) => id)).toEqual(["r:c:0", "c:step:clone:with:colons:0"]);
  });

  it("accepts a derived identity whose step component is exactly at its UTF-8 byte limit", () => {
    const candidate = minimalContract();
    const stepId = "é".repeat(R_FRAME_CONTRACT_LIMITS.stepIdBytes / 2);
    expect(Buffer.byteLength(stepId, "utf8")).toBe(R_FRAME_CONTRACT_LIMITS.stepIdBytes);
    const id = `c:step:${stepId}:0`;
    (candidate.schema as Array<Record<string, unknown>>)[0]!.id = id;
    (candidate.page as Record<string, unknown>).columnIds = [id];

    expect(decodeCandidate(candidate).schema[0]?.id).toBe(id);
  });

  it("rejects a derived identity whose step component exceeds its UTF-8 byte limit", () => {
    const candidate = minimalContract();
    const stepId = `${"é".repeat(R_FRAME_CONTRACT_LIMITS.stepIdBytes / 2)}x`;
    expect(Buffer.byteLength(stepId, "utf8")).toBe(R_FRAME_CONTRACT_LIMITS.stepIdBytes + 1);
    const id = `c:step:${stepId}:0`;
    (candidate.schema as Array<Record<string, unknown>>)[0]!.id = id;
    (candidate.page as Record<string, unknown>).columnIds = [id];

    expect(() => decodeCandidate(candidate)).toThrow("oversized step identity");
  });

  it.each(["c:step::0", "c:step:clone:-1", "c:step:clone:00", "c:step:clone:2048", "created:clone:0"])(
    "rejects malformed derived column identity %s",
    (id) => {
      const candidate = minimalContract();
      (candidate.schema as Array<Record<string, unknown>>)[0]!.id = id;
      (candidate.page as Record<string, unknown>).columnIds = [id];

      expect(() => decodeCandidate(candidate)).toThrow("stable R column ID");
    }
  );

  it("rejects a derived column identity containing NUL", () => {
    const candidate = minimalContract();
    const id = "c:step:clone\u0000id:0";
    (candidate.schema as Array<Record<string, unknown>>)[0]!.id = id;
    (candidate.page as Record<string, unknown>).columnIds = [id];

    expect(() => decodeCandidate(candidate)).toThrow("stable R column ID");
  });

  it("rejects an oversized derived column identity", () => {
    const candidate = minimalContract();
    const id = `c:step:${"x".repeat(R_FRAME_CONTRACT_LIMITS.columnIdBytes)}:0`;
    (candidate.schema as Array<Record<string, unknown>>)[0]!.id = id;
    (candidate.page as Record<string, unknown>).columnIds = [id];

    expect(() => decodeCandidate(candidate)).toThrow("schema[0].id must be a bounded UTF-8 string");
  });

  it.each(["__open_wrangler_internal_row_id_forged", "__OPEN_WRANGLER_INTERNAL_ROW_ID_forged"])(
    "rejects a transported schema name in the private row-identity namespace: %s",
    (name) => {
      const candidate = minimalContract();
      (candidate.schema as Array<Record<string, unknown>>)[0]!.name = name;

      expect(() => decodeCandidate(candidate)).toThrow("private row-identity prefix");
    }
  );

  it("keeps explicit row names as bounded labels without changing source identity", () => {
    const candidate = minimalContract();
    candidate.frameSemantics = { classes: ["data.frame"], rowNames: "explicit", keyColumnIds: [] };
    const page = candidate.page as Record<string, unknown>;
    (page.rows as Array<Record<string, unknown>>)[0]!.rowLabel = "Mazda RX4";

    const decoded = decodeCandidate(candidate);

    expect(decoded.frameSemantics.rowNames).toBe("explicit");
    expect(decoded.page.rows[0]).toMatchObject({ id: "r:r:0", rowNumber: 0, rowLabel: "Mazda RX4" });
  });

  it("accepts unique source row identities in logical view order", () => {
    const candidate = minimalContract();
    candidate.shape = { rows: 3, columns: 1 };
    const page = candidate.page as Record<string, unknown>;
    page.limit = 2;
    page.totalRows = 3;
    page.rows = [
      {
        id: "r:r:2",
        rowNumber: 0,
        values: [{ kind: "integer", raw: "3", display: "3", isNull: false, isNaN: false }]
      },
      {
        id: "r:r:0",
        rowNumber: 1,
        values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }]
      }
    ];

    expect(decodeCandidate(candidate).page.rows.map(({ id, rowNumber }) => ({ id, rowNumber }))).toEqual([
      { id: "r:r:2", rowNumber: 0 },
      { id: "r:r:0", rowNumber: 1 }
    ]);
  });

  it("accepts a filtered logical row count while keeping source row identities", () => {
    const candidate = minimalContract();
    candidate.shape = { rows: 5, columns: 1 };
    const page = candidate.page as Record<string, unknown>;
    page.totalRows = 2;
    page.rows = [
      {
        id: "r:r:4",
        rowNumber: 0,
        values: [{ kind: "integer", raw: "5", display: "5", isNull: false, isNaN: false }]
      }
    ];

    expect(decodeCandidate(candidate).page).toMatchObject({
      totalRows: 2,
      rows: [{ id: "r:r:4", rowNumber: 0 }]
    });
  });

  it.each([
    [
      "duplicate source row identities",
      (rows: Array<Record<string, unknown>>) => {
        rows[1]!.id = "r:r:2";
      }
    ],
    [
      "an out-of-range source row identity",
      (rows: Array<Record<string, unknown>>) => {
        rows[0]!.id = "r:r:3";
      }
    ]
  ])("rejects %s in a logical view page", (_label, mutate) => {
    const candidate = minimalContract();
    candidate.shape = { rows: 3, columns: 1 };
    const page = candidate.page as Record<string, unknown>;
    page.limit = 2;
    page.totalRows = 3;
    const rows = [
      {
        id: "r:r:2",
        rowNumber: 0,
        values: [{ kind: "integer", raw: "3", display: "3", isNull: false, isNaN: false }]
      },
      {
        id: "r:r:0",
        rowNumber: 1,
        values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }]
      }
    ];
    mutate(rows);
    page.rows = rows;

    expect(() => decodeCandidate(candidate)).toThrow(TypeError);
  });

  it("rejects source row numbers in place of logical grid positions", () => {
    const candidate = minimalContract();
    candidate.shape = { rows: 3, columns: 1 };
    const page = candidate.page as Record<string, unknown>;
    page.limit = 1;
    page.totalRows = 3;
    page.rows = [
      {
        id: "r:r:2",
        rowNumber: 2,
        values: [{ kind: "integer", raw: "3", display: "3", isNull: false, isNaN: false }]
      }
    ];

    expect(() => decodeCandidate(candidate)).toThrow("logical grid position");
  });

  it.each([
    [
      "a row label on positional row names",
      (candidate: Record<string, unknown>) => {
        const page = candidate.page as Record<string, unknown>;
        (page.rows as Array<Record<string, unknown>>)[0]!.rowLabel = "unexpected";
      }
    ],
    [
      "a missing label on explicit row names",
      (candidate: Record<string, unknown>) => {
        candidate.frameSemantics = { classes: ["data.frame"], rowNames: "explicit", keyColumnIds: [] };
      }
    ],
    [
      "an oversized explicit row label",
      (candidate: Record<string, unknown>) => {
        candidate.frameSemantics = { classes: ["data.frame"], rowNames: "explicit", keyColumnIds: [] };
        const page = candidate.page as Record<string, unknown>;
        (page.rows as Array<Record<string, unknown>>)[0]!.rowLabel = "x".repeat(R_FRAME_CONTRACT_LIMITS.nameBytes + 1);
      }
    ]
  ])("rejects %s", (_label, mutate) => {
    const candidate = minimalContract();
    mutate(candidate);
    expect(() => decodeCandidate(candidate)).toThrow(TypeError);
  });

  it.each([
    ["unknown top-level fields", (candidate: Record<string, unknown>) => (candidate.extra = true)],
    [
      "flavor/class disagreement",
      (candidate: Record<string, unknown>) => {
        candidate.dataframeFlavor = "r.tibble";
      }
    ],
    [
      "malformed source column IDs",
      (candidate: Record<string, unknown>) => {
        (candidate.schema as Array<Record<string, unknown>>)[0]!.id = "r:c:01";
      }
    ],
    [
      "metadata/type disagreement",
      (candidate: Record<string, unknown>) => {
        (candidate.schema as Array<Record<string, unknown>>)[0]!.type = "string";
      }
    ],
    [
      "a lone surrogate in a name",
      (candidate: Record<string, unknown>) => {
        (candidate.schema as Array<Record<string, unknown>>)[0]!.name = "\ud800";
      }
    ],
    [
      "row width disagreement",
      (candidate: Record<string, unknown>) => {
        const page = candidate.page as Record<string, unknown>;
        (page.rows as Array<Record<string, unknown>>)[0]!.values = [];
      }
    ],
    [
      "NA in a non-nullable column",
      (candidate: Record<string, unknown>) => {
        const page = candidate.page as Record<string, unknown>;
        (page.rows as Array<Record<string, unknown>>)[0]!.values = [
          { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false }
        ];
      }
    ],
    [
      "an out-of-range integer64",
      (candidate: Record<string, unknown>) => {
        const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
        column.rawType = "integer64";
        column.semantics = { kind: "integer64", storageMode: "double", classes: ["integer64"] };
        const page = candidate.page as Record<string, unknown>;
        (page.rows as Array<Record<string, unknown>>)[0]!.values = [
          {
            kind: "integer",
            raw: "9223372036854775808",
            display: "9223372036854775808",
            isNull: false,
            isNaN: false
          }
        ];
      }
    ],
    [
      "too many factor levels",
      (candidate: Record<string, unknown>) => {
        const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
        column.rawType = "factor";
        column.type = "string";
        column.semantics = {
          kind: "factor",
          storageMode: "integer",
          classes: ["factor"],
          levels: new Array(R_FRAME_CONTRACT_LIMITS.factorLevels + 1).fill("level"),
          ordered: false
        };
        const page = candidate.page as Record<string, unknown>;
        (page.rows as Array<Record<string, unknown>>)[0]!.values = [
          { kind: "string", raw: "level", display: "level", isNull: false, isNaN: false }
        ];
      }
    ]
  ])("rejects %s", (_label, mutate) => {
    const candidate = minimalContract();
    mutate(candidate);
    expect(() => decodeCandidate(candidate)).toThrow(TypeError);
  });

  it("rejects malformed and oversized JSON before accepting values", () => {
    expect(() => decodeRFramePageJson("{")).toThrow("not valid JSON");
    expect(() => decodeRFramePageJson("x".repeat(R_FRAME_CONTRACT_LIMITS.payloadBytes + 1))).toThrow(
      "exceeds the byte limit"
    );
  });

  it.each([
    ["R integer", "-2147483648", false],
    ["bit64 integer64", "-9223372036854775808", true]
  ])("rejects the %s NA sentinel as an ordinary value", (_label, raw, integer64) => {
    const candidate = minimalContract();
    const column = (candidate.schema as Array<Record<string, unknown>>)[0]!;
    if (integer64) {
      column.rawType = "integer64";
      column.semantics = { kind: "integer64", storageMode: "double", classes: ["integer64"] };
    }
    const page = candidate.page as Record<string, unknown>;
    (page.rows as Array<Record<string, unknown>>)[0]!.values = [
      { kind: "integer", raw, display: raw, isNull: false, isNaN: false }
    ];

    expect(() => decodeCandidate(candidate)).toThrow("outside the");
  });

  it.each(["0001-01-01", "2000-02-29", "9999-12-31"])("accepts the valid ISO date %s", (value) => {
    expect(decodeCandidate(dateContract(value)).page.rows[0]?.values[0]).toMatchObject({ raw: value });
  });

  it.each(["1900-02-29", "2026-04-31", "2026-13-01"])("rejects the invalid ISO date %s", (value) => {
    expect(() => decodeCandidate(dateContract(value))).toThrow("valid ISO date");
  });
});
