from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .limits import MAX_VIEW_VALUE_TEXT_CHARACTERS
from .operations import OperationError, validate_step

PROTOCOL_VERSION = 2
MAX_PAGE_LIMIT = 10_000
MAX_COLUMN_LIMIT = 256
REQUEST_PRIORITIES = {"interactive", "background"}
SOURCE_ALLOWED_FIELDS = {"kind", "label", "path", "uri", "variableName", "importOptions"}
_ECMASCRIPT_TRIM_CHARACTERS = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003"
    "\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
REQUEST_FIELDS: dict[str, tuple[str, ...]] = {
    "initialize": (),
    "openSession": ("source", "pageSize", "columnOffset", "columnLimit"),
    "getPage": (
        "sessionId",
        "revision",
        "viewRequestId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit",
        "filterModel",
    ),
    "getSummary": ("sessionId", "revision", "viewRequestId", "filterModel"),
    "getDatasetStats": ("sessionId", "revision", "viewRequestId", "filterModel"),
    "getColumnValues": ("sessionId", "revision", "viewRequestId", "column", "filterModel", "limit"),
    "previewStep": ("sessionId", "revision", "step", "offset", "limit", "columnOffset", "columnLimit"),
    "inspectStep": ("sessionId", "revision", "stepId", "offset", "limit", "columnOffset", "columnLimit"),
    "applyDraft": ("sessionId", "revision", "offset", "limit", "columnOffset", "columnLimit"),
    "discardDraft": ("sessionId", "revision", "offset", "limit", "columnOffset", "columnLimit"),
    "undoStep": ("sessionId", "revision", "offset", "limit", "columnOffset", "columnLimit"),
    "exportData": ("sessionId", "revision", "path", "options"),
    "closeSession": ("sessionId", "revision"),
    "cancelRequest": ("targetRequestId",),
}
REQUEST_ALLOWED_FIELDS: dict[str, set[str]] = {
    "initialize": {"kind"},
    "openSession": {
        "kind",
        "source",
        "requestedSessionId",
        "cloneFrom",
        "backend",
        "mode",
        "pageSize",
        "columnOffset",
        "columnLimit",
    },
    "getPage": {
        "kind",
        "sessionId",
        "revision",
        "viewRequestId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit",
        "filterModel",
    },
    "getSummary": {"kind", "sessionId", "revision", "viewRequestId", "filterModel", "columnIds"},
    "getDatasetStats": {"kind", "sessionId", "revision", "viewRequestId", "filterModel"},
    "getColumnValues": {
        "kind",
        "sessionId",
        "revision",
        "viewRequestId",
        "column",
        "filterModel",
        "search",
        "limit",
    },
    "previewStep": {
        "kind",
        "sessionId",
        "revision",
        "step",
        "replaceStepId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit",
    },
    "inspectStep": {
        "kind",
        "sessionId",
        "revision",
        "stepId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit",
    },
    "applyDraft": {"kind", "sessionId", "revision", "offset", "limit", "columnOffset", "columnLimit"},
    "discardDraft": {"kind", "sessionId", "revision", "offset", "limit", "columnOffset", "columnLimit"},
    "undoStep": {"kind", "sessionId", "revision", "offset", "limit", "columnOffset", "columnLimit"},
    "exportData": {
        "kind",
        "sessionId",
        "revision",
        "path",
        "options",
        "targetIdentity",
    },
    "closeSession": {"kind", "sessionId", "revision"},
    "cancelRequest": {"kind", "targetRequestId"},
}


class ProtocolError(ValueError):
    """Raised when a transport envelope or request violates protocol v2."""


