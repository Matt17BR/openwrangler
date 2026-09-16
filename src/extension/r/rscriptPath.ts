import { accessSync, constants as fsConstants, statSync } from "node:fs";
import type * as vscode from "vscode";
import { getSetting } from "../configuration";
import { resolveExecutableCommand } from "../pythonPath";

export function configuredRscriptPath(resource: vscode.Uri): string | undefined {
  const configured = getSetting<string>("rscriptPath", "", resource).trim() || "Rscript";
  return resolveExecutableCommand(configured, process.env, isExecutableFile);
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
