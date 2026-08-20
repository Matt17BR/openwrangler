import { describe, expect, it } from "vitest";
import type { SessionSource } from "../shared/protocol";
import {
  automaticBackends,
  isFileDataBackend,
  isSupportedPythonVersion,
  requiredDependencies,
  trustedPickleConversionDependencies
} from "../extension/pythonEnvironmentModel";

describe("Python environment requirements", () => {
  it("accepts exactly the supported Python minor range", () => {
    expect(isSupportedPythonVersion(3, 10)).toBe(true);
    expect(isSupportedPythonVersion(3, 14)).toBe(true);
    expect(isSupportedPythonVersion(3, 9)).toBe(false);
    expect(isSupportedPythonVersion(3, 15)).toBe(false);
    expect(isSupportedPythonVersion(2, 14)).toBe(false);
  });

  it("probes only modules required by the selected engine and format", () => {
    const parquet: SessionSource = { kind: "file", label: "data.parquet", path: "/tmp/data.parquet" };
    const xlsx: SessionSource = { kind: "file", label: "data.xlsx", path: "/tmp/data.xlsx" };
    const xls: SessionSource = { kind: "file", label: "legacy.xls", path: "/tmp/legacy.xls" };

    expect(requiredDependencies("polars", parquet).map((item) => item.installSpec)).toEqual(["polars>=1.35.2,<2"]);
    expect(requiredDependencies("duckdb", parquet)).toEqual([
      {
        importModule: "duckdb",
        distribution: "duckdb",
        installSpec: "duckdb>=1.5.4,<1.6",
        minimumVersion: "1.5.4",
        maximumVersionExclusive: "1.6"
      },
      {
        importModule: "fsspec",
        distribution: "fsspec",
        installSpec: "fsspec==2026.7.0",
        exactVersion: "2026.7.0"
      },
      {
        importModule: "pytz",
        distribution: "pytz",
        installSpec: "pytz>=2026.3.post1,<2027",
        minimumVersion: "2026.3.post1",
        maximumVersionExclusive: "2027"
      }
    ]);
    expect(requiredDependencies("pandas", parquet).map((item) => item.installSpec)).toEqual([
      "pandas>=2.2,<3",
      "pyarrow>=25,<26"
    ]);
    expect(requiredDependencies("pandas", xlsx)).toEqual([
      {
        importModule: "pandas",
        distribution: "pandas",
        installSpec: "pandas>=2.2,<3",
        minimumVersion: "2.2",
        maximumVersionExclusive: "3"
      },
      {
        importModule: "openpyxl",
        distribution: "openpyxl",
        installSpec: "openpyxl>=3.1.5,<4",
        minimumVersion: "3.1.5",
        maximumVersionExclusive: "4"
      }
    ]);
    expect(requiredDependencies("pandas", xls)).toEqual([
      {
        importModule: "pandas",
        distribution: "pandas",
        installSpec: "pandas>=2.2,<3",
        minimumVersion: "2.2",
        maximumVersionExclusive: "3"
      },
      {
        importModule: "xlrd",
        distribution: "xlrd",
        installSpec: "xlrd>=2.0.1,<3",
        minimumVersion: "2.0.1",
        maximumVersionExclusive: "3"
      }
    ]);
    expect(requiredDependencies("polars", xlsx).map((item) => item.installSpec)).toEqual([
      "polars>=1.35.2,<2",
      "fastexcel>=0.9,<1"
    ]);
    expect(requiredDependencies("polars", xls).map((item) => item.installSpec)).toEqual([
      "polars>=1.35.2,<2",
      "fastexcel>=0.9,<1"
    ]);
  });

  it("requires Pandas and PyArrow for trusted pickle conversion", () => {
    expect(trustedPickleConversionDependencies()).toEqual([
      {
        importModule: "pandas",
        distribution: "pandas",
        installSpec: "pandas>=2.2,<3",
        minimumVersion: "2.2",
        maximumVersionExclusive: "3"
      },
      {
        importModule: "pyarrow",
        distribution: "pyarrow",
        installSpec: "pyarrow>=25,<26",
        minimumVersion: "25",
        maximumVersionExclusive: "26"
      }
    ]);
  });

  it("prefers native engines deterministically without offering unsupported DuckDB inputs", () => {
    const parquet: SessionSource = { kind: "file", label: "data.parquet", path: "/tmp/data.parquet" };
    const excel: SessionSource = { kind: "file", label: "data.xlsx", path: "/tmp/data.xlsx" };
    const legacyExcel: SessionSource = { kind: "file", label: "data.xls", path: "/tmp/data.xls" };
    const latin1: SessionSource = {
      kind: "file",
      label: "legacy.csv",
      path: "/tmp/legacy.csv",
      importOptions: { encoding: "latin-1" }
    };
    const lossyUtf8: SessionSource = {
      kind: "file",
      label: "damaged.csv",
      path: "/tmp/damaged.csv",
      importOptions: { encoding: "utf8-lossy" }
    };
    const utf16Le: SessionSource = {
      kind: "file",
      label: "little-endian.csv",
      path: "/tmp/little-endian.csv",
      importOptions: { encoding: "utf-16le" }
    };
    const utf16Be: SessionSource = {
      kind: "file",
      label: "big-endian.tsv",
      path: "/tmp/big-endian.tsv",
      importOptions: { encoding: "utf-16be" }
    };

    expect(automaticBackends(parquet)).toEqual(["polars", "duckdb", "pandas"]);
    expect(automaticBackends(excel)).toEqual(["polars", "pandas"]);
    expect(automaticBackends(legacyExcel)).toEqual(["polars", "pandas"]);
    expect(automaticBackends(latin1)).toEqual(["pandas"]);
    expect(automaticBackends(lossyUtf8)).toEqual(["pandas"]);
    expect(automaticBackends(utf16Le)).toEqual(["pandas"]);
    expect(automaticBackends(utf16Be)).toEqual(["pandas"]);
    expect(requiredDependencies(automaticBackends(lossyUtf8)[0], lossyUtf8).map((item) => item.installSpec)).toEqual([
      "pandas>=2.2,<3"
    ]);
    expect(isFileDataBackend("pyspark")).toBe(false);
    expect(automaticBackends(parquet)).not.toContain("pyspark");
  });

  it("routes multibyte CSV controls only through engines that accept them", () => {
    const multibyteDelimiter: SessionSource = {
      kind: "file",
      label: "localized.csv",
      path: "/tmp/localized.csv",
      importOptions: { delimiter: "§" }
    };
    const multibyteQuote: SessionSource = {
      kind: "file",
      label: "quoted.tsv",
      path: "/tmp/quoted.tsv",
      importOptions: { quoteChar: "“" }
    };
    const both: SessionSource = {
      ...multibyteDelimiter,
      importOptions: { delimiter: "§", quoteChar: "“" }
    };

    expect(automaticBackends(multibyteDelimiter)).toEqual(["duckdb", "pandas"]);
    expect(automaticBackends(multibyteQuote)).toEqual(["pandas"]);
    expect(automaticBackends(both)).toEqual(["pandas"]);
  });
});