def decode_request(value: Any) -> dict[str, Any]:
    request = _mapping(value, "request")
    kind = request.get("kind")
    if not isinstance(kind, str) or kind not in REQUEST_FIELDS:
        raise ProtocolError(f"Unsupported request kind: {kind!r}")
    missing = [field for field in REQUEST_FIELDS[kind] if field not in request]
    if missing:
        raise ProtocolError(f"{kind} request is missing required fields: {', '.join(missing)}")
    unexpected = set(request) - REQUEST_ALLOWED_FIELDS[kind]
    if unexpected:
        raise ProtocolError(f"{kind} request contains unknown fields: {', '.join(sorted(unexpected))}")

    if "sessionId" in request and not isinstance(request["sessionId"], str):
        raise ProtocolError("sessionId must be a string.")
    if "revision" in request and not _is_non_negative_integer(request["revision"]):
        raise ProtocolError("revision must be a non-negative integer.")
    if "viewRequestId" in request and (not isinstance(request["viewRequestId"], str) or not request["viewRequestId"]):
        raise ProtocolError("viewRequestId must be a non-empty string.")
    if "stepId" in request and (not isinstance(request["stepId"], str) or not request["stepId"]):
        raise ProtocolError("stepId must be a non-empty string.")
    for field in ("pageSize", "limit"):
        if field in request and (not _is_non_negative_integer(request[field]) or request[field] < 1):
            raise ProtocolError(f"{field} must be a positive integer.")
        if field in request and request[field] > MAX_PAGE_LIMIT:
            if kind == "inspectStep":
                raise ProtocolError(f"inspectStep limit must not exceed {MAX_PAGE_LIMIT}.")
            raise ProtocolError(f"{field} must not exceed {MAX_PAGE_LIMIT}.")
    if "columnOffset" in request and not _is_non_negative_integer(request["columnOffset"]):
        raise ProtocolError("columnOffset must be a non-negative integer.")
    if "columnLimit" in request and (
        not _is_non_negative_integer(request["columnLimit"])
        or request["columnLimit"] < 1
        or request["columnLimit"] > MAX_COLUMN_LIMIT
    ):
        raise ProtocolError(f"columnLimit must be an integer between 1 and {MAX_COLUMN_LIMIT}.")
    if "offset" in request and not _is_non_negative_integer(request["offset"]):
        raise ProtocolError("offset must be a non-negative integer.")
    if "filterModel" in request:
        model = _mapping(request["filterModel"], "filterModel")
        if not isinstance(model.get("filters"), list) or not isinstance(model.get("sort"), list):
            raise ProtocolError("filterModel must contain filters and sort arrays.")
        _validate_view_filter_text(model)
        sort_columns: set[str] = set()
        for index, value in enumerate(model["sort"]):
            rule = _mapping(value, f"filterModel.sort[{index}]")
            column = rule.get("column")
            if not isinstance(column, str) or not column:
                raise ProtocolError(f"filterModel.sort[{index}].column must be a non-empty string.")
            if column in sort_columns:
                raise ProtocolError("filterModel.sort contains duplicate columns.")
            sort_columns.add(column)
    if kind == "getSummary" and "columnIds" in request:
        column_ids = request["columnIds"]
        if (
            not isinstance(column_ids, list)
            or not column_ids
            or any(not isinstance(column_id, str) or not column_id for column_id in column_ids)
            or len(set(column_ids)) != len(column_ids)
        ):
            raise ProtocolError("columnIds must be a non-empty array of unique non-empty strings.")
    if kind == "openSession":
        source = _mapping(request["source"], "source")
        unexpected_source_fields = set(source) - SOURCE_ALLOWED_FIELDS
        if unexpected_source_fields:
            raise ProtocolError(f"source contains unknown fields: {', '.join(sorted(unexpected_source_fields))}")
        if source.get("kind") not in {"file", "notebookVariable", "notebookOutput"}:
            raise ProtocolError("source.kind is not supported.")
        if not isinstance(source.get("label"), str) or not source["label"]:
            raise ProtocolError("source.label must be a non-empty string.")
        for field in ("path", "uri", "variableName"):
            if field in source and not isinstance(source[field], str):
                raise ProtocolError(f"source.{field} must be a string.")
        decoded_source = dict(source)
        if "importOptions" in source:
            decoded_source["importOptions"] = _validate_import_options(source["importOptions"], source)
        request = dict(request)
        request["source"] = decoded_source
        backend = request.get("backend")
        if backend not in {None, "pandas", "polars", "duckdb", "pyspark"}:
            raise ProtocolError("backend must be pandas, polars, duckdb, or pyspark.")
        if backend == "pyspark" and source.get("kind") != "notebookVariable":
            raise ProtocolError("The pyspark backend supports only live notebookVariable sources.")
        if backend == "pyspark" and request.get("mode") not in {None, "viewing"}:
            raise ProtocolError("The pyspark backend supports only viewing mode.")
        if request.get("mode") not in {None, "viewing", "editing"}:
            raise ProtocolError("mode must be viewing or editing.")
        requested_session_id = request.get("requestedSessionId")
        if requested_session_id is not None and (not isinstance(requested_session_id, str) or not requested_session_id):
            raise ProtocolError("requestedSessionId must be a non-empty string.")
        clone_from = request.get("cloneFrom")
        if clone_from is not None:
            clone = _mapping(clone_from, "cloneFrom")
            if set(clone) != {"sessionId", "revision"}:
                raise ProtocolError("cloneFrom must contain exactly sessionId and revision.")
            if not isinstance(clone.get("sessionId"), str) or not clone["sessionId"]:
                raise ProtocolError("cloneFrom.sessionId must be a non-empty string.")
            revision = clone.get("revision")
            if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
                raise ProtocolError("cloneFrom.revision must be a non-negative integer.")
            if requested_session_id is None:
                raise ProtocolError("cloneFrom requires requestedSessionId.")
            request["cloneFrom"] = dict(clone)
    if kind == "previewStep":
        step = _mapping(request["step"], "step")
        try:
            request = dict(request)
            request["step"] = validate_step(step)
        except OperationError as error:
            raise ProtocolError(str(error)) from error
        if "replaceStepId" in request and (
            not isinstance(request["replaceStepId"], str) or not request["replaceStepId"]
        ):
            raise ProtocolError("replaceStepId must be a non-empty string.")
    if kind == "exportData":
        if not isinstance(request["path"], str) or not request["path"]:
            raise ProtocolError("path must be a non-empty string.")
        export_options = _validate_export_options(request["options"])
        target_identity = _mapping(request.get("targetIdentity"), "targetIdentity")
        unexpected_identity = set(target_identity) - {"device", "inode"}
        if unexpected_identity or set(target_identity) != {"device", "inode"}:
            raise ProtocolError("targetIdentity must contain exactly device and inode.")
        request = dict(request)
        request["options"] = export_options
        request["targetIdentity"] = {
            "device": _filesystem_identity_component(target_identity["device"], "targetIdentity.device"),
            "inode": _filesystem_identity_component(target_identity["inode"], "targetIdentity.inode"),
        }
        if request["targetIdentity"] == {"device": "0", "inode": "0"}:
            raise ProtocolError("targetIdentity must be usable.")
    return dict(request)


