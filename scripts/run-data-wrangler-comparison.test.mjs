import assert from "node:assert/strict";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import nodeTest from "node:test";
import { PINNED_PYTHON_EXTENSION_ID } from "./editor-acceptance.mjs";
import { DATA_WRANGLER_COMPARISON_BOUNDARY } from "./data-wrangler-comparison-report.mjs";
import {
  COMPARISON_PRODUCT_FRAGMENT_PROTOCOL,
  COMPARISON_COMMON_EXTENSION_LOCK,
  COMPARISON_TEST_PHASES,
  DATA_WRANGLER_FIRST_USE_SETUP_PHASE,
  DATA_WRANGLER_MARKETPLACE_EXTENSION,
  assertComparisonPathSeparation,
  captureComparisonInputFile,
  createComparisonProductEditorPhasePlan,
  dataWranglerComparisonKernelLabel,
  comparisonPythonCommandMatches,
  comparisonPythonCommandShape,
  createComparisonPythonProcessObserver,
  installComparisonExtension,
  installedComparisonProductVersion,
  normalizeComparisonProductEvidence,
  observeComparisonPythonProcessGroup,
  parseDataWranglerComparisonArguments,
  parseInstalledComparisonExtensions,
  readOfficialVSCodeVersion,
  revalidateComparisonInputFile,
  runComparisonInventoryGuard,
  runComparisonObservedEditorPhase,
  runComparisonProductEditorPhases,
  runDataWranglerComparison,
  writeDataWranglerComparisonJupyterEnvironment,
  writeDataWranglerComparisonReport
} from "./run-data-wrangler-comparison.mjs";

const digest = (value) => value.repeat(64);
const OPEN_WRANGLER_RUN_ID = "11111111-1111-4111-8111-111111111111";
const DATA_WRANGLER_RUN_ID = "22222222-2222-4222-8222-222222222222";
// The runner is Linux x64-only, and these fixtures intentionally exercise Linux inode and symlink semantics.
const test = (name, callback) => nodeTest(name, { skip: process.platform !== "linux" }, callback);

test("comparison arguments expose only candidate, Python, and output paths", () => {
  const options = parseDataWranglerComparisonArguments(
    ["--candidate", "candidate.vsix", "--python", "/opt/python/bin/python", "--out", "result.json"],
    {},
    "/work"
  );
  assert.deepEqual(options, {
    candidate: "/work/candidate.vsix",
    python: "/opt/python/bin/python",
    output: "/work/result.json"
  });

  assert.throws(() => parseDataWranglerComparisonArguments([], {}, "/work"), /requires --candidate/u);
  assert.throws(
    () =>
      parseDataWranglerComparisonArguments(
        ["--candidate", "a.vsix", "--candidate", "b.vsix"],
        { OPEN_WRANGLER_TEST_PYTHON: "/python" },
        "/work"
      ),
    /only once/u
  );
  assert.throws(
    () =>
      parseDataWranglerComparisonArguments(
        ["--candidate", "a.vsix"],
        { OPEN_WRANGLER_TEST_PYTHON: "relative/python" },
        "/work"
      ),
    /absolute path/u
  );
  assert.throws(
    () =>
      parseDataWranglerComparisonArguments(
        ["--candidate", "same.vsix", "--python", "/python", "--out", "same.vsix"],
        {},
        "/work"
      ),
    /must not overwrite or alias/u
  );
  for (const forbidden of [
    "--editor",
    "--data-wrangler-vsix",
    "--data-wrangler-version",
    "--marketplace-url",
    "--display"
  ]) {
    assert.throws(
      () =>
        parseDataWranglerComparisonArguments(
          ["--candidate", "a.vsix", "--python", "/python", forbidden, "value"],
          {},
          "/work"
        ),
      /Unknown comparison runner argument/u
    );
  }
});

