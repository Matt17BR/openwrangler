import { types as utilTypes } from "node:util";

export const AXE_MACHINE_RESULT_PREFIX = "OPEN_WRANGLER_AXE_RESULT ";
export const AXE_SCAN_RESULT_PROTOCOL = "openwrangler-axe-scan-result-v1";
export const AXE_RUN_RESULT_PROTOCOL = "openwrangler-axe-run-result-v1";
export const AXE_RESULT_LIMITS = Object.freeze({
  scans: 128,
  findingsPerScan: 256,
  findingsPerRun: 512,
  nodesPerFinding: 10_000,
  nodesPerScan: 50_000,
  nodesPerRun: 100_000,
  diagnosticNodesPerFinding: 5,
  harnessCodePoints: 256,
  idCodePoints: 128,
  helpCodePoints: 512,
  targetCodePoints: 512,
  targetParts: 16,
  targetArrayEntries: 16,
  targetTraversalEntries: 64,
  targetDepth: 4,
  failureSummaryCodePoints: 512,
  rawImpactCodePoints: 32,
  machineResultUtf8Bytes: 2 * 1024 * 1024,
  machineResultGraphNodes: 100_000
});

const IMPACT_ORDER = Object.freeze(["critical", "serious", "moderate", "minor", "unknown"]);
const KNOWN_IMPACTS = new Set(IMPACT_ORDER.slice(0, -1));
const CLASSIFICATION_ERROR_CODES = new Set([
  "duplicate_harness",
  "invalid_findings",
  "invalid_harness",
  "invalid_machine_result",
  "machine_result_too_large",
  "too_many_machine_result_nodes",
  "too_many_finding_nodes",
  "too_many_run_findings",
  "too_many_run_nodes",
  "too_many_scan_findings",
  "too_many_scan_nodes",
  "too_many_scans"
]);
const { isProxy } = utilTypes;

function defineOwnDataProperty(target, property, value) {
  Object.defineProperty(target, property, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function appendOwnArrayEntry(values, value) {
  defineOwnDataProperty(values, String(values.length), value);
}

function sortOwnArray(values, compare) {
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    let destination = index;
    while (destination > 0 && compare(values[destination - 1], value) > 0) {
      defineOwnDataProperty(values, String(destination), values[destination - 1]);
      destination -= 1;
    }
    defineOwnDataProperty(values, String(destination), value);
  }
}

export class AxeResultClassificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    defineOwnDataProperty(this, "name", "AxeResultClassificationError");
    defineOwnDataProperty(this, "code", code);
    defineOwnDataProperty(this, "actual", details.actual);
    defineOwnDataProperty(this, "limit", details.limit);
  }
}

export function createAxeResultCollector() {
  const scans = new Map();
  let findingCount = 0;
  let nodeCount = 0;

  return Object.freeze({
    record(input) {
      if (scans.size >= AXE_RESULT_LIMITS.scans) {
        throw classificationLimitError("too_many_scans", "Axe scan count", scans.size + 1, AXE_RESULT_LIMITS.scans);
      }
      const envelope = captureAxeScanEnvelope(input);
      if (scans.has(envelope.harness)) {
        throw new AxeResultClassificationError(
          "duplicate_harness",
          `Axe scan results repeated the harness ${JSON.stringify(envelope.harness)}.`
        );
      }
      if (findingCount + envelope.findingCount > AXE_RESULT_LIMITS.findingsPerRun) {
        throw classificationLimitError(
          "too_many_run_findings",
          "Axe run finding count",
          findingCount + envelope.findingCount,
          AXE_RESULT_LIMITS.findingsPerRun
        );
      }
      const prepared = prepareAxeScanInput(envelope, nodeCount);
      const scan = classifyPreparedAxeScan(prepared);
      scans.set(scan.harness, scan);
      findingCount += scan.findingCount;
      nodeCount += prepared.nodeCount;
      return scan;
    },

    report() {
      const orderedScans = [];
      for (const scan of scans.values()) appendOwnArrayEntry(orderedScans, scan);
      sortOwnArray(orderedScans, (left, right) => compareText(left.harness, right.harness));
      return Object.freeze({
        protocol: AXE_RUN_RESULT_PROTOCOL,
        status: findingCount === 0 ? "passed" : "failed",
        scanCount: orderedScans.length,
        findingCount,
        unapprovedFindingCount: findingCount,
        scans: Object.freeze(orderedScans)
      });
    }
  });
}

