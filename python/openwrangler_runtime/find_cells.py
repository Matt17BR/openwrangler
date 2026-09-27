"""Row-major navigation over the matching cells of one resolved grid view."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

Cell = tuple[int, int]


def _lowest_bit(bits: int) -> int:
    return (bits & -bits).bit_length() - 1


@dataclass(frozen=True, slots=True)
class FindMatches:
    """Matches as ``(schema position, row bitset)`` pairs in ascending position, where bit ``r`` marks row ``r``."""

    rows: int
    columns: tuple[tuple[int, int], ...]
    count: int

    @classmethod
    def from_masks(cls, positions: Sequence[int], masks: Sequence[bytes | None]) -> FindMatches:
        rows = 0
        columns: list[tuple[int, int]] = []
        for position, mask in sorted(zip(positions, masks, strict=True), key=lambda item: item[0]):
            if mask is None:
                continue
            rows = max(rows, len(mask))
            bits = int(mask[::-1], 2)
            if bits:
                columns.append((position, bits))
        return cls(rows, tuple(columns), sum(bits.bit_count() for _position, bits in columns))

    def step(self, start: Cell | None, *, backward: bool, inclusive: bool) -> Cell | None:
        """Return the next or previous match from ``start``, wrapping around the view."""
        if not self.columns:
            return None
        if start is not None:
            cell = (min(start[0], self.rows), start[1])
            found = self._before(cell, inclusive) if backward else self._after(cell, inclusive)
            if found is not None:
                return found
        if backward:
            return max((bits.bit_length() - 1, position) for position, bits in self.columns)
        return min((_lowest_bit(bits), position) for position, bits in self.columns)

    def ordinal(self, cell: Cell) -> int:
        """Return the one-based position of a matching cell among all matches."""
        row, column = cell
        earlier_rows = (1 << row) - 1
        return sum(
            (bits & earlier_rows).bit_count() + (position <= column and bits >> row & 1)
            for position, bits in self.columns
        )

    def _after(self, start: Cell, inclusive: bool) -> Cell | None:
        row, column = start
        same_row = [
            position
            for position, bits in self.columns
            if (position > column or (inclusive and position == column)) and bits >> row & 1
        ]
        if same_row:
            return row, min(same_row)
        later = [
            (row + 1 + _lowest_bit(shifted), position)
            for position, bits in self.columns
            if (shifted := bits >> (row + 1))
        ]
        return min(later) if later else None

    def _before(self, start: Cell, inclusive: bool) -> Cell | None:
        row, column = start
        same_row = [
            position
            for position, bits in self.columns
            if (position < column or (inclusive and position == column)) and bits >> row & 1
        ]
        if same_row:
            return row, max(same_row)
        earlier_rows = (1 << row) - 1
        earlier = [
            ((bits & earlier_rows).bit_length() - 1, position) for position, bits in self.columns if bits & earlier_rows
        ]
        return max(earlier) if earlier else None
