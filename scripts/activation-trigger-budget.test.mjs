import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";
import {
  activationEventClassifications,
  activationBudgetFailures,
  activationTriggerContract,
  activationTriggerBudgets,
  dynamicEdgeClassifications,
  maximumDependencyFreeActivationMs,
  measureDependencyFreeActivation,
  measureActivationInventory,
  measureActivationTriggers,
  measureTransitiveRuntimeSources
} from "./activation-trigger-budget.mjs";

const execFileAsync = promisify(execFile);

test("production activation trigger classes stay within their closed runtime-source budgets", async () => {
  const report = await measureActivationTriggers();

  assert.deepEqual(activationBudgetFailures(report), []);
  assert.equal(report.elapsedActivation.maximumMs, maximumDependencyFreeActivationMs);
  assert.equal(report.elapsedActivation.withinBudget, true);
  assert.equal(report.elapsedActivation.elapsedMs <= maximumDependencyFreeActivationMs, true);
  assert.equal(report.measurements.unrelated.modules <= 3, true);
  assert.equal(report.measurements.unrelated.files.includes("src/extension/lazyActivationOwners.ts"), true);
  assert.equal(report.measurements.runtime.files.includes("src/extension/pythonBridge.ts"), true);
  assert.equal(
    report.measurements["trusted-pickle"].files.includes("src/extension/files/trustedPickleWorker.ts"),
    true
  );
  assert.equal(report.measurements.r.files.includes("src/extension/r/rInteractiveCommands.ts"), true);
  assert.equal(report.measurements["r-document"].files.includes("src/extension/r/rDocumentCommands.ts"), true);
  assert.equal(
    report.measurements.notebook.files.includes("src/extension/notebooks/pythonInteractiveCommands.ts"),
    true
  );
  assert.equal(report.measurements["custom-editor"].files.includes("src/extension/files/fileOpen.ts"), true);
  assert.equal(report.measurements["native-view"].files.includes("src/extension/nativeViews.ts"), true);
  assert.equal(
    report.measurements["native-view"].files.includes("src/extension/notebooks/pythonInteractiveCommands.ts"),
    false
  );
  assert.equal(report.measurements["native-view"].files.includes("src/extension/r/rInteractiveCommands.ts"), false);
  assert.equal(
    report.measurements["native-live"].files.includes("src/extension/notebooks/pythonInteractiveCommands.ts"),
    true
  );
  assert.equal(report.measurements["native-live"].files.includes("src/extension/r/rInteractiveCommands.ts"), true);
  assert.equal(
    report.measurements["test-api"].files.includes("src/extension/notebooks/notebookPreviewCoordinator.ts"),
    true
  );
  assert.equal(report.dynamicEdges.discovered.length, Object.keys(dynamicEdgeClassifications).length);
  assert.deepEqual(report.dynamicEdges.unclassified, []);
  assert.deepEqual(report.dynamicEdges.staleClassifications, []);
  assert.deepEqual(report.dynamicEdges.occurrenceMismatches, []);
  assert.deepEqual(report.dynamicEdges.closureMismatches, []);
  for (const [edge, classification] of Object.entries(dynamicEdgeClassifications)) {
    const [importer, _kind, specifier] = edge.split("|");
    if (!specifier.startsWith(".")) continue;
    const unresolvedTarget = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    const target = /\.[cm]?js$/u.test(unresolvedTarget)
      ? unresolvedTarget
          .replace(/\.mjs$/u, ".mts")
          .replace(/\.cjs$/u, ".cts")
          .replace(/\.js$/u, ".ts")
      : `${unresolvedTarget}.ts`;
    for (const trigger of classification.triggers) {
      assert.equal(report.measurements[trigger].classifiedDynamicRoots.includes(target), true, `${trigger}: ${target}`);
      assert.equal(report.measurements[trigger].files.includes(target), true, `${trigger}: ${target}`);
    }
  }
  assert.equal(report.activationEvents.discovered.length, Object.keys(activationEventClassifications).length);
  assert.equal(report.activationEvents.explicit.length, 51);
  assert.equal(report.activationEvents.contributedCommands.length, 43);
  assert.deepEqual(report.activationEvents.contributedViews, [
    "openWrangler.cleaningSteps",
    "openWrangler.codePreview",
    "openWrangler.filters",
    "openWrangler.operations",
    "openWrangler.summary"
  ]);
  assert.deepEqual(report.activationEvents.contributedCustomEditors, ["openWrangler.viewer"]);
  assert.deepEqual(
    report.activationEvents.contributionDerived.filter((event) => !report.activationEvents.explicit.includes(event)),
    ["onCommand:openWrangler.openCachedNotebookVariable"]
  );
  assert.deepEqual(report.activationEvents.unclassified, []);
  assert.deepEqual(report.activationEvents.staleClassifications, []);
  assert.deepEqual(report.activationEvents.occurrenceMismatches, []);
  assert.deepEqual(report.activationEvents.contributedViewOccurrenceMismatches, []);
  assert.deepEqual(report.activationEvents.contributedCustomEditorOccurrenceMismatches, []);
});

