import { randomUUID } from "node:crypto";
import type { Jupyter, Kernel } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import type { DataBackend } from "../../shared/protocol";
import { DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS } from "../configuration";
import { withKernelTimeout } from "./kernelLifecycle";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

const DISCOVERY_PROTOCOL_VERSION = 1;
const MAX_DISCOVERY_VARIABLES = 256;
const MAX_DISCOVERY_SCANNED_VARIABLES = 4_096;
const MAX_DISCOVERY_NAME_CHARACTERS = 128;
const MAX_DISCOVERY_OUTPUT_BYTES = 64 * 1024;
const MAX_DISCOVERY_OUTPUTS = 128;
const MAX_DISCOVERY_OUTPUT_ITEMS = 256;

const NOTEBOOK_VARIABLE_TYPES = {
  "pandas.core.frame.DataFrame": { backend: "pandas", family: "Pandas", kind: "DataFrame" },
  "pandas.core.series.Series": { backend: "pandas", family: "Pandas", kind: "Series" },
  "polars.dataframe.frame.DataFrame": { backend: "polars", family: "Polars", kind: "DataFrame" },
  "polars.lazyframe.frame.LazyFrame": { backend: "polars", family: "Polars", kind: "LazyFrame" },
  "polars.series.series.Series": { backend: "polars", family: "Polars", kind: "Series" },
  "pyspark.sql.dataframe.DataFrame": { backend: "pyspark", family: "PySpark Classic", kind: "DataFrame" },
  "pyspark.sql.classic.dataframe.DataFrame": {
    backend: "pyspark",
    family: "PySpark Classic",
    kind: "DataFrame"
  },
  "pyspark.sql.connect.dataframe.DataFrame": {
    backend: "pyspark",
    family: "PySpark Connect",
    kind: "DataFrame"
  },
  "_duckdb.DuckDBPyRelation": { backend: "duckdb", family: "DuckDB", kind: "DuckDBPyRelation" },
  "duckdb.duckdb.DuckDBPyRelation": { backend: "duckdb", family: "DuckDB", kind: "DuckDBPyRelation" }
} as const satisfies Record<string, { backend: DataBackend; family: string; kind: string }>;

export type NotebookVariableType = keyof typeof NOTEBOOK_VARIABLE_TYPES;

export interface NotebookVariableDescriptor {
  readonly name: string;
  readonly type: NotebookVariableType;
  readonly backend: DataBackend;
}

export interface NotebookVariableDiscovery {
  readonly variables: readonly NotebookVariableDescriptor[];
  readonly truncated: boolean;
}

export class NotebookVariableDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotebookVariableDiscoveryError";
  }
}

export async function discoverNotebookVariables(notebook: vscode.NotebookDocument): Promise<NotebookVariableDiscovery> {
  try {
    assertNotebookProvenance(notebook);
    if (!vscode.workspace.isTrusted) {
      throw new NotebookVariableDiscoveryError("Trust this workspace before Open Wrangler inspects a notebook kernel.");
    }

    const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    if (!extension) {
      throw new NotebookVariableDiscoveryError(
        "Install or enable the VS Code Jupyter extension to discover live notebook dataframes."
      );
    }

    const api = await revalidateAfter(extension.activate(), notebook);
    if (!isJupyterApi(api)) {
      throw new NotebookVariableDiscoveryError("Open Wrangler could not access the public Jupyter kernel API.");
    }
    const kernel = await revalidateAfter(api.kernels.getKernel(notebook.uri), notebook);
    if (!isKernel(kernel)) {
      throw new NotebookVariableDiscoveryError(
        "Open Wrangler could not access the selected Jupyter kernel for this notebook."
      );
    }
    if (kernel.language.toLowerCase() !== "python") {
      throw new NotebookVariableDiscoveryError(
        `Open Wrangler requires a Python notebook kernel; the selected kernel uses ${kernel.language}.`
      );
    }

    return await revalidateAfter(executeDiscovery(kernel, notebook), notebook);
  } catch (error) {
    if (error instanceof NotebookVariableDiscoveryError) throw error;
    throw new NotebookVariableDiscoveryError(
      "Open Wrangler could not inspect dataframe variables in the selected notebook kernel."
    );
  }
}

export function notebookVariablePresentation(type: NotebookVariableType): {
  readonly backend: DataBackend;
  readonly family: string;
  readonly kind: string;
} {
  return NOTEBOOK_VARIABLE_TYPES[type];
}

export function isLiveNotebookVariableBackend(backend: DataBackend): boolean {
  return backend === "pandas" || backend === "polars" || backend === "pyspark";
}

async function executeDiscovery(kernel: Kernel, notebook: vscode.NotebookDocument): Promise<NotebookVariableDiscovery> {
  const marker = randomUUID().replaceAll("-", "");
  const tokenSource = new vscode.CancellationTokenSource();
  const abort = (): void => tokenSource.cancel();
  try {
    const output = kernel.executeCode(buildNotebookVariableDiscoveryCode(marker), tokenSource.token);
    const text = await revalidateAfter(
      withKernelTimeout(collectBoundedKernelText(output, notebook), DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS, abort),
      notebook
    );
    return parseNotebookVariableDiscoveryOutput(text, marker);
  } catch (error) {
    abort();
    throw error;
  } finally {
    tokenSource.dispose();
  }
}

