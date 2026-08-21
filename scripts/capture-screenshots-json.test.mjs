import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  AXE_MACHINE_RESULT_PREFIX,
  AXE_RESULT_LIMITS,
  AXE_RUN_RESULT_PROTOCOL,
  AxeResultClassificationError,
  classifyAxeScanResult,
  createAxeResultCollector,
  formatAxeFailureDetail,
  serializeAxeClassificationError,
  serializeAxeMachineResult
} from "./accessibility-result-classification.mjs";
import { stringifyForInlineScript } from "./capture-screenshots-json.mjs";
import { createFilterPanelScreenshotReadiness } from "./capture-screenshots-readiness.mjs";
import {
  captureWebviewScreenshot,
  createWebviewSelectorReadiness,
  createWebviewBrowserIsolation,
  preflightWebviewBrowser,
  resolveWebviewBrowserExecutable,
  WEBVIEW_BROWSER_PREREQUISITE_FAILURE
} from "./webview-browser.mjs";

const completedHeaderReadiness = () =>
  createWebviewSelectorReadiness({
    description: "test header profiles",
    selectors: [
      { selector: "th[data-grid-column]", count: 2 },
      { selector: "th[data-grid-column] > .columnInsight:not(.emptyInsight)", count: 2 },
      { selector: "th[data-grid-column] .emptyInsight", count: 0 }
    ],
    absentText: [{ selector: "th[data-grid-column] > .columnInsight", text: "Profiling…" }],
    emptyArrayGlobals: ["openWranglerHarnessErrors"]
  });

const axeViolation = ({ id, impact, help = `${id} help`, nodes = [] }) => ({ id, impact, help, nodes });

test("Axe classification fails every impact including minor and unknown findings", () => {
  const scan = classifyAxeScanResult({
    harness: "impact-harness.html",
    violations: [
      axeViolation({ id: "minor-rule", impact: "minor" }),
      axeViolation({ id: "critical-rule", impact: "critical" }),
      axeViolation({ id: "moderate-rule", impact: "moderate" }),
      axeViolation({ id: "serious-rule", impact: "serious" }),
      axeViolation({ id: "unknown-null-rule", impact: null }),
      axeViolation({ id: "unknown-new-rule", impact: "future-impact" })
    ]
  });

  assert.equal(scan.status, "failed");
  assert.equal(scan.findingCount, 6);
  assert.equal(scan.unapprovedFindingCount, 6);
  assert.deepEqual(
    scan.findings.map(({ id, impact }) => [id, impact]),
    [
      ["critical-rule", "critical"],
      ["serious-rule", "serious"],
      ["moderate-rule", "moderate"],
      ["minor-rule", "minor"],
      ["unknown-new-rule", "unknown"],
      ["unknown-null-rule", "unknown"]
    ]
  );
  assert.equal(scan.findings.find(({ id }) => id === "unknown-new-rule").rawImpact, "future-impact");
  assert.equal(scan.findings.find(({ id }) => id === "unknown-null-rule").rawImpact, null);
});

test("Axe run classification is deterministic across harness and finding order", () => {
  const inputs = [
    {
      harness: "z-last.html",
      violations: [
        axeViolation({ id: "z-rule", impact: "moderate" }),
        axeViolation({ id: "a-rule", impact: "critical" })
      ]
    },
    { harness: "a-first.html", violations: [axeViolation({ id: "minor-rule", impact: "minor" })] }
  ];
  const forward = createAxeResultCollector();
  for (const input of inputs) forward.record(input);
  const reverse = createAxeResultCollector();
  for (const input of [...inputs].reverse()) {
    reverse.record({ ...input, violations: [...input.violations].reverse() });
  }

  assert.deepEqual(reverse.report(), forward.report());
  assert.deepEqual(
    forward.report().scans.map(({ harness }) => harness),
    ["a-first.html", "z-last.html"]
  );
  const serialized = serializeAxeMachineResult(forward.report());
  assert.ok(serialized.startsWith(AXE_MACHINE_RESULT_PREFIX));
  assert.equal(serialized, `${AXE_MACHINE_RESULT_PREFIX}${JSON.stringify(forward.report())}\n`);
  assert.equal(JSON.parse(serialized.slice(AXE_MACHINE_RESULT_PREFIX.length)).protocol, AXE_RUN_RESULT_PROTOCOL);
});

test("Axe machine results bound strings, node diagnostics, and finding counts", () => {
  const longText = "😀".repeat(2_000);
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    target: [`.target-${String(11 - index).padStart(2, "0")}`, longText],
    failureSummary: longText
  }));
  const scan = classifyAxeScanResult({
    harness: "bounded.html",
    violations: [axeViolation({ id: longText, impact: "minor", help: longText, nodes })]
  });
  const finding = scan.findings[0];

  assert.equal(finding.idTruncated, true);
  assert.equal(finding.helpTruncated, true);
  assert.equal(finding.nodeCount, 12);
  assert.equal(finding.nodes.length, AXE_RESULT_LIMITS.diagnosticNodesPerFinding);
  assert.equal(finding.omittedNodeCount, 7);
  assert.deepEqual(
    finding.nodes.map(({ target }) => target.slice(0, 10)),
    [".target-00", ".target-01", ".target-02", ".target-03", ".target-04"]
  );
  assert.match(
    formatAxeFailureDetail({ scans: [{ harness: scan.harness, findings: scan.findings }] }),
    /7 additional affected nodes omitted/u
  );
  assert.ok(Buffer.byteLength(serializeAxeMachineResult(scan), "utf8") <= AXE_RESULT_LIMITS.machineResultUtf8Bytes);

  assert.throws(
    () =>
      classifyAxeScanResult({
        harness: "too-many.html",
        violations: Array.from({ length: AXE_RESULT_LIMITS.findingsPerScan + 1 }, (_, index) =>
          axeViolation({ id: `rule-${index}`, impact: "minor" })
        )
      }),
    (error) => error instanceof AxeResultClassificationError && error.code === "too_many_scan_findings"
  );
  let boundedError;
  try {
    classifyAxeScanResult({ harness: "too-many.html", violations: Array(AXE_RESULT_LIMITS.findingsPerScan + 1) });
  } catch (error) {
    boundedError = error;
  }
  const errorResult = JSON.parse(serializeAxeClassificationError(boundedError).slice(AXE_MACHINE_RESULT_PREFIX.length));
  assert.deepEqual(errorResult, {
    protocol: AXE_RUN_RESULT_PROTOCOL,
    status: "invalid",
    code: "too_many_scan_findings",
    actual: AXE_RESULT_LIMITS.findingsPerScan + 1,
    limit: AXE_RESULT_LIMITS.findingsPerScan
  });
});