export function classifyAxeScanResult(input) {
  return classifyPreparedAxeScan(prepareAxeScanInput(captureAxeScanEnvelope(input), 0));
}

function captureAxeScanEnvelope(input) {
  const envelope = requirePlainRecord(input, "invalid_findings", "Axe scan results must be plain objects.");
  const harness = readOwnDataProperty(
    envelope,
    "harness",
    "invalid_findings",
    "Axe scan result fields must be own data properties."
  );
  const violations = readOwnDataProperty(
    envelope,
    "violations",
    "invalid_findings",
    "Axe scan result fields must be own data properties."
  );
  const normalizedHarness = boundedText(harness, "", AXE_RESULT_LIMITS.harnessCodePoints);
  if (normalizedHarness.value.length === 0 || normalizedHarness.truncated) {
    throw new AxeResultClassificationError(
      "invalid_harness",
      `Axe harness must contain at most ${AXE_RESULT_LIMITS.harnessCodePoints} non-empty code points.`
    );
  }
  const violationCount = readPlainArrayLength(violations, "invalid_findings", "Axe violations must be a plain array.");
  if (violationCount > AXE_RESULT_LIMITS.findingsPerScan) {
    throw classificationLimitError(
      "too_many_scan_findings",
      `Axe findings for ${normalizedHarness.value}`,
      violationCount,
      AXE_RESULT_LIMITS.findingsPerScan
    );
  }

  return Object.freeze({
    harness: normalizedHarness.value,
    violations,
    findingCount: violationCount
  });
}

function prepareAxeScanInput(envelope, existingRunNodeCount) {
  const preflightFindings = [];
  let nodeCount = 0;
  for (let index = 0; index < envelope.findingCount; index += 1) {
    const findingEntry = readOwnArrayEntry(
      envelope.violations,
      index,
      "invalid_findings",
      "Axe violation entries must be own data properties."
    );
    const sourceFinding = requireOptionalPlainRecord(
      findingEntry.present ? findingEntry.value : undefined,
      "invalid_findings",
      "Axe violations must contain plain objects."
    );
    const findingNodes = readOwnDataProperty(
      sourceFinding,
      "nodes",
      "invalid_findings",
      "Axe finding fields must be own data properties."
    );
    const findingNodeCount =
      findingNodes === undefined
        ? 0
        : readPlainArrayLength(findingNodes, "invalid_findings", "Axe finding nodes must be plain arrays.");
    const remainingNodeLimit = Math.min(
      AXE_RESULT_LIMITS.nodesPerFinding,
      AXE_RESULT_LIMITS.nodesPerScan - nodeCount,
      AXE_RESULT_LIMITS.nodesPerRun - existingRunNodeCount - nodeCount
    );
    if (findingNodeCount > remainingNodeLimit) {
      if (findingNodeCount > AXE_RESULT_LIMITS.nodesPerFinding) {
        throw classificationLimitError(
          "too_many_finding_nodes",
          "Axe affected-node count",
          findingNodeCount,
          AXE_RESULT_LIMITS.nodesPerFinding
        );
      }
      if (nodeCount + findingNodeCount > AXE_RESULT_LIMITS.nodesPerScan) {
        throw classificationLimitError(
          "too_many_scan_nodes",
          `Axe affected-node count for ${envelope.harness}`,
          nodeCount + findingNodeCount,
          AXE_RESULT_LIMITS.nodesPerScan
        );
      }
      throw classificationLimitError(
        "too_many_run_nodes",
        "Axe run affected-node count",
        existingRunNodeCount + nodeCount + findingNodeCount,
        AXE_RESULT_LIMITS.nodesPerRun
      );
    }
    nodeCount += findingNodeCount;
    appendOwnArrayEntry(preflightFindings, Object.freeze({ sourceFinding, findingNodes, findingNodeCount }));
  }

  const sourceFindings = [];
  const sourceNodes = [];
  for (const preflight of preflightFindings) {
    appendOwnArrayEntry(sourceFindings, snapshotFinding(preflight.sourceFinding));
    appendOwnArrayEntry(sourceNodes, snapshotFindingNodes(preflight.findingNodes, preflight.findingNodeCount));
  }

  return Object.freeze({
    harness: envelope.harness,
    findingCount: envelope.findingCount,
    nodeCount,
    sourceFindings: Object.freeze(sourceFindings),
    sourceNodes: Object.freeze(sourceNodes)
  });
}

