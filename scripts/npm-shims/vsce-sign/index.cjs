"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
/* global module, process, require */

const { execFile } = require("node:child_process");
const path = require("node:path");

const codes = Object.freeze([
  "Success",
  undefined,
  undefined,
  "RequiredArgumentMissing",
  "InvalidArgument",
  "PackageIsUnreadable",
  "UnhandledException",
  "SignatureManifestIsMissing",
  "SignatureManifestIsUnreadable",
  "SignatureIsMissing",
  "SignatureIsUnreadable",
  "CertificateIsUnreadable",
  "SignatureArchiveIsUnreadable",
  "FileAlreadyExists",
  "SignatureArchiveIsInvalidZip",
  "SignatureArchiveHasSameSignatureFile",
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  "PackageIntegrityCheckFailed",
  "SignatureIsInvalid",
  "SignatureManifestIsInvalid",
  "SignatureIntegrityCheckFailed",
  "EntryIsMissing",
  "EntryIsTampered",
  "Untrusted",
  "CertificateRevoked",
  "SignatureIsNotValid",
  "UnknownError",
  "PackageIsInvalidZip",
  "SignatureArchiveHasTooManyEntries"
]);

const ExtensionSignatureVerificationCode = Object.freeze(
  Object.fromEntries(codes.filter(Boolean).map((code) => [code, code]))
);
const ReturnCode = Object.freeze(
  Object.fromEntries(
    codes.flatMap((code, index) =>
      code === undefined
        ? []
        : [
            [index, code],
            [code, index]
          ]
    )
  )
);

class ExtensionSignatureVerificationResult {
  constructor(code, didExecute, internalCode, output) {
    this.code = code;
    this.didExecute = didExecute;
    this.internalCode = internalCode;
    this.output = output;
  }
}

function isAlpineLinux() {
  if (process.platform !== "linux") return false;
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return true;
  }
}

function currentTarget() {
  const platform = process.platform;
  const architecture = process.arch;
  if (platform === "darwin" && ["arm64", "x64"].includes(architecture)) return `darwin-${architecture}`;
  if (platform === "win32" && ["arm64", "x64"].includes(architecture)) return `win32-${architecture}`;
  if (platform === "linux" && ["arm", "arm64", "x64"].includes(architecture)) {
    if (isAlpineLinux()) {
      if (architecture === "arm") throw new Error("VSCE signing does not support Alpine Linux arm.");
      return `alpine-${architecture}`;
    }
    return `linux-${architecture}`;
  }
  throw new Error(`VSCE signing does not support ${platform}-${architecture}.`);
}

function signingExecutable() {
  const executable = process.platform === "win32" ? "vsce-sign.exe" : "vsce-sign";
  return require.resolve(`@vscode/vsce-sign-${currentTarget()}/bin/${executable}`);
}

function execute(arguments_, verbose, rejectOnFailure) {
  const args = verbose === true ? [...arguments_, "--verbose"] : [...arguments_];
  return new Promise((resolve, reject) => {
    execFile(signingExecutable(), args, (error, stdout) => {
      const rawCode = error === null ? 0 : error?.code;
      const didExecute = typeof rawCode === "number";
      const internalCode = didExecute ? rawCode : undefined;
      const code = didExecute ? (ReturnCode[rawCode] ?? "UnknownError") : (rawCode ?? "UnknownError");
      const result = new ExtensionSignatureVerificationResult(
        code,
        didExecute,
        internalCode,
        verbose ? stdout : undefined
      );
      if (rejectOnFailure && code !== "Success") reject(result);
      else resolve(result);
    });
  });
}

async function verify(vsixFilePath, signatureArchiveFilePath, verbose = false) {
  return execute(["verify", "--package", vsixFilePath, "--signaturearchive", signatureArchiveFilePath], verbose, false);
}

async function generateManifest(vsixFilePath, manifestFilePath, verbose = false) {
  const output = manifestFilePath ?? path.join(path.dirname(vsixFilePath), ".signature.manifest");
  await execute(["generatemanifest", "--package", vsixFilePath, "--output", output], verbose, true);
  return output;
}

async function zip(manifestFilePath, signatureFilePath, signatureArchiveFilePath, verbose = false) {
  const output = signatureArchiveFilePath ?? path.join(path.dirname(manifestFilePath), ".signature.zip");
  await execute(
    ["zip", "--manifest", manifestFilePath, "--signature", signatureFilePath, "--output", output],
    verbose,
    true
  );
  return output;
}

module.exports = Object.freeze({
  ExtensionSignatureVerificationCode,
  ExtensionSignatureVerificationResult,
  ReturnCode,
  generateManifest,
  verify,
  zip
});
