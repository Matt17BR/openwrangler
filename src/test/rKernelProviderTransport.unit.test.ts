import type { Kernel } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { KernelRequestCancelledError } from "../extension/notebooks/kernelLifecycle";
import {
  buildRKernelProviderBundle,
  collectRKernelOutput,
  createRProviderDispatchContext,
  frameRKernelRequest,
  parseRKernelResponse,
  readRKernelAgentSource,
  RKernelProviderTransport
} from "../extension/r/rKernelProviderTransport";
import {
  R_PROVIDER_LIMITS,
  R_PROVIDER_PROTOCOL_VERSION,
  type RProviderResponseEnvelope
} from "../extension/r/rProviderProtocol";

const initializedEnvelope = (requestId: string): RProviderResponseEnvelope => ({
  protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
  requestId,
  response: {
    kind: "initialized",
    runtimeVersion: "0.1.0",
    language: "r",
    transport: "inProcessR",
    capabilities: {
      sourceKinds: ["notebookVariable"],
      dataFrameClasses: ["data.frame", "tbl_df", "data.table"],
      variableDiscovery: true,
      paging: true,
      filtering: false,
      sorting: false,
      editing: false
    }
  }
});

const discoveredEnvelope = (requestId: string): RProviderResponseEnvelope => ({
  protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
  requestId,
  response: {
    kind: "variablesDiscovered",
    truncated: false,
    variables: [
      { discoveryId: "r:d:1:1", name: "orders", sourceClass: "data.frame", shape: { rows: 12, columns: 4 } },
      { discoveryId: "r:d:1:2", name: "summary", sourceClass: "tbl_df", shape: { rows: 2, columns: 3 } }
    ]
  }
});

describe("native R kernel provider bundle", () => {
  it("embeds one deterministic pure-R provider without exposing source or Python bridges", () => {
    const source = "(function(direct_execution) { function(target = .GlobalEnv) list() })(FALSE)\n";
    const first = buildRKernelProviderBundle(source);
    const second = buildRKernelProviderBundle(source);

    expect(first).toEqual(second);
    expect(first.optionKey).toMatch(/^openwrangler\.r\.provider\.[0-9a-f]{16}$/u);
    expect(first.bootstrapCode).toContain("jsonlite::base64_dec");
    expect(first.bootstrapCode).toContain(".ow_agent_factory(.GlobalEnv)");
    expect(first.bootstrapCode).toContain("length(ls(.ow_agent_env, all.names = TRUE)) != 0L");
    expect(first.bootstrapCode).not.toContain(source);
    expect(first.bootstrapCode).not.toMatch(/python|pandas|reticulate/iu);
    expect(first.disposeCode).toContain(".ow_provider$close()");
    expect(() => buildRKernelProviderBundle("")).toThrow("provider source is empty");
    expect(readRKernelAgentSource(process.cwd())).toContain("create_open_wrangler_r_provider");
  });

  it("frames injection-safe requests and validates the exact correlated response", () => {
    const request = { kind: "initialize" } as const;
    const context = createRProviderDispatchContext("request-1", request);
    const framed = frameRKernelRequest(
      context,
      "openwrangler.r.provider.0123456789abcdef",
      "0123456789abcdef0123456789abcdef"
    );
    const response = initializedEnvelope("request-1");
    const output = [
      "ordinary IRkernel output before the response\n",
      `__OPEN_WRANGLER_R_START_${framed.marker}__\n`,
      JSON.stringify(response),
      `\n__OPEN_WRANGLER_R_END_${framed.marker}__\n`
    ].join("");

    expect(JSON.parse(framed.payload)).toEqual({
      protocolVersion: R_PROVIDER_PROTOCOL_VERSION,
      requestId: "request-1",
      request
    });
    expect(framed.code).not.toContain('"requestId":"request-1"');
    expect(parseRKernelResponse(output, framed)).toEqual(response);
  });

  it("rejects missing, duplicated, stale, and contradictory kernel responses", () => {
    const request = { kind: "initialize" } as const;
    const framed = frameRKernelRequest(
      createRProviderDispatchContext("request-1", request),
      "openwrangler.r.provider.0123456789abcdef",
      "0123456789abcdef0123456789abcdef"
    );
    const marked = (response: unknown): string =>
      `__OPEN_WRANGLER_R_START_${framed.marker}__\n${JSON.stringify(response)}\n__OPEN_WRANGLER_R_END_${framed.marker}__`;

    expect(() => parseRKernelResponse("no marker", framed)).toThrow("exactly one native R kernel response");
    expect(() => parseRKernelResponse(`${marked(initializedEnvelope("request-1"))}${marked({})}`, framed)).toThrow(
      "exactly one native R kernel response"
    );
    expect(() => parseRKernelResponse(marked(initializedEnvelope("stale-request")), framed)).toThrow(
      "invalid, stale, or contradictory"
    );
    expect(() =>
      frameRKernelRequest(createRProviderDispatchContext("request-1", request), "unsafe-option", framed.marker)
    ).toThrow("option key is invalid");
    expect(() =>
      frameRKernelRequest(
        createRProviderDispatchContext("request-1", request),
        "openwrangler.r.provider.0123456789abcdef",
        "bad-marker"
      )
    ).toThrow("response marker is invalid");
  });

  it("requires confirmed session state only for page and close requests", () => {
    const close = { kind: "closeSession", sessionId: "r-session", revision: 0 } as const;
    expect(() => createRProviderDispatchContext("close", close)).toThrow("requires its exact confirmed session");
    expect(() =>
      createRProviderDispatchContext(
        "initialize",
        { kind: "initialize" },
        {
          sessionId: "r-session",
          revision: 0,
          shape: { rows: 0, columns: 0 },
          schema: []
        }
      )
    ).toThrow("cannot carry unrelated session state");
    expect(createRProviderDispatchContext("discover", { kind: "discoverVariables" })).toEqual({
      requestId: "discover",
      request: { kind: "discoverVariables" }
    });
  });
});