test("Axe target diagnostics cap sparse and multibyte work before later values", () => {
  let lateTargetRead = false;
  const multibyteTarget = new Array(16);
  multibyteTarget[0] = "😀".repeat(20_000);
  Object.defineProperty(multibyteTarget, 1, {
    get() {
      lateTargetRead = true;
      throw new Error("Target normalization read beyond its code-point bound.");
    }
  });
  const multibyteScan = classifyAxeScanResult({
    harness: "multibyte-target.html",
    violations: [
      axeViolation({
        id: "multibyte-target",
        impact: "minor",
        nodes: [{ target: multibyteTarget, failureSummary: "failed" }]
      })
    ]
  });
  const multibyteNode = multibyteScan.findings[0].nodes[0];
  assert.equal(lateTargetRead, false);
  assert.equal(multibyteNode.targetTruncated, true);
  assert.equal(Array.from(multibyteNode.target).length, AXE_RESULT_LIMITS.targetCodePoints + 1);
  assert.equal(multibyteNode.target.endsWith("…"), true);

  const sparseTarget = [];
  sparseTarget.length = 0xffff_ffff;
  sparseTarget[0] = ".bounded";
  const sparseScan = classifyAxeScanResult({
    harness: "sparse-target.html",
    violations: [
      axeViolation({
        id: "sparse-target",
        impact: null,
        nodes: [{ target: sparseTarget, failureSummary: "failed" }]
      })
    ]
  });
  assert.deepEqual(sparseScan.findings[0].nodes[0], {
    target: ".bounded…",
    targetTruncated: true,
    failureSummary: "failed",
    failureSummaryTruncated: false
  });
});

test("Axe aggregate node budgets preflight 512 maximum-node findings and rejected run overflow", () => {
  let aggregateTargetReads = 0;
  const aggregateNode = { failureSummary: "aggregate failure" };
  Object.defineProperty(aggregateNode, "target", {
    get() {
      aggregateTargetReads += 1;
      throw new Error("Aggregate node normalization ran before its budget check.");
    }
  });
  const maximumNodes = Array(AXE_RESULT_LIMITS.nodesPerFinding).fill(aggregateNode);
  const aggregateFindings = Array.from({ length: AXE_RESULT_LIMITS.findingsPerRun }, (_, index) =>
    axeViolation({ id: `aggregate-${index}`, impact: "minor", nodes: maximumNodes })
  );
  for (const [index, findings] of [
    aggregateFindings.slice(0, AXE_RESULT_LIMITS.findingsPerScan),
    aggregateFindings.slice(AXE_RESULT_LIMITS.findingsPerScan)
  ].entries()) {
    assert.throws(
      () => classifyAxeScanResult({ harness: `aggregate-${index}.html`, violations: findings }),
      (error) =>
        error instanceof AxeResultClassificationError &&
        error.code === "too_many_scan_nodes" &&
        error.actual === AXE_RESULT_LIMITS.nodesPerScan + AXE_RESULT_LIMITS.nodesPerFinding &&
        error.limit === AXE_RESULT_LIMITS.nodesPerScan
    );
  }
  assert.equal(aggregateTargetReads, 0);

  let nodesAccessorReads = 0;
  const nodesAccessorFinding = {};
  Object.defineProperty(nodesAccessorFinding, "nodes", {
    get() {
      nodesAccessorReads += 1;
      return maximumNodes;
    }
  });
  assert.throws(
    () => classifyAxeScanResult({ harness: "nodes-accessor.html", violations: [nodesAccessorFinding] }),
    (error) => error instanceof AxeResultClassificationError && error.code === "invalid_findings"
  );
  assert.equal(nodesAccessorReads, 0);

  const ordinaryNode = { target: [".bounded"], failureSummary: "failed" };
  const boundedNodes = Array(AXE_RESULT_LIMITS.nodesPerFinding).fill(ordinaryNode);
  const exactScanFindings = Array.from(
    { length: AXE_RESULT_LIMITS.nodesPerScan / AXE_RESULT_LIMITS.nodesPerFinding },
    (_, index) => axeViolation({ id: `bounded-${index}`, impact: "minor", nodes: boundedNodes })
  );
  const collector = createAxeResultCollector();
  collector.record({ harness: "run-nodes-a.html", violations: exactScanFindings });
  collector.record({ harness: "run-nodes-b.html", violations: exactScanFindings });
  let rejectedImpactReads = 0;
  const rejectedFinding = { nodes: [ordinaryNode] };
  Object.defineProperty(rejectedFinding, "impact", {
    get() {
      rejectedImpactReads += 1;
      throw new Error("Rejected run-overflow finding was normalized.");
    }
  });
  assert.throws(
    () => collector.record({ harness: "run-nodes-overflow.html", violations: [rejectedFinding] }),
    (error) =>
      error instanceof AxeResultClassificationError &&
      error.code === "too_many_run_nodes" &&
      error.actual === AXE_RESULT_LIMITS.nodesPerRun + 1 &&
      error.limit === AXE_RESULT_LIMITS.nodesPerRun
  );
  assert.equal(rejectedImpactReads, 0);
  const report = collector.report();
  assert.equal(report.scanCount, 2);
  assert.equal(report.findingCount, exactScanFindings.length * 2);
  for (const finding of report.scans.flatMap(({ findings }) => findings)) {
    assert.equal(finding.nodeCount, AXE_RESULT_LIMITS.nodesPerFinding);
    assert.equal(
      finding.omittedNodeCount,
      AXE_RESULT_LIMITS.nodesPerFinding - AXE_RESULT_LIMITS.diagnosticNodesPerFinding
    );
    assert.equal(finding.nodes.length, AXE_RESULT_LIMITS.diagnosticNodesPerFinding);
  }
});

test("Axe run finding limits reject 512 plus 5 findings before inspecting 50,000 nodes", () => {
  const collector = createAxeResultCollector();
  for (const scanIndex of [0, 1]) {
    collector.record({
      harness: `finding-limit-${scanIndex}.html`,
      violations: Array.from({ length: AXE_RESULT_LIMITS.findingsPerScan }, (_, findingIndex) =>
        axeViolation({ id: `finding-${scanIndex}-${findingIndex}`, impact: "minor" })
      )
    });
  }

  let rejectedNodeReads = 0;
  const rejectedNode = { failureSummary: "must not be inspected" };
  Object.defineProperty(rejectedNode, "target", {
    get() {
      rejectedNodeReads += 1;
      throw new Error("Run finding overflow inspected rejected nodes.");
    }
  });
  const rejectedFindings = Array.from({ length: 5 }, (_, index) =>
    axeViolation({
      id: `rejected-${index}`,
      impact: "minor",
      nodes: Array(AXE_RESULT_LIMITS.nodesPerFinding).fill(rejectedNode)
    })
  );
  assert.throws(
    () => collector.record({ harness: "finding-limit-overflow.html", violations: rejectedFindings }),
    (error) =>
      error instanceof AxeResultClassificationError &&
      error.code === "too_many_run_findings" &&
      error.actual === AXE_RESULT_LIMITS.findingsPerRun + rejectedFindings.length &&
      error.limit === AXE_RESULT_LIMITS.findingsPerRun
  );
  assert.equal(rejectedNodeReads, 0);
  assert.equal(collector.report().findingCount, AXE_RESULT_LIMITS.findingsPerRun);
});

