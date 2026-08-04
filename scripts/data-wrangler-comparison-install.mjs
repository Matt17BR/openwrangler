import { basename, isAbsolute, resolve } from "node:path";
import {
  PINNED_JUPYTER_EXTENSION_ID,
  PINNED_PYTHON_EXTENSION_ID,
  runBoundedEditorCliCommand
} from "./editor-acceptance.mjs";

const EXTENSION_LIST_MAX_BYTES = 64 * 1024;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const INSTALLED_EXTENSION =
  /^([A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,127})@([0-9A-Za-z][0-9A-Za-z._+-]{0,127})$/u;

export const COMPARISON_COMMON_EXTENSION_LOCK = Object.freeze([
  "ms-python.debugpy@2026.6.0",
  PINNED_PYTHON_EXTENSION_ID,
  "ms-python.vscode-pylance@2026.3.1",
  "ms-python.vscode-python-envs@1.36.0",
  PINNED_JUPYTER_EXTENSION_ID,
  "ms-toolsai.jupyter-keymap@1.1.2",
  "ms-toolsai.jupyter-renderers@1.3.0",
  "ms-toolsai.vscode-jupyter-cell-tags@0.1.9",
  "ms-toolsai.vscode-jupyter-slideshow@0.1.6"
]);
export const DATA_WRANGLER_MARKETPLACE_EXTENSION = "ms-toolsai.datawrangler@1.24.2";

export async function installComparisonExtension(
  { editor, userData, extensions, target, kind, allowedPrivateVsixPaths = [], sandboxArgs, environment, label },
  { runCli = runBoundedEditorCliCommand } = {}
) {
  validateEditorInputs({ editor, userData, extensions, sandboxArgs, environment, label });
  let installTarget;
  if (kind === "marketplace") {
    const allowed = new Set([...COMPARISON_COMMON_EXTENSION_LOCK, DATA_WRANGLER_MARKETPLACE_EXTENSION]);
    if (typeof target !== "string" || target !== target.trim() || !allowed.has(target)) {
      throw new Error("Comparison Marketplace installation accepts only its pinned extension IDs.");
    }
    installTarget = target;
  } else if (kind === "owned-vsix") {
    const allowed = allowedPrivateVsixPaths.map((entry) => resolve(entry));
    if (
      typeof target !== "string" ||
      !isAbsolute(target) ||
      basename(resolve(target)) !== "openwrangler.vsix" ||
      !allowed.includes(resolve(target))
    ) {
      throw new Error("Comparison VSIX installation accepts only the runner-owned Open Wrangler candidate.");
    }
    installTarget = resolve(target);
  } else {
    throw new Error("Comparison extension installation kind must be marketplace or owned-vsix.");
  }

  return runCli(
    {
      editor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        installTarget,
        "--force",
        ...sandboxArgs
      ],
      environment,
      label
    },
    { timeoutMs: 180_000 }
  );
}

export async function verifyComparisonExtensionInventory(
  { editor, userData, extensions, sandboxArgs, environment, product, productVersion, label },
  { runCli = runBoundedEditorCliCommand } = {}
) {
  validateEditorInputs({ editor, userData, extensions, sandboxArgs, environment, label });
  if (!["open-wrangler", "data-wrangler"].includes(product) || !NUMERIC_VERSION.test(productVersion ?? "")) {
    throw new TypeError("Comparison inventory requires one product and an exact numeric version.");
  }
  if (
    product === "data-wrangler" &&
    `ms-toolsai.datawrangler@${productVersion}` !== DATA_WRANGLER_MARKETPLACE_EXTENSION
  ) {
    throw new Error("The comparison inventory requires Data Wrangler 1.24.2.");
  }

  const result = await runCli(
    {
      editor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--list-extensions",
        "--show-versions",
        ...sandboxArgs
      ],
      environment,
      label
    },
    { timeoutMs: 60_000, maxOutputBytes: EXTENSION_LIST_MAX_BYTES }
  );
  const installed = parseInstalledExtensions(result?.stdout);
  const productEntry =
    product === "open-wrangler" ? `matt17br.openwrangler@${productVersion}` : DATA_WRANGLER_MARKETPLACE_EXTENSION;
  const expected = [...COMPARISON_COMMON_EXTENSION_LOCK.map((entry) => entry.toLowerCase()), productEntry].sort();
  if (installed.length !== expected.length || installed.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${product} did not report its exact locked comparison extension inventory.`);
  }
  return Object.freeze(installed);
}

function parseInstalledExtensions(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > EXTENSION_LIST_MAX_BYTES) {
    throw new Error("The installed-extension inventory is absent or oversized.");
  }
  const installed = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = INSTALLED_EXTENSION.exec(line);
      if (!match) throw new Error("The VS Code CLI returned a malformed installed-extension inventory.");
      return `${match[1].toLowerCase()}@${match[2]}`;
    })
    .sort();
  if (installed.length === 0 || installed.length > 64 || new Set(installed).size !== installed.length) {
    throw new Error("The installed-extension inventory must contain between 1 and 64 unique entries.");
  }
  return installed;
}

function validateEditorInputs({ editor, userData, extensions, sandboxArgs, environment, label }) {
  if (
    !editor ||
    typeof editor !== "object" ||
    typeof userData !== "string" ||
    typeof extensions !== "string" ||
    !Array.isArray(sandboxArgs) ||
    !environment ||
    typeof environment !== "object" ||
    typeof label !== "string" ||
    label.length === 0 ||
    /[\0\r\n]/u.test(label)
  ) {
    throw new TypeError("Comparison extension command received malformed editor inputs.");
  }
}
