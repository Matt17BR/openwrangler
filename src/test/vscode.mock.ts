type Listener<T> = (event: T) => unknown;

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
  showWarningMessage: async (): Promise<undefined> => undefined
};

export const workspace = {
  isTrusted: true,
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback })
};

export const extensions = {
  getExtension: (_id: string): undefined => undefined
};

export const Uri = {
  file(path: string): { fsPath: string; toString(): string } {
    return {
      fsPath: path,
      toString: () => `file://${path}`
    };
  }
};

export const ViewColumn = {
  Active: 1
};