test("Axe input snapshots reject proxies and array accessors before invoking hostile code", () => {
  let proxyTrapCalls = 0;
  const hostileHandler = {
    get() {
      proxyTrapCalls += 1;
      throw new Error("Axe classification invoked a proxy get trap.");
    },
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error("Axe classification invoked a proxy descriptor trap.");
    },
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error("Axe classification invoked a proxy prototype trap.");
    },
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error("Axe classification invoked a proxy key trap.");
    }
  };
  for (const input of [
    new Proxy({ harness: "proxy-envelope.html", violations: [] }, hostileHandler),
    { harness: "proxy-violations.html", violations: new Proxy([], hostileHandler) },
    {
      harness: "proxy-finding.html",
      violations: [new Proxy({ id: "proxy", impact: "minor", nodes: [] }, hostileHandler)]
    },
    {
      harness: "proxy-nodes.html",
      violations: [axeViolation({ id: "proxy", impact: "minor", nodes: new Proxy([], hostileHandler) })]
    },
    {
      harness: "proxy-target.html",
      violations: [
        axeViolation({
          id: "proxy",
          impact: "minor",
          nodes: [{ target: new Proxy([".unsafe"], hostileHandler), failureSummary: "failed" }]
        })
      ]
    }
  ]) {
    assert.throws(
      () => classifyAxeScanResult(input),
      (error) => error instanceof AxeResultClassificationError && error.code === "invalid_findings"
    );
  }
  assert.equal(proxyTrapCalls, 0);

  let elementAccessorCalls = 0;
  const driftingNodes = Array(1);
  Object.defineProperty(driftingNodes, 0, {
    get() {
      elementAccessorCalls += 1;
      driftingNodes.length = 0;
      return { target: [".unsafe"], failureSummary: "failed" };
    }
  });
  assert.throws(
    () =>
      classifyAxeScanResult({
        harness: "length-drift.html",
        violations: [axeViolation({ id: "length-drift", impact: "minor", nodes: driftingNodes })]
      }),
    (error) => error instanceof AxeResultClassificationError && error.code === "invalid_findings"
  );
  assert.equal(elementAccessorCalls, 0);
  assert.equal(driftingNodes.length, 1);
});

test("Axe reports retain only bounded normalized diagnostics after recording", () => {
  const sourceTarget = [".before"];
  const sourceNode = { target: sourceTarget, failureSummary: "before failure" };
  const sourceNodes = Array(AXE_RESULT_LIMITS.nodesPerFinding).fill(sourceNode);
  const collector = createAxeResultCollector();
  collector.record({
    harness: "retained-memory.html",
    violations: [axeViolation({ id: "retained-memory", impact: "minor", nodes: sourceNodes })]
  });
  const report = collector.report();

  sourceTarget[0] = ".after";
  sourceNode.failureSummary = "after failure";
  sourceNodes.fill({ target: [".replacement"], failureSummary: "replacement" });

  const finding = report.scans[0].findings[0];
  assert.equal(finding.nodeCount, AXE_RESULT_LIMITS.nodesPerFinding);
  assert.equal(finding.nodes.length, AXE_RESULT_LIMITS.diagnosticNodesPerFinding);
  assert.equal(finding.nodes[0].target, ".before");
  assert.equal(finding.nodes[0].failureSummary, "before failure");
  const retained = new Set();
  const visit = (value) => {
    if (value === null || typeof value !== "object" || retained.has(value)) return;
    retained.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) visit(descriptor.value);
    }
  };
  visit(report);
  assert.equal(retained.has(sourceNodes), false);
  assert.equal(retained.has(sourceNode), false);
  assert.equal(retained.has(sourceTarget), false);
});

test("Axe machine-result size includes the prefix and exactly one newline", () => {
  const emptyRecord = `${AXE_MACHINE_RESULT_PREFIX}${JSON.stringify({ padding: "" })}\n`;
  const paddingBytes = AXE_RESULT_LIMITS.machineResultUtf8Bytes - Buffer.byteLength(emptyRecord, "utf8");
  assert.ok(paddingBytes > 0);

  const exactAsciiRecord = serializeAxeMachineResult({ padding: "x".repeat(paddingBytes) });
  assert.equal(Buffer.byteLength(exactAsciiRecord, "utf8"), AXE_RESULT_LIMITS.machineResultUtf8Bytes);
  assert.equal(exactAsciiRecord.endsWith("\n"), true);
  assert.equal(exactAsciiRecord.endsWith("\n\n"), false);
  assert.throws(
    () => serializeAxeMachineResult({ padding: "x".repeat(paddingBytes + 1) }),
    (error) =>
      error instanceof AxeResultClassificationError &&
      error.code === "machine_result_too_large" &&
      error.actual === AXE_RESULT_LIMITS.machineResultUtf8Bytes + 1
  );

  const multibytePadding = `${paddingBytes % 2 === 0 ? "" : "x"}${"é".repeat(Math.floor(paddingBytes / 2))}`;
  const exactMultibyteRecord = serializeAxeMachineResult({ padding: multibytePadding });
  assert.equal(Buffer.byteLength(exactMultibyteRecord, "utf8"), AXE_RESULT_LIMITS.machineResultUtf8Bytes);
  assert.throws(
    () => serializeAxeMachineResult({ padding: `${multibytePadding}é` }),
    (error) =>
      error instanceof AxeResultClassificationError &&
      error.code === "machine_result_too_large" &&
      error.actual === AXE_RESULT_LIMITS.machineResultUtf8Bytes + 2
  );

  const escapedPadding = `${paddingBytes % 2 === 0 ? "" : "x"}${'"'.repeat(Math.floor(paddingBytes / 2))}`;
  const exactEscapedRecord = serializeAxeMachineResult({ padding: escapedPadding });
  assert.equal(Buffer.byteLength(exactEscapedRecord, "utf8"), AXE_RESULT_LIMITS.machineResultUtf8Bytes);
  assert.throws(
    () => serializeAxeMachineResult({ padding: `${escapedPadding}"` }),
    (error) =>
      error instanceof AxeResultClassificationError &&
      error.code === "machine_result_too_large" &&
      error.actual === AXE_RESULT_LIMITS.machineResultUtf8Bytes + 2
  );

  const escapedSample = 'quote " slash \\ nul \0 newline\n lone \ud800 emoji 😀 accent é';
  const escapedSampleRecord = serializeAxeMachineResult({ padding: escapedSample });
  assert.equal(
    Buffer.byteLength(escapedSampleRecord, "utf8"),
    Buffer.byteLength(`${AXE_MACHINE_RESULT_PREFIX}${JSON.stringify({ padding: escapedSample })}\n`, "utf8")
  );
});

