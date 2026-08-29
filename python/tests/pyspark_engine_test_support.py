from __future__ import annotations

import threading
from datetime import datetime
from types import SimpleNamespace
from typing import Any

import pytest
from python.tests.pyspark_connect_test_support import spark_session as _shared_spark_session

from openwrangler_runtime.engines import PySparkEngine
from openwrangler_runtime.session_access import SessionRequestAdmission

spark_session = _shared_spark_session


@pytest.fixture
def sample_frame(spark_session: Any) -> Any:
    return spark_session.createDataFrame(
        [
            ("Beta", 2.0, "x", True, datetime(2026, 1, 1, 12, 0)),
            ("alpha", None, "y", False, datetime(2026, 1, 2, 12, 0)),
            ("ALPHA", float("nan"), "y", None, None),
            ("ÄLPHA", -1.0, "x", True, datetime(2026, 1, 3, 12, 0)),
            ("Beta", 2.0, "x", True, datetime(2026, 1, 1, 12, 0)),
        ],
        "name string, amount double, group_name string, flag boolean, happened timestamp",
    ).repartition(2)


def _open_engine(frame: Any, token: str = "test") -> tuple[PySparkEngine, Any]:
    engine = PySparkEngine()
    assert engine.detect(frame)
    engine.validate_internal_row_id_namespace(frame)
    engine.validate_column_addressability(frame)
    return engine, engine.ensure_row_ids(frame, token)


def _empty_view() -> dict[str, Any]:
    return {"logic": "and", "filters": [], "sort": []}


class _FakeSparkContext:
    def __init__(
        self,
        properties: dict[str, str] | None = None,
        *,
        fail_job_group_after_update: bool = False,
    ) -> None:
        self.properties = dict(properties or {})
        self.groups: list[str] = []
        self.fail_job_group_after_update = fail_job_group_after_update

    def getLocalProperty(self, key: str) -> str | None:
        return self.properties.get(key)

    def setLocalProperty(self, key: str, value: str | None) -> None:
        if value is None:
            self.properties.pop(key, None)
        else:
            self.properties[key] = value

    def setJobGroup(
        self,
        group_id: str,
        description: str,
        interruptOnCancel: bool = False,
    ) -> None:
        self.groups.append(group_id)
        self.setLocalProperty("spark.job.description", description)
        self.setLocalProperty("spark.jobGroup.id", group_id)
        self.setLocalProperty("spark.job.interruptOnCancel", str(interruptOnCancel).lower())
        if self.fail_job_group_after_update:
            raise RuntimeError("job-group setup failed")


class _ThreadLocalFakeSparkContext:
    def __init__(self) -> None:
        self._local = threading.local()
        self._groups_lock = threading.Lock()
        self.groups: list[tuple[int, str]] = []

    @property
    def properties(self) -> dict[str, str]:
        properties = getattr(self._local, "properties", None)
        if properties is None:
            properties = {}
            self._local.properties = properties
        return properties

    def getLocalProperty(self, key: str) -> str | None:
        return self.properties.get(key)

    def setLocalProperty(self, key: str, value: str | None) -> None:
        if value is None:
            self.properties.pop(key, None)
        else:
            self.properties[key] = value

    def setJobGroup(
        self,
        group_id: str,
        description: str,
        interruptOnCancel: bool = False,
    ) -> None:
        self.setLocalProperty("spark.job.description", description)
        self.setLocalProperty("spark.jobGroup.id", group_id)
        self.setLocalProperty("spark.job.interruptOnCancel", str(interruptOnCancel).lower())
        with self._groups_lock:
            self.groups.append((threading.get_ident(), group_id))


class _StoppedSparkContext:
    def __init__(self) -> None:
        self.ownership_calls = 0

    def getLocalProperty(self, _key: str) -> str | None:
        self.ownership_calls += 1
        raise RuntimeError("Spark context is stopped")


class _RestoreFailingSparkContext:
    def __init__(self) -> None:
        self.ownership_calls = 0
        self._request_group_set = False

    def getLocalProperty(self, _key: str) -> str | None:
        self.ownership_calls += 1
        return None

    def setJobGroup(
        self,
        _group_id: str,
        _description: str,
        interruptOnCancel: bool = False,
    ) -> None:
        del interruptOnCancel
        self.ownership_calls += 1
        self._request_group_set = True

    def setLocalProperty(self, _key: str, _value: str | None) -> None:
        self.ownership_calls += 1
        if self._request_group_set:
            raise RuntimeError("Spark properties cannot be restored")


class _FakeClassicFrame:
    def __init__(self, spark_context: Any) -> None:
        self.sparkSession = SimpleNamespace(sparkContext=spark_context)


class _ClosablePySparkSession:
    def __init__(self, session_id: str, engine: PySparkEngine) -> None:
        self.session_id = session_id
        self.engine = engine
        self.disposed = False
        self.access = SessionRequestAdmission()

    def dispose(self) -> None:
        self.disposed = True
        self.engine.close()


class _FailureClassifyingSession:
    def __init__(self, session_id: str, engine: PySparkEngine, live_source_value: Any | None = None) -> None:
        self.session_id = session_id
        self.engine = engine
        self.backend = "pyspark"
        self.source = {"kind": "notebookVariable", "variableName": "orders", "label": "orders"}
        self.live_source_value = live_source_value
        self.page_cache = {"confirmed": object()}
        self.page_cache_bytes = 128
        self.disposed = False

    def clear_page_cache(self) -> None:
        self.page_cache.clear()
        self.page_cache_bytes = 0