def _filesystem_identity_component(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 39:
        raise ProtocolError(f"{label} must be a canonical unsigned 128-bit decimal string.")
    if value != "0" and (value[0] == "0" or not value.isascii() or not value.isdecimal()):
        raise ProtocolError(f"{label} must be a canonical unsigned 128-bit decimal string.")
    if value == "0":
        return value
    if int(value, 10) > (1 << 128) - 1:
        raise ProtocolError(f"{label} must be a canonical unsigned 128-bit decimal string.")
    return value


def decode_envelope(value: Any) -> tuple[str, str, dict[str, Any]]:
    envelope = _mapping(value, "envelope")
    unexpected = set(envelope) - {"protocolVersion", "requestId", "priority", "request"}
    if unexpected:
        raise ProtocolError(f"Envelope contains unknown fields: {', '.join(sorted(unexpected))}")
    if envelope.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolError(
            f"Unsupported protocol version {envelope.get('protocolVersion')!r}; expected {PROTOCOL_VERSION}."
        )
    request_id = envelope.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        raise ProtocolError("requestId must be a non-empty string.")
    priority = envelope.get("priority")
    if priority not in REQUEST_PRIORITIES:
        raise ProtocolError("priority must be interactive or background.")
    return request_id, str(priority), decode_request(envelope.get("request"))


def response_envelope(request_id: str, response: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "response": dict(response),
    }


def error_response(
    message: str,
    *,
    code: str = "runtime_error",
    detail: str | None = None,
    recoverable: bool = True,
    session_id: str | None = None,
) -> dict[str, Any]:
    response: dict[str, Any] = {
        "kind": "error",
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    if detail:
        response["detail"] = detail
    if session_id:
        response["sessionId"] = session_id
    return response


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError(f"{label} must be a JSON object.")
    return value


def _validate_view_filter_text(model: Mapping[str, Any]) -> None:
    for filter_index, filter_value in enumerate(model["filters"]):
        if not isinstance(filter_value, Mapping):
            continue
        predicates = filter_value.get("predicates")
        if isinstance(predicates, list):
            for predicate_index, predicate_value in enumerate(predicates):
                if not isinstance(predicate_value, Mapping):
                    continue
                for key in ("value", "secondValue"):
                    if key in predicate_value:
                        _validate_view_value_text(
                            predicate_value[key],
                            f"filterModel.filters[{filter_index}].predicates[{predicate_index}].{key}",
                        )
        value_filter = filter_value.get("valueFilter")
        if not isinstance(value_filter, Mapping):
            continue
        selected_values = value_filter.get("selectedValues")
        if isinstance(selected_values, list):
            for value_index, selected_value in enumerate(selected_values):
                _validate_view_value_text(
                    selected_value,
                    f"filterModel.filters[{filter_index}].valueFilter.selectedValues[{value_index}]",
                )


def _validate_view_value_text(value: Any, label: str) -> None:
    if isinstance(value, str) and len(value) > MAX_VIEW_VALUE_TEXT_CHARACTERS:
        raise ProtocolError(f"{label} must not exceed {MAX_VIEW_VALUE_TEXT_CHARACTERS:,} Unicode code points.")


def _is_non_negative_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _validate_import_options(value: Any, source: Mapping[str, Any]) -> dict[str, Any]:
    options = _mapping(value, "source.importOptions")
    allowed = {"delimiter", "encoding", "quoteChar", "hasHeader", "sheetName", "sheetIndex"}
    unexpected = set(options) - allowed
    if unexpected:
        raise ProtocolError(f"source.importOptions contains unknown fields: {', '.join(sorted(unexpected))}")

    for field in ("delimiter", "quoteChar"):
        if field in options and (
            not isinstance(options[field], str) or len(options[field]) != 1 or 0xD800 <= ord(options[field]) <= 0xDFFF
        ):
            raise ProtocolError(f"source.importOptions.{field} must contain exactly one Unicode code point.")
    if "encoding" in options and not _is_non_empty_trimmed_string(options["encoding"]):
        raise ProtocolError("source.importOptions.encoding must be a non-empty string.")
    if "hasHeader" in options and not isinstance(options["hasHeader"], bool):
        raise ProtocolError("source.importOptions.hasHeader must be a boolean.")
    if "sheetName" in options and not _is_non_empty_trimmed_string(options["sheetName"]):
        raise ProtocolError("source.importOptions.sheetName must be a non-empty string.")
    if "sheetIndex" in options and not _is_safe_non_negative_integer(options["sheetIndex"]):
        raise ProtocolError("source.importOptions.sheetIndex must be a non-negative safe integer.")
    if "sheetName" in options and "sheetIndex" in options:
        raise ProtocolError("source.importOptions must contain only one of sheetName or sheetIndex.")
    excel_fields = {"sheetName", "sheetIndex"} & options.keys()
    delimited_fields = {"delimiter", "encoding", "quoteChar", "hasHeader"} & options.keys()
    if excel_fields and delimited_fields:
        raise ProtocolError("source.importOptions must not mix Excel selectors with delimited-file options.")
    if not options:
        return {}
    if source.get("kind") != "file":
        raise ProtocolError("source.importOptions may contain values only for file sources.")
    extension = _source_extension(source)
    if extension in {"xlsx", "xls"} and delimited_fields:
        raise ProtocolError("source.importOptions contains delimited-file values for an Excel source.")
    if extension in {"csv", "tsv"} and excel_fields:
        raise ProtocolError("source.importOptions contains Excel values for a delimited-file source.")
    if extension not in {"xlsx", "xls", "csv", "tsv"}:
        raise ProtocolError("source.importOptions is not supported for this file format.")
    normalized = dict(options)
    if "sheetIndex" in normalized:
        normalized["sheetIndex"] = int(normalized["sheetIndex"])
    return normalized


def _validate_export_options(value: Any) -> dict[str, Any]:
    options = _mapping(value, "options")
    format_name = options.get("format")
    if format_name == "csv":
        required = {"format", "delimiter", "quoteChar", "encoding", "header"}
        allowed = required | {"rowAxisPolicy"}
    elif format_name == "parquet":
        required = {"format"}
        allowed = required | {"rowAxisPolicy"}
    else:
        raise ProtocolError("options.format must be csv or parquet.")
    missing = required - options.keys()
    if missing:
        raise ProtocolError(f"options is missing required fields: {', '.join(sorted(missing))}")
    unexpected = set(options) - allowed
    if unexpected:
        raise ProtocolError(
            f"options contains fields that are invalid for {format_name}: {', '.join(sorted(unexpected))}"
        )
    if format_name == "csv":
        for field in ("delimiter", "quoteChar"):
            field_value = options[field]
            if (
                not isinstance(field_value, str)
                or len(field_value) != 1
                or field_value in {"\0", "\r", "\n"}
                or 0xD800 <= ord(field_value) <= 0xDFFF
            ):
                raise ProtocolError(
                    f"options.{field} must contain exactly one non-NUL, non-line-break Unicode code point."
                )
        if options["delimiter"] == options["quoteChar"]:
            raise ProtocolError("options.delimiter and options.quoteChar must differ.")
        if not _is_non_empty_trimmed_string(options["encoding"]) or len(options["encoding"]) > 64:
            raise ProtocolError("options.encoding must be a non-empty string of at most 64 Unicode code points.")
        if not isinstance(options["header"], bool):
            raise ProtocolError("options.header must be a boolean.")
    if "rowAxisPolicy" in options:
        row_axis_policy = options["rowAxisPolicy"]
        if not isinstance(row_axis_policy, str) or row_axis_policy not in {"preserve", "omit"}:
            raise ProtocolError("options.rowAxisPolicy must be preserve or omit.")
    return dict(options)


def _is_non_empty_trimmed_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip(_ECMASCRIPT_TRIM_CHARACTERS))


def _is_safe_non_negative_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return 0 <= value <= 9_007_199_254_740_991
    if isinstance(value, float):
        return value.is_integer() and 0 <= value <= 9_007_199_254_740_991
    return False


def _source_extension(source: Mapping[str, Any]) -> str:
    path = source.get("path")
    uri = source.get("uri")
    label = source.get("label")
    if isinstance(path, str) and path:
        location = path
        is_uri = False
    elif isinstance(uri, str) and uri:
        location = uri
        is_uri = True
    elif isinstance(label, str) and label:
        location = label
        is_uri = False
    else:
        return ""
    pathname = (location.split("?", 1)[0].split("#", 1)[0] if is_uri else location).replace("\\", "/")
    filename = pathname.rsplit("/", 1)[-1]
    separator = filename.rfind(".")
    return filename[separator + 1 :].lower() if separator > 0 else ""
