import { describe, expect, it, vi } from "vitest";
import {
  packagedGridCopyShortcut,
  runPackagedGridRangeCopyLifecycle,
  runWithPackagedGridClipboardRestoration,
  waitForPackagedGridClipboard
} from "./extensionHost/packagedGridRangeCopyJourney";

describe("packaged grid range-copy journey", () => {
  it("routes the platform copy modifier without guessing from the editor brand", () => {
    expect(packagedGridCopyShortcut("darwin")).toBe("Meta+c");
    expect(packagedGridCopyShortcut("linux")).toBe("Control+c");
    expect(packagedGridCopyShortcut("win32")).toBe("Control+c");
  });

  it.each([
    { cleanupFailed: false, productFailed: true },
    { cleanupFailed: true, productFailed: false },
    { cleanupFailed: true, productFailed: true }
  ])(
    "uses one privacy-safe structural envelope when product=$productFailed cleanup=$cleanupFailed",
    async ({ cleanupFailed, productFailed }) => {
      const productSecret = "private-product-clipboard-sentinel";
      const expectedSecret = "private-expected-clipboard-sentinel";
      const cleanupSecret = "private-cleanup-clipboard-sentinel";
      const productFailure = Object.assign(new Error("clipboard mismatch"), {
        actual: productSecret,
        expected: expectedSecret
      });
      let failure: unknown;
      try {
        await runPackagedGridRangeCopyLifecycle(
          async () => {
            if (productFailed) throw productFailure;
          },
          async () => {
            if (cleanupFailed) throw new Error(cleanupSecret);
          }
        );
      } catch (error) {
        failure = error;
      }

      const record = failure as Error & { cleanupFailed?: boolean; productFailed?: boolean };
      const expectedMessage = `The packaged grid range-copy journey failed. Product stage: ${productFailed ? "failed" : "passed"}; cleanup stage: ${cleanupFailed ? "failed" : "passed"}; clipboard text retained: no.`;
      expect({
        cleanupFailed: record?.cleanupFailed,
        isAggregate: failure instanceof AggregateError,
        messageMatches: record?.message === expectedMessage,
        name: record?.name,
        productFailed: record?.productFailed,
        retainsClipboardText: diagnosticRetainsAny(failure, [productSecret, expectedSecret, cleanupSecret])
      }).toEqual({
        cleanupFailed,
        isAggregate: false,
        messageMatches: true,
        name: "PackagedGridRangeCopyFailure",
        productFailed,
        retainsClipboardText: false
      });
    }
  );

  it("always performs bounded cleanup and reports a structural product failure", async () => {
    const journeyFailure = new Error("pointer assertion failed");
    const calls: string[] = [];

    let failure: unknown;
    try {
      await runPackagedGridRangeCopyLifecycle(
        async () => {
          calls.push("exercise");
          throw journeyFailure;
        },
        async () => {
          calls.push("cleanup");
        }
      );
    } catch (error) {
      failure = error;
    }
    expect(calls).toEqual(["exercise", "cleanup"]);
    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
  });

  it("reports combined product and cleanup failure without retaining either child", async () => {
    const journeyFailure = new Error("clipboard assertion failed");
    const cleanupFailure = new Error("session cleanup failed");
    let failure: unknown;
    try {
      await runPackagedGridRangeCopyLifecycle(
        async () => {
          throw journeyFailure;
        },
        async () => {
          throw cleanupFailure;
        }
      );
      expect.unreachable("The lifecycle must report both failures.");
    } catch (error) {
      failure = error;
    }
    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, true));
  });

  it("publishes the fixed structural envelope in the actual packaged result error field", async () => {
    const productFailure = new Error(`pointer assertion failed ${"p".repeat(2_048)}`);
    const cleanupFailure = new Error(`session cleanup failed ${"c".repeat(2_048)}`);

    try {
      await runPackagedGridRangeCopyLifecycle(
        async () => {
          throw productFailure;
        },
        async () => {
          throw cleanupFailure;
        }
      );
      expect.unreachable("The lifecycle must publish its bounded result diagnostic.");
    } catch (error) {
      const resultEnvelope = {
        protocol: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        phase: "platform-smoke",
        ok: false,
        error: error instanceof Error ? error.message : "Non-Error failure."
      };
      const decoded = JSON.parse(JSON.stringify(resultEnvelope)) as typeof resultEnvelope;

      expect({
        bounded: new TextEncoder().encode(decoded.error).byteLength <= 2 * 1024,
        messageMatches: decoded.error === packagedFailureMessage(true, true),
        retainsChildText: decoded.error.includes("p".repeat(512)) || decoded.error.includes("c".repeat(512))
      }).toEqual({ bounded: true, messageMatches: true, retainsChildText: false });
    }
  });

  it("reports a cleanup-only failure after a successful journey", async () => {
    const cleanupFailure = new Error("cleanup failed");
    let failure: unknown;
    try {
      await runPackagedGridRangeCopyLifecycle(
        async () => undefined,
        async () => {
          throw cleanupFailure;
        }
      );
    } catch (error) {
      failure = error;
    }
    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(false, true));
  });

  it("reports product and clipboard restoration failures without retaining either child", async () => {
    const productFailure = new Error("context-menu payload assertion failed");
    const restorationFailure = new Error("host clipboard restoration failed");
    const hostClipboard = {
      readText: vi.fn(async () => "prior clipboard"),
      writeText: vi.fn(async () => {
        throw restorationFailure;
      })
    };

    let failure: unknown;
    try {
      await runWithPackagedGridClipboardRestoration(hostClipboard, async () => {
        throw productFailure;
      });
      expect.unreachable("The production clipboard-restoration helper must report both failures.");
    } catch (error) {
      failure = error;
    }
    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, true));
    expect(hostClipboard.readText).toHaveBeenCalledTimes(1);
    expect(hostClipboard.writeText).toHaveBeenCalledExactlyOnceWith("prior clipboard");
  });

  it("wraps a secret-bearing initial clipboard rejection before it can escape the privacy lifecycle", async () => {
    const clipboardSecret = "private-initial-read-clipboard-sentinel";
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => {
        throw Object.assign(new Error("initial clipboard read rejected"), { actual: clipboardSecret });
      }),
      writeText: vi.fn(async () => undefined)
    };

    let failure: unknown;
    try {
      await runWithPackagedGridClipboardRestoration(hostClipboard, exercise);
    } catch (error) {
      failure = error;
    }

    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
    expect(diagnosticRetainsAny(failure, [clipboardSecret])).toBe(false);
    expect(exercise).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("restores the prior clipboard after a successful packaged journey", async () => {
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => "prior clipboard"),
      writeText: vi.fn(async () => undefined)
    };

    await runWithPackagedGridClipboardRestoration(hostClipboard, exercise);

    expect(exercise).toHaveBeenCalledTimes(1);
    expect(hostClipboard.writeText).toHaveBeenCalledExactlyOnceWith("prior clipboard");
  });

  it("bounds an oversized concurrent clipboard replacement before polling can normalize or retain it", async () => {
    const oversizedObserved = "private-polling-clipboard-sentinel".repeat(140_000);
    const hostClipboard = {
      readText: vi.fn().mockResolvedValueOnce("pending").mockResolvedValueOnce(oversizedObserved),
      writeText: vi.fn(async () => undefined)
    };

    let failure: unknown;
    try {
      await waitForPackagedGridClipboard(hostClipboard, "expected range");
    } catch (error) {
      failure = error;
    }

    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
    expect(diagnosticRetainsAny(failure, ["private-polling-clipboard-sentinel"])).toBe(false);
    expect(hostClipboard.readText).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-string prior clipboard value before the packaged journey can mutate it", async () => {
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => 42 as unknown as string),
      writeText: vi.fn(async () => undefined)
    };

    let failure: unknown;
    try {
      await runWithPackagedGridClipboardRestoration(hostClipboard, exercise);
    } catch (error) {
      failure = error;
    }

    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
    expect(hostClipboard.readText).toHaveBeenCalledTimes(1);
    expect(exercise).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("rejects an oversized prior clipboard value before the packaged journey can mutate it", async () => {
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => "x".repeat(4 * 1024 * 1024 + 1)),
      writeText: vi.fn(async () => undefined)
    };

    let failure: unknown;
    try {
      await runWithPackagedGridClipboardRestoration(hostClipboard, exercise);
    } catch (error) {
      failure = error;
    }

    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
    expect(hostClipboard.readText).toHaveBeenCalledTimes(1);
    expect(exercise).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });
});

