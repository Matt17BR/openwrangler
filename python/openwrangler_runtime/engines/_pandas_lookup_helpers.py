from ..lookup import check_lookup_columns, lookup_duplicate_message


def _open_wrangler_read_lookup(path, file_format):
    """Read a lookup file with Pandas' own readers, keeping integers, Booleans and text nullable.

    Parquet floats, dates and decimals stay Arrow-backed: Pandas' nullable floats would turn a stored NaN into a
    missing value, and object columns would lose their type when no row matches.
    """
    import pandas as pd

    try:
        if file_format in ("csv", "tsv"):
            try:
                frame = pd.read_csv(
                    path, sep="\t" if file_format == "tsv" else ",", encoding="utf-8", dtype_backend="numpy_nullable"
                )
            except pd.errors.EmptyDataError:
                frame = pd.DataFrame()
        elif file_format == "parquet":
            import pyarrow as pa
            import pyarrow.parquet as pq

            nullable = {
                pa.bool_(): pd.BooleanDtype(),
                pa.string(): pd.StringDtype(),
                pa.large_string(): pd.StringDtype(),
            }
            for bits in (8, 16, 32, 64):
                nullable[getattr(pa, f"int{bits}")()] = getattr(pd, f"Int{bits}Dtype")()
                nullable[getattr(pa, f"uint{bits}")()] = getattr(pd, f"UInt{bits}Dtype")()

            def mapper(arrow_type):
                if pa.types.is_floating(arrow_type) or pa.types.is_decimal(arrow_type) or pa.types.is_date(arrow_type):
                    return pd.ArrowDtype(arrow_type)
                return nullable.get(arrow_type)

            frame = pq.read_table(path).to_pandas(types_mapper=mapper)
            if any(name is not None for name in frame.index.names):
                frame = frame.reset_index()
        else:
            frame = pd.read_json(path, lines=True, dtype_backend="numpy_nullable")
    except (OSError, ValueError) as error:
        raise ValueError(f"Couldn't read the lookup file {path!r}: {error}") from error
    return frame.reset_index(drop=True)


