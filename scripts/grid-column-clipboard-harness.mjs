export function createGridColumnClipboardHarness(opened) {
  const payload = structuredClone(opened);
  payload.metadata = {
    ...payload.metadata,
    shape: { rows: 64, columns: 4 },
    filteredShape: { rows: 64, columns: 4 },
    schema: payload.metadata.schema.slice(0, 4).map((column, position) => ({
      ...column,
      name: ["hostile_text", "typed_negative", "exact_cap", "over_cap"][position],
      position,
      rawType: position === 1 ? "Int64" : "String",
      type: position === 1 ? "integer" : "string",
      nullable: false
    }))
  };
  payload.page = {
    offset: 0,
    limit: 2,
    totalRows: 64,
    columnIds: payload.metadata.schema.map((column) => column.id),
    rows: Array.from({ length: 2 }, (_, rowNumber) => ({
      id: `r:column-clipboard:${rowNumber}`,
      rowNumber,
      values: payload.metadata.schema.map((_, column) =>
        column === 1
          ? {
              kind: "integer",
              raw: String(-(rowNumber + 1)),
              display: String(-(rowNumber + 1)),
              isNull: false,
              isNaN: false
            }
          : { kind: "string", display: `value-${rowNumber + 1}`, isNull: false, isNaN: false }
      )
    }))
  };
  return [
    "grid-column-clipboard.html",
    payload,
    {},
    "acceptance/grid-column-clipboard-unused.png",
    {},
    { capture: false, clipboardColumnFixture: true, fetchRowBlockSize: 2, strictProjectedPages: true }
  ];
}