test("Data Wrangler setup writes one uniquely correlated kernelspec for the exact pinned interpreter", async () => {
  await withRunnerFixture(async ({ options, directory }) => {
    const pythonReceipt = captureComparisonInputFile(options.python, {
      label: "Comparison Python interpreter",
      executable: true
    });
    const jupyterRoot = resolve(directory, "data-wrangler-jupyter");
    const result = writeDataWranglerComparisonJupyterEnvironment(jupyterRoot, pythonReceipt, DATA_WRANGLER_RUN_ID);
    const expectedLabel = dataWranglerComparisonKernelLabel(DATA_WRANGLER_RUN_ID);
    assert.equal(result.label, expectedLabel);
    assert.deepEqual(Object.keys(result.jupyterEnvironment).sort(), ["configDir", "dataDir", "path", "runtimeDir"]);
    const kernelName = `openwrangler-comparison-${DATA_WRANGLER_RUN_ID.replaceAll("-", "")}`;
    const kernel = JSON.parse(
      readFileSync(resolve(result.jupyterEnvironment.dataDir, "kernels", kernelName, "kernel.json"), "utf8")
    );
    assert.deepEqual(kernel, {
      argv: [options.python, "-I", "-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
      display_name: expectedLabel,
      language: "python",
      metadata: { debugger: false }
    });
    assert.equal(DATA_WRANGLER_FIRST_USE_SETUP_PHASE, "comparison-data-wrangler-setup");
    assert.throws(
      () => writeDataWranglerComparisonJupyterEnvironment(jupyterRoot, pythonReceipt, DATA_WRANGLER_RUN_ID),
      /new absolute private Jupyter directory/u
    );
  });
});

test("Data Wrangler setup and diagnostic share launch state while only the diagnostic receipt reports", async () => {
  const userData = "/private/profile/user";
  const jupyterEnvironment = Object.freeze({
    dataDir: "/private/profile/jupyter/data",
    runtimeDir: "/private/profile/jupyter/runtime",
    configDir: "/private/profile/jupyter/config",
    path: "/private/profile/jupyter/path"
  });
  const phasePlan = createComparisonProductEditorPhasePlan({
    productKey: "data-wrangler",
    diagnosticPhase: COMPARISON_TEST_PHASES["data-wrangler"],
    diagnosticResultPath: "/private/profile/comparison-data-wrangler-result.json",
    firstUseSetupResultPath: "/private/profile/comparison-data-wrangler-setup-result.json",
    userData,
    jupyterEnvironment
  });
  assert.deepEqual(
    phasePlan.map((phase) => ({ kind: phase.kind, phase: phase.phase, reportsFragment: phase.reportsFragment })),
    [
      {
        kind: "first-use-setup",
        phase: DATA_WRANGLER_FIRST_USE_SETUP_PHASE,
        reportsFragment: false
      },
      {
        kind: "diagnostic",
        phase: COMPARISON_TEST_PHASES["data-wrangler"],
        reportsFragment: true
      }
    ]
  );
  assert.equal(phasePlan[0].userData, userData);
  assert.equal(phasePlan[1].userData, userData);
  assert.equal(phasePlan[0].jupyterEnvironment, jupyterEnvironment);
  assert.equal(phasePlan[1].jupyterEnvironment, jupyterEnvironment);

  const events = [];
  const setupReceipt = { receipt: "setup-must-not-report" };
  const diagnosticReceipt = { receipt: "diagnostic-reports" };
  const result = await runComparisonProductEditorPhases({
    phasePlan,
    async runPhase(launch) {
      events.push(launch.kind);
      assert.equal(launch.userData, userData);
      assert.equal(launch.jupyterEnvironment, jupyterEnvironment);
      return launch.kind === "first-use-setup" ? setupReceipt : diagnosticReceipt;
    }
  });
  assert.equal(result, diagnosticReceipt);
  assert.deepEqual(events, ["first-use-setup", "diagnostic"]);

  let diagnosticStarted = false;
  await assert.rejects(
    runComparisonProductEditorPhases({
      phasePlan,
      async runPhase(launch) {
        if (launch.kind === "first-use-setup") throw new Error("runtime selection missing");
        diagnosticStarted = true;
      }
    }),
    /runtime selection missing/u
  );
  assert.equal(diagnosticStarted, false);
  await assert.rejects(
    runComparisonProductEditorPhases({ phasePlan: [...phasePlan], runPhase: async () => undefined }),
    /authentic phase plan/u
  );

  const openPlan = createComparisonProductEditorPhasePlan({
    productKey: "open-wrangler",
    diagnosticPhase: COMPARISON_TEST_PHASES["open-wrangler"],
    diagnosticResultPath: "/private/profile/comparison-open-wrangler-result.json",
    firstUseSetupResultPath: null,
    userData,
    jupyterEnvironment: null
  });
  assert.equal(await runComparisonProductEditorPhases({ phasePlan: openPlan, runPhase: async () => "open" }), "open");
});

test("comparison output rejects lexical, canonical, symlink, and inode aliases of both protected inputs", async () => {
  await withRunnerFixture(async ({ options, directory }) => {
    for (const protectedPath of [options.candidate, options.python]) {
      assert.throws(
        () => assertComparisonPathSeparation({ ...options, output: protectedPath }),
        /must not overwrite or alias/u
      );
    }

    const aliasParent = resolve(directory, "alias-parent");
    symlinkSync(directory, aliasParent, "dir");
    assert.throws(
      () =>
        assertComparisonPathSeparation({
          ...options,
          output: resolve(aliasParent, "candidate.vsix")
        }),
      /Open Wrangler candidate/u
    );

    const symbolicOutput = resolve(directory, "symbolic-result.json");
    symlinkSync(options.python, symbolicOutput);
    assert.throws(
      () => assertComparisonPathSeparation({ ...options, output: symbolicOutput }),
      /configured Python interpreter/u
    );

    const hardLinkedOutput = resolve(directory, "hard-linked-result.json");
    linkSync(options.candidate, hardLinkedOutput);
    assert.throws(
      () => assertComparisonPathSeparation({ ...options, output: hardLinkedOutput }),
      /Open Wrangler candidate/u
    );
  });
});

test("installed-extension inventory is canonical and proves exact products and common pins", () => {
  const openWrangler = parseInstalledComparisonExtensions(
    installedInventory("open-wrangler")
      .map((entry) => (entry.startsWith("matt17br.") ? entry.replace("matt17br.", "Matt17BR.") : entry))
      .reverse()
      .join("\n"),
    "open-wrangler"
  );
  assert.deepEqual(openWrangler, installedInventory("open-wrangler"));
  assert.equal(installedComparisonProductVersion(openWrangler, "open-wrangler"), "1.0.0");

  const dataWrangler = parseInstalledComparisonExtensions(
    installedInventory("data-wrangler").join("\n"),
    "data-wrangler"
  );
  assert.equal(installedComparisonProductVersion(dataWrangler, "data-wrangler"), "1.24.2");

  for (const [inventory, expected] of [
    [
      installedInventory("open-wrangler")
        .filter((entry) => entry !== PINNED_PYTHON_EXTENSION_ID)
        .join("\n"),
      /exact locked comparison extension inventory/u
    ],
    [
      installedInventory("data-wrangler")
        .map((entry) => (entry === DATA_WRANGLER_MARKETPLACE_EXTENSION ? "ms-toolsai.datawrangler@1.25.0" : entry))
        .join("\n"),
      /exact locked comparison extension inventory/u
    ],
    [
      `${installedInventory("open-wrangler").join("\n")}\ninstalling extensions`,
      /malformed installed-extension inventory/u
    ],
    [`${installedInventory("open-wrangler").join("\n")}\n${PINNED_PYTHON_EXTENSION_ID}`, /unique entries/u],
    [
      `${installedInventory("open-wrangler").join("\n")}\nvendor.unlocked@1.0.0`,
      /exact locked comparison extension inventory/u
    ]
  ]) {
    assert.throws(
      () =>
        parseInstalledComparisonExtensions(
          inventory,
          inventory.includes("datawrangler") ? "data-wrangler" : "open-wrangler"
        ),
      expected
    );
  }
});

test("Marketplace installation is exact-ID-only and owned VSIX installation is Open Wrangler-only", async () => {
  const calls = [];
  const headlessSandboxArgs = [
    "--no-sandbox",
    "--ozone-platform=headless",
    "--ozone-override-screen-size=1920,1080",
    "--disable-gpu",
    "--force-disable-user-env",
    "--disable-updates",
    "--disable-crash-reporter",
    "--disable-telemetry",
    "--use-inmemory-secretstorage",
    "--password-store=basic",
    "--skip-add-to-recently-opened"
  ];
  const common = {
    editor: {
      name: "VS Code",
      key: "vscode",
      executable: "/editor/code",
      cli: "/editor/bin/code"
    },
    userData: "/private/user",
    extensions: "/private/extensions",
    sandboxArgs: headlessSandboxArgs,
    environment: { HOME: "/private/home" },
    label: "exact comparison install"
  };
  const runCli = async (...arguments_) => {
    calls.push(arguments_);
    return { stdout: "", stderr: "" };
  };

  await installComparisonExtension(
    {
      ...common,
      target: DATA_WRANGLER_MARKETPLACE_EXTENSION,
      kind: "marketplace"
    },
    { runCli }
  );
  assert.deepEqual(calls[0][0].args, [
    "--user-data-dir",
    "/private/user",
    "--extensions-dir",
    "/private/extensions",
    "--install-extension",
    "ms-toolsai.datawrangler@1.24.2",
    "--force",
    ...headlessSandboxArgs
  ]);
  assert.deepEqual(calls[0][1], { timeoutMs: 180_000 });

  const candidate = "/private/openwrangler.vsix";
  await installComparisonExtension(
    {
      ...common,
      target: candidate,
      kind: "owned-vsix",
      allowedPrivateVsixPaths: [candidate]
    },
    { runCli }
  );
  assert.equal(calls[1][0].args[calls[1][0].args.indexOf("--install-extension") + 1], candidate);

  for (const target of [
    "ms-toolsai.datawrangler",
    "ms-toolsai.datawrangler@1.25.0",
    "MS-TOOLSAI.DATAWRANGLER@1.24.2",
    "https://example.test/datawrangler.vsix",
    "/private/datawrangler.vsix"
  ]) {
    await assert.rejects(
      installComparisonExtension(
        {
          ...common,
          target,
          kind: target.startsWith("ms-") ? "marketplace" : "owned-vsix",
          allowedPrivateVsixPaths: [target]
        },
        { runCli }
      ),
      /exact pinned extension IDs|Open Wrangler candidate/u
    );
  }
  assert.equal(calls.length, 2);
});

test("product-fragment normalization keeps outer provenance authoritative without claiming a backend", () => {
  const openEvidence = normalizeComparisonProductEvidence({
    fragment: productFragment("open-wrangler", OPEN_WRANGLER_RUN_ID),
    expectedRunId: OPEN_WRANGLER_RUN_ID,
    productKey: "open-wrangler",
    editorVersion: "1.130.0",
    installedExtensions: installedInventory("open-wrangler"),
    candidateSha256: digest("a"),
    configuredPythonProcessObservedDuringProductRun: true
  });
  const openPhases = openEvidence.phases;
  assert.equal(openPhases.length, 2);
  assert.deepEqual(openEvidence.configuredPythonEnvironment, comparisonConfiguredPythonEnvironment());
  assert.deepEqual(
    openPhases.map((phase) => phase.fixture.format),
    ["csv", "parquet"]
  );
  assert.deepEqual(openPhases[0].product, {
    key: "open-wrangler",
    id: "Matt17BR.openwrangler",
    version: "1.0.0",
    installation: "candidate-vsix",
    candidateSha256: digest("a")
  });
  assert.deepEqual(openPhases[0].editor, {
    id: "microsoft.vscode",
    version: "1.130.0",
    officialDistribution: true,
    displayMode: "headless"
  });
  assert.equal(openPhases[0].proofs.cleanupVerified, true);

  const dataEvidence = normalizeComparisonProductEvidence({
    fragment: productFragment("data-wrangler", DATA_WRANGLER_RUN_ID),
    expectedRunId: DATA_WRANGLER_RUN_ID,
    productKey: "data-wrangler",
    editorVersion: "1.130.0",
    installedExtensions: installedInventory("data-wrangler"),
    candidateSha256: digest("f"),
    configuredPythonProcessObservedDuringProductRun: true
  });
  const dataPhases = dataEvidence.phases;
  assert.equal(dataPhases[0].product.candidateSha256, null);
  assert.equal(dataPhases[0].product.version, "1.24.2");

  const fragment = productFragment("open-wrangler", OPEN_WRANGLER_RUN_ID);
  const invalid = [
    [{ ...fragment, runId: DATA_WRANGLER_RUN_ID }, /mis-correlated/u],
    [{ ...fragment, phase: "comparison-data-wrangler" }, /mis-correlated/u],
    [{ ...fragment, editor: { id: "microsoft.vscode" } }, /unknown fields/u],
    [
      {
        ...fragment,
        samples: [fragment.samples[0], { ...fragment.samples[1], fixture: fragment.samples[0].fixture }]
      },
      /unique CSV and Parquet/u
    ],
    [
      {
        ...fragment,
        samples: [
          {
            ...fragment.samples[0],
            proofs: {
              ...fragment.samples[0].proofs,
              cleanupVerified: true
            }
          },
          fragment.samples[1]
        ]
      },
      /unknown fields/u
    ],
    [
      {
        ...fragment,
        samples: [
          { ...fragment.samples[0], configuredPythonEnvironment: fragment.configuredPythonEnvironment },
          fragment.samples[1]
        ]
      },
      /unknown fields/u
    ]
  ];
  for (const [value, expected] of invalid) {
    assert.throws(
      () =>
        normalizeComparisonProductEvidence({
          fragment: value,
          expectedRunId: OPEN_WRANGLER_RUN_ID,
          productKey: "open-wrangler",
          editorVersion: "1.130.0",
          installedExtensions: installedInventory("open-wrangler"),
          candidateSha256: digest("a"),
          configuredPythonProcessObservedDuringProductRun: true
        }),
      expected
    );
  }
  assert.throws(
    () =>
      normalizeComparisonProductEvidence({
        fragment,
        expectedRunId: OPEN_WRANGLER_RUN_ID,
        productKey: "open-wrangler",
        editorVersion: "1.130.0",
        installedExtensions: installedInventory("open-wrangler"),
        candidateSha256: digest("a"),
        configuredPythonProcessObservedDuringProductRun: false
      }),
    /outer owned-process Python observation/u
  );
});

test("official VS Code version probe accepts one bounded numeric version only", async () => {
  const calls = [];
  const input = {
    editor: { name: "VS Code" },
    userData: "/private/user",
    extensions: "/private/extensions",
    sandboxArgs: ["--no-sandbox"],
    environment: { HOME: "/private/home" }
  };
  assert.equal(
    await readOfficialVSCodeVersion({
      ...input,
      runCli: async (...arguments_) => {
        calls.push(arguments_);
        return { stdout: "1.130.0\ncommit\nx64\n", stderr: "" };
      }
    }),
    "1.130.0"
  );
  assert.deepEqual(calls[0][0].args, [
    "--user-data-dir",
    "/private/user",
    "--extensions-dir",
    "/private/extensions",
    "--version",
    "--no-sandbox"
  ]);
  await assert.rejects(
    readOfficialVSCodeVersion({
      ...input,
      runCli: async () => ({ stdout: "stable\n", stderr: "" })
    }),
    /exactly one numeric/u
  );
});

test("candidate and Python inputs are pinned as no-follow, single-link regular files", async () => {
  await withRunnerFixture(async ({ options, directory }) => {
    const candidate = captureComparisonInputFile(options.candidate, {
      label: "Open Wrangler candidate"
    });
    const python = captureComparisonInputFile(options.python, {
      label: "Comparison Python interpreter",
      executable: true
    });
    assert.equal(revalidateComparisonInputFile(candidate), candidate);
    assert.equal(revalidateComparisonInputFile(python), python);
    assert.throws(() => revalidateComparisonInputFile({ ...candidate }), /authentic captured receipt/u);

    const symbolic = resolve(directory, "candidate-link.vsix");
    symlinkSync(options.candidate, symbolic);
    assert.throws(
      () =>
        captureComparisonInputFile(symbolic, {
          label: "Symbolic candidate"
        }),
      /single-link|symbolic link/u
    );

    const hardLink = resolve(directory, "candidate-hard-link.vsix");
    linkSync(options.candidate, hardLink);
    assert.throws(
      () =>
        captureComparisonInputFile(options.candidate, {
          label: "Hard-linked candidate"
        }),
      /single-link/u
    );

    const nonExecutable = resolve(directory, "not-executable-python");
    writeFileSync(nonExecutable, "python", { mode: 0o600 });
    assert.throws(
      () =>
        captureComparisonInputFile(nonExecutable, {
          label: "Non-executable Python",
          executable: true
        }),
      /regular executable/u
    );
  });
});

test("owned-process Python observation is product-specific and phase-authoritative", async () => {
  assert.equal(
    comparisonPythonCommandShape(
      ["/private/python", "-m", "ipykernel_launcher", "--f=/private/connection-secret.json"],
      { argv0Exact: true }
    ),
    "argv0=exact argc=3 -m ipykernel_launcher --f=<path>"
  );
  assert.equal(
    comparisonPythonCommandShape(["/private/python-alias", "--private-token", "sensitive-value"], {
      argv0Exact: false
    }),
    "argv0=alias argc=2 <flag> <arg>"
  );
  assert.equal(comparisonPythonCommandShape([], { argv0Exact: false }), "argv0=absent argc=0");
  assert.equal(
    comparisonPythonCommandMatches("open-wrangler", ["/python", "-s", "-m", "openwrangler_runtime.server"]),
    true
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", ["/python", "-m", "ipykernel_launcher", "-f", "connection.json"]),
    true
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", [
      "/python",
      "-I",
      "-Xfrozen_modules=off",
      "-m",
      "ipykernel_launcher",
      "-f",
      "connection.json"
    ]),
    true
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", [
      "/python",
      "-I",
      "-Xfrozen_modules=off",
      "-m",
      "ipykernel_launcher",
      "--f=/private/connection.json"
    ]),
    true
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", ["/python", "-m", "ipykernel_launcher", "--f", "connection.json"]),
    true
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", ["/python", "-m", "openwrangler_runtime.server"]),
    false
  );
  assert.equal(
    comparisonPythonCommandMatches("open-wrangler", [
      "/python",
      "-c",
      "print('not the runtime')",
      "-m",
      "openwrangler_runtime.server"
    ]),
    false
  );
  assert.equal(
    comparisonPythonCommandMatches("open-wrangler", ["/python", "unrelated.py", "-m", "openwrangler_runtime.server"]),
    false
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", [
      "/python",
      "-c",
      "print('not a kernel')",
      "-m",
      "ipykernel_launcher",
      "-f",
      "connection.json"
    ]),
    false
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", [
      "/python",
      "-I",
      "-m",
      "ipykernel_launcher",
      "--f=/private/connection.json",
      "unexpected"
    ]),
    false
  );
  assert.equal(
    comparisonPythonCommandMatches("data-wrangler", [
      "/python",
      "unrelated.py",
      "-m",
      "ipykernel_launcher",
      "-f",
      "connection.json"
    ]),
    false
  );

  await withRunnerFixture(async ({ options }) => {
    const pythonReceipt = captureComparisonInputFile(options.python, {
      label: "Comparison Python interpreter",
      executable: true
    });
    const events = [];
    const child = { pid: 8123 };
    const receipt = {
      protocol: "openwrangler-editor-acceptance-artifact-receipt-v1",
      bytes: 1,
      sha256: digest("e")
    };
    const result = await runComparisonObservedEditorPhase(
      {
        productKey: "data-wrangler",
        pythonReceipt,
        observer: {
          begin(pid) {
            events.push(["begin", pid]);
          },
          end() {
            events.push(["end"]);
            return true;
          }
        },
        async runPhase(spawnProcess) {
          assert.equal(spawnProcess("editor", [], {}), child);
          events.push(["phase-clean"]);
          return receipt;
        }
      },
      {
        spawnOwned() {
          events.push(["spawn"]);
          return child;
        }
      }
    );
    assert.deepEqual(result, {
      receipt,
      configuredPythonProcessObservedDuringProductRun: true
    });
    assert.deepEqual(events, [["spawn"], ["begin", 8123], ["phase-clean"], ["end"]]);

    await assert.rejects(
      runComparisonObservedEditorPhase(
        {
          productKey: "data-wrangler",
          pythonReceipt,
          observer: {
            begin() {},
            end() {
              return false;
            }
          },
          async runPhase(spawnProcess) {
            spawnProcess("editor", [], {});
            return receipt;
          }
        },
        { spawnOwned: () => child }
      ),
      /did not execute the exact configured Python/u
    );
  });
});

