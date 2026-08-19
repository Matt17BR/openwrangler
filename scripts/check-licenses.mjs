import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APPROVED_PROJECT_LICENSE = Object.freeze({
  spdx: "MIT",
  sha256: "1436578df6da613a94af2095a3bc369ec565175f8b32d4d89f7af5cd5de9ca16"
});

const VENDORED_JS_YAML = Object.freeze({
  version: "5.2.3",
  runtimeBytes: 122_488,
  runtimeSha256: "f1499c20ab232a283f6f9f85aeecc99dceab175e8dd4005bd3d764848f3e5965",
  licenseSha256: "a07bc24468b9654ce76a547d47a2db282d07733b715db4c73a98bd63961f9550"
});

const allowedLicenses = new Set(["MIT", "CC-BY-4.0"]);
const noticeGroups = [
  {
    name: "CodeMirror and Lezer",
    matches: (name) =>
      name.startsWith("@codemirror/") ||
      name.startsWith("@lezer/") ||
      ["@marijn/find-cluster-break", "crelt", "style-mod", "w3c-keyname"].includes(name)
  },
  {
    name: "React",
    matches: (name) => ["react", "react-dom", "scheduler"].includes(name)
  },
  {
    name: "Codicons",
    matches: (name) => name === "@vscode/codicons"
  }
];

export function inspectProjectLicensePolicy({ packageJsonSource, licenseBytes }) {
  if (typeof packageJsonSource !== "string" || !Buffer.isBuffer(licenseBytes)) {
    throw new TypeError("Project license policy requires package metadata and exact license bytes.");
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonSource);
  } catch {
    return ["package.json must contain valid JSON before its project license can be checked."];
  }

  const errors = [];
  if (packageJson.license !== APPROVED_PROJECT_LICENSE.spdx) {
    errors.push(`package.json must declare the approved ${APPROVED_PROJECT_LICENSE.spdx} project license.`);
  }
  const digest = createHash("sha256").update(licenseBytes).digest("hex");
  if (digest !== APPROVED_PROJECT_LICENSE.sha256) {
    errors.push("LICENSE must byte-match the reviewed Open Wrangler MIT license text.");
  }
  return errors;
}

export function inspectDependencyLicensePolicy({ root, lock, notices }) {
  if (typeof root !== "string" || typeof lock !== "object" || lock === null || typeof notices !== "string") {
    throw new TypeError("Dependency license policy requires a root, lockfile object, and notices text.");
  }

  const errors = [];
  const productionPackages = [];
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    if (metadata.link) {
      if (lock.packages[metadata.resolved] === undefined) {
        errors.push(`${packagePath} has no lockfile-owned link target.`);
      }
      continue;
    }
    if (!packagePath || metadata.dev) continue;
    const manifest = JSON.parse(readFileSync(resolve(root, packagePath, "package.json"), "utf8"));
    const name = manifest.name ?? metadata.name ?? packagePath.split("node_modules/").at(-1);
    const license = manifest.license ?? metadata.license;
    productionPackages.push({ name, license });
    if (!license) errors.push(`${name} does not declare a license.`);
    else if (!allowedLicenses.has(license)) errors.push(`${name} uses unapproved production license ${license}.`);

    const group = noticeGroups.find((candidate) => candidate.matches(name));
    if (!group) errors.push(`${name} is not assigned to a third-party notice group.`);
    else if (!notices.includes(group.name)) errors.push(`THIRD_PARTY_NOTICES.md is missing ${group.name}.`);
  }

  for (const required of [
    "MIT",
    "CC-BY-4.0",
    "Pandas",
    "Polars",
    "PyArrow",
    "openpyxl",
    "fastexcel",
    "fsspec 2026.7.0: BSD-3-Clause License"
  ]) {
    if (!notices.includes(required)) errors.push(`THIRD_PARTY_NOTICES.md is missing ${required}.`);
  }
  return { errors, productionPackages };
}