test("Axe machine-result sparse arrays pass at the exact byte boundary and fail at plus one entry", () => {
  const emptyRecord = `${AXE_MACHINE_RESULT_PREFIX}${JSON.stringify({ padding: "", values: [] })}\n`;
  const availableBytes = AXE_RESULT_LIMITS.machineResultUtf8Bytes - Buffer.byteLength(emptyRecord, "utf8");
  const sparseLength = Math.floor((availableBytes + 1) / 5);
  const sparseArrayBytes = sparseLength * 5 - 1;
  const padding = "x".repeat(availableBytes - sparseArrayBytes);
  const exactSparse = [];
  exactSparse.length = sparseLength;

  const exactRecord = serializeAxeMachineResult({ padding, values: exactSparse });
  assert.equal(Buffer.byteLength(exactRecord, "utf8"), AXE_RESULT_LIMITS.machineResultUtf8Bytes);
  assert.deepEqual(JSON.parse(exactRecord.slice(AXE_MACHINE_RESULT_PREFIX.length)).values.length, sparseLength);

  const oversizedSparse = [];
  oversizedSparse.length = sparseLength + 1;
  assert.throws(
    () => serializeAxeMachineResult({ padding, values: oversizedSparse }),
    (error) =>
      error instanceof AxeResultClassificationError &&
      error.code === "machine_result_too_large" &&
      error.actual === AXE_RESULT_LIMITS.machineResultUtf8Bytes + 5 &&
      error.limit === AXE_RESULT_LIMITS.machineResultUtf8Bytes
  );
});

test("Axe sparse serialization never walks or writes through an Array.prototype Proxy", () => {
  const originalPrototypeParent = Object.getPrototypeOf(Array.prototype);
  let prototypeHasCalls = 0;
  let prototypeSetCalls = 0;
  const proxyPrototypeParent = new Proxy(originalPrototypeParent, {
    has() {
      prototypeHasCalls += 1;
      throw new Error("Sparse serialization walked the Array prototype chain.");
    },
    set() {
      prototypeSetCalls += 1;
      throw new Error("Sparse serialization wrote through the Array prototype chain.");
    }
  });
  const sparse = Array(3);
  let serialized;
  Object.setPrototypeOf(Array.prototype, proxyPrototypeParent);
  try {
    serialized = serializeAxeMachineResult({ sparse });
  } finally {
    Object.setPrototypeOf(Array.prototype, originalPrototypeParent);
  }

  assert.equal(prototypeHasCalls, 0);
  assert.equal(prototypeSetCalls, 0);
  assert.deepEqual(JSON.parse(serialized.slice(AXE_MACHINE_RESULT_PREFIX.length)), {
    sparse: [null, null, null]
  });
});

test("Axe sparse serialization ignores inherited non-writable numeric properties", () => {
  const inheritedIndex = Object.getOwnPropertyDescriptor(Array.prototype, "0");
  assert.equal(inheritedIndex, undefined);
  const sparse = Array(1);
  let serialized;
  Object.defineProperty(Array.prototype, "0", {
    value: "inherited",
    enumerable: false,
    configurable: true,
    writable: false
  });
  try {
    serialized = serializeAxeMachineResult({ sparse });
  } finally {
    delete Array.prototype[0];
  }

  assert.deepEqual(JSON.parse(serialized.slice(AXE_MACHINE_RESULT_PREFIX.length)), {
    sparse: [null]
  });
});

test("Axe machine results reject 100,000 empty child arrays at the aggregate graph-node bound", () => {
  const graph = Array.from({ length: AXE_RESULT_LIMITS.machineResultGraphNodes }, () => []);
  assert.throws(
    () => serializeAxeMachineResult(graph),
    (error) =>
      error instanceof AxeResultClassificationError &&
      error.code === "too_many_machine_result_nodes" &&
      error.actual === AXE_RESULT_LIMITS.machineResultGraphNodes + 1 &&
      error.limit === AXE_RESULT_LIMITS.machineResultGraphNodes
  );
});

test("Axe machine-result charging rejects toJSON and accessors without invoking them", () => {
  let toJSONCalls = 0;
  const hooked = {
    padding: "safe",
    toJSON() {
      toJSONCalls += 1;
      return { padding: "x".repeat(AXE_RESULT_LIMITS.machineResultUtf8Bytes) };
    }
  };
  assert.throws(
    () => serializeAxeMachineResult(hooked),
    (error) => error instanceof AxeResultClassificationError && error.code === "invalid_machine_result"
  );
  assert.equal(toJSONCalls, 0);

  let accessorCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "padding", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "unsafe";
    }
  });
  assert.throws(
    () => serializeAxeMachineResult(accessor),
    (error) => error instanceof AxeResultClassificationError && error.code === "invalid_machine_result"
  );
  assert.equal(accessorCalls, 0);

  let proxyTrapCalls = 0;
  const proxyResult = new Proxy(
    { padding: "unsafe" },
    {
      get() {
        proxyTrapCalls += 1;
        throw new Error("Axe serialization invoked a proxy get trap.");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("Axe serialization invoked a proxy descriptor trap.");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("Axe serialization invoked a proxy prototype trap.");
      }
    }
  );
  assert.throws(
    () => serializeAxeMachineResult(proxyResult),
    (error) => error instanceof AxeResultClassificationError && error.code === "invalid_machine_result"
  );
  assert.equal(proxyTrapCalls, 0);

  let arrayAccessorCalls = 0;
  const driftingArray = Array(1);
  Object.defineProperty(driftingArray, 0, {
    get() {
      arrayAccessorCalls += 1;
      driftingArray.length = 0;
      return "unsafe";
    }
  });
  assert.throws(
    () => serializeAxeMachineResult(driftingArray),
    (error) => error instanceof AxeResultClassificationError && error.code === "invalid_machine_result"
  );
  assert.equal(arrayAccessorCalls, 0);
  assert.equal(driftingArray.length, 1);
});

test("Axe classification errors emit only allowlisted bounded codes through the machine serializer", () => {
  const oversizedCode = `private-${"x".repeat(AXE_RESULT_LIMITS.machineResultUtf8Bytes)}`;
  const serialized = serializeAxeClassificationError(
    new AxeResultClassificationError(oversizedCode, "private failure", {
      actual: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER
    })
  );
  assert.deepEqual(JSON.parse(serialized.slice(AXE_MACHINE_RESULT_PREFIX.length)), {
    protocol: AXE_RUN_RESULT_PROTOCOL,
    status: "invalid",
    code: "classification_failed"
  });
  assert.ok(Buffer.byteLength(serialized, "utf8") < 256);
  assert.doesNotMatch(serialized, /private-/u);

  let codeAccessorCalls = 0;
  const accessorError = new AxeResultClassificationError("invalid_findings", "private failure");
  Object.defineProperty(accessorError, "code", {
    get() {
      codeAccessorCalls += 1;
      return "invalid_findings";
    }
  });
  assert.deepEqual(JSON.parse(serializeAxeClassificationError(accessorError).slice(AXE_MACHINE_RESULT_PREFIX.length)), {
    protocol: AXE_RUN_RESULT_PROTOCOL,
    status: "invalid",
    code: "classification_failed"
  });
  assert.equal(codeAccessorCalls, 0);
});

