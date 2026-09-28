from __future__ import annotations

import pytest
from generated_code_test_support import assert_readable_python

PLAN = [{"id": "s1", "kind": "sortRows", "params": {}}, {"id": "s2", "kind": "upperText", "params": {}}]

READABLE = '''def clean_data(df):
    import pandas as pd

    def is_text(column):
        """Return whether a column holds only text and missing values."""
        return pd.api.types.is_string_dtype(column.dtype)

    if not is_text(df["name"]):
        raise TypeError("Column 'name' is not text.")

    # Sort rows
    df = df.sort_values("units", kind="stable")

    # Uppercase
    df = df.assign(name=df["name"].str.upper())
    return df
'''


def test_readable_code_passes() -> None:
    assert_readable_python(READABLE, PLAN, max_lines=20)


@pytest.mark.parametrize(
    ("code", "message"),
    [
        (READABLE.replace("is_text", "_ow_is_text"), "private-looking name"),
        (
            READABLE.replace("df = df.sort", "_sort_0 = df.sort").replace(
                "# Uppercase", "df = _sort_0\n\n    # Uppercase"
            ),
            "private-looking name",
        ),
        (READABLE.replace("def clean_data", "x = 1\n\n\ndef clean_data"), "only its entry function"),
        (
            READABLE.replace('        """Return whether a column holds only text and missing values."""\n', ""),
            "one-line docstring",
        ),
        (READABLE.replace("missing values.", "missing\n        values."), "one-line docstring"),
        (READABLE.replace("import pandas as pd", "import pandas as pd\n    import numpy as np"), "without using it"),
        (
            READABLE.replace(
                '    if not is_text(df["name"]):\n        raise TypeError("Column \'name\' is not text.")\n', ""
            ),
            "without using it",
        ),
        (READABLE.replace("# Uppercase", "# Upper"), "no '# Uppercase' comment"),
    ],
)
def test_unreadable_code_fails(code: str, message: str) -> None:
    with pytest.raises(AssertionError, match=message):
        assert_readable_python(code, PLAN)


def test_the_line_limit_is_enforced() -> None:
    with pytest.raises(AssertionError, match="the limit is 10"):
        assert_readable_python(READABLE, PLAN, max_lines=10)