function classifyPreparedAxeScan(prepared) {
  const findings = [];
  for (let index = 0; index < prepared.sourceFindings.length; index += 1) {
    appendOwnArrayEntry(findings, normalizeFinding(prepared.sourceFindings[index], prepared.sourceNodes[index]));
  }
  sortOwnArray(findings, compareFindings);
  return Object.freeze({
    protocol: AXE_SCAN_RESULT_PROTOCOL,
    harness: prepared.harness,
    status: findings.length === 0 ? "passed" : "failed",
    findingCount: findings.length,
    unapprovedFindingCount: findings.length,
    findings: Object.freeze(findings)
  });
}

export function serializeAxeMachineResult(result) {
  const budget = createMachineResultBudget();
  budget.chargeAscii(AXE_MACHINE_RESULT_PREFIX.length + 1);
  const snapshot = snapshotJsonValue(result, budget, new WeakSet(), 0);
  return `${AXE_MACHINE_RESULT_PREFIX}${JSON.stringify(snapshot)}\n`;
}

export function serializeAxeClassificationError(error) {
  return serializeAxeMachineResult(classificationErrorResult(error));
}

export function formatAxeFailureDetail(report) {
  let detail = "";
  for (let scanIndex = 0; scanIndex < report.scans.length; scanIndex += 1) {
    const scan = report.scans[scanIndex];
    for (let findingIndex = 0; findingIndex < scan.findings.length; findingIndex += 1) {
      const finding = scan.findings[findingIndex];
      const rawImpact = finding.impact === "unknown" ? `:${finding.rawImpact ?? "null"}` : "";
      let nodes = "";
      for (let nodeIndex = 0; nodeIndex < finding.nodes.length; nodeIndex += 1) {
        const node = finding.nodes[nodeIndex];
        nodes += `${nodes.length > 0 ? "\n" : ""}  ${node.target}: ${node.failureSummary}`;
      }
      if (finding.omittedNodeCount > 0) {
        nodes += `${nodes.length > 0 ? "\n" : ""}  … ${
          finding.omittedNodeCount
        } additional affected nodes omitted from bounded diagnostics`;
      }
      detail += `${detail.length > 0 ? "\n" : ""}${scan.harness}: [${finding.impact}${rawImpact}] ${finding.id}: ${
        finding.help
      }${nodes.length > 0 ? `\n${nodes}` : ""}`;
    }
  }
  return detail;
}

function normalizeFinding(violation, preparedNodes) {
  const finding = violation;
  const impact = KNOWN_IMPACTS.has(finding.impact) ? finding.impact : "unknown";
  const rawImpact =
    impact === "unknown" && typeof finding.impact === "string"
      ? boundedText(finding.impact, "unknown", AXE_RESULT_LIMITS.rawImpactCodePoints)
      : { value: null, truncated: false };
  const id = boundedText(finding.id, "unknown-rule", AXE_RESULT_LIMITS.idCodePoints);
  const help = boundedText(finding.help, "Axe finding", AXE_RESULT_LIMITS.helpCodePoints);
  const diagnosticNodes = [];
  for (let index = 0; index < preparedNodes.count; index += 1) {
    insertDiagnosticNode(diagnosticNodes, normalizeNode(preparedNodes.values[index]));
  }

  return Object.freeze({
    impact,
    rawImpact: rawImpact.value,
    rawImpactTruncated: rawImpact.truncated,
    id: id.value,
    idTruncated: id.truncated,
    help: help.value,
    helpTruncated: help.truncated,
    nodeCount: preparedNodes.count,
    omittedNodeCount: Math.max(0, preparedNodes.count - diagnosticNodes.length),
    nodes: Object.freeze(diagnosticNodes)
  });
}

function normalizeNode(node) {
  const findingNode = node;
  const target = boundedTarget(findingNode.target);
  const failureSummary = boundedText(
    findingNode.failureSummary,
    "Axe check failed",
    AXE_RESULT_LIMITS.failureSummaryCodePoints
  );
  return Object.freeze({
    target: target.value,
    targetTruncated: target.truncated,
    failureSummary: failureSummary.value,
    failureSummaryTruncated: failureSummary.truncated
  });
}

