import { isRLibrary, type DataBackend, type RLibrary, type SessionMetadata } from "./protocol";

type RDataframeFlavor = NonNullable<SessionMetadata["rDataframeFlavor"]>;

export type RuntimeLanguage = "python" | "r";
export type DataframeFlavor = "pandas" | "polars" | "duckdb" | "pyspark" | RDataframeFlavor;
export type CodeDialect = "python.pandas" | "python.polars" | "python.duckdb" | `r.${RLibrary}`;

export interface RuntimeIdentity {
  readonly runtimeLanguage: RuntimeLanguage;
  readonly dataframeFlavor: DataframeFlavor;
  readonly codeDialect: CodeDialect | null;
}

const PYTHON_RUNTIME_IDENTITIES = Object.freeze({
  polars: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "polars",
    codeDialect: "python.polars"
  }),
  duckdb: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "duckdb",
    codeDialect: "python.duckdb"
  }),
  pandas: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "pandas",
    codeDialect: "python.pandas"
  }),
  pyspark: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "pyspark",
    codeDialect: null
  })
} satisfies Readonly<Record<Exclude<DataBackend, "r">, RuntimeIdentity>>);

/** Derives host presentation identity only after the runtime has confirmed a concrete backend. */
export function runtimeIdentityForDataBackend(backend: Exclude<DataBackend, "r">): RuntimeIdentity {
  const identity = (PYTHON_RUNTIME_IDENTITIES as Readonly<Record<string, RuntimeIdentity | undefined>>)[backend];
  if (!identity) throw new TypeError(`Unsupported confirmed dataframe backend: ${String(backend)}`);
  return identity;
}

export function runtimeIdentityForSessionMetadata(
  metadata: Pick<SessionMetadata, "backend" | "rDataframeFlavor" | "rLibrary">
): RuntimeIdentity {
  if (metadata.backend !== "r") return runtimeIdentityForDataBackend(metadata.backend);
  if (!isRDataframeFlavor(metadata.rDataframeFlavor)) {
    throw new TypeError("An R session must identify its native dataframe flavor.");
  }
  if (!isRLibrary(metadata.rLibrary)) {
    throw new TypeError("An R session must identify its confirmed cleaning library.");
  }
  return Object.freeze({
    runtimeLanguage: "r" as const,
    dataframeFlavor: metadata.rDataframeFlavor,
    codeDialect: `r.${metadata.rLibrary}` as const
  });
}

export function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  if (!hasExactKeys(value, ["runtimeLanguage", "dataframeFlavor", "codeDialect"])) return false;
  if (isRDataframeFlavor(value.dataframeFlavor)) {
    return (
      value.runtimeLanguage === "r" &&
      typeof value.codeDialect === "string" &&
      value.codeDialect.startsWith("r.") &&
      isRLibrary(value.codeDialect.slice(2))
    );
  }
  if (!isPythonDataframeFlavor(value.dataframeFlavor)) return false;
  const expected = runtimeIdentityForDataBackend(value.dataframeFlavor);
  return (
    value.runtimeLanguage === expected.runtimeLanguage &&
    value.dataframeFlavor === expected.dataframeFlavor &&
    value.codeDialect === expected.codeDialect
  );
}

export function codeDialectLanguageLabel(codeDialect: CodeDialect | null): "Python" | "R" | undefined {
  switch (codeDialect) {
    case "python.pandas":
    case "python.polars":
    case "python.duckdb":
      return "Python";
    case "r.base":
    case "r.dplyr":
    case "r.data.table":
    case "r.collapse":
      return "R";
    case null:
      return undefined;
  }
}

function isPythonDataframeFlavor(value: unknown): value is Exclude<DataBackend, "r"> {
  return value === "polars" || value === "duckdb" || value === "pandas" || value === "pyspark";
}

function isRDataframeFlavor(value: unknown): value is RDataframeFlavor {
  return value === "r.data.frame" || value === "r.tibble" || value === "r.data.table";
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