test("one trigger contract owns both activation events and runtime closures", () => {
  assert.deepEqual(Object.keys(activationTriggerBudgets), Object.keys(activationTriggerContract));
  for (const [trigger, contract] of Object.entries(activationTriggerContract)) {
    assert.deepEqual(activationTriggerBudgets[trigger], {
      roots: contract.roots,
      maximumModules: contract.maximumModules,
      maximumBytes: contract.maximumBytes,
      forbidden: contract.forbidden
    });
    for (const event of contract.events) assert.equal(activationEventClassifications[event], trigger);
  }
  assert.equal(
    Object.values(activationTriggerContract).reduce((total, contract) => total + contract.events.length, 0),
    Object.keys(activationEventClassifications).length
  );
  assert.deepEqual(activationTriggerContract["test-api"].events, []);
  assert.deepEqual(activationTriggerContract["test-api"].roots, ["src/extension/activate.ts"]);
});

test("production lazy loaders emit only deferred literal CommonJS requires", async () => {
  const source = await readFile(new URL("../src/extension/lazyActivationOwners.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: "src/extension/lazyActivationOwners.ts"
  }).outputText;
  assert.doesNotMatch(output, /\bimport\s*\(/u);

  const inventory = await measureActivationInventory();
  const lazyEdges = inventory.dynamicEdges.discovered.filter(({ key }) =>
    key.startsWith("src/extension/lazyActivationOwners.ts|")
  );
  assert.equal(lazyEdges.length > 0, true);
  assert.equal(
    lazyEdges.every(({ key }) => key.includes("|require|")),
    true
  );
});

test("the elapsed activation gate rejects an injected synchronous registration delay", async () => {
  const measurement = await measureDependencyFreeActivation(undefined, {
    synchronousRegistrationDelayMs: maximumDependencyFreeActivationMs + 1
  });

  assert.equal(measurement.elapsedMs >= maximumDependencyFreeActivationMs + 1, true);
  assert.equal(measurement.withinBudget, false);
  assert.match(measurement.failure, /synchronous activation exceeded/u);
  const failures = activationBudgetFailures(completeInventoryReport({ elapsedActivation: measurement }), {});
  assert.equal(failures.length, 1);
  assert.match(failures[0], /elapsed activation/u);
});

test("the elapsed activation boundary includes cold module evaluation", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await writeFile(
      path.join(sourceRoot, "lazyActivationOwners.ts"),
      `
        export class LazyActivationOwners {
          constructor(_context: unknown) {}
          startBeforeFirstYield(): void {}
          async extensionApiForCurrentEnvironment(): Promise<undefined> { return undefined; }
          async shutdown(): Promise<void> {}
        }
      `,
      "utf8"
    );
    await writeFile(
      path.join(sourceRoot, "activate.ts"),
      `
        import { LazyActivationOwners } from "./lazyActivationOwners";
        const coldStartedAt = performance.now();
        while (performance.now() - coldStartedAt <= ${maximumDependencyFreeActivationMs + 1}) {}
        export const MAX_SYNCHRONOUS_ACTIVATION_MS = ${maximumDependencyFreeActivationMs};
        let owner: LazyActivationOwners | undefined;
        export async function activate(context: unknown): Promise<undefined> {
          owner = new LazyActivationOwners(context);
          owner.startBeforeFirstYield();
          return owner.extensionApiForCurrentEnvironment();
        }
        export async function deactivate(): Promise<void> { await owner?.shutdown(); }
      `,
      "utf8"
    );

    const measurement = await measureDependencyFreeActivation(root);

    assert.equal(measurement.elapsedMs > maximumDependencyFreeActivationMs, true);
    assert.equal(measurement.withinBudget, false);
    assert.match(measurement.failure, /Cold dependency-free activation exceeded/u);
  });
});

