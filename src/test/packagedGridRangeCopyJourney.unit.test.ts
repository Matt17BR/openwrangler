import { describe, expect, it, vi } from "vitest";
import {
  packagedGridCopyShortcut,
  packagedGridClipboardOperationTimeoutMs,
  runPackagedGridClipboardAction,
  runPackagedGridRangeCopyLifecycle,
  validatePackagedGridClipboardSettlementReceipt,
  waitForPackagedGridClipboard,
  waitForPackagedGridClipboardActionAvailability,
  waitForFreshPackagedGridRangeCopySettlement,
  writePackagedGridClipboard
} from "./extensionHost/packagedGridRangeCopyJourney";

describe("packaged grid range-copy journey", () => {
  it("routes the platform copy modifier without guessing from the editor brand", () => {
    expect(packagedGridCopyShortcut("darwin")).toBe("Meta+c");
    expect(packagedGridCopyShortcut("linux")).toBe("Control+c");
    expect(packagedGridCopyShortcut("win32")).toBe("Control+c");
  });

  it("validates the bounded production clipboard settlement receipt", () => {
    expect(validatePackagedGridClipboardSettlementReceipt(settlementReceipt(42, "success"))).toEqual({
      id: 42,
      mode: "range",
      status: "success"
    });
    for (const invalid of [
      settlementReceipt("01", "success"),
      settlementReceipt("9007199254740992", "success"),
      settlementReceipt("2", "complete"),
      { id: "2", mode: "column", status: "success" }
    ]) {
      expect(() => validatePackagedGridClipboardSettlementReceipt(invalid)).toThrowError(
        "The packaged grid range-copy clipboard operation did not complete safely."
      );
    }
  });

  it("binds one newer range receipt and ignores stale success", async () => {
    vi.useFakeTimers();
    try {
      const snapshots = [
        settlementReceipt(8, "success"),
        settlementReceipt(9, "pending"),
        settlementReceipt(9, "success")
      ];
      const readReceipt = vi.fn(async () => snapshots.shift() ?? settlementReceipt(9, "success"));
      const outcome = waitForFreshPackagedGridRangeCopySettlement(readReceipt, 8);

      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toBe(9);
      expect(readReceipt).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retarget from the first newer receipt to another range action", async () => {
    vi.useFakeTimers();
    try {
      const snapshots = [settlementReceipt(21, "success", "cell"), settlementReceipt(22, "success")];
      const readReceipt = vi.fn(async () => snapshots.shift() ?? settlementReceipt(22, "success"));
      let terminal = false;
      void waitForFreshPackagedGridRangeCopySettlement(readReceipt, 20).then(
        () => {
          terminal = true;
        },
        () => {
          terminal = true;
        }
      );

      await vi.advanceTimersByTimeAsync(30_000);

      expect(terminal).toBe(false);
      expect(readReceipt.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a newer failure receipt authorize clipboard inspection", async () => {
    vi.useFakeTimers();
    try {
      const readReceipt = vi
        .fn()
        .mockResolvedValueOnce(settlementReceipt(12, "pending"))
        .mockResolvedValue(settlementReceipt(12, "failure"));
      const outcome = waitForFreshPackagedGridRangeCopySettlement(readReceipt, 11);
      let terminal = false;
      void outcome.then(
        () => {
          terminal = true;
        },
        () => {
          terminal = true;
        }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(terminal).toBe(false);
      await vi.advanceTimersByTimeAsync(25);

      await expect(outcome).rejects.toMatchObject({ name: "PackagedGridClipboardOperationFailure" });
      expect(terminal).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pending or unreadable renderer receipt owned for the outer process deadline", async () => {
    vi.useFakeTimers();
    try {
      const readReceipt = vi
        .fn()
        .mockResolvedValueOnce(settlementReceipt(16, "pending"))
        .mockRejectedValue(new Error("renderer was replaced"));
      let terminal = false;
      void waitForFreshPackagedGridRangeCopySettlement(readReceipt, 15).then(
        () => {
          terminal = true;
        },
        () => {
          terminal = true;
        }
      );

      await vi.advanceTimersByTimeAsync(30_000);

      expect(terminal).toBe(false);
      expect(readReceipt.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch over an exact pre-action pending receipt", async () => {
    vi.useFakeTimers();
    try {
      let currentReceipt = settlementReceipt(17, "pending");
      const readReceipt = vi.fn(async () => currentReceipt);
      const action = vi.fn(async () => {
        currentReceipt = settlementReceipt(18, "pending");
      });
      const outcome = runPackagedGridClipboardAction(readReceipt, action);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(action).not.toHaveBeenCalled();

      currentReceipt = settlementReceipt(17, "success");
      await vi.advanceTimersByTimeAsync(25);
      expect(action).toHaveBeenCalledTimes(1);
      expect(currentReceipt).toEqual(settlementReceipt(18, "pending"));

      currentReceipt = settlementReceipt(18, "success");
      await vi.advanceTimersByTimeAsync(25);
      await expect(outcome).resolves.toBe(18);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pre-action pending receipt owned when later reads become unreadable", async () => {
    vi.useFakeTimers();
    try {
      const readReceipt = vi
        .fn()
        .mockResolvedValueOnce(settlementReceipt(19, "pending"))
        .mockRejectedValue(new Error("renderer was replaced"));
      let terminal = false;
      void waitForPackagedGridClipboardActionAvailability(readReceipt).then(
        () => {
          terminal = true;
        },
        () => {
          terminal = true;
        }
      );

      await vi.advanceTimersByTimeAsync(30_000);

      expect(terminal).toBe(false);
      expect(readReceipt.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
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

      const record = failure as Error & {
        cleanupFailed?: boolean;
        clipboardInterference?: boolean;
        productFailed?: boolean;
      };
      const expectedMessage = packagedFailureMessage(productFailed, cleanupFailed);
      expect({
        cleanupFailed: record?.cleanupFailed,
        clipboardInterference: record?.clipboardInterference,
        isAggregate: failure instanceof AggregateError,
        messageMatches: record?.message === expectedMessage,
        name: record?.name,
        productFailed: record?.productFailed,
        retainsClipboardText: diagnosticRetainsAny(failure, [productSecret, expectedSecret, cleanupSecret])
      }).toEqual({
        cleanupFailed,
        clipboardInterference: false,
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

  it("does not add a clipboard cleanup failure after a product failure", async () => {
    const productFailure = new Error("context-menu payload assertion failed");
    const hostClipboard = {
      readText: vi.fn(async () => "private-prior-clipboard"),
      writeText: vi.fn(async () => undefined)
    };

    let failure: unknown;
    try {
      await runPackagedGridRangeCopyLifecycle(
        async () => {
          throw productFailure;
        },
        async () => undefined
      );
    } catch (error) {
      failure = error;
    }
    expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not read secret-bearing clipboard state before the product exercise", async () => {
    const clipboardSecret = "private-initial-read-clipboard-sentinel";
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => {
        throw Object.assign(new Error("initial clipboard read rejected"), { actual: clipboardSecret });
      }),
      writeText: vi.fn(async () => undefined)
    };

    await runPackagedGridRangeCopyLifecycle(exercise, async () => undefined);

    expect(exercise).toHaveBeenCalledTimes(1);
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("leaves the successful product clipboard value untouched", async () => {
    let clipboard = "prior clipboard";
    const exercise = vi.fn(async () => {
      clipboard = "test-owned clipboard";
    });
    const hostClipboard = {
      readText: vi.fn(async () => clipboard),
      writeText: vi.fn(async () => undefined)
    };

    await runPackagedGridRangeCopyLifecycle(exercise, async () => undefined);

    expect(exercise).toHaveBeenCalledTimes(1);
    expect(clipboard).toBe("test-owned clipboard");
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not normalize or restore exact clipboard bytes during cleanup", async () => {
    let clipboard = "prior\nclipboard\r\nbytes";
    const hostClipboard = {
      readText: vi.fn(async () => clipboard),
      writeText: vi.fn(async () => undefined)
    };

    await runPackagedGridRangeCopyLifecycle(
      async () => {
        clipboard = "owned\r\nclipboard";
      },
      async () => undefined
    );

    expect(clipboard).toBe("owned\r\nclipboard");
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not await an unrelated never-settling clipboard read", async () => {
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(() => new Promise<string>(() => undefined)),
      writeText: vi.fn(async () => undefined)
    };

    await runPackagedGridRangeCopyLifecycle(exercise, async () => undefined);

    expect(exercise).toHaveBeenCalledTimes(1);
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("retains a late product write until its stateful settlement before reporting failure", async () => {
    vi.useFakeTimers();
    try {
      let clipboard = "prior clipboard";
      const lateWrite = deferredClipboardWrite(() => {
        clipboard = "test-owned clipboard";
      });
      const hostClipboard = {
        readText: vi.fn(async () => "unused"),
        writeText: vi.fn(() => lateWrite.promise)
      };
      let terminal = false;
      const outcome = writePackagedGridClipboard(hostClipboard, "test-owned clipboard").then(
        () => {
          terminal = true;
          return undefined;
        },
        (error: unknown) => {
          terminal = true;
          return error;
        }
      );

      await vi.advanceTimersByTimeAsync(packagedGridClipboardOperationTimeoutMs);
      expect({ clipboard, terminal }).toEqual({ clipboard: "prior clipboard", terminal: false });

      lateWrite.settle();
      const failure = await outcome;
      const clipboardAtTerminal = clipboard;
      await Promise.resolve();

      expect(failure).toMatchObject({
        message: "The packaged grid range-copy clipboard operation did not complete safely.",
        name: "PackagedGridClipboardOperationFailure"
      });
      expect(clipboard).toBe("test-owned clipboard");
      expect(clipboard).toBe(clipboardAtTerminal);
      expect(terminal).toBe(true);
      expect(hostClipboard.writeText).toHaveBeenCalledExactlyOnceWith("test-owned clipboard");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a foreign update observed after a late product write settles", async () => {
    vi.useFakeTimers();
    try {
      let clipboard = "prior clipboard";
      const foreignClipboard = "private-post-write-foreign-clipboard";
      const events: string[] = [];
      const lateWrite = deferredClipboardWrite(() => {
        clipboard = "test-owned clipboard";
        events.push("product-write-applied");
      });
      const hostClipboard = {
        readText: vi.fn(async () => clipboard),
        writeText: vi.fn(() => lateWrite.promise)
      };
      let terminal = false;
      const outcome = runPackagedGridRangeCopyLifecycle(
        async () => writePackagedGridClipboard(hostClipboard, "test-owned clipboard"),
        async () => {
          clipboard = foreignClipboard;
          events.push("foreign-update-observed");
        }
      ).then(
        () => {
          terminal = true;
          events.push("terminal");
          return undefined;
        },
        (error: unknown) => {
          terminal = true;
          events.push("terminal");
          return error;
        }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(hostClipboard.writeText).toHaveBeenCalledExactlyOnceWith("test-owned clipboard");
      await vi.advanceTimersByTimeAsync(packagedGridClipboardOperationTimeoutMs);
      expect({ clipboard, terminal }).toEqual({ clipboard: "prior clipboard", terminal: false });

      lateWrite.settle();
      const failure = await outcome;

      expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
      expect(diagnosticRetainsAny(failure, [foreignClipboard])).toBe(false);
      expect(clipboard).toBe(foreignClipboard);
      expect(terminal).toBe(true);
      expect(events).toEqual(["product-write-applied", "foreign-update-observed", "terminal"]);
      expect(hostClipboard.readText).not.toHaveBeenCalled();
      expect(hostClipboard.writeText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never dispatches a cleanup write after a successful product action", async () => {
    let clipboard = "prior clipboard";
    const foreignClipboard = "private-post-product-foreign-clipboard";
    const hostClipboard = {
      readText: vi.fn(async () => clipboard),
      writeText: vi.fn(async () => undefined)
    };

    await runPackagedGridRangeCopyLifecycle(
      async () => {
        clipboard = "test-owned clipboard";
      },
      async () => {
        clipboard = foreignClipboard;
      }
    );

    expect(clipboard).toBe(foreignClipboard);
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("keeps a never-settling write owned for the outer process deadline", async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = new Promise<void>(() => undefined);
      const hostClipboard = {
        readText: vi.fn(async () => "prior clipboard"),
        writeText: vi.fn(() => neverSettles)
      };
      let terminal = false;
      void runPackagedGridRangeCopyLifecycle(
        async () => writePackagedGridClipboard(hostClipboard, "test-owned clipboard"),
        async () => undefined
      ).then(
        () => {
          terminal = true;
        },
        () => {
          terminal = true;
        }
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(packagedGridClipboardOperationTimeoutMs);

      expect(terminal).toBe(false);
      expect(hostClipboard.readText).not.toHaveBeenCalled();
      expect(hostClipboard.writeText).toHaveBeenCalledExactlyOnceWith("test-owned clipboard");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a cleanup read that could race a foreign clipboard update", async () => {
    const hostClipboard = {
      readText: vi.fn(() => new Promise<string>(() => undefined)),
      writeText: vi.fn(async () => undefined)
    };

    await runPackagedGridRangeCopyLifecycle(
      async () => undefined,
      async () => undefined
    );

    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("bounds a never-settling polling read without retaining a late value", async () => {
    vi.useFakeTimers();
    try {
      const lateRead = deferred<string>();
      const hostClipboard = {
        readText: vi.fn(() => lateRead.promise),
        writeText: vi.fn(async () => undefined)
      };
      const outcome = waitForPackagedGridClipboard(hostClipboard, "expected range").then(
        () => undefined,
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(packagedGridClipboardOperationTimeoutMs);
      const failure = await outcome;
      const lateSecret = "private-late-polling-clipboard-sentinel";
      lateRead.resolve(lateSecret);
      await Promise.resolve();

      expect(packagedFailureShape(failure)).toEqual(expectedPackagedFailureShape(true, false));
      expect(diagnosticRetainsAny(failure, [lateSecret])).toBe(false);
      expect(hostClipboard.readText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a foreign update between the former cleanup check and restore window", async () => {
    const foreignClipboard = "private-concurrent-foreign-clipboard-sentinel";
    let currentClipboard = "prior clipboard";
    const hostClipboard = {
      readText: vi.fn(async () => currentClipboard),
      writeText: vi.fn(async (value: string) => {
        currentClipboard = foreignClipboard;
        currentClipboard = value;
      })
    };

    await runPackagedGridRangeCopyLifecycle(
      async () => {
        currentClipboard = "test-owned clipboard";
      },
      async () => {
        currentClipboard = foreignClipboard;
      }
    );

    expect(currentClipboard).toBe(foreignClipboard);
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
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

  it("rejects a non-string product clipboard value before the host adapter", async () => {
    const hostClipboard = {
      readText: vi.fn(async () => "unused"),
      writeText: vi.fn(async () => undefined)
    };

    await expect(writePackagedGridClipboard(hostClipboard, 42 as unknown as string)).rejects.toThrowError(
      "The host clipboard value is invalid or exceeds the 4 MiB limit."
    );
    expect(hostClipboard.readText).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("rejects an oversized product clipboard value before the host adapter", async () => {
    const hostClipboard = {
      readText: vi.fn(async () => "unused"),
      writeText: vi.fn(async () => undefined)
    };

    await expect(writePackagedGridClipboard(hostClipboard, "x".repeat(4 * 1024 * 1024 + 1))).rejects.toThrowError(
      "The host clipboard value is invalid or exceeds the 4 MiB limit."
    );
    expect(hostClipboard.readText).not.toHaveBeenCalled();
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

function packagedFailureMessage(productFailed: boolean, cleanupFailed: boolean, clipboardInterference = false): string {
  return `The packaged grid range-copy journey failed. Product stage: ${productFailed ? "failed" : "passed"}; cleanup stage: ${cleanupFailed ? "failed" : "passed"}; clipboard interference: ${clipboardInterference ? "detected" : "none"}; clipboard text retained: no.`;
}

function packagedFailureShape(value: unknown) {
  const record = value as Error & {
    cleanupFailed?: boolean;
    clipboardInterference?: boolean;
    productFailed?: boolean;
  };
  return {
    cleanupFailed: record?.cleanupFailed,
    clipboardInterference: record?.clipboardInterference,
    isAggregate: value instanceof AggregateError,
    messageMatches:
      typeof record?.productFailed === "boolean" &&
      typeof record.cleanupFailed === "boolean" &&
      typeof record.clipboardInterference === "boolean" &&
      record.message ===
        packagedFailureMessage(record.productFailed, record.cleanupFailed, record.clipboardInterference),
    name: record?.name,
    productFailed: record?.productFailed
  };
}

function expectedPackagedFailureShape(productFailed: boolean, cleanupFailed: boolean, clipboardInterference = false) {
  return {
    cleanupFailed,
    clipboardInterference,
    isAggregate: false,
    messageMatches: true,
    name: "PackagedGridRangeCopyFailure",
    productFailed
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function deferredClipboardWrite(apply: () => void) {
  const pending = deferred<void>();
  return {
    promise: pending.promise,
    settle() {
      apply();
      pending.resolve();
    }
  };
}

function settlementReceipt(
  id: number | string,
  status: "idle" | "pending" | "success" | "failure" | "complete",
  mode: "none" | "cell" | "row" | "range" | "column" = "range"
) {
  return { id: String(id), mode, status };
}
