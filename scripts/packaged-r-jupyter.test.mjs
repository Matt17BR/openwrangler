import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  jupyterAcceptanceRKernelBootstrapStage,
  prepareJupyterAcceptanceREnvironment,
  probeJupyterAcceptanceRKernel,
  R_ACCEPTANCE_PACKAGE_VERSIONS,
  rAcceptanceInstallTimings,
  rAcceptancePackageRecordMatches,
  rAcceptanceRepositories
} from "./jupyter-acceptance-environment.mjs";
import { resolvePackagedRJourneySelection } from "./packaged-r-journey.mjs";
import { editorAcceptancePrivateRootIdentityLost } from "./packaged-editor-orchestration.mjs";
import { acquireExactArtifact, prepareREditorAcceptanceTooling } from "./r-editor-acceptance-tooling.mjs";

const notebookPackages = ["IRkernel", "jsonlite", "rlang", "Rcpp", "tibble", "data.table", "collapse", "nanoparquet"];
const editorPackages = [
  "IRkernel",
  "jsonlite",
  "rlang",
  "Rcpp",
  "languageserver",
  "rmarkdown",
  "knitr",
  "tibble",
  "data.table",
  "collapse",
  "nanoparquet"
];
const artifactPayload = "exact artifact";
const artifactPin = Object.freeze({
  fileName: "fixture.tgz",
  url: "https://example.invalid/fixture.tgz",
  bytes: Buffer.byteLength(artifactPayload),
  sha256: createHash("sha256").update(artifactPayload).digest("hex")
});

function provisioning(t) {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-r-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rscript = join(root, "Rscript");
  const rExecutable = join(root, "R");
  for (const path of [rscript, rExecutable]) writeFileSync(path, "executable fixture", { mode: 0o700 });
  const commands = [];
  return {
    root,
    directory: join(root, "private"),
    rscript,
    rExecutable,
    commands,
    options: {
      containedBy: root,
      environment: { PATH: "", R_LIBS: "foreign-library", R_PROFILE: "foreign-profile", RETAINED: "value" },
      async runCommand(input) {
        commands.push(input);
        return { stdout: rExecutable, stderr: "" };
      }
    }
  };
}

function commandCode(invocation) {
  assert.equal(invocation.input.args[0], "--vanilla");
  assert.equal(invocation.input.args[1], "-e");
  return invocation.input.args[2];
}

function preparedPackageInputs(prepared) {
  const install = commandCode(prepared.dependencyInstall);
  const probe = commandCode(prepared.dependencyProbe);
  const packageNames = /^\.ow_packages <- c\((.*)\)$/mu.exec(install);
  const expectedVersions = /^\.ow_expected <- c\((.*)\)$/mu.exec(probe);
  assert.ok(packageNames);
  assert.ok(expectedVersions);
  return {
    packages: JSON.parse(`[${packageNames[1]}]`),
    versions: Object.fromEntries(
      [...expectedVersions[1].matchAll(/("[^"]+") = ("[^"]+")/gu)].map((match) => [
        JSON.parse(match[1]),
        JSON.parse(match[2])
      ])
    )
  };
}

test("actual artifact acquisition verifies tiny local and fetched payloads before returning their path", async (t) => {
  const bytes = Buffer.from(artifactPayload);
  const pin = artifactPin;
  for (const route of ["source", "fetch"]) {
    for (const content of [bytes, Buffer.concat([bytes, Buffer.from("extra")]), Buffer.from("wrong artifact")]) {
      const fixture = provisioning(t);
      mkdirSync(fixture.directory, { mode: 0o700 });
      const source = join(fixture.root, "input.tgz");
      writeFileSync(source, content);
      let fetches = 0;
      const options = {
        sourcePath: route === "source" ? source : undefined,
        async fetchImpl() {
          fetches += 1;
          assert.equal(route, "fetch");
          return new Response(content);
        }
      };
      const acquired = acquireExactArtifact(fixture.directory, "fixture", pin, options);
      if (content.equals(bytes)) {
        assert.equal(await acquired, join(fixture.directory, pin.fileName));
        assert.deepEqual(readFileSync(join(fixture.directory, pin.fileName)), bytes);
      } else {
        await assert.rejects(acquired, /pinned size|pinned checksum|exact response-body verification/u);
        const destination = join(fixture.directory, pin.fileName);
        if (existsSync(destination)) assert.ok(statSync(destination).size <= pin.bytes);
      }
      assert.equal(fetches, route === "source" ? 0 : 1);
      assert.deepEqual(readFileSync(source), content);
      assert.equal(fixture.commands.length, 0);
    }
  }
});

