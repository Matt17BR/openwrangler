export function inspectPublicWriting({ agentGuide, contributing, pullRequestTemplate, styleGuide }) {
  for (const [name, value] of Object.entries({ agentGuide, contributing, pullRequestTemplate, styleGuide })) {
    if (typeof value !== "string") {
      throw new TypeError(`Public-writing input ${name} must be a string.`);
    }
  }
  const problems = [];
  if (!agentGuide.includes("docs/writing-style.md")) {
    problems.push("AGENTS.md must route future agents to docs/writing-style.md.");
  }
  if (!contributing.includes("docs/writing-style.md")) {
    problems.push("CONTRIBUTING.md must route contributors to docs/writing-style.md.");
  }
  if (!pullRequestTemplate.includes("docs/writing-style.md")) {
    problems.push("The pull request template must include a public-copy review using docs/writing-style.md.");
  }
  if (!styleGuide.includes("Write as a maintainer explaining the product to another developer.")) {
    problems.push("The writing guide must retain its plain-language maintainer rule.");
  }
  const publicCopyHeading = "\n## Public copy";
  const publicCopyHeadingIndex = styleGuide.indexOf(publicCopyHeading);
  if (publicCopyHeadingIndex === -1) {
    problems.push("The writing guide must retain its Public copy section.");
  }
  for (const heading of ["## What changed", "## Why", "## Verification", "## User-facing docs or screenshots"]) {
    if (!pullRequestTemplate.includes(heading)) {
      problems.push(`The pull request template is missing ${heading}.`);
    }
  }
  return problems;
}
