import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import {
  R_KERNEL_EXPORT_CHUNK_BYTES,
  R_KERNEL_MAX_CUSTOM_CODE_BYTES,
  R_KERNEL_TRANSPORT_VERSION,
  decodeRKernelResponseJson,
  encodeRKernelRequest,
  type RKernelByExampleStep,
  type RKernelGroupByStep,
  type RKernelRequest
} from "../extension/r/rKernelProtocol";
import { R_FRAME_CONTRACT_LIMITS } from "../extension/r/rFrameContract";
import { RKernelSessionTransport } from "../extension/r/rKernelTransport";
import type { RNotebookKernelSelectionBinding } from "../extension/r/rNotebookVariableDiscovery";
import { MAX_VIEW_VALUE_TEXT_CHARACTERS } from "../shared/viewValueLimits";
import {
  R_KERNEL_RUNTIME_BINDING,
  buildRKernelBootstrapCode,
  buildRKernelTeardownCode
} from "../extension/r/rKernelRuntimeBundle";
import { rCsvExportOptions, rExportOptions, rParquetExportOptions } from "./rExportTestOptions";

const sessionId = "11111111-1111-4111-8111-111111111111";
const openRequestId = "22222222-2222-4222-8222-222222222222";
const pageRequestId = "33333333-3333-4333-8333-333333333333";
const closeRequestId = "44444444-4444-4444-8444-444444444444";
const summaryRequestId = "55555555-5555-4555-8555-555555555555";
const statsRequestId = "66666666-6666-4666-8666-666666666666";
const valuesRequestId = "77777777-7777-4777-8777-777777777777";
const previewRequestId = "88888888-8888-4888-8888-888888888888";
const applyRequestId = "99999999-9999-4999-8999-999999999999";
const discardRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const undoRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const inspectRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const inspectOutputRequestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const inspectSecondPageRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const exportRequestId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const exportChunkRequestId = "12345678-1234-4234-8234-1234567890ab";
const exportCloseRequestId = "23456789-2345-4345-8345-234567890abc";
const exportSecondChunkRequestId = "34567890-3456-4456-8456-34567890abcd";
const exportId = "01234567-89ab-4cde-8fab-0123456789ab";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setOpenNotebookDocuments();
});

describe("native R kernel runtime bundle", () => {
  it("embeds the pure-R runtime without referencing the extension filesystem", () => {
    const files = testRuntimeFiles();
    const code = buildRKernelBootstrapCode(files, "transport-owner-a");
    const teardown = buildRKernelTeardownCode(files, "transport-owner-a");

    expect(code).toContain(R_KERNEL_RUNTIME_BINDING);
    expect(code).toContain("jsonlite::base64_dec");
    expect(code).toContain("base::memDecompress");
    expect(code).toContain('type = "gzip"');
    expect(code).not.toContain(Buffer.from(files["frame_contract.R"]!, "utf8").toString("base64"));
    expect(code).not.toContain("openwrangler_r_frame_contract <- list()");
    expect(code).not.toContain("extensionPath");
    expect(teardown).toContain(R_KERNEL_RUNTIME_BINDING);
    expect(teardown).toContain('exists("transport-owner-a", envir = .__ow_existing$transportOwners');
    expect(teardown).toContain("identical(.__ow_existing$bundleId");
    expect(teardown).toContain(".__ow_existing$agent$dispose()");
    expect(teardown).toContain("remove(list = .__ow_binding");
  });

  it("rejects incomplete and unexpected R runtime bundles", () => {
    expect(() => buildRKernelBootstrapCode({ "frame_contract.R": "" })).toThrow("incomplete");
    expect(() =>
      buildRKernelBootstrapCode({
        "frame_contract.R": "",
        "kernel_agent.R": "",
        "../escape.R": ""
      })
    ).toThrow("incomplete");
  });

  it("rejects an owner token that could alter generated R code", () => {
    expect(() => buildRKernelBootstrapCode(testRuntimeFiles(), 'owner"; rm(list = ls()); #')).toThrow(
      "owner token is invalid"
    );
    expect(() => buildRKernelTeardownCode(testRuntimeFiles(), "")).toThrow("owner token is invalid");
  });
});

