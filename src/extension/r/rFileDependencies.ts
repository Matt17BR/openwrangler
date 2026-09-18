import { access, chmod, constants, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RLibrary } from "../../shared/protocol";
import type { BridgeRequestOptions } from "../dataBridge";
import { rStringExpression } from "./rCode";
import {
  buildRDependencyCheckFunctionCode,
  buildRDependencySerializationCode,
  decodeRDependencyRequirements,
  R_CORE_DEPENDENCY_REQUIREMENTS,
  R_DEPENDENCY_FAILURE_CLASS,
  type RDependencyRequirement
} from "./rDependencyRequirements";
import { startRDependencyProcess } from "./rDependencyProcess";
import type { RProcessFileSource } from "./rProcessTransport";

const CRAN_REPOSITORY = "https://cloud.r-project.org";
const MAX_PROBE_BYTES = 64 * 1024;
let repairInProgress = false;

export interface RFileDependencyTarget {
  readonly runtimeRoot: string;
  readonly rscriptPath: string;
  readonly cwd: vscode.Uri;
  readonly environment: NodeJS.ProcessEnv;
  readonly format: RProcessFileSource["format"];
}

interface RDependencyProbe {
  readonly rHome: string;
  readonly rVersion: string;
  readonly libraryPaths: readonly string[];
  readonly userLibrary: string;
  readonly requirements: readonly RDependencyRequirement[];
}

/** A failed file owns this repair; no active notebook, terminal or runtime setting is consulted. */
export async function repairRFileDependencies(
  target: RFileDependencyTarget,
  original: readonly RDependencyRequirement[],
  library: RLibrary,
  options: BridgeRequestOptions = {}
): Promise<false | { readonly libraryPath?: string }> {
  const current = (): boolean => vscode.workspace.isTrusted && !options.cancellation?.isCancellationRequested;
  if (!current()) return false;
  if (repairInProgress)
    throw new Error("Another R package check or installation is still running. Wait for it to finish, then retry.");
  repairInProgress = true;
  const settlements: Promise<void>[] = [];
  let cleanupRoot: string | undefined;
  try {
    const executable = await fileIdentity(target.rscriptPath);
    const root = await mkdtemp(path.join(tmpdir(), "openwrangler-r-dependencies-"));
    cleanupRoot = root;
    await chmod(root, 0o700);
    const probe = async (environment: NodeJS.ProcessEnv, suffix: string): Promise<RDependencyProbe> => {
      const output = path.join(root, `${suffix}.json`);
      const scriptPath = path.join(root, `${suffix}.R`);
      await writeFile(scriptPath, buildRFileDependencyProbeCode(target, original, library, output), {
        flag: "wx",
        mode: 0o400
      });
      if (!current()) throw new Error("R package checking was cancelled.");
      const process = startRDependencyProcess({
        rscriptPath: target.rscriptPath,
        scriptPath,
        cwd: target.cwd,
        environment,
        mode: "probe",
        cancellation: options.cancellation
      });
      settlements.push(process.settlement);
      await process.completion;
      const info = await stat(output);
      if (!info.isFile() || info.size > MAX_PROBE_BYTES)
        throw new Error("The R package check returned an invalid result.");
      return decodeRDependencyProbe(JSON.parse(await readFile(output, "utf8")), target.cwd.fsPath);
    };
    const before = await probe(target.environment, "before");
    if (!current()) return false;
    if (before.requirements.length === 0) return {};
    const targetLibrary = await selectTargetLibrary(before);
    const targetIdentity = await existingAncestorIdentity(targetLibrary);
    const requirements = before.requirements.map(
      (requirement) =>
        `${requirement.packageName}${requirement.minimumVersion ? ` >= ${requirement.minimumVersion}` : ""}`
    );
    const answer = await vscode.window.showWarningMessage(
      "Install or update the R packages needed to open this file?",
      {
        modal: true,
        detail: [
          `Packages: ${requirements.join(", ")}`,
          `Rscript: ${target.rscriptPath}`,
          `R ${before.rVersion} at ${before.rHome}`,
          `Package library: ${targetLibrary}`,
          `Repository: ${CRAN_REPOSITORY}`,
          "Installation runs in its own terminal and can take several minutes. Keep that terminal open until it finishes. Closing this data view will not interrupt package writes."
        ].join("\n\n")
      },
      "Install"
    );
    if (answer !== "Install" || !current()) return false;
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Open Wrangler dependencies" },
      async () => {
        await assertFileIdentity(target.rscriptPath, executable);
        await assertFileIdentity(targetIdentity.path, targetIdentity.identity);
        const installScript = path.join(root, "install.R");
        const reportPath = path.join(root, "install-result.json");
        await writeFile(installScript, buildRFileDependencyInstallCode(before, targetLibrary, reportPath), {
          flag: "wx",
          mode: 0o400
        });
        if (!current()) return false;
        const install = startRDependencyProcess({
          rscriptPath: target.rscriptPath,
          scriptPath: installScript,
          cwd: target.cwd,
          environment: target.environment,
          mode: "install",
          cancellation: options.cancellation
        });
        settlements.push(install.settlement);
        try {
          await install.completion;
        } catch (error) {
          if (!current()) return false;
          const detail = await installFailureDetail(reportPath);
          throw new Error(
            `${error instanceof Error ? error.message : "R package installation failed."}${detail ? ` ${detail}` : ""}`
          );
        }
        if (!current()) return false;
        const environment = rEnvironmentWithLibrary(target.environment, targetLibrary);
        const after = await probe(environment, "after");
        if (after.rHome !== before.rHome || after.rVersion !== before.rVersion || after.requirements.length > 0) {
          const detail = await installFailureDetail(reportPath);
          throw new Error(
            `R package installation did not satisfy this file's requirements. ` +
              (after.requirements.length
                ? `Still unavailable: ${after.requirements.map((entry) => entry.packageName).join(", ")}. `
                : "The R environment changed. ") +
              (detail || "Retry after checking the R package requirements and available build tools.")
          );
        }
        if (!current()) return false;
        void vscode.window.showInformationMessage("Open Wrangler runtime dependencies were installed.");
        return { libraryPath: targetLibrary };
      }
    );
  } finally {
    // An abandoned waiter is not proof of process exit. Retain the installation reservation and files until exit.
    void Promise.allSettled(settlements)
      .then(async () => {
        repairInProgress = false;
        if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true });
      })
      .catch(() => undefined);
  }
}