def _open_wrangler_lookup_columns(df, lookup, keys, outputs, semantic_type):
    """Append looked-up columns to ``df``, keeping every row and its order.

    ``keys`` lists (position in ``df``, lookup column) pairs and ``outputs`` (lookup column, new column) pairs. A key
    with a missing part never matches, and a complete key may appear in at most one lookup row.
    """
    import numpy as np
    import pandas as pd

    names = [str(name) for name in lookup.columns]
    needed = {name for _, name in keys} | {name for name, _ in outputs}
    check_lookup_columns(
        [(name, semantic_type(lookup.iloc[:, position])) for position, name in enumerate(names) if name in needed],
        [(str(df.columns[position]), semantic_type(df.iloc[:, position]), name) for position, name in keys],
        outputs,
        [str(name) for name in df.columns],
    )

    def lookup_series(name):
        return lookup.iloc[:, names.index(name)]

    def key_codes(left, right, column_type):
        """Code one key part on both sides by the lookup file's distinct values; -1 marks missing or unmatched."""
        masks = None
        native = [getattr(series.dtype, "numpy_dtype", series.dtype) for series in (left, right)]
        if column_type == "boolean":
            masks = [~np.asarray(series.isna(), dtype=bool) for series in (left, right)]
            values = [series.to_numpy(dtype=bool, na_value=False) for series in (left, right)]
        elif (
            column_type == "integer"
            and all(
                isinstance(dtype, np.dtype) and dtype.kind in "iu" and not isinstance(series.dtype, pd.CategoricalDtype)
                for dtype, series in zip(native, (left, right), strict=True)
            )
            and len({dtype.kind == "u" and dtype.itemsize == 8 for dtype in native}) == 1
        ):
            masks = [~np.asarray(series.isna(), dtype=bool) for series in (left, right)]
            wide = native[0].kind == "u" and native[0].itemsize == 8
            values = [series.to_numpy(dtype="uint64" if wide else "int64", na_value=0) for series in (left, right)]
        elif column_type == "integer":
            values = []
            for series in (left, right):
                objects = series.to_numpy(dtype=object, na_value=None)
                present = ~np.asarray(series.isna(), dtype=bool)
                objects[present] = [int(value) for value in objects[present]]
                values.append(objects)
        else:
            values = [left, right]
        (left_codes, left_uniques), (right_codes, right_uniques) = (pd.factorize(value) for value in values)
        if masks is not None:
            left_codes[~masks[0]] = -1
            right_codes[~masks[1]] = -1

        def index(uniques):
            if isinstance(uniques, np.ndarray) and uniques.dtype.kind in "biu":
                return pd.Index(uniques)
            return pd.Index(np.asarray(uniques, dtype=object), dtype=object)

        matching = np.append(index(right_uniques).get_indexer(index(left_uniques)), -1)
        return matching[left_codes].astype(np.int64), right_codes.astype(np.int64), len(right_uniques)

    def combine(codes, part, width):
        return np.where((codes >= 0) & (part >= 0), codes * width + part, -1)

    (first_position, first_name), *other_keys = keys
    right = lookup_series(first_name)
    left_codes, right_codes, width = key_codes(df.iloc[:, first_position], right, semantic_type(right))
    right_keys = [right.to_numpy(dtype=object, na_value=None)]
    bound = max(width, 1)
    for position, name in other_keys:
        right = lookup_series(name)
        left_part, right_part, width = key_codes(df.iloc[:, position], right, semantic_type(right))
        width = max(width, 1)
        right_keys.append(right.to_numpy(dtype=object, na_value=None))
        if bound * width >= 2**62:
            distinct = np.unique(right_codes[right_codes >= 0])
            right_codes = np.where(right_codes >= 0, np.searchsorted(distinct, right_codes), -1)
            found = np.searchsorted(distinct, left_codes)
            clipped = np.minimum(found, max(len(distinct) - 1, 0))
            known = (left_codes >= 0) & (found < len(distinct))
            known[known] = distinct[clipped[known]] == left_codes[known]
            left_codes = np.where(known, found, -1)
            bound = max(len(distinct), 1)
        left_codes = combine(left_codes, left_part, width)
        right_codes = combine(right_codes, right_part, width)
        bound *= width
    right_rows = np.flatnonzero(right_codes >= 0)
    present_codes = right_codes[right_rows]
    repeated = pd.Index(present_codes).duplicated(keep=False)
    if repeated.any():
        row = right_rows[int(np.flatnonzero(repeated)[0])]
        values = [column[row] for column in right_keys]
        raise ValueError(
            lookup_duplicate_message(
                [name for _, name in keys],
                [value.item() if isinstance(value, np.generic) else value for value in values],
            )
        )
    order = np.argsort(present_codes, kind="stable")
    ordered = present_codes[order]
    found = np.searchsorted(ordered, left_codes)
    clipped = np.minimum(found, max(len(ordered) - 1, 0))
    hit = (left_codes >= 0) & (found < len(ordered))
    hit[hit] = ordered[clipped[hit]] == left_codes[hit]
    positions = np.where(hit, right_rows[order[clipped]] if len(ordered) else -1, -1)
    matched = positions >= 0

    added = []
    for name, new_column in outputs:
        series = lookup_series(name)
        dtype = series.dtype
        if isinstance(dtype, np.dtype) and dtype.kind == "O":
            values = np.full(len(df), None, dtype=object)
            values[matched] = series.to_numpy()[positions[matched]]
            added.append(pd.Series(values, index=df.index, dtype=object, name=new_column))
            continue
        array = series.array
        if isinstance(dtype, np.dtype) and dtype.kind in "biuf":
            data = series.to_numpy()
            mask = np.zeros(len(data), dtype=bool)
            if dtype.kind == "b":
                array = pd.arrays.BooleanArray(data, mask)
            elif dtype.kind == "f":
                array = pd.arrays.FloatingArray(data.astype(np.float64 if dtype.itemsize > 4 else np.float32), mask)
            else:
                array = pd.arrays.IntegerArray(data, mask)
        added.append(pd.Series(array.take(positions, allow_fill=True), index=df.index, name=new_column))
    return pd.concat([df, *added], axis=1)