async function collectBoundedKernelText(
  output: ReturnType<Kernel["executeCode"]>,
  notebook: vscode.NotebookDocument
): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  let outputCount = 0;
  let itemCount = 0;
  const iterator = output[Symbol.asyncIterator]();
  while (true) {
    const next = await revalidateAfter(iterator.next(), notebook);
    if (next.done) break;
    outputCount += 1;
    if (outputCount > MAX_DISCOVERY_OUTPUTS) {
      throw oversizedDiscoveryResponse();
    }
    if (!isKernelOutput(next.value)) {
      throw malformedDiscoveryResponse();
    }
    itemCount += next.value.items.length;
    if (next.value.items.length > MAX_DISCOVERY_OUTPUT_ITEMS || itemCount > MAX_DISCOVERY_OUTPUT_ITEMS) {
      throw oversizedDiscoveryResponse();
    }
    for (const item of next.value.items) {
      if (!isKernelOutputItem(item)) {
        throw malformedDiscoveryResponse();
      }
      if (item.mime === "application/vnd.code.notebook.error") {
        throw new NotebookVariableDiscoveryError(
          "Open Wrangler could not inspect dataframe variables in the selected notebook kernel."
        );
      }
      if (!isKernelTextMime(item.mime)) continue;
      bytes += item.data.byteLength;
      if (bytes > MAX_DISCOVERY_OUTPUT_BYTES) {
        throw oversizedDiscoveryResponse();
      }
      chunks.push(Buffer.from(item.data.buffer, item.data.byteOffset, item.data.byteLength).toString("utf8"));
    }
  }
  return chunks.join("");
}

