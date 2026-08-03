import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DATA_WRANGLER_PUBLIC_UI_RECEIPT_PROTOCOL,
  DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
  NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
  PUBLIC_UI_AVAILABLE_STABILITY_CHECKS,
  PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
  PUBLIC_UI_CAPABILITY_END_JITTER_MS,
  PUBLIC_UI_COMMON_EXTENSION_INVENTORY,
  PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
  PUBLIC_UI_DATA_WRANGLER_EXTENSION,
  PUBLIC_UI_MAXIMUM_TRACE_SAMPLES,
  PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
  PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
  canonicalPublicUiReceiptJson,
  createDataWranglerPolarsCapabilityReceipt,
  createExpectedPublicUiExtensionInventory,
  createNeitherProductControlReceipt,
  createPublicUiReceiptContext,
  digestPublicUiReceiptEvidence,
  normalizePublicUiEvidence,
  validateDataWranglerPolarsCapabilityReceipt,
  validateNeitherProductControlReceipt
} from "./data-wrangler-public-ui-receipts.mjs";

const CAPABILITY_KIND = DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND;
const CONTROL_KIND = NEITHER_PRODUCT_CONTROL_RECEIPT_KIND;
const CAPTURE_ID = "3b7607f1-49d6-4cd9-8d76-616659ab31c8";
const START_MS = 8_456_000;

function sha(character) {
  return character.repeat(64);
}

function context() {
  return createPublicUiReceiptContext({
    captureId: CAPTURE_ID,
    editor: {
      id: "Microsoft.VisualStudioCode",
      version: "1.130.0",
      sha256: sha("a"),
      uiLocale: "en"
    },
    source: {
      variableName: "study_frame",
      engine: "polars",
      semanticClass: "dataframe",
      rowCount: 10_000,
      columnCount: 4,
      schemaSha256: sha("b"),
      sentinels: [
        { rowIndex: 0, columnName: "study_id", value: 101 },
        { rowIndex: 9_999, columnName: "sentinel", value: "OMEGA-9999" }
      ]
    }
  });
}

function rawEvidence(kind, conclusion) {
  const available = conclusion === "available";
  const fullWindow = !available;
  const inventory = createExpectedPublicUiExtensionInventory(kind);
  const endedAtMonotonicMs = fullWindow ? START_MS + PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS : START_MS + 475;
  const times = available
    ? [START_MS, START_MS + 250, endedAtMonotonicMs]
    : [...Array(PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS / PUBLIC_UI_OBSERVATION_MAX_GAP_MS + 1).keys()].map(
        (index) => START_MS + index * PUBLIC_UI_OBSERVATION_MAX_GAP_MS
      );
  const trace = times.map((atMonotonicMs, index) => {
    const actionAvailable = available && index >= times.length - PUBLIC_UI_AVAILABLE_STABILITY_CHECKS;
    return {
      atMonotonicMs,
      output: readyHostOutput(),
      actions: measuredActions(actionAvailable)
    };
  });
  return {
    captureId: CAPTURE_ID,
    editor: {
      id: "Microsoft.VisualStudioCode",
      version: "1.130.0",
      sha256: sha("a"),
      uiLocale: "en"
    },
    extensions: structuredClone(inventory),
    source: structuredClone(context().source),
    observation: {
      clock: "linux-monotonic",
      startedAtMonotonicMs: START_MS,
      endedAtMonotonicMs,
      absenceDeadlineAtMonotonicMs: START_MS + PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
      maxGapMs: PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
      sampleCount: trace.length
    },
    trace,
    output: structuredClone(trace.at(-1).output),
    actions: structuredClone(trace.at(-1).actions),
    conclusion
  };
}

function readyHostOutput() {
  return {
    ready: true,
    busy: false,
    obstructed: false,
    owner: "host-jupyter"
  };
}

function measuredActions(dataWranglerAvailable) {
  return [
    {
      product: "open-wrangler",
      accessibleName: PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
      matchCount: 0,
      pointerUsable: false
    },
    {
      product: "data-wrangler",
      accessibleName: PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
      matchCount: dataWranglerAvailable ? 1 : 0,
      pointerUsable: dataWranglerAvailable
    }
  ];
}

function createCapability(conclusion = "available") {
  return createDataWranglerPolarsCapabilityReceipt(rawEvidence(CAPABILITY_KIND, conclusion), context());
}

function createControl() {
  return createNeitherProductControlReceipt(rawEvidence(CONTROL_KIND, "neither-product-control"), context());
}

