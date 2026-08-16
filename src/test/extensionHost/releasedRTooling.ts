import * as assert from "node:assert/strict";

interface ReleasedRToolingExtension {
  readonly packageJSON: Readonly<{ version?: unknown }>;
  readonly isActive: boolean;
  activate(): PromiseLike<unknown>;
}

export interface ReleasedRToolingDependencies {
  readonly getExtension: (id: string) => ReleasedRToolingExtension | undefined;
  readonly getCommands: () => PromiseLike<readonly string[]>;
  readonly getConfiguration: <T>(section: string, key: string) => T | undefined;
  readonly pathIsAbsolute: (candidate: string) => boolean;
  readonly pathExists: (candidate: string) => boolean;
  readonly quartoVersion: (executable: string) => string;
  readonly withBoundedPromise: <T>(promise: PromiseLike<T>, timeoutMs: number, description: string) => Promise<T>;
}

const RELEASED_R_TOOLING_EXTENSIONS = [
  ["reditorsupport.r-syntax", "0.1.4"],
  ["reditorsupport.r", "2.8.8"],
  ["quarto.quarto", "1.135.0"]
] as const;

const RELEASED_R_TOOLING_COMMANDS = [
  "r.runSelection",
  "r.runSource",
  "r.knitRmdToHtml",
  "quarto.runCurrentCell",
  "quarto.renderDocument",
  "quarto.preview"
] as const;

export async function assertReleasedNativeREditorTooling(dependencies: ReleasedRToolingDependencies): Promise<boolean> {
  const installed = RELEASED_R_TOOLING_EXTENSIONS.map(([id, version]) => ({
    id,
    version,
    extension: dependencies.getExtension(id)
  }));
  if (installed.every(({ extension }) => extension === undefined)) return false;
  for (const { id, version, extension } of installed) {
    assert.ok(extension, `Packaged R acceptance requires ${id}@${version}.`);
    assert.equal(extension.packageJSON.version, version, `Packaged R acceptance requires ${id}@${version}.`);
  }
  for (const id of ["reditorsupport.r", "quarto.quarto"] as const) {
    const extension = dependencies.getExtension(id);
    assert.ok(extension);
    await dependencies.withBoundedPromise(extension.activate(), 30_000, `activating ${id}`);
    assert.equal(extension.isActive, true, `${id} must activate in the private editor profile.`);
  }
  const commands = new Set(await dependencies.getCommands());
  for (const command of RELEASED_R_TOOLING_COMMANDS) {
    assert.ok(commands.has(command), `The native R/Quarto profile did not register ${command}.`);
  }
  const quarto = dependencies.getConfiguration<string>("quarto", "path");
  assert.ok(
    quarto && dependencies.pathIsAbsolute(quarto) && dependencies.pathExists(quarto),
    "Quarto must use the pinned private CLI."
  );
  assert.equal(
    dependencies.getConfiguration<string>("quarto", "render.previewType"),
    "internal",
    "The native editor journey must keep Quarto previews inside VS Code."
  );
  assert.equal(
    dependencies.getConfiguration<boolean>("quarto", "render.previewReveal"),
    true,
    "The native editor journey must reveal the Quarto preview."
  );
  assert.equal(dependencies.quartoVersion(quarto), "1.10.18", "The native editor journey must use Quarto 1.10.18.");
  return true;
}
