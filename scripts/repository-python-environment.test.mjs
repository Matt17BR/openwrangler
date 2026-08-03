import assert from "node:assert/strict";
import test from "node:test";
import {
  repositoryPythonEnvironment,
  repositoryPythonNoBytecodeEnvironment
} from "./repository-python-environment.mjs";

test("repository Python child environments disable bytecode without case-variant overrides", () => {
  assert.deepEqual(
    repositoryPythonNoBytecodeEnvironment({
      PYTHONDONTWRITEBYTECODE: "0",
      pythondontwritebytecode: "0",
      PYTHONPATH: "/inherited/python",
      KEEP_ME: "yes"
    }),
    {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: "/inherited/python",
      KEEP_ME: "yes"
    }
  );
  assert.deepEqual(
    repositoryPythonEnvironment("/private/python", {
      PYTHONDONTWRITEBYTECODE: "0",
      pythondontwritebytecode: "0",
      PYTHONPATH: "/inherited/python",
      pythonpath: "/case-variant/python",
      KEEP_ME: "yes"
    }),
    {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: "/private/python",
      KEEP_ME: "yes"
    }
  );
});