test("actual artifact acquisition preserves an existing destination on both entry routes", async (t) => {
  const bytes = Buffer.from(artifactPayload);
  const pin = artifactPin;
  for (const route of ["source", "fetch"]) {
    const fixture = provisioning(t);
    mkdirSync(fixture.directory, { mode: 0o700 });
    const destination = join(fixture.directory, pin.fileName);
    const source = join(fixture.root, "input.tgz");
    writeFileSync(destination, "existing caller artifact");
    writeFileSync(source, bytes);
    await assert.rejects(
      acquireExactArtifact(fixture.directory, "fixture", pin, {
        sourcePath: route === "source" ? source : undefined,
        async fetchImpl() {
          assert.equal(route, "fetch");
          return new Response(bytes);
        }
      })
    );
    assert.equal(readFileSync(destination, "utf8"), "existing caller artifact");
    assert.deepEqual(readFileSync(source), bytes);
  }
});

test("actual artifact acquisition retains its deadline while unused HTTP cancellation is pending", async (t) => {
  const fixture = provisioning(t);
  mkdirSync(fixture.directory, { mode: 0o700 });
  const destination = join(fixture.directory, artifactPin.fileName);
  writeFileSync(destination, "existing caller artifact");
  let cancellationStarted;
  const started = new Promise((resolve) => {
    cancellationStarted = resolve;
  });
  let releaseCancellation;
  const pendingCancellation = new Promise((resolve) => {
    releaseCancellation = resolve;
  });
  let deadline;
  let cleared = 0;
  let settled;
  const timer = Symbol("controlled aggregate deadline");
  const acquired = acquireExactArtifact(fixture.directory, "fixture", artifactPin, {
    timeoutMs: 120_000,
    timersForTest: {
      setTimeout(callback, milliseconds) {
        assert.equal(milliseconds, 120_000);
        deadline = callback;
        return timer;
      },
      clearTimeout(value) {
        assert.equal(value, timer);
        cleared += 1;
      }
    },
    async fetchImpl() {
      return new Response(
        new ReadableStream({
          cancel() {
            cancellationStarted();
            return pendingCancellation;
          }
        })
      );
    }
  }).then(
    (value) => {
      settled = { value };
    },
    (error) => {
      settled = { error };
    }
  );
  try {
    await Promise.race([
      started,
      acquired.then(() => {
        throw new Error("Acquisition settled before unused-body cancellation.");
      })
    ]);
    deadline();
    await new Promise(setImmediate);
    assert.ok(settled, "The aggregate deadline must settle acquisition before cancellation resolves.");
    assert.match(settled.error.message, /exceeded its aggregate download deadline/u);
  } finally {
    releaseCancellation();
    await acquired;
    assert.equal(cleared, 1);
    assert.equal(readFileSync(destination, "utf8"), "existing caller artifact");
  }
});