describe("native R kernel protocol", () => {
  it("decodes a correlated typed page and rejects a stale request ID", () => {
    const encoded = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: openRequestId,
      kind: "page",
      sessionId,
      exportFormats: ["csv", "parquet"],
      page: minimalFramePage()
    });

    expect(decodeRKernelResponseJson(encoded, openRequestId, { expectExportFormats: true })).toMatchObject({
      kind: "page",
      sessionId,
      exportFormats: ["csv", "parquet"],
      page: { dataframeFlavor: "r.data.frame", shape: { rows: 1, columns: 1 } }
    });
    expect(() => decodeRKernelResponseJson(encoded, pageRequestId, { expectExportFormats: true })).toThrow(
      "stale or mis-correlated"
    );
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: openRequestId,
          kind: "page",
          sessionId,
          exportFormats: ["parquet", "csv"],
          page: minimalFramePage()
        }),
        openRequestId,
        { expectExportFormats: true }
      )
    ).toThrow("must contain csv first");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: openRequestId,
          kind: "page",
          sessionId,
          page: minimalFramePage()
        }),
        openRequestId,
        { expectExportFormats: true }
      )
    ).toThrow("invalid fields");
  });

  it("strictly decodes bounded column profiles and dataset statistics", () => {
    const summary = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: summaryRequestId,
      kind: "summary",
      sessionId,
      summaries: [minimalSummary()]
    });
    expect(decodeRKernelResponseJson(summary, summaryRequestId)).toMatchObject({
      kind: "summary",
      sessionId,
      summaries: [{ columnId: "r:c:0", numeric: { exactMin: { raw: 1 } } }]
    });
    const derivedColumnSummary = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: summaryRequestId,
      kind: "summary",
      sessionId,
      summaries: [{ ...minimalSummary(), columnId: longDerivedColumnId() }]
    });
    expect(decodeRKernelResponseJson(derivedColumnSummary, summaryRequestId)).toMatchObject({
      kind: "summary",
      summaries: [{ columnId: longDerivedColumnId() }]
    });
    const sampledSummary = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: summaryRequestId,
      kind: "summary",
      sessionId,
      summaries: [
        {
          ...minimalSummary(),
          totalCount: 1_500_001,
          distinctCount: undefined,
          topValues: [],
          visualization: { kind: "numeric", bins: [{ min: 1, max: 1_500_001, count: 100_000 }], sampled: true }
        }
      ]
    });
    expect(decodeRKernelResponseJson(sampledSummary, summaryRequestId)).toMatchObject({
      kind: "summary",
      summaries: [{ totalCount: 1_500_001, visualization: { sampled: true } }]
    });
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: summaryRequestId,
          kind: "summary",
          sessionId,
          summaries: [
            {
              ...minimalSummary(),
              distinctCount: undefined,
              topValues: [],
              visualization: { kind: "numeric", bins: [{ min: 1, max: 1, count: 1 }], sampled: true }
            }
          ]
        }),
        summaryRequestId
      )
    ).toThrow("inconsistent value counts");

    const stats = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: statsRequestId,
      kind: "datasetStats",
      sessionId,
      totalRows: 1,
      stats: minimalDatasetStats()
    });
    expect(decodeRKernelResponseJson(stats, statsRequestId)).toMatchObject({
      kind: "datasetStats",
      sessionId,
      totalRows: 1,
      stats: { missingCells: 0, missingValuesByColumn: [{ column: "value", count: 0 }] }
    });
    const sampledStats = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: statsRequestId,
      kind: "datasetStats",
      sessionId,
      totalRows: 1_500_001,
      stats: { ...minimalDatasetStats(), duplicateRows: 4, duplicateRowsSampleSize: 100_000 }
    });
    expect(decodeRKernelResponseJson(sampledStats, statsRequestId)).toMatchObject({
      kind: "datasetStats",
      totalRows: 1_500_001,
      stats: { duplicateRows: 4, duplicateRowsSampleSize: 100_000 }
    });

    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: summaryRequestId,
          kind: "summary",
          sessionId,
          summaries: [{ ...minimalSummary(), extra: true }]
        }),
        summaryRequestId
      )
    ).toThrow("summary response is invalid");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: statsRequestId,
          kind: "datasetStats",
          sessionId,
          totalRows: 1,
          stats: { ...minimalDatasetStats(), missingRows: -1 }
        }),
        statsRequestId
      )
    ).toThrow("dataset-statistics response is invalid");

    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: summaryRequestId,
          kind: "summary",
          sessionId,
          summaries: [
            {
              ...minimalSummary(),
              visualization: { kind: "numeric", bins: [{ min: 1, max: 1, count: 2 }] }
            }
          ]
        }),
        summaryRequestId
      )
    ).toThrow("histogram counts outside");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: summaryRequestId,
          kind: "summary",
          sessionId,
          summaries: [
            {
              columnId: "r:c:0",
              column: "value",
              type: "string",
              rawType: "character",
              totalCount: 1,
              nullCount: 0,
              nanCount: 0,
              distinctCount: 1,
              text: { emptyCount: 0, minLength: 1, maxLength: 1, meanLength: 1 },
              visualization: {
                kind: "categorical",
                categories: [{ value: "a", count: 1 }],
                otherCount: 1
              },
              topValues: [{ value: "a", count: 1 }]
            }
          ]
        }),
        summaryRequestId
      )
    ).toThrow("inconsistent categorical counts");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: statsRequestId,
          kind: "datasetStats",
          sessionId,
          totalRows: 1,
          stats: { ...minimalDatasetStats(), missingCells: 1 }
        }),
        statsRequestId
      )
    ).toThrow("inconsistent missing-value totals");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: statsRequestId,
          kind: "datasetStats",
          sessionId,
          totalRows: 0,
          stats: {
            missingCells: 1,
            missingRows: 1,
            duplicateRows: 0,
            missingValuesByColumn: [{ column: "value", count: 1 }]
          }
        }),
        statsRequestId
      )
    ).toThrow("filtered row count");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: statsRequestId,
          kind: "datasetStats",
          sessionId,
          totalRows: 10,
          stats: { ...minimalDatasetStats(), duplicateRows: 1, duplicateRowsSampleSize: 11 }
        }),
        statsRequestId
      )
    ).toThrow("filtered row count");
  });

  it("strictly decodes typed column values", () => {
    const encoded = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: valuesRequestId,
      kind: "columnValues",
      sessionId,
      column: "value",
      values: [minimalColumnValue()],
      hasMore: false
    });

    expect(decodeRKernelResponseJson(encoded, valuesRequestId)).toMatchObject({
      kind: "columnValues",
      column: "value",
      values: [{ value: "1", count: 1 }],
      hasMore: false
    });
    const sampled = JSON.parse(encoded) as Record<string, unknown>;
    sampled.hasMore = true;
    sampled.sampleSize = R_FRAME_CONTRACT_LIMITS.profileSampleRows;
    expect(decodeRKernelResponseJson(JSON.stringify(sampled), valuesRequestId)).toMatchObject({
      kind: "columnValues",
      sampleSize: R_FRAME_CONTRACT_LIMITS.profileSampleRows,
      hasMore: true
    });
    sampled.hasMore = false;
    expect(() => decodeRKernelResponseJson(JSON.stringify(sampled), valuesRequestId)).toThrow("response");
    sampled.hasMore = true;
    sampled.sampleSize = R_FRAME_CONTRACT_LIMITS.profileSampleRows - 1;
    expect(() => decodeRKernelResponseJson(JSON.stringify(sampled), valuesRequestId)).toThrow("sampleSize");
    sampled.sampleSize = R_FRAME_CONTRACT_LIMITS.profileSampleRows + 1;
    expect(() => decodeRKernelResponseJson(JSON.stringify(sampled), valuesRequestId)).toThrow("sampleSize");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: valuesRequestId,
          kind: "columnValues",
          sessionId,
          column: "value",
          values: [{ value: "1", count: 1 }],
          hasMore: false
        }),
        valuesRequestId
      )
    ).toThrow("typed selection");
  });

  it("validates private streamed CSV and Parquet exports", () => {
    const request: Extract<RKernelRequest, { kind: "exportData" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: exportRequestId,
      kind: "exportData",
      payload: { sessionId, revision: 4, exportId, options: rCsvExportOptions }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    expect(
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: exportRequestId,
          kind: "dataExported",
          sessionId,
          revision: 4,
          exportId,
          format: "csv",
          rows: 3,
          columns: 2,
          bytes: 42
        }),
        exportRequestId
      )
    ).toEqual({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: exportRequestId,
      kind: "dataExported",
      sessionId,
      revision: 4,
      exportId,
      format: "csv",
      rows: 3,
      columns: 2,
      bytes: 42
    });

    const parquetRequest = {
      ...request,
      payload: { ...request.payload, options: rParquetExportOptions }
    };
    expect(JSON.parse(encodeRKernelRequest(parquetRequest))).toEqual(parquetRequest);
    expect(
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: exportRequestId,
          kind: "dataExported",
          sessionId,
          revision: 4,
          exportId,
          format: "parquet",
          rows: 3,
          columns: 2,
          bytes: 84
        }),
        exportRequestId
      )
    ).toMatchObject({ kind: "dataExported", format: "parquet", bytes: 84 });

    expect(() =>
      encodeRKernelRequest({
        ...request,
        payload: { ...request.payload, exportId: "../escape" }
      } as RKernelRequest)
    ).toThrow("canonical UUID");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: exportRequestId,
          kind: "dataExported",
          sessionId,
          revision: 4,
          exportId,
          format: "csv",
          rows: 3,
          columns: 2,
          bytes: -1
        }),
        exportRequestId
      )
    ).toThrow("supported range");

    const chunkRequest: Extract<RKernelRequest, { kind: "readDataExport" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: exportChunkRequestId,
      kind: "readDataExport",
      payload: { sessionId, revision: 4, exportId, offset: 7, limit: 8 }
    };
    expect(JSON.parse(encodeRKernelRequest(chunkRequest))).toEqual(chunkRequest);
    expect(
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: exportChunkRequestId,
          kind: "dataExportChunk",
          sessionId,
          revision: 4,
          exportId,
          offset: 7,
          bytes: 3,
          data: Buffer.from("abc").toString("base64")
        }),
        exportChunkRequestId
      )
    ).toEqual({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: exportChunkRequestId,
      kind: "dataExportChunk",
      sessionId,
      revision: 4,
      exportId,
      offset: 7,
      bytes: 3,
      data: Uint8Array.from(Buffer.from("abc"))
    });
    for (const [data, bytes] of [
      ["not base64", 3],
      [Buffer.from("abc").toString("base64"), 2]
    ] as const) {
      expect(() =>
        decodeRKernelResponseJson(
          JSON.stringify({
            transportVersion: R_KERNEL_TRANSPORT_VERSION,
            requestId: exportChunkRequestId,
            kind: "dataExportChunk",
            sessionId,
            revision: 4,
            exportId,
            offset: 7,
            bytes,
            data
          }),
          exportChunkRequestId
        )
      ).toThrow();
    }

    const closeRequest: Extract<RKernelRequest, { kind: "closeDataExport" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: exportCloseRequestId,
      kind: "closeDataExport",
      payload: { sessionId, revision: 4, exportId }
    };
    expect(JSON.parse(encodeRKernelRequest(closeRequest))).toEqual(closeRequest);
    expect(
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: exportCloseRequestId,
          kind: "dataExportClosed",
          sessionId,
          revision: 4,
          exportId
        }),
        exportCloseRequestId
      )
    ).toMatchObject({ kind: "dataExportClosed", sessionId, revision: 4, exportId });
  });

  it("validates page windows and repeated stable sort identities before dispatch", () => {
    const valid = openRequest();
    expect(JSON.parse(encodeRKernelRequest(valid))).toEqual(valid);
    const cloneRequest: RKernelRequest = {
      ...valid,
      payload: {
        ...valid.payload,
        cloneFromSessionId: "99999999-9999-4999-8999-999999999999",
        cloneFromRevision: 7
      }
    };
    expect(JSON.parse(encodeRKernelRequest(cloneRequest))).toEqual(cloneRequest);
    expect(() =>
      encodeRKernelRequest({
        ...cloneRequest,
        payload: { ...cloneRequest.payload, cloneFromRevision: undefined }
      } as unknown as RKernelRequest)
    ).toThrow("provided together");
    const derivedSortRequest: RKernelRequest = {
      ...valid,
      payload: {
        ...valid.payload,
        page: {
          ...valid.payload.page,
          view: {
            ...valid.payload.page.view,
            sorts: [
              {
                column: { id: longDerivedColumnId(), name: "value copy" },
                direction: "asc",
                nulls: "last"
              }
            ]
          }
        }
      }
    };
    expect(JSON.parse(encodeRKernelRequest(derivedSortRequest))).toEqual(derivedSortRequest);
    const repeated: RKernelRequest = {
      ...valid,
      payload: {
        ...valid.payload,
        page: {
          ...valid.payload.page,
          view: { ...valid.payload.page.view, sorts: [sortRule(), sortRule()] }
        }
      }
    };
    expect(() => encodeRKernelRequest(repeated)).toThrow("repeated column identity");
    expect(() =>
      encodeRKernelRequest({
        ...valid,
        payload: { ...valid.payload, variableName: String.fromCharCode(0xd800) }
      })
    ).toThrow("bounded string");
  });

  it("validates committed R sort/filter requests and bounded row-changing diffs", () => {
    const sortRequest: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "sort-step",
          kind: "sortRows",
          params: {
            rules: [
              {
                column: { id: "r:c:0", name: "non syntactic" },
                direction: "desc",
                nulls: "first"
              },
              {
                column: { id: "r:c:1", name: "duplicate" },
                direction: "asc",
                nulls: "last"
              }
            ]
          }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(sortRequest))).toEqual(sortRequest);

    const filterRequest: Extract<RKernelRequest, { kind: "previewStep" }> = {
      ...sortRequest,
      payload: {
        ...sortRequest.payload,
        step: {
          id: "filter-step",
          kind: "filterRows",
          params: {
            filterModel: {
              logic: "or",
              filters: [
                {
                  column: { id: "r:c:0", name: "non syntactic" },
                  type: "string",
                  predicates: [],
                  valueFilter: {
                    kind: "values",
                    selectedValues: ["alpha"],
                    includeNulls: false,
                    includeNaN: false
                  }
                },
                {
                  column: { id: "r:c:1", name: "duplicate" },
                  type: "float",
                  predicates: [{ kind: "predicate", operator: "isNaN" }]
                }
              ],
              sort: [
                {
                  column: { id: "r:c:1", name: "duplicate" },
                  direction: "desc",
                  nulls: "last"
                }
              ]
            }
          }
        }
      }
    };
    expect(JSON.parse(encodeRKernelRequest(filterRequest))).toEqual(filterRequest);

    const emptySort = structuredClone(sortRequest) as unknown as {
      payload: { step: { params: { rules: unknown[] } } };
    };
    emptySort.payload.step.params.rules = [];
    expect(() => encodeRKernelRequest(emptySort as unknown as RKernelRequest)).toThrow("sorts exceed");

    const repeatedSort = structuredClone(sortRequest) as unknown as {
      payload: { step: { params: { rules: Array<{ column: { id: string; name: string } }> } } };
    };
    repeatedSort.payload.step.params.rules[1]!.column = { id: "r:c:0", name: "non syntactic" };
    expect(() => encodeRKernelRequest(repeatedSort as unknown as RKernelRequest)).toThrow("repeated column identity");

    const malformedFilter = structuredClone(filterRequest) as unknown as {
      payload: { step: { params: { filterModel: Record<string, unknown> } } };
    };
    malformedFilter.payload.step.params.filterModel.sorts = [];
    expect(() => encodeRKernelRequest(malformedFilter as unknown as RKernelRequest)).toThrow("invalid fields");

    const filteredPreview = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalFramePage(),
      diff: { ...minimalRenameDiff(), removedRows: 1, truncated: true },
      code: "open_wrangler_result <- frame\n"
    };
    expect(
      decodeRKernelResponseJson(JSON.stringify(filteredPreview), previewRequestId, {
        inputSchema: minimalFramePage().schema
      })
    ).toMatchObject({
      kind: "stepPreview",
      diff: { addedRows: 0, removedRows: 1, changedCells: 0, truncated: true }
    });

    for (const removedRows of [-1, R_FRAME_CONTRACT_LIMITS.rows + 1, 1.5]) {
      expect(() =>
        decodeRKernelResponseJson(
          JSON.stringify({ ...filteredPreview, diff: { ...filteredPreview.diff, removedRows } }),
          previewRequestId,
          { inputSchema: minimalFramePage().schema }
        )
      ).toThrow("response.diff.removedRows");
    }
  });

  it("requires an exact runtime-normalized retained step for native R by-example previews", () => {
    const step = byExampleStep();
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: { sessionId, revision: 0, step, page: pageWindow() }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    expect(() =>
      encodeRKernelRequest({
        ...request,
        payload: {
          ...request.payload,
          step: { ...step, params: { ...step.params, newColumn: "derived\u0000truncated" } }
        }
      })
    ).toThrow("U+0000");
    expect(() =>
      encodeRKernelRequest({
        ...request,
        payload: {
          ...request.payload,
          step: {
            ...step,
            params: {
              ...step.params,
              examples: [{ inputs: [-0], output: 0 }, step.params.examples[1]]
            }
          }
        }
      })
    ).toThrow("malformed or exceed");
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    for (const program of [
      { kind: "slice", input: { kind: "column", column: { id: "r:c:0", name: "value" } }, start: unsafeInteger },
      {
        kind: "slice",
        input: { kind: "column", column: { id: "r:c:0", name: "value" } },
        start: 0,
        stop: unsafeInteger
      },
      {
        kind: "split",
        input: { kind: "column", column: { id: "r:c:0", name: "value" } },
        delimiter: "-",
        index: unsafeInteger
      },
      {
        kind: "regexExtract",
        input: { kind: "column", column: { id: "r:c:0", name: "value" } },
        pattern: "(.)",
        group: unsafeInteger
      }
    ] as const) {
      expect(() =>
        encodeRKernelRequest({
          ...request,
          payload: {
            ...request.payload,
            step: { ...step, params: { ...step.params, program } }
          }
        })
      ).toThrow("malformed or exceed");
    }

    const retainedStep = {
      ...step,
      params: {
        ...step.params,
        program: { kind: "column", column: { id: "r:c:0", name: "value" } },
        warnings: [],
        candidateCount: 1
      }
    } as const;
    const response = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalByExampleFramePage(),
      diff: {
        ...minimalRenameDiff(),
        addedColumns: ["derived value"]
      },
      code: "frame[['derived value']] <- frame[['value']]\n",
      retainedStep
    } as const;
    const context = { inputSchema: minimalFramePage().schema, previewStep: step } as const;
    expect(decodeRKernelResponseJson(JSON.stringify(response), previewRequestId, context)).toMatchObject({
      kind: "stepPreview",
      retainedStep: {
        id: "by-example-step",
        params: { program: { kind: "column" }, warnings: [], candidateCount: 1 }
      }
    });

    const { retainedStep: _retainedStep, ...missingRetainedStep } = response;
    expect(() => decodeRKernelResponseJson(JSON.stringify(missingRetainedStep), previewRequestId, context)).toThrow(
      "invalid fields"
    );
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          ...response,
          retainedStep: { ...retainedStep, params: { ...retainedStep.params, warnings: undefined } }
        }),
        previewRequestId,
        context
      )
    ).toThrow();
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          ...response,
          retainedStep: { ...retainedStep, params: { ...retainedStep.params, warnings: ["bad\u0000warning"] } }
        }),
        previewRequestId,
        context
      )
    ).toThrow("U+0000");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          ...response,
          retainedStep: {
            ...retainedStep,
            params: { ...retainedStep.params, candidateCount: unsafeInteger }
          }
        }),
        previewRequestId,
        context
      )
    ).toThrow("valid retained by-example step");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          ...response,
          retainedStep: {
            ...retainedStep,
            params: { ...retainedStep.params, examples: [{ inputs: [9], output: 9 }, step.params.examples[1]] }
          }
        }),
        previewRequestId,
        context
      )
    ).toThrow("does not match the exact preview request");

    const saved = { ...step, params: { ...step.params, program: retainedStep.params.program } } as const;
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          ...response,
          retainedStep: {
            ...retainedStep,
            params: { ...retainedStep.params, program: { kind: "literal", value: 1 } }
          }
        }),
        previewRequestId,
        { inputSchema: minimalFramePage().schema, previewStep: saved }
      )
    ).toThrow("changed a saved by-example program");
  });

  it("bounds custom R source and requires an exact custom-only effective view", () => {
    const step = { id: "custom-step", kind: "customCode", params: { code: "result <- df\n" } } as const;
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: { sessionId, revision: 0, step, page: pageWindow() }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    for (const code of ["result <- df\u0000", "   \r\n\t", "# only\r  # comments\n"]) {
      expect(() =>
        encodeRKernelRequest({
          ...request,
          payload: { ...request.payload, step: { ...step, params: { code } } }
        })
      ).toThrow();
    }
    expect(() =>
      encodeRKernelRequest({
        ...request,
        payload: {
          ...request.payload,
          step: { ...step, params: { code: `# comment\r${"x".repeat(R_KERNEL_MAX_CUSTOM_CODE_BYTES)}` } }
        }
      })
    ).toThrow("UTF-8 byte limit");

    const response = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalFramePage(),
      diff: {
        addedRows: 1,
        removedRows: 1,
        addedColumns: ["duplicate", "duplicate"],
        removedColumns: ["duplicate", "duplicate"],
        changedCells: 0,
        cells: [],
        truncated: false
      },
      code: "open_wrangler_result <- frame\n",
      effectiveView: emptyView()
    } as const;
    const context = { inputSchema: minimalFramePage().schema, previewStep: step } as const;
    expect(decodeRKernelResponseJson(JSON.stringify(response), previewRequestId, context)).toMatchObject({
      kind: "stepPreview",
      effectiveView: { filters: [], sorts: [] },
      diff: { addedColumns: ["duplicate", "duplicate"], removedColumns: ["duplicate", "duplicate"] }
    });

    const { effectiveView: _effectiveView, ...missingEffectiveView } = response;
    expect(() => decodeRKernelResponseJson(JSON.stringify(missingEffectiveView), previewRequestId, context)).toThrow(
      "invalid fields"
    );
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({ ...response, effectiveView: { logic: null, filters: [], sorts: [] } }),
        previewRequestId,
        context
      )
    ).toThrow("view logic");
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(response), previewRequestId, {
        inputSchema: minimalFramePage().schema,
        previewStep: renameStep()
      })
    ).toThrow("invalid fields");

    const page = minimalFramePage();
    for (const malformedPage of [
      {
        ...page,
        schema: page.schema.map((column) => ({ ...column, id: "not-a-stable-id" })),
        page: { ...page.page, columnIds: ["not-a-stable-id"] }
      },
      { ...page, frameSemantics: { ...page.frameSemantics, rowNames: "explicit" } },
      { ...page, frameSemantics: { ...page.frameSemantics, keyColumnIds: ["r:c:0"] } },
      {
        ...page,
        schema: page.schema.map((column) => ({ ...column, name: "__OPEN_WRANGLER_INTERNAL_ROW_ID_hidden" }))
      }
    ]) {
      expect(() =>
        decodeRKernelResponseJson(JSON.stringify({ ...response, page: malformedPage }), previewRequestId, context)
      ).toThrow();
    }
  });

  it("strictly validates native R missing-row and duplicate-row requests", () => {
    const base: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: { id: "drop-missing", kind: "dropMissingRows", params: { columns: [], how: "all" } },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(base))).toEqual(base);

    const selectedMissing: Extract<RKernelRequest, { kind: "previewStep" }> = {
      ...base,
      payload: {
        ...base.payload,
        step: {
          id: "drop-missing-selected",
          kind: "dropMissingRows",
          params: {
            columns: [
              { id: "r:c:0", name: "non syntactic" },
              { id: "r:c:1", name: "duplicate" }
            ],
            how: "any"
          }
        }
      }
    };
    expect(JSON.parse(encodeRKernelRequest(selectedMissing))).toEqual(selectedMissing);

    const allColumnsDuplicates: Extract<RKernelRequest, { kind: "previewStep" }> = {
      ...base,
      payload: {
        ...base.payload,
        step: { id: "drop-duplicates-all", kind: "dropDuplicates", params: {} }
      }
    };
    expect(JSON.parse(encodeRKernelRequest(allColumnsDuplicates))).toEqual(allColumnsDuplicates);

    const selectedDuplicates: Extract<RKernelRequest, { kind: "previewStep" }> = {
      ...base,
      payload: {
        ...base.payload,
        step: {
          id: "drop-duplicates-selected",
          kind: "dropDuplicates",
          params: {
            columns: [{ id: "r:c:0", name: "non syntactic" }],
            keep: "none"
          }
        }
      }
    };
    expect(JSON.parse(encodeRKernelRequest(selectedDuplicates))).toEqual(selectedDuplicates);

    const emptyDuplicates = structuredClone(selectedDuplicates) as unknown as {
      payload: { step: { params: { columns: unknown[] } } };
    };
    emptyDuplicates.payload.step.params.columns = [];
    expect(() => encodeRKernelRequest(emptyDuplicates as unknown as RKernelRequest)).toThrow("non-empty");

    const repeatedMissing = structuredClone(selectedMissing) as unknown as {
      payload: { step: { params: { columns: Array<{ id: string; name: string }> } } };
    };
    repeatedMissing.payload.step.params.columns[1] = { id: "r:c:0", name: "non syntactic" };
    expect(() => encodeRKernelRequest(repeatedMissing as unknown as RKernelRequest)).toThrow("repeated identity");

    for (const [request, value] of [
      [selectedMissing, "some"],
      [selectedDuplicates, "middle"]
    ] as const) {
      const malformed = structuredClone(request) as unknown as {
        payload: { step: { params: { how?: string; keep?: string } } };
      };
      if (request.payload.step.kind === "dropMissingRows") malformed.payload.step.params.how = value;
      else malformed.payload.step.params.keep = value;
      expect(() => encodeRKernelRequest(malformed as unknown as RKernelRequest)).toThrow("invalid");
    }
  });

  it("validates projected profile identities before dispatch", () => {
    const request: RKernelRequest = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: summaryRequestId,
      kind: "getSummary",
      payload: { sessionId, columns: [{ id: "r:c:0", name: "value" }], view: emptyView() }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    expect(() =>
      encodeRKernelRequest({
        ...request,
        payload: { ...request.payload, columns: [...request.payload.columns, ...request.payload.columns] }
      })
    ).toThrow("repeated identity");
  });

  it("strictly validates native R rename lifecycle requests and responses", () => {
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: renameStep(),
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const preview = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalFramePage(),
      diff: minimalRenameDiff(),
      code: "open_wrangler_result <- frame\n"
    });
    expect(
      decodeRKernelResponseJson(preview, previewRequestId, { inputSchema: minimalFramePage().schema })
    ).toMatchObject({
      kind: "stepPreview",
      sessionId,
      revision: 1,
      diff: { changedCells: 0, truncated: false },
      code: "open_wrangler_result <- frame\n"
    });

    const inspectionRequest: Extract<RKernelRequest, { kind: "inspectStepPage" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: inspectRequestId,
      kind: "inspectStepPage",
      payload: { sessionId, revision: 2, stepId: "rename-step", side: "input", page: pageWindow() }
    };
    expect(JSON.parse(encodeRKernelRequest(inspectionRequest))).toEqual(inspectionRequest);
    const inspection = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: inspectRequestId,
      kind: "stepInspectionPage",
      sessionId,
      revision: 2,
      stepId: "rename-step",
      stepIndex: 0,
      side: "input",
      page: inspectionWirePage(minimalFramePage())
    });
    expect(
      decodeRKernelResponseJson(inspection, inspectRequestId, {
        inputSchema: minimalFramePage().schema,
        inspectionSide: "input"
      })
    ).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      stepId: "rename-step",
      stepIndex: 0,
      revision: 2
    });
    expect(() => decodeRKernelResponseJson(inspection, inspectRequestId)).toThrow("does not match the requested side");
    expect(() =>
      decodeRKernelResponseJson(inspection, inspectRequestId, {
        inputSchema: minimalFramePage().schema,
        inspectionSide: "output"
      })
    ).toThrow("does not match the requested side");
    const inspectionInfo = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: inspectOutputRequestId,
      kind: "stepInspectionInfo",
      sessionId,
      revision: 2,
      stepId: "rename-step",
      stepIndex: 0,
      code: "open_wrangler_result <- frame\n"
    });
    expect(decodeRKernelResponseJson(inspectionInfo, inspectOutputRequestId)).toMatchObject({
      kind: "stepInspectionInfo",
      stepId: "rename-step",
      code: "open_wrangler_result <- frame\n"
    });

    const invalidStep = structuredClone(request) as unknown as {
      payload: { step: { kind: string; params: Record<string, unknown> } };
    };
    invalidStep.payload.step.kind = "formula";
    expect(() => encodeRKernelRequest(invalidStep as unknown as RKernelRequest)).toThrow("invalid fields");
    invalidStep.payload.step.kind = "renameColumn";
    invalidStep.payload.step.params.extra = true;
    expect(() => encodeRKernelRequest(invalidStep as unknown as RKernelRequest)).toThrow("invalid fields");

    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          ...JSON.parse(preview),
          diff: { ...minimalRenameDiff(), changedCells: 1 }
        }),
        previewRequestId,
        { inputSchema: minimalFramePage().schema }
      )
    ).toThrow("changed-cell totals are inconsistent");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: previewRequestId,
          kind: "planUpdated",
          sessionId,
          action: "replace",
          revision: 2,
          page: minimalFramePage(),
          code: "open_wrangler_result <- frame\n"
        }),
        previewRequestId
      )
    ).toThrow("invalid action");
  });

  it("strictly validates native R Clone Column requests, derived identities, and structural diffs", () => {
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "clone-step",
          kind: "cloneColumn",
          params: { column: { id: "r:c:0", name: "value" }, newName: "value copy" }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const response = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalCloneFramePage(),
      diff: { ...minimalRenameDiff(), addedColumns: ["value copy"] },
      code: "open_wrangler_result <- frame\n"
    });
    const decoded = decodeRKernelResponseJson(response, previewRequestId, { inputSchema: minimalFramePage().schema });
    expect(decoded).toMatchObject({
      kind: "stepPreview",
      diff: { addedColumns: ["value copy"], removedColumns: [] }
    });
    if (decoded.kind !== "stepPreview") throw new Error("Expected a native R clone preview.");
    expect(decoded.page.schema.map(({ id }) => id)).toEqual(["r:c:0", "c:step:clone-step:0"]);

    const malformed = structuredClone(request) as unknown as {
      payload: { step: { params: Record<string, unknown> } };
    };
    malformed.payload.step.params.extra = true;
    expect(() => encodeRKernelRequest(malformed as unknown as RKernelRequest)).toThrow("invalid fields");

    const oversizedReference = structuredClone(request) as unknown as {
      payload: { step: { params: { column: { id: string } } } };
    };
    oversizedReference.payload.step.params.column.id = "x".repeat(R_FRAME_CONTRACT_LIMITS.columnIdBytes + 1);
    expect(() => encodeRKernelRequest(oversizedReference as unknown as RKernelRequest)).toThrow(
      "request.payload.step.params.column.id"
    );

    const malformedDiff = JSON.parse(response) as { diff: { addedColumns: unknown[] } };
    malformedDiff.diff.addedColumns = [17];
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(malformedDiff), previewRequestId, {
        inputSchema: minimalFramePage().schema
      })
    ).toThrow("response.diff.addedColumns[0]");
  });

  it("strictly validates native R Text Length requests and derived integer responses", () => {
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "text-length-step",
          kind: "textLength",
          params: { column: { id: "r:c:0", name: "value" }, newColumn: "value length" }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const response = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalTextLengthFramePage(),
      diff: { ...minimalRenameDiff(), addedColumns: ["value length"] },
      code: "open_wrangler_result <- frame\n"
    });
    const decoded = decodeRKernelResponseJson(response, previewRequestId, { inputSchema: minimalFramePage().schema });
    expect(decoded).toMatchObject({
      kind: "stepPreview",
      page: {
        schema: [
          expect.objectContaining({ id: "r:c:0" }),
          expect.objectContaining({
            id: "c:step:text-length-step:0",
            name: "value length",
            rawType: "integer",
            type: "integer"
          })
        ]
      },
      diff: { addedColumns: ["value length"], removedColumns: [] }
    });

    const malformed = structuredClone(request) as unknown as {
      payload: { step: { params: Record<string, unknown> } };
    };
    malformed.payload.step.params.newName = malformed.payload.step.params.newColumn;
    delete malformed.payload.step.params.newColumn;
    expect(() => encodeRKernelRequest(malformed as unknown as RKernelRequest)).toThrow("invalid fields");

    const oversizedOutput = structuredClone(request) as unknown as {
      payload: { step: { params: { newColumn: string } } };
    };
    oversizedOutput.payload.step.params.newColumn = "é".repeat(513);
    expect(() => encodeRKernelRequest(oversizedOutput as unknown as RKernelRequest)).toThrow(
      "request.payload.step.params.newColumn"
    );

    const malformedDiff = JSON.parse(response) as { diff: { addedColumns: unknown[] } };
    malformedDiff.diff.addedColumns = [null];
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(malformedDiff), previewRequestId, {
        inputSchema: minimalFramePage().schema
      })
    ).toThrow("response.diff.addedColumns[0]");
  });

  it("strictly validates canonical bounded Pivot Wider string-key tokens", () => {
    const selection = (value: string) => ({
      kind: "typedSelection" as const,
      version: 1 as const,
      columnType: "string" as const,
      cell: { kind: "string" as const, raw: value, display: value, isNull: false, isNaN: false }
    });
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "pivot-wider-token-step",
          kind: "pivotWider",
          params: {
            namesFrom: { id: "r:c:0", name: "key" },
            valuesFrom: { id: "r:c:1", name: "value" },
            outputs: [
              { key: selection("a"), name: "alpha" },
              { key: selection("b"), name: "beta" }
            ]
          }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    for (const invalidVersion of [true, "1"]) {
      const invalid = structuredClone(request) as unknown as {
        payload: { step: { params: { outputs: Array<{ key: { version: unknown } }> } } };
      };
      invalid.payload.step.params.outputs[0]!.key.version = invalidVersion;
      expect(() => encodeRKernelRequest(invalid as unknown as RKernelRequest)).toThrow(
        "canonical present string typed selection token"
      );
    }

    const exactLimit = structuredClone(request) as unknown as {
      payload: {
        step: {
          params: { outputs: Array<{ key: { cell: { raw: string; display: string } } }> };
        };
      };
    };
    const exactLimitValue = "a".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);
    exactLimit.payload.step.params.outputs[0]!.key.cell.raw = exactLimitValue;
    exactLimit.payload.step.params.outputs[0]!.key.cell.display = exactLimitValue;
    expect(JSON.parse(encodeRKernelRequest(exactLimit as unknown as RKernelRequest))).toEqual(exactLimit);

    const oversized = structuredClone(exactLimit);
    oversized.payload.step.params.outputs[0]!.key.cell.raw += "a";
    oversized.payload.step.params.outputs[0]!.key.cell.display += "a";
    expect(() => encodeRKernelRequest(oversized as unknown as RKernelRequest)).toThrow(
      "canonical present string typed selection token"
    );

    const mismatchedDisplay = structuredClone(request) as unknown as {
      payload: { step: { params: { outputs: Array<{ key: { cell: { display: string } } }> } } };
    };
    mismatchedDisplay.payload.step.params.outputs[0]!.key.cell.display = "A";
    expect(() => encodeRKernelRequest(mismatchedDisplay as unknown as RKernelRequest)).toThrow(
      "canonical present string typed selection token"
    );
  });

  it("strictly validates native R lowercase requests and bounded in-place cell diffs", () => {
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "lower-step",
          kind: "lowerText",
          params: { column: { id: "r:c:0", name: "value" } }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const response = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalLowerFramePage(),
      diff: {
        ...minimalRenameDiff(),
        changedCells: 1,
        cells: [
          {
            rowNumber: 0,
            columnId: "r:c:0",
            column: "value",
            before: { kind: "string", raw: "MiXeD", display: "MiXeD", isNull: false, isNaN: false },
            after: { kind: "string", raw: "mixed", display: "mixed", isNull: false, isNaN: false }
          }
        ]
      },
      code: "open_wrangler_result <- frame\n"
    });
    expect(
      decodeRKernelResponseJson(response, previewRequestId, { inputSchema: minimalLowerFramePage().schema })
    ).toMatchObject({
      kind: "stepPreview",
      page: { schema: [expect.objectContaining({ id: "r:c:0", rawType: "character", type: "string" })] },
      diff: {
        changedCells: 1,
        cells: [expect.objectContaining({ rowNumber: 0, columnId: "r:c:0", column: "value" })]
      }
    });

    const derived = structuredClone(request) as unknown as {
      payload: { step: { params: { newColumn?: string } } };
    };
    derived.payload.step.params.newColumn = "value lower";
    expect(JSON.parse(encodeRKernelRequest(derived as unknown as RKernelRequest))).toEqual(derived);

    const extra = structuredClone(request) as unknown as { payload: { step: { params: Record<string, unknown> } } };
    extra.payload.step.params.extra = true;
    expect(() => encodeRKernelRequest(extra as unknown as RKernelRequest)).toThrow("invalid fields");

    const malformedDiff = JSON.parse(response) as { diff: { changedCells: number; cells: unknown[] } };
    malformedDiff.diff.changedCells = 0;
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(malformedDiff), previewRequestId, {
        inputSchema: minimalLowerFramePage().schema
      })
    ).toThrow("changed-cell totals");

    const wrongAfter = JSON.parse(response) as { diff: { cells: Array<{ after: { raw: string; display: string } }> } };
    wrongAfter.diff.cells[0]!.after.raw = "different";
    wrongAfter.diff.cells[0]!.after.display = "different";
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(wrongAfter), previewRequestId, {
        inputSchema: minimalLowerFramePage().schema
      })
    ).toThrow("after-value does not match");

    const wrongProjection = JSON.parse(response) as {
      page: ReturnType<typeof minimalLowerFramePage> & {
        shape: { rows: number; columns: number };
        schema: Array<Record<string, unknown>>;
        page: { columnLimit: number };
      };
      diff: { cells: Array<{ columnId: string; column: string }> };
    };
    wrongProjection.page = minimalProjectedLowerFramePage() as typeof wrongProjection.page;
    wrongProjection.diff.cells[0]!.columnId = "r:c:1";
    wrongProjection.diff.cells[0]!.column = "other";
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(wrongProjection), previewRequestId, {
        inputSchema: minimalLowerFramePage().schema
      })
    ).toThrow("outside the returned page projection");
  });

  it("strictly validates native R uppercase and find-and-replace parameters", () => {
    const uppercase: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "upper-step",
          kind: "upperText",
          params: { column: { id: "r:c:0", name: "value" }, newColumn: "VALUE" }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(uppercase))).toEqual(uppercase);

    const findReplaceSteps = [
      {
        id: "replace-literal",
        kind: "findReplace",
        params: {
          column: { id: "r:c:0", name: "value" },
          find: ".",
          replacement: "!",
          regex: false,
          newColumn: "literal result"
        }
      },
      {
        id: "replace-regex",
        kind: "findReplace",
        params: { column: { id: "r:c:0", name: "value" }, find: "[[:digit:]]+", replacement: "#", regex: true }
      },
      {
        id: "replace-blank",
        kind: "findReplace",
        params: { column: { id: "r:c:0", name: "value" }, find: "", replacement: "_" }
      }
    ] as const;
    for (const step of findReplaceSteps) {
      const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step, page: pageWindow() }
      };
      expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    }

    const malformedRegex = structuredClone(findReplaceSteps[0]) as unknown as {
      params: { regex: unknown };
    };
    malformedRegex.params.regex = "false";
    expect(() =>
      encodeRKernelRequest({
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step: malformedRegex, page: pageWindow() }
      } as unknown as RKernelRequest)
    ).toThrow("invalid regex flag");

    const extra = structuredClone(findReplaceSteps[0]) as unknown as { params: Record<string, unknown> };
    extra.params.extra = true;
    expect(() =>
      encodeRKernelRequest({
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step: extra, page: pageWindow() }
      } as unknown as RKernelRequest)
    ).toThrow("invalid fields");

    const oversized = structuredClone(findReplaceSteps[0]) as unknown as { params: { find: string } };
    oversized.params.find = "é".repeat(4_097);
    expect(() =>
      encodeRKernelRequest({
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step: oversized, page: pageWindow() }
      } as unknown as RKernelRequest)
    ).toThrow("request.payload.step.params.find");
  });

  it("strictly validates native R capitalize, strip, and split parameters", () => {
    const steps = [
      {
        id: "capitalize-step",
        kind: "capitalizeText",
        params: { column: { id: "r:c:0", name: "value" }, newColumn: "capitalized" }
      },
      {
        id: "strip-default-step",
        kind: "stripText",
        params: { column: { id: "r:c:0", name: "value" }, characters: null }
      },
      {
        id: "strip-custom-step",
        kind: "stripText",
        params: { column: { id: "r:c:0", name: "value" }, characters: " .", newColumn: "trimmed" }
      },
      {
        id: "split-step",
        kind: "splitText",
        params: { column: { id: "r:c:0", name: "value" }, delimiter: "::", index: 1, newColumn: "part" }
      }
    ] as const;
    for (const step of steps) {
      const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step, page: pageWindow() }
      };
      expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    }

    const expectRejected = (step: unknown, message: string) => {
      expect(() =>
        encodeRKernelRequest({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: previewRequestId,
          kind: "previewStep",
          payload: { sessionId, revision: 0, step, page: pageWindow() }
        } as RKernelRequest)
      ).toThrow(message);
    };
    expectRejected(
      { ...steps[1], params: { ...steps[1].params, characters: "" } },
      "request.payload.step.params.characters"
    );
    expectRejected(
      { ...steps[2], params: { ...steps[2].params, characters: "x\u0000y" } },
      "request.payload.step.params.characters"
    );
    expectRejected(
      { ...steps[3], params: { ...steps[3].params, delimiter: "" } },
      "request.payload.step.params.delimiter"
    );
    expectRejected({ ...steps[3], params: { ...steps[3].params, index: -1 } }, "request.payload.step.params.index");
    expectRejected({ ...steps[3], params: { ...steps[3].params, index: 1.5 } }, "request.payload.step.params.index");
    const missingOutput = structuredClone(steps[3]) as unknown as { params: Record<string, unknown> };
    delete missingOutput.params.newColumn;
    expectRejected(missingOutput, "invalid fields");
    expectRejected({ ...steps[0], params: { ...steps[0].params, unexpected: true } }, "invalid fields");

    const emptyCodeResponse = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalLowerFramePage(),
      diff: minimalRenameDiff(),
      code: ""
    };
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(emptyCodeResponse), previewRequestId, {
        inputSchema: minimalLowerFramePage().schema
      })
    ).toThrow("response.code");
  });

  it("strictly validates every native R Fill Missing Values replacement", () => {
    const replacements = [
      { kind: "mean" },
      { kind: "median" },
      { kind: "mostFrequent" },
      {
        kind: "directional",
        direction: "forward",
        orderBy: [
          {
            column: { id: "r:c:1", name: "sequence" },
            direction: "asc",
            nulls: "last"
          }
        ],
        maxGap: 25
      },
      {
        kind: "groupedStatistic",
        statistic: "mean",
        keys: [{ id: "r:c:1", name: "group" }]
      },
      {
        kind: "linearInterpolation",
        coordinate: { id: "r:c:1", name: "coordinate" },
        maxGap: 25
      },
      { kind: "string", value: "unknown" },
      { kind: "integer", value: "-42" },
      { kind: "float", value: "1.25e+3" },
      { kind: "decimal", value: "0.125" },
      { kind: "boolean", value: false },
      { kind: "date", value: "2026-08-06" },
      { kind: "datetime", value: "2026-08-06T12:30:00Z" }
    ] as const;

    for (const replacement of replacements) {
      const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: {
          sessionId,
          revision: 0,
          step: {
            id: `fill-${replacement.kind}`,
            kind: "fillMissingValues",
            params: { column: { id: "r:c:0", name: "value" }, replacement }
          },
          page: pageWindow()
        }
      };
      expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    }

    const previewResponse = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalFramePage(),
      diff: minimalRenameDiff(),
      code: "open_wrangler_result <- frame\n",
      remainingMissingCells: 1
    };
    expect(
      decodeRKernelResponseJson(JSON.stringify(previewResponse), previewRequestId, {
        inputSchema: minimalFramePage().schema
      })
    ).toMatchObject({ kind: "stepPreview", remainingMissingCells: 1 });
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          ...previewResponse,
          remainingMissingCells: minimalFramePage().shape.rows + 1
        }),
        previewRequestId,
        { inputSchema: minimalFramePage().schema }
      )
    ).toThrow("response.remainingMissingCells");

    const fallbackRequest = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "fill-fallback-columns",
          kind: "fillMissingValues",
          params: {
            column: { id: "r:c:0", name: "value" },
            replacement: {
              kind: "fallbackColumns",
              columns: [
                { id: "r:c:2", name: "first" },
                { id: "r:c:1", name: "second" }
              ]
            }
          }
        },
        page: pageWindow()
      }
    } as RKernelRequest;
    expect(JSON.parse(encodeRKernelRequest(fallbackRequest))).toEqual(fallbackRequest);

    const invalidReplacements: ReadonlyArray<readonly [unknown, string]> = [
      [{ kind: "mean", value: "1" }, "may not contain a value"],
      [{ kind: "median", value: "1" }, "may not contain a value"],
      [{ kind: "mostFrequent", value: "ready" }, "may not contain a value"],
      [{ kind: "fallbackColumns", columns: [] }, "bounded non-empty array"],
      [{ kind: "fallbackColumns", columns: [{ id: "r:c:0", name: "value" }] }, "cannot also be a fallback"],
      [
        {
          kind: "fallbackColumns",
          columns: [
            { id: "r:c:1", name: "first" },
            { id: "r:c:1", name: "first" }
          ]
        },
        "repeated identity"
      ],
      [
        {
          kind: "fallbackColumns",
          columns: Array.from({ length: 65 }, (_, index) => ({ id: `r:c:${index + 1}`, name: `c${index}` }))
        },
        "bounded non-empty array"
      ],
      [
        { kind: "fallbackColumns", columns: [{ id: "r:c:1", name: "first" }], value: "wrong" },
        "may not contain a value"
      ],
      [{ kind: "directional", direction: "forward", orderBy: [] }, "sorts exceed the supported limit"],
      [
        {
          kind: "directional",
          direction: "forward",
          orderBy: [{ column: { id: "r:c:0", name: "value" }, direction: "asc", nulls: "last" }]
        },
        "cannot also be a directional ordering column"
      ],
      [
        {
          kind: "directional",
          direction: "forward",
          orderBy: [
            { column: { id: "r:c:1", name: "sequence" }, direction: "asc", nulls: "last" },
            { column: { id: "r:c:1", name: "sequence" }, direction: "desc", nulls: "first" }
          ]
        },
        "repeated column identity"
      ],
      [
        {
          kind: "directional",
          direction: "sideways",
          orderBy: [{ column: { id: "r:c:1", name: "sequence" }, direction: "asc", nulls: "last" }]
        },
        "forward or backward"
      ],
      [
        {
          kind: "directional",
          direction: "backward",
          orderBy: [{ column: { id: "r:c:1", name: "sequence" }, direction: "asc", nulls: "last" }],
          maxGap: 0
        },
        "must be positive"
      ],
      [
        {
          kind: "directional",
          direction: "backward",
          orderBy: [{ column: { id: "r:c:1", name: "sequence" }, direction: "asc", nulls: "last" }],
          maxGap: 1_000_001
        },
        "outside its supported range"
      ],
      [
        {
          kind: "directional",
          direction: "forward",
          sortRules: [{ column: { id: "r:c:1", name: "sequence" }, direction: "asc", nulls: "last" }]
        },
        "invalid fields"
      ],
      [{ kind: "groupedStatistic", statistic: "mean", keys: [] }, "bounded non-empty array"],
      [
        {
          kind: "groupedStatistic",
          statistic: "mean",
          keys: [{ id: "r:c:0", name: "value" }]
        },
        "cannot also be a grouping column"
      ],
      [
        {
          kind: "groupedStatistic",
          statistic: "mean",
          keys: [
            { id: "r:c:1", name: "group" },
            { id: "r:c:1", name: "group" }
          ]
        },
        "repeated identity"
      ],
      [
        {
          kind: "groupedStatistic",
          statistic: "sum",
          keys: [{ id: "r:c:1", name: "group" }]
        },
        "unsupported statistic"
      ],
      [
        {
          kind: "groupedStatistic",
          statistic: "median",
          keys: [{ id: "r:c:1", name: "group" }],
          maxGap: 1
        },
        "may contain only"
      ],
      [
        {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:0", name: "value" }
        },
        "cannot also be the interpolation coordinate"
      ],
      [{ kind: "linearInterpolation" }, "request.payload.step.params.replacement.coordinate"],
      [
        {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:1", name: "coordinate" },
          maxGap: 0
        },
        "must be positive"
      ],
      [
        {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:1", name: "coordinate" },
          maxGap: 1_000_001
        },
        "outside its supported range"
      ],
      [
        {
          kind: "linearInterpolation",
          coordinate: { id: "r:c:1", name: "coordinate" },
          keys: [{ id: "r:c:2", name: "extra" }]
        },
        "may contain only"
      ],
      [{ kind: "string" }, "requires a value"],
      [{ kind: "integer", value: "01" }, "canonical decimal text"],
      [{ kind: "float", value: "NaN" }, "canonical decimal text"],
      [{ kind: "boolean", value: "true" }, "true or false"],
      [{ kind: "string", value: "🙂".repeat(3_000) }, "UTF-8 byte limit"],
      [{ kind: "date", value: "06-08-2026" }, "YYYY-MM-DD"],
      [{ kind: "datetime", value: "2026-08-06" }, "too short"],
      [{ kind: "duration", value: "1" }, "unsupported kind"]
    ];
    for (const [replacement, message] of invalidReplacements) {
      const request = {
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: {
          sessionId,
          revision: 0,
          step: {
            id: "fill-invalid",
            kind: "fillMissingValues",
            params: { column: { id: "r:c:0", name: "value" }, replacement }
          },
          page: pageWindow()
        }
      };
      expect(() => encodeRKernelRequest(request as RKernelRequest)).toThrow(message);
    }

    const extraParameter = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "fill-extra",
          kind: "fillMissingValues",
          params: {
            column: { id: "r:c:0", name: "value" },
            replacement: { kind: "string", value: "unknown" },
            extra: true
          }
        },
        page: pageWindow()
      }
    };
    expect(() => encodeRKernelRequest(extraParameter as RKernelRequest)).toThrow("invalid fields");
  });

  it("strictly validates native R Group By payloads", () => {
    const aggregation = (
      operation: RKernelGroupByStep["params"]["aggregations"][number]["operation"],
      index: number
    ) => ({
      column: { id: "r:c:0", name: "value" },
      operation,
      alias: `${operation}_${index}`
    });
    const step: RKernelGroupByStep = {
      id: "group-step",
      kind: "groupBy",
      params: {
        keys: [{ id: "r:c:1", name: "group" }],
        aggregations: [
          aggregation("sum", 0),
          aggregation("mean", 1),
          aggregation("median", 2),
          aggregation("min", 3),
          aggregation("max", 4),
          aggregation("count", 5),
          aggregation("nUnique", 6),
          aggregation("first", 7),
          aggregation("last", 8)
        ]
      }
    };
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: { sessionId, revision: 0, step, page: pageWindow() }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const expectRejected = (candidate: unknown, message: string) => {
      expect(() =>
        encodeRKernelRequest({
          ...request,
          payload: { ...request.payload, step: candidate }
        } as RKernelRequest)
      ).toThrow(message);
    };
    expectRejected({ ...step, params: { ...step.params, keys: [] } }, "bounded non-empty array");
    expectRejected(
      { ...step, params: { ...step.params, keys: [step.params.keys[0], step.params.keys[0]] } },
      "repeated identity"
    );
    expectRejected({ ...step, params: { ...step.params, aggregations: [] } }, "output-column limit");
    expectRejected(
      {
        ...step,
        params: {
          ...step.params,
          aggregations: [{ ...step.params.aggregations[0], operation: "variance" }]
        }
      },
      "unsupported operation"
    );
    expectRejected(
      {
        ...step,
        params: {
          ...step.params,
          aggregations: [
            step.params.aggregations[0],
            { ...step.params.aggregations[1], alias: step.params.aggregations[0]!.alias }
          ]
        }
      },
      "aliases must be unique"
    );
    expectRejected(
      {
        ...step,
        params: {
          ...step.params,
          aggregations: [{ ...step.params.aggregations[0], alias: "group" }]
        }
      },
      "cannot duplicate a key name"
    );
    expectRejected({ ...step, params: { ...step.params, extra: true } }, "invalid fields");
  });

  it("strictly validates native R Min-max scale, Round, Floor, and Ceiling payloads", () => {
    const steps = [
      {
        id: "scale-in-place",
        kind: "minMaxScale",
        params: { column: { id: "r:c:0", name: "value" } }
      },
      {
        id: "scale-derived",
        kind: "minMaxScale",
        params: { column: { id: "r:c:0", name: "value" }, newColumn: "scaled" }
      },
      {
        id: "round-negative-digits",
        kind: "roundNumber",
        params: { column: { id: "r:c:0", name: "value" }, decimals: -3 }
      },
      {
        id: "round-positive-digits",
        kind: "roundNumber",
        params: { column: { id: "r:c:0", name: "value" }, decimals: 4, newColumn: "rounded" }
      },
      {
        id: "floor-step",
        kind: "floorNumber",
        params: { column: { id: "r:c:0", name: "value" } }
      },
      {
        id: "ceiling-step",
        kind: "ceilNumber",
        params: { column: { id: "r:c:0", name: "value" }, newColumn: "ceiling_value" }
      }
    ] as const;
    for (const step of steps) {
      const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step, page: pageWindow() }
      };
      expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    }

    const expectRejected = (step: unknown, message: string) => {
      expect(() =>
        encodeRKernelRequest({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: previewRequestId,
          kind: "previewStep",
          payload: { sessionId, revision: 0, step, page: pageWindow() }
        } as RKernelRequest)
      ).toThrow(message);
    };
    expectRejected({ ...steps[0], params: { ...steps[0].params, decimals: 0 } }, "invalid fields");
    expectRejected(
      { ...steps[2], params: { ...steps[2].params, decimals: 1.5 } },
      "request.payload.step.params.decimals"
    );
    expectRejected(
      { ...steps[2], params: { ...steps[2].params, decimals: 2_147_483_648 } },
      "request.payload.step.params.decimals"
    );
    expectRejected(
      { ...steps[2], params: { ...steps[2].params, decimals: -2_147_483_648 } },
      "request.payload.step.params.decimals"
    );
    expectRejected({ ...steps[4], params: { ...steps[4].params, decimals: 0 } }, "invalid fields");
    expectRejected(
      { ...steps[5], params: { ...steps[5].params, newColumn: "" } },
      "request.payload.step.params.newColumn"
    );
    expectRejected({ ...steps[3], params: { ...steps[3].params, unexpected: true } }, "invalid fields");
    const missingColumn = structuredClone(steps[1]) as unknown as { params: Record<string, unknown> };
    delete missingColumn.params.column;
    expectRejected(missingColumn, "invalid fields");
  });

  it("strictly validates native R Formula and Format Datetime payloads", () => {
    const formulaWithScalar = {
      id: "formula-scalar",
      kind: "formula",
      params: {
        leftColumn: { id: "r:c:0", name: "value" },
        operator: "multiply",
        value: 2.5,
        newColumn: "scaled value"
      }
    } as const;
    const formulaWithColumn = {
      id: "formula-column",
      kind: "formula",
      params: {
        leftColumn: { id: "r:c:0", name: "value" },
        operator: "subtract",
        rightColumn: { id: "r:c:1", name: "baseline" },
        newColumn: "difference"
      }
    } as const;
    const formatInPlace = {
      id: "format-in-place",
      kind: "formatDatetime",
      params: { column: { id: "r:c:2", name: "recorded at" }, format: "%Y-%m-%d" }
    } as const;
    const formatAppended = {
      id: "format-appended",
      kind: "formatDatetime",
      params: {
        column: { id: "r:c:2", name: "recorded at" },
        format: "%Y-%m-%d %H:%M:%S",
        newColumn: "recorded label"
      }
    } as const;

    for (const step of [formulaWithScalar, formulaWithColumn, formatInPlace, formatAppended]) {
      const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step, page: pageWindow() }
      };
      expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    }

    const expectRejected = (step: unknown, message: string) => {
      expect(() =>
        encodeRKernelRequest({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: previewRequestId,
          kind: "previewStep",
          payload: { sessionId, revision: 0, step, page: pageWindow() }
        } as RKernelRequest)
      ).toThrow(message);
    };

    expectRejected({ ...formulaWithScalar, params: { ...formulaWithScalar.params, extra: true } }, "invalid fields");
    expectRejected(
      { ...formulaWithScalar, params: { ...formulaWithScalar.params, operator: "quotient" } },
      "unsupported operator"
    );
    expectRejected(
      {
        ...formulaWithScalar,
        params: {
          ...formulaWithScalar.params,
          rightColumn: formulaWithColumn.params.rightColumn
        }
      },
      "exactly one right column or numeric value"
    );
    const formulaWithoutOperand = structuredClone(formulaWithScalar) as unknown as {
      params: Record<string, unknown>;
    };
    delete formulaWithoutOperand.params.value;
    expectRejected(formulaWithoutOperand, "exactly one right column or numeric value");
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      expectRejected(
        { ...formulaWithScalar, params: { ...formulaWithScalar.params, value } },
        "formula value must be finite"
      );
    }
    expectRejected(
      { ...formulaWithScalar, params: { ...formulaWithScalar.params, newColumn: "" } },
      "request.payload.step.params.newColumn"
    );
    expectRejected({ ...formatInPlace, params: { ...formatInPlace.params, extra: true } }, "invalid fields");
    const formatWithoutPattern = structuredClone(formatInPlace) as unknown as {
      params: Record<string, unknown>;
    };
    delete formatWithoutPattern.params.format;
    expectRejected(formatWithoutPattern, "invalid fields");
    expectRejected(
      { ...formatInPlace, params: { ...formatInPlace.params, format: "" } },
      "request.payload.step.params.format"
    );
    expectRejected(
      { ...formatAppended, params: { ...formatAppended.params, newColumn: "" } },
      "request.payload.step.params.newColumn"
    );
  });

  it("strictly validates native R categorical payloads and permits duplicate removed labels", () => {
    const oneHot = {
      id: "one-hot",
      kind: "oneHotEncode",
      params: {
        columns: [
          { id: "r:c:0", name: "duplicate" },
          { id: "r:c:1", name: "duplicate" }
        ],
        prefixSeparator: "",
        dropOriginal: true
      }
    } as const;
    const multiLabel = {
      id: "multi-label",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "r:c:2", name: "labels" },
        delimiter: "::",
        prefix: "",
        dropOriginal: false
      }
    } as const;
    for (const step of [oneHot, multiLabel]) {
      const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
        transportVersion: R_KERNEL_TRANSPORT_VERSION,
        requestId: previewRequestId,
        kind: "previewStep",
        payload: { sessionId, revision: 0, step, page: pageWindow() }
      };
      expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);
    }

    const expectRejected = (step: unknown, message: string) => {
      expect(() =>
        encodeRKernelRequest({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: previewRequestId,
          kind: "previewStep",
          payload: { sessionId, revision: 0, step, page: pageWindow() }
        } as RKernelRequest)
      ).toThrow(message);
    };
    expectRejected({ ...oneHot, params: { ...oneHot.params, columns: [] } }, "bounded non-empty array");
    expectRejected(
      { ...oneHot, params: { ...oneHot.params, columns: [oneHot.params.columns[0], oneHot.params.columns[0]] } },
      "repeated identity"
    );
    expectRejected({ ...oneHot, params: { ...oneHot.params, columns: ["duplicate"] } }, "must be an object");
    expectRejected({ ...oneHot, params: { ...oneHot.params, dropOriginal: "yes" } }, "drop-original flag");
    expectRejected(
      { ...oneHot, params: { ...oneHot.params, prefixSeparator: "x".repeat(R_FRAME_CONTRACT_LIMITS.textBytes + 1) } },
      "prefixSeparator"
    );
    expectRejected({ ...multiLabel, params: { ...multiLabel.params, delimiter: "" } }, "delimiter");
    expectRejected({ ...multiLabel, params: { ...multiLabel.params, prefix: 1 } }, "prefix");
    expectRejected({ ...multiLabel, params: { ...multiLabel.params, dropOriginal: 1 } }, "drop-original flag");
    expectRejected({ ...multiLabel, params: { ...multiLabel.params, extra: true } }, "invalid fields");

    const duplicateInputSchema = [
      { ...minimalFramePage().schema[0]!, id: "r:c:0", name: "duplicate", position: 0 },
      { ...minimalFramePage().schema[0]!, id: "r:c:1", name: "duplicate", position: 1 }
    ];
    const response = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalFramePage(),
      diff: { ...minimalRenameDiff(), removedColumns: ["duplicate", "duplicate"] },
      code: "open_wrangler_result <- frame\n"
    };
    expect(
      decodeRKernelResponseJson(JSON.stringify(response), previewRequestId, { inputSchema: duplicateInputSchema })
    ).toMatchObject({ kind: "stepPreview", diff: { removedColumns: ["duplicate", "duplicate"] } });
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({ ...response, diff: { ...response.diff, addedColumns: ["encoded", "encoded"] } }),
        previewRequestId,
        { inputSchema: duplicateInputSchema }
      )
    ).toThrow("added-column diff names must be unique");
  });

  it("strictly validates native R Cast requests and type-changing cell diffs", () => {
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "cast-step",
          kind: "castColumn",
          params: { column: { id: "r:c:0", name: "value" }, dtype: "float" }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const response = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalCastFloatFramePage(),
      diff: {
        ...minimalRenameDiff(),
        changedCells: 1,
        cells: [
          {
            rowNumber: 0,
            columnId: "r:c:0",
            column: "value",
            before: { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false },
            after: { kind: "number", raw: "1", display: "1", isNull: false, isNaN: false }
          }
        ]
      },
      code: "open_wrangler_result <- frame\n"
    });
    expect(
      decodeRKernelResponseJson(response, previewRequestId, { inputSchema: minimalFramePage().schema })
    ).toMatchObject({
      kind: "stepPreview",
      page: { schema: [expect.objectContaining({ id: "r:c:0", rawType: "double", type: "float" })] },
      diff: {
        changedCells: 1,
        cells: [
          expect.objectContaining({
            before: expect.objectContaining({ kind: "integer", raw: "1" }),
            after: expect.objectContaining({ kind: "number", raw: 1 })
          })
        ]
      }
    });

    const inspection = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: inspectRequestId,
      kind: "stepInspectionPage",
      sessionId,
      revision: 2,
      stepId: "cast-step",
      stepIndex: 0,
      side: "output",
      page: inspectionWirePage(minimalCastFloatFramePage())
    });
    expect(
      decodeRKernelResponseJson(inspection, inspectRequestId, {
        outputSchema: minimalCastFloatFramePage().schema,
        inspectionSide: "output"
      })
    ).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      stepId: "cast-step",
      page: { schema: [expect.objectContaining({ type: "float" })] }
    });

    const unsupported = structuredClone(request) as unknown as {
      payload: { step: { params: { dtype: string } } };
    };
    unsupported.payload.step.params.dtype = "decimal";
    expect(() => encodeRKernelRequest(unsupported as unknown as RKernelRequest)).toThrow("unsupported target type");

    const derived = structuredClone(request) as unknown as {
      payload: { step: { params: Record<string, unknown> } };
    };
    derived.payload.step.params.newColumn = "value cast";
    expect(() => encodeRKernelRequest(derived as unknown as RKernelRequest)).toThrow("invalid fields");

    const malformedBefore = JSON.parse(response) as {
      diff: { cells: Array<{ before: Record<string, unknown> }> };
    };
    malformedBefore.diff.cells[0]!.before = {
      kind: "number",
      raw: "not-a-number",
      display: "not-a-number",
      isNull: false,
      isNaN: false
    };
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(malformedBefore), previewRequestId, {
        inputSchema: minimalFramePage().schema
      })
    ).toThrow("response.diff.cells[0].before is invalid");

    const outOfRangeBaseInteger = JSON.parse(response) as {
      diff: { cells: Array<{ before: Record<string, unknown> }> };
    };
    outOfRangeBaseInteger.diff.cells[0]!.before = {
      kind: "integer",
      raw: "9223372036854775807",
      display: "9223372036854775807",
      isNull: false,
      isNaN: false
    };
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(outOfRangeBaseInteger), previewRequestId, {
        inputSchema: minimalFramePage().schema
      })
    ).toThrow("response.diff.cells[0].before is invalid");

    const factorOutsideLevels = JSON.parse(response) as {
      diff: { cells: Array<{ before: Record<string, unknown> }> };
    };
    factorOutsideLevels.diff.cells[0]!.before = {
      kind: "string",
      raw: "BETA",
      display: "BETA",
      isNull: false,
      isNaN: false
    };
    const factorInputSchema = minimalFramePage().schema.map((column) => ({
      ...column,
      rawType: "factor",
      type: "string" as const,
      semantics: {
        kind: "factor" as const,
        storageMode: "integer" as const,
        classes: ["factor"],
        levels: ["ALPHA"],
        ordered: false
      }
    }));
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(factorOutsideLevels), previewRequestId, {
        inputSchema: factorInputSchema
      })
    ).toThrow("response.diff.cells[0].before is invalid");

    const oversizedBefore = JSON.parse(response) as {
      diff: { cells: Array<{ before: Record<string, unknown> }> };
    };
    oversizedBefore.diff.cells[0]!.before = {
      kind: "string",
      raw: "x".repeat(R_FRAME_CONTRACT_LIMITS.textBytes + 1),
      display: "x",
      isNull: false,
      isNaN: false
    };
    expect(() =>
      decodeRKernelResponseJson(JSON.stringify(oversizedBefore), previewRequestId, {
        inputSchema: minimalFramePage().schema
      })
    ).toThrow("response.diff.cells[0].before is invalid");
  });

  it("strictly validates native R Drop Columns requests and structural diffs", () => {
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "drop-step",
          kind: "dropColumns",
          params: { columns: [{ id: "r:c:0", name: "value" }] }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const duplicate = structuredClone(request) as unknown as {
      payload: { step: { params: { columns: Array<{ id: string; name: string }> } } };
    };
    duplicate.payload.step.params.columns.push({
      id: "r:c:0",
      name: "value"
    });
    expect(() => encodeRKernelRequest(duplicate as unknown as RKernelRequest)).toThrow("repeated identity");

    const empty = structuredClone(request) as unknown as {
      payload: { step: { params: { columns: Array<{ id: string; name: string }> } } };
    };
    empty.payload.step.params.columns.length = 0;
    expect(() => encodeRKernelRequest(empty as unknown as RKernelRequest)).toThrow("bounded non-empty array");

    const response = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalFramePage(),
      diff: { ...minimalRenameDiff(), removedColumns: ["value"] },
      code: "open_wrangler_result <- frame\n"
    });
    expect(
      decodeRKernelResponseJson(response, previewRequestId, { inputSchema: minimalFramePage().schema })
    ).toMatchObject({
      kind: "stepPreview",
      diff: { removedColumns: ["value"] }
    });
  });

  it("strictly validates ordered native R Select Columns requests and structural diffs", () => {
    const request: Extract<RKernelRequest, { kind: "previewStep" }> = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "previewStep",
      payload: {
        sessionId,
        revision: 0,
        step: {
          id: "select-step",
          kind: "selectColumns",
          params: {
            columns: [
              { id: "r:c:2", name: "date" },
              { id: "r:c:0", name: "value" }
            ]
          }
        },
        page: pageWindow()
      }
    };
    expect(JSON.parse(encodeRKernelRequest(request))).toEqual(request);

    const duplicate = structuredClone(request) as unknown as {
      payload: { step: { params: { columns: Array<{ id: string; name: string }> } } };
    };
    duplicate.payload.step.params.columns.push({ id: "r:c:2", name: "date" });
    expect(() => encodeRKernelRequest(duplicate as unknown as RKernelRequest)).toThrow("repeated identity");

    const empty = structuredClone(request) as unknown as {
      payload: { step: { params: { columns: Array<{ id: string; name: string }> } } };
    };
    empty.payload.step.params.columns.length = 0;
    expect(() => encodeRKernelRequest(empty as unknown as RKernelRequest)).toThrow("bounded non-empty array");

    const oversized = structuredClone(request) as unknown as {
      payload: { step: { params: { columns: Array<{ id: string; name: string }> } } };
    };
    oversized.payload.step.params.columns = Array.from({ length: R_FRAME_CONTRACT_LIMITS.columns + 1 }, (_, index) => ({
      id: `r:c:${index}`,
      name: `column-${index}`
    }));
    expect(() => encodeRKernelRequest(oversized as unknown as RKernelRequest)).toThrow("bounded non-empty array");

    const response = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: previewRequestId,
      kind: "stepPreview",
      sessionId,
      revision: 1,
      page: minimalFramePage(),
      diff: { ...minimalRenameDiff(), removedColumns: ["count"] },
      code: "open_wrangler_result <- frame\n"
    });
    expect(
      decodeRKernelResponseJson(response, previewRequestId, { inputSchema: minimalFramePage().schema })
    ).toMatchObject({
      kind: "stepPreview",
      diff: { removedColumns: ["count"] }
    });
  });

  it("validates R filter operators, typed selections, and value limits before dispatch", () => {
    const valid: RKernelRequest = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: pageRequestId,
      kind: "getPage",
      payload: {
        sessionId,
        page: {
          ...pageWindow(),
          view: {
            filters: [
              {
                column: { id: "r:c:0", name: "value" },
                type: "float",
                predicates: [{ kind: "predicate", operator: "isNaN" }],
                valueFilter: {
                  kind: "values",
                  selectedValues: [
                    {
                      kind: "typedSelection",
                      version: 1,
                      columnType: "float",
                      cell: {
                        kind: "infinity",
                        raw: null,
                        display: "Inf",
                        isNull: false,
                        isNaN: false,
                        sign: 1
                      }
                    }
                  ],
                  includeNulls: false,
                  includeNaN: false
                }
              }
            ],
            sorts: []
          }
        }
      }
    };
    expect(JSON.parse(encodeRKernelRequest(valid))).toEqual(valid);

    const invalidOperator = structuredClone(valid) as Extract<RKernelRequest, { kind: "getPage" }>;
    const operatorFilter = invalidOperator.payload.page.view.filters[0] as unknown as { type: string };
    operatorFilter.type = "string";
    expect(() => encodeRKernelRequest(invalidOperator)).toThrow("is invalid");

    const invalidSelection = structuredClone(valid) as Extract<RKernelRequest, { kind: "getPage" }>;
    const selection = invalidSelection.payload.page.view.filters[0]?.valueFilter?.selectedValues[0] as {
      columnType: string;
    };
    selection.columnType = "integer";
    expect(() => encodeRKernelRequest(invalidSelection)).toThrow("typed selection");

    const valuesRequest: RKernelRequest = {
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: valuesRequestId,
      kind: "getColumnValues",
      payload: {
        sessionId,
        column: { id: "r:c:0", name: "value" },
        view: emptyView(),
        search: null,
        limit: 0
      }
    };
    expect(() => encodeRKernelRequest(valuesRequest)).toThrow("must be positive");
  });

  it("rejects extra or malformed request fields before kernel dispatch", () => {
    const valid = openRequest();
    const invalidRequests = [
      { ...valid, extra: true },
      { ...valid, payload: { ...valid.payload, extra: true } },
      { ...valid, payload: { ...valid.payload, page: { ...valid.payload.page, extra: true } } },
      {
        ...valid,
        payload: {
          ...valid.payload,
          page: {
            ...valid.payload.page,
            view: { ...valid.payload.page.view, sorts: [{ ...sortRule(), extra: true }] }
          }
        }
      },
      {
        ...valid,
        payload: {
          ...valid.payload,
          page: {
            ...valid.payload.page,
            view: {
              ...valid.payload.page.view,
              sorts: [{ ...sortRule(), column: { ...sortRule().column, extra: true } }]
            }
          }
        }
      }
    ];

    for (const request of invalidRequests) {
      expect(() => encodeRKernelRequest(request as unknown as RKernelRequest)).toThrow("invalid fields");
    }
    expect(() => encodeRKernelRequest(null as unknown as RKernelRequest)).toThrow("must be an object");
  });

  it("rejects malformed response fields and oversized diagnostics", () => {
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: openRequestId,
          kind: "closed",
          sessionId,
          extra: true
        }),
        openRequestId
      )
    ).toThrow("invalid fields");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: openRequestId,
          kind: "error",
          code: "runtime_error",
          message: "x".repeat(4_097),
          recoverable: false
        }),
        openRequestId
      )
    ).toThrow("UTF-8 byte limit");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: openRequestId,
          kind: "error",
          code: "unsupported-row-names",
          message: "legacy frame error",
          recoverable: false
        }),
        openRequestId
      )
    ).toThrow("invalid diagnostic code");
  });
});

