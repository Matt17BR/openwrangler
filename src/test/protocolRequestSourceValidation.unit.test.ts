import { describe, expect, it } from "vitest";
import { openWranglerRequestShapes } from "../shared/protocol";
import { isOpenWranglerRequest, isOpenWranglerResponse, isRuntimeRequestEnvelope } from "../shared/protocolValidation";
import { runtimeIdentityForDataBackend } from "../shared/runtimeIdentity";
import { metadata, requests, responses, validateTransportSchema } from "./protocolValidation.fixtures";

const representativeRequests = [...new Map(requests.map((request) => [request.kind, request] as const)).values()];

describe("protocol-v2 request validation", () => {
  it.each(requests.map((request) => [request.kind, request] as const))(
    "accepts a structurally complete %s request",
    (_kind, request) => {
      expect(isOpenWranglerRequest(request)).toBe(true);
      expect(
        isRuntimeRequestEnvelope({
          protocolVersion: 2,
          requestId: `request-${request.kind}`,
          priority: "interactive",
          request
        })
      ).toBe(true);
    }
  );

  it("keeps the generated request-shape catalog complete and deeply frozen", () => {
    expect(openWranglerRequestShapes).toHaveLength(14);
    expect(openWranglerRequestShapes.map(({ kind }) => kind)).toEqual(representativeRequests.map(({ kind }) => kind));
    expect(Object.isFrozen(openWranglerRequestShapes)).toBe(true);
    for (const definition of openWranglerRequestShapes) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.required)).toBe(true);
      expect(Object.isFrozen(definition.optional)).toBe(true);
    }

    const first = openWranglerRequestShapes[0];
    expect(Reflect.set(openWranglerRequestShapes, 0, first)).toBe(false);
    expect(Reflect.set(first, "kind", "changed")).toBe(false);
    expect(Reflect.set(first.required, 0, "changed")).toBe(false);
  });

  it.each(representativeRequests.map((request) => [request.kind, request] as const))(
    "rejects missing required and unknown top-level keys for %s",
    (kind, request) => {
      const definition = openWranglerRequestShapes.find((candidate) => candidate.kind === kind);
      expect(definition).toBeDefined();
      if (definition === undefined) return;

      for (const requiredKey of definition.required) {
        const missingRequired = { ...request } as Record<string, unknown>;
        Reflect.deleteProperty(missingRequired, requiredKey);
        expect(isOpenWranglerRequest(missingRequired)).toBe(false);
      }
      expect(isOpenWranglerRequest({ ...request, unknownTopLevelKey: true })).toBe(false);
    }
  );

  it("requires an exact requested runtime identity for session clones", () => {
    const request = requests.find((candidate) => candidate.kind === "openSession");
    if (!request || request.kind !== "openSession" || !request.cloneFrom) {
      throw new Error("Expected the canonical cloned-session fixture.");
    }
    const { requestedSessionId: _requestedSessionId, ...withoutRequestedSessionId } = request;

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(isOpenWranglerRequest(withoutRequestedSessionId)).toBe(false);
    expect(isOpenWranglerRequest({ ...request, cloneFrom: { sessionId: "", revision: 3 } })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, cloneFrom: { sessionId: "session-1", revision: -1 } })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, cloneFrom: { sessionId: "session-1", revision: 3, extra: true } })).toBe(
      false
    );
  });

  it("keeps host runtime identity outside every protocol-v2 payload", () => {
    const runtimeIdentity = runtimeIdentityForDataBackend("polars");
    const openRequest = requests.find((request) => request.kind === "openSession");
    const openedResponse = responses.find((response) => response.kind === "sessionOpened");
    if (!openRequest || !openedResponse) throw new Error("Expected canonical open fixtures.");

    expect(isOpenWranglerRequest({ ...openRequest, runtimeIdentity })).toBe(false);
    expect(isOpenWranglerResponse({ ...openedResponse, runtimeIdentity })).toBe(false);
    expect(
      isOpenWranglerResponse({
        ...openedResponse,
        metadata: { ...openedResponse.metadata, runtimeIdentity }
      })
    ).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "request-private-runtime-identity",
        priority: "interactive",
        request: { ...openRequest, runtimeIdentity }
      })
    ).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "response-private-runtime-identity",
        response: { ...openedResponse, runtimeIdentity }
      })
    ).toBe(false);
  });

  it("accepts DuckDB as a first-class file backend", () => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source: metadata.source,
        backend: "duckdb",
        mode: "editing",
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(true);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...metadata, backend: "duckdb" } })).toBe(true);
  });

  it("accepts PySpark only for live notebook variables", () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "spark_frame",
      variableName: "spark_frame",
      uri: "file:///workspace/notebook.ipynb"
    };
    const request = {
      kind: "openSession" as const,
      source,
      backend: "pyspark" as const,
      mode: "viewing" as const,
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };
    const sparkMetadata = {
      ...metadata,
      backend: "pyspark" as const,
      mode: "viewing" as const,
      source,
      capabilities: {
        editable: false,
        lazy: true,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      steps: []
    };

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(isOpenWranglerRequest({ ...request, mode: "editing" })).toBe(false);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: sparkMetadata })).toBe(true);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...sparkMetadata, mode: "editing" } })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, source: metadata.source })).toBe(false);
    expect(
      isOpenWranglerRequest({
        ...request,
        source: { kind: "notebookOutput", label: "saved Spark output" }
      })
    ).toBe(false);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...sparkMetadata, source: metadata.source } })).toBe(
      false
    );
  });

  it("keeps identified live R notebook frames valid in either session mode", () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "r_frame",
      variableName: "r_frame",
      uri: "file:///workspace/notebook.ipynb"
    };
    const request = {
      kind: "openSession" as const,
      source,
      backend: "r" as const,
      mode: "viewing" as const,
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };
    const { latestStepInputSchema: _latest, stats: _stats, ...viewingMetadata } = metadata;
    const rMetadata = {
      ...viewingMetadata,
      backend: "r" as const,
      rDataframeFlavor: "r.tibble" as const,
      mode: "viewing" as const,
      source,
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        filter: false,
        sort: true,
        profile: true,
        columnValues: false,
        supportedOperations: ["renameColumn"]
      },
      filterModel: { logic: "and" as const, filters: [], sort: [] },
      steps: []
    };
    const opened = { ...responses[1], metadata: rMetadata, summaries: [] };

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(isOpenWranglerRequest({ ...request, mode: "editing" })).toBe(true);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-editing-open",
        priority: "interactive",
        request: { ...request, mode: "editing" }
      })
    ).toBe(true);
    expect(isOpenWranglerRequest({ ...request, source: metadata.source })).toBe(false);
    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "r-open", response: opened })).toBe(true);
    for (const invalidSource of [
      { kind: "file" as const, label: "frame.csv", path: "/workspace/frame.csv" },
      { kind: "notebookOutput" as const, label: "saved R output" }
    ]) {
      const invalidOpened = { ...opened, metadata: { ...rMetadata, source: invalidSource } };
      expect(isOpenWranglerResponse(invalidOpened)).toBe(false);
      expect(
        validateTransportSchema({ protocolVersion: 2, requestId: `r-${invalidSource.kind}`, response: invalidOpened })
      ).toBe(false);
    }
    const { rDataframeFlavor: _rDataframeFlavor, ...rMetadataWithoutFlavor } = rMetadata;
    const rWithoutFlavor = { ...opened, metadata: rMetadataWithoutFlavor };
    expect(isOpenWranglerResponse(rWithoutFlavor)).toBe(false);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "r-no-flavor", response: rWithoutFlavor })).toBe(
      false
    );
    const editingOpened = { ...opened, metadata: { ...rMetadata, mode: "editing" as const } };
    expect(isOpenWranglerResponse(editingOpened)).toBe(true);
    expect(
      validateTransportSchema({ protocolVersion: 2, requestId: "r-editing-opened", response: editingOpened })
    ).toBe(true);
    const nonRWithFlavor = { ...responses[1], metadata: { ...metadata, rDataframeFlavor: "r.tibble" as const } };
    expect(isOpenWranglerResponse(nonRWithFlavor)).toBe(false);
    expect(
      validateTransportSchema({ protocolVersion: 2, requestId: "python-r-flavor", response: nonRWithFlavor })
    ).toBe(false);
    const insertableNotebookOpened = {
      ...opened,
      metadata: {
        ...rMetadata,
        capabilities: { ...rMetadata.capabilities, notebookInsert: true, documentInsert: false }
      }
    };
    expect(isOpenWranglerResponse(insertableNotebookOpened)).toBe(true);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-notebook-insertion",
        response: insertableNotebookOpened
      })
    ).toBe(true);
    const notebookWithDocumentInsertion = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, documentInsert: true } }
    };
    expect(isOpenWranglerResponse(notebookWithDocumentInsertion)).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-notebook-wrong-insertion",
        response: notebookWithDocumentInsertion
      })
    ).toBe(false);
  });

  it("accepts an identified R document variable only with its canonical source URI", () => {
    const source = {
      kind: "documentVariable" as const,
      label: "orders",
      variableName: "orders",
      uri: "file:///workspace/analysis.R"
    };
    const request = {
      kind: "openSession" as const,
      source,
      backend: "r" as const,
      mode: "editing" as const,
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };
    const rMetadata = {
      ...metadata,
      backend: "r" as const,
      rDataframeFlavor: "r.data.table" as const,
      source,
      capabilities: { ...metadata.capabilities, documentInsert: true }
    };
    const opened = { ...responses[1], metadata: rMetadata };
    const requestEnvelope = (candidate: unknown) => ({
      protocolVersion: 2,
      requestId: "r-document-open",
      priority: "interactive",
      request: candidate
    });

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(validateTransportSchema(requestEnvelope(request))).toBe(true);
    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "r-document-opened", response: opened })).toBe(
      true
    );

    const remoteSource = {
      ...source,
      uri: "vscode-remote://ssh-remote+workstation/workspace/analysis.R"
    };
    expect(isOpenWranglerRequest({ ...request, source: remoteSource })).toBe(true);
    expect(validateTransportSchema(requestEnvelope({ ...request, source: remoteSource }))).toBe(true);
    const encodedSource = { ...source, uri: "file:///workspace/r%C3%A9sum%C3%A9%20analysis.R" };
    expect(isOpenWranglerRequest({ ...request, source: encodedSource })).toBe(true);
    expect(validateTransportSchema(requestEnvelope({ ...request, source: encodedSource }))).toBe(true);

    const documentInsertionDisabled = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, documentInsert: false } }
    };
    expect(isOpenWranglerResponse(documentInsertionDisabled)).toBe(true);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-document-insertion-disabled",
        response: documentInsertionDisabled
      })
    ).toBe(true);
    const malformedDocumentInsertion = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, documentInsert: "yes" } }
    };
    expect(isOpenWranglerResponse(malformedDocumentInsertion)).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-document-insertion-malformed",
        response: malformedDocumentInsertion
      })
    ).toBe(false);
    const documentWithNotebookInsertion = {
      ...opened,
      metadata: { ...rMetadata, capabilities: { ...rMetadata.capabilities, notebookInsert: true } }
    };
    expect(isOpenWranglerResponse(documentWithNotebookInsertion)).toBe(false);
    expect(
      validateTransportSchema({
        protocolVersion: 2,
        requestId: "r-document-wrong-insertion",
        response: documentWithNotebookInsertion
      })
    ).toBe(false);

    const invalidSources: unknown[] = [
      { kind: "documentVariable", label: "orders", uri: source.uri },
      { kind: "documentVariable", label: "orders", variableName: "", uri: source.uri },
      { kind: "documentVariable", label: "orders", variableName: "orders" },
      { ...source, uri: "" },
      { ...source, uri: "/workspace/analysis.R" },
      { ...source, uri: "FILE:///workspace/analysis.R" },
      { ...source, uri: "file:///workspace/analysis data.R" },
      { ...source, uri: "file:///workspace/%zz.R" },
      { ...source, path: "/workspace/analysis.R" },
      { ...source, importOptions: {} }
    ];
    for (const invalidSource of invalidSources) {
      const invalidRequest = { ...request, source: invalidSource };
      const invalidOpened = { ...opened, metadata: { ...rMetadata, source: invalidSource } };
      expect(isOpenWranglerRequest(invalidRequest)).toBe(false);
      expect(validateTransportSchema(requestEnvelope(invalidRequest))).toBe(false);
      expect(isOpenWranglerResponse(invalidOpened)).toBe(false);
      expect(
        validateTransportSchema({ protocolVersion: 2, requestId: "invalid-r-document-opened", response: invalidOpened })
      ).toBe(false);
    }

    const sparkRequest = { ...request, backend: "pyspark" as const, mode: "viewing" as const };
    expect(isOpenWranglerRequest(sparkRequest)).toBe(false);
    expect(validateTransportSchema(requestEnvelope(sparkRequest))).toBe(false);
    const { rDataframeFlavor: _rDataframeFlavor, ...metadataWithoutRFlavor } = rMetadata;
    const sparkOpened = {
      ...opened,
      metadata: { ...metadataWithoutRFlavor, backend: "pyspark" as const, mode: "viewing" as const }
    };
    expect(isOpenWranglerResponse(sparkOpened)).toBe(false);
    expect(
      validateTransportSchema({ protocolVersion: 2, requestId: "spark-document-opened", response: sparkOpened })
    ).toBe(false);
  });

  it("accepts an active R-session variable without notebook or document provenance", () => {
    const source = {
      kind: "rInteractiveVariable" as const,
      label: "orders",
      variableName: "orders"
    };
    const request = {
      kind: "openSession" as const,
      source,
      backend: "r" as const,
      mode: "editing" as const,
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };
    const opened = {
      ...responses[1],
      metadata: {
        ...metadata,
        backend: "r" as const,
        rDataframeFlavor: "r.tibble" as const,
        source,
        capabilities: { ...metadata.capabilities, notebookInsert: false, documentInsert: false }
      }
    };
    const envelope = { protocolVersion: 2, requestId: "r-interactive-open", priority: "interactive", request };

    expect(isOpenWranglerRequest(request)).toBe(true);
    expect(validateTransportSchema(envelope)).toBe(true);
    expect(isOpenWranglerResponse(opened)).toBe(true);
    expect(validateTransportSchema({ protocolVersion: 2, requestId: "r-interactive-opened", response: opened })).toBe(
      true
    );

    for (const invalidSource of [
      { kind: "rInteractiveVariable", label: "orders" },
      { ...source, variableName: "" },
      { ...source, uri: "file:///workspace/analysis.R" },
      { ...source, path: "/workspace/analysis.R" },
      { ...source, importOptions: {} }
    ]) {
      expect(isOpenWranglerRequest({ ...request, source: invalidSource })).toBe(false);
      expect(validateTransportSchema({ ...envelope, request: { ...request, source: invalidSource } })).toBe(false);
    }
    const { backend: _rBackend, ...missingBackend } = request;
    for (const candidate of [
      missingBackend,
      ...(["pandas", "polars", "duckdb", "pyspark"] as const).map((backend) => ({ ...request, backend }))
    ]) {
      expect(isOpenWranglerRequest(candidate)).toBe(false);
      expect(validateTransportSchema({ ...envelope, request: candidate })).toBe(false);
    }
  });
});