test("actual artifact acquisition disposes rejected HTTP bodies and retains replaced-root ownership", async (t) => {
  for (const replaced of [false, true]) {
    const fixture = provisioning(t);
    mkdirSync(fixture.directory, { mode: 0o700 });
    let fetches = 0;
    let cancellations = 0;
    const sentinel = join(fixture.directory, "caller-owned");
    await assert.rejects(
      acquireExactArtifact(fixture.directory, "fixture", artifactPin, {
        async fetchImpl() {
          fetches += 1;
          if (replaced) {
            renameSync(fixture.directory, `${fixture.directory}-original`);
            mkdirSync(fixture.directory, { mode: 0o700 });
          }
          writeFileSync(sentinel, "preserve caller file");
          return new Response(
            new ReadableStream({
              cancel() {
                cancellations += 1;
              }
            }),
            { status: 500 }
          );
        }
      }),
      (error) => {
        assert.equal(editorAcceptancePrivateRootIdentityLost(error), replaced);
        if (replaced) {
          assert.ok(error instanceof AggregateError);
          assert.ok(error.errors.some((nested) => /non-success HTTP response/u.test(nested.message)));
        } else assert.match(error.message, /non-success HTTP response/u);
        return true;
      }
    );
    assert.equal(fetches, 1);
    assert.equal(cancellations, 1);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve caller file");
    assert.equal(existsSync(join(fixture.directory, artifactPin.fileName)), false);
    if (replaced) assert.ok(existsSync(`${fixture.directory}-original`));
  }
});

for (const replacement of ["file", "root"]) {
  for (const rejected of [false, true]) {
    test(`actual artifact acquisition preserves ${replacement} replacement when its stream ${rejected ? "rejects" : "completes"}`, async (t) => {
      const fixture = provisioning(t);
      mkdirSync(fixture.directory, { mode: 0o700 });
      const bytes = Buffer.from(artifactPayload);
      const pin = artifactPin;
      const destination = join(fixture.directory, pin.fileName);
      const streamError = new Error("controlled artifact stream failure");
      let controller;
      let created;
      const destinationCreated = new Promise((resolve) => {
        created = resolve;
      });
      const watcher = watch(fixture.directory, () => {
        if (existsSync(destination)) created();
      });
      const body = new ReadableStream({
        start(value) {
          controller = value;
        }
      });
      const outcome = acquireExactArtifact(fixture.directory, "fixture", pin, {
        timeoutMs: 2_000,
        async fetchImpl() {
          return new Response(body);
        }
      }).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      try {
        await Promise.race([
          destinationCreated,
          outcome.then(() => {
            throw new Error("Acquisition settled before opening its destination.");
          })
        ]);
        const original =
          replacement === "file" ? `${destination}.original` : join(`${fixture.directory}-original`, pin.fileName);
        if (replacement === "file") {
          renameSync(destination, original);
        } else {
          renameSync(fixture.directory, `${fixture.directory}-original`);
          mkdirSync(fixture.directory, { mode: 0o700 });
        }
        writeFileSync(destination, "replacement caller artifact");
        if (rejected) controller.error(streamError);
        else {
          controller.enqueue(bytes);
          controller.close();
        }
        const settled = await outcome;
        assert.equal(readFileSync(destination, "utf8"), "replacement caller artifact");
        assert.ok(existsSync(original));
        if (!rejected) assert.deepEqual(readFileSync(original), bytes);
        assert.equal(editorAcceptancePrivateRootIdentityLost(settled.error), true);
        if (rejected) {
          assert.ok(settled.error instanceof AggregateError);
          assert.ok(settled.error.errors.includes(streamError));
        }
      } finally {
        watcher.close();
        controller.error(new Error("Artifact stream fixture cleanup."));
        await outcome;
      }
    });
  }
}

test("R preparation selects matching Ubuntu binaries and source for other hosts", async (t) => {
  for (const [osReleaseText, distribution] of [
    ['ID=ubuntu\nVERSION_ID="24.04"\n', "noble"],
    ["ID=ubuntu\nVERSION_ID=26.04\n", "resolute"],
    ["ID=ubuntu\nVERSION_ID=22.04\nVERSION_CODENAME=noble\n", undefined],
    ["ID=debian\nVERSION_ID=13\n", undefined],
    ["ID=ubuntu\nVERSION_ID=unknown\n", undefined],
    ["", undefined]
  ]) {
    const prefix = `https://p3m.dev/cran/${distribution ? `__linux__/${distribution}/` : ""}`;
    const expected = {
      repository: `${prefix}2026-03-10`,
      supplementalRepository: `${prefix}2026-06-01`
    };
    assert.deepEqual(rAcceptanceRepositories("linux", osReleaseText), expected);
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      purpose: "notebook",
      platform: "linux",
      osReleaseText
    });
    assert.equal(prepared.repository, expected.repository);
    assert.equal(prepared.supplementalRepository, expected.supplementalRepository);
    const userAgent = commandCode(prepared.dependencyInstall)
      .split("\n")
      .find((line) => line.startsWith("options(HTTPUserAgent"));
    assert.equal(
      userAgent,
      distribution
        ? 'options(HTTPUserAgent = sprintf("R/%s R (%s)", getRversion(), paste(getRversion(), R.version["platform"], R.version["arch"], R.version["os"])))'
        : undefined
    );
  }
});

