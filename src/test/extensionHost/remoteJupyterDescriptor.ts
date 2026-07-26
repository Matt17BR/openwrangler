const RELEASED_REMOTE_JUPYTER_TOKEN = /^owr_[A-Za-z0-9_-]{39}$/u;

export function readReleasedRemoteJupyterDescriptorToken(value: unknown): string {
  if (typeof value !== "string" || !RELEASED_REMOTE_JUPYTER_TOKEN.test(value)) {
    throw new Error("The remote Jupyter descriptor token is malformed.");
  }
  return value;
}
