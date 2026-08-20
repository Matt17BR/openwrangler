export const WEBVIEW_FAILURE_PHASES = ["react", "message"] as const;

export type WebviewFailurePhase = (typeof WEBVIEW_FAILURE_PHASES)[number];

export function isWebviewFailurePhase(value: unknown): value is WebviewFailurePhase {
  return WEBVIEW_FAILURE_PHASES.some((phase) => phase === value);
}
