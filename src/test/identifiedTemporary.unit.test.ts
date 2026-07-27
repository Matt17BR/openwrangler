import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeIdentifiedTemporary } from "./extensionHost/identifiedTemporary";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("identified fragment temporary cleanup", () => {
  it("withholds cleanup after path substitution and retains the replacement", () => {
    const root = join(tmpdir(), `ow-fragment-cleanup-${process.pid}-${randomUUID()}`);
    roots.push(root);
    mkdirSync(root, { mode: 0o700 });
    const temporary = join(root, "fragment.tmp");
    const retained = join(root, "retained.tmp");
    writeFileSync(temporary, "owned temporary", { flag: "wx", mode: 0o600 });
    const identity = lstatSync(temporary, { bigint: true });
    renameSync(temporary, retained);
    writeFileSync(temporary, "replacement must survive", { flag: "wx", mode: 0o600 });

    expect(() => removeIdentifiedTemporary(temporary, identity)).toThrow(
      /cleanup was withheld after an identity change/u
    );
    expect(readFileSync(temporary, "utf8")).toBe("replacement must survive");
    expect(readFileSync(retained, "utf8")).toBe("owned temporary");
  });
});