test("the gate rejects byte, module, and owner-isolation regressions", () => {
  const report = completeInventoryReport({
    measurements: {
      unrelated: {
        modules: activationTriggerBudgets.unrelated.maximumModules + 1,
        bytes: activationTriggerBudgets.unrelated.maximumBytes + 1,
        files: ["src/extension/pythonBridge.ts"],
        forbiddenMatches: [{ needle: "pythonBridge.ts", file: "src/extension/pythonBridge.ts" }]
      }
    }
  });
  const failures = activationBudgetFailures(report, { unrelated: activationTriggerBudgets.unrelated });

  assert.equal(failures.length, 3);
  assert.match(failures[0], /modules exceeds/u);
  assert.match(failures[1], /bytes exceeds/u);
  assert.match(failures[2], /unexpectedly loads/u);
});

test("the audit discovers aliased loaders and contribution-derived activation through mutated fixtures", async () => {
  await withInventoryFixture(
    `
      import { createRequire as makeRequire } from "node:module";
      const loadModule = (specifier) => import(specifier);
      const aliasedLoad = loadModule;
      const directRequire = require;
      const aliasedRequire = directRequire;
      const localRequire = makeRequire(import.meta.url);
      aliasedLoad("./dynamic-owner.js");
      aliasedRequire("./required-owner.js");
      localRequire("./created-owner.js");
      // require("./commented-line.js");
      /* import("./commented-block.js"); */
    `,
    {
      activationEvents: ["onCommand:fixture.explicit"],
      contributes: { commands: [{ command: "fixture.explicit" }, { command: "fixture.implicit" }] }
    },
    async (report) => {
      assert.deepEqual(
        report.dynamicEdges.discovered.map(({ key }) => key),
        [
          "src/extension/fixture.ts|import|./dynamic-owner.js",
          "src/extension/fixture.ts|require|./created-owner.js",
          "src/extension/fixture.ts|require|./required-owner.js"
        ]
      );
      assert.equal(
        report.dynamicEdges.discovered.some(({ key }) => key.includes("commented")),
        false
      );
      assert.deepEqual(report.activationEvents.explicit, ["onCommand:fixture.explicit"]);
      assert.deepEqual(report.activationEvents.contributionDerived, [
        "onCommand:fixture.explicit",
        "onCommand:fixture.implicit"
      ]);
      assert.deepEqual(report.activationEvents.discovered, [
        "onCommand:fixture.explicit",
        "onCommand:fixture.implicit"
      ]);
    }
  );
});

test("the audit derives implicit activation from mutated command, view, and custom-editor contributions", async () => {
  await withInventoryFixture(
    "export {};\n",
    {
      activationEvents: ["onCommand:fixture.explicit"],
      contributes: {
        commands: [{ command: "fixture.explicit" }, { command: "fixture.command" }],
        views: { fixture: [{ id: "fixture.view" }] },
        customEditors: [{ viewType: "fixture.editor" }]
      }
    },
    async (report) => {
      assert.deepEqual(report.activationEvents.contributionDerived, [
        "onCommand:fixture.command",
        "onCommand:fixture.explicit",
        "onCustomEditor:fixture.editor",
        "onView:fixture.view"
      ]);
      assert.deepEqual(report.activationEvents.discovered, report.activationEvents.contributionDerived);
      assert.deepEqual(report.activationEvents.contributedViews, ["fixture.view"]);
      assert.deepEqual(report.activationEvents.contributedCustomEditors, ["fixture.editor"]);
    }
  );
});