for (const [scope, selection, packages] of [
  ["default", {}, editorPackages],
  ["literate", { purpose: "literate-documents" }, editorPackages],
  ["notebook", { purpose: "notebook" }, notebookPackages],
  ...["value-operations", "categorical-operations", "pivot-wider"].map((purpose) => [
    purpose,
    { purpose },
    ["IRkernel", "jsonlite", "rlang", "tibble", "data.table", "nanoparquet"]
  ]),
  ["terminal", { purpose: "interactive-terminal" }, ["jsonlite", "rlang", "tibble", "data.table", "nanoparquet"]]
]) {
  test(`prepared R dependency inputs and receipt agree for ${scope}`, async (t) => {
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      ...selection
    });
    const versions = Object.fromEntries(packages.map((name) => [name, R_ACCEPTANCE_PACKAGE_VERSIONS[name]]));
    assert.deepEqual(preparedPackageInputs(prepared), { packages, versions });
    assert.deepEqual(prepared.packages, packages);
    assert.equal(commandCode(prepared.dependencyProbe).includes("collapse::qDF("), packages.includes("collapse"));
    assert.deepEqual(prepared.packageVersions, versions);
    assert.equal(prepared.packageRecord, packages.map((name) => `${name}=${versions[name]}`).join("\n"));
    for (const value of [prepared, prepared.packages, prepared.packageVersions]) assert.ok(Object.isFrozen(value));
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].executable, fixture.rscript);
    assert.equal(fixture.commands[0].environment.R_LIBS, undefined);
    assert.equal(fixture.commands[0].environment.R_PROFILE, undefined);
    assert.equal(prepared.rExecutable, fixture.rExecutable);
    assert.deepEqual(readdirSync(prepared.libraryDir), []);
    for (const command of [prepared.dependencyInstall, prepared.dependencyProbe]) {
      assert.equal(command.input.executable, fixture.rscript);
      assert.equal(command.input.environment.R_LIBS_USER, prepared.libraryDir);
      assert.equal(command.input.environment.HOME, join(prepared.root, "h"));
      assert.equal(command.input.environment.RETAINED, "value");
      assert.equal(command.input.environment.R_LIBS, undefined);
    }
    if (scope !== "terminal") {
      const kernel = JSON.parse(readFileSync(prepared.kernelSpecPath, "utf8"));
      assert.deepEqual(kernel.argv, [fixture.rscript, "--vanilla", prepared.kernelBootstrapPath, "{connection_file}"]);
      assert.equal(kernel.env.R_LIBS_USER, prepared.libraryDir);
    }
    assert.equal(prepared.jupyterEnvironment.rscriptPath, fixture.rscript);
    assert.equal(prepared.jupyterEnvironment.rLibraryDir, prepared.libraryDir);
    assert.equal(prepared.dependencyProbe.options.timeoutMs, 30_000);
    assert.equal(prepared.dependencyInstall.options.timeoutMs, 1_200_000);
    assert.ok(Object.isFrozen(R_ACCEPTANCE_PACKAGE_VERSIONS));
    assert.equal(prepared.packages.includes("bit64"), false);
    await assert.rejects(
      prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, fixture.options),
      /new contained private environment/u
    );
    assert.equal(fixture.commands.length, 1);
  });
}

