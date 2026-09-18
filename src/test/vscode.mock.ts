import { posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Listener<T> = (event: T) => unknown;

const configurationListeners = new Set<(event: { affectsConfiguration(section: string): boolean }) => unknown>();

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class CancellationTokenSource {
  private readonly state: { cancelled: boolean };
  private readonly listeners = new Set<() => void>();
  readonly token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
  };

  constructor() {
    const state = { cancelled: false };
    this.state = state;
    this.token = {
      get isCancellationRequested(): boolean {
        return state.cancelled;
      },
      onCancellationRequested: (listener: () => void): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      }
    };
  }

  cancel(): void {
    if (this.state.cancelled) return;
    this.state.cancelled = true;
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export const window = {
  createTerminal: (_options: unknown): unknown => {
    throw new Error("This test has not supplied a terminal.");
  },
  onDidCloseTerminal: (_listener: Listener<unknown>): { dispose(): void } => ({ dispose: () => undefined }),
  createOutputChannel: () => ({
    append: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined
  }),
  showWarningMessage: async (): Promise<undefined> => undefined,
  showInformationMessage: async (): Promise<undefined> => undefined,
  showErrorMessage: async (): Promise<undefined> => undefined,
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report(): void }, token: { isCancellationRequested: boolean }) => Promise<T>
  ): Promise<T> => task({ report: () => undefined }, { isCancellationRequested: false })
};

export const TerminalExitReason = { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 };

export const ProgressLocation = {
  Notification: 15
};

export const workspace = {
  isTrusted: true,
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
  getWorkspaceFolder: (_uri: unknown): undefined => undefined,
  onDidChangeConfiguration(listener: (event: { affectsConfiguration(section: string): boolean }) => unknown): {
    dispose(): void;
  } {
    configurationListeners.add(listener);
    return { dispose: () => configurationListeners.delete(listener) };
  },
  __fireDidChangeConfiguration(section: string): void {
    const event = { affectsConfiguration: (candidate: string): boolean => candidate === section };
    for (const listener of configurationListeners) listener(event);
  }
};

export const extensions = {
  getExtension: (_id: string): undefined => undefined
};

export const env = {
  appName: "Visual Studio Code"
};

export const commands = {
  executeCommand: async (): Promise<undefined> => undefined
};

const windowsFilePathPattern = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u;

export const Uri = {
  file(path: string): { scheme: string; authority: string; path: string; fsPath: string; toString(): string } {
    // Abstract POSIX fixtures stay portable; explicit drive and UNC paths use Windows rules.
    return Uri.parse(pathToFileURL(path, { windows: windowsFilePathPattern.test(path) }).href);
  },
  parse(
    value: string,
    strict = false
  ): { scheme: string; authority: string; path: string; fsPath: string; toString(): string } {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/.exec(value);
    if (!match && strict) throw new Error(`Invalid URI: ${value}`);
    const scheme = match?.[1] ?? "";
    const authority = match?.[2] ?? "";
    const encodedPath = match?.[3] ?? value;
    const path = scheme === "file" ? decodeURIComponent(encodedPath) : encodedPath;
    const fsPath =
      scheme === "file" && path
        ? fileURLToPath(value, {
            windows: (authority !== "" && authority.toLowerCase() !== "localhost") || /^\/[A-Za-z]:\//u.test(path)
          })
        : path;
    return {
      scheme,
      authority,
      path,
      fsPath,
      toString: () => value
    };
  },
  joinPath(
    base: { scheme: string; authority: string; path: string; fsPath: string },
    ...parts: string[]
  ): { scheme: string; authority: string; path: string; fsPath: string; toString(): string } {
    if (base.scheme === "file") {
      const paths = windowsFilePathPattern.test(base.fsPath) ? win32 : posix;
      return Uri.file(paths.join(base.fsPath, ...parts));
    }
    const suffix = parts
      .map((part) => part.replace(/^\/+|\/+$/gu, ""))
      .filter(Boolean)
      .join("/");
    const basePath = base.path.replace(/\/+$/gu, "");
    const joinedPath = suffix ? `${basePath}/${suffix}` : basePath;
    return {
      scheme: base.scheme,
      authority: base.authority,
      path: joinedPath,
      fsPath: joinedPath,
      toString: () => `${base.scheme}://${base.authority}${joinedPath}`
    };
  }
};

export const ViewColumn = {
  Active: 1
};
