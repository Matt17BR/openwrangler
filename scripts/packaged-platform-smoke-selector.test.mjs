import assert from "node:assert/strict";
import test from "node:test";
import {
  PACKAGED_DAILY_CORE_SELECTOR,
  PACKAGED_GRID_RANGE_COPY_SELECTOR,
  resolvePackagedPlatformSmokeSelector,
  runPackagedPlatformSmokePhase
} from "./packaged-platform-smoke-selector.mjs";

test("accepts the two focused platform-smoke journeys", () => {
  for (const selector of [PACKAGED_DAILY_CORE_SELECTOR, PACKAGED_GRID_RANGE_COPY_SELECTOR]) {
    assert.equal(resolvePackagedPlatformSmokeSelector({ acceptanceMode: "platform-smoke", selector }), selector);
    assert.throws(
      () => resolvePackagedPlatformSmokeSelector({ acceptanceMode: "full", selector }),
      /only when.*platform-smoke/u
    );
  }
  assert.equal(resolvePackagedPlatformSmokeSelector({ acceptanceMode: "platform-smoke" }), undefined);
  assert.throws(
    () => resolvePackagedPlatformSmokeSelector({ acceptanceMode: "platform-smoke", selector: "another-journey" }),
    /only when.*platform-smoke/u
  );
});

test("forwards a selected journey without changing the ordinary smoke", async () => {
  for (const selector of [PACKAGED_DAILY_CORE_SELECTOR, PACKAGED_GRID_RANGE_COPY_SELECTOR]) {
    const calls = [];
    const input = { phase: "platform-smoke", marker: "selected" };
    await runPackagedPlatformSmokePhase(async (value) => calls.push(value), input, selector);
    assert.deepEqual(calls, [{ ...input, testSelector: selector }]);
  }

  const calls = [];
  const input = { phase: "platform-smoke", marker: "ordinary" };
  await runPackagedPlatformSmokePhase(async (value) => calls.push(value), input, undefined);
  assert.deepEqual(calls, [input]);
  assert.equal(Object.hasOwn(calls[0], "testSelector"), false);
});

test("never dispatches a platform selector to an unrelated phase", async () => {
  let calls = 0;
  await assert.rejects(
    runPackagedPlatformSmokePhase(
      async () => {
        calls += 1;
      },
      { phase: "verify" },
      PACKAGED_DAILY_CORE_SELECTOR
    ),
    /only to the platform-smoke phase/u
  );
  assert.equal(calls, 0);
});