test("Axe human diagnostics visibly escape unsafe control and bidi code points", () => {
  const unsafe = "\u001b\u0007\u007f\u0085\u2028\u202e\u2066\u200f\ufeff";
  const scan = classifyAxeScanResult({
    harness: `control${unsafe}.html`,
    violations: [
      axeViolation({
        id: `rule${unsafe}`,
        impact: `future${unsafe}`,
        help: `help${unsafe}`,
        nodes: [{ target: [`.target${unsafe}`], failureSummary: `failure${unsafe}` }]
      })
    ]
  });
  const finding = scan.findings[0];
  const detail = formatAxeFailureDetail({ scans: [scan] });
  const visibleEscapes = [
    "\\u{001B}",
    "\\u{0007}",
    "\\u{007F}",
    "\\u{0085}",
    "\\u{2028}",
    "\\u{202E}",
    "\\u{2066}",
    "\\u{200F}",
    "\\u{FEFF}"
  ];

  for (const escape of visibleEscapes) {
    assert.ok(scan.harness.includes(escape));
    assert.ok(finding.id.includes(escape));
    assert.ok(finding.rawImpact.includes(escape));
    assert.ok(finding.help.includes(escape));
    assert.ok(finding.nodes[0].target.includes(escape));
    assert.ok(finding.nodes[0].failureSummary.includes(escape));
    assert.ok(detail.includes(escape));
  }
  for (const control of unsafe) assert.equal(detail.includes(control), false);
});

function readinessScope({
  headerCount = 2,
  completedCount = 2,
  emptyCount = 0,
  texts = ["Ready", "Ready"],
  errors = []
} = {}) {
  const elements = (count, textValues = []) =>
    Array.from({ length: count }, (_, index) => ({ textContent: textValues[index] ?? "" }));
  const selectorResults = new Map([
    ["th[data-grid-column]", elements(headerCount)],
    ["th[data-grid-column] > .columnInsight:not(.emptyInsight)", elements(completedCount)],
    ["th[data-grid-column] .emptyInsight", elements(emptyCount)],
    ["th[data-grid-column] > .columnInsight", elements(texts.length, texts)]
  ]);
  return {
    window: {
      document: {
        querySelectorAll(selector) {
          return selectorResults.get(selector) ?? [];
        }
      },
      openWranglerHarnessErrors: errors
    }
  };
}

function filterPanelReadinessScope(readiness, { selectorCountOverrides = {}, errors = [] } = {}) {
  const selectorResults = new Map(
    readiness.argument.selectors.map(({ selector, count }) => [
      selector,
      Array.from({ length: selectorCountOverrides[selector] ?? count }, () => ({ textContent: "" }))
    ])
  );
  return {
    window: {
      document: {
        querySelectorAll(selector) {
          return selectorResults.get(selector) ?? [];
        }
      },
      openWranglerHarnessErrors: errors
    }
  };
}

function mockScreenshotCapture({ parent, onWaitForFunction, onReadinessConfirmation, clockAdvanceAfterInstall = 0 }) {
  const order = [];
  const timeouts = {};
  let clockInstallOptions;
  const outputPath = join(parent, "capture.png");
  let closeCalls = 0;
  let monotonicTime = 0;
  let clockTime = 0;
  const page = {
    clock: {
      async install(options) {
        clockInstallOptions = options;
        clockTime = options?.time ?? 0;
        clockTime += clockAdvanceAfterInstall;
        order.push("clock-install");
      },
      async setFixedTime(time) {
        assert.equal(time, 0);
        clockTime = time;
        order.push("clock-fix-time");
      },
      async pauseAt(time) {
        assert.equal(time, 0);
        assert.ok(time >= clockTime);
        clockTime = time;
        order.push("clock-pause");
      },
      async setSystemTime(time) {
        assert.equal(time, 0);
        clockTime = time;
        order.push("clock-reset-time");
      },
      async fastForward() {
        order.push("clock-fast-forward");
      },
      async resume() {
        order.push("clock-resume");
      }
    },
    async goto(_url, options) {
      timeouts.navigation = options.timeout;
      order.push("goto");
    },
    async waitForTimeout() {
      order.push("settle");
    },
    async waitForFunction(predicate, argument, options) {
      timeouts.readiness = options.timeout;
      order.push("readiness-wait");
      return onWaitForFunction?.(predicate, argument, options);
    },
    async evaluate(predicate, argument) {
      if (argument === undefined) {
        order.push("fonts");
        return undefined;
      }
      order.push("readiness-confirm");
      return onReadinessConfirmation?.(predicate, argument);
    },
    async screenshot({ path, timeout }) {
      timeouts.screenshot = timeout;
      order.push("screenshot");
      writeFileSync(path, "synthetic image");
    }
  };
  const context = {
    pages() {
      return [page];
    },
    async close() {
      closeCalls += 1;
      order.push("close");
    }
  };
  const chromium = {
    async launchPersistentContext(_profile, options) {
      timeouts.launch = options.timeout;
      order.push("launch");
      return context;
    }
  };
  return {
    chromium,
    outputPath,
    order,
    timeouts,
    clockInstallOptions: () => clockInstallOptions,
    closeCalls: () => closeCalls,
    options: {
      chromium,
      browser: { executablePath: process.execPath, explicitOverride: false },
      isolation: {
        workspaceTmp: parent,
        platform: process.platform,
        rootPrefix: "readiness-capture-",
        aliasPrefix: "ow-rdy-",
        shortTempParent: tmpdir()
      },
      url: "data:text/html,<title>readiness</title>",
      outputPath,
      monotonicNow() {
        monotonicTime += 100;
        return monotonicTime;
      }
    }
  };
}

test("inline-script JSON escapes HTML script boundaries without changing its value", () => {
  const payload = {
    message: "</ScRiPt><script>window.openWranglerEscaped = false;</script><!--&-->\u2028\u2029",
    nested: ["plain", { code: "before</script>after", value: 42 }],
    enabled: true,
    missing: null
  };

  const serialized = stringifyForInlineScript(payload);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/u);
  assert.doesNotMatch(serialized, /<\/script/iu);

  const harness = `<script>globalThis.payload = ${serialized};</script>`;
  assert.equal(harness.match(/<\/script>/giu)?.length, 1);
  assert.equal(JSON.stringify(runInNewContext(`(${serialized})`)), JSON.stringify(payload));
});

test("inline-script JSON retains ordinary JSON.stringify semantics", () => {
  assert.equal(stringifyForInlineScript(undefined), "undefined");
  assert.equal(stringifyForInlineScript(Number.NaN), "null");
  assert.equal(stringifyForInlineScript(-0), "0");
  assert.equal(stringifyForInlineScript('"quoted"'), '"\\"quoted\\""');
  assert.throws(() => stringifyForInlineScript(1n), /BigInt/u);
});