function boundedTarget(target) {
  let text = "";
  let codePointCount = 0;
  let partCount = 0;
  let traversalEntryCount = 0;
  let truncated = false;
  let stopped = false;

  const append = (value) => {
    for (const codePoint of value) {
      if (codePointCount >= AXE_RESULT_LIMITS.targetCodePoints) {
        truncated = true;
        stopped = true;
        return;
      }
      text += visibleDiagnosticCodePoint(codePoint);
      codePointCount += 1;
    }
  };

  const visit = (value, depth) => {
    if (stopped) return;
    if (value !== null && typeof value === "object" && isProxy(value)) {
      throw new AxeResultClassificationError("invalid_findings", "Axe target proxies are forbidden.");
    }
    if (typeof value === "string") {
      if (partCount >= AXE_RESULT_LIMITS.targetParts) {
        truncated = true;
        stopped = true;
        return;
      }
      if (partCount > 0) append(" > ");
      if (!stopped) append(value);
      partCount += 1;
      return;
    }
    if (!Array.isArray(value)) {
      if (value !== null && value !== undefined) truncated = true;
      return;
    }
    if (depth >= AXE_RESULT_LIMITS.targetDepth) {
      truncated = true;
      return;
    }

    const targetLength = readPlainArrayLength(value, "invalid_findings", "Axe targets must use plain arrays.");
    const entryCount = Math.min(targetLength, AXE_RESULT_LIMITS.targetArrayEntries);
    if (targetLength > entryCount) truncated = true;
    for (let index = 0; index < entryCount && !stopped; index += 1) {
      if (codePointCount >= AXE_RESULT_LIMITS.targetCodePoints) {
        truncated = true;
        stopped = true;
        break;
      }
      traversalEntryCount += 1;
      if (traversalEntryCount > AXE_RESULT_LIMITS.targetTraversalEntries) {
        truncated = true;
        stopped = true;
        break;
      }
      const entry = readOwnArrayEntry(
        value,
        index,
        "invalid_findings",
        "Axe target entries must be own data properties."
      );
      if (!entry.present) {
        truncated = true;
        continue;
      }
      visit(entry.value, depth + 1);
    }
  };

  visit(target, 0);
  text = text.replace(/\s+/gu, " ").trim();
  if (text.length === 0) text = "<unavailable target>";
  return { value: `${text}${truncated ? "…" : ""}`, truncated };
}

function insertDiagnosticNode(nodes, node) {
  appendOwnArrayEntry(nodes, node);
  sortOwnArray(nodes, compareNodes);
  if (nodes.length > AXE_RESULT_LIMITS.diagnosticNodesPerFinding) {
    nodes.length = AXE_RESULT_LIMITS.diagnosticNodesPerFinding;
  }
}

function boundedText(value, fallback, maxCodePoints) {
  const source = typeof value === "string" ? value : fallback;
  let text = "";
  let count = 0;
  let truncated = false;
  for (const codePoint of source) {
    if (count >= maxCodePoints) {
      truncated = true;
      break;
    }
    text += visibleDiagnosticCodePoint(codePoint);
    count += 1;
  }
  text = text.replace(/\s+/gu, " ").trim();
  return { value: `${text}${truncated ? "…" : ""}`, truncated };
}

function compareFindings(left, right) {
  return (
    IMPACT_ORDER.indexOf(left.impact) - IMPACT_ORDER.indexOf(right.impact) ||
    compareText(left.id, right.id) ||
    compareText(left.help, right.help) ||
    compareText(left.rawImpact ?? "", right.rawImpact ?? "") ||
    left.nodeCount - right.nodeCount ||
    compareText(JSON.stringify(left.nodes), JSON.stringify(right.nodes))
  );
}

