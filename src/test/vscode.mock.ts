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

export const ProgressLocation = {
  Notification: 15
};

export const workspace = {
  isTrusted: true,
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
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

export const Uri = {
  file(path: string): { scheme: string; authority: string; path: string; fsPath: string; toString(): string } {
    return {
      scheme: "file",
      authority: "",
      path,
      fsPath: path,
      toString: () => `file://${path}`
    };
  },
  parse(
    value: string,
    strict = false
  ): { scheme: string; authority: string; path: string; fsPath: string; toString(): string } {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/.exec(value);
    if (!match && strict) throw new Error(`Invalid URI: ${value}`);
    const scheme = match?.[1] ?? "";
    const authority = match?.[2] ?? "";
    const path = match?.[3] ?? value;
    return {
      scheme,
      authority,
      path,
      fsPath: path,
      toString: () => value
    };
  }
};

export const ViewColumn = {
  Active: 1
};
