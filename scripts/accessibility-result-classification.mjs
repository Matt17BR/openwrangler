import { Buffer } from "node:buffer";

export const AXE_MACHINE_RESULT_PREFIX = "OPEN_WRANGLER_AXE_RESULT ";
export const AXE_SCAN_RESULT_PROTOCOL = "openwrangler-axe-scan-result-v1";
export const AXE_RUN_RESULT_PROTOCOL = "openwrangler-axe-run-result-v1";
export const AXE_RESULT_LIMITS = Object.freeze({
  scans: 128,
  findingsPerScan: 256,
  findingsPerRun: 512,
  nodesPerFinding: 10_000,
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
  machineResultUtf8Bytes: 2 * 1024 * 1024
});

const IMPACT_ORDER = Object.freeze(["critical", "serious", "moderate", "minor", "unknown"]);
const KNOWN_IMPACTS = new Set(IMPACT_ORDER.slice(0, -1));

export class AxeResultClassificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AxeResultClassificationError";
    this.code = code;
    this.actual = details.actual;
    this.limit = details.limit;
  }
}

export function createAxeResultCollector() {
  const scans = new Map();
  let findingCount = 0;

  return Object.freeze({
    record(input) {
      if (scans.size >= AXE_RESULT_LIMITS.scans) {
        throw classificationLimitError("too_many_scans", "Axe scan count", scans.size + 1, AXE_RESULT_LIMITS.scans);
      }
      const scan = classifyAxeScanResult(input);
      if (scans.has(scan.harness)) {
        throw new AxeResultClassificationError(
          "duplicate_harness",
          `Axe scan results repeated the harness ${JSON.stringify(scan.harness)}.`
        );
      }
      if (findingCount + scan.findingCount > AXE_RESULT_LIMITS.findingsPerRun) {
        throw classificationLimitError(
          "too_many_run_findings",
          "Axe run finding count",
          findingCount + scan.findingCount,
          AXE_RESULT_LIMITS.findingsPerRun
        );
      }
      scans.set(scan.harness, scan);
      findingCount += scan.findingCount;
      return scan;
    },

    report() {
      const orderedScans = [...scans.values()].sort((left, right) => compareText(left.harness, right.harness));
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

export function classifyAxeScanResult({ harness, violations }) {
  const normalizedHarness = boundedText(harness, "", AXE_RESULT_LIMITS.harnessCodePoints);
  if (normalizedHarness.value.length === 0 || normalizedHarness.truncated) {
    throw new AxeResultClassificationError(
      "invalid_harness",
      `Axe harness must contain at most ${AXE_RESULT_LIMITS.harnessCodePoints} non-empty code points.`
    );
  }
  if (!Array.isArray(violations)) {
    throw new AxeResultClassificationError("invalid_findings", "Axe violations must be an array.");
  }
  if (violations.length > AXE_RESULT_LIMITS.findingsPerScan) {
    throw classificationLimitError(
      "too_many_scan_findings",
      `Axe findings for ${normalizedHarness.value}`,
      violations.length,
      AXE_RESULT_LIMITS.findingsPerScan
    );
  }

  const findings = violations.map(normalizeFinding).sort(compareFindings);
  return Object.freeze({
    protocol: AXE_SCAN_RESULT_PROTOCOL,
    harness: normalizedHarness.value,
    status: findings.length === 0 ? "passed" : "failed",
    findingCount: findings.length,
    unapprovedFindingCount: findings.length,
    findings: Object.freeze(findings)
  });
}

export function serializeAxeMachineResult(result) {
  const record = `${AXE_MACHINE_RESULT_PREFIX}${JSON.stringify(result)}\n`;
  const size = Buffer.byteLength(record, "utf8");
  if (size > AXE_RESULT_LIMITS.machineResultUtf8Bytes) {
    throw classificationLimitError(
      "machine_result_too_large",
      "Axe machine result UTF-8 size",
      size,
      AXE_RESULT_LIMITS.machineResultUtf8Bytes
    );
  }
  return record;
}

export function serializeAxeClassificationError(error) {
  const classified = error instanceof AxeResultClassificationError;
  return `${AXE_MACHINE_RESULT_PREFIX}${JSON.stringify({
    protocol: AXE_RUN_RESULT_PROTOCOL,
    status: "invalid",
    code: classified ? error.code : "classification_failed",
    ...(classified && Number.isSafeInteger(error.actual) ? { actual: error.actual } : {}),
    ...(classified && Number.isSafeInteger(error.limit) ? { limit: error.limit } : {})
  })}\n`;
}

export function formatAxeFailureDetail(report) {
  return report.scans
    .flatMap((scan) =>
      scan.findings.map((finding) => {
        const rawImpact = finding.impact === "unknown" ? `:${finding.rawImpact ?? "null"}` : "";
        const nodes = finding.nodes.map((node) => `  ${node.target}: ${node.failureSummary}`);
        if (finding.omittedNodeCount > 0) {
          nodes.push(`  … ${finding.omittedNodeCount} additional affected nodes omitted from bounded diagnostics`);
        }
        return `${scan.harness}: [${finding.impact}${rawImpact}] ${finding.id}: ${finding.help}${
          nodes.length > 0 ? `\n${nodes.join("\n")}` : ""
        }`;
      })
    )
    .join("\n");
}

function normalizeFinding(violation) {
  const finding = violation !== null && typeof violation === "object" ? violation : {};
  const impact = KNOWN_IMPACTS.has(finding.impact) ? finding.impact : "unknown";
  const rawImpact =
    impact === "unknown" && typeof finding.impact === "string"
      ? boundedText(finding.impact, "unknown", AXE_RESULT_LIMITS.rawImpactCodePoints)
      : { value: null, truncated: false };
  const id = boundedText(finding.id, "unknown-rule", AXE_RESULT_LIMITS.idCodePoints);
  const help = boundedText(finding.help, "Axe finding", AXE_RESULT_LIMITS.helpCodePoints);
  const sourceNodes = Array.isArray(finding.nodes) ? finding.nodes : [];
  if (sourceNodes.length > AXE_RESULT_LIMITS.nodesPerFinding) {
    throw classificationLimitError(
      "too_many_finding_nodes",
      `Axe affected-node count for ${id.value}`,
      sourceNodes.length,
      AXE_RESULT_LIMITS.nodesPerFinding
    );
  }

  const diagnosticNodes = [];
  for (const node of sourceNodes) {
    insertDiagnosticNode(diagnosticNodes, normalizeNode(node));
  }

  return Object.freeze({
    impact,
    rawImpact: rawImpact.value,
    rawImpactTruncated: rawImpact.truncated,
    id: id.value,
    idTruncated: id.truncated,
    help: help.value,
    helpTruncated: help.truncated,
    nodeCount: sourceNodes.length,
    omittedNodeCount: Math.max(0, sourceNodes.length - diagnosticNodes.length),
    nodes: Object.freeze(diagnosticNodes)
  });
}

function normalizeNode(node) {
  const findingNode = node !== null && typeof node === "object" ? node : {};
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
      text += codePoint;
      codePointCount += 1;
    }
  };

  const visit = (value, depth) => {
    if (stopped) return;
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

    const entryCount = Math.min(value.length, AXE_RESULT_LIMITS.targetArrayEntries);
    if (value.length > entryCount) truncated = true;
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
      if (!Object.hasOwn(value, index)) {
        truncated = true;
        continue;
      }
      visit(value[index], depth + 1);
    }
  };

  visit(target, 0);
  text = text.replace(/\s+/gu, " ").trim();
  if (text.length === 0) text = "<unavailable target>";
  return { value: `${text}${truncated ? "…" : ""}`, truncated };
}

function insertDiagnosticNode(nodes, node) {
  let index = 0;
  while (index < nodes.length && compareNodes(nodes[index], node) <= 0) index += 1;
  nodes.splice(index, 0, node);
  if (nodes.length > AXE_RESULT_LIMITS.diagnosticNodesPerFinding) nodes.pop();
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
    text += codePoint;
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

function classificationLimitError(code, label, actual, limit) {
  return new AxeResultClassificationError(code, `${label} ${actual} exceeds the bound ${limit}.`, { actual, limit });
}
