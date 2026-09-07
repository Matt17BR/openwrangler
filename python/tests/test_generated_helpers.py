from __future__ import annotations

from typing import Any

import pytest

from openwrangler_runtime.generated_helpers import select_generated_helpers


def test_generated_helper_reachability_preserves_decorated_source() -> None:
    source = """import math as numbers
from functools import wraps as copy_metadata
DEFAULT = 2.75

def decorate(function):
    @copy_metadata(function)
    def wrapped(value: float = DEFAULT) -> float:
        return function(value) + 1
    return wrapped

@decorate
def helper(value: float = DEFAULT) -> float:
    return numbers.floor(value)
"""
    selected = select_generated_helpers(source, "def clean_data(df):\n    return helper()\n")
    namespace: dict[str, Any] = {}
    exec(selected, namespace)

    assert selected.index("import math as numbers") < selected.index("@decorate")
    assert "from functools import wraps as copy_metadata" in selected
    assert "DEFAULT = 2.75" in selected
    assert "@copy_metadata(function)" in selected
    assert namespace["helper"]() == 3
    assert namespace["helper"].__name__ == "helper"


@pytest.mark.parametrize(
    "source",
    [
        "import math as duplicate, cmath as duplicate\n",
        "import math as duplicate\nimport cmath as duplicate\n",
        "from math import *\n",
        "from __future__ import annotations\n",
        "FIRST, SECOND = (1, 2)\n",
        "VALUE: int = 1\n",
        "class Helper:\n    pass\n",
        "async def helper():\n    return None\n",
    ],
)
def test_generated_helper_catalog_rejects_unsupported_source(source: str) -> None:
    with pytest.raises(RuntimeError):
        select_generated_helpers(source, "def clean_data(df):\n    return df\n")


def test_generated_helper_selection_keeps_source_libraries_independent() -> None:
    sources = [f"def helper():\n    return {value!r}\n" for value in ("first", "second", "third")]
    for source in [*sources, sources[0], sources[1]]:
        selected = select_generated_helpers(source, "def clean_data(df):\n    return helper()\n")
        assert selected == source.rstrip()
        assert select_generated_helpers(source, "def clean_data(df):\n    return df\n") == ""
