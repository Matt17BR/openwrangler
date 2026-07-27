import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { loadXvfbManifest } from "./prepare-xvfb.mjs";
import { readBoundedRemoteWorkspaceFile } from "./remote-workspace-contract.mjs";
import {
  assertRemoteWorkspacePhaseLoaderStage,
  stageRemoteWorkspacePhaseLoader,
  validateRemoteWorkspacePhaseModuleClosure
} from "./remote-workspace-phase-loader.mjs";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("phase-loader staging derives one fixed reachable static ESM closure", () => {
  const fixture = phaseFixture("ow-remote-phase-loader-");
  try {
    const closure = validateRemoteWorkspacePhaseModuleClosure(fixture.source);
    assert.equal(closure.entrypoint, "remote-workspace-phase-child.mjs");
    assert.deepEqual(
      closure.modules.map((module) => module.name),
      ["remote-workspace-phase-child.mjs", "remote-workspace-contract.mjs", "remote-workspace-processes.mjs"]
    );
    assert.deepEqual(closure.modules[0].localImports, [
      "remote-workspace-contract.mjs",
      "remote-workspace-processes.mjs"
    ]);
    assert.deepEqual(closure.modules[0].nodeImports, ["node:fs"]);
    const stage = stageRemoteWorkspacePhaseLoader(fixture.source, fixture.staged, fixture.xvfb);
    assert.equal(stage.entrypoint, join(fixture.staged, "remote-workspace-phase-child.mjs"));
    assert.deepEqual(
      stage.manifest.directories.map((entry) => entry.path),
      ["."]
    );
    assert.deepEqual(stage.manifest.links, []);
    assert.deepEqual(
      stage.manifest.files.map((entry) => entry.path),
      ["Xvfb", "remote-workspace-contract.mjs", "remote-workspace-phase-child.mjs", "remote-workspace-processes.mjs"]
    );
    assert.equal(
      stage.manifest.bytes,
      [stage.xvfbStage, ...stage.moduleStages].reduce(
        (bytes, fileStage) => bytes + Number(fileStage.stagedReceipt.size),
        0
      )
    );
    assert.equal(assertRemoteWorkspacePhaseLoaderStage(stage), stage);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

posixTest("phase runtime bounds accept the exact largest pinned Xvfb and reject its next byte", () => {
  const pinnedMaximum = Object.values(loadXvfbManifest().packages).reduce(
    (maximum, record) => Math.max(maximum, record.executableSize),
    0
  );
  assert.equal(pinnedMaximum, 2_142_760, "a pinned Xvfb size change requires an explicit staging-bound review");

  const accepted = phaseFixture("ow-remote-phase-xvfb-max-", {
    moduleBytes: 512 * 1024,
    xvfbBytes: pinnedMaximum
  });
  try {
    const stage = stageRemoteWorkspacePhaseLoader(accepted.source, accepted.staged, accepted.xvfb);
    assert.equal(stage.manifest.files.find((entry) => entry.path === "Xvfb")?.receipt.size, BigInt(pinnedMaximum));
    assert.equal(stage.manifest.bytes, pinnedMaximum + 3 * 512 * 1024);
    assert.equal(stage.manifest.links.length, 0);
    assert.deepEqual(
      stage.manifest.directories.map((entry) => entry.path),
      ["."]
    );
  } finally {
    rmSync(accepted.root, { recursive: true, force: true });
  }

  const rejected = phaseFixture("ow-remote-phase-xvfb-over-", { xvfbBytes: pinnedMaximum + 1 });
  try {
    assert.throws(
      () => stageRemoteWorkspacePhaseLoader(rejected.source, rejected.staged, rejected.xvfb),
      /bounded no-follow regular receipt file/u
    );
  } finally {
    rmSync(rejected.root, { recursive: true, force: true });
  }
});

posixTest("phase-loader modules retain their exact 512 KiB source ceiling", () => {
  const fixture = phaseFixture("ow-remote-phase-module-bound-");
  const childPath = join(fixture.source, "remote-workspace-phase-child.mjs");
  try {
    const exact = paddedModuleSource(validChildSource(), 512 * 1024);
    writeFileSync(childPath, exact);
    assert.doesNotThrow(() => validateRemoteWorkspacePhaseModuleClosure(fixture.source));

    writeFileSync(childPath, `${exact} `);
    assert.throws(() => validateRemoteWorkspacePhaseModuleClosure(fixture.source), /unsafe bounded file/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

posixTest("phase-loader closure accepts export-from and ignores import-shaped comments", () => {
  const fixture = phaseFixture("ow-remote-phase-export-");
  try {
    writeFileSync(
      join(fixture.source, "remote-workspace-phase-child.mjs"),
      [
        'export { contract } from "./remote-workspace-contract.mjs";',
        'import "./remote-workspace-processes.mjs";',
        '// import "./not-a-module.mjs";',
        'const text = "import(\\"./also-not-a-module.mjs\\")";'
      ].join("\n") + "\n"
    );
    assert.doesNotThrow(() => validateRemoteWorkspacePhaseModuleClosure(fixture.source));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

posixTest("phase-loader closure rejects missing, unreachable, dynamic, and malformed modules", () => {
  for (const [label, mutate, expected] of [
    [
      "missing",
      (fixture) => unlinkSync(join(fixture.source, "remote-workspace-processes.mjs")),
      /unsafe bounded file/u
    ],
    [
      "unreachable",
      (fixture) =>
        writeFileSync(
          join(fixture.source, "remote-workspace-phase-child.mjs"),
          'import "./remote-workspace-contract.mjs";\n'
        ),
      /unreachable module/u
    ],
    [
      "dynamic",
      (fixture) =>
        writeFileSync(
          join(fixture.source, "remote-workspace-phase-child.mjs"),
          validChildSource('await import("./remote-workspace-contract.mjs");')
        ),
      /dynamic import/u
    ],
    [
      "require",
      (fixture) =>
        writeFileSync(
          join(fixture.source, "remote-workspace-phase-child.mjs"),
          validChildSource('require("./remote-workspace-contract.mjs");')
        ),
      /CommonJS loader/u
    ],
    [
      "parse",
      (fixture) => writeFileSync(join(fixture.source, "remote-workspace-phase-child.mjs"), "import {\n"),
      /invalid JavaScript/u
    ]
  ]) {
    const fixture = phaseFixture(`ow-remote-phase-${label}-`);
    try {
      mutate(fixture);
      assert.throws(() => validateRemoteWorkspacePhaseModuleClosure(fixture.source), expected);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

posixTest("phase-loader closure rejects bare, decorated, nested, absolute, and parent imports", () => {
  for (const specifier of [
    "typescript",
    "./remote-workspace-contract.mjs?query",
    "./remote-workspace-contract.mjs#fragment",
    "./nested/remote-workspace-contract.mjs",
    "/tmp/remote-workspace-contract.mjs",
    "../remote-workspace-contract.mjs"
  ]) {
    const fixture = phaseFixture("ow-remote-phase-import-");
    try {
      writeFileSync(
        join(fixture.source, "remote-workspace-phase-child.mjs"),
        validChildSource(`import ${JSON.stringify(specifier)};`)
      );
      assert.throws(
        () => validateRemoteWorkspacePhaseModuleClosure(fixture.source),
        /escaped its fixed local ESM closure/u
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

posixTest("phase-loader reads remain bound to one descriptor during a named-path swap", () => {
  const fixture = phaseFixture("ow-remote-phase-race-");
  try {
    const target = join(fixture.source, "remote-workspace-phase-child.mjs");
    const original = join(fixture.source, "original.mjs");
    const replacement = join(fixture.source, "replacement.mjs");
    writeFileSync(replacement, validChildSource("export const replacement = true;\n"));
    assert.throws(
      () =>
        validateRemoteWorkspacePhaseModuleClosure(fixture.source, {
          readFile(path, maximumBytes) {
            return readBoundedRemoteWorkspaceFile(path, maximumBytes, {
              onDescriptorOpened() {
                if (basename(path) === "remote-workspace-phase-child.mjs") {
                  renameSync(target, original);
                  renameSync(replacement, target);
                }
              }
            });
          }
        }),
      /path identity changed/u
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

posixTest("phase-loader stage rejects source, staged, extra, nested, and linked drift", () => {
  for (const [label, mutate] of [
    [
      "source",
      (fixture) => writeFileSync(join(fixture.source, "remote-workspace-contract.mjs"), "export const contract = 2;\n")
    ],
    [
      "staged",
      (fixture) => writeFileSync(join(fixture.staged, "remote-workspace-contract.mjs"), "export const contract = 2;\n")
    ],
    ["extra", (fixture) => writeFileSync(join(fixture.staged, "extra.mjs"), "export {};\n")],
    [
      "nested",
      (fixture) => {
        mkdirSync(join(fixture.staged, "nested"), { mode: 0o700 });
        writeFileSync(join(fixture.staged, "nested", "extra.mjs"), "export {};\n");
      }
    ],
    [
      "linked",
      (fixture) =>
        symlinkSync(join(fixture.staged, "remote-workspace-contract.mjs"), join(fixture.staged, "linked.mjs"))
    ]
  ]) {
    const fixture = phaseFixture(`ow-remote-phase-stage-${label}-`);
    try {
      const stage = stageRemoteWorkspacePhaseLoader(fixture.source, fixture.staged, fixture.xvfb);
      mutate(fixture);
      assert.throws(
        () => assertRemoteWorkspacePhaseLoaderStage(stage),
        /changed after|changed after it was pinned|exact root-only file manifest|exceeded its fixed entry bound|contains a symbolic link/u
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

function phaseFixture(prefix, { moduleBytes, xvfbBytes } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  const source = join(root, "source");
  const staged = join(root, "staged");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(staged, { mode: 0o700 });
  const modules = [
    ["remote-workspace-phase-child.mjs", validChildSource()],
    ["remote-workspace-contract.mjs", "export const contract = 1;\n"],
    ["remote-workspace-processes.mjs", "export const processes = 1;\n"]
  ];
  for (const [name, sourceText] of modules) {
    writeFileSync(
      join(source, name),
      moduleBytes === undefined ? sourceText : paddedModuleSource(sourceText, moduleBytes)
    );
  }
  const xvfb = join(root, "Xvfb");
  writeFileSync(xvfb, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  if (xvfbBytes !== undefined) truncateSync(xvfb, xvfbBytes);
  chmodSync(xvfb, 0o700);
  return Object.freeze({ root, source, staged, xvfb });
}

function validChildSource(extra = "") {
  return (
    [
      'import fs from "node:fs";',
      'import "./remote-workspace-contract.mjs";',
      'import "./remote-workspace-processes.mjs";',
      "void fs;",
      extra
    ].join("\n") + "\n"
  );
}

function paddedModuleSource(source, bytes) {
  const padding = bytes - Buffer.byteLength(source, "utf8") - 4;
  assert.equal(Number.isSafeInteger(padding) && padding >= 0, true);
  return `${source}/*${" ".repeat(padding)}*/`;
}
