from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import TypeVar

_View = TypeVar("_View")


class SessionRequestAdmission:
    """Own the ordering and lifetime of one session's dataframe requests."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._admission_condition = threading.Condition(threading.Lock())
        self._profile_condition = threading.Condition(self._lock)
        self._active_profiles = 0
        self._waiting_writers = 0

    @contextmanager
    def shared(self) -> Iterator[None]:
        """Admit a short read unless an exclusive operation is already waiting."""

        with self._admission_condition:
            while self._waiting_writers:
                self._admission_condition.wait()
            self._lock.acquire()
        try:
            yield
        finally:
            self._lock.release()

    @contextmanager
    def profile(
        self,
        capture_view: Callable[[], _View],
        revalidate_view: Callable[[], None],
    ) -> Iterator[_View]:
        """Lease one captured view while allowing foreground reads to proceed."""

        with self._admission_condition:
            while self._waiting_writers:
                self._admission_condition.wait()
            with self._lock:
                view = capture_view()
                self._active_profiles += 1
        try:
            yield view
        except BaseException as error:
            self._complete_profile(revalidate_view, error)
            raise
        else:
            self._complete_profile(revalidate_view, None)

    @contextmanager
    def exclusive(self) -> Iterator[None]:
        """Register writer intent before locking and wait for leased profiles."""

        with self._admission_condition:
            self._waiting_writers += 1
            self._admission_condition.notify_all()
        try:
            with self._lock:
                while self._active_profiles:
                    self._profile_condition.wait()
                yield
        finally:
            with self._admission_condition:
                self._waiting_writers -= 1
                self._admission_condition.notify_all()

    def _complete_profile(
        self,
        revalidate_view: Callable[[], None],
        cause: BaseException | None,
    ) -> None:
        with self._lock:
            try:
                revalidate_view()
            except BaseException as validation_error:
                if cause is not None:
                    raise validation_error from cause
                raise
            finally:
                self._active_profiles -= 1
                self._profile_condition.notify_all()
