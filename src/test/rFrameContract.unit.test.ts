import { describe, expect, it } from "vitest";
import { decodeRFramePageJson, R_FRAME_CONTRACT_LIMITS } from "../extension/r/rFrameContract";

function decodeCandidate(candidate: Record<string, unknown>) {
  return decodeRFramePageJson(JSON.stringify(candidate));
}

function minimalContract(): Record<string, unknown> {
  return {
    contractVersion: 4,
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

describe("native R frame contract decoder", () => {
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