test("R package records accept console line endings while preserving exact package contents", async (t) => {
  for (const selection of [
    { purpose: "notebook" },
    { purpose: "literate-documents" },
    { purpose: "interactive-terminal" },
    { purpose: "source-contracts" }
  ]) {
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      ...selection
    });
    const record = prepared.packageRecord;
    const lines = record.split("\n");
    assert.equal(rAcceptancePackageRecordMatches(record, record), true);
    assert.equal(rAcceptancePackageRecordMatches(record.replaceAll("\n", "\r\n"), record), true);
    for (const [description, output] of [
      ["bare carriage returns", record.replaceAll("\n", "\r")],
      ["leading output", `unexpected\n${record}`],
      ["trailing output", `${record}\nunexpected`],
      ["trailing LF", `${record}\n`],
      ["trailing CRLF", `${record.replaceAll("\n", "\r\n")}\r\n`],
      ["wrong version", `${lines[0]}0\n${lines.slice(1).join("\n")}`],
      ["omitted package", lines.slice(1).join("\n")],
      ["reordered packages", [...lines].reverse().join("\n")]
    ]) {
      assert.equal(rAcceptancePackageRecordMatches(output, record), false, description);
    }
  }
});

test("R install timings expose only bounded fixed stages and omit ambiguous records", () => {
  assert.deepEqual(
    rAcceptanceInstallTimings(
      "private package output\nOPEN_WRANGLER_R_INSTALL:core:0\r\n" +
        "OPEN_WRANGLER_R_INSTALL:supplemental:123\nOPEN_WRANGLER_R_INSTALL:macos-collapse-source:1200000\n"
    ),
    [
      "R acceptance core installation completed in 0 ms.",
      "R acceptance supplemental installation completed in 123 ms.",
      "R acceptance macos-collapse-source installation completed in 1200000 ms."
    ]
  );
  for (const value of ["-1", "+1", "01", "1.5", "1e3", "NaN", "Inf", "1200001", "12345678", "7 private"]) {
    assert.deepEqual(rAcceptanceInstallTimings(`OPEN_WRANGLER_R_INSTALL:core:${value}\n`), []);
  }
  assert.deepEqual(
    rAcceptanceInstallTimings(
      "OPEN_WRANGLER_R_INSTALL:unknown:1\n leading OPEN_WRANGLER_R_INSTALL:core:1\n" +
        "OPEN_WRANGLER_R_INSTALL:core:1\nOPEN_WRANGLER_R_INSTALL:core:2\nOPEN_WRANGLER_R_INSTALL:core:3\n" +
        "OPEN_WRANGLER_R_INSTALL:supplemental:4\n"
    ),
    ["R acceptance supplemental installation completed in 4 ms."]
  );
  const record = "\nOPEN_WRANGLER_R_INSTALL:core:1\n";
  const limit = 1024 * 1024;
  assert.equal(rAcceptanceInstallTimings("x".repeat(limit - record.length) + record).length, 1);
  for (const value of [undefined, null, {}, "x".repeat(limit) + record, "é".repeat(limit / 2) + record]) {
    assert.deepEqual(rAcceptanceInstallTimings(value), []);
  }
});

test("invalid R preparation purposes fail before commands or private directories", async (t) => {
  const fixture = provisioning(t);
  for (const purpose of [null, false, true, 0, 1, "", "terminal", "unknown", [], {}]) {
    await assert.rejects(
      prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
        ...fixture.options,
        purpose
      }),
      /preparation purpose/u
    );
    assert.equal(fixture.commands.length, 0);
    assert.equal(existsSync(fixture.directory), false);
  }
});

test("all R package scopes require the caller's contained private directory", async (t) => {
  const fixture = provisioning(t);
  const other = provisioning(t);
  for (const selection of [
    { purpose: "notebook" },
    { purpose: "literate-documents" },
    { purpose: "interactive-terminal" },
    { purpose: "source-contracts" }
  ]) {
    await assert.rejects(
      prepareJupyterAcceptanceREnvironment(other.directory, fixture.rscript, {
        ...fixture.options,
        ...selection
      }),
      /inside its caller-owned root/u
    );
    assert.equal(fixture.commands.length, 0);
    assert.equal(existsSync(other.directory), false);
  }
});

