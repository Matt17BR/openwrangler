import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const notices = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
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

const errors = [];
const productionPackages = [];
for (const [packagePath, metadata] of Object.entries(lock.packages)) {
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

for (const required of ["MIT", "CC-BY-4.0", "Pandas", "Polars", "PyArrow", "openpyxl", "fastexcel"]) {
  if (!notices.includes(required)) errors.push(`THIRD_PARTY_NOTICES.md is missing ${required}.`);
}

if (errors.length) throw new Error(`Dependency license policy failed:\n- ${[...new Set(errors)].join("\n- ")}`);

const counts = new Map();
for (const dependency of productionPackages) {
  counts.set(dependency.license, (counts.get(dependency.license) ?? 0) + 1);
}
console.log(
  `Verified ${productionPackages.length} bundled production packages: ${[...counts.entries()]
    .map(([license, count]) => `${count} ${license}`)
    .join(", ")}.`
);