export function rEnvironmentWithLibrary(environment: NodeJS.ProcessEnv, libraryPath: string): NodeJS.ProcessEnv {
  return { ...environment, R_LIBS: [libraryPath, environment.R_LIBS].filter(Boolean).join(path.delimiter) };
}

export function buildRFileDependencyProbeCode(
  target: Pick<RFileDependencyTarget, "runtimeRoot" | "format">,
  original: readonly RDependencyRequirement[],
  library: RLibrary,
  output: string
): string {
  const coreChecks = R_CORE_DEPENDENCY_REQUIREMENTS.map(
    (requirement) => `check(.__ow_check_native_r_dependency(
    list(package = ${rStringExpression(requirement.packageName)}, minimum = ${rStringExpression(requirement.minimumVersion)},
      exports = ${rStrings(requirement.exports)}), "the selected Rscript environment"))`
  ).join("\n");
  const originalChecks = original
    .filter(
      (requirement) => !R_CORE_DEPENDENCY_REQUIREMENTS.some((core) => core.packageName === requirement.packageName)
    )
    .map(
      (requirement) => `check(frame$require_package(
    ${rStringExpression(requirement.packageName)}, ${requirement.minimumVersion ? rStringExpression(requirement.minimumVersion) : "NULL"},
    ${rStringExpression(`${requirement.packageName} is required to open this file.`)}))`
    )
    .join("\n");
  const formatChecks =
    target.format === "parquet"
      ? "check(frame$require_arrow()); check(frame$require_nanoparquet())"
      : target.format === "excel"
        ? "check(frame$require_readxl())"
        : "";
  return `local({
${buildRDependencyCheckFunctionCode()}
${buildRDependencySerializationCode()}
runtime <- new.env(parent = baseenv())
sys.source(${rStringExpression(path.join(target.runtimeRoot, "frame_contract.R"))}, envir = runtime, keep.source = FALSE)
frame <- runtime$openwrangler_r_frame_contract
requirements <- list()
check <- function(expression) tryCatch(expression, error = function(error) {
  if (!inherits(error, ${rStringExpression(R_DEPENDENCY_FAILURE_CLASS)})) stop(error)
  for (requirement in error$requirements) {
    if (!any(vapply(requirements, function(existing) identical(existing$packageName, requirement$packageName), logical(1L)))) {
      requirements[[length(requirements) + 1L]] <<- requirement
    }
  }
})
${coreChecks}
${formatChecks}
check(frame$require_r_library(${rStringExpression(library)}))
${originalChecks}
paths <- normalizePath(.libPaths(), winslash = "/", mustWork = TRUE)
user <- strsplit(Sys.getenv("R_LIBS_USER"), .Platform$path.sep, fixed = TRUE)[[1L]]
user <- if (length(user)) path.expand(user[[1L]]) else ""
payload <- paste0('{"rHome":', .__ow_dependency_json_string(normalizePath(R.home(), winslash = "/", mustWork = TRUE)),
  ',"rVersion":', .__ow_dependency_json_string(as.character(getRversion())),
  ',"libraryPaths":[', paste(vapply(paths, .__ow_dependency_json_string, character(1L)), collapse = ","),
  '],"userLibrary":', .__ow_dependency_json_string(user),
  ',"requirements":', .__ow_dependency_requirements_json(requirements), '}')
if (nchar(payload, type = "bytes") > ${MAX_PROBE_BYTES}L) stop("The R package check result is too large.", call. = FALSE)
writeLines(payload, ${rStringExpression(output)}, useBytes = TRUE)
})
`;
}