for (const platform of ["linux", "darwin", "win32"]) {
  test(`source R contracts prepare only their private dependencies on ${platform}`, async (t) => {
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      purpose: "source-contracts",
      platform
    });
    const packages = ["jsonlite", "bit64"];
    const versions = Object.fromEntries(packages.map((name) => [name, R_ACCEPTANCE_PACKAGE_VERSIONS[name]]));
    assert.deepEqual(prepared.packages, packages);
    assert.equal(versions.bit64, "4.6.0.1");
    assert.deepEqual(preparedPackageInputs(prepared), { packages, versions });
    assert.deepEqual(prepared.packageVersions, versions);
    assert.equal(prepared.packageRecord, packages.map((name) => `${name}=${versions[name]}`).join("\n"));
    for (const value of [prepared, prepared.packages, prepared.packageVersions]) assert.ok(Object.isFrozen(value));
    assert.deepEqual(readdirSync(prepared.root).sort(), ["h", "l", "t"]);
    assert.equal(prepared.jupyterEnvironment, undefined);
    assert.equal(prepared.kernelSpecPath, undefined);
    assert.equal(prepared.rExecutable, fixture.rExecutable);
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].executable, fixture.rscript);
    for (const command of [prepared.dependencyInstall, prepared.dependencyProbe]) {
      assert.equal(command.input.executable, fixture.rscript);
      assert.equal(command.input.environment.R_LIBS_USER, prepared.libraryDir);
      assert.equal(command.input.environment.HOME, join(prepared.root, "h"));
      for (const key of ["TMPDIR", "TMP", "TEMP"])
        assert.equal(command.input.environment[key], join(prepared.root, "t"));
      assert.equal(command.input.environment.RETAINED, "value");
      assert.equal(command.input.environment.R_LIBS, undefined);
      assert.equal(command.input.environment.R_PROFILE, undefined);
    }
    const repositories = rAcceptanceRepositories(platform);
    assert.equal(prepared.repository, repositories.repository);
    assert.equal(prepared.supplementalRepository, repositories.supplementalRepository);
    const install = commandCode(prepared.dependencyInstall);
    assert.match(install, /\.ow_supplemental_packages <- c\(\)/u);
    assert.match(install, /\.ow_binary_supplemental_packages <- c\(\)/u);
    assert.equal(install.match(/utils::install\.packages\(/gu)?.length, 1);
    assert.equal(install.includes('"nanoparquet"'), false);
    assert.equal(install.includes('"collapse"'), false);
    assert.equal(install.includes('type = "source"'), false);
    assert.equal(install.includes("-j2"), false);
    assert.match(install, /dependencies = NA/u);
    const probe = commandCode(prepared.dependencyProbe);
    assert.match(probe, /find\.package\(\.ow_package, lib.loc = \.ow_library, quiet = TRUE\)/u);
    assert.match(probe, /loadNamespace\(\.ow_package, lib.loc = \.ow_library\)/u);
    for (const status of [10, 11, 12]) assert.ok(probe.includes(`status = ${status}L`));
    assert.equal(probe.includes("collapse::"), false);
    await assert.rejects(
      probeJupyterAcceptanceRKernel(fixture.rscript, prepared, { runCommand: fixture.options.runCommand }),
      /exact prepared private environment/u
    );
    assert.equal(fixture.commands.length, 1);
  });
}

