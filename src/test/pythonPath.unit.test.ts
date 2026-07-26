import * as path from "path";
import { describe, expect, it } from "vitest";
import { isFullyQualifiedPythonPath, resolvePythonCommandPath, resolvePythonExecutable } from "../extension/pythonPath";

describe("resolvePythonExecutable", () => {
  it("keeps absolute paths unchanged", () => {
    expect(resolvePythonExecutable("/opt/python/bin/python", ["/workspace"], "/extension", () => false)).toBe(
      "/opt/python/bin/python"
    );
  });

  it("resolves relative paths from the workspace before the extension", () => {
    const workspace = path.resolve("workspace");
    const extension = path.resolve("extension");
    const configured = path.join(".venv", "bin", "python");
    const workspacePython = path.join(workspace, configured);
    const existing = new Set([workspacePython, path.join(extension, configured)]);

    expect(resolvePythonExecutable(configured, [workspace], extension, (candidate) => existing.has(candidate))).toBe(
      workspacePython
    );
  });

  it("falls back to the configured path when no relative candidate exists", () => {
    expect(resolvePythonExecutable("python3", ["/workspace"], "/extension", () => false)).toBe("python3");
  });

  it("does not let a workspace file shadow a configured command name", () => {
    const workspace = path.resolve("workspace");
    expect(resolvePythonExecutable("python3", [workspace], "/extension", () => true)).toBe("python3");
  });
});

describe("resolvePythonCommandPath", () => {
  it("accepts fully qualified Windows drive and UNC paths with either separator", () => {
    expect(isFullyQualifiedPythonPath("C:\\Python314\\python.exe", "win32")).toBe(true);
    expect(isFullyQualifiedPythonPath("C:/Python314/python.exe", "win32")).toBe(true);
    expect(isFullyQualifiedPythonPath("\\\\server\\share\\python.exe", "win32")).toBe(true);
    expect(isFullyQualifiedPythonPath("//server/share/python.exe", "win32")).toBe(true);
    expect(isFullyQualifiedPythonPath("C:relative\\python.exe", "win32")).toBe(false);
    expect(isFullyQualifiedPythonPath("\\root-relative\\python.exe", "win32")).toBe(false);
  });

  it("keeps an absolute executable path", () => {
    const executable = path.resolve("python");
    expect(resolvePythonCommandPath(executable, { PATH: "" }, () => true)).toBe(executable);
    expect(resolvePythonCommandPath(executable, { PATH: "" }, () => false)).toBeUndefined();
  });

  it("ignores empty and relative PATH entries", () => {
    const trustedDirectory = path.resolve("trusted-bin");
    const relativeDirectory = "hostile-bin";
    const separator = path.delimiter;
    const executable = path.join(trustedDirectory, process.platform === "win32" ? "python3.exe" : "python3");
    const checked: string[] = [];

    expect(
      resolvePythonCommandPath(
        "python3",
        { PATH: `${separator}.${separator}${relativeDirectory}${separator}${trustedDirectory}` },
        (candidate) => {
          checked.push(candidate);
          return candidate === executable;
        }
      )
    ).toBe(executable);
    expect(checked).toEqual([executable]);
  });

  it("rejects unresolved relative paths instead of resolving them against the host cwd", () => {
    expect(resolvePythonCommandPath("./venv/python", { PATH: path.resolve("bin") }, () => true)).toBeUndefined();
  });

  it("resolves Windows commands with a case-insensitive Path and PATHEXT", () => {
    const directory = "C:\\Python314";
    expect(
      resolvePythonCommandPath(
        "python",
        { Path: directory, PathExt: ".CMD;.BAT" },
        (candidate) => candidate.toLocaleLowerCase("en-US") === "c:\\python314\\python.exe",
        "win32"
      )
    ).toBe("C:\\Python314\\python.exe");
  });

  it("does not use Windows command wrappers or ambiguous PATH keys", () => {
    expect(resolvePythonCommandPath("python.cmd", { Path: "C:\\Python314" }, () => true, "win32")).toBeUndefined();
    expect(resolvePythonCommandPath("\\Python314\\python.exe", {}, () => true, "win32")).toBeUndefined();
    expect(
      resolvePythonCommandPath("python", { PATH: "C:\\Trusted", Path: "C:\\Hostile" }, () => true, "win32")
    ).toBeUndefined();
  });

  it("treats PATH as case-sensitive on POSIX", () => {
    expect(resolvePythonCommandPath("python3", { Path: path.resolve("bin") }, () => true, "linux")).toBeUndefined();
  });
});
