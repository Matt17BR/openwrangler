export const R_EXTENSION_ID = "reditorsupport.r";
export const QUARTO_EXTENSION_ID = "quarto.quarto";
export const JUPYTER_EXTENSION_ID = "ms-toolsai.jupyter";

export type RDocumentSurface = "rSource" | "rMarkdown" | "quarto" | "jupyterR";
export type NativeRTransport = "jupyterKernel" | "sessionHelper";

export interface RDocumentContext {
  readonly kind: "text" | "notebook";
  readonly fileName?: string;
  readonly languageId?: string;
  readonly notebookType?: string;
  readonly kernelLanguage?: string;
}

declare const nativeRSessionHelperReceiptBrand: unique symbol;

/**
 * An opaque receipt proving that one helper instance was attached to one
 * exact editor document through one exact R process.
 *
 * Callers cannot construct a valid receipt structurally. The module-private
 * registry below is the authority consulted by {@link planNativeRLaunch}.
 */
export interface NativeRSessionHelperReceipt {
  readonly [nativeRSessionHelperReceiptBrand]: true;
}

export interface NativeRSessionHelperBinding {
  readonly receipt: NativeRSessionHelperReceipt;
  readonly processIdentity: object;
  readonly helperIdentity: object;
}

export interface NativeRLaunchContext {
  readonly document: RDocumentContext;
  /** The exact VS Code TextDocument/NotebookDocument (or owned stand-in). */
  readonly documentIdentity: object;
  readonly installedExtensionIds: readonly string[];
  readonly sessionHelper?: NativeRSessionHelperBinding;
}

export interface NativeRLaunchPlan {
  readonly surface?: RDocumentSurface;
  readonly transport?: NativeRTransport;
  readonly available: boolean;
  readonly missingExtensionIds: readonly string[];
  readonly reason: string;
}

export interface QuartoExtensionApiSnapshot {
  readonly available: boolean;
  readonly path?: string;
  readonly version?: string;
}

interface NativeRSessionHelperOrigin {
  readonly documentIdentity: object;
  readonly processIdentity: object;
  readonly helperIdentity: object;
}

const nativeRSessionHelperOrigins = new WeakMap<object, NativeRSessionHelperOrigin>();

export function issueNativeRSessionHelperReceipt(
  documentIdentity: object,
  processIdentity: object,
  helperIdentity: object
): NativeRSessionHelperReceipt {
  const receipt = Object.freeze(Object.create(null)) as NativeRSessionHelperReceipt;
  nativeRSessionHelperOrigins.set(receipt, Object.freeze({ documentIdentity, processIdentity, helperIdentity }));
  return receipt;
}

/**
 * Revokes a helper connection when its document, process, or helper is
 * disposed. Revocation is idempotent and makes stale receipts fail closed.
 */
export function revokeNativeRSessionHelperReceipt(receipt: NativeRSessionHelperReceipt): void {
  nativeRSessionHelperOrigins.delete(receipt);
}

export function classifyRDocument(context: RDocumentContext): RDocumentSurface | undefined {
  const fileExtension = extensionOf(context.fileName);
  const languageId = context.languageId?.toLowerCase();

  if (context.kind === "notebook") {
    return context.notebookType === "jupyter-notebook" && context.kernelLanguage?.toLowerCase() === "r"
      ? "jupyterR"
      : undefined;
  }

  if (fileExtension === "rmd" || languageId === "rmd") return "rMarkdown";
  if (fileExtension === "qmd" || languageId === "quarto") return "quarto";
  if (fileExtension === "r" || languageId === "r") return "rSource";
  return undefined;
}

/**
 * Selects only transports Open Wrangler can own and validate.
 *
 * Installing the R or Quarto extension improves authoring, but neither
 * extension currently exports a public live-session dataframe API. Their
 * presence therefore never grants Open Wrangler access to an R environment.
 */