function resign(receipt, mutate) {
  const changed = structuredClone(receipt);
  mutate(changed.evidence);
  changed.evidenceSha256 = digestPublicUiReceiptEvidence(changed.evidence);
  return changed;
}

function refreshInventoryDigest(evidence) {
  evidence.extensions.entries.sort((left, right) => {
    return left.extensionId < right.extensionId ? -1 : left.extensionId > right.extensionId ? 1 : 0;
  });
  evidence.extensions.sha256 = createHash("sha256")
    .update(canonicalPublicUiReceiptJson(evidence.extensions.entries), "utf8")
    .digest("hex");
}

test("available capability normalizes raw evidence and requires one exact pointer-usable action", () => {
  const evidence = rawEvidence(CAPABILITY_KIND, "available");
  evidence.extensions.entries.reverse();
  evidence.actions.reverse();
  const rawDigest = digestPublicUiReceiptEvidence(evidence);
  const receipt = createDataWranglerPolarsCapabilityReceipt(evidence, context());

  assert.equal(receipt.protocol, DATA_WRANGLER_PUBLIC_UI_RECEIPT_PROTOCOL);
  assert.equal(receipt.kind, CAPABILITY_KIND);
  assert.equal(receipt.evidenceSha256, rawDigest);
  assert.equal(receipt.evidenceSha256, digestPublicUiReceiptEvidence(receipt.evidence));
  assert.deepEqual(
    receipt.evidence.actions.map((action) => action.product),
    ["open-wrangler", "data-wrangler"]
  );
  assert.equal(receipt.evidence.actions[0].accessibleName, "Open in Open Wrangler");
  assert.deepEqual(receipt.evidence.actions[1], {
    product: "data-wrangler",
    accessibleName: "Open 'study_frame' in Data Wrangler",
    matchCount: 1,
    pointerUsable: true
  });
  assert.equal(receipt.evidence.trace.length, 3);
  assert.deepEqual(
    receipt.evidence.trace.map((sample) => sample.actions[1].matchCount),
    [0, 1, 1]
  );
  assert.equal(
    receipt.evidence.observation.endedAtMonotonicMs < receipt.evidence.observation.absenceDeadlineAtMonotonicMs,
    true
  );
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.evidence.source.sentinels), true);
  assert.equal(validateDataWranglerPolarsCapabilityReceipt(receipt, context()), receipt);
});

test("a Polars capability timeout proves only that no action appeared before the deadline", () => {
  const receipt = createCapability("capability-timeout");
  assert.equal(receipt.evidence.conclusion, "capability-timeout");
  assert.equal(
    receipt.evidence.observation.endedAtMonotonicMs,
    receipt.evidence.observation.absenceDeadlineAtMonotonicMs
  );
  assert.equal(receipt.evidence.trace.length, 31);
  assert.equal(receipt.evidence.observation.sampleCount, receipt.evidence.trace.length);
  assert.deepEqual(
    receipt.evidence.actions.map(({ matchCount, pointerUsable }) => ({ matchCount, pointerUsable })),
    [
      { matchCount: 0, pointerUsable: false },
      { matchCount: 0, pointerUsable: false }
    ]
  );
  assert.equal(validateDataWranglerPolarsCapabilityReceipt(receipt, context()), receipt);
});

test("neither-product control excludes both measured extensions and actions on the same ready host output", () => {
  const receipt = createControl();
  const ids = receipt.evidence.extensions.entries.map((entry) => entry.extensionId.toLowerCase());
  assert.deepEqual(receipt.evidence.extensions.entries, PUBLIC_UI_COMMON_EXTENSION_INVENTORY);
  assert.equal(ids.includes(PUBLIC_UI_DATA_WRANGLER_EXTENSION.extensionId), false);
  assert.equal(ids.includes("matt17br.openwrangler"), false);
  assert.deepEqual(receipt.evidence.output, {
    ready: true,
    busy: false,
    obstructed: false,
    owner: "host-jupyter"
  });
  assert.ok(receipt.evidence.actions.every((action) => action.matchCount === 0 && action.pointerUsable === false));
  assert.equal(validateNeitherProductControlReceipt(receipt, context()), receipt);
});