test("installed-extension inventory is revalidated after the diagnostic phase", async () => {
  const expected = installedInventory("open-wrangler");
  const drifted = [...expected, "vendor.unexpected@1.0.0"].sort();
  let reads = 0;
  let phases = 0;
  await assert.rejects(
    runComparisonInventoryGuard({
      readInventory: async () => {
        reads += 1;
        return reads === 1 ? expected : drifted;
      },
      runPhase: async () => {
        phases += 1;
        return { receipt: "private" };
      }
    }),
    /inventory changed during the diagnostic editor phase/u
  );
  assert.equal(reads, 2);
  assert.equal(phases, 1);

  const result = await runComparisonInventoryGuard({
    readInventory: async () => expected,
    runPhase: async () => ({ receipt: "verified" })
  });
  assert.equal(result.installedExtensions, expected);
  assert.deepEqual(result.phaseResult, { receipt: "verified" });
});

test("Python observer retains only a boolean after seeing the exact signature", async () => {
  await withRunnerFixture(async ({ options }) => {
    const pythonReceipt = captureComparisonInputFile(options.python, {
      label: "Comparison Python interpreter",
      executable: true
    });
    let tick;
    let inspections = 0;
    const observer = createComparisonPythonProcessObserver({
      productKey: "open-wrangler",
      pythonReceipt,
      inspect(processGroupId, input) {
        assert.equal(processGroupId, 991);
        assert.equal(input.productKey, "open-wrangler");
        assert.equal(input.pythonReceipt, pythonReceipt);
        inspections += 1;
        return inspections === 2;
      },
      setTimer(callback) {
        tick = callback;
        return { unref() {} };
      },
      clearTimer() {}
    });
    observer.begin(991);
    tick();
    assert.equal(observer.end(), true);
    assert.equal(inspections, 2);
  });
});

