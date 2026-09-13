"""Cancellation-safe boundaries for synchronous side effects."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any


async def _drain_task_ignoring_cancellation[T](worker: asyncio.Task[T]) -> T:
    """Wait for ``worker`` to finish even if the caller is cancelled again.

    Once a synchronous side effect has started in ``to_thread`` it cannot be
    safely abandoned: the thread can keep mutating a workspace or remote while
    the async caller moves on to cleanup.  Repeated ``Task.cancel()`` calls are
    therefore intentionally absorbed until the worker reaches a terminal state.
    """

    while not worker.done():
        try:
            await asyncio.shield(worker)
        except asyncio.CancelledError:
            # A second (or later) cancellation request must not abandon the
            # already-running side effect.  The first cancellation is re-raised
            # by ``cancellation_safe_to_thread`` after the worker is drained.
            continue
    return worker.result()


async def cancellation_safe_to_thread[T](
    func: Callable[..., T],
    /,
    *args: Any,
    cancel_cleanup: Callable[[T], Any] | None = None,
    **kwargs: Any,
) -> T:
    """Run a synchronous side effect off-loop and preserve cancellation ordering.

    If cancellation arrives after the worker starts, drain that worker to a
    terminal state before propagating the *first* ``CancelledError``.  Any later
    cancellation requests are absorbed while draining.  An optional synchronous
    compensation step is drained with the same rule.
    """

    worker = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError as cancel_exc:
        try:
            result = await _drain_task_ignoring_cancellation(worker)
            if cancel_cleanup is not None:
                cleanup = asyncio.create_task(asyncio.to_thread(cancel_cleanup, result))
                await _drain_task_ignoring_cancellation(cleanup)
        except BaseException as worker_exc:
            raise cancel_exc from worker_exc
        raise


__all__ = ["cancellation_safe_to_thread"]
