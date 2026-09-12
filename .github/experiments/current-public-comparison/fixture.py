"""Temporary synthetic Pandas fixture and independent public-code oracle."""

import ast
import hashlib
import importlib.metadata
import json
import pathlib
import sys

import numpy as np
import pandas as pd


def runtime_identity():
    packages = sorted((d.metadata["Name"].lower(), d.version) for d in importlib.metadata.distributions())
    return {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "prefix": sys.prefix,
        "basePrefix": sys.base_prefix,
        "packages": packages,
    }


def make_frame(rows):
    if rows not in (100_000, 1_000_000):
        raise ValueError("Unreviewed fixture size")
    i = np.arange(rows, dtype="int64")
    amount = (i % 2000).astype("float64") / 2
    amount[i % 17 == 0] = np.nan
    families = [
        i,
        amount,
        i % 2 == 0,
        np.array(["North", "SOUTH", "East", "WEST"], dtype=object)[i % 4],
        pd.Series(i % 4096).map(lambda x: f"item-{x:04d}").to_numpy(),
        pd.Timestamp("2020-01-01") + pd.to_timedelta(i % 366, unit="D"),
    ]
    return pd.DataFrame({f"c{j:02d}": families[j % 6] for j in range(20)})


def digest(frame):
    schema = json.dumps([(str(c), str(t)) for c, t in zip(frame.columns, frame.dtypes)]).encode()
    return hashlib.sha256(schema + pd.util.hash_pandas_object(frame, index=True).to_numpy().tobytes()).hexdigest()


def expected(frame):
    result = frame.copy(deep=True)
    result["c01"] = result["c01"].fillna(result["c01"].median())
    result["c03"] = result["c03"].str.lower()
    return result


def profiles(frame):
    result = []
    for column in frame.columns:
        values = frame[column]
        item = {
            "name": column,
            "missing": int(values.isna().sum()),
            "distinct": int(values.nunique()),
        }
        if values.dtype.kind in "if":
            item.update(
                family="numeric",
                minimum=float(values.min()),
                maximum=float(values.max()),
            )
        elif values.dtype.kind == "b":
            item.update(
                family="boolean",
                trueCount=int(values.sum()),
                falseCount=int((~values).sum()),
            )
        elif values.dtype.kind == "M":
            item.update(
                family="datetime",
                minimumDate=values.min().date().isoformat(),
                maximumDate=values.max().date().isoformat(),
            )
        else:
            item.update(family="text")
        result.append(item)
    return result


def verify_code(code, source):
    # These are publicly exported user cleaning instructions, never extension package code.
    tree = ast.parse(code)
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and not node.name.startswith("_")]
    if len(functions) != 1:
        raise AssertionError("Pilot gate: exported code must expose one public cleaning function")
    function = functions[0]
    if len(function.args.args) != 1 or function.args.vararg or function.args.kwarg or function.args.kwonlyargs:
        raise AssertionError("Pilot gate: cleaning function must take one dataframe")
    invocations = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef)):
            continue
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            continue
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == function.name
            and len(node.value.args) == 1
            and isinstance(node.value.args[0], ast.Name)
            and not node.value.keywords
        ):
            invocations.append(node)
        else:
            raise AssertionError("Pilot gate: unreviewed top-level exported execution")
    if len(invocations) > 1:
        raise AssertionError("Pilot gate: multiple exported cleaning invocations")
    before = source.copy(deep=True)
    fresh = source.copy(deep=True)
    fresh_before = fresh.copy(deep=True)
    namespace = {}
    if invocations:
        namespace[invocations[0].value.args[0].id] = fresh
    exec(compile(tree, "<publicly-exported-cleaning-code>", "exec"), namespace)  # noqa: S102
    result = namespace[invocations[0].targets[0].id] if invocations else namespace[function.name](fresh)
    pd.testing.assert_frame_equal(result, expected(before), check_exact=True)
    pd.testing.assert_frame_equal(fresh, fresh_before, check_exact=True)
    pd.testing.assert_frame_equal(source, before, check_exact=True)
    return {
        "completeFrameEqual": True,
        "sourceUnchanged": True,
        "resultDigest": digest(result),
        "inputUnchanged": True,
        "invocations": 1,
        "route": "script" if invocations else "function",
        "codeSha256": hashlib.sha256(code.encode()).hexdigest(),
    }


def prepare(rows, directory):
    source = pathlib.Path(__file__).resolve()
    cells = [
        (
            "import json, os, runpy, sys, uuid\n"
            f"comparison_helpers = runpy.run_path({str(source)!r})\n"
            f"comparison_frame = comparison_helpers['make_frame']({rows})\n"
            "comparison_original = comparison_frame.copy(deep=True)\n"
            "comparison_kernel_identity = {'nonce': uuid.uuid4().hex, 'pid': os.getpid()}\n"
            "print('COMPARISON_READY:' + json.dumps({'digest': comparison_helpers['digest'](comparison_frame), "
            "'profiles': comparison_helpers['profiles'](comparison_frame), "
            "'median': float(comparison_frame['c01'].median()), 'runtime': comparison_helpers['runtime_identity'](), "
            "'kernelIdentity': comparison_kernel_identity}))"
        ),
        "comparison_frame",
        "# The public driver inserts exported cleaning code into an oracle invocation here.",
    ]
    notebook = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {
                "name": "public-comparison",
                "display_name": "Python 3.12 (Public comparison)",
                "language": "python",
            }
        },
        "cells": [
            {
                "cell_type": "code",
                "metadata": {},
                "source": code.splitlines(keepends=True),
                "execution_count": None,
                "outputs": [],
            }
            for code in cells
        ],
    }
    (directory / "comparison.ipynb").write_text(json.dumps(notebook), encoding="utf8")


if __name__ == "__main__":
    if sys.argv[1:] == ["--versions"]:
        print(json.dumps(runtime_identity()))
    elif len(sys.argv) == 3:
        prepare(int(sys.argv[1]), pathlib.Path(sys.argv[2]))
    else:
        raise SystemExit("fixture.py --versions | ROWS OWNED_WORKSPACE")