test("the syntax authority accepts parenthesized loaders and rejects regex, template, and string text", async () => {
  const source = [
    "const loadModule = (specifier) => import(specifier);",
    "const directRequire = require;",
    '(loadModule)("./parenthesized-import.js");',
    '(directRequire)("./parenthesized-require.js");',
    "const stringText = 'require(\"./string-text.js\")';",
    'const templateText = `import("./template-text.js")`;',
    'const regexText = /require\\("\\.\\/regex-text\\.js"\\)/u;'
  ].join("\n");
  await withInventoryFixture(source, { activationEvents: [], contributes: { commands: [] } }, async (report) => {
    assert.deepEqual(
      report.dynamicEdges.discovered.map(({ key }) => key),
      [
        "src/extension/fixture.ts|import|./parenthesized-import.js",
        "src/extension/fixture.ts|require|./parenthesized-require.js"
      ]
    );
  });
});

test("the syntax authority recognizes namespace and CommonJS createRequire loaders", async () => {
  await withInventoryFixture(
    `
      import * as moduleApi from "node:module";
      import moduleApiDefault from "node:module";
      import type typeOnlyDefault from "node:module";
      import type * as typeOnlyNamespace from "node:module";
      import { type createRequire as typeOnlyCreateRequire } from "node:module";
      const namespaceRequire = moduleApi.createRequire(import.meta.url);
      const defaultRequire = moduleApiDefault.createRequire(import.meta.url);
      const commonJsModule = require("node:module");
      const commonJsRequire = commonJsModule.createRequire(__filename);
      const directMemberRequire = require("node:module").createRequire(__filename);
      namespaceRequire("./namespace-owner.js");
      defaultRequire("./default-owner.js");
      commonJsRequire("./commonjs-owner.js");
      directMemberRequire("./direct-member-owner.js");
      type TypeOnlyBindings = [typeof typeOnlyDefault, typeof typeOnlyNamespace, typeof typeOnlyCreateRequire];
    `,
    { activationEvents: [], contributes: { commands: [] } },
    async (report) => {
      assert.deepEqual(report.dynamicEdges.discovered, [
        { key: "src/extension/fixture.ts|require|./commonjs-owner.js", occurrences: 1 },
        { key: "src/extension/fixture.ts|require|./default-owner.js", occurrences: 1 },
        { key: "src/extension/fixture.ts|require|./direct-member-owner.js", occurrences: 1 },
        { key: "src/extension/fixture.ts|require|./namespace-owner.js", occurrences: 1 },
        { key: "src/extension/fixture.ts|require|node:module", occurrences: 2 }
      ]);
    }
  );
});

test("loader alias propagation is linear and cycle-safe across forward chains", async () => {
  const aliases = Array.from({ length: 2_048 }, (_, index) =>
    index === 2_047 ? `const loader${index} = require;` : `const loader${index} = loader${index + 1};`
  );
  const source = [
    ...aliases,
    'loader0("./linear-owner.js");',
    "function cycleOne(specifier) { return cycleTwo(specifier); }",
    "function cycleTwo(specifier) { return cycleOne(specifier); }"
  ].join("\n");
  await withInventoryFixture(source, { activationEvents: [], contributes: { commands: [] } }, async (report) => {
    assert.deepEqual(report.dynamicEdges.discovered, [
      { key: "src/extension/fixture.ts|require|./linear-owner.js", occurrences: 1 }
    ]);
  });
});