function compareNodes(left, right) {
  return compareText(left.target, right.target) || compareText(left.failureSummary, right.failureSummary);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createMachineResultBudget() {
  let size = 0;
  let graphNodes = 0;
  return Object.freeze({
    chargeAscii(bytes) {
      const nextSize = size + bytes;
      if (nextSize > AXE_RESULT_LIMITS.machineResultUtf8Bytes) {
        throw classificationLimitError(
          "machine_result_too_large",
          "Axe machine result UTF-8 size",
          nextSize,
          AXE_RESULT_LIMITS.machineResultUtf8Bytes
        );
      }
      size = nextSize;
    },
    rejectMinimumAscii(bytes) {
      throw classificationLimitError(
        "machine_result_too_large",
        "Axe machine result UTF-8 size",
        size + bytes,
        AXE_RESULT_LIMITS.machineResultUtf8Bytes
      );
    },
    remainingAscii() {
      return AXE_RESULT_LIMITS.machineResultUtf8Bytes - size;
    },
    chargeGraphNode() {
      const nextGraphNodes = graphNodes + 1;
      if (nextGraphNodes > AXE_RESULT_LIMITS.machineResultGraphNodes) {
        throw classificationLimitError(
          "too_many_machine_result_nodes",
          "Axe machine result graph-node count",
          nextGraphNodes,
          AXE_RESULT_LIMITS.machineResultGraphNodes
        );
      }
      graphNodes = nextGraphNodes;
    }
  });
}

function snapshotJsonValue(value, budget, ancestors, depth) {
  if (depth > 64) {
    throw new AxeResultClassificationError("invalid_machine_result", "Axe machine result nesting is invalid.");
  }
  if (value === null) {
    budget.chargeAscii(4);
    return null;
  }
  if (typeof value === "string") {
    chargeJsonString(value, budget);
    return value;
  }
  if (typeof value === "boolean") {
    budget.chargeAscii(value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    const serialized = JSON.stringify(value);
    budget.chargeAscii(serialized.length);
    return value;
  }
  if (typeof value !== "object") {
    throw new AxeResultClassificationError("invalid_machine_result", "Axe machine result values must be JSON-safe.");
  }
  if (isProxy(value)) {
    throw new AxeResultClassificationError("invalid_machine_result", "Axe machine result proxies are forbidden.");
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new AxeResultClassificationError("invalid_machine_result", "Axe machine result objects must be plain.");
  }
  if (Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined) {
    throw new AxeResultClassificationError("invalid_machine_result", "Axe machine result toJSON hooks are forbidden.");
  }
  if (ancestors.has(value)) {
    throw new AxeResultClassificationError("invalid_machine_result", "Axe machine result cycles are forbidden.");
  }
  budget.chargeGraphNode();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = readPlainArrayLength(value, "invalid_machine_result", "Axe machine result arrays must be plain.");
      budget.chargeAscii(2);
      const minimumEntryBytes = length === 0 ? 0 : length * 2 - 1;
      if (minimumEntryBytes > budget.remainingAscii()) budget.rejectMinimumAscii(minimumEntryBytes);
      const snapshot = [];
      Object.setPrototypeOf(snapshot, null);
      for (let index = 0; index < length; index += 1) {
        const entry = readOwnArrayEntry(
          value,
          index,
          "invalid_machine_result",
          "Axe machine result array entries must be own data properties."
        );
        if (!entry.present) {
          budget.chargeAscii(index > 0 ? 5 : 4);
          snapshot[index] = null;
        } else {
          if (index > 0) budget.chargeAscii(1);
          const snapshotEntry = snapshotJsonValue(entry.value, budget, ancestors, depth + 1);
          snapshot[index] = snapshotEntry;
        }
      }
      return snapshot;
    }

    const snapshot = Object.create(null);
    let propertyCount = 0;
    budget.chargeAscii(2);
    for (const key in value) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new AxeResultClassificationError("invalid_machine_result", "Axe machine result accessors are forbidden.");
      }
      budget.chargeAscii(propertyCount > 0 ? 1 : 0);
      chargeJsonString(key, budget);
      budget.chargeAscii(1);
      snapshot[key] = snapshotJsonValue(descriptor.value, budget, ancestors, depth + 1);
      propertyCount += 1;
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

function chargeJsonString(value, budget) {
  budget.chargeAscii(2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c || isShortJsonEscape(codeUnit)) {
      budget.chargeAscii(2);
    } else if (codeUnit <= 0x1f || (codeUnit >= 0xd800 && codeUnit <= 0xdfff)) {
      if (
        codeUnit >= 0xd800 &&
        codeUnit <= 0xdbff &&
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff
      ) {
        budget.chargeAscii(4);
        index += 1;
      } else {
        budget.chargeAscii(6);
      }
    } else if (codeUnit <= 0x7f) {
      budget.chargeAscii(1);
    } else if (codeUnit <= 0x7ff) {
      budget.chargeAscii(2);
    } else {
      budget.chargeAscii(3);
    }
  }
}

