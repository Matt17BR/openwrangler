import { describe, expect, it } from "vitest";
import {
  releasedNotebookExecutionFailureMessage,
  releasedNotebookOutputClassification
} from "./extensionHost/releasedNotebookFailure";

describe("released notebook failure diagnostics", () => {
  it("classifies notebook errors without retaining raw MIME data, ANSI, paths, or credentials", () => {
    const privateMaterial = "\u001b[31m/tmp/private/profile token=do-not-retain -----BEGIN PRIVATE KEY-----\u001b[0m";
    const outputs = [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: Buffer.from(privateMaterial)
          }
        ]
      }
    ];

    expect(releasedNotebookOutputClassification(outputs)).toBe("notebook-error-output");
    const message = releasedNotebookExecutionFailureMessage(1, outputs);
    expect(message).toBe("Released-Jupyter cell 1 failed (notebook-error-output).");
    expect(message).not.toContain(privateMaterial);
    expect(message).not.toContain("token");
    expect(message).not.toContain("\u001b");
  });

  it("returns one fixed printable classification when no notebook-error item exists", () => {
    const outputs = [
      {
        items: [
          {
            mime: "text/plain",
            data: Buffer.from("arbitrary output")
          }
        ]
      }
    ];
    expect(releasedNotebookOutputClassification(outputs)).toBe("no-notebook-error-output");
    expect(releasedNotebookExecutionFailureMessage(0, outputs)).toBe(
      "Released-Jupyter cell 0 failed (no-notebook-error-output)."
    );
  });
});