test("every screenshot harness inline payload uses the script-safe serializer", () => {
  const source = readFileSync(new URL("./capture-screenshots.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\$\{\s*JSON\.stringify/u);

  for (const expression of [
    "stringifyForInlineScript(sessionPayload)",
    "stringifyForInlineScript(columnValues)",
    "stringifyForInlineScript(suppliedPages)",
    "stringifyForInlineScript(stepInspections)",
    "stringifyForInlineScript(strictProjectedPages)",
    "stringifyForInlineScript(fetchColumnBlockSize)",
    "stringifyForInlineScript(editorAction)",
    "stringifyForInlineScript(appearance.followupMessage)",
    'stringifyForInlineScript(`th[data-column="${openColumnFilter}"]`)',
    "stringifyForInlineScript(payload)",
    "stringifyForInlineScript(code)"
  ]) {
    assert.ok(source.includes(expression), `Missing script-safe serialization for ${expression}.`);
  }
});

test("webview browser discovery permits only the pinned executable or an absolute override", () => {
  const environment = { HOME: "/original/home", XDG_CACHE_HOME: "/original/cache" };
  const snapshot = { ...environment };
  const pinned = resolveWebviewBrowserExecutable({
    chromium: { executablePath: () => process.execPath },
    environment,
    platform: process.platform
  });
  assert.deepEqual(pinned, { executablePath: process.execPath, explicitOverride: false });
  assert.deepEqual(environment, snapshot);

  const overridden = resolveWebviewBrowserExecutable({
    chromium: {
      executablePath() {
        throw new Error("An explicit browser must not fall back to Playwright discovery.");
      }
    },
    environment: { CHROME_BIN: process.execPath },
    platform: process.platform
  });
  assert.deepEqual(overridden, { executablePath: process.execPath, explicitOverride: true });
  assert.throws(
    () =>
      resolveWebviewBrowserExecutable({
        chromium: { executablePath: () => process.execPath },
        environment: { CHROME_BIN: "relative-browser" },
        platform: process.platform
      }),
    /must be an absolute/u
  );
});

test("webview browser isolation keeps ambient state untouched and removes its unique profiles", () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-webview-isolation-test-"));
  chmodSync(parent, 0o700);
  const environment = { HOME: "/inherited/home", XDG_CACHE_HOME: "/inherited/cache", SAFE_VALUE: "retained" };
  const snapshot = { ...environment };
  try {
    const isolation = createWebviewBrowserIsolation({
      workspaceTmp: parent,
      environment,
      platform: process.platform,
      rootPrefix: "browser-test-",
      aliasPrefix: "ow-browser-test-",
      shortTempParent: tmpdir()
    });
    const browserRoot = isolation.root;
    const aliasRoot = process.platform === "win32" ? undefined : dirname(isolation.childEnvironment.TMPDIR);
    assert.deepEqual(environment, snapshot);
    assert.equal(isolation.childEnvironment.SAFE_VALUE, "retained");
    assert.equal(isolation.childEnvironment.HOME.startsWith(browserRoot), true);
    assert.equal(isolation.childEnvironment.XDG_RUNTIME_DIR.startsWith(browserRoot), true);
    if (process.platform !== "win32") {
      assert.equal(realpathSync(isolation.childEnvironment.TMPDIR), realpathSync(join(browserRoot, "temp")));
      assert.equal(lstatSync(isolation.childEnvironment.TMPDIR).isSymbolicLink(), true);
      assert.equal(statSync(aliasRoot).mode & 0o777, 0o700);
    }
    const first = isolation.createProfile("first");
    const second = isolation.createProfile("second");
    assert.notEqual(first, second);
    assert.equal(first.startsWith(join(browserRoot, "profiles")), true);
    assert.equal(second.startsWith(join(browserRoot, "profiles")), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(browserRoot).mode & 0o777, 0o700);
    }
    isolation.cleanup();
    assert.equal(existsSync(browserRoot), false);
    if (aliasRoot) assert.equal(existsSync(aliasRoot), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("browser preflight timeout is single-attempt, classified, explicit-profile, and cleanup-bound", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-webview-launch-test-"));
  chmodSync(parent, 0o700);
  let calls = 0;
  let profile;
  try {
    await assert.rejects(
      () =>
        preflightWebviewBrowser({
          chromium: {
            executablePath() {
              throw new Error("The explicit override must bypass Playwright browser discovery.");
            },
            async launchPersistentContext(candidate, options) {
              calls += 1;
              profile = candidate;
              assert.equal(existsSync(profile), true);
              assert.equal(options.executablePath, process.execPath);
              assert.equal(options.env.HOME.includes("webview-browser-preflight-"), true);
              assert.ok(options.timeout > 0 && options.timeout <= 30_000);
              throw Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" });
            }
          },
          cwd: parent,
          workspaceTmp: parent,
          environment: { CHROME_BIN: process.execPath },
          platform: process.platform,
          shortTempParent: tmpdir()
        }),
      (error) =>
        error.code === WEBVIEW_BROWSER_PREREQUISITE_FAILURE &&
        error.message === `${WEBVIEW_BROWSER_PREREQUISITE_FAILURE}: synthetic timeout`
    );
    assert.equal(calls, 1);
    assert.equal(existsSync(profile), false);
    assert.deepEqual(
      readdirSync(parent).filter((entry) => entry.startsWith("webview-browser-preflight-")),
      []
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("selector readiness requires exact completed profiles without placeholders or harness errors", () => {
  const readiness = completedHeaderReadiness();
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.argument.selectors), true);
  assert.equal(readiness.predicate(readiness.argument, readinessScope()), true);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ completedCount: 1 })), false);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ headerCount: 3 })), false);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ emptyCount: 1 })), false);
  assert.equal(readiness.predicate(readiness.argument, readinessScope({ texts: ["Ready", "Profiling…"] })), false);
  assert.throws(
    () => readiness.predicate(readiness.argument, readinessScope({ errors: ["synthetic harness error"] })),
    /openWranglerHarnessErrors reported an error/u
  );
});

test("filter-panel readiness binds the open drawer, active view, exact fixture rules, and values", () => {
  const readiness = createFilterPanelScreenshotReadiness();
  const selectors = readiness.argument.selectors.map(({ selector, count }) => [selector, count]);
  assert.equal(readiness.description, "the open city filter panel with its exact active filter fixture");
  assert.deepEqual(selectors, [
    [
      'button[aria-label="Column profiles and filters"][aria-expanded="true"][aria-controls="openwrangler-insights-panel"]',
      1
    ],
    ['aside#openwrangler-insights-panel.sidebar[aria-label="Column profiles and filters"]', 1],
    ['#openwrangler-insights-panel .summaryPanel[data-active-view="filters"]', 1],
    [
      '#openwrangler-insights-tab-filters[role="tab"][aria-selected="true"][aria-controls="openwrangler-insights-view-filters"]',
      1
    ],
    [
      '#openwrangler-insights-view-filters.filtersViewContent[role="tabpanel"][aria-labelledby="openwrangler-insights-tab-filters"]',
      1
    ],
    ["#openwrangler-insights-view-filters .panel.filterSortPanel", 1],
    ['#openwrangler-insights-view-filters .activeFilterOverview[aria-label="Active filters"]', 1],
    ['#openwrangler-insights-view-filters .activeFilterGroup[aria-label="city filters"]', 1],
    ["#openwrangler-insights-view-filters .rulePill.rulePillButton", 3],
    [`#openwrangler-insights-view-filters button[aria-label='Remove equals "Berlin" filter from city']`, 1],
    [`#openwrangler-insights-view-filters button[aria-label='Remove equals "Milan" filter from city']`, 1],
    [`#openwrangler-insights-view-filters button[aria-label='Remove contains "i" filter from city']`, 1],
    ['#openwrangler-insights-view-filters select[aria-label="Filter column"]', 1],
    ['#openwrangler-insights-view-filters input[aria-label="Search values for city"]', 1],
    ['#openwrangler-insights-view-filters button[aria-label="Search values in city"]', 1],
    ["#openwrangler-insights-view-filters .valueList > label.checkboxRow", 2]
  ]);
  assert.deepEqual(readiness.argument.emptyArrayGlobals, ["openWranglerHarnessErrors"]);
  assert.equal(readiness.predicate(readiness.argument, filterPanelReadinessScope(readiness)), true);

  for (const selector of [selectors[0][0], selectors[2][0], selectors[7][0], selectors[11][0], selectors[15][0]]) {
    assert.equal(
      readiness.predicate(
        readiness.argument,
        filterPanelReadinessScope(readiness, { selectorCountOverrides: { [selector]: 0 } })
      ),
      false,
      `Readiness must reject missing ${selector}.`
    );
  }
  assert.throws(
    () =>
      readiness.predicate(
        readiness.argument,
        filterPanelReadinessScope(readiness, { errors: ["synthetic filter harness error"] })
      ),
    /openWranglerHarnessErrors reported an error/u
  );
});

