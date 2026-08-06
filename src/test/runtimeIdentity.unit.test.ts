import { describe, expect, it } from "vitest";
import type { DataBackend } from "../shared/protocol";
import { isCodePreviewHostMessage, isCodePreviewWebviewMessage } from "../shared/codePreviewMessages";
import {
  codeDialectLanguageLabel,
  isRuntimeIdentity,
  runtimeIdentityForDataBackend,
  runtimeIdentityForSessionMetadata,
  type RuntimeIdentity
} from "../shared/runtimeIdentity";

type PythonDataBackend = Exclude<DataBackend, "r">;

const identities: Readonly<Record<PythonDataBackend, RuntimeIdentity>> = {
  polars: { runtimeLanguage: "python", dataframeFlavor: "polars", codeDialect: "python.polars" },
  duckdb: { runtimeLanguage: "python", dataframeFlavor: "duckdb", codeDialect: "python.duckdb" },
  pandas: { runtimeLanguage: "python", dataframeFlavor: "pandas", codeDialect: "python.pandas" },
  pyspark: { runtimeLanguage: "python", dataframeFlavor: "pyspark", codeDialect: null }
};

describe("host runtime identity", () => {
  it.each(Object.entries(identities) as Array<[PythonDataBackend, RuntimeIdentity]>)(
    "maps the confirmed %s backend without changing its engine identity",
    (backend, expected) => {
      const actual = runtimeIdentityForDataBackend(backend);

      expect(actual).toEqual(expected);
      expect(isRuntimeIdentity(actual)).toBe(true);
      expect(Object.isFrozen(actual)).toBe(true);
    }
  );

  it.each(["r.data.frame", "r.tibble", "r.data.table"] as const)(
    "keeps the native %s flavor separate from its R runtime",
    (rDataframeFlavor) => {
      const actual = runtimeIdentityForSessionMetadata({ backend: "r", rDataframeFlavor });
      expect(actual).toEqual({ runtimeLanguage: "r", dataframeFlavor: rDataframeFlavor, codeDialect: "r.base" });
      expect(isRuntimeIdentity(actual)).toBe(true);
    }
  );

  it("rejects R metadata without an exact dataframe flavor", () => {
    expect(() => runtimeIdentityForSessionMetadata({ backend: "r" })).toThrow(
      "An R session must identify its native dataframe flavor"
    );
  });

  it("does not derive an identity from an unresolved automatic backend", () => {
    expect(() => runtimeIdentityForDataBackend("auto" as PythonDataBackend)).toThrow(
      "Unsupported confirmed dataframe backend: auto"
    );
  });

  it("derives one user-facing language label from each generated-code dialect", () => {
    expect(codeDialectLanguageLabel("python.pandas")).toBe("Python");
    expect(codeDialectLanguageLabel("python.polars")).toBe("Python");
    expect(codeDialectLanguageLabel("python.duckdb")).toBe("Python");
    expect(codeDialectLanguageLabel("r.base")).toBe("R");
    expect(codeDialectLanguageLabel(null)).toBeUndefined();
  });

  it.each([
    null,
    {},
    { runtimeLanguage: "python", dataframeFlavor: "polars", codeDialect: "python.polars", extra: true },
    { runtimeLanguage: "python", dataframeFlavor: "polars", codeDialect: "python.pandas" },
    { runtimeLanguage: "python", dataframeFlavor: "pyspark", codeDialect: "python.polars" },
    { runtimeLanguage: "python", dataframeFlavor: "pandas", codeDialect: null },
    { runtimeLanguage: "r", dataframeFlavor: "r.tibble", codeDialect: null },
    { runtimeLanguage: "r", dataframeFlavor: "r.data.frame", codeDialect: "python.pandas" },
    { runtimeLanguage: "python", dataframeFlavor: "r.data.table", codeDialect: "r.base" },
    { runtimeLanguage: "python", dataframeFlavor: "auto", codeDialect: "python.pandas" }
  ])("rejects a malformed or inconsistent identity: %j", (candidate) => {
    expect(isRuntimeIdentity(candidate)).toBe(false);
  });
});

describe("private Code Preview messages", () => {
  const polarsIdentity = runtimeIdentityForDataBackend("polars");
  const pysparkIdentity = runtimeIdentityForDataBackend("pyspark");
  const rIdentity = runtimeIdentityForSessionMetadata({ backend: "r", rDataframeFlavor: "r.tibble" });

  it("accepts the current private host and webview messages", () => {
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        code: "def clean_data(df):\n    return df\n",
        editable: true,
        runtimeIdentity: polarsIdentity
      })
    ).toBe(true);
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        code: "# Open a dataframe to preview generated code.",
        editable: false,
        runtimeIdentity: null
      })
    ).toBe(true);
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        code: "# PySpark viewing-only session.",
        editable: false,
        runtimeIdentity: pysparkIdentity
      })
    ).toBe(true);
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        code: "clean_data <- function(df) df\n",
        editable: true,
        runtimeIdentity: rIdentity
      })
    ).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "ready" })).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "codeChanged", code: "# edited" })).toBe(true);
  });

  it.each([
    { kind: "codePreview", code: "# missing identity", editable: false },
    {
      kind: "codePreview",
      code: "# unknown field",
      editable: false,
      runtimeIdentity: polarsIdentity,
      unknown: true
    },
    {
      kind: "codePreview",
      code: "# no generated dialect",
      editable: true,
      runtimeIdentity: pysparkIdentity
    }
  ])("rejects a malformed private host message: %j", (candidate) => {
    expect(isCodePreviewHostMessage(candidate)).toBe(false);
  });

  it.each([
    { kind: "ready", unknown: true },
    { kind: "codeChanged" },
    { kind: "codeChanged", code: "# edited", unknown: true },
    { kind: "future" }
  ])("rejects a malformed private webview message: %j", (candidate) => {
    expect(isCodePreviewWebviewMessage(candidate)).toBe(false);
  });
});
