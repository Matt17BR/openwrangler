import { describe, expect, it } from "vitest";
import {
  releasedNotebookErrorDiagnostic,
  releasedNotebookExecutionFailureMessage,
  releasedNotebookOutputClassification,
  releasedNotebookRSetupFailureStage
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

  it("reports only a fixed R parse category and bounded location", () => {
    const privateMaterial = "/tmp/private token=do-not-retain -----BEGIN PRIVATE KEY-----";
    const outputs = [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: Buffer.from(
              JSON.stringify({
                name: `attacker-controlled ${privateMaterial}`,
                message: "Error in parse(text = code): <text>:42:7: unexpected end of input",
                stack: `source line and ${privateMaterial}`
              }),
              "utf8"
            )
          }
        ]
      }
    ];

    expect(releasedNotebookErrorDiagnostic(outputs)).toBe("R parse error at 42:7 (unexpected end of input)");
    const message = releasedNotebookExecutionFailureMessage(0, outputs);
    expect(message).toBe(
      "Released-Jupyter cell 0 failed (notebook-error-output; R parse error at 42:7 (unexpected end of input))."
    );
    expect(message).not.toContain(privateMaterial);
    expect(message).not.toContain("source line");
  });

  it("recognizes fixed kernel, cancellation, dependency, and native-load failures", () => {
    const error = (message: string) => [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: Buffer.from(JSON.stringify({ name: "ERROR", message }), "utf8")
          }
        ]
      }
    ];

    expect(releasedNotebookErrorDiagnostic(error("The kernel died while waiting for a reply."))).toBe("kernel stopped");
    expect(releasedNotebookErrorDiagnostic(error("Execution was cancelled."))).toBe("execution cancelled");
    expect(releasedNotebookErrorDiagnostic(error("there is no package called ‘collapse’"))).toBe(
      "missing R package collapse"
    );
    expect(releasedNotebookErrorDiagnostic(error("DLL load failed while loading a package"))).toBe(
      "R package failed to load"
    );
  });

  it.each([
    [
      "\u001b[1;31mFailed to start the Kernel 'R (Open Wrangler)'. View Jupyter log for further details.",
      "kernel failed to start"
    ],
    [
      "Unable to start Kernel 'R (Open Wrangler)' due to a connection timeout. View Jupyter log for further details.",
      "kernel connection timed out"
    ],
    [
      "Unable to start Kernel 'R (Open Wrangler)' due to a timeout waiting for the ports to get used.",
      "kernel port wait timed out"
    ],
    [
      "The kernel 'R (Open Wrangler)' was not started as it is located in an insecure location '/tmp/private'.",
      "kernel spec not trusted"
    ],
    [
      "Connection file not found in kernelspec json args: /tmp/private/kernel.json",
      "kernel spec missing connection file"
    ],
    ["The kernel 'R (Open Wrangler)' died. View Jupyter log for further details.", "kernel stopped"],
    ["Cannot execute code, session has been disposed.", "kernel session disposed"],
    ["SyntaxError: invalid syntax at /tmp/private/script.py", "kernel language mismatch"]
  ])("classifies a Jupyter stack without exposing its contents: %s", (stack, expected) => {
    const privateMaterial = "/tmp/private token=do-not-retain -----BEGIN PRIVATE KEY-----";
    const outputs = [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: Buffer.from(JSON.stringify({ name: "", message: "", stack: `${stack}\n${privateMaterial}` }), "utf8")
          }
        ]
      }
    ];

    expect(releasedNotebookErrorDiagnostic(outputs)).toBe(expected);
    const message = releasedNotebookExecutionFailureMessage(0, outputs);
    expect(message).toBe(`Released-Jupyter cell 0 failed (notebook-error-output; ${expected}).`);
    expect(message).not.toContain(privateMaterial);
    expect(message).not.toContain("\u001b");
  });

  it("falls back to the opaque classification for malformed, oversized, unknown, or conflicting errors", () => {
    const item = (data: Buffer) => ({ mime: "application/vnd.code.notebook.error", data });
    const unknown = item(Buffer.from(JSON.stringify({ name: "Error", message: "secret=/tmp/private" }), "utf8"));
    expect(releasedNotebookErrorDiagnostic([{ items: [item(Buffer.from("not json", "utf8"))] }])).toBeUndefined();
    expect(releasedNotebookErrorDiagnostic([{ items: [item(Buffer.alloc(16 * 1024 + 1, 0x78))] }])).toBeUndefined();
    expect(
      releasedNotebookErrorDiagnostic([
        {
          items: [item(Buffer.from(JSON.stringify({ name: "", message: "", stack: 42 }), "utf8"))]
        }
      ])
    ).toBeUndefined();
    expect(
      releasedNotebookErrorDiagnostic([
        {
          items: [
            item(Buffer.from(JSON.stringify({ name: "", message: "", stack: "x".repeat(16 * 1024 + 1) }), "utf8"))
          ]
        }
      ])
    ).toBeUndefined();
    expect(releasedNotebookErrorDiagnostic([{ items: [unknown] }])).toBeUndefined();
    expect(
      releasedNotebookErrorDiagnostic([
        {
          items: [
            item(Buffer.from(JSON.stringify({ name: "Error", message: "<text>:2:1: unexpected symbol" }), "utf8")),
            item(Buffer.from(JSON.stringify({ name: "Error", message: "The kernel stopped." }), "utf8"))
          ]
        }
      ])
    ).toBeUndefined();
    expect(releasedNotebookExecutionFailureMessage(0, [{ items: [unknown] }])).toBe(
      "Released-Jupyter cell 0 failed (notebook-error-output)."
    );
  });

  it("retains one allowlisted R setup stage split across bounded stream items", () => {
    const outputs = [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.stderr",
            data: Buffer.from("OPEN_WRANGLER_R_SETUP_", "utf8")
          },
          {
            mime: "application/vnd.code.notebook.stderr",
            data: Buffer.from("FAILED:collapse-load\n", "utf8")
          },
          {
            mime: "application/vnd.code.notebook.error",
            data: Buffer.from("/tmp/private token=do-not-retain", "utf8")
          }
        ]
      }
    ];

    const stage = releasedNotebookRSetupFailureStage(outputs);
    expect(stage).toBe("collapse-load");
    const message = releasedNotebookExecutionFailureMessage(0, outputs, stage);
    expect(message).toBe("Released-Jupyter cell 0 failed (notebook-error-output; R setup stage collapse-load).");
    expect(message).not.toContain("/tmp/private");
    expect(message).not.toContain("token");
  });

  it("extracts one repeated allowlisted stage from a bounded notebook error without retaining its payload", () => {
    const privateMaterial = "/tmp/private token=do-not-retain";
    const marker = "OPEN_WRANGLER_R_SETUP_FAILED:collapse-data-frame";
    const outputs = [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: Buffer.from(
              JSON.stringify({
                message: `Error: ${marker}`,
                stack: `${marker}\n${privateMaterial}`
              }),
              "utf8"
            )
          }
        ]
      }
    ];

    const stage = releasedNotebookRSetupFailureStage(outputs);
    expect(stage).toBe("collapse-data-frame");
    const message = releasedNotebookExecutionFailureMessage(0, outputs, stage);
    expect(message).toBe("Released-Jupyter cell 0 failed (notebook-error-output; R setup stage collapse-data-frame).");
    expect(message).not.toContain(privateMaterial);
    expect(message).not.toContain("token");
  });

  it("accepts only structurally bounded R setup markers", () => {
    const stream = (text: string) => [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.stderr",
            data: Buffer.from(text, "utf8")
          }
        ]
      }
    ];

    expect(releasedNotebookRSetupFailureStage(stream("OPEN_WRANGLER_R_SETUP_FAILED:unknown\n"))).toBeUndefined();
    expect(
      releasedNotebookRSetupFailureStage(
        stream("OPEN_WRANGLER_R_SETUP_FAILED:tibble\nOPEN_WRANGLER_R_SETUP_FAILED:data-table\n")
      )
    ).toBeUndefined();
    expect(
      releasedNotebookRSetupFailureStage(stream("OPEN_WRANGLER_R_SETUP_FAILED:tibble secret=/tmp/private\n"))
    ).toBeUndefined();
    expect(releasedNotebookRSetupFailureStage(stream("XOPEN_WRANGLER_R_SETUP_FAILED:tibble\n"))).toBeUndefined();
    expect(releasedNotebookRSetupFailureStage(stream("OPEN_WRANGLER_R_SETUP_FAILED:tibble\\u0065vil"))).toBeUndefined();
    expect(releasedNotebookRSetupFailureStage(stream("OPEN_WRANGLER_R_SETUP_FAILED:tibble\\tprivate"))).toBeUndefined();
    expect(releasedNotebookRSetupFailureStage(stream("OPEN_WRANGLER_R_SETUP_FAILED:tibble\\n"))).toBe("tibble");
    expect(releasedNotebookRSetupFailureStage(stream('"OPEN_WRANGLER_R_SETUP_FAILED:tibble"'))).toBe("tibble");
  });

  it("rejects R setup output outside the item and byte bounds", () => {
    const tooManyItems = [
      {
        items: Array.from({ length: 33 }, (_, index) => ({
          mime: "application/vnd.code.notebook.stderr",
          data: Buffer.from(index === 0 ? "OPEN_WRANGLER_R_SETUP_FAILED:tibble\n" : "x", "utf8")
        }))
      }
    ];
    const tooManyBytes = [
      {
        items: [
          {
            mime: "application/vnd.code.notebook.stderr",
            data: Buffer.concat([
              Buffer.from("OPEN_WRANGLER_R_SETUP_FAILED:tibble\n", "utf8"),
              Buffer.alloc(16 * 1024, 0x78)
            ])
          }
        ]
      }
    ];

    expect(releasedNotebookRSetupFailureStage(tooManyItems)).toBeUndefined();
    expect(releasedNotebookRSetupFailureStage(tooManyBytes)).toBeUndefined();
  });
});