test("the syntax authority rejects loader aliases that escape through unsupported storage", async () => {
  await withInventoryFixture(
    `
      import { createRequire as makeRequire } from "node:module";
      const loaders = { load: require };
      const factories = { makeRequire };
      loaders.load("./escaped-owner.js");
      factories.makeRequire(import.meta.url)("./also-escaped-owner.js");
    `,
    { activationEvents: [], contributes: { commands: [] } },
    async () => assert.fail("a property-held loader must not escape the closed dynamic-edge model"),
    {},
    /loader alias escapes through unsupported use/u
  );
});

test("the syntax authority rejects loader aliases through arrays, callbacks, returns, class fields, and invocation helpers", async () => {
  const escapes = [
    ["array", "const loaders = [require];"],
    ["callback", "declare function consume(value: unknown): void; consume(require);"],
    ["return", "function escapedLoader(): unknown { return require; }"],
    ["class-field", "class LoaderOwner { readonly load = require; }"],
    [
      "direct-create-require",
      'import { createRequire } from "node:module"; createRequire(import.meta.url)("./escaped.js");'
    ],
    ["call", 'require.call(undefined, "./escaped.js");'],
    ["apply", 'require.apply(undefined, ["./escaped.js"]);'],
    ["bind", "const escapedLoader = require.bind(undefined);"]
  ];
  for (const [name, source] of escapes) {
    await withInventoryFixture(
      source,
      { activationEvents: [], contributes: { commands: [] } },
      async () => assert.fail(`${name} must not escape the closed dynamic-edge model`),
      {},
      /loader alias escapes through unsupported use/u
    );
  }
});

test("the syntax authority follows lexical loader origins through quoted bindings, destructuring, and module.require", async () => {
  await withInventoryFixture(
    `
      import { "createRequire" as quotedCreateRequire } from "node:module";
      const quotedRequire = quotedCreateRequire(import.meta.url);
      const { "createRequire": commonJsCreateRequire } = require("node:module");
      const commonJsRequire = commonJsCreateRequire(__filename);
      const { "require": moduleRequire } = module;
      const aliasedModuleRequire = module.require;
      quotedRequire("./quoted-import.js");
      commonJsRequire("./quoted-commonjs.js");
      moduleRequire("./destructured-module.js");
      aliasedModuleRequire("./module-alias.js");
    `,
    { activationEvents: [], contributes: { commands: [] } },
    async (report) => {
      assert.deepEqual(
        report.dynamicEdges.discovered.map(({ key }) => key),
        [
          "src/extension/fixture.ts|require|./destructured-module.js",
          "src/extension/fixture.ts|require|./module-alias.js",
          "src/extension/fixture.ts|require|./quoted-commonjs.js",
          "src/extension/fixture.ts|require|./quoted-import.js",
          "src/extension/fixture.ts|require|node:module"
        ]
      );
    }
  );
});

test("the syntax authority distinguishes shadowed loader names from global bindings", async () => {
  await withInventoryFixture(
    `
      function shadowRequire(require) { require("./shadowed-require.js"); }
      function shadowModule(module) { module.require("./shadowed-module.js"); }
      require("./global-require.js");
      module.require("./global-module.js");
    `,
    { activationEvents: [], contributes: { commands: [] } },
    async (report) => {
      assert.deepEqual(
        report.dynamicEdges.discovered.map(({ key }) => key),
        ["src/extension/fixture.ts|require|./global-module.js", "src/extension/fixture.ts|require|./global-require.js"]
      );
    }
  );
});

test("the syntax authority rejects loader reassignment including destructured assignment", async () => {
  const reassignments = [
    'let load = require; load = () => undefined; load("./stale-origin.js");',
    'let load; load = require; load("./late-origin.js");',
    'let load; ({ "require": load } = module); load("./destructured-assignment.js");'
  ];
  for (const source of reassignments) {
    await withInventoryFixture(
      source,
      { activationEvents: [], contributes: { commands: [] } },
      async () => assert.fail("reassigned loaders must not enter the closed dynamic-edge model"),
      {},
      /loader alias escapes through unsupported use/u
    );
  }
});

