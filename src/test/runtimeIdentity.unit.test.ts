import { describe, expect, it } from "vitest";
import type { DataBackend } from "../shared/protocol";
import { CODE_PREVIEW_MAX_UTF8_BYTES, isValidCodePreviewText } from "../shared/codePreviewLimits";
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
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const bufferId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const polarsIdentity = runtimeIdentityForDataBackend("polars");
  const pysparkIdentity = runtimeIdentityForDataBackend("pyspark");
  const rIdentity = runtimeIdentityForSessionMetadata({ backend: "r", rDataframeFlavor: "r.tibble" });

  it("accepts the current private host and webview messages", () => {
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        bufferId,
        bufferInvalid: false,
        code: "def clean_data(df):\n    return df\n",
        editable: true,
        runtimeIdentity: polarsIdentity
      })
    ).toBe(true);
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        bufferId,
        bufferInvalid: false,
        code: "# Open a dataframe to preview generated code.",
        editable: false,
        runtimeIdentity: null
      })
    ).toBe(true);
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        bufferId,
        bufferInvalid: false,
        code: "# PySpark viewing-only session.",
        editable: false,
        runtimeIdentity: pysparkIdentity
      })
    ).toBe(true);
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        bufferId,
        bufferInvalid: false,
        code: "clean_data <- function(df) df\n",
        editable: true,
        runtimeIdentity: rIdentity
      })
    ).toBe(true);
    expect(isCodePreviewHostMessage({ kind: "codeSnapshotRequest", requestId, bufferId })).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "ready" })).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "codeChanged", bufferId, code: "# edited" })).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "codeChangedInvalid", bufferId })).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "codeSnapshot", requestId, bufferId, code: "# current" })).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "codeSnapshotInvalid", requestId, bufferId })).toBe(true);
  });

  it.each([
    ["ASCII at limit", "abcd", 4, true],
    ["ASCII over limit", "abcde", 4, false],
    ["two-byte text at limit", "éé", 4, true],
    ["two-byte text over limit", "ééa", 4, false],
    ["three-byte text at limit", "€", 3, true],
    ["three-byte text over limit", "€a", 3, false],
    ["astral text at limit", "🧪", 4, true],
    ["astral text over limit", "🧪a", 4, false],
    ["mixed text at limit", "aé€🧪", 10, true],
    ["mixed text over limit", "aé€🧪a", 10, false],
    ["terminal high surrogate", "\ud800", 4, false],
    ["lone low surrogate", "\udc00", 4, false],
    ["interrupted surrogate pair", "before\ud800after", 64, false]
  ])("validates %s", (_label, code, maximumUtf8Bytes, expected) => {
    expect(isValidCodePreviewText(code, maximumUtf8Bytes)).toBe(expected);
  });

  it("wires the generated-code ceiling into both message decoders", () => {
    const oversized = "a".repeat(CODE_PREVIEW_MAX_UTF8_BYTES + 1);
    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        bufferId,
        bufferInvalid: false,
        code: oversized,
        editable: true,
        runtimeIdentity: polarsIdentity
      })
    ).toBe(false);
    expect(isCodePreviewWebviewMessage({ kind: "codeChanged", bufferId, code: oversized })).toBe(false);
  });

  it.each([
    { kind: "codePreview", bufferId, bufferInvalid: false, code: "# missing identity", editable: false },
    { kind: "codeSnapshotRequest", requestId: "not-a-request-id", bufferId },
    {
      kind: "codePreview",
      bufferId,
      bufferInvalid: false,
      code: "# unknown field",
      editable: false,
      runtimeIdentity: polarsIdentity,
      unknown: true
    },
    {
      kind: "codePreview",
      bufferId,
      bufferInvalid: false,
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
    { kind: "codeChangedInvalid", bufferId, unknown: true },
    { kind: "codeChanged", bufferId, code: "# edited", unknown: true },
    { kind: "codeSnapshot", requestId: "not-a-request-id", bufferId, code: "# edited" },
    { kind: "codeSnapshotInvalid", requestId, bufferId, unknown: true },
    { kind: "future" }
  ])("rejects a malformed private webview message: %j", (candidate) => {
    expect(isCodePreviewWebviewMessage(candidate)).toBe(false);
  });
});
