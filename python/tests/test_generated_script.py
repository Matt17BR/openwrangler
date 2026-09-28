from __future__ import annotations

from typing import Any

import pytest
from generated_code_test_support import assert_readable_python

from openwrangler_runtime.engines._generated_script import GeneratedScript, expected_columns


def test_render_places_imports_helpers_checks_and_steps_in_order():
    script = GeneratedScript()
    script.add_import("import pandas as pd")
    script.add_import("import pandas as pd")
    script.add_helper(
        "is_text",
        [
            "def is_text(column):",
            '    """Return whether a column holds only text and missing values."""',
            "    return pd.api.types.is_string_dtype(column)",
        ],
    )
    script.add_checks(
        [
            'if not is_text(df["name"]):',
            "    raise TypeError(\"Column 'name' is not text.\")",
        ]
    )
    script.add_step("upperText", ['df = df.assign(name=df["name"].str.upper())'])

    code = script.render()

    assert code == (
        "def clean_data(df):\n"
        "    import pandas as pd\n"
        "\n"
        "    def is_text(column):\n"
        '        """Return whether a column holds only text and missing values."""\n'
        "        return pd.api.types.is_string_dtype(column)\n"
        "\n"
        "    # Stop if the data differs from the data this code was generated for.\n"
        '    if not is_text(df["name"]):\n'
        "        raise TypeError(\"Column 'name' is not text.\")\n"
        "\n"
        "    # Uppercase\n"
        '    df = df.assign(name=df["name"].str.upper())\n'
        "\n"
        "    return df\n"
    )
    plan = [{"id": "s1", "kind": "upperText", "params": {}}]
    assert_readable_python(code, plan)


def test_empty_checks_add_no_block_and_custom_code_checks_have_their_own_comment():
    script = GeneratedScript(function_name="clean_data_1")
    script.add_checks([])
    script.add_checks(["pass"], after_custom_code=True)

    assert script.render() == (
        "def clean_data_1(df):\n"
        "    # Stop if the custom code changed columns the next steps use.\n"
        "    pass\n"
        "\n"
        "    return df\n"
    )


def _type_checked_script(**conversion: str) -> str:
    script = GeneratedScript()
    script.add_checks(
        script.type_check(
            'isinstance(df["units"], int) or isinstance(df["units"], bool)',
            '"units"',
            'type(df["units"]).__name__',
            expected_columns("integer"),
            **conversion,
        )
    )
    return script.render()


def test_type_check_raises_the_shared_type_error():
    code = _type_checked_script()
    namespace: dict[str, Any] = {}
    exec(code, namespace)
    clean_data = namespace["clean_data"]

    assert clean_data({"units": 3}) == {"units": 3}
    with pytest.raises(TypeError) as raised:
        clean_data({"units": 2.5})
    assert str(raised.value) == (
        "Column 'units' is float, but this code was generated for integer columns. "
        "Open the new data in Open Wrangler and generate the code again."
    )
    assert "    if not (isinstance(" in code
    assert_readable_python(code, [])


def test_type_check_offers_an_exact_conversion():
    namespace: dict[str, Any] = {}
    exec(_type_checked_script(conversion='df["units"] = int(df["units"])'), namespace)

    with pytest.raises(TypeError) as raised:
        namespace["clean_data"]({"units": 2.0})
    assert str(raised.value) == (
        "Column 'units' is float, but this code was generated for integer columns. "
        'Run this first: df["units"] = int(df["units"])'
    )


def test_type_check_keeps_a_bare_condition_unwrapped():
    lines = GeneratedScript().type_check('is_text(df["name"])', '"name"', 'df["name"].dtype', "text columns")

    assert lines == [
        'if not is_text(df["name"]):',
        '    raise type_error("name", df["name"].dtype, \'text columns\')',
    ]


def test_helper_must_start_with_its_def_line():
    with pytest.raises(ValueError, match="is_text"):
        GeneratedScript().add_helper("is_text", ["def other(column):"])


@pytest.mark.parametrize(
    ("column_type", "time_zone", "expected"),
    [
        ("integer", None, "integer columns"),
        ("string", None, "text columns"),
        ("object", None, "mixed-value object columns"),
        ("datetime", None, "datetime columns without a time zone"),
        ("datetime", "UTC", "datetime columns in UTC"),
    ],
)
def test_expected_columns_names_the_family(column_type, time_zone, expected):
    assert expected_columns(column_type, time_zone) == expected