test("the syntax authority rejects deep operator trees with a controlled bound", async () => {
  const deepOperatorChain = `export const value = ${Array.from({ length: 600 }, () => "1").join(" + ")};\n`;
  await withInventoryFixture(
    deepOperatorChain,
    { activationEvents: [], contributes: { commands: [] } },
    async () => assert.fail("a deep operator tree must fail through the explicit AST depth gate"),
    {},
    /exceeds syntax tree depth 512/u
  );
});

test("transitive source discovery resolves .mjs and .cjs imports to .mts and .cts sources", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await writeFile(path.join(sourceRoot, "entry.mts"), 'import "./module.mjs";\n', "utf8");
    await writeFile(path.join(sourceRoot, "module.mts"), "export const moduleValue = 1;\n", "utf8");
    await writeFile(path.join(sourceRoot, "entry.cts"), 'import "./common.cjs";\n', "utf8");
    await writeFile(path.join(sourceRoot, "common.cts"), "export const commonValue = 1;\n", "utf8");

    const report = await measureTransitiveRuntimeSources(root, ["src/extension/entry.mts", "src/extension/entry.cts"]);

    assert.deepEqual(report.files, [
      "src/extension/common.cts",
      "src/extension/entry.cts",
      "src/extension/entry.mts",
      "src/extension/module.mts"
    ]);
  });
});

test("transitive source discovery rejects symlinks before reading them", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./linked.js";\n', "utf8");
    await writeFile(path.join(sourceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    await symlink("target.ts", path.join(sourceRoot, "linked.ts"));

    await assert.rejects(
      measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"]),
      /resolved through a symlink/u
    );
  });
});

test("transitive source discovery binds the opened descriptor before path identity checks", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    const dependency = path.join(sourceRoot, "dependency.ts");
    await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./dependency.js";\n', "utf8");
    await writeFile(dependency, "export const value = 1;\n", "utf8");
    let replaced = false;

    await assert.rejects(
      measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"], {
        afterDescriptorOpen: async (file) => {
          if (file !== dependency || replaced) return;
          replaced = true;
          await rename(dependency, `${dependency}.previous`);
          await writeFile(dependency, "export const value = 2;\n", "utf8");
        }
      }),
      /changed identity before read/u
    );
  });
});

test(
  "descriptor reads reject FIFO replacement and device sources without reading them",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(measureTransitiveRuntimeSources("/", ["dev/null"]), /bounded regular file/u);
    await withSourceFixture(async (root) => {
      const sourceRoot = path.join(root, "src/extension");
      const dependency = path.join(sourceRoot, "dependency.ts");
      await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./dependency.js";\n', "utf8");
      await writeFile(dependency, "export const value = 1;\n", "utf8");
      let replaced = false;

      await assert.rejects(
        measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"], {
          afterDescriptorOpen: async (file) => {
            if (file !== dependency || replaced) return;
            replaced = true;
            await rename(dependency, `${dependency}.previous`);
            await execFileAsync("mkfifo", [dependency]);
          }
        }),
        /changed identity before read/u
      );
    });
    await withSourceFixture(async (root) => {
      const sourceRoot = path.join(root, "src/extension");
      const dependency = path.join(sourceRoot, "dependency.ts");
      await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./dependency.js";\n', "utf8");
      await writeFile(dependency, "export const value = 1;\n", "utf8");

      await assert.rejects(
        measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"], {
          afterDescriptorOpen: async (file) => {
            if (file !== dependency) return;
            await rename(dependency, `${dependency}.previous`);
            await symlink("/dev/null", dependency);
          }
        }),
        /escaped repository root|symlinked path/u
      );
    });
  }
);

test("descriptor reads reject hard-linked source files", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    const entry = path.join(sourceRoot, "entry.ts");
    await writeFile(entry, "export const value = 1;\n", "utf8");
    await link(entry, path.join(sourceRoot, "entry-alias.ts"));

    await assert.rejects(measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"]), /bounded regular file/u);
  });
});