test("Python observer reports only bounded safe command shapes when matching fails", async () => {
  await withRunnerFixture(async ({ options }) => {
    const pythonReceipt = captureComparisonInputFile(options.python, {
      label: "Comparison Python interpreter",
      executable: true
    });
    let tick;
    const observer = createComparisonPythonProcessObserver({
      productKey: "data-wrangler",
      pythonReceipt,
      inspect(_processGroupId, input) {
        input.recordCandidateShape(
          comparisonPythonCommandShape([options.python, "--secret-token", "/private/connection-secret.json"], {
            argv0Exact: true
          })
        );
        return false;
      },
      setTimer(callback) {
        tick = callback;
        return { unref() {} };
      },
      clearTimer() {}
    });
    observer.begin(992);
    tick();
    assert.throws(
      () => observer.end(),
      (error) =>
        /Safe command shapes: argv0=exact argc=2 <flag> <arg>/u.test(error.message) &&
        !error.message.includes("secret-token") &&
        !error.message.includes("connection-secret") &&
        !error.message.includes(options.python)
    );
  });
});

test("procfs observation requires matching group, executable, and product signature", async () => {
  await withRunnerFixture(async ({ options, directory }) => {
    const pythonReceipt = captureComparisonInputFile(options.python, {
      label: "Comparison Python interpreter",
      executable: true
    });
    const procRoot = resolve(directory, "proc");
    const processRoot = resolve(procRoot, "321");
    mkdirSync(processRoot, { recursive: true, mode: 0o700 });
    const fields = Array.from({ length: 22 }, () => "0");
    fields[0] = "S";
    fields[1] = "1";
    fields[2] = "777";
    fields[19] = "12345";
    writeFileSync(resolve(processRoot, "stat"), `321 (python worker) ${fields.join(" ")}\n`);
    writeFileSync(resolve(processRoot, "cmdline"), `${options.python}\0-m\0ipykernel_launcher\0-f\0connection.json\0`);
    symlinkSync(options.python, resolve(processRoot, "exe"));

    assert.equal(
      observeComparisonPythonProcessGroup(777, {
        productKey: "data-wrangler",
        pythonReceipt,
        procRoot
      }),
      true
    );
    assert.equal(
      observeComparisonPythonProcessGroup(778, {
        productKey: "data-wrangler",
        pythonReceipt,
        procRoot
      }),
      false
    );
    assert.equal(
      observeComparisonPythonProcessGroup(777, {
        productKey: "open-wrangler",
        pythonReceipt,
        procRoot
      }),
      false
    );

    writeFileSync(resolve(processRoot, "cmdline"), `${options.python}\0-m\0unknown_private_module\0--token\0secret\0`);
    const shapes = [];
    assert.equal(
      observeComparisonPythonProcessGroup(777, {
        productKey: "data-wrangler",
        pythonReceipt,
        procRoot,
        recordCandidateShape(shape) {
          shapes.push(shape);
        }
      }),
      false
    );
    assert.deepEqual(shapes, ["argv0=exact argc=4 -m <arg> <flag> <arg>"]);
  });
});