test("all R journey selectors retain their existing local and tooling boundaries", () => {
  const common = {
    acceptanceMode: "r-jupyter",
    requestedEditors: ["vscode"],
    remoteJupyterEnabled: false,
    platform: "linux"
  };
  for (const selector of [
    undefined,
    "core-operations",
    "categorical-operations",
    "value-operations",
    "pivot-wider",
    "kernel-restart",
    "native-frames",
    "interactive-terminal",
    "literate-documents"
  ]) {
    const selected = resolvePackagedRJourneySelection({ ...common, selector });
    assert.equal(selected.local, true);
    assert.equal(
      selected.nativeEditorTooling,
      selector === "interactive-terminal" || selector === "literate-documents"
    );
    assert.equal(selected.literateDocuments, selector === "literate-documents");
  }
  assert.equal(
    resolvePackagedRJourneySelection({ ...common, selector: "remote-r-jupyter", remoteJupyterEnabled: true }).local,
    false
  );
  assert.equal(resolvePackagedRJourneySelection({ ...common, acceptanceMode: "full" }).local, false);
  for (const options of [
    { selector: "unknown" },
    { selector: "core-operations", acceptanceMode: "full" },
    { selector: "core-operations", remoteJupyterEnabled: true },
    { selector: "remote-r-jupyter" }
  ])
    assert.throws(() => resolvePackagedRJourneySelection({ ...common, ...options }));
});

test("invalid literate tooling scope fails before artifact or command work", async (t) => {
  const fixture = provisioning(t);
  let attempts = 0;
  for (const literateDocuments of [null, 0, 1, "false", [], {}]) {
    await assert.rejects(
      prepareREditorAcceptanceTooling(fixture.root, {
        literateDocuments,
        onArtifactAttempt() {
          attempts += 1;
          throw new Error("Unexpected artifact acquisition.");
        },
        runCommand: fixture.options.runCommand
      }),
      /boolean literate documents decision/u
    );
    assert.equal(attempts, 0);
    assert.equal(fixture.commands.length, 0);
    assert.deepEqual(readdirSync(fixture.root).sort(), ["R", "Rscript"]);
  }
});

test("notebook roots retain supplemental installs and private dependency refusals on each platform", async (t) => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      purpose: "notebook",
      platform
    });
    const repositories = rAcceptanceRepositories(platform);
    assert.equal(prepared.repository, repositories.repository);
    assert.equal(prepared.supplementalRepository, repositories.supplementalRepository);
    const install = commandCode(prepared.dependencyInstall);
    assert.match(install, /\.ow_supplemental_packages <- c\("collapse", "nanoparquet"\)/u);
    assert.equal(install.includes('type = "source"'), platform === "darwin");
    assert.match(
      install,
      platform === "darwin"
        ? /\.ow_binary_supplemental_packages <- c\("nanoparquet"\)/u
        : /\.ow_binary_supplemental_packages <- c\("collapse", "nanoparquet"\)/u
    );
    const serialMake = 'Sys.setenv(MAKEFLAGS = "-s")';
    const parallelMake = 'Sys.setenv(MAKEFLAGS = "-s -j2")';
    assert.equal(install.split("\n")[0], serialMake);
    assert.deepEqual(
      install.split("\n").filter((line) => line.startsWith("Sys.setenv(MAKEFLAGS")),
      platform === "darwin" ? [serialMake, parallelMake] : [serialMake]
    );
    if (platform === "darwin") {
      const collapseStart = install.indexOf(`${parallelMake}\nutils::install.packages(\n  "collapse",`);
      assert.notEqual(collapseStart, -1);
      assert.equal(install.slice(0, collapseStart).match(/utils::install\.packages\(/gu)?.length, 2);
      assert.equal(install.slice(collapseStart).match(/utils::install\.packages\(/gu)?.length, 1);
    }
    assert.match(install, /dependencies = NA/u);
    const probe = commandCode(prepared.dependencyProbe);
    assert.match(probe, /find\.package\(.ow_package, lib.loc = .ow_library, quiet = TRUE\)/u);
    assert.match(probe, /loadNamespace\(.ow_package, lib.loc = .ow_library\)/u);
    for (const status of [10, 11, 12, 13, 14, 15, 16, 17]) assert.ok(probe.includes(`status = ${status}L`));
    for (const factory of ["qDF", "qTBL", "qDT", "fgroup_by", "findex_by"])
      assert.ok(probe.includes(`collapse::${factory}(`));
  }
});

