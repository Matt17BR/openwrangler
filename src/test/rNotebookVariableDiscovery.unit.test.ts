import { spawnSync } from "node:child_process";
import type { Jupyter, Kernel } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRNotebookVariableDiscoveryCode,
  discoverRNotebookVariables,
  parseRNotebookVariableDiscoveryOutput,
  verifyRNotebookVariableSelection
} from "../extension/r/rNotebookVariableDiscovery";

const MARKER = "0123456789abcdef0123456789abcdef";
const R_DISCOVERY_CONTRACT_AVAILABLE =
  spawnSync(
    "Rscript",
    [
      "--vanilla",
      "-e",
      'quit(status = if (requireNamespace("rlang", quietly = TRUE) && requireNamespace("jsonlite", quietly = TRUE)) 0L else 1L)'
    ],
    { encoding: "utf8" }
  ).status === 0;

afterEach(() => {
  vi.restoreAllMocks();
  setWorkspaceState(true);
});

describe("R notebook variable discovery", () => {
  it("decodes every supported R frame flavor and returns descriptors sorted by name", () => {
    expect(
      parseRNotebookVariableDiscoveryOutput(
        framed(MARKER, {
          protocolVersion: 1,
          truncated: false,
          variables: [
            { name: "z_tibble", dataframeFlavor: "r.tibble" },
            { name: "base frame", dataframeFlavor: "r.data.frame" },
            { name: "accounts", dataframeFlavor: "r.data.table" }
          ]
        }),
        MARKER
      )
    ).toEqual({
      truncated: false,
      variables: [
        { name: "accounts", backend: "r", dataframeFlavor: "r.data.table" },
        { name: "base frame", backend: "r", dataframeFlavor: "r.data.frame" },
        { name: "z_tibble", backend: "r", dataframeFlavor: "r.tibble" }
      ]
    });
  });

  it("rejects extra fields, repeated names, invalid flavors, invalid names, and oversized output", () => {
    const invalidPayloads: unknown[] = [
      { protocolVersion: 1, truncated: false, variables: [], extra: true },
      {
        protocolVersion: 1,
        truncated: false,
        variables: [
          { name: "frame", dataframeFlavor: "r.data.frame" },
          { name: "frame", dataframeFlavor: "r.tibble" }
        ]
      },
      {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "frame", dataframeFlavor: "r.grouped_df" }]
      },
      {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "frame\nname", dataframeFlavor: "r.data.frame" }]
      },
      {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "frame", dataframeFlavor: "r.data.frame", classes: ["data.frame"] }]
      }
    ];

    for (const payload of invalidPayloads) {
      expect(() => parseRNotebookVariableDiscoveryOutput(framed(MARKER, payload), MARKER)).toThrow("malformed");
    }
    expect(() => parseRNotebookVariableDiscoveryOutput("x".repeat(64 * 1_024 + 1), MARKER)).toThrow("oversized");
  });

  it("sorts bindings before truncation and skips active or lazy bindings before reading values", () => {
    const code = buildRNotebookVariableDiscoveryCode(MARKER);
    const bindingSort = code.indexOf(".ow_names <- sort(");
    const bindingTruncation = code.indexOf(".ow_names <- .ow_names[seq_len(.ow_max_scanned_bindings)]");
    const activeBindingGuard = code.indexOf("bindingIsActive(.ow_name, .ow_source)");
    const lazyBindingGuard = code.indexOf("rlang::env_binding_are_lazy(.ow_source, .ow_name)");
    const bindingRead = code.indexOf("get(.ow_name, envir = .ow_source, inherits = FALSE)");

    expect(bindingSort).toBeGreaterThanOrEqual(0);
    expect(bindingTruncation).toBeGreaterThan(bindingSort);
    expect(activeBindingGuard).toBeGreaterThanOrEqual(0);
    expect(lazyBindingGuard).toBeGreaterThan(activeBindingGuard);
    expect(bindingRead).toBeGreaterThan(lazyBindingGuard);
    expect(code).toContain('requireNamespace("jsonlite", quietly = TRUE)');
    expect(code).toContain('requireNamespace("rlang", quietly = TRUE)');
    expect(code).toContain('identical(.ow_classes, c("data.table", "data.frame"))');
    expect(code).toContain('identical(.ow_classes, c("tbl_df", "tbl", "data.frame"))');
    expect(code).toContain('identical(.ow_classes, "data.frame")');
    expect(code).toContain(".GlobalEnv");
    expect(code.toLowerCase()).not.toContain("python");
  });

  it.runIf(R_DISCOVERY_CONTRACT_AVAILABLE)("does not evaluate active or delayed bindings in a real R process", () => {
    const script = `
.ow_forced <- FALSE
ordinary_frame <- data.frame(value = 1L)
delayedAssign(
  "lazy_frame",
  { .ow_forced <<- TRUE; data.frame(value = 2L) },
  assign.env = .GlobalEnv
)
makeActiveBinding(
  "active_frame",
  function(value) {
    .ow_forced <<- TRUE
    data.frame(value = 3L)
  },
  .GlobalEnv
)
${buildRNotebookVariableDiscoveryCode(MARKER)}
cat("__OPEN_WRANGLER_FORCED__", .ow_forced, "\\n", sep = "")
`;
    const result = spawnSync("Rscript", ["--vanilla", "-"], {
      encoding: "utf8",
      input: script,
      maxBuffer: 128 * 1_024
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("__OPEN_WRANGLER_FORCED__FALSE");
    expect(parseRNotebookVariableDiscoveryOutput(result.stdout, MARKER)).toEqual({
      truncated: false,
      variables: [{ name: "ordinary_frame", backend: "r", dataframeFlavor: "r.data.frame" }]
    });
  });

  it("reports missing R discovery packages with an actionable message", () => {
    expect(() =>
      parseRNotebookVariableDiscoveryOutput(framed(MARKER, { protocolVersion: 1, error: "missing_jsonlite" }), MARKER)
    ).toThrow('install.packages("jsonlite")');
    expect(() =>
      parseRNotebookVariableDiscoveryOutput(framed(MARKER, { protocolVersion: 1, error: "missing_rlang" }), MARKER)
    ).toThrow('install.packages("rlang")');
  });

  it("uses the public Jupyter API, the exact selected R kernel, and a never-cancelled token", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    let executionToken: vscode.CancellationToken | undefined;
    const executeCode = vi.fn((code: string, token: vscode.CancellationToken) => {
      executionToken = token;
      const marker = discoveryMarker(code);
      return kernelOutput(
        framed(marker, {
          protocolVersion: 1,
          truncated: false,
          variables: [{ name: "orders", dataframeFlavor: "r.data.table" }]
        })
      );
    });
    const selectedKernel = { language: "R", executeCode } as unknown as Kernel;
    const getKernel = vi.fn(async (_uri: vscode.Uri) => selectedKernel);
    const activate = installJupyterMock(getKernel);
    const cancel = vi.spyOn(vscode.CancellationTokenSource.prototype, "cancel");

    await expect(discoverRNotebookVariables(document)).resolves.toEqual({
      truncated: false,
      variables: [{ name: "orders", backend: "r", dataframeFlavor: "r.data.table" }]
    });

    expect(activate).toHaveBeenCalledOnce();
    expect(getKernel).toHaveBeenCalledTimes(3);
    expect(getKernel.mock.calls.every(([uri]) => uri === document.uri)).toBe(true);
    expect(executeCode).toHaveBeenCalledOnce();
    expect(executeCode.mock.calls[0]?.[0]).toContain(".GlobalEnv");
    expect(executionToken?.isCancellationRequested).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects a kernel switch after discovery instead of retargeting the result", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    const firstKernel = {
      language: "r",
      executeCode: (code: string) =>
        kernelOutput(
          framed(discoveryMarker(code), {
            protocolVersion: 1,
            truncated: false,
            variables: [{ name: "frame", dataframeFlavor: "r.data.frame" }]
          })
        )
    } as unknown as Kernel;
    const replacementKernel = { language: "r", executeCode: vi.fn() } as unknown as Kernel;
    const getKernel = vi
      .fn()
      .mockResolvedValueOnce(firstKernel)
      .mockResolvedValueOnce(firstKernel)
      .mockResolvedValueOnce(replacementKernel);
    installJupyterMock(getKernel);

    await expect(discoverRNotebookVariables(document)).rejects.toThrow("kernel changed");
    expect(getKernel).toHaveBeenCalledTimes(3);
  });

  it("rechecks the exact kernel and selected variable after the picker resolves", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    const executeCode = vi.fn((code: string) => {
      const marker = discoveryMarker(code);
      return kernelOutput(
        framed(marker, {
          protocolVersion: 1,
          truncated: false,
          variables: [{ name: "orders", dataframeFlavor: "r.data.table" }]
        })
      );
    });
    const selectedKernel = { language: "R", executeCode } as unknown as Kernel;
    const getKernel = vi.fn(async () => selectedKernel);
    installJupyterMock(getKernel);

    const discovery = await discoverRNotebookVariables(document);
    const selected = discovery.variables[0];
    if (!selected) throw new Error("Expected a discovered variable.");

    await expect(verifyRNotebookVariableSelection(document, discovery, selected)).resolves.toBeUndefined();

    expect(executeCode).toHaveBeenCalledTimes(2);
    expect(executeCode.mock.calls[1]?.[0]).toContain('.ow_name <- "orders"');
    expect(executeCode.mock.calls[1]?.[0]).toContain("rlang::env_binding_are_lazy");
    expect(getKernel).toHaveBeenCalledTimes(5);
  });

  it("rejects a kernel switch while the picker is open without probing the replacement", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    const executeCode = vi.fn((code: string) =>
      kernelOutput(
        framed(discoveryMarker(code), {
          protocolVersion: 1,
          truncated: false,
          variables: [{ name: "frame", dataframeFlavor: "r.data.frame" }]
        })
      )
    );
    const firstKernel = { language: "r", executeCode } as unknown as Kernel;
    const replacementKernel = { language: "r", executeCode: vi.fn() } as unknown as Kernel;
    const getKernel = vi
      .fn()
      .mockResolvedValueOnce(firstKernel)
      .mockResolvedValueOnce(firstKernel)
      .mockResolvedValueOnce(firstKernel)
      .mockResolvedValueOnce(replacementKernel);
    installJupyterMock(getKernel);

    const discovery = await discoverRNotebookVariables(document);
    const selected = discovery.variables[0];
    if (!selected) throw new Error("Expected a discovered variable.");

    await expect(verifyRNotebookVariableSelection(document, discovery, selected)).rejects.toThrow("kernel changed");
    expect(executeCode).toHaveBeenCalledOnce();
    expect(replacementKernel.executeCode).not.toHaveBeenCalled();
  });

  it("rejects a variable whose dataframe flavor changed while the picker was open", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    let execution = 0;
    const executeCode = vi.fn((code: string) => {
      execution += 1;
      return kernelOutput(
        framed(discoveryMarker(code), {
          protocolVersion: 1,
          truncated: false,
          variables: [
            {
              name: "frame",
              dataframeFlavor: execution === 1 ? "r.data.frame" : "r.tibble"
            }
          ]
        })
      );
    });
    const selectedKernel = { language: "r", executeCode } as unknown as Kernel;
    installJupyterMock(vi.fn(async () => selectedKernel));

    const discovery = await discoverRNotebookVariables(document);
    const selected = discovery.variables[0];
    if (!selected) throw new Error("Expected a discovered variable.");

    await expect(verifyRNotebookVariableSelection(document, discovery, selected)).rejects.toThrow(
      "changed while the picker was open"
    );
  });

  it("rejects parsed or unrelated discovery selections that have no live receipt", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    const parsed = parseRNotebookVariableDiscoveryOutput(
      framed(MARKER, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "frame", dataframeFlavor: "r.data.frame" }]
      }),
      MARKER
    );
    const selected = parsed.variables[0];
    if (!selected) throw new Error("Expected a parsed variable.");

    await expect(verifyRNotebookVariableSelection(document, parsed, selected)).rejects.toThrow(
      "no longer belongs to this variable list"
    );
  });

  it("extracts a bounded actionable jsonlite error from the R kernel", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    const selectedKernel = {
      language: "r",
      executeCode: () =>
        kernelErrorOutput({
          name: "simpleError",
          message: "there is no package called ‘jsonlite’",
          stack: ""
        })
    } as unknown as Kernel;
    installJupyterMock(vi.fn(async () => selectedKernel));

    await expect(discoverRNotebookVariables(document)).rejects.toThrow('install.packages("jsonlite")');
  });

  it("rejects a replacement NotebookDocument after an awaited kernel output", async () => {
    const document = notebookDocument();
    const replacement = notebookDocument();
    setWorkspaceState(true, document);
    const selectedKernel = {
      language: "r",
      executeCode: (code: string) => replacingKernelOutput(code, replacement)
    } as unknown as Kernel;
    const getKernel = vi.fn(async () => selectedKernel);
    installJupyterMock(getKernel);

    await expect(discoverRNotebookVariables(document)).rejects.toThrow("originating notebook is no longer open");
    expect(getKernel).toHaveBeenCalledTimes(2);
  });

  it("rejects non-R kernels before executing discovery code", async () => {
    const document = notebookDocument();
    setWorkspaceState(true, document);
    const executeCode = vi.fn();
    const getKernel = vi.fn(async () => ({ language: "python", executeCode }) as unknown as Kernel);
    installJupyterMock(getKernel);

    await expect(discoverRNotebookVariables(document)).rejects.toThrow("requires an R notebook kernel");
    expect(executeCode).not.toHaveBeenCalled();
  });

  it("requires workspace trust before activating Jupyter", async () => {
    const document = notebookDocument();
    setWorkspaceState(false, document);
    const getExtension = vi.spyOn(vscode.extensions, "getExtension");

    await expect(discoverRNotebookVariables(document)).rejects.toThrow("Trust this workspace");
    expect(getExtension).not.toHaveBeenCalled();
  });
});