test("orchestrator runs two product processes, cleans before publishing, and never mutates caller environment", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const callerEnvironment = {
      OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS: "/private/capture",
      OPEN_WRANGLER_EDITOR_DISPLAY: "current",
      DISPLAY: ":desktop",
      WAYLAND_DISPLAY: "wayland-0",
      VSCODE_IPC_HOOK_CLI: "/desktop/vscode.sock",
      CURSOR_IPC_HOOK_CLI: "/desktop/cursor.sock"
    };
    let written;
    const dependencies = successfulDependencies({
      privateRoot,
      events,
      writeReport(output, report) {
        events.push("write");
        written = { output, report };
      }
    });

    const report = await runDataWranglerComparison(options, callerEnvironment, dependencies);
    assert.equal(report.feasibilityOnly, true);
    assert.equal(report.publishable, false);
    assert.deepEqual(
      report.phases.map((phase) => `${phase.product.key}:${phase.fixture.format}`),
      ["open-wrangler:csv", "open-wrangler:parquet", "data-wrangler:csv", "data-wrangler:parquet"]
    );
    assert.deepEqual(events, [
      "build",
      "stage",
      "fixtures",
      "harness",
      "acquire-vscode",
      "start-display",
      "product:open-wrangler",
      "product:data-wrangler",
      "revalidate-candidate",
      "stop-display:false",
      "remove-root",
      "write"
    ]);
    assert.equal(written.output, options.output);
    assert.equal(written.report, report);
    assert.deepEqual(callerEnvironment, {
      OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS: "/private/capture",
      OPEN_WRANGLER_EDITOR_DISPLAY: "current",
      DISPLAY: ":desktop",
      WAYLAND_DISPLAY: "wayland-0",
      VSCODE_IPC_HOOK_CLI: "/desktop/vscode.sock",
      CURSOR_IPC_HOOK_CLI: "/desktop/cursor.sock"
    });
    assert.equal(dependencies.observedEnvironment.OPEN_WRANGLER_EDITOR_DISPLAY, "headless");
    assert.equal(Object.hasOwn(dependencies.observedEnvironment, "OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS"), false);
    assert.equal(dependencies.productInputs.length, 2);
    assert.equal(dependencies.productInputs[0].editorVersion, undefined);
    assert.equal(dependencies.productInputs[1].editorVersion, "1.130.0");
    assert.equal(dependencies.productInputs[0].editor, dependencies.productInputs[1].editor);
    assert.equal(dependencies.productEnvironmentSnapshots.length, 2);
    for (const environment of dependencies.productEnvironmentSnapshots) {
      assert.equal(environment.OPEN_WRANGLER_EDITOR_DISPLAY, "headless");
      for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "VSCODE_IPC_HOOK_CLI", "CURSOR_IPC_HOOK_CLI"]) {
        assert.equal(Object.hasOwn(environment, key), false);
      }
    }
  });
});