describe("native R exact-kernel transport", () => {
  it("discovers bounded native dataframe picker metadata through the owned kernel", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const marker = requestId.replaceAll("-", "");
    const executions: string[] = [];
    const kernel = fakeKernel((code) => {
      executions.push(code);
      if (!code.includes(`__OPEN_WRANGLER_R_START_${marker}__`)) return "";
      return `__OPEN_WRANGLER_R_START_${marker}__\n${JSON.stringify(
        discoveredEnvelope(requestId)
      )}\n__OPEN_WRANGLER_R_END_${marker}__\n`;
    });
    const transport = new RKernelProviderTransport(
      kernel,
      buildRKernelProviderBundle("function(target) list()"),
      () => requestId
    );
    const tokenSource = new vscode.CancellationTokenSource();

    await expect(transport.dispatch({ kind: "discoverVariables" }, tokenSource.token)).resolves.toEqual(
      discoveredEnvelope(requestId)
    );
    expect(executions).toHaveLength(2);
    expect(executions[1]!).toContain("jsonlite::base64_dec");
    expect(executions[1]!).not.toContain("orders");
    tokenSource.dispose();
  });

  it("applies the smaller discovery-output ceiling while collecting exact-kernel output", async () => {
    const requestId = "55555555-5555-4555-8555-555555555555";
    const kernel = fakeKernel((code) =>
      code.includes("__OPEN_WRANGLER_R_START_")
        ? "x".repeat(R_PROVIDER_LIMITS.maxDiscoveryResponseBytes + 1_048_577)
        : ""
    );
    const transport = new RKernelProviderTransport(
      kernel,
      buildRKernelProviderBundle("function(target) list()"),
      () => requestId
    );
    const tokenSource = new vscode.CancellationTokenSource();

    await expect(transport.dispatch({ kind: "discoverVariables" }, tokenSource.token)).rejects.toThrow(
      "output exceeded the bounded transport budget"
    );
    tokenSource.dispose();
  });

  it("bootstraps once, dispatches correlated requests, and disposes the private provider", async () => {
    const executions: string[] = [];
    const requestIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    let nextRequestId = 0;
    const kernel = fakeKernel((code) => {
      executions.push(code);
      const marker = /__OPEN_WRANGLER_R_START_([A-Za-z0-9]+)__/u.exec(code)?.[1];
      if (marker === undefined) return "";
      const requestId = marker === requestIds[0]?.replaceAll("-", "") ? requestIds[0]! : requestIds[1]!;
      return [
        "harmless notebook noise\n",
        `__OPEN_WRANGLER_R_START_${marker}__\n`,
        JSON.stringify(initializedEnvelope(requestId)),
        `\n__OPEN_WRANGLER_R_END_${marker}__\n`
      ].join("");
    });
    const transport = new RKernelProviderTransport(
      kernel,
      buildRKernelProviderBundle("(function(direct_execution) { function(target) list() })(FALSE)"),
      () => requestIds[nextRequestId++]!
    );
    const tokenSource = new vscode.CancellationTokenSource();

    await expect(transport.dispatch({ kind: "initialize" }, tokenSource.token)).resolves.toEqual(
      initializedEnvelope("11111111-1111-4111-8111-111111111111")
    );
    await expect(transport.dispatch({ kind: "initialize" }, tokenSource.token)).resolves.toEqual(
      initializedEnvelope("22222222-2222-4222-8222-222222222222")
    );
    await expect(transport.dispose(tokenSource.token)).resolves.toBeUndefined();

    expect(executions).toHaveLength(4);
    expect(executions.filter((code) => code.includes(".ow_agent_factory <-"))).toHaveLength(1);
    expect(executions.filter((code) => code.includes("__OPEN_WRANGLER_R_START_"))).toHaveLength(2);
    expect(executions.at(-1)).toContain(".ow_provider$close()");
    tokenSource.dispose();
  });

  it("does not touch the kernel when cancellation is already requested", async () => {
    let executions = 0;
    const kernel = fakeKernel(() => {
      executions += 1;
      return "";
    });
    const transport = new RKernelProviderTransport(kernel, buildRKernelProviderBundle("function(target) list()"));
    const tokenSource = new vscode.CancellationTokenSource();
    tokenSource.cancel();

    await expect(transport.dispatch({ kind: "initialize" }, tokenSource.token)).rejects.toBeInstanceOf(
      KernelRequestCancelledError
    );
    expect(executions).toBe(0);
    tokenSource.dispose();
  });

  it("cannot publish a late bootstrap into an invalidated kernel generation", async () => {
    let releaseBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const executions: string[] = [];
    const requestId = "33333333-3333-4333-8333-333333333333";
    const marker = requestId.replaceAll("-", "");
    const kernel = {
      executeCode(code: string) {
        executions.push(code);
        const isBootstrap = code.includes(".ow_agent_factory <-");
        const text = code.includes("__OPEN_WRANGLER_R_START_")
          ? `__OPEN_WRANGLER_R_START_${marker}__\n${JSON.stringify(
              initializedEnvelope(requestId)
            )}\n__OPEN_WRANGLER_R_END_${marker}__\n`
          : "";
        return (async function* () {
          if (isBootstrap && executions.filter((entry) => entry.includes(".ow_agent_factory <-")).length === 1) {
            await bootstrapGate;
          }
          if (text.length > 0) yield text;
        })() as ReturnType<Kernel["executeCode"]>;
      }
    } as Pick<Kernel, "executeCode">;
    const transport = new RKernelProviderTransport(
      kernel,
      buildRKernelProviderBundle("function(target) list()"),
      () => requestId
    );
    const tokenSource = new vscode.CancellationTokenSource();

    const stale = transport.dispatch({ kind: "initialize" }, tokenSource.token);
    await Promise.resolve();
    transport.invalidate();
    releaseBootstrap();

    await expect(stale).rejects.toThrow("kernel generation changed");
    await expect(transport.dispatch({ kind: "initialize" }, tokenSource.token)).resolves.toEqual(
      initializedEnvelope(requestId)
    );
    expect(executions.filter((code) => code.includes(".ow_agent_factory <-"))).toHaveLength(2);
    tokenSource.dispose();
  });

  it("surfaces stable Jupyter error output and caps accumulated output before parsing", async () => {
    const encoder = new TextEncoder();
    async function* erroredOutput() {
      yield {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: encoder.encode(JSON.stringify({ name: "RRuntimeError", message: "jsonlite is unavailable" }))
          }
        ]
      };
    }
    await expect(collectRKernelOutput(erroredOutput() as ReturnType<Kernel["executeCode"]>)).rejects.toThrow(
      "Open Wrangler R kernel execution failed (RRuntimeError): jsonlite is unavailable"
    );

    async function* oversizedOutput() {
      yield "x".repeat(R_PROVIDER_LIMITS.maxResponseBytes + 1_048_577);
    }
    await expect(collectRKernelOutput(oversizedOutput() as ReturnType<Kernel["executeCode"]>)).rejects.toThrow(
      "output exceeded the bounded transport budget"
    );
  });
});

function fakeKernel(produceText: (code: string) => string): Pick<Kernel, "executeCode"> {
  return {
    executeCode(code: string) {
      const text = produceText(code);
      return (async function* () {
        if (text.length > 0) {
          yield {
            items: [
              {
                mime: "application/x.notebook.stream.stdout",
                data: new TextEncoder().encode(text)
              }
            ]
          };
        }
      })() as ReturnType<Kernel["executeCode"]>;
    }
  } as Pick<Kernel, "executeCode">;
}
