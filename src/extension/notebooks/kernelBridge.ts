import { randomUUID } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import type { DataExplorerRequest, DataExplorerResponse } from "../../shared/protocol";
import type { DataExplorerBridge } from "../dataBridge";

interface JupyterExtensionApi {
  getKernelService?: () => Promise<JupyterKernelService | undefined>;
}

interface JupyterKernelService {
  getKernel(uri: vscode.Uri): JupyterKernel | undefined;
}

interface JupyterKernel {
  start?: () => Promise<unknown>;
  executeCode?: (code: string, token?: vscode.CancellationToken) => Promise<unknown>;
  executeHidden?: (code: string) => Promise<unknown>;
  connection?: {
    connection?: JupyterKernelConnection;
  };
}

interface JupyterKernelConnection {
  requestExecute?: (
    content: {
      code: string;
      silent?: boolean;
      store_history?: boolean;
      allow_stdin?: boolean;
    },
    disposeOnDone?: boolean
  ) => JupyterFuture;
}

interface JupyterFuture {
  onIOPub?: (message: JupyterMessage) => void;
  done: Promise<JupyterMessage>;
}

interface JupyterMessage {
  header?: {
    msg_type?: string;
  };
  content?: {
    name?: string;
    text?: string | string[];
    data?: Record<string, unknown>;
    traceback?: string[];
    ename?: string;
    evalue?: string;
    status?: string;
  };
}

interface KernelAgentEnvelope {
  response?: DataExplorerResponse;
  error?: string;
  detail?: string;
}

export class KernelBridge implements DataExplorerBridge {
  private bootstrapped = false;
  private kernel: JupyterKernel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notebookUri: vscode.Uri
  ) {}

  async request(request: DataExplorerRequest): Promise<DataExplorerResponse> {
    await this.ensureKernelAgent();
    const marker = randomUUID().replace(/-/g, "");
    const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    const output = await this.executePython(`
import base64 as __de_base64
import data_wrangler_runtime.kernel_agent as __de_kernel_agent
__de_payload = __de_base64.b64decode("${payload}").decode("utf-8")
print("__DATA_EXPLORER_START_${marker}__")
print(__de_kernel_agent.dispatch_json(__de_payload))
print("__DATA_EXPLORER_END_${marker}__")
`);
    const envelope = parseMarkedJson(output, marker);
    if (envelope.error) {
      throw new Error(envelope.detail ? `${envelope.error}\n${envelope.detail}` : envelope.error);
    }
    if (!envelope.response) {
      throw new Error("Data Explorer kernel agent returned no response.");
    }
    return envelope.response;
  }

  private async ensureKernelAgent(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }
    const pythonRoot = path.join(this.context.extensionPath, "python");
    await this.executePython(`
import sys as __de_sys
__de_python_root = ${JSON.stringify(pythonRoot)}
if __de_python_root not in __de_sys.path:
    __de_sys.path.insert(0, __de_python_root)
import data_wrangler_runtime.kernel_agent as __de_kernel_agent
`);
    this.bootstrapped = true;
  }

  private async executePython(code: string): Promise<string> {
    const kernel = await this.getKernel();
    if (kernel.executeCode) {
      const output = await kernel.executeCode(code);
      return outputsToText(output);
    }
    if (kernel.executeHidden) {
      const output = await kernel.executeHidden(code);
      return outputsToText(output);
    }

    const connection = kernel.connection?.connection;
    if (!connection?.requestExecute) {
      throw new Error("The active Jupyter kernel does not expose an executable connection.");
    }

    return executeWithKernelConnection(connection, code);
  }

  private async getKernel(): Promise<JupyterKernel> {
    if (this.kernel) {
      return this.kernel;
    }

    const jupyter = vscode.extensions.getExtension<JupyterExtensionApi>("ms-toolsai.jupyter");
    if (!jupyter) {
      throw new Error("Install the VS Code Jupyter extension to open live notebook dataframes.");
    }

    const api = await jupyter.activate();
    const kernelService = await api.getKernelService?.();
    const kernel = kernelService?.getKernel(this.notebookUri);
    if (!kernel) {
      throw new Error("Data Explorer could not find the active Jupyter kernel for this notebook.");
    }

    await kernel.start?.();
    this.kernel = kernel;
    return kernel;
  }
}

async function executeWithKernelConnection(connection: JupyterKernelConnection, code: string): Promise<string> {
  const chunks: string[] = [];
  const errors: string[] = [];
  const future = connection.requestExecute?.(
    {
      code,
      silent: false,
      store_history: false,
      allow_stdin: false
    },
    true
  );
  if (!future) {
    throw new Error("The active Jupyter kernel did not accept the execution request.");
  }

  future.onIOPub = (message) => {
    const text = messageText(message);
    if (text) {
      chunks.push(text);
    }
    if (message.header?.msg_type === "error") {
      errors.push(message.content?.traceback?.join("\n") ?? message.content?.evalue ?? "Unknown kernel error.");
    }
  };

  const reply = await future.done;
  if (reply.content?.status === "error" || errors.length > 0) {
    throw new Error(errors.join("\n") || reply.content?.evalue || "Kernel execution failed.");
  }

  return chunks.join("");
}

function messageText(message: JupyterMessage): string {
  if (message.header?.msg_type === "stream") {
    return normalizeText(message.content?.text);
  }
  const textPlain = message.content?.data?.["text/plain"];
  return normalizeText(textPlain);
}

function outputsToText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (!Array.isArray(output)) {
    return "";
  }

  return output.map((item) => outputItemToText(item)).join("");
}

function outputItemToText(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (typeof item !== "object" || item === null) {
    return "";
  }
  const output = item as {
    text?: unknown;
    data?: Record<string, unknown>;
    items?: Array<{ mime?: string; data?: unknown }>;
  };
  if (output.text) {
    return normalizeText(output.text);
  }
  if (output.data?.["text/plain"]) {
    return normalizeText(output.data["text/plain"]);
  }
  const textItem = output.items?.find((candidate) => candidate.mime === "text/plain");
  return normalizeText(textItem?.data);
}

function normalizeText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join("");
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function parseMarkedJson(output: string, marker: string): KernelAgentEnvelope {
  const start = `__DATA_EXPLORER_START_${marker}__`;
  const end = `__DATA_EXPLORER_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Data Explorer could not parse the kernel response. Output: ${output.trim()}`);
  }
  const json = output.slice(startIndex + start.length, endIndex).trim();
  return JSON.parse(json) as KernelAgentEnvelope;
}