export function parseNotebookVariableDiscoveryOutput(output: string, marker: string): NotebookVariableDiscovery {
  if (!/^[a-f0-9]{32}$/.test(marker) || Buffer.byteLength(output, "utf8") > MAX_DISCOVERY_OUTPUT_BYTES) {
    throw oversizedDiscoveryResponse();
  }

  const start = `__OPEN_WRANGLER_VARIABLES_START_${marker}__`;
  const end = `__OPEN_WRANGLER_VARIABLES_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (
    startIndex < 0 ||
    endIndex <= startIndex ||
    output.indexOf(start, startIndex + start.length) >= 0 ||
    output.indexOf(end, endIndex + end.length) >= 0
  ) {
    throw malformedDiscoveryResponse();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(startIndex + start.length, endIndex).trim());
  } catch {
    throw malformedDiscoveryResponse();
  }
  if (
    !isPlainRecord(parsed) ||
    !hasExactKeys(parsed, ["protocolVersion", "truncated", "variables"]) ||
    parsed.protocolVersion !== DISCOVERY_PROTOCOL_VERSION ||
    typeof parsed.truncated !== "boolean" ||
    !Array.isArray(parsed.variables) ||
    parsed.variables.length > MAX_DISCOVERY_VARIABLES
  ) {
    throw malformedDiscoveryResponse();
  }

  const names = new Set<string>();
  let previousName: string | undefined;
  const variables = parsed.variables.map((value): NotebookVariableDescriptor => {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["backend", "name", "type"]) ||
      typeof value.name !== "string" ||
      value.name.length < 1 ||
      value.name.length > MAX_DISCOVERY_NAME_CHARACTERS ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.name) ||
      typeof value.type !== "string" ||
      !isNotebookVariableType(value.type) ||
      typeof value.backend !== "string" ||
      NOTEBOOK_VARIABLE_TYPES[value.type].backend !== value.backend ||
      (previousName !== undefined && value.name <= previousName) ||
      names.has(value.name)
    ) {
      throw malformedDiscoveryResponse();
    }
    names.add(value.name);
    previousName = value.name;
    return {
      name: value.name,
      type: value.type,
      backend: NOTEBOOK_VARIABLE_TYPES[value.type].backend
    };
  });
  return { variables, truncated: parsed.truncated };
}

export function buildNotebookVariableDiscoveryCode(marker: string): string {
  if (!/^[a-f0-9]{32}$/.test(marker)) {
    throw new Error("Notebook variable discovery marker must be 32 lowercase hexadecimal characters.");
  }
  return `
def __ow_discover_variables_v1():
    import json as __ow_json
    import sys as __ow_sys
    __ow_specs = {
        ("pandas.core.frame", "DataFrame"): ("pandas.core.frame.DataFrame", "pandas"),
        ("pandas.core.series", "Series"): ("pandas.core.series.Series", "pandas"),
        ("polars.dataframe.frame", "DataFrame"): ("polars.dataframe.frame.DataFrame", "polars"),
        ("polars.lazyframe.frame", "LazyFrame"): ("polars.lazyframe.frame.LazyFrame", "polars"),
        ("polars.series.series", "Series"): ("polars.series.series.Series", "polars"),
        ("pyspark.sql.dataframe", "DataFrame"): ("pyspark.sql.dataframe.DataFrame", "pyspark"),
        ("pyspark.sql.classic.dataframe", "DataFrame"): ("pyspark.sql.classic.dataframe.DataFrame", "pyspark"),
        ("pyspark.sql.connect.dataframe", "DataFrame"): ("pyspark.sql.connect.dataframe.DataFrame", "pyspark"),
        ("_duckdb", "DuckDBPyRelation"): ("_duckdb.DuckDBPyRelation", "duckdb"),
        ("duckdb.duckdb", "DuckDBPyRelation"): ("duckdb.duckdb.DuckDBPyRelation", "duckdb"),
    }
    __ow_variables = []
    __ow_truncated = False
    __ow_scanned = 0
    for __ow_name, __ow_value in globals().items():
        __ow_scanned += 1
        if __ow_scanned > ${MAX_DISCOVERY_SCANNED_VARIABLES}:
            __ow_truncated = True
            break
        if (
            not isinstance(__ow_name, str)
            or len(__ow_name) < 1
            or len(__ow_name) > ${MAX_DISCOVERY_NAME_CHARACTERS}
            or not __ow_name.isascii()
            or not __ow_name.isidentifier()
            or __ow_name.startswith("_")
        ):
            continue
        __ow_actual_type = type(__ow_value)
        __ow_module_name = getattr(__ow_actual_type, "__module__", None)
        __ow_type_name = getattr(__ow_actual_type, "__name__", None)
        if not isinstance(__ow_module_name, str) or not isinstance(__ow_type_name, str):
            continue
        __ow_spec = __ow_specs.get((__ow_module_name, __ow_type_name))
        __ow_module = __ow_sys.modules.get(__ow_module_name)
        __ow_module_namespace = getattr(__ow_module, "__dict__", None)
        if (
            __ow_spec is None
            or __ow_module is None
            or not isinstance(__ow_module_namespace, dict)
            or __ow_module_namespace.get(__ow_type_name) is not __ow_actual_type
        ):
            continue
        if len(__ow_variables) >= ${MAX_DISCOVERY_VARIABLES}:
            __ow_truncated = True
            break
        __ow_variables.append({"name": __ow_name, "type": __ow_spec[0], "backend": __ow_spec[1]})
    __ow_variables.sort(key=lambda __ow_item: __ow_item["name"])
    return __ow_json.dumps(
        {
            "protocolVersion": ${DISCOVERY_PROTOCOL_VERSION},
            "truncated": __ow_truncated,
            "variables": __ow_variables,
        },
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )

__ow_discovery_result_v1 = __ow_discover_variables_v1()
print("__OPEN_WRANGLER_VARIABLES_START_${marker}__")
print(__ow_discovery_result_v1)
print("__OPEN_WRANGLER_VARIABLES_END_${marker}__")
del __ow_discovery_result_v1
del __ow_discover_variables_v1
`;
}

function assertNotebookProvenance(notebook: vscode.NotebookDocument): void {
  if (!isSoleOpenNotebookDocument(notebook)) {
    throw new NotebookVariableDiscoveryError("The originating notebook is no longer open. Reopen it and try again.");
  }
}

async function revalidateAfter<T>(value: PromiseLike<T>, notebook: vscode.NotebookDocument): Promise<T> {
  try {
    return await value;
  } finally {
    assertNotebookProvenance(notebook);
  }
}

function isJupyterApi(value: unknown): value is Jupyter {
  if (typeof value !== "object" || value === null) return false;
  const kernels = (value as { kernels?: unknown }).kernels;
  return (
    typeof kernels === "object" &&
    kernels !== null &&
    typeof (kernels as { getKernel?: unknown }).getKernel === "function"
  );
}

function isKernel(value: unknown): value is Kernel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { executeCode?: unknown; language?: unknown };
  return typeof candidate.executeCode === "function" && typeof candidate.language === "string";
}

function isKernelOutput(value: unknown): value is { items: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items);
}

function isKernelOutputItem(value: unknown): value is {
  mime: string;
  data: Uint8Array;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { mime?: unknown; data?: unknown };
  return typeof candidate.mime === "string" && ArrayBuffer.isView(candidate.data);
}

function isKernelTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/x.notebook.stream.stdout" ||
    mime === "application/x.notebook.stream.stderr" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr"
  );
}

function isNotebookVariableType(value: string): value is NotebookVariableType {
  return Object.hasOwn(NOTEBOOK_VARIABLE_TYPES, value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function malformedDiscoveryResponse(): NotebookVariableDiscoveryError {
  return new NotebookVariableDiscoveryError("Open Wrangler received a malformed notebook variable discovery response.");
}

function oversizedDiscoveryResponse(): NotebookVariableDiscoveryError {
  return new NotebookVariableDiscoveryError(
    "Open Wrangler rejected an oversized notebook variable discovery response."
  );
}
