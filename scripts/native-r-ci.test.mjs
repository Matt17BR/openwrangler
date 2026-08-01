import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { load as parseYaml } from "js-yaml";

const SETUP_R_ACTION = "r-lib/actions/setup-r@bd49c52ffe281809afa6f0fecbf37483c5dd0b93";
const SETUP_R_DEPENDENCIES_ACTION = "r-lib/actions/setup-r-dependencies@bd49c52ffe281809afa6f0fecbf37483c5dd0b93";
const LOCAL_R_ACTION = "./.github/actions/setup-native-r";
const PACKAGE_COMMAND = /^npm run package(?::prepared)?(?:\s|$)/u;

function readRepositoryFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("native R setup pins and verifies the complete advertised read-only toolchain", () => {
  const action = parseYaml(readRepositoryFile(".github/actions/setup-native-r/action.yml"));
  assert.deepEqual(action, {
    name: "Set up the pinned native R test toolchain",
    description: "Install and verify the exact R toolchain used by the native R provider gate.",
    runs: {
      using: "composite",
      steps: [
        {
          uses: SETUP_R_ACTION,
          with: {
            "r-version": "4.5.2",
            "use-public-rspm": true
          }
        },
        {
          uses: SETUP_R_DEPENDENCIES_ACTION,
          with: {
            packages: "cran::jsonlite@2.0.0\ncran::tibble@3.3.1\ncran::data.table@1.18.2.1\n",
            dependencies: '"hard"',
            "cache-version": "r-4.5.2-cran-jsonlite-2.0.0-tibble-3.3.1-data-table-1.18.2.1",
            "install-quarto": false
          }
        },
        {
          name: "Verify the exact native R test toolchain",
          shell: "bash",
          run: "Rscript --vanilla r/tests/verify_ci_toolchain.R"
        }
      ]
    }
  });

  const packages = action.runs.steps[1].with.packages.trim().split("\n");
  assert.deepEqual(packages, ["cran::jsonlite@2.0.0", "cran::tibble@3.3.1", "cran::data.table@1.18.2.1"]);
  assert.ok(
    packages.every((reference) => /^cran::[A-Za-z][A-Za-z0-9.]*@[0-9]+(?:[.-][0-9]+)*$/u.test(reference)),
    "Every advertised R dependency must constrain both the CRAN source and exact version."
  );

  const verification = readRepositoryFile("r/tests/verify_ci_toolchain.R");
  assert.match(verification, /expected_r_version <- "4\.5\.2"/u);
  assert.match(verification, /jsonlite = "2\.0\.0"/u);
  assert.match(verification, /tibble = "3\.3\.1"/u);
  assert.match(verification, /data\.table = "1\.18\.2\.1"/u);
  assert.match(verification, /requireNamespace\(package_name, quietly = TRUE\)/u);
  assert.match(verification, /utils::packageVersion\(package_name\)/u);
});

test("the ordinary package lifecycle cannot omit the native R gate", () => {
  const manifest = JSON.parse(readRepositoryFile("package.json"));
  assert.equal(
    manifest.scripts?.["test:r"],
    "Rscript --vanilla r/tests/runtime_smoke.R && Rscript --vanilla r/openwrangler_runtime/kernel_agent.R --probe"
  );
  assert.equal(
    manifest.scripts?.prepackage,
    "npm run clean && npm run build && npm run check && npm test && npm run test:r"
  );
});

test("every CI package producer prepares pinned R before packaging", () => {
  const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
  const producers = [];
  for (const fileName of readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".yml"))
    .sort()) {
    const workflow = parseYaml(readFileSync(new URL(fileName, workflowsDirectory), "utf8"));
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const packageIndexes = steps
        .map((step, index) => ({ index, run: typeof step?.run === "string" ? step.run.trim() : "" }))
        .filter(({ run }) => PACKAGE_COMMAND.test(run))
        .map(({ index }) => index);
      if (packageIndexes.length === 0) continue;
      producers.push(`${fileName}:${jobName}`);
      const setupIndexes = steps
        .map((step, index) => ({ index, step }))
        .filter(({ step }) => step?.uses === LOCAL_R_ACTION)
        .map(({ index }) => index);
      assert.equal(
        setupIndexes.length,
        1,
        `${fileName}:${jobName} must prepare the pinned native R toolchain exactly once.`
      );
      assert.ok(
        setupIndexes[0] < Math.min(...packageIndexes),
        `${fileName}:${jobName} must prepare native R before package lifecycle execution.`
      );
    }
  }

  assert.deepEqual(producers, [
    "ci.yml:canonical-vsix",
    "release.yml:build",
    "released-jupyter.yml:vscode",
    "stable-candidate.yml:package",
    "stable-release.yml:package"
  ]);
});

test("CI-internal prepared packaging runs the native R test explicitly", () => {
  const workflow = parseYaml(readRepositoryFile(".github/workflows/ci.yml"));
  const steps = workflow?.jobs?.["canonical-vsix"]?.steps;
  assert.ok(Array.isArray(steps));
  const setupIndex = steps.findIndex((step) => step?.uses === LOCAL_R_ACTION);
  const testIndex = steps.findIndex((step) => step?.run === "npm run test:r");
  const packageIndex = steps.findIndex((step) => step?.run === "npm run package:prepared -- --out openwrangler.vsix");
  assert.ok(setupIndex >= 0 && setupIndex < testIndex && testIndex < packageIndex);
});