function diagnosticRetainsAny(value: unknown, needles: readonly string[]): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (typeof current === "string") {
      if (needles.some((needle) => current.includes(needle))) return true;
      continue;
    }
    if (!(current instanceof Error)) continue;
    const assertionLike = current as Error & { actual?: unknown; expected?: unknown };
    pending.push(current.name, current.message, current.cause, assertionLike.actual, assertionLike.expected);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

function packagedFailureMessage(productFailed: boolean, cleanupFailed: boolean): string {
  return `The packaged grid range-copy journey failed. Product stage: ${productFailed ? "failed" : "passed"}; cleanup stage: ${cleanupFailed ? "failed" : "passed"}; clipboard text retained: no.`;
}

function packagedFailureShape(value: unknown) {
  const record = value as Error & { cleanupFailed?: boolean; productFailed?: boolean };
  return {
    cleanupFailed: record?.cleanupFailed,
    isAggregate: value instanceof AggregateError,
    messageMatches:
      typeof record?.productFailed === "boolean" &&
      typeof record.cleanupFailed === "boolean" &&
      record.message === packagedFailureMessage(record.productFailed, record.cleanupFailed),
    name: record?.name,
    productFailed: record?.productFailed
  };
}

function expectedPackagedFailureShape(productFailed: boolean, cleanupFailed: boolean) {
  return {
    cleanupFailed,
    isAggregate: false,
    messageMatches: true,
    name: "PackagedGridRangeCopyFailure",
    productFailed
  };
}