test("fixture execution requires a just-in-time Python input revalidation", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const dependencies = successfulDependencies({ privateRoot, events });
    dependencies.revalidateInput = (receipt) => {
      if (receipt.path === options.python) {
        events.push("revalidate-python-before-fixtures");
        throw new Error("Comparison Python interpreter changed after the build.");
      }
    };
    await assert.rejects(
      runDataWranglerComparison(options, {}, dependencies),
      /Comparison Python interpreter changed after the build/u
    );
    assert.deepEqual(events.slice(0, 3), ["build", "stage", "revalidate-python-before-fixtures"]);
    assert.equal(events.includes("fixtures"), false);
    assert.equal(events.includes("write"), false);
  });
});

test("configured Python environment drift between fixed product runs prevents publication", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const dependencies = successfulDependencies({ privateRoot, events });
    const runProduct = dependencies.runProduct;
    dependencies.runProduct = async (input) => {
      const run = await runProduct(input);
      return input.productKey === "data-wrangler"
        ? {
            ...run,
            configuredPythonEnvironment: {
              ...run.configuredPythonEnvironment,
              installedPandasVersion: "2.4.0"
            }
          }
        : run;
    };
    await assert.rejects(
      runDataWranglerComparison(options, {}, dependencies),
      /configured Python environment changed/u
    );
    assert.ok(events.includes("remove-root"));
    assert.equal(events.includes("write"), false);
  });
});

test("phase and headless-isolation failures have no retry and never publish", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const dependencies = successfulDependencies({ privateRoot, events });
    dependencies.runProduct = async ({ productKey }) => {
      events.push(`product:${productKey}`);
      throw new Error("phase failed");
    };
    await assert.rejects(runDataWranglerComparison(options, {}, dependencies), /phase failed/u);
    assert.equal(events.filter((entry) => entry.startsWith("product:")).length, 1);
    assert.ok(events.includes("stop-display:false"));
    assert.ok(events.includes("remove-root"));
    assert.equal(events.includes("write"), false);
  });

  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const dependencies = successfulDependencies({ privateRoot, events });
    const startDisplay = dependencies.startDisplay;
    dependencies.startDisplay = async (input) => {
      const display = await startDisplay(input);
      return {
        ...display,
        async stop({ preservePrivateFiles }) {
          events.push(`stop-display:${String(preservePrivateFiles)}`);
          throw new Error("headless isolation cleanup failed");
        }
      };
    };
    await assert.rejects(runDataWranglerComparison(options, {}, dependencies), /headless isolation cleanup failed/u);
    assert.ok(events.includes("remove-root"));
    assert.equal(events.includes("write"), false);
  });

  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const dependencies = successfulDependencies({ privateRoot, events });
    dependencies.startDisplay = async () => {
      events.push("start-display");
      throw new Error("headless isolation failed");
    };
    await assert.rejects(runDataWranglerComparison(options, {}, dependencies), /headless isolation failed/u);
    assert.equal(
      events.some((entry) => entry.startsWith("product:")),
      false
    );
    assert.ok(events.includes("remove-root"));
    assert.equal(events.includes("write"), false);
  });
});

test("process-tree uncertainty withholds all private-root reads and publication", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const uncertain = new Error("owned editor tree uncertain");
    const dependencies = successfulDependencies({ privateRoot, events });
    dependencies.runProduct = async ({ productKey }) => {
      events.push(`product:${productKey}`);
      throw uncertain;
    };
    dependencies.processTreeMayBeLive = (error) => error === uncertain;
    await assert.rejects(runDataWranglerComparison(options, {}, dependencies), /owned editor tree uncertain/u);
    assert.ok(events.includes("stop-display:true"));
    assert.equal(events.includes("remove-root"), false);
    assert.equal(events.includes("revalidate-candidate"), false);
    assert.equal(events.includes("write"), false);
  });
});

test("cleanup failure is release-authoritative and prevents report publication", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const dependencies = successfulDependencies({ privateRoot, events });
    dependencies.removePrivateRoot = () => {
      events.push("remove-root");
      throw new Error("root identity changed");
    };
    await assert.rejects(runDataWranglerComparison(options, {}, dependencies), /root identity changed/u);
    assert.ok(events.includes("stop-display:false"));
    assert.equal(events.includes("write"), false);
  });
});

test("a late output alias created after owned cleanup prevents the final report write", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    const events = [];
    const dependencies = successfulDependencies({ privateRoot, events });
    dependencies.removePrivateRoot = () => {
      events.push("remove-root");
      symlinkSync(options.python, options.output);
    };
    await assert.rejects(runDataWranglerComparison(options, {}, dependencies), /configured Python interpreter/u);
    assert.ok(events.includes("remove-root"));
    assert.equal(events.includes("write"), false);
  });
});

test("comparison report publication is exclusive descriptor-bound no-clobber", async () => {
  await withRunnerFixture(async ({ directory }) => {
    const destination = resolve(directory, "published", "report.json");
    const report = { protocol: "comparison-no-clobber-test", feasible: true };
    writeDataWranglerComparisonReport(destination, report);
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), report);

    assert.throws(
      () => writeDataWranglerComparisonReport(destination, { protocol: "replacement" }),
      /must be absent; existing files are never replaced/u
    );
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), report);
  });
});