export function planNativeRLaunch(context: NativeRLaunchContext): NativeRLaunchPlan {
  const surface = classifyRDocument(context.document);
  if (surface === undefined) {
    return Object.freeze({
      available: false,
      missingExtensionIds: Object.freeze([]),
      reason: "The active document is not a recognized R, R Markdown, Quarto, or R-kernel notebook surface."
    });
  }

  const installed = new Set(context.installedExtensionIds.map((extensionId) => extensionId.toLowerCase()));
  if (surface === "jupyterR") {
    if (installed.has(JUPYTER_EXTENSION_ID)) {
      return Object.freeze({
        surface,
        transport: "jupyterKernel",
        available: true,
        missingExtensionIds: Object.freeze([]),
        reason: "Use the selected R Jupyter kernel through the stable Jupyter extension API."
      });
    }
    return Object.freeze({
      surface,
      available: false,
      missingExtensionIds: Object.freeze([JUPYTER_EXTENSION_ID]),
      reason: "An R-kernel notebook requires the Jupyter extension before Open Wrangler can access its kernel."
    });
  }

  if (isExactNativeRSessionHelper(context.documentIdentity, context.sessionHelper)) {
    return Object.freeze({
      surface,
      transport: "sessionHelper",
      available: true,
      missingExtensionIds: Object.freeze([]),
      reason: "Use the explicit Open Wrangler helper connected to this exact R session."
    });
  }

  const authoringExtension = surface === "quarto" || surface === "rMarkdown" ? QUARTO_EXTENSION_ID : R_EXTENSION_ID;
  const authoringStatus = installed.has(authoringExtension)
    ? ` ${authoringExtension} is installed, but its public API does not expose the live R environment.`
    : "";
  const helperStatus =
    context.sessionHelper === undefined
      ? ""
      : " The supplied helper receipt is stale or belongs to a different document, R process, or helper instance.";
  return Object.freeze({
    surface,
    available: false,
    missingExtensionIds: Object.freeze([]),
    reason: `Connect the explicit Open Wrangler R-session helper before opening a live variable.${authoringStatus}${helperStatus}`
  });
}

/**
 * Reads only Quarto's documented public metadata API. This API locates the
 * Quarto CLI; it does not provide access to variables or execution sessions.
 */
export function readQuartoExtensionApi(value: unknown): QuartoExtensionApiSnapshot | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    const getQuartoPath = candidate.getQuartoPath;
    const getQuartoVersion = candidate.getQuartoVersion;
    const isQuartoAvailable = candidate.isQuartoAvailable;
    if (
      typeof getQuartoPath !== "function" ||
      typeof getQuartoVersion !== "function" ||
      typeof isQuartoAvailable !== "function"
    ) {
      return undefined;
    }

    const available = Reflect.apply(isQuartoAvailable, value, []);
    const path = Reflect.apply(getQuartoPath, value, []);
    const version = Reflect.apply(getQuartoVersion, value, []);
    if (
      typeof available !== "boolean" ||
      (path !== undefined && (typeof path !== "string" || path.length === 0)) ||
      (version !== undefined && (typeof version !== "string" || version.length === 0))
    ) {
      return undefined;
    }
    if (!available && (path !== undefined || version !== undefined)) return undefined;
    return Object.freeze({
      available,
      ...(path === undefined ? {} : { path }),
      ...(version === undefined ? {} : { version })
    });
  } catch {
    return undefined;
  }
}

function extensionOf(fileName: string | undefined): string | undefined {
  if (fileName === undefined) return undefined;
  const finalSeparator = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const finalDot = fileName.lastIndexOf(".");
  return finalDot > finalSeparator ? fileName.slice(finalDot + 1).toLowerCase() : undefined;
}

function isExactNativeRSessionHelper(
  documentIdentity: object,
  binding: NativeRSessionHelperBinding | undefined
): boolean {
  if (binding === undefined || typeof binding.receipt !== "object" || binding.receipt === null) return false;
  const origin = nativeRSessionHelperOrigins.get(binding.receipt);
  return (
    origin !== undefined &&
    origin.documentIdentity === documentIdentity &&
    origin.processIdentity === binding.processIdentity &&
    origin.helperIdentity === binding.helperIdentity
  );
}