function framed(marker: string, payload: unknown): string {
  return [
    "unrelated notebook output",
    `__OPEN_WRANGLER_R_VARIABLES_START_${marker}__`,
    JSON.stringify(payload),
    `__OPEN_WRANGLER_R_VARIABLES_END_${marker}__`
  ].join("\n");
}

async function* kernelOutput(text: string): AsyncIterable<{ items: Array<{ mime: string; data: Uint8Array }> }> {
  yield { items: [{ mime: "application/x.notebook.stream.stdout", data: Buffer.from(text, "utf8") }] };
}

async function* kernelErrorOutput(error: unknown): AsyncIterable<{ items: Array<{ mime: string; data: Uint8Array }> }> {
  yield {
    items: [
      {
        mime: "application/vnd.code.notebook.error",
        data: Buffer.from(JSON.stringify(error), "utf8")
      }
    ]
  };
}

async function* replacingKernelOutput(
  code: string,
  replacement: vscode.NotebookDocument
): AsyncIterable<{ items: Array<{ mime: string; data: Uint8Array }> }> {
  setWorkspaceState(true, replacement);
  yield {
    items: [
      {
        mime: "application/x.notebook.stream.stdout",
        data: Buffer.from(
          framed(discoveryMarker(code), {
            protocolVersion: 1,
            truncated: false,
            variables: [{ name: "frame", dataframeFlavor: "r.data.frame" }]
          }),
          "utf8"
        )
      }
    ]
  };
}

function installJupyterMock(getKernel: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  const activate = vi.fn(async () => ({ kernels: { getKernel } }) as unknown as Jupyter);
  vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({ activate } as never);
  return activate;
}

function discoveryMarker(code: string): string {
  const marker = code.match(/__OPEN_WRANGLER_R_VARIABLES_START_([a-f0-9]{32})__/)?.[1];
  if (!marker) throw new Error("The test could not find the R discovery marker.");
  return marker;
}

function notebookDocument(): vscode.NotebookDocument {
  return {
    uri: vscode.Uri.file("/workspace/r-notebook.ipynb"),
    isClosed: false
  } as vscode.NotebookDocument;
}

function setWorkspaceState(trusted: boolean, ...documents: vscode.NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value: trusted });
  Object.defineProperty(vscode.workspace, "notebookDocuments", { configurable: true, value: documents });
}