test("exclusive publication rejects output-ancestor rebinding at the open boundary", async () => {
  await withRunnerFixture(async ({ options, directory }) => {
    const protectedSnapshots = captureProtectedSnapshots(options);

    for (const [index, protectedPath] of [options.candidate, options.python].entries()) {
      const outputParent = resolve(directory, `pre-open-output-${index}`);
      const retiredOutputParent = resolve(directory, `pre-open-retired-${index}`);
      mkdirSync(outputParent, { mode: 0o700 });
      const destination = resolve(outputParent, basename(protectedPath));
      let boundaryReached = false;
      assert.throws(
        () =>
          writeDataWranglerComparisonReport(
            destination,
            { protocol: "pre-open-ancestor-rebinding-test" },
            {
              beforeExclusiveOpen(target) {
                boundaryReached = true;
                assert.equal(target, destination);
                renameSync(outputParent, retiredOutputParent);
                symlinkSync(directory, outputParent, "dir");
              }
            }
          ),
        (error) => {
          assert.match(error.message, /must remain absent at its exclusive-open boundary/u);
          assert.equal(error.cause?.code, "EEXIST");
          return true;
        }
      );
      assert.equal(boundaryReached, true);
      assertProtectedSnapshots(protectedSnapshots);
    }
  });
});

test("post-write ancestor rebinding retains the report inode and never cleans a protected path", async () => {
  await withRunnerFixture(async ({ options, directory }) => {
    const protectedSnapshots = captureProtectedSnapshots(options);

    for (const [index, protectedPath] of [options.candidate, options.python].entries()) {
      const outputParent = resolve(directory, `post-write-output-${index}`);
      const retiredOutputParent = resolve(directory, `post-write-retired-${index}`);
      mkdirSync(outputParent, { mode: 0o700 });
      const destination = resolve(outputParent, basename(protectedPath));
      const report = { protocol: "post-write-ancestor-rebinding-test", index };
      let boundaryReached = false;
      assert.throws(
        () =>
          writeDataWranglerComparisonReport(destination, report, {
            beforePathValidation(target) {
              boundaryReached = true;
              assert.equal(target, destination);
              renameSync(outputParent, retiredOutputParent);
              symlinkSync(directory, outputParent, "dir");
            }
          }),
        /destination path changed during publication/u
      );
      assert.equal(boundaryReached, true);
      assertProtectedSnapshots(protectedSnapshots);
      assert.deepEqual(JSON.parse(readFileSync(resolve(retiredOutputParent, basename(protectedPath)), "utf8")), report);
    }
  });
});

test("post-open pathname substitution cannot redirect descriptor writes or trigger pathname cleanup", async () => {
  await withRunnerFixture(async ({ options, directory }) => {
    const protectedSnapshots = captureProtectedSnapshots(options);
    const outputParent = resolve(directory, "post-open-output");
    mkdirSync(outputParent, { mode: 0o700 });
    const destination = resolve(outputParent, "report.json");
    const retainedDestination = resolve(outputParent, "retained-report.json");
    const report = { protocol: "post-open-pathname-substitution-test" };
    let boundaryReached = false;
    assert.throws(
      () =>
        writeDataWranglerComparisonReport(destination, report, {
          afterExclusiveOpen(target) {
            boundaryReached = true;
            assert.equal(target, destination);
            renameSync(target, retainedDestination);
            writeFileSync(target, "attacker-owned", { flag: "wx", mode: 0o600 });
          }
        }),
      /destination path changed during publication/u
    );
    assert.equal(boundaryReached, true);
    assert.equal(readFileSync(destination, "utf8"), "attacker-owned");
    assert.deepEqual(JSON.parse(readFileSync(retainedDestination, "utf8")), report);
    assertProtectedSnapshots(protectedSnapshots);
  });
});

function captureProtectedSnapshots(options) {
  return new Map(
    [options.candidate, options.python].map((file) => [
      file,
      {
        bytes: readFileSync(file),
        identity: lstatSync(file, { bigint: true })
      }
    ])
  );
}

function assertProtectedSnapshots(snapshots) {
  for (const [file, snapshot] of snapshots) {
    assert.deepEqual(readFileSync(file), snapshot.bytes);
    const current = lstatSync(file, { bigint: true });
    for (const key of ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(current[key], snapshot.identity[key], `${basename(file)} changed at ${key}`);
    }
  }
}

test("comparison execution rejects non-official platforms before creating an editor root", async () => {
  await withRunnerFixture(async ({ options, privateRoot }) => {
    for (const [platform, architecture] of [
      ["darwin", "x64"],
      ["linux", "arm64"]
    ]) {
      let created = false;
      const dependencies = successfulDependencies({
        privateRoot,
        events: []
      });
      dependencies.platform = platform;
      dependencies.architecture = architecture;
      dependencies.mkdtemp = () => {
        created = true;
        return privateRoot;
      };
      await assert.rejects(runDataWranglerComparison(options, {}, dependencies), /only Linux x64/u);
      assert.equal(created, false);
    }
  });
});

