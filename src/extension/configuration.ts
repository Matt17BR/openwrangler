import * as vscode from "vscode";
import type { OpenWranglerRequest } from "../shared/protocol";

export const CONFIGURATION_SECTION = "openWrangler";
export const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 60_000;

export interface WebviewBootstrapSettings {
  readonly fetchBlockSize: number;
  readonly fetchColumnBlockSize: number;
  readonly defaultColumnWidth: number;
  readonly insightsOnOpen: boolean;
  readonly filterMode: "basic" | "advanced";
}

type WebviewBootstrapInput = Partial<Record<keyof WebviewBootstrapSettings, unknown>>;

export function getSetting<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION, resource).get<T>(key, fallback);
}

export function updateSetting(key: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void> {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION).update(key, value, target);
}

export function decodeWebviewBootstrapSettings(input: WebviewBootstrapInput): WebviewBootstrapSettings {
  return {
    fetchBlockSize: boundedNumber(input.fetchBlockSize, 200, 25, 2_000, true),
    fetchColumnBlockSize: boundedNumber(input.fetchColumnBlockSize, 16, 1, 256, true),
    defaultColumnWidth: boundedNumber(input.defaultColumnWidth, 190, 80, 640),
    insightsOnOpen: typeof input.insightsOnOpen === "boolean" ? input.insightsOnOpen : true,
    filterMode: input.filterMode === "advanced" ? "advanced" : "basic"
  };
}

export function readWebviewBootstrapSettings(): WebviewBootstrapSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  return decodeWebviewBootstrapSettings({
    fetchBlockSize: configuration.get<unknown>("fetchBlockSize"),
    fetchColumnBlockSize: configuration.get<unknown>("fetchColumnBlockSize"),
    defaultColumnWidth: configuration.get<unknown>("defaultColumnWidth"),
    insightsOnOpen: configuration.get<unknown>("insightsOnOpen"),
    filterMode: configuration.get<unknown>("filterMode")
  });
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number, integer = false): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

export function runtimeRequestTimeoutMs(
  request: Pick<OpenWranglerRequest, "kind">,
  explicitTimeoutMs?: number
): number {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  return request.kind === "openSession"
    ? getSetting<number>("sessionOpenTimeoutMs", DEFAULT_SESSION_OPEN_TIMEOUT_MS)
    : getSetting<number>("requestTimeoutMs", DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS);
}
