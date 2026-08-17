import { describe, expect, it } from "vitest";
import { persistedReplayExportRequest } from "./extensionHost/persistedReplayExport";

describe("persisted replay export requests", () => {
  it.each(["csv", "parquet"] as const)("supplies an explicit Pandas index policy for %s", (format) => {
    expect(
      persistedReplayExportRequest(
        { backend: "pandas", sessionId: "pandas-session", revision: 7 },
        `/tmp/replayed.${format}`,
        format
      )
    ).toEqual({
      kind: "exportData",
      sessionId: "pandas-session",
      revision: 7,
      path: `/tmp/replayed.${format}`,
      format,
      rowAxisPolicy: "omit"
    });
  });

  it.each(["polars", "duckdb", "pyspark", "r"] as const)("does not send the Pandas-only policy to %s", (backend) => {
    const request = persistedReplayExportRequest(
      { backend, sessionId: `${backend}-session`, revision: 3 },
      `/tmp/${backend}.csv`,
      "csv"
    );

    expect(request).toEqual({
      kind: "exportData",
      sessionId: `${backend}-session`,
      revision: 3,
      path: `/tmp/${backend}.csv`,
      format: "csv"
    });
    expect(request).not.toHaveProperty("rowAxisPolicy");
  });
});