describe("exact IRkernel session transport", () => {
  it("never retargets a verified picker selection to a replacement kernel", async () => {
    const original = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() })
    );
    const replacement = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() })
    );
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const jupyter = mockKernel(original.kernel, async () => replacement.kernel);
    const binding = selectionBinding(document, jupyter, original.kernel);
    const transport = createTransport(document, [sessionId, openRequestId], binding);

    await expect(transport.open("frame", pageWindow())).rejects.toThrow("verified R notebook kernel changed");
    await expect(transport.dispose()).resolves.toBeUndefined();

    expect(original.bootstrapExecutions()).toBe(0);
    expect(original.dispatchExecutions()).toBe(0);
    expect(replacement.bootstrapExecutions()).toBe(0);
    expect(replacement.dispatchExecutions()).toBe(0);
    expect(binding.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a verified kernel that restarted after bridge construction but before open", async () => {
    const controller = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() })
    );
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const jupyter = mockKernel(controller.kernel);
    let invalidated = false;
    const binding = selectionBinding(document, jupyter, controller.kernel, "r.data.frame", () => invalidated);
    const transport = createTransport(document, [sessionId, openRequestId], binding);

    invalidated = true;

    await expect(transport.open("frame", pageWindow())).rejects.toThrow("verified R notebook kernel changed");
    expect(controller.bootstrapExecutions()).toBe(0);
    expect(controller.dispatchExecutions()).toBe(0);
    await expect(transport.dispose()).resolves.toBeUndefined();
  });

  it("rejects a frame whose flavor no longer matches the verified picker selection", async () => {
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "closeSession") {
        return response(request, { kind: "closed", sessionId: request.payload.sessionId });
      }
      return response(request, {
        kind: "page",
        sessionId: request.payload.sessionId,
        page: minimalFramePage()
      });
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const jupyter = mockKernel(controller.kernel);
    const binding = selectionBinding(document, jupyter, controller.kernel, "r.tibble");
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId], binding);

    await expect(transport.open("frame", pageWindow())).rejects.toThrow("dataframe changed");
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(mappedSessions(transport)).toEqual(new Map());
    await expect(transport.dispose()).resolves.toBeUndefined();
  });

  it("opens, pages, profiles, retrieves values, and closes one immutable R session on its exact kernel", async () => {
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "closeSession") {
        return response(request, { kind: "closed", sessionId: request.payload.sessionId });
      }
      if (request.kind === "getSummary") {
        return response(request, {
          kind: "summary",
          sessionId: request.payload.sessionId,
          summaries: [minimalSummary()]
        });
      }
      if (request.kind === "getDatasetStats") {
        return response(request, {
          kind: "datasetStats",
          sessionId: request.payload.sessionId,
          totalRows: 1,
          stats: minimalDatasetStats()
        });
      }
      if (request.kind === "getColumnValues") {
        return response(request, {
          kind: "columnValues",
          sessionId: request.payload.sessionId,
          column: "value",
          values: [minimalColumnValue()],
          hasMore: false
        });
      }
      return response(request, {
        kind: "page",
        sessionId: request.payload.sessionId,
        page: minimalFramePage()
      });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [
      sessionId,
      openRequestId,
      pageRequestId,
      summaryRequestId,
      statsRequestId,
      valuesRequestId,
      closeRequestId
    ]);

    await expect(transport.open("frame", pageWindow())).resolves.toMatchObject({
      sessionId,
      exportFormats: ["csv"],
      page: { dataframeFlavor: "r.data.frame" }
    });
    await expect(transport.getPage(sessionId, pageWindow([sortRule()]))).resolves.toMatchObject({
      page: { rows: [{ id: "r:r:0" }] }
    });
    await expect(transport.getSummary(sessionId, [{ id: "r:c:0", name: "value" }], emptyView())).resolves.toMatchObject(
      [{ columnId: "r:c:0", totalCount: 1 }]
    );
    await expect(transport.getDatasetStats(sessionId, emptyView())).resolves.toEqual({
      totalRows: 1,
      stats: minimalDatasetStats()
    });
    await expect(
      transport.getColumnValues(sessionId, { id: "r:c:0", name: "value" }, emptyView(), "1", 25)
    ).resolves.toMatchObject({ column: "value", values: [{ value: "1", count: 1 }], hasMore: false });
    await expect(transport.close(sessionId)).resolves.toBeUndefined();
    await expect(transport.dispose()).resolves.toBeUndefined();

    expect(controller.bootstrapExecutions()).toBe(1);
    expect(controller.teardownExecutions()).toBe(1);
    expect(requests.map((request) => request.kind)).toEqual([
      "openSession",
      "getPage",
      "getSummary",
      "getDatasetStats",
      "getColumnValues",
      "closeSession"
    ]);
    expect(requests[1]).toMatchObject({
      payload: { page: { view: { sorts: [{ column: { id: "r:c:0", name: "value" } }] } } }
    });
  });

  it.each(["csv", "parquet"] as const)(
    "streams a bounded %s export from the exact IRkernel and closes its private artifact",
    async (format) => {
      const requests: RKernelRequest[] = [];
      const controller = controlledRKernel(async (request) => {
        requests.push(request);
        if (request.kind === "exportData") {
          return response(request, {
            kind: "dataExported",
            sessionId,
            revision: request.payload.revision,
            exportId: request.payload.exportId,
            format,
            rows: 1,
            columns: 1,
            bytes: R_KERNEL_EXPORT_CHUNK_BYTES + 3
          });
        }
        if (request.kind === "readDataExport") {
          const data =
            request.payload.offset === 0 ? Buffer.alloc(R_KERNEL_EXPORT_CHUNK_BYTES, 0x61) : Buffer.from("end", "utf8");
          return response(request, {
            kind: "dataExportChunk",
            sessionId,
            revision: request.payload.revision,
            exportId: request.payload.exportId,
            offset: request.payload.offset,
            bytes: data.byteLength,
            data: data.toString("base64")
          });
        }
        if (request.kind === "closeDataExport") {
          return response(request, {
            kind: "dataExportClosed",
            sessionId,
            revision: request.payload.revision,
            exportId: request.payload.exportId
          });
        }
        if (request.kind === "closeSession") {
          return response(request, { kind: "closed", sessionId: request.payload.sessionId });
        }
        return response(request, {
          kind: "page",
          sessionId: request.payload.sessionId,
          exportFormats: ["csv", "parquet"],
          page: minimalFramePage()
        });
      });
      mockKernel(controller.kernel);
      const document = notebookDocument();
      setOpenNotebookDocuments(document);
      const transport = createTransport(document, [
        sessionId,
        openRequestId,
        exportId,
        exportRequestId,
        exportChunkRequestId,
        exportSecondChunkRequestId,
        exportCloseRequestId,
        closeRequestId
      ]);
      const chunks: Uint8Array[] = [];

      await transport.open("frame", pageWindow());
      await expect(
        transport.exportData(sessionId, 0, rExportOptions(format), async (chunk) => {
          chunks.push(chunk);
        })
      ).resolves.toEqual({ sessionId, revision: 0, format, rows: 1, columns: 1 });
      await transport.close(sessionId);
      await transport.dispose();

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toHaveLength(R_KERNEL_EXPORT_CHUNK_BYTES);
      expect(Buffer.from(chunks[1]!).toString("utf8")).toBe("end");
      expect(requests.map(({ kind }) => kind)).toEqual([
        "openSession",
        "exportData",
        "readDataExport",
        "readDataExport",
        "closeDataExport",
        "closeSession"
      ]);
      expect(requests[2]).toMatchObject({ payload: { offset: 0, limit: R_KERNEL_EXPORT_CHUNK_BYTES } });
      expect(requests[3]).toMatchObject({ payload: { offset: R_KERNEL_EXPORT_CHUNK_BYTES, limit: 3 } });
    }
  );

  it("closes a private IRkernel export after a timed-out begin request settles", async () => {
    vi.useFakeTimers();
    const beginStarted = deferred<void>();
    const releaseBegin = deferred<void>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "exportData") {
        beginStarted.resolve();
        await releaseBegin.promise;
        return response(request, {
          kind: "dataExported",
          sessionId,
          revision: request.payload.revision,
          exportId: request.payload.exportId,
          format: "csv",
          rows: 0,
          columns: 1,
          bytes: 0
        });
      }
      if (request.kind === "closeDataExport") {
        return response(request, {
          kind: "dataExportClosed",
          sessionId,
          revision: request.payload.revision,
          exportId: request.payload.exportId
        });
      }
      if (request.kind === "closeSession") {
        return response(request, { kind: "closed", sessionId: request.payload.sessionId });
      }
      return response(request, {
        kind: "page",
        sessionId: request.payload.sessionId,
        page: minimalFramePage()
      });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [
      sessionId,
      openRequestId,
      exportId,
      exportRequestId,
      exportCloseRequestId,
      closeRequestId
    ]);

    await transport.open("frame", pageWindow());
    const exporting = transport
      .exportData(sessionId, 0, rCsvExportOptions, async () => undefined, { timeoutMs: 30 })
      .catch((error: unknown) => error);
    await beginStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    const detached = await exporting;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "timeout", dispatched: true });

    releaseBegin.resolve();
    vi.useRealTimers();
    await (detached as DetachedBridgeRequestError).settlement;
    expect(requests.map(({ kind }) => kind)).toEqual(["openSession", "exportData", "closeDataExport"]);
    await transport.close(sessionId);
    await transport.dispose();
  });

  it("cleans a detached export on its captured kernel after the public mapping is invalidated", async () => {
    vi.useFakeTimers();
    const beginStarted = deferred<void>();
    const releaseBegin = deferred<void>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "exportData") {
        beginStarted.resolve();
        await releaseBegin.promise;
        invalidateCurrentKernel(transport);
        return response(request, {
          kind: "dataExported",
          sessionId,
          revision: request.payload.revision,
          exportId: request.payload.exportId,
          format: "csv",
          rows: 0,
          columns: 1,
          bytes: 0
        });
      }
      if (request.kind === "closeDataExport") {
        return response(request, {
          kind: "dataExportClosed",
          sessionId,
          revision: request.payload.revision,
          exportId: request.payload.exportId
        });
      }
      return response(request, {
        kind: "page",
        sessionId: request.payload.sessionId,
        page: minimalFramePage()
      });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [
      sessionId,
      openRequestId,
      exportId,
      exportRequestId,
      exportCloseRequestId
    ]);

    await transport.open("frame", pageWindow());
    const exporting = transport
      .exportData(sessionId, 0, rCsvExportOptions, async () => undefined, { timeoutMs: 30 })
      .catch((error: unknown) => error);
    await beginStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    const detached = await exporting;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);

    releaseBegin.resolve();
    vi.useRealTimers();
    await (detached as DetachedBridgeRequestError).settlement;
    expect(mappedSessions(transport).size).toBe(0);
    expect(requests.map(({ kind }) => kind)).toEqual(["openSession", "exportData", "closeDataExport"]);
    await transport.dispose();
  });

  it("terminally invalidates a session and reports an unrecovered detached export cleanup", async () => {
    vi.useFakeTimers();
    const beginStarted = deferred<void>();
    const releaseBegin = deferred<void>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "exportData") {
        beginStarted.resolve();
        await releaseBegin.promise;
        return response(request, {
          kind: "dataExported",
          sessionId,
          revision: request.payload.revision,
          exportId: request.payload.exportId,
          format: "csv",
          rows: 0,
          columns: 1,
          bytes: 0
        });
      }
      if (request.kind === "closeDataExport" || request.kind === "closeSession") {
        return response(request, {
          kind: "error",
          code: "runtime_error",
          message: "injected cleanup failure",
          recoverable: false
        });
      }
      return response(request, {
        kind: "page",
        sessionId: request.payload.sessionId,
        page: minimalFramePage()
      });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [
      sessionId,
      openRequestId,
      exportId,
      exportRequestId,
      exportCloseRequestId,
      closeRequestId
    ]);
    const invalidated = vi.fn();
    transport.onDidInvalidateKernel(invalidated);

    await transport.open("frame", pageWindow());
    const exporting = transport
      .exportData(sessionId, 0, rCsvExportOptions, async () => undefined, { timeoutMs: 30 })
      .catch((error: unknown) => error);
    await beginStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    const detached = await exporting;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);

    releaseBegin.resolve();
    vi.useRealTimers();
    await (detached as DetachedBridgeRequestError).settlement;
    expect(invalidated).toHaveBeenCalledOnce();
    expect(mappedSessions(transport).size).toBe(0);
    expect(requests.map(({ kind }) => kind)).toEqual(["openSession", "exportData", "closeDataExport", "closeSession"]);
    await expect(transport.dispose()).rejects.toThrow("could not close a private R notebook export");
  });

  it("rejects a replacement document with the same URI before dispatch", async () => {
    const controller = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId, page: minimalFramePage() })
    );
    let lookup = 0;
    const original = notebookDocument();
    const replacement = notebookDocument();
    setOpenNotebookDocuments(original);
    mockKernel(controller.kernel, async () => {
      lookup += 1;
      if (lookup === 2) setOpenNotebookDocuments(replacement);
      return controller.kernel;
    });
    const transport = createTransport(original, [sessionId, openRequestId]);

    await expect(transport.open("frame", pageWindow())).rejects.toThrow("no longer the sole open document");
    expect(controller.dispatchExecutions()).toBe(0);
  });

  it("keeps native R rename mutations on the exact mapped kernel", async () => {
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "previewStep") {
        return response(request, {
          kind: "stepPreview",
          sessionId,
          revision: 1,
          page: minimalFramePage(),
          diff: minimalRenameDiff(),
          code: "open_wrangler_result <- frame\n"
        });
      }
      if (request.kind === "applyDraft" || request.kind === "discardDraft" || request.kind === "undoStep") {
        const action = request.kind === "applyDraft" ? "apply" : request.kind === "discardDraft" ? "discard" : "undo";
        return response(request, {
          kind: "planUpdated",
          sessionId,
          action,
          revision: request.payload.revision + 1,
          page: minimalFramePage(),
          code: "open_wrangler_result <- frame\n"
        });
      }
      if (request.kind === "inspectStepInfo") {
        return response(request, {
          kind: "stepInspectionInfo",
          sessionId,
          revision: request.payload.revision,
          stepId: request.payload.stepId,
          stepIndex: 0,
          code: "open_wrangler_result <- frame\n"
        });
      }
      if (request.kind === "inspectStepPage") {
        const frame = minimalFramePage();
        return response(request, {
          kind: "stepInspectionPage",
          sessionId,
          revision: request.payload.revision,
          stepId: request.payload.stepId,
          stepIndex: 0,
          side: request.payload.side,
          page: inspectionWirePage(frame)
        });
      }
      if (request.kind === "closeSession") {
        return response(request, { kind: "closed", sessionId });
      }
      return response(request, { kind: "page", sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [
      sessionId,
      openRequestId,
      previewRequestId,
      applyRequestId,
      discardRequestId,
      undoRequestId,
      inspectRequestId,
      inspectOutputRequestId,
      inspectSecondPageRequestId,
      closeRequestId
    ]);

    await transport.open("frame", pageWindow());
    await expect(
      transport.previewStep(sessionId, 0, renameStep(), pageWindow(), minimalFramePage().schema)
    ).resolves.toMatchObject({
      sessionId,
      revision: 1,
      diff: { changedCells: 0 }
    });
    await expect(transport.applyDraft(sessionId, 1, pageWindow())).resolves.toMatchObject({
      action: "apply",
      revision: 2
    });
    await expect(transport.discardDraft(sessionId, 2, pageWindow())).resolves.toMatchObject({
      action: "discard",
      revision: 3
    });
    await expect(transport.undoStep(sessionId, 3, pageWindow())).resolves.toMatchObject({
      action: "undo",
      revision: 4
    });
    await expect(
      transport.inspectStep(
        sessionId,
        4,
        "rename-step",
        pageWindow(),
        minimalFramePage().schema,
        minimalFramePage().schema
      )
    ).resolves.toMatchObject({
      stepId: "rename-step",
      stepIndex: 0,
      revision: 4
    });
    await transport.close(sessionId);
    await transport.dispose();

    expect(requests.map((request) => request.kind)).toEqual([
      "openSession",
      "previewStep",
      "applyDraft",
      "discardDraft",
      "undoStep",
      "inspectStepInfo",
      "inspectStepPage",
      "inspectStepPage",
      "closeSession"
    ]);
  });

  it("returns a correlated mutation without a post-response kernel lookup", async () => {
    let kernelLookups = 0;
    const controller = controlledRKernel(async (request) => {
      if (request.kind === "previewStep") {
        return response(request, {
          kind: "stepPreview",
          sessionId,
          revision: 1,
          page: minimalFramePage(),
          diff: minimalRenameDiff(),
          code: "open_wrangler_result <- frame\n"
        });
      }
      if (request.kind === "closeSession") {
        return response(request, { kind: "closed", sessionId });
      }
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel, async () => {
      kernelLookups += 1;
      if (kernelLookups > 6) throw new Error("unexpected post-response kernel lookup");
      return controller.kernel;
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, previewRequestId, closeRequestId]);

    await transport.open("frame", pageWindow());
    await expect(
      transport.previewStep(sessionId, 0, renameStep(), pageWindow(), minimalFramePage().schema)
    ).resolves.toMatchObject({
      sessionId,
      revision: 1
    });
    expect(kernelLookups).toBe(6);
    await transport.close(sessionId);
    await transport.dispose();
  });

  it("invalidates mapped sessions when the exact IRkernel restarts", async () => {
    const controller = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() })
    );
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, pageRequestId]);
    const invalidated = vi.fn();
    transport.onDidInvalidateKernel(invalidated);

    await transport.open("frame", pageWindow());
    controller.setStatus("restarting");

    expect(invalidated).toHaveBeenCalledOnce();
    await expect(transport.getPage(sessionId, pageWindow())).rejects.toThrow("no live R kernel session");
    await expect(transport.dispose()).resolves.toBeUndefined();
    expect(controller.teardownExecutions()).toBe(0);
  });

  it("closes only the host-created candidate when an open response names another session", async () => {
    const wrongSessionId = "55555555-5555-4555-8555-555555555555";
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") {
        return response(request, { kind: "page", sessionId: wrongSessionId, page: minimalFramePage() });
      }
      return response(request, { kind: "closed", sessionId: request.payload.sessionId });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    await expect(transport.open("frame", pageWindow())).rejects.toThrow("mismatched session identity");
    expect(
      requests.map((request) =>
        request.kind === "openSession" ? `open:${request.payload.sessionId}` : `close:${request.payload.sessionId}`
      )
    ).toEqual([`open:${sessionId}`, `close:${sessionId}`]);
    const attempts = (
      transport as unknown as {
        cleanupAttempts: WeakMap<Kernel, ReadonlyMap<string, Promise<boolean>>>;
      }
    ).cleanupAttempts.get(controller.kernel);
    expect(attempts?.size ?? 0).toBe(0);
  });

  it("retires a normal close that succeeds after the host deadline", async () => {
    vi.useFakeTimers();
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    let closeRequests = 0;
    const controller = controlledRKernel(async (request) => {
      if (request.kind === "closeSession") {
        closeRequests += 1;
        closeStarted.resolve();
        await releaseClose.promise;
        return response(request, { kind: "closed", sessionId: request.payload.sessionId });
      }
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    await transport.open("frame", pageWindow());
    const closing = transport.close(sessionId, { timeoutMs: 30 }).catch((error: unknown) => error);
    await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    const detached = await closing;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "timeout", dispatched: true });
    expect(mappedSessions(transport).has(sessionId)).toBe(true);

    const repeatedClose = transport.close(sessionId, { timeoutMs: 1_000 });
    await Promise.resolve();
    expect(closeRequests).toBe(1);
    releaseClose.resolve();
    vi.useRealTimers();
    await (detached as DetachedBridgeRequestError).settlement;
    await expect(repeatedClose).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mappedSessions(transport).has(sessionId)).toBe(false));
    expect(closeRequests).toBe(1);
  });

  it("keeps failed-open cleanup deduplicated until a late exact close settles", async () => {
    vi.useFakeTimers();
    const wrongSessionId = "55555555-5555-4555-8555-555555555555";
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const controller = controlledRKernel(async (request) => {
      if (request.kind === "openSession") {
        return response(request, { kind: "page", sessionId: wrongSessionId, page: minimalFramePage() });
      }
      closeStarted.resolve();
      await releaseClose.promise;
      return response(request, { kind: "closed", sessionId: request.payload.sessionId });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    const opening = transport.open("frame", pageWindow());
    const openRejection = expect(opening).rejects.toThrow("mismatched session identity");
    await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    await openRejection;
    expect(cleanupAttempts(transport, controller.kernel)?.size).toBe(1);
    expect(mappedSessions(transport).has(sessionId)).toBe(true);

    releaseClose.resolve();
    vi.useRealTimers();
    await vi.waitFor(() => expect(mappedSessions(transport).has(sessionId)).toBe(false));
    expect(cleanupAttempts(transport, controller.kernel)?.size ?? 0).toBe(0);
  });

  it("bounds retired session identity bookkeeping", () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, []);
    const internals = transport as unknown as {
      rememberRetiredSessionId(sessionId: string): void;
      retiredSessionIds: ReadonlySet<string>;
    };

    for (let index = 0; index < 1_025; index += 1) {
      internals.rememberRetiredSessionId(`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    }

    expect(internals.retiredSessionIds.size).toBe(1_024);
    expect(internals.retiredSessionIds.has("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(internals.retiredSessionIds.has("00000000-0000-4000-8000-000000000001")).toBe(true);
  });

  it("bounds pending failed-open cleanup bookkeeping", () => {
    const controller = controlledRKernel(async () => {
      throw new Error("should not dispatch");
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, []);
    const internals = transport as unknown as {
      rememberCleanupAttempt(kernel: Kernel, sessionId: string, attempt: Promise<boolean>): void;
      cleanupAttempts: WeakMap<Kernel, ReadonlyMap<string, Promise<boolean>>>;
    };

    for (let index = 0; index < 65; index += 1) {
      internals.rememberCleanupAttempt(
        controller.kernel,
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        new Promise<boolean>(() => undefined)
      );
    }

    const attempts = internals.cleanupAttempts.get(controller.kernel);
    expect(attempts?.size).toBe(64);
    expect(attempts?.has("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(attempts?.has("00000000-0000-4000-8000-000000000001")).toBe(true);
  });

  it("detaches host cancellation without interrupting IRkernel and cleans the candidate after settlement", async () => {
    const pending = deferred<unknown>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") return pending.promise;
      return response(request, { kind: "closed", sessionId: request.payload.sessionId });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const ids = [sessionId, openRequestId, closeRequestId];
    const transport = createTransport(document, ids);
    const cancellation = cancellationSource();
    const opening = transport
      .open("frame", pageWindow(), { cancellation: cancellation.token })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    cancellation.cancel();
    const detached = await opening;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "cancellation", dispatched: true });
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);

    const disposal = transport.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests.map((request) => request.kind)).toEqual(["openSession"]);
    pending.resolve(response(requests[0]!, { kind: "page", sessionId, page: minimalFramePage() }));
    await (detached as DetachedBridgeRequestError).settlement;
    await expect(disposal).resolves.toBeUndefined();
    await vi.waitFor(() => expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]));
    expect(requests.filter((request) => request.kind === "closeSession")).toHaveLength(1);
  });

  it("does not duplicate a detached-open cleanup when its bounded close remains pending", async () => {
    vi.useFakeTimers();
    const openStarted = deferred<void>();
    const releaseOpen = deferred<void>();
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") {
        openStarted.resolve();
        await releaseOpen.promise;
        return response(request, { kind: "page", sessionId, page: minimalFramePage() });
      }
      closeStarted.resolve();
      await releaseClose.promise;
      return response(request, { kind: "closed", sessionId: request.payload.sessionId });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    const opening = transport.open("frame", pageWindow(), { timeoutMs: 30 }).catch((error: unknown) => error);
    await openStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    const detached = await opening;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);

    const disposal = transport.dispose().catch((error: unknown) => error);
    releaseOpen.resolve();
    await closeStarted.promise;
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);

    await vi.advanceTimersByTimeAsync(5_000);
    await (detached as DetachedBridgeRequestError).settlement;
    const disposalError = await disposal;
    expect(disposalError).toBeInstanceOf(AggregateError);
    expect(disposalError).toHaveProperty("message", "Open Wrangler could not close every R kernel session.");
    expect(requests.filter((request) => request.kind === "closeSession")).toHaveLength(1);

    releaseClose.resolve();
    vi.useRealTimers();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("parks the next page request behind a cancelled page execution", async () => {
    const pendingPage = deferred<unknown>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "getPage" && request.requestId === pageRequestId) return pendingPage.promise;
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, pageRequestId, closeRequestId]);
    await transport.open("frame", pageWindow());

    const cancellation = cancellationSource();
    const firstPage = transport.getPage(sessionId, pageWindow(), { cancellation: cancellation.token }).then(
      (result) => result,
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    cancellation.cancel();
    const detached = await firstPage;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "cancellation", dispatched: true });

    const nextPage = transport.getPage(sessionId, pageWindow());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(2);

    pendingPage.resolve(response(requests[1]!, { kind: "page", sessionId, page: minimalFramePage() }));
    await (detached as DetachedBridgeRequestError).settlement;
    await expect(nextPage).resolves.toMatchObject({ page: { rows: [{ id: "r:r:0" }] } });
    expect(requests.map((request) => request.requestId)).toEqual([openRequestId, pageRequestId, closeRequestId]);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
  });

  it("revokes queued Custom Code and opens after settlement while still allowing exact close cleanup", async () => {
    const trustDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "isTrusted");
    let trusted = true;
    Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, get: () => trusted });
    const pendingPage = deferred<unknown>();
    const requests: RKernelRequest[] = [];
    let kernelLookups = 0;
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "getPage") return pendingPage.promise;
      if (request.kind === "previewStep") {
        return response(request, {
          kind: "stepPreview",
          sessionId,
          revision: request.payload.revision + 1,
          page: minimalFramePage(),
          diff: {
            addedRows: 1,
            removedRows: 1,
            addedColumns: [],
            removedColumns: [],
            changedCells: 0,
            cells: [],
            truncated: false
          },
          code: "open_wrangler_result <- frame\n",
          effectiveView: emptyView()
        });
      }
      if (request.kind === "closeSession") {
        return response(request, { kind: "closed", sessionId: request.payload.sessionId });
      }
      return response(request, {
        kind: "page",
        sessionId: request.payload.sessionId,
        page: minimalFramePage()
      });
    });
    mockKernel(controller.kernel, async () => {
      kernelLookups += 1;
      return controller.kernel;
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [
      sessionId,
      openRequestId,
      pageRequestId,
      previewRequestId,
      applyRequestId,
      closeRequestId
    ]);

    try {
      await transport.open("frame", pageWindow());
      const cancellation = cancellationSource();
      const page = transport
        .getPage(sessionId, pageWindow(), { cancellation: cancellation.token })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(requests.map(({ kind }) => kind)).toEqual(["openSession", "getPage"]));
      cancellation.cancel();
      const detached = await page;
      expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
      expect(detached).toMatchObject({ reason: "cancellation", dispatched: true });

      const lookupsBeforePreview = kernelLookups;
      const customStep = {
        id: "queued-custom",
        kind: "customCode",
        params: { code: "result <- df\n" }
      } as const;
      const preview = transport.previewStep(sessionId, 0, customStep, pageWindow(), minimalFramePage().schema);
      const queuedSessionId = "55555555-5555-4555-8555-555555555555";
      const queuedOpen = transport.open("frame", pageWindow(), { requestedSessionId: queuedSessionId });
      await vi.waitFor(() => expect(kernelLookups).toBeGreaterThanOrEqual(lookupsBeforePreview + 3));
      await Promise.resolve();
      trusted = false;
      const previewRejection = expect(preview).rejects.toThrow("Trust this workspace");
      const openRejection = expect(queuedOpen).rejects.toThrow("Trust this workspace");

      pendingPage.resolve(response(requests[1]!, { kind: "page", sessionId, page: minimalFramePage() }));
      await (detached as DetachedBridgeRequestError).settlement;
      await previewRejection;
      await openRejection;
      expect(requests.map(({ kind }) => kind)).toEqual(["openSession", "getPage"]);
      expect(mappedSessions(transport).has(queuedSessionId)).toBe(false);

      await expect(transport.close(sessionId)).resolves.toBeUndefined();
      expect(requests.map(({ kind }) => kind)).toEqual(["openSession", "getPage", "closeSession"]);
      await expect(transport.dispose()).resolves.toBeUndefined();
    } finally {
      trusted = true;
      await transport.dispose().catch(() => undefined);
      if (trustDescriptor) Object.defineProperty(vscode.workspace, "isTrusted", trustDescriptor);
      else Reflect.deleteProperty(vscode.workspace, "isTrusted");
    }
  });

  it("parks the next page request behind a timed-out page execution", async () => {
    vi.useFakeTimers();
    const pageStarted = deferred<void>();
    const pendingPage = deferred<unknown>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "getPage" && request.requestId === pageRequestId) {
        pageStarted.resolve();
        return pendingPage.promise;
      }
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, pageRequestId, closeRequestId]);
    await transport.open("frame", pageWindow());

    const firstPage = transport.getPage(sessionId, pageWindow(), { timeoutMs: 30 }).then(
      (result) => result,
      (error: unknown) => error
    );
    await pageStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    const detached = await firstPage;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "timeout", dispatched: true });

    const nextPage = transport.getPage(sessionId, pageWindow(), { timeoutMs: 1_000 });
    await Promise.resolve();
    expect(requests).toHaveLength(2);

    pendingPage.resolve(response(requests[1]!, { kind: "page", sessionId, page: minimalFramePage() }));
    await (detached as DetachedBridgeRequestError).settlement;
    await expect(nextPage).resolves.toMatchObject({ page: { rows: [{ id: "r:r:0" }] } });
    expect(requests.map((request) => request.requestId)).toEqual([openRequestId, pageRequestId, closeRequestId]);
  });

  it("rejects non-R kernels before bootstrap", async () => {
    const controller = controlledRKernel(async () => {
      throw new Error("should not dispatch");
    }, "python");
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);

    await expect(createTransport(document, [sessionId, openRequestId]).open("frame", pageWindow())).rejects.toThrow(
      "requires an R notebook kernel"
    );
    expect(controller.bootstrapExecutions()).toBe(0);
  });

  it("rejects an out-of-range host deadline before touching Jupyter", async () => {
    const getExtension = vi.spyOn(vscode.extensions, "getExtension");
    const document = notebookDocument();
    setOpenNotebookDocuments(document);

    await expect(
      createTransport(document, [sessionId]).open("frame", pageWindow(), { timeoutMs: 2_147_483_648 })
    ).rejects.toThrow("outside the supported integer range");
    expect(getExtension).not.toHaveBeenCalled();
  });

  it("makes disposal single-flight and rejects an open that is still preparing", async () => {
    const secondLookupStarted = deferred<void>();
    const releaseSecondLookup = deferred<Kernel>();
    const controller = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() })
    );
    let lookups = 0;
    mockKernel(controller.kernel, async () => {
      lookups += 1;
      if (lookups === 2) {
        secondLookupStarted.resolve();
        return releaseSecondLookup.promise;
      }
      return controller.kernel;
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId]);

    const opening = transport.open("frame", pageWindow());
    await secondLookupStarted.promise;
    const firstDisposal = transport.dispose();
    const secondDisposal = transport.dispose();
    expect(firstDisposal).toBe(secondDisposal);
    releaseSecondLookup.resolve(controller.kernel);

    await expect(opening).rejects.toThrow("transport is disposed");
    await expect(firstDisposal).resolves.toBeUndefined();
    expect(controller.dispatchExecutions()).toBe(0);
    await expect(transport.open("frame", pageWindow())).rejects.toThrow("transport is disposed");
  });

  it("does not install a kernel observer after pre-dispatch timeout and disposal", async () => {
    vi.useFakeTimers();
    const lookupStarted = deferred<void>();
    const releaseLookup = deferred<Kernel>();
    const controller = controlledRKernel(async () => {
      throw new Error("should not dispatch");
    });
    mockKernel(controller.kernel, async () => {
      lookupStarted.resolve();
      return releaseLookup.promise;
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId]);

    const opening = transport.open("frame", pageWindow(), { timeoutMs: 30 });
    const openRejection = expect(opening).rejects.toThrow("timed out after 30 ms");
    await lookupStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    await openRejection;
    let disposalSettled = false;
    const disposal = transport.dispose().finally(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    releaseLookup.resolve(controller.kernel);
    await expect(disposal).resolves.toBeUndefined();
    vi.useRealTimers();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.statusListenerCount()).toBe(0);
    expect(controller.bootstrapExecutions()).toBe(0);
  });

  it("waits for a timed-out bootstrap before disposal removes its late runtime bindings", async () => {
    vi.useFakeTimers();
    const bootstrapStarted = deferred<void>();
    const releaseBootstrap = deferred<void>();
    const controller = controlledRKernel(
      async (request) =>
        response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() }),
      "r",
      async function* () {
        bootstrapStarted.resolve();
        await releaseBootstrap.promise;
        yield* emptyOutput();
      }
    );
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId]);

    const opening = transport.open("frame", pageWindow(), { timeoutMs: 30 }).catch((error: unknown) => error);
    await bootstrapStarted.promise;
    await vi.advanceTimersByTimeAsync(30);

    const detached = await opening;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "timeout", dispatched: false });

    let disposalSettled = false;
    const disposal = transport.dispose().finally(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);
    expect(controller.bootstrapExecutions()).toBe(1);
    expect(controller.teardownExecutions()).toBe(0);
    expect(controller.dispatchExecutions()).toBe(0);

    releaseBootstrap.resolve();
    await (detached as DetachedBridgeRequestError).settlement;
    await expect(disposal).resolves.toBeUndefined();
    expect(controller.teardownExecutions()).toBe(1);
    expect(controller.statusListenerCount()).toBe(0);
  });

  it("finishes host disposal even when the kernel close reports an error", async () => {
    const controller = controlledRKernel(async (request) => {
      if (request.kind === "closeSession") {
        return response(request, {
          kind: "error",
          code: "runtime_error",
          message: "close failed",
          recoverable: false
        });
      }
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    await transport.open("frame", pageWindow());
    const disposal = transport.dispose();
    await expect(disposal).rejects.toThrow("could not close every R kernel session");

    expect(controller.statusListenerCount()).toBe(0);
    expect(controller.teardownExecutions()).toBe(1);
    expect(mappedSessions(transport).size).toBe(0);
    expect(transport.dispose()).toBe(disposal);
    await expect(transport.open("frame", pageWindow())).rejects.toThrow("transport is disposed");
  });

  it("preserves close and teardown failures from one terminal disposal", async () => {
    const controller = controlledRKernel(
      async (request) => {
        if (request.kind === "closeSession") {
          return response(request, {
            kind: "error",
            code: "runtime_error",
            message: "close failed",
            recoverable: false
          });
        }
        return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
      },
      "r",
      emptyOutput,
      async function* () {
        yield* emptyOutput();
        throw new Error("teardown failed");
      }
    );
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    await transport.open("frame", pageWindow());
    const disposal = transport.dispose();
    const error = await disposal.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty("message", "Open Wrangler could not finish R kernel cleanup.");
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toHaveProperty(
      "message",
      "Open Wrangler could not close every R kernel session."
    );
    expect((error as AggregateError).errors[1]).toHaveProperty(
      "message",
      "Open Wrangler could not remove every private R kernel runtime binding."
    );
    expect(controller.teardownExecutions()).toBe(1);
    expect(transport.dispose()).toBe(disposal);
    await expect(transport.open("frame", pageWindow())).rejects.toThrow("transport is disposed");
  });
});

function testRuntimeFiles(): Readonly<Record<string, string>> {
  return {
    "frame_contract.R": "openwrangler_r_frame_contract <- list()\n",
    "kernel_agent.R": "openwrangler_r_kernel_agent <- list()\n"
  };
}

function openRequest(): Extract<RKernelRequest, { kind: "openSession" }> {
  return {
    transportVersion: R_KERNEL_TRANSPORT_VERSION,
    requestId: openRequestId,
    kind: "openSession",
    payload: { sessionId, variableName: "frame", page: pageWindow() }
  };
}

function pageWindow(sorts: readonly ReturnType<typeof sortRule>[] = []) {
  return {
    rowOffset: 0,
    rowLimit: 100,
    columnOffset: 0,
    columnLimit: 100,
    view: { filters: [], sorts }
  } as const;
}

function emptyView() {
  return { filters: [], sorts: [] } as const;
}

function sortRule() {
  return { column: { id: "r:c:0", name: "value" }, direction: "asc", nulls: "last" } as const;
}

function longDerivedColumnId() {
  const id = `c:step:${"x".repeat(130)}:0`;
  if (Buffer.byteLength(id, "utf8") <= 128) throw new Error("long derived-column fixture is too short");
  return id;
}

function renameStep() {
  return {
    id: "rename-step",
    kind: "renameColumn",
    params: { column: { id: "r:c:0", name: "value" }, newName: "renamed value" }
  } as const;
}

function byExampleStep(): RKernelByExampleStep {
  return {
    id: "by-example-step",
    kind: "byExample",
    params: {
      sourceColumns: [{ id: "r:c:0", name: "value" }],
      newColumn: "derived value",
      examples: [
        { inputs: [1], output: 1 },
        { inputs: [2], output: 2 }
      ]
    }
  };
}

function minimalRenameDiff() {
  return {
    addedRows: 0,
    removedRows: 0,
    addedColumns: [],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  } as const;
}

function minimalFramePage() {
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 1, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
    schema: [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "integer",
        type: "integer",
        nullable: false,
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      }
    ],
    page: {
      offset: 0,
      limit: 100,
      totalRows: 1,
      columnOffset: 0,
      columnLimit: 100,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }]
        }
      ]
    }
  } as const;
}

function minimalByExampleFramePage() {
  const frame = structuredClone(minimalFramePage()) as unknown as {
    shape: { rows: number; columns: number };
    schema: Array<Record<string, unknown>>;
    page: { columnIds: string[]; rows: Array<{ values: unknown[] }> };
  };
  frame.shape.columns = 2;
  frame.schema.push({
    ...frame.schema[0],
    id: "c:step:by-example-step:0",
    name: "derived value",
    position: 1
  });
  frame.page.columnIds.push("c:step:by-example-step:0");
  frame.page.rows[0]?.values.push({ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false });
  return frame;
}

function inspectionWirePage<T extends Readonly<{ schema: unknown }>>(frame: T): Omit<T, "schema"> {
  const { schema: _schema, ...wirePage } = frame;
  return wirePage;
}

function minimalCloneFramePage() {
  const frame = structuredClone(minimalFramePage()) as unknown as {
    shape: { rows: number; columns: number };
    schema: Array<Record<string, unknown>>;
    page: { columnIds: string[]; rows: Array<{ values: unknown[] }> };
  };
  frame.shape.columns = 2;
  frame.schema.push({
    ...frame.schema[0],
    id: "c:step:clone-step:0",
    name: "value copy",
    position: 1
  });
  frame.page.columnIds.push("c:step:clone-step:0");
  frame.page.rows[0]?.values.push({ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false });
  return frame;
}

function minimalTextLengthFramePage() {
  const frame = structuredClone(minimalFramePage()) as unknown as {
    shape: { rows: number; columns: number };
    schema: Array<Record<string, unknown>>;
    page: { columnIds: string[]; rows: Array<{ values: unknown[] }> };
  };
  frame.shape.columns = 2;
  frame.schema.push({
    id: "c:step:text-length-step:0",
    name: "value length",
    position: 1,
    rawType: "integer",
    type: "integer",
    nullable: false,
    semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
  });
  frame.page.columnIds.push("c:step:text-length-step:0");
  frame.page.rows[0]?.values.push({ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false });
  return frame;
}

function minimalLowerFramePage() {
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 1, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
    schema: [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "character",
        type: "string",
        nullable: false,
        semantics: { kind: "character", storageMode: "character", classes: ["character"] }
      }
    ],
    page: {
      offset: 0,
      limit: 100,
      totalRows: 1,
      columnOffset: 0,
      columnLimit: 100,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          values: [{ kind: "string", raw: "mixed", display: "mixed", isNull: false, isNaN: false }]
        }
      ]
    }
  } as const;
}

function minimalCastFloatFramePage() {
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 1, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
    schema: [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "double",
        type: "float",
        nullable: false,
        semantics: { kind: "double", storageMode: "double", classes: ["numeric"] }
      }
    ],
    page: {
      offset: 0,
      limit: 100,
      totalRows: 1,
      columnOffset: 0,
      columnLimit: 100,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          values: [{ kind: "number", raw: "1", display: "1", isNull: false, isNaN: false }]
        }
      ]
    }
  } as const;
}

function minimalProjectedLowerFramePage() {
  const frame = structuredClone(minimalLowerFramePage()) as unknown as {
    shape: { rows: number; columns: number };
    schema: Array<Record<string, unknown>>;
    page: { columnLimit: number };
  };
  frame.shape.columns = 2;
  frame.schema.push({ ...frame.schema[0], id: "r:c:1", name: "other", position: 1 });
  frame.page.columnLimit = 1;
  return frame;
}

function minimalSummary() {
  const exact = { kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false } as const;
  return {
    columnId: "r:c:0",
    column: "value",
    type: "integer",
    rawType: "integer",
    totalCount: 1,
    nullCount: 0,
    nanCount: 0,
    distinctCount: 1,
    numeric: { min: 1, max: 1, mean: 1, median: 1, exactMin: exact, exactMax: exact },
    visualization: { kind: "numeric", bins: [{ min: 1, max: 1, count: 1 }] },
    topValues: [{ value: "1", count: 1 }]
  } as const;
}

function minimalDatasetStats() {
  return {
    missingCells: 0,
    missingRows: 0,
    duplicateRows: 0,
    missingValuesByColumn: [{ column: "value", count: 0 }]
  } as const;
}

function minimalColumnValue() {
  return {
    value: "1",
    count: 1,
    selectionValue: {
      kind: "typedSelection",
      version: 1,
      columnType: "integer",
      cell: { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }
    }
  } as const;
}

function response(request: RKernelRequest, body: Record<string, unknown>) {
  const exportFormats = request.kind === "openSession" && body.kind === "page" ? { exportFormats: ["csv"] } : {};
  return { transportVersion: R_KERNEL_TRANSPORT_VERSION, requestId: request.requestId, ...exportFormats, ...body };
}

function createTransport(
  document: vscode.NotebookDocument,
  ids: readonly string[],
  verifiedSelection?: RNotebookKernelSelectionBinding
): RKernelSessionTransport {
  let index = 0;
  return new RKernelSessionTransport(
    { extensionPath: process.cwd() } as vscode.ExtensionContext,
    document,
    () => {
      const id = ids[index++];
      if (!id) throw new Error("The test exhausted its deterministic IDs.");
      return id;
    },
    "test-owner",
    verifiedSelection
  );
}

function mappedSessions(transport: RKernelSessionTransport): ReadonlyMap<string, Kernel> {
  return (transport as unknown as { sessionKernels: ReadonlyMap<string, Kernel> }).sessionKernels;
}

function invalidateCurrentKernel(transport: RKernelSessionTransport): void {
  (transport as unknown as { invalidateKernel(): void }).invalidateKernel();
}

function cleanupAttempts(
  transport: RKernelSessionTransport,
  kernel: Kernel
): ReadonlyMap<string, Promise<boolean>> | undefined {
  return (
    transport as unknown as {
      cleanupAttempts: WeakMap<Kernel, ReadonlyMap<string, Promise<boolean>>>;
    }
  ).cleanupAttempts.get(kernel);
}

interface ControlledRKernel {
  readonly kernel: Kernel;
  bootstrapExecutions(): number;
  teardownExecutions(): number;
  dispatchExecutions(): number;
  executionTokens(): readonly vscode.CancellationToken[];
  statusListenerCount(): number;
  setStatus(status: KernelStatus): void;
}

function controlledRKernel(
  respond: (request: RKernelRequest) => unknown | Promise<unknown>,
  language = "r",
  bootstrapOutput: () => AsyncIterable<unknown> = emptyOutput,
  teardownOutput: () => AsyncIterable<unknown> = emptyOutput
): ControlledRKernel {
  let bootstrapExecutions = 0;
  let teardownExecutions = 0;
  let dispatchExecutions = 0;
  let status: KernelStatus = "idle";
  const listeners = new Set<(status: KernelStatus) => unknown>();
  const tokens: vscode.CancellationToken[] = [];
  const kernel = {
    language,
    get status() {
      return status;
    },
    onDidChangeStatus(listener: (next: KernelStatus) => unknown) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    executeCode(code: string, token: vscode.CancellationToken) {
      tokens.push(token);
      if (!code.includes("__OPEN_WRANGLER_R_START_")) {
        if (code.includes("remove(list = .__ow_binding")) {
          teardownExecutions += 1;
          return teardownOutput();
        }
        bootstrapExecutions += 1;
        return bootstrapOutput();
      }
      dispatchExecutions += 1;
      return rKernelOutput(code, respond);
    }
  } as unknown as Kernel;
  return {
    kernel,
    bootstrapExecutions: () => bootstrapExecutions,
    teardownExecutions: () => teardownExecutions,
    dispatchExecutions: () => dispatchExecutions,
    executionTokens: () => tokens,
    statusListenerCount: () => listeners.size,
    setStatus(next) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    }
  };
}

async function* emptyOutput(): AsyncIterable<unknown> {}

async function* rKernelOutput(
  code: string,
  respond: (request: RKernelRequest) => unknown | Promise<unknown>
): AsyncIterable<unknown> {
  const marker = code.match(/__OPEN_WRANGLER_R_START_([a-f0-9]{32})__/)?.[1];
  const payload = code.match(/\.__ow_payload <- rawToChar\(jsonlite::base64_dec\("([A-Za-z0-9+/=]+)"\)\)/u)?.[1];
  if (!marker || !payload) throw new Error("The R kernel test could not decode the dispatch frame.");
  const request = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as RKernelRequest;
  const result = await respond(request);
  yield {
    text: [`__OPEN_WRANGLER_R_START_${marker}__`, JSON.stringify(result), `__OPEN_WRANGLER_R_END_${marker}__`].join(
      "\n"
    )
  };
}

function mockKernel(kernel: Kernel, getKernel: () => Promise<Kernel | undefined> = async () => kernel): Jupyter {
  const jupyter = { kernels: { getKernel } } as unknown as Jupyter;
  vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({ activate: async () => jupyter } as never);
  return jupyter;
}

function selectionBinding(
  document: vscode.NotebookDocument,
  jupyter: Jupyter,
  kernel: Kernel,
  dataframeFlavor: "r.data.frame" | "r.tibble" | "r.data.table" = "r.data.frame",
  isInvalidated: () => boolean = () => false
): RNotebookKernelSelectionBinding {
  return {
    notebook: document,
    jupyter,
    kernel,
    variable: { name: "frame", backend: "r", dataframeFlavor },
    isInvalidated,
    dispose: vi.fn()
  };
}

function notebookDocument(): vscode.NotebookDocument {
  return { uri: vscode.Uri.file("/workspace/r-notebook.ipynb"), isClosed: false } as vscode.NotebookDocument;
}

function setOpenNotebookDocuments(...documents: vscode.NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "notebookDocuments", { configurable: true, value: documents });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cancellationSource(): {
  readonly token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
  };
  cancel(): void;
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    },
    cancel() {
      cancelled = true;
      for (const listener of listeners) listener();
    }
  };
}
