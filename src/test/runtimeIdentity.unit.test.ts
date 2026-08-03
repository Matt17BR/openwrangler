import { describe, expect, it } from "vitest";
import type { DataBackend } from "../shared/protocol";
import { isCodePreviewHostMessage, isCodePreviewWebviewMessage } from "../shared/codePreviewMessages";
import { isRuntimeIdentity, runtimeIdentityForDataBackend, type RuntimeIdentity } from "../shared/runtimeIdentity";

const identities: Readonly<Record<DataBackend, RuntimeIdentity>> = {
  polars: { runtimeLanguage: "python", dataframeFlavor: "polars", codeDialect: "python" },
  duckdb: { runtimeLanguage: "python", dataframeFlavor: "duckdb", codeDialect: "python" },
  pandas: { runtimeLanguage: "python", dataframeFlavor: "pandas", codeDialect: "python" },
  pyspark: { runtimeLanguage: "python", dataframeFlavor: "pyspark", codeDialect: null }
};

describe("host runtime identity", () => {
  it.each(Object.entries(identities) as Array<[DataBackend, RuntimeIdentity]>)(
    "maps the confirmed %s backend without changing its engine identity",
    (backend, expected) => {
      const actual = runtimeIdentityForDataBackend(backend);

      expect(actual).toEqual(expected);
      expect(isRuntimeIdentity(actual)).toBe(true);
      expect(Object.isFrozen(actual)).toBe(true);
    }
  );

  it("does not derive an identity from an unresolved automatic backend", () => {
    expect(() => runtimeIdentityForDataBackend("auto" as DataBackend)).toThrow(
      "Unsupported confirmed dataframe backend: auto"
    );
  });

  it.each([
    null,
    {},
    { runtimeLanguage: "python", dataframeFlavor: "polars", codeDialect: "python", extra: true },
    { runtimeLanguage: "python", dataframeFlavor: "pyspark", codeDialect: "python" },
    { runtimeLanguage: "python", dataframeFlavor: "pandas", codeDialect: null },
    { runtimeLanguage: "python", dataframeFlavor: "auto", codeDialect: "python" }
  ])("rejects a malformed or inconsistent identity: %j", (candidate) => {
    expect(isRuntimeIdentity(candidate)).toBe(false);
  });
});

describe("private Code Preview messages", () => {
  const polarsIdentity = runtimeIdentityForDataBackend("polars");
  const pysparkIdentity = runtimeIdentityForDataBackend("pyspark");

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