export function buildRFileDependencyInstallCode(
  probe: RDependencyProbe,
  libraryPath: string,
  reportPath: string
): string {
  return `local({
${buildRDependencySerializationCode()}
messages <- character()
record <- function(condition) {
  text <- substr(conditionMessage(condition), 1L, 1024L)
  text <- gsub("https?://[^[:space:]]+", "[repository URL]", text, perl = TRUE)
  text <- gsub("[[:cntrl:]]", " ", text, perl = TRUE)
  if (length(messages) < 6L) messages <<- c(messages, text)
}
success <- tryCatch(withCallingHandlers({
if (!identical(normalizePath(R.home(), winslash = "/", mustWork = TRUE), ${rStringExpression(probe.rHome)}) ||
    !identical(as.character(getRversion()), ${rStringExpression(probe.rVersion)}) ||
    !identical(normalizePath(.libPaths(), winslash = "/", mustWork = TRUE), ${rStrings(probe.libraryPaths)})) {
  stop("The selected R environment changed. Reopen the file before installing packages.", call. = FALSE)
}
library <- ${rStringExpression(libraryPath)}
ancestor <- library
while (!file.exists(ancestor) && dirname(ancestor) != ancestor) ancestor <- dirname(ancestor)
if (!dir.exists(ancestor) || !identical(normalizePath(ancestor, winslash = "/", mustWork = TRUE), ancestor)) {
  stop("The confirmed R package library parent changed.", call. = FALSE)
}
if (!dir.exists(library) && !dir.create(library, recursive = TRUE, showWarnings = FALSE)) {
  stop("R could not create the confirmed package library.", call. = FALSE)
}
if (!identical(normalizePath(library, winslash = "/", mustWork = TRUE), library)) {
  stop("The confirmed R package library changed.", call. = FALSE)
}
.libPaths(c(library, .libPaths()))
utils::install.packages(${rStrings(probe.requirements.map((entry) => entry.packageName))},
  lib = library, repos = ${rStringExpression(CRAN_REPOSITORY)}, lock = TRUE)
TRUE
}, warning = record), error = function(error) { record(error); FALSE })
writeLines(paste0("[", paste(vapply(messages, .__ow_dependency_json_string, character(1L)), collapse = ","), "]"),
  ${rStringExpression(reportPath)}, useBytes = TRUE)
if (!success) quit(save = "no", status = 1L, runLast = FALSE)
})
`;
}

