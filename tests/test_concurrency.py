from __future__ import annotations

import asyncio
import threading

import pytest

from forgeflow.concurrency import cancellation_safe_to_thread


def test_repeated_cancellation_drains_started_worker() -> None:
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def side_effect() -> str:
        entered.set()
        assert release.wait(timeout=5)
        finished.set()
        return "done"

    async def scenario() -> None:
        task = asyncio.create_task(cancellation_safe_to_thread(side_effect))
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        # Allow the first cancellation to enter the helper's drain path.
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()

    asyncio.run(scenario())


def test_worker_failure_is_cause_of_preserved_cancellation() -> None:
    entered = threading.Event()
    release = threading.Event()

    def side_effect() -> None:
        entered.set()
        assert release.wait(timeout=5)
        raise RuntimeError("worker failed")

    async def scenario() -> None:
        task = asyncio.create_task(cancellation_safe_to_thread(side_effect))
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError) as caught:
            await task
        assert isinstance(caught.value.__cause__, RuntimeError)

    asyncio.run(scenario())