test("descriptor reads reject an in-place same-length mutation", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    const dependency = path.join(sourceRoot, "dependency.ts");
    await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./dependency.js";\n', "utf8");
    await writeFile(dependency, "export const value = 1;\n", "utf8");
    let mutated = false;

    await assert.rejects(
      measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"], {
        afterDescriptorRead: async (file) => {
          if (file !== dependency || mutated) return;
          mutated = true;
          await writeFile(dependency, "export const value = 2;\n", "utf8");
        }
      }),
      /changed identity during read/u
    );
  });
});

test("transitive source discovery rejects aggregate overflow before the next read", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./dependency.js";\nexport const entry = 1;\n', "utf8");
    await writeFile(
      path.join(sourceRoot, "dependency.ts"),
      'export const dependency = "a bounded fixture that crosses the aggregate cap";\n',
      "utf8"
    );

    await assert.rejects(
      measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"], { maximumAggregateBytes: 96 }),
      /aggregate source bound/u
    );
  });
});

test("production source discovery rejects deep and wide directory trees", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await mkdir(path.join(sourceRoot, "one/two"), { recursive: true });
    await writeFile(path.join(sourceRoot, "one/two/deep.ts"), "export {};\n", "utf8");

    await assert.rejects(measureActivationInventory(root, { maximumDirectoryDepth: 1 }), /exceeds directory depth 1/u);
  });
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await Promise.all(
      ["one.ts", "two.ts", "three.ts"].map((file) => writeFile(path.join(sourceRoot, file), "export {};\n", "utf8"))
    );

    await assert.rejects(
      measureActivationInventory(root, { maximumDirectoryEntries: 2 }),
      /exceeds 2 directory entries/u
    );
  });
});

test("the syntax preflight rejects token and nesting overflow before AST inventory", async () => {
  await withInventoryFixture(
    "const first = 1; const second = 2;\n",
    { activationEvents: [], contributes: { commands: [] } },
    async () => assert.fail("token overflow should reject before producing an inventory"),
    { maximumSyntaxTokens: 4 },
    /exceeds 4 syntax tokens/u
  );
  await withInventoryFixture(
    "export const nested = [[[1]]];\n",
    { activationEvents: [], contributes: { commands: [] } },
    async () => assert.fail("nesting overflow should reject before producing an inventory"),
    { maximumSyntaxNesting: 2 },
    /exceeds syntax nesting 2/u
  );
});

function completeInventoryReport(report) {
  return {
    elapsedActivation: {
      elapsedMs: 0,
      maximumMs: maximumDependencyFreeActivationMs,
      withinBudget: true
    },
    ...report,
    dynamicEdges: {
      discovered: [],
      classified: [],
      unclassified: [],
      staleClassifications: [],
      occurrenceMismatches: [],
      unknownTriggerClasses: [],
      closureMismatches: []
    },
    activationEvents: {
      discovered: [],
      classified: [],
      unclassified: [],
      staleClassifications: [],
      occurrenceMismatches: [],
      contributedCommandOccurrenceMismatches: [],
      contributedViewOccurrenceMismatches: [],
      contributedCustomEditorOccurrenceMismatches: [],
      unknownTriggerClasses: []
    }
  };
}

async function withInventoryFixture(source, manifest, inspect, options = {}, expectedFailure) {
  const root = await mkdtemp(path.join(tmpdir(), "ow-activation-audit-"));
  try {
    await mkdir(path.join(root, "src/extension"), { recursive: true });
    await writeFile(path.join(root, "src/extension/fixture.ts"), source, "utf8");
    await writeFile(path.join(root, "package.json"), JSON.stringify(manifest), "utf8");
    if (expectedFailure) {
      await assert.rejects(measureActivationInventory(root, options), expectedFailure);
    } else {
      await inspect(await measureActivationInventory(root, options));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withSourceFixture(inspect) {
  const root = await mkdtemp(path.join(tmpdir(), "ow-activation-source-audit-"));
  try {
    await mkdir(path.join(root, "src/extension"), { recursive: true });
    await inspect(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