export function inspectVendoredRuntimeLicensePolicy({
  packageJsonSource,
  lock,
  notices,
  jsYamlRuntimeBytes,
  jsYamlLicenseBytes
}) {
  if (
    typeof packageJsonSource !== "string" ||
    typeof lock !== "object" ||
    lock === null ||
    typeof notices !== "string" ||
    !Buffer.isBuffer(jsYamlRuntimeBytes) ||
    !Buffer.isBuffer(jsYamlLicenseBytes)
  ) {
    throw new TypeError("Vendored runtime license policy requires package metadata, exact bytes, and notices text.");
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonSource);
  } catch {
    return ["package.json must contain valid JSON before the vendored runtime can be checked."];
  }

  const errors = [];
  if (packageJson.dependencies?.["js-yaml"] !== undefined) {
    errors.push("js-yaml must remain a development dependency because only its reviewed runtime asset is vendored.");
  }
  if (packageJson.devDependencies?.["js-yaml"] !== `^${VENDORED_JS_YAML.version}`) {
    errors.push(`package.json must retain js-yaml ^${VENDORED_JS_YAML.version} as a development dependency.`);
  }
  const locked = lock.packages?.["node_modules/js-yaml"];
  if (locked?.version !== VENDORED_JS_YAML.version || locked.dev !== true || locked.license !== "MIT") {
    errors.push(`package-lock.json must pin js-yaml ${VENDORED_JS_YAML.version} as an MIT development dependency.`);
  }
  if (
    jsYamlRuntimeBytes.length !== VENDORED_JS_YAML.runtimeBytes ||
    createHash("sha256").update(jsYamlRuntimeBytes).digest("hex") !== VENDORED_JS_YAML.runtimeSha256
  ) {
    errors.push("The vendored js-yaml runtime source must byte-match its reviewed release asset.");
  }
  if (createHash("sha256").update(jsYamlLicenseBytes).digest("hex") !== VENDORED_JS_YAML.licenseSha256) {
    errors.push("The js-yaml LICENSE must byte-match its reviewed MIT notice.");
  }
  const exactLicense = jsYamlLicenseBytes.toString("utf8");
  if (
    !notices.includes(`js-yaml ${VENDORED_JS_YAML.version}`) ||
    !notices.includes("Copyright (C) 2011-2015 by Vitaly Puzrin") ||
    !notices.includes(exactLicense)
  ) {
    errors.push("THIRD_PARTY_NOTICES.md must include the full reviewed js-yaml MIT notice.");
  }
  return errors;
}

export function runLicenseCheck(root = resolve(import.meta.dirname, "..")) {
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  const notices = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const packageJsonSource = readFileSync(resolve(root, "package.json"), "utf8");
  const errors = inspectProjectLicensePolicy({
    packageJsonSource,
    licenseBytes: readFileSync(resolve(root, "LICENSE"))
  });
  const dependencyPolicy = inspectDependencyLicensePolicy({ root, lock, notices });
  errors.push(...dependencyPolicy.errors);
  errors.push(
    ...inspectVendoredRuntimeLicensePolicy({
      packageJsonSource,
      lock,
      notices,
      jsYamlRuntimeBytes: readFileSync(resolve(root, "node_modules/js-yaml/dist/js-yaml.cjs.js")),
      jsYamlLicenseBytes: readFileSync(resolve(root, "node_modules/js-yaml/LICENSE"))
    })
  );

  if (errors.length) throw new Error(`License policy failed:\n- ${[...new Set(errors)].join("\n- ")}`);

  const counts = new Map();
  for (const dependency of dependencyPolicy.productionPackages) {
    counts.set(dependency.license, (counts.get(dependency.license) ?? 0) + 1);
  }
  return `Verified the ${APPROVED_PROJECT_LICENSE.spdx} project license, the exact vendored js-yaml runtime, and ${
    dependencyPolicy.productionPackages.length
  } bundled production packages: ${[...counts.entries()].map(([license, count]) => `${count} ${license}`).join(", ")}.`;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    console.log(runLicenseCheck());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "License policy failed."}\n`);
    process.exitCode = 1;
  }
}
