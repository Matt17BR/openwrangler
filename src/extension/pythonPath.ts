import * as path from "path";

export type Exists = (candidate: string) => boolean;
export type IsExecutable = (candidate: string) => boolean;

export function resolvePythonExecutable(
  configuredPath: string,
  workspaceFolders: readonly string[],
  extensionPath: string,
  exists: Exists
): string {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  if (!hasPathSeparator(configuredPath, process.platform)) {
    return configuredPath;
  }

  for (const workspaceFolder of workspaceFolders) {
    const candidate = path.join(workspaceFolder, configuredPath);
    if (exists(candidate)) {
      return candidate;
    }
  }

  const extensionCandidate = path.join(extensionPath, configuredPath);
  if (exists(extensionCandidate)) {
    return extensionCandidate;
  }

  return configuredPath;
}

export function resolvePythonCommandPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  isExecutable: IsExecutable,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  return resolveExecutableCommand(command, environment, isExecutable, platform);
}

/** Resolve an absolute executable or a bare command from an absolute PATH. */
export function resolveExecutableCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  isExecutable: IsExecutable,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (isFullyQualifiedPythonPath(command, platform)) {
    const candidate = pathApi.normalize(command);
    return isExecutable(candidate) ? candidate : undefined;
  }
  if (hasPathSeparator(command, platform)) {
    return undefined;
  }

  const pathValue = environmentValue(environment, "PATH", platform);
  if (!pathValue) return undefined;
  const extensions = executableExtensions(command, environment, platform);
  for (const directory of pathValue.split(pathApi.delimiter)) {
    if (!directory || !isFullyQualifiedPythonPath(directory, platform)) continue;
    for (const extension of extensions) {
      const candidate = pathApi.resolve(directory, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function isFullyQualifiedPythonPath(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return path.posix.isAbsolute(candidate);
  const root = path.win32.parse(path.win32.normalize(candidate)).root;
  return /^[A-Za-z]:\\$/.test(root) || root.startsWith("\\\\");
}

function hasPathSeparator(command: string, platform: NodeJS.Platform): boolean {
  return command.includes("/") || (platform === "win32" && command.includes("\\"));
}

function executableExtensions(
  command: string,
  _environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): readonly string[] {
  if (platform !== "win32") return [""];
  const extension = path.win32.extname(command);
  if (!extension) return [".exe"];
  return extension.toLocaleLowerCase("en-US") === ".exe" ? [""] : [];
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return environment[name];
  const entries = Object.entries(environment).filter(([key]) => key.toLocaleUpperCase("en-US") === name);
  return entries.length === 1 ? entries[0]?.[1] : undefined;
}