function successfulDependencies({ privateRoot, events, writeReport }) {
  const productInputs = [];
  const productEnvironmentSnapshots = [];
  const state = { observedEnvironment: undefined };
  const dependencies = {
    platform: "linux",
    architecture: "x64",
    exists: () => true,
    mkdir: () => undefined,
    mkdtemp: () => privateRoot,
    createPrivateRootReceipt: () => ({ privateRoot }),
    configureTempRoot(_privateRoot, environment) {
      state.observedEnvironment = environment;
      environment.HOME = join(privateRoot, "home");
    },
    validatePrivatePathOverrides: () => undefined,
    captureInputs: (options) => ({
      candidate: { path: options.candidate },
      python: { path: options.python }
    }),
    revalidateInput: () => undefined,
    buildTestRuntime: () => events.push("build"),
    stageCandidate: () => {
      events.push("stage");
      return {
        path: join(privateRoot, "openwrangler.vsix"),
        sha256: digest("a"),
        bytes: 1,
        fileIdentity: {
          dev: 1n,
          ino: 2n,
          size: 1n,
          mtimeNs: 3n,
          ctimeNs: 4n
        }
      };
    },
    revalidateCandidate: () => events.push("revalidate-candidate"),
    generateFixtures: () => {
      events.push("fixtures");
      return fixtureManifest();
    },
    createHarness: async () => {
      events.push("harness");
      return join(privateRoot, "harness");
    },
    acquireVscode: async () => {
      events.push("acquire-vscode");
      return {
        editor: {
          name: "VS Code",
          key: "vscode",
          executable: "/official-vscode/code",
          cli: "/official-vscode/bin/code",
          sharedDataDir: true
        }
      };
    },
    startDisplay: async ({ environment }) => {
      events.push("start-display");
      assert.equal(environment.OPEN_WRANGLER_EDITOR_DISPLAY, "headless");
      const isolatedKeys = ["DISPLAY", "WAYLAND_DISPLAY", "VSCODE_IPC_HOOK_CLI", "CURSOR_IPC_HOOK_CLI"];
      const previous = new Map();
      for (const key of isolatedKeys) {
        previous.set(key, {
          existed: Object.hasOwn(environment, key),
          value: environment[key]
        });
        delete environment[key];
      }
      return {
        isolated: true,
        mode: "headless",
        async stop({ preservePrivateFiles }) {
          events.push(`stop-display:${String(preservePrivateFiles)}`);
          for (const [key, value] of previous) {
            if (value.existed) {
              environment[key] = value.value;
            } else {
              delete environment[key];
            }
          }
        }
      };
    },
    async runProduct(input) {
      productInputs.push(input);
      productEnvironmentSnapshots.push({ ...input.environment });
      events.push(`product:${input.productKey}`);
      const runId = input.productKey === "open-wrangler" ? OPEN_WRANGLER_RUN_ID : DATA_WRANGLER_RUN_ID;
      const evidence = normalizeComparisonProductEvidence({
        fragment: productFragment(input.productKey, runId),
        expectedRunId: runId,
        productKey: input.productKey,
        editorVersion: "1.130.0",
        installedExtensions: installedInventory(input.productKey),
        candidateSha256: digest("a"),
        configuredPythonProcessObservedDuringProductRun: true
      });
      return {
        editorVersion: "1.130.0",
        ...evidence
      };
    },
    processTreeMayBeLive: () => false,
    removePrivateRoot: () => events.push("remove-root"),
    sanitize: (error) => error.message,
    writeReport:
      writeReport ??
      (() => {
        events.push("write");
      }),
    now: () => new Date("2026-07-28T00:00:00.000Z")
  };
  Object.defineProperties(dependencies, {
    productInputs: {
      enumerable: false,
      get: () => productInputs
    },
    productEnvironmentSnapshots: {
      enumerable: false,
      get: () => productEnvironmentSnapshots
    },
    observedEnvironment: {
      enumerable: false,
      get: () => state.observedEnvironment
    }
  });
  return dependencies;
}

function productFragment(productKey, runId) {
  return {
    protocol: COMPARISON_PRODUCT_FRAGMENT_PROTOCOL,
    runId,
    phase: COMPARISON_TEST_PHASES[productKey],
    productKey,
    configuredPythonEnvironment: comparisonConfiguredPythonEnvironment(),
    samples: [comparisonSample("csv"), comparisonSample("parquet")]
  };
}

function comparisonConfiguredPythonEnvironment() {
  return {
    pythonVersion: "3.12.12",
    pythonImplementation: "CPython",
    pythonExecutableSha256: digest("b"),
    installedPandasVersion: "2.3.3",
    installedPyarrowVersion: "22.0.0",
    installedJupyterCoreVersion: "5.9.1",
    installedIpykernelVersion: "7.1.0"
  };
}

function comparisonSample(format) {
  const entry = fixtureManifest().fixtures[format];
  return {
    fixture: {
      format,
      rows: entry.rows,
      columns: entry.columns,
      bytes: entry.bytes,
      sha256: entry.sha256
    },
    diagnostic: {
      boundary: DATA_WRANGLER_COMPARISON_BOUNDARY,
      warmupCompleted: true,
      diagnosticDurationMs: format === "csv" ? 750.25 : 1_250.5,
      cacheProof: {
        protocol: "openwrangler-source-cache-proof-v1",
        requestedState: "resident",
        fdatasyncApplied: true,
        adviceAccepted: false,
        verification: "linux-mincore",
        pageSizeBytes: 4_096,
        totalPages: 10,
        residentPagesBefore: 3,
        residentPagesAfter: 10,
        identityStable: true,
        verified: true
      },
      readiness: {
        grid: {
          rootRole: "grid",
          busy: "false",
          visible: true,
          pointerUsable: true,
          geometryStableFrames: 2,
          headers: ["c00", "c01"],
          sentinelsMatched: true,
          ariaRowCount: entry.rows + 1,
          ariaColumnCount: entry.columns + 1
        },
        workbench: {
          targetEditorSelected: true,
          noVisibleQuickInput: true,
          noVisibleDialog: true,
          noVisibleModal: true,
          rendererFramePointerUsable: true
        }
      }
    },
    proofs: {
      telemetryDisabled: true,
      sourceIdentityStable: true,
      sourceUnchanged: true
    }
  };
}

function installedInventory(productKey) {
  return [
    ...COMPARISON_COMMON_EXTENSION_LOCK,
    productKey === "open-wrangler" ? "matt17br.openwrangler@1.0.0" : DATA_WRANGLER_MARKETPLACE_EXTENSION
  ].sort();
}

function fixtureManifest() {
  return {
    protocol: "openwrangler-installed-performance-fixtures-v1",
    smoke: true,
    generator: {
      contractVersion: 1,
      implementation: "polars",
      implementationVersion: "1.34.0"
    },
    license: "CC0-1.0",
    redistribution: "Deterministic synthetic integer fixtures generated by Open Wrangler.",
    fixtures: {
      csv: fixture("csv", 2_000, 8, "c"),
      parquet: fixture("parquet", 5_000, 8, "d")
    }
  };
}

function fixture(format, rows, columns, digestValue) {
  return {
    fileName: `${rows}-${columns}.${format}`,
    format,
    rows,
    columns,
    columnType: "Int64",
    columnNamePattern: "c followed by a zero-padded zero-based integer",
    sentinelRows: [0, Math.floor(rows / 2), rows - 1],
    sha256: digest(digestValue),
    bytes: format === "csv" ? 100_000 : 50_000
  };
}

async function withRunnerFixture(callback) {
  const directory = mkdtempSync(join(tmpdir(), "ow-comparison-runner-"));
  const privateRoot = resolve(directory, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  const candidate = resolve(directory, "candidate.vsix");
  const python = resolve(directory, "python");
  writeFileSync(candidate, "candidate", { mode: 0o600 });
  writeFileSync(python, "#!/bin/sh\n", { mode: 0o700 });
  try {
    return await callback({
      directory,
      privateRoot,
      options: {
        candidate,
        python,
        output: resolve(directory, "result.json")
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
