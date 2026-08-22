import assert from "node:assert/strict";
import test from "node:test";
import {
  PACKAGED_GRID_RANGE_COPY_SELECTOR,
  resolvePackagedGridRangeCopySelector,
  runPackagedPlatformSmokePhase
} from "./packaged-grid-range-copy-selector.mjs";

test("accepts only the exact grid journey in platform-smoke mode", () => {
  assert.equal(
    resolvePackagedGridRangeCopySelector({
      acceptanceMode: "platform-smoke",
      selector: PACKAGED_GRID_RANGE_COPY_SELECTOR
    }),
    PACKAGED_GRID_RANGE_COPY_SELECTOR
  );
  assert.equal(resolvePackagedGridRangeCopySelector({ acceptanceMode: "platform-smoke" }), undefined);
  for (const input of [
    { acceptanceMode: "full", selector: PACKAGED_GRID_RANGE_COPY_SELECTOR },
    { acceptanceMode: "platform-smoke", selector: "another-journey" }
  ]) {
    assert.throws(() => resolvePackagedGridRangeCopySelector(input), /only when.*platform-smoke/u);
  }
});

test("forwards the exact selector to the platform phase without changing the ordinary smoke", async () => {
  const selectedCalls = [];
  const selectedInput = { phase: "platform-smoke", marker: "selected" };
  await runPackagedPlatformSmokePhase(
    async (input) => selectedCalls.push(input),
    selectedInput,
    PACKAGED_GRID_RANGE_COPY_SELECTOR
  );
  assert.deepEqual(selectedCalls, [{ ...selectedInput, testSelector: PACKAGED_GRID_RANGE_COPY_SELECTOR }]);

  const ordinaryCalls = [];
  const ordinaryInput = { phase: "platform-smoke", marker: "ordinary" };
  await runPackagedPlatformSmokePhase(async (input) => ordinaryCalls.push(input), ordinaryInput, undefined);
  assert.deepEqual(ordinaryCalls, [ordinaryInput]);
  assert.equal(Object.hasOwn(ordinaryCalls[0], "testSelector"), false);
});

test("never dispatches the focused selector to an unrelated phase", async () => {
  let calls = 0;
  await assert.rejects(
    runPackagedPlatformSmokePhase(
      async () => {
        calls += 1;
      },
      { phase: "verify" },
      PACKAGED_GRID_RANGE_COPY_SELECTOR
    ),
    /only to the platform-smoke phase/u
  );
  assert.equal(calls, 0);
});