test("filter-panel capture waits for exact readiness and re-confirms it immediately before writing", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-filter-readiness-test-"));
  const readiness = createFilterPanelScreenshotReadiness();
  const openDrawerSelector = readiness.argument.selectors[0].selector;
  const capture = mockScreenshotCapture({
    parent,
    onWaitForFunction(predicate, argument) {
      assert.equal(predicate, readiness.predicate);
      assert.equal(
        predicate(
          argument,
          filterPanelReadinessScope(readiness, { selectorCountOverrides: { [openDrawerSelector]: 0 } })
        ),
        false
      );
      assert.equal(predicate(argument, filterPanelReadinessScope(readiness)), true);
    },
    onReadinessConfirmation(predicate, argument) {
      return predicate(argument, filterPanelReadinessScope(readiness));
    }
  });
  try {
    await captureWebviewScreenshot({ ...capture.options, readiness });
    assert.ok(capture.order.indexOf("readiness-wait") < capture.order.indexOf("readiness-confirm"));
    assert.ok(capture.order.indexOf("readiness-confirm") < capture.order.indexOf("screenshot"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("filter-panel capture rejects stale readiness without writing an image", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-filter-readiness-stale-test-"));
  const readiness = createFilterPanelScreenshotReadiness();
  const activeFilterSelector = readiness.argument.selectors[7].selector;
  const capture = mockScreenshotCapture({
    parent,
    onWaitForFunction() {},
    onReadinessConfirmation(predicate, argument) {
      return predicate(
        argument,
        filterPanelReadinessScope(readiness, { selectorCountOverrides: { [activeFilterSelector]: 0 } })
      );
    }
  });
  try {
    await assert.rejects(
      () => captureWebviewScreenshot({ ...capture.options, readiness }),
      /Webview readiness was lost before capture for the open city filter panel with its exact active filter fixture\./u
    );
    assert.equal(capture.order.includes("screenshot"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("screenshot capture waits for semantic readiness and confirms it before writing", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-wait-test-"));
  const readiness = completedHeaderReadiness();
  const capture = mockScreenshotCapture({
    parent,
    onWaitForFunction(predicate, argument, options) {
      assert.equal(predicate, readiness.predicate);
      assert.ok(options.timeout > 0 && options.timeout < 30_000);
      assert.equal(predicate(argument, readinessScope({ completedCount: 1, emptyCount: 1 })), false);
      assert.equal(predicate(argument, readinessScope()), true);
    },
    onReadinessConfirmation(predicate, argument) {
      return predicate(argument, readinessScope());
    }
  });
  try {
    const result = await captureWebviewScreenshot({ ...capture.options, readiness });
    assert.equal(result.outputPath, capture.outputPath);
    assert.deepEqual(Object.keys(capture.timeouts), ["launch", "navigation", "readiness", "screenshot"]);
    assert.ok(capture.timeouts.launch > capture.timeouts.navigation);
    assert.ok(capture.timeouts.navigation > capture.timeouts.readiness);
    assert.ok(capture.timeouts.readiness > capture.timeouts.screenshot);
    assert.deepEqual(capture.clockInstallOptions(), { time: 0 });
    assert.ok(capture.order.indexOf("clock-fix-time") < capture.order.indexOf("clock-pause"));
    assert.ok(capture.order.indexOf("clock-pause") < capture.order.indexOf("goto"));
    assert.ok(capture.order.indexOf("clock-reset-time") < capture.order.indexOf("goto"));
    assert.ok(capture.order.indexOf("clock-resume") < capture.order.indexOf("readiness-wait"));
    assert.ok(capture.order.indexOf("readiness-wait") < capture.order.indexOf("readiness-confirm"));
    assert.ok(capture.order.indexOf("readiness-confirm") < capture.order.indexOf("screenshot"));
    assert.equal(capture.closeCalls(), 1);
    assert.deepEqual(
      readdirSync(parent).filter((entry) => entry.startsWith("readiness-capture-")),
      []
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("readiness clock pauses safely after post-install real-time advancement", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-clock-race-test-"));
  const readiness = completedHeaderReadiness();
  const capture = mockScreenshotCapture({
    parent,
    clockAdvanceAfterInstall: 250,
    onWaitForFunction() {},
    onReadinessConfirmation(predicate, argument) {
      return predicate(argument, readinessScope());
    }
  });
  try {
    await captureWebviewScreenshot({ ...capture.options, readiness });
    assert.ok(capture.order.indexOf("clock-install") < capture.order.indexOf("clock-fix-time"));
    assert.ok(capture.order.indexOf("clock-fix-time") < capture.order.indexOf("clock-pause"));
    assert.ok(capture.order.indexOf("clock-pause") < capture.order.indexOf("clock-reset-time"));
    assert.ok(capture.order.indexOf("clock-reset-time") < capture.order.indexOf("goto"));
    assert.equal(capture.order.includes("screenshot"), true);
    assert.equal(capture.closeCalls(), 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("readiness timeout and lost readiness fail without taking a screenshot", async (context) => {
  await context.test("timeout", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ow-readiness-timeout-test-"));
    const readiness = completedHeaderReadiness();
    const capture = mockScreenshotCapture({
      parent,
      onWaitForFunction() {
        throw new Error("synthetic readiness timeout");
      }
    });
    try {
      await assert.rejects(
        () => captureWebviewScreenshot({ ...capture.options, readiness }),
        (error) =>
          error.message === "Webview readiness failed for test header profiles." &&
          error.cause?.message === "synthetic readiness timeout"
      );
      assert.equal(capture.order.includes("screenshot"), false);
      assert.equal(capture.closeCalls(), 1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  await context.test("predicate no longer holds", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ow-readiness-lost-test-"));
    const readiness = completedHeaderReadiness();
    const capture = mockScreenshotCapture({
      parent,
      onWaitForFunction() {},
      onReadinessConfirmation() {
        return false;
      }
    });
    try {
      await assert.rejects(
        () => captureWebviewScreenshot({ ...capture.options, readiness }),
        /Webview readiness was lost before capture for test header profiles\./u
      );
      assert.equal(capture.order.includes("screenshot"), false);
      assert.equal(capture.closeCalls(), 1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("screenshot capture does not add readiness work when the option is omitted", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-omitted-test-"));
  const capture = mockScreenshotCapture({
    parent,
    onWaitForFunction() {
      throw new Error("readiness must not be called");
    }
  });
  try {
    await captureWebviewScreenshot(capture.options);
    assert.equal(capture.order.includes("readiness-wait"), false);
    assert.equal(capture.order.includes("readiness-confirm"), false);
    assert.equal(capture.order.includes("clock-fix-time"), false);
    assert.equal(capture.order.includes("clock-pause"), false);
    assert.equal(capture.order.includes("clock-reset-time"), false);
    assert.equal(capture.order.includes("clock-resume"), false);
    assert.equal(capture.clockInstallOptions(), undefined);
    assert.equal(capture.order.includes("screenshot"), true);
    assert.equal(capture.closeCalls(), 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("capture deadline expiration prevents a readiness wait and screenshot", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ow-readiness-deadline-test-"));
  const readiness = completedHeaderReadiness();
  const capture = mockScreenshotCapture({ parent });
  const readings = [0, 1, 2, 30_000];
  let index = 0;
  try {
    await assert.rejects(
      () =>
        captureWebviewScreenshot({
          ...capture.options,
          readiness,
          monotonicNow() {
            return readings[index++] ?? readings.at(-1);
          }
        }),
      (error) =>
        error.message === "Webview readiness failed for test header profiles." &&
        error.cause?.message === "Webview capture deadline expired before semantic readiness."
    );
    assert.equal(capture.order.includes("readiness-wait"), false);
    assert.equal(capture.order.includes("screenshot"), false);
    assert.equal(capture.closeCalls(), 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("screenshot and accessibility consumers preserve browser isolation ordering", () => {
  const capture = readFileSync(new URL("./capture-screenshots.mjs", import.meta.url), "utf8");
  const accessibility = readFileSync(new URL("./test-webview-accessibility.mjs", import.meta.url), "utf8");
  const pythonPreflight = capture.indexOf("resolveAndPreflightAcceptancePython({");
  const preflight = capture.indexOf("preflightWebviewBrowser({", pythonPreflight);
  const payload = capture.indexOf("const payloads = JSON.parse(", preflight);
  assert.ok(pythonPreflight >= 0 && preflight > pythonPreflight && payload > preflight);
  assert.match(
    capture,
    /screenshotQueue = screenshotQueue\.then\(async \(\) => \{[\s\S]*await captureWebviewScreenshot\(/u
  );
  assert.match(capture, /await screenshotQueue;/u);
  assert.equal((capture.match(/readiness: byExamplePreviewReadiness/gu) ?? []).length, 3);
  assert.equal((capture.match(/readiness: filterPanelReadiness/gu) ?? []).length, 1);
  assert.match(
    capture,
    /const observer = new MutationObserver\(commitOpenColumnFilter\);[\s\S]*observer\.observe\(document\.body, \{ childList: true, subtree: true \}\);[\s\S]*commitOpenColumnFilter\(\);/u
  );
  assert.match(capture, /observer\.disconnect\(\);/u);
  assert.doesNotMatch(capture, /filter\?\.click\(\)|openColumnFilter\s*\?\s*`setTimeout/u);
  assert.match(capture, /byExampleHeaderCount !== 2/u);
  assert.doesNotMatch(capture, /process\.env\.(?:HOME|XDG_[A-Z_]+|TMPDIR?)\s*=/u);

  const browserHelper = readFileSync(new URL("./webview-browser.mjs", import.meta.url), "utf8");
  assert.match(browserHelper, /chromium\.launchPersistentContext\(profile,/u);
  assert.doesNotMatch(browserHelper, /spawnSync|chromium_headless_shell|--headless=new/u);

  const acceptanceCommand = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).scripts[
    "test:webview-acceptance:run"
  ];
  assert.match(
    acceptanceCommand,
    /^node scripts\/packaged-python-preflight\.mjs visual && node scripts\/webview-browser\.mjs && npm run brand:render-check/u
  );

  const accessibilityDiscovery = accessibility.indexOf("resolveWebviewBrowserExecutable({ chromium })");
  const accessibilityIsolation = accessibility.indexOf("createWebviewBrowserIsolation({", accessibilityDiscovery);
  const accessibilityLaunch = accessibility.indexOf("chromium.launchPersistentContext(", accessibilityIsolation);
  const firstHarnessScan = accessibility.indexOf("for (const harness of harnesses)", accessibilityLaunch);
  assert.ok(
    accessibilityDiscovery >= 0 &&
      accessibilityIsolation > accessibilityDiscovery &&
      accessibilityLaunch > accessibilityIsolation &&
      firstHarnessScan > accessibilityLaunch
  );
  assert.match(
    accessibility,
    /browserExecutable\.explicitOverride \? \{ executablePath: browserExecutable\.executablePath \} : \{\}/u
  );
  assert.match(accessibility, /env: browserIsolation\.childEnvironment/u);
  assert.match(accessibility, /finally \{[\s\S]*browserIsolation\.cleanup\(\)/u);
  assert.doesNotMatch(accessibility, /process\.env\.(?:HOME|XDG_[A-Z_]+|TMPDIR?)\s*=/u);
  assert.equal((accessibility.match(/recordAxeScanResult\(harness, result\.violations\);/gu) ?? []).length, 2);
  assert.equal(
    (accessibility.match(/process\.stdout\.write\(serializeAxeMachineResult\(result\)\);/gu) ?? []).length,
    2
  );
  assert.doesNotMatch(accessibility, /console\.log\(serializeAxeMachineResult/u);
  assert.doesNotMatch(accessibility, /violations\.filter|impact\s*!==\s*["']minor["']/u);
  assert.match(
    accessibility,
    /const axeReport = axeResults\.report\(\);[\s\S]*if \(axeReport\.unapprovedFindingCount > 0\) \{[\s\S]*throw new Error\(`Webview accessibility scan failed:/u
  );

  for (const file of ["generate-brand-assets.mjs", "verify-readme-responsive-render.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /resolveWebviewBrowserExecutable\(\{ chromium \}\)/u);
    assert.match(source, /chromium\.launchPersistentContext\(browserIsolation\.createProfile\(/u);
    assert.match(source, /env: browserIsolation\.childEnvironment/u);
    assert.match(source, /browserIsolation\.cleanup\(\)/u);
    assert.doesNotMatch(source, /chromium\.launch\(/u);
  }
});
