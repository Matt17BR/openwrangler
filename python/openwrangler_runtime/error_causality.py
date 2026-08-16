from __future__ import annotations


def add_exception_note(error: BaseException, note: str) -> None:
    """Attach bounded cleanup evidence without requiring Python 3.11."""
    bounded_note = note[:512]
    add_note = getattr(error, "add_note", None)
    if callable(add_note):
        add_note(bounded_note)
        return

    existing = getattr(error, "__notes__", None)
    notes = list(existing) if isinstance(existing, list) else []
    notes.append(bounded_note)
    try:
        error.__notes__ = notes  # type: ignore[attr-defined]
    except (AttributeError, TypeError):
        # A defensive exception subclass may reject normal attribute assignment.
        # BaseException still owns this compatibility receipt on Python 3.10.
        BaseException.__setattr__(error, "__notes__", notes)
