import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
  DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL,
  createDataWranglerStudyControlBridge,
  type DataWranglerStudyBridgeEnvelope
} from "./extensionHost/dataWranglerStudyControlBridge";

const RUN_ID = "12345678-1234-4123-8123-123456789abc";
const PHASE = "comparison-study-open-wrangler-trial";
const roots: string[] = [];

function privateBridgePaths(): { readonly root: string; readonly requestPath: string; readonly acknowledgementPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ow-study-child-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return {
    root,
    requestPath: join(root, "request.json"),
    acknowledgementPath: join(root, "acknowledgement.json")
  };
}

function canonical(value: Record<string, unknown>): string {
  return `${JSON.stringify(
    Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])),
    null,
    2
  )}\n`;
}

async function waitForRequest(path: string): Promise<DataWranglerStudyBridgeEnvelope> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as DataWranglerStudyBridgeEnvelope;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("request did not arrive");
}

function writeAcknowledgement(
  path: string,
  request: DataWranglerStudyBridgeEnvelope,
  overrides: Record<string, unknown> = {}
): void {
  const acknowledgement = {
    protocol: DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
    runId: request.runId,
    phase: request.phase,
    sequence: request.sequence,
    kind: request.kind,
    monotonicNanoseconds: (BigInt(request.monotonicNanoseconds) + 1n).toString(),
    ...overrides
  };
  writeFileSync(path, canonical(acknowledgement), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("notebook-trial child control bridge", () => {
  it("publishes private canonical requests and accepts only correlated acknowledgements", async () => {
    const paths = privateBridgePaths();
    let clock = 100n;
    const bridge = createDataWranglerStudyControlBridge(
      { ...paths, runId: RUN_ID, phase: PHASE },
      { clock: () => (clock += 10n), timeoutMs: 1_000, pollIntervalMs: 1 }
    );
    const responder = (async () => {
      const first = await waitForRequest(paths.requestPath);
      expect(first).toEqual({
        protocol: DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL,
        runId: RUN_ID,
        phase: PHASE,
        sequence: 0,
        kind: "source-verified",
        monotonicNanoseconds: "110"
      });
      writeAcknowledgement(paths.acknowledgementPath, first);
      let second: DataWranglerStudyBridgeEnvelope;
      do {
        await new Promise((resolve) => setTimeout(resolve, 1));
        second = await waitForRequest(paths.requestPath);
      } while (second.sequence !== 1);
      writeAcknowledgement(paths.acknowledgementPath, second);
    })();

    const first = await bridge.exchange("source-verified");
    const second = await bridge.exchange("measurement-ready");
    await responder;
    expect(first.acknowledgement.sequence).toBe(0);
    expect(second.request.sequence).toBe(1);
    expect(BigInt(second.request.monotonicNanoseconds)).toBeGreaterThan(
      BigInt(first.acknowledgement.monotonicNanoseconds)
    );
    expect(bridge.nextSequence()).toBe(2);
    expect(existsSync(paths.requestPath)).toBe(false);
    expect(existsSync(paths.acknowledgementPath)).toBe(false);
    expect(() => bridge.close()).not.toThrow();
  });

  it("fails before publication when either wire path contains a stale entry", () => {
    const paths = privateBridgePaths();
    writeFileSync(paths.requestPath, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    expect(() =>
      createDataWranglerStudyControlBridge({ ...paths, runId: RUN_ID, phase: PHASE })
    ).toThrow(/unconsumed/u);
  });

  it("rejects a malformed acknowledgement without consuming the durable request", async () => {
    const paths = privateBridgePaths();
    const bridge = createDataWranglerStudyControlBridge(
      { ...paths, runId: RUN_ID, phase: PHASE },
      { clock: () => 100n, timeoutMs: 1_000, pollIntervalMs: 1 }
    );
    const responder = (async () => {
      const request = await waitForRequest(paths.requestPath);
      writeAcknowledgement(paths.acknowledgementPath, request, { unexpected: true });
    })();
    await expect(bridge.exchange("source-verified")).rejects.toThrow(/missing or unknown fields/u);
    await responder;
    expect(existsSync(paths.requestPath)).toBe(true);
    expect(existsSync(paths.acknowledgementPath)).toBe(true);
  });

  it("rejects a stale correlation and a regressed acknowledgement clock", async () => {
    const stalePaths = privateBridgePaths();
    const staleBridge = createDataWranglerStudyControlBridge(
      { ...stalePaths, runId: RUN_ID, phase: PHASE },
      { clock: () => 100n, timeoutMs: 1_000, pollIntervalMs: 1 }
    );
    const staleResponder = (async () => {
      const request = await waitForRequest(stalePaths.requestPath);
      writeAcknowledgement(stalePaths.acknowledgementPath, request, {
        runId: "22345678-1234-4123-8123-123456789abc"
      });
    })();
    await expect(staleBridge.exchange("source-verified")).rejects.toThrow(/stale/u);
    await staleResponder;

    const clockPaths = privateBridgePaths();
    const clockBridge = createDataWranglerStudyControlBridge(
      { ...clockPaths, runId: RUN_ID, phase: PHASE },
      { clock: () => 100n, timeoutMs: 1_000, pollIntervalMs: 1 }
    );
    const clockResponder = (async () => {
      const request = await waitForRequest(clockPaths.requestPath);
      writeAcknowledgement(clockPaths.acknowledgementPath, request, { monotonicNanoseconds: "99" });
    })();
    await expect(clockBridge.exchange("source-verified")).rejects.toThrow(/predates/u);
    await clockResponder;
  });

  it("times out without inventing an acknowledgement or consuming its request", async () => {
    const paths = privateBridgePaths();
    const bridge = createDataWranglerStudyControlBridge(
      { ...paths, runId: RUN_ID, phase: PHASE },
      { clock: () => 100n, timeoutMs: 5, pollIntervalMs: 1 }
    );
    await expect(bridge.exchange("source-verified")).rejects.toThrow(/within 5 ms/u);
    expect(existsSync(paths.requestPath)).toBe(true);
    expect(existsSync(paths.acknowledgementPath)).toBe(false);
  });

  it("rejects an acknowledgement that appears before the deadline but is read after it", async () => {
    const paths = privateBridgePaths();
    const times = [0, 0, 0, 5, 10];
    const bridge = createDataWranglerStudyControlBridge(
      { ...paths, runId: RUN_ID, phase: PHASE },
      {
        clock: () => 100n,
        now: () => times.shift() ?? 10,
        timeoutMs: 10,
        pollIntervalMs: 1,
        async wait() {
          const request = JSON.parse(readFileSync(paths.requestPath, "utf8")) as DataWranglerStudyBridgeEnvelope;
          writeAcknowledgement(paths.acknowledgementPath, request);
        }
      }
    );
    await expect(bridge.exchange("source-verified")).rejects.toThrow(/within 10 ms/u);
    expect(existsSync(paths.requestPath)).toBe(true);
    expect(existsSync(paths.acknowledgementPath)).toBe(true);
  });
});