test("terminal preparation keeps native R ownership without a kernel on each platform", async (t) => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      purpose: "interactive-terminal",
      platform
    });
    const install = commandCode(prepared.dependencyInstall);
    assert.match(install, /\.ow_supplemental_packages <- c\("nanoparquet"\)/u);
    assert.match(install, /\.ow_binary_supplemental_packages <- c\("nanoparquet"\)/u);
    assert.equal(install.includes('"collapse"'), false);
    assert.equal(install.includes('"Rcpp"'), false);
    assert.equal(install.includes('"IRkernel"'), false);
    assert.equal(install.includes('"rmarkdown"'), false);
    assert.equal(install.includes('type = "source"'), false);
    assert.deepEqual(
      install.split("\n").filter((line) => line.startsWith("Sys.setenv(MAKEFLAGS")),
      ['Sys.setenv(MAKEFLAGS = "-s")']
    );
    assert.equal(install.match(/utils::install\.packages\(/gu)?.length, 2);
    assert.match(install, /dependencies = NA/u);
    const probe = commandCode(prepared.dependencyProbe);
    assert.equal(probe.includes("collapse::"), false);
    assert.match(probe, /find\.package\(.ow_package, lib.loc = .ow_library, quiet = TRUE\)/u);
    assert.match(probe, /loadNamespace\(.ow_package, lib.loc = .ow_library\)/u);
    for (const status of [10, 11, 12]) assert.ok(probe.includes(`status = ${status}L`));
    assert.equal(prepared.rExecutable, fixture.rExecutable);
    assert.deepEqual(prepared.jupyterEnvironment, {
      dataDir: join(prepared.root, "d"),
      runtimeDir: join(prepared.root, "r"),
      configDir: join(prepared.root, "c"),
      path: join(prepared.root, "p"),
      rscriptPath: fixture.rscript,
      rLibraryDir: prepared.libraryDir
    });
    assert.ok(Object.isFrozen(prepared.jupyterEnvironment));
    assert.deepEqual(readdirSync(prepared.root).sort(), ["c", "d", "h", "l", "p", "r", "t"]);
    for (const directory of readdirSync(prepared.root)) {
      assert.deepEqual(readdirSync(join(prepared.root, directory)), []);
    }
    for (const key of [
      "kernelId",
      "kernelSpecPath",
      "kernelBootstrapPath",
      "kernelBootstrapStagePath",
      "kernelProbeWorkingDirectory"
    ]) {
      assert.equal(Object.hasOwn(prepared, key), false);
    }
    await assert.rejects(
      probeJupyterAcceptanceRKernel(fixture.rscript, prepared, { runCommand: fixture.options.runCommand }),
      /exact prepared private environment/u
    );
    assert.equal(fixture.commands.length, 1);
    assert.throws(() => jupyterAcceptanceRKernelBootstrapStage(prepared), /exact prepared environment/u);
  }
});

test("the selected R environment retains exact bootstrap ownership through readiness", async (t) => {
  const fixture = provisioning(t);
  const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
    ...fixture.options,
    purpose: "notebook"
  });
  let probes = 0;
  const runCommand = async (input) => {
    probes += 1;
    assert.equal(input.environment.R_LIBS_USER, prepared.libraryDir);
    assert.equal(input.args[4], prepared.kernelSpecPath);
    appendFileSync(prepared.kernelBootstrapStagePath, "entered\nlibrary-ready\nirkernel-loaded\nmain-entered\n");
    return { stdout: "OPEN_WRANGLER_R_KERNEL_READY\n", stderr: "" };
  };
  await assert.rejects(
    probeJupyterAcceptanceRKernel(fixture.rscript, { ...prepared }, { runCommand }),
    /exact prepared environment/u
  );
  assert.equal(probes, 0);
  await probeJupyterAcceptanceRKernel(fixture.rscript, prepared, { runCommand });
  assert.equal(jupyterAcceptanceRKernelBootstrapStage(prepared), "not-entered");
  assert.equal(probes, 1);
  rmSync(prepared.kernelBootstrapStagePath);
  mkdirSync(prepared.kernelBootstrapStagePath);
  await assert.rejects(
    probeJupyterAcceptanceRKernel(fixture.rscript, prepared, { runCommand }),
    /bootstrap stage|identity/u
  );
  assert.equal(probes, 1);
});