function rStrings(values: readonly string[]): string {
  return values.length ? `c(${values.map(rStringExpression).join(", ")})` : "character()";
}

function decodeRDependencyProbe(value: unknown, workingDirectory: string): RDependencyProbe {
  function fail(): never {
    throw new Error("The R package check returned malformed environment details.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const validPath = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length <= 4096 &&
    path.isAbsolute(candidate) &&
    !hasControlCharacter(candidate);
  if (
    typeof record.userLibrary !== "string" ||
    record.userLibrary.length > 4096 ||
    hasControlCharacter(record.userLibrary)
  )
    fail();
  const userLibrary = record.userLibrary ? path.resolve(workingDirectory, record.userLibrary) : "";
  if (
    !validPath(record.rHome) ||
    typeof record.rVersion !== "string" ||
    !/^\d+[.\d-]{0,63}$/u.test(record.rVersion) ||
    !Array.isArray(record.libraryPaths) ||
    record.libraryPaths.length < 1 ||
    record.libraryPaths.length > 32 ||
    !record.libraryPaths.every(validPath) ||
    new Set(record.libraryPaths).size !== record.libraryPaths.length ||
    !(userLibrary === "" || validPath(userLibrary)) ||
    !Array.isArray(record.requirements)
  )
    fail();
  return {
    rHome: record.rHome as string,
    rVersion: record.rVersion as string,
    libraryPaths: record.libraryPaths as string[],
    userLibrary,
    requirements: (record.requirements as unknown[]).length ? decodeRDependencyRequirements(record.requirements) : []
  };
}

async function selectTargetLibrary(probe: RDependencyProbe): Promise<string> {
  const first = probe.libraryPaths[0]!;
  const writable = async (directory: string): Promise<boolean> => {
    try {
      await access(directory, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (await writable(first)) return (await realpath(first)).replaceAll(path.sep, "/");
  if (!probe.userLibrary)
    throw new Error(
      "The selected R library is read-only and R has no personal library. Configure R_LIBS_USER, then reopen this file."
    );
  const ancestor = await existingAncestorIdentity(probe.userLibrary);
  if (!(await writable(ancestor.path)))
    throw new Error(
      "The selected R personal library is not writable. Choose a writable R library, then reopen this file."
    );
  return path
    .join(ancestor.identity.realPath, path.relative(ancestor.path, probe.userLibrary))
    .replaceAll(path.sep, "/");
}

async function fileIdentity(
  file: string
): Promise<{ readonly realPath: string; readonly dev: bigint; readonly ino: bigint }> {
  const realPath = await realpath(file);
  const info = await stat(realPath, { bigint: true });
  return { realPath, dev: info.dev, ino: info.ino };
}

async function assertFileIdentity(file: string, expected: Awaited<ReturnType<typeof fileIdentity>>): Promise<void> {
  const actual = await fileIdentity(file);
  if (actual.realPath !== expected.realPath || actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error(
      "The selected R executable or package library changed. Reopen the file before installing packages."
    );
}

async function existingAncestorIdentity(
  file: string
): Promise<{ path: string; identity: Awaited<ReturnType<typeof fileIdentity>> }> {
  let candidate = file;
  for (;;) {
    try {
      return { path: candidate, identity: await fileIdentity(candidate) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(candidate) === candidate) throw error;
      candidate = path.dirname(candidate);
    }
  }
}

async function installFailureDetail(reportPath: string): Promise<string> {
  try {
    const info = await stat(reportPath);
    if (!info.isFile() || info.size > 8192) return "";
    const messages: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    if (
      !Array.isArray(messages) ||
      messages.length > 6 ||
      messages.some((message) => typeof message !== "string" || message.length > 1024 || hasControlCharacter(message))
    )
      return "";
    return messages.join(" ").slice(0, 4096);
  } catch {
    return "";
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point < 32 || point === 127;
  });
}