test("a recomputed digest cannot legitimize a capability or control enum flip", async (t) => {
  await t.test("available to capability timeout", () => {
    const changed = resign(createCapability("available"), (evidence) => {
      evidence.conclusion = "capability-timeout";
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /capability timeout requires zero actions through the deadline/u
    );
  });

  await t.test("capability timeout to available", () => {
    const changed = resign(createCapability("capability-timeout"), (evidence) => {
      evidence.conclusion = "available";
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /stop at the first stable exact pointer-usable action/u
    );
  });

  await t.test("control to capability conclusion", () => {
    const changed = resign(createControl(), (evidence) => {
      evidence.conclusion = "available";
    });
    assert.throws(
      () => validateNeitherProductControlReceipt(changed, context()),
      /control evidence has an invalid conclusion/u
    );
  });
});

test("absence claims require the exact absolute full deadline", async (t) => {
  await t.test("a shortened declared deadline", () => {
    const changed = resign(createCapability("capability-timeout"), (evidence) => {
      evidence.observation.absenceDeadlineAtMonotonicMs = START_MS + 5_000;
      evidence.observation.endedAtMonotonicMs = START_MS + 5_000;
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /fixed absolute monotonic window and cadence/u
    );
  });

  await t.test("an early end despite the fixed deadline", () => {
    const changed = resign(createCapability("capability-timeout"), (evidence) => {
      evidence.trace.pop();
      evidence.observation.sampleCount = evidence.trace.length;
      evidence.observation.endedAtMonotonicMs = evidence.trace.at(-1).atMonotonicMs;
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /zero actions through the deadline/u
    );
  });

  await t.test("a control ending before its deadline", () => {
    const changed = resign(createControl(), (evidence) => {
      evidence.trace.pop();
      evidence.observation.sampleCount = evidence.trace.length;
      evidence.observation.endedAtMonotonicMs = evidence.trace.at(-1).atMonotonicMs;
    });
    assert.throws(() => validateNeitherProductControlReceipt(changed, context()), /observe the full absence deadline/u);
  });

  await t.test("an end beyond the bounded completion jitter", () => {
    const changed = resign(createControl(), (evidence) => {
      evidence.observation.endedAtMonotonicMs =
        evidence.observation.absenceDeadlineAtMonotonicMs + PUBLIC_UI_CAPABILITY_END_JITTER_MS + 1;
    });
    assert.throws(
      () => validateNeitherProductControlReceipt(changed, context()),
      /fixed absolute monotonic window and cadence/u
    );
  });
});

test("the bounded trace exposes mid-window actions, missing cadence intervals, and forged summaries", async (t) => {
  await t.test("a Data Wrangler action appearing mid-window invalidates timeout evidence", () => {
    const changed = resign(createCapability("capability-timeout"), (evidence) => {
      evidence.trace[10].actions[1].matchCount = 1;
      evidence.trace[10].actions[1].pointerUsable = true;
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /zero actions through the deadline/u
    );
  });

  await t.test("an earlier transient action invalidates a later available conclusion", () => {
    const changed = resign(createCapability("available"), (evidence) => {
      evidence.trace[0].actions[1].matchCount = 1;
      evidence.trace[0].actions[1].pointerUsable = true;
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /stop at the first stable exact pointer-usable action/u
    );
  });

  await t.test("a removed cadence sample creates a reviewable missing interval", () => {
    const changed = resign(createControl(), (evidence) => {
      evidence.trace.splice(12, 1);
      evidence.observation.sampleCount = evidence.trace.length;
    });
    assert.throws(
      () => validateNeitherProductControlReceipt(changed, context()),
      /missing, reversed, or overlong observation interval/u
    );
  });

  await t.test("a final summary cannot contradict the retained trace", () => {
    const changed = resign(createCapability("capability-timeout"), (evidence) => {
      evidence.actions[1].matchCount = 1;
      evidence.actions[1].pointerUsable = true;
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /summary state must equal the final normalized trace sample/u
    );
  });

  await t.test("a mid-window output obstruction cannot be hidden by a ready summary", () => {
    const changed = resign(createControl(), (evidence) => {
      evidence.trace[15].output.obstructed = true;
    });
    assert.throws(
      () => validateNeitherProductControlReceipt(changed, context()),
      /ready, idle, unobstructed host\/Jupyter output/u
    );
  });
});

test("obstructed, busy, non-ready, or non-host outputs cannot support a receipt", async (t) => {
  for (const [label, mutate] of [
    ["obstructed", (output) => (output.obstructed = true)],
    ["busy", (output) => (output.busy = true)],
    ["not ready", (output) => (output.ready = false)],
    ["wrong owner", (output) => (output.owner = "data-wrangler-webview")]
  ]) {
    await t.test(label, () => {
      const changed = resign(createCapability(), (evidence) => mutate(evidence.output));
      assert.throws(
        () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
        /ready, idle, unobstructed host\/Jupyter output/u
      );
    });
  }
});

test("the complete extension inventory is exact for capability and control receipts", async (t) => {
  await t.test("missing common extension", () => {
    const changed = resign(createCapability(), (evidence) => {
      evidence.extensions.entries.shift();
      refreshInventoryDigest(evidence);
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /exact complete extension inventory/u
    );
  });

  await t.test("wrong Data Wrangler version", () => {
    const changed = resign(createCapability(), (evidence) => {
      evidence.extensions.entries.find((entry) => entry.extensionId === "ms-toolsai.datawrangler").version = "1.24.3";
      refreshInventoryDigest(evidence);
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /exact complete extension inventory/u
    );
  });

  await t.test("Open Wrangler added to the Data Wrangler capture", () => {
    const changed = resign(createCapability(), (evidence) => {
      evidence.extensions.entries.push({ extensionId: "Matt17BR.openwrangler", version: "1.2.1" });
      refreshInventoryDigest(evidence);
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /exact complete extension inventory/u
    );
  });

  await t.test("a measured product added to the neither-product control", () => {
    const changed = resign(createControl(), (evidence) => {
      evidence.extensions.entries.push({ extensionId: "ms-toolsai.datawrangler", version: "1.24.2" });
      refreshInventoryDigest(evidence);
    });
    assert.throws(
      () => validateNeitherProductControlReceipt(changed, context()),
      /exact complete extension inventory/u
    );
  });
});

test("capture, editor, and notebook source receipts are bound exactly to expected context", async (t) => {
  for (const [label, expectedError, mutate] of [
    ["capture", /expected capture ID/u, (evidence) => (evidence.captureId = "58f75762-5d47-40b3-b410-1fb4855a8bc5")],
    ["editor version", /exact expected editor identity/u, (evidence) => (evidence.editor.version = "1.131.0")],
    ["editor binary", /exact expected editor identity/u, (evidence) => (evidence.editor.sha256 = sha("c"))],
    ["editor locale", /exact expected editor identity/u, (evidence) => (evidence.editor.uiLocale = "de")],
    ["source engine", /exact expected notebook source/u, (evidence) => (evidence.source.engine = "pandas")],
    ["source shape", /exact expected notebook source/u, (evidence) => (evidence.source.rowCount = 10_001)],
    ["source sentinel", /exact expected notebook source/u, (evidence) => (evidence.source.sentinels[1].value = "WRONG")]
  ]) {
    await t.test(label, () => {
      const changed = resign(createCapability(), mutate);
      assert.throws(() => validateDataWranglerPolarsCapabilityReceipt(changed, context()), expectedError);
    });
  }
});

test("duplicate, mislabeled, or non-usable action evidence is rejected after digest recomputation", async (t) => {
  await t.test("duplicate DOM matches", () => {
    const changed = resign(createCapability(), (evidence) => {
      evidence.actions[1].matchCount = 2;
      evidence.trace.at(-1).actions[1].matchCount = 2;
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /stop at the first stable exact pointer-usable action/u
    );
  });

  await t.test("duplicate product observations", () => {
    const changed = resign(createCapability(), (evidence) => {
      evidence.actions[0] = structuredClone(evidence.actions[1]);
      evidence.trace.at(-1).actions[0] = structuredClone(evidence.trace.at(-1).actions[1]);
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /one observation for each measured product/u
    );
  });

  await t.test("wrong accessible name", () => {
    const changed = resign(createCapability(), (evidence) => {
      evidence.actions[1].accessibleName = "Open study_frame in Data Wrangler";
      evidence.trace.at(-1).actions[1].accessibleName = "Open study_frame in Data Wrangler";
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /accessible names must match the fixed/u
    );
  });

  await t.test("not pointer usable", () => {
    const changed = resign(createCapability(), (evidence) => {
      evidence.actions[1].pointerUsable = false;
      evidence.trace.at(-1).actions[1].pointerUsable = false;
    });
    assert.throws(
      () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
      /stop at the first stable exact pointer-usable action/u
    );
  });
});

test("the outer digest covers normalized raw evidence and validation rejects a mismatch", () => {
  const receipt = createCapability();
  const reordered = structuredClone(receipt.evidence);
  reordered.actions.reverse();
  reordered.extensions.entries.reverse();
  reordered.source.sentinels.reverse();
  assert.equal(digestPublicUiReceiptEvidence(reordered), receipt.evidenceSha256);

  const changed = structuredClone(receipt);
  changed.evidence.source.sentinels[0].value = 102;
  assert.throws(
    () => validateDataWranglerPolarsCapabilityReceipt(changed, context()),
    /does not match its normalized digest/u
  );
});

test("validators require normalized array order even when its normalized digest is valid", () => {
  const receipt = structuredClone(createCapability());
  receipt.evidence.actions.reverse();
  receipt.evidence.extensions.entries.reverse();
  receipt.evidenceSha256 = digestPublicUiReceiptEvidence(receipt.evidence);
  assert.throws(
    () => validateDataWranglerPolarsCapabilityReceipt(receipt, context()),
    /evidence is not in normalized form/u
  );
});

test("contexts and source sentinels are bounded and restricted to the study editor and Polars source", () => {
  const extraContextField = { ...structuredClone(context()), path: "/private/notebook.ipynb" };
  assert.throws(() => createPublicUiReceiptContext(extraContextField), /missing or unknown fields/u);

  const wrongEditor = structuredClone(context());
  wrongEditor.editor.id = "cursor";
  assert.throws(() => createPublicUiReceiptContext(wrongEditor), /official Microsoft Visual Studio Code/u);

  const wrongLocale = structuredClone(context());
  wrongLocale.editor.uiLocale = "de";
  assert.throws(() => createPublicUiReceiptContext(wrongLocale), /--locale=en/u);

  const wrongSource = structuredClone(context());
  wrongSource.source.engine = "pandas";
  assert.throws(() => createPublicUiReceiptContext(wrongSource), /exact study_frame Polars dataframe source/u);

  const noSentinels = structuredClone(context());
  noSentinels.source.sentinels = [];
  assert.throws(() => createPublicUiReceiptContext(noSentinels), /at least one sentinel/u);

  const duplicateSentinel = structuredClone(context());
  duplicateSentinel.source.sentinels.push(structuredClone(duplicateSentinel.source.sentinels[0]));
  assert.throws(() => createPublicUiReceiptContext(duplicateSentinel), /locations must be unique/u);

  const oversizedSentinel = structuredClone(context());
  oversizedSentinel.source.sentinels[0].value = "x".repeat(4 * 1024 + 1);
  assert.throws(() => createPublicUiReceiptContext(oversizedSentinel), /exceeds its UTF-8 byte bound/u);
});

test("trace size, declared cadence, and sample count are bounded and cross-checked", () => {
  const tooManySamples = rawEvidence(CONTROL_KIND, "neither-product-control");
  while (tooManySamples.trace.length <= PUBLIC_UI_MAXIMUM_TRACE_SAMPLES) {
    tooManySamples.trace.push(structuredClone(tooManySamples.trace.at(-1)));
  }
  tooManySamples.observation.sampleCount = PUBLIC_UI_MAXIMUM_TRACE_SAMPLES;
  assert.throws(
    () => createNeitherProductControlReceipt(tooManySamples, context()),
    /observation trace must be an array within its entry bound/u
  );

  const wrongCadence = resign(createControl(), (evidence) => {
    evidence.observation.maxGapMs = PUBLIC_UI_OBSERVATION_MAX_GAP_MS + 1;
  });
  assert.throws(
    () => validateNeitherProductControlReceipt(wrongCadence, context()),
    /fixed absolute monotonic window and cadence/u
  );

  const wrongCount = resign(createControl(), (evidence) => {
    evidence.observation.sampleCount -= 1;
  });
  assert.throws(
    () => validateNeitherProductControlReceipt(wrongCount, context()),
    /trace count and endpoints must match/u
  );
});

test("inventory and evidence digests are deterministic normalized SHA-256 values", () => {
  const inventory = createExpectedPublicUiExtensionInventory(CAPABILITY_KIND);
  assert.match(inventory.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(inventory.entries.length, PUBLIC_UI_COMMON_EXTENSION_INVENTORY.length + 1);
  assert.deepEqual(normalizePublicUiEvidence(rawEvidence(CAPABILITY_KIND, "available")), createCapability().evidence);
  assert.match(digestPublicUiReceiptEvidence(rawEvidence(CAPABILITY_KIND, "available")), /^[0-9a-f]{64}$/u);
});
