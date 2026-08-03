import type { DataBackend } from "./protocol.generated";

export type RuntimeLanguage = "python";
export type DataframeFlavor = "pandas" | "polars" | "duckdb" | "pyspark";
export type CodeDialect = "python";

export interface RuntimeIdentity {
  readonly runtimeLanguage: RuntimeLanguage;
  readonly dataframeFlavor: DataframeFlavor;
  readonly codeDialect: CodeDialect | null;
}

const RUNTIME_IDENTITIES = Object.freeze({
  polars: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "polars",
    codeDialect: "python"
  }),
  duckdb: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "duckdb",
    codeDialect: "python"
  }),
  pandas: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "pandas",
    codeDialect: "python"
  }),
  pyspark: Object.freeze({
    runtimeLanguage: "python",
    dataframeFlavor: "pyspark",
    codeDialect: null
  })
} satisfies Readonly<Record<DataBackend, RuntimeIdentity>>);

/** Derives host presentation identity only after the runtime has confirmed a concrete backend. */
export function runtimeIdentityForDataBackend(backend: DataBackend): RuntimeIdentity {
  const identity = (RUNTIME_IDENTITIES as Readonly<Record<string, RuntimeIdentity | undefined>>)[backend];
  if (!identity) throw new TypeError(`Unsupported confirmed dataframe backend: ${String(backend)}`);
  return identity;
}

export function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  if (!hasExactKeys(value, ["runtimeLanguage", "dataframeFlavor", "codeDialect"])) return false;
  if (!isDataBackend(value.dataframeFlavor)) return false;
  const expected = runtimeIdentityForDataBackend(value.dataframeFlavor);
  return (
    value.runtimeLanguage === expected.runtimeLanguage &&
    value.dataframeFlavor === expected.dataframeFlavor &&
    value.codeDialect === expected.codeDialect
  );
}

function isDataBackend(value: unknown): value is DataBackend {
  return value === "polars" || value === "duckdb" || value === "pandas" || value === "pyspark";
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