function isShortJsonEscape(codeUnit) {
  return codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d;
}

function visibleDiagnosticCodePoint(codePoint) {
  if (!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(codePoint)) return codePoint;
  const value = codePoint.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  return `\\u{${value}}`;
}

function classificationErrorResult(error) {
  if (
    error === null ||
    typeof error !== "object" ||
    isProxy(error) ||
    !(error instanceof AxeResultClassificationError)
  ) {
    return createClassificationErrorResult("classification_failed");
  }
  try {
    const code = readOwnDataProperty(
      error,
      "code",
      "invalid_machine_result",
      "Axe classification errors must use own data properties."
    );
    if (!CLASSIFICATION_ERROR_CODES.has(code)) return createClassificationErrorResult("classification_failed");
    const actual = readOwnDataProperty(
      error,
      "actual",
      "invalid_machine_result",
      "Axe classification errors must use own data properties."
    );
    const limit = readOwnDataProperty(
      error,
      "limit",
      "invalid_machine_result",
      "Axe classification errors must use own data properties."
    );
    return createClassificationErrorResult(code, actual, limit);
  } catch {
    return createClassificationErrorResult("classification_failed");
  }
}

function createClassificationErrorResult(code, actual, limit) {
  const result = Object.create(null);
  defineOwnDataProperty(result, "protocol", AXE_RUN_RESULT_PROTOCOL);
  defineOwnDataProperty(result, "status", "invalid");
  defineOwnDataProperty(result, "code", code);
  if (Number.isSafeInteger(actual)) defineOwnDataProperty(result, "actual", actual);
  if (Number.isSafeInteger(limit)) defineOwnDataProperty(result, "limit", limit);
  return Object.freeze(result);
}

function snapshotFinding(finding) {
  return Object.freeze({
    impact: readOwnDataProperty(
      finding,
      "impact",
      "invalid_findings",
      "Axe finding fields must be own data properties."
    ),
    id: readOwnDataProperty(finding, "id", "invalid_findings", "Axe finding fields must be own data properties."),
    help: readOwnDataProperty(finding, "help", "invalid_findings", "Axe finding fields must be own data properties.")
  });
}

function snapshotFindingNodes(nodes, count) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const entry = readOwnArrayEntry(nodes, index, "invalid_findings", "Axe node entries must be own data properties.");
    const node = requireOptionalPlainRecord(
      entry.present ? entry.value : undefined,
      "invalid_findings",
      "Axe nodes must contain plain objects."
    );
    appendOwnArrayEntry(
      values,
      Object.freeze({
        target: readOwnDataProperty(node, "target", "invalid_findings", "Axe node fields must be own data properties."),
        failureSummary: readOwnDataProperty(
          node,
          "failureSummary",
          "invalid_findings",
          "Axe node fields must be own data properties."
        )
      })
    );
  }
  return Object.freeze({ values: Object.freeze(values), count });
}

function requireOptionalPlainRecord(value, code, message) {
  if (value === undefined || value === null || typeof value !== "object") return Object.freeze({});
  return requirePlainRecord(value, code, message);
}

function requirePlainRecord(value, code, message) {
  if (value === null || typeof value !== "object" || isProxy(value)) {
    throw new AxeResultClassificationError(code, message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AxeResultClassificationError(code, message);
  }
  return value;
}

function readPlainArrayLength(value, code, message) {
  if (value === null || typeof value !== "object" || isProxy(value) || !Array.isArray(value)) {
    throw new AxeResultClassificationError(code, message);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new AxeResultClassificationError(code, message);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (descriptor === undefined || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value)) {
    throw new AxeResultClassificationError(code, message);
  }
  return descriptor.value;
}

function readOwnArrayEntry(value, index, code, message) {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!("value" in descriptor)) throw new AxeResultClassificationError(code, message);
  return { present: true, value: descriptor.value };
}

function readOwnDataProperty(value, property, code, message) {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new AxeResultClassificationError(code, message);
  return descriptor.value;
}

function classificationLimitError(code, label, actual, limit) {
  return new AxeResultClassificationError(code, `${label} ${actual} exceeds the bound ${limit}.`, { actual, limit });
}
