"""In-process pub/sub bus for realtime stats events streamed over SSE.

Design constraints
------------------
- Detection threads (tracker / anomaly) run as real ``threading.Thread`` (the
  process calls ``monkey.patch_all(thread=False, queue=False, ...)``), so the
  bus must be thread-safe for plain threads.
- Flask handlers run on gevent greenlets. Waiting for data must be done in a
  way that does not block the gevent hub for too long — we therefore use
  ``queue.Queue.get(timeout=...)`` with a short timeout and let the Flask
  generator yield between calls (``gevent.sleep``).
- One bounded queue *per subscriber*. Producers never block: on overflow we
  drop the newest event for that subscriber and bump a per-subscriber drop
  counter that's piggy-backed onto the next delivered event.

Payload shape
-------------
``publish(event)`` accepts an already-serialised dict. The SSE route emits it
as ``event: stats\\ndata: <json>\\n\\n``. The ``event`` name is intentionally
always ``stats`` — we do not multiplex different event names. The ``data``
dict contains a ``pipeline_id`` so subscribers can dispatch client-side.
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Any, Callable, Iterator

# Per-subscriber queue depth. Small on purpose: one crossing every ~few
# hundred ms + a 2 Hz heartbeat, so 32 is plenty of headroom for a slow client
# before we start dropping newest-first.
_SUBSCRIBER_QUEUE_MAX = 32


class Subscriber:
    """A single SSE connection's view of the bus."""

    __slots__ = ("q", "dropped", "id")

    def __init__(self, sub_id: int) -> None:
        self.q: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=_SUBSCRIBER_QUEUE_MAX)
        self.dropped: int = 0
        self.id: int = sub_id


class StatsBus:
    """Fan-out pub/sub with bounded per-subscriber queues.

    ``publish`` is non-blocking: if a subscriber's queue is full, its newest
    slot is sacrificed rather than blocking the detection loop.
    """

    def __init__(self) -> None:
        self._subs: list[Subscriber] = []
        self._lock = threading.Lock()
        self._next_id = 0
        # Simple global counter so the SSE handler can log drops on shutdown.
        self.total_published: int = 0
        self.total_dropped: int = 0

    # ── Producer side ────────────────────────────────────────────────────
    def publish(self, event: dict[str, Any]) -> None:
        """Broadcast `event` to every subscriber. Never blocks.

        If a subscriber's queue is full, the oldest event for that subscriber
        is discarded to make room — this preserves "latest-state" semantics
        for a slow client instead of letting it lag the whole stream.
        """
        self.total_published += 1
        # Copy the subscriber list under lock so we don't hold the lock
        # while calling put_nowait (which can itself briefly contend).
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            try:
                sub.q.put_nowait(event)
            except queue.Full:
                # Drop oldest, then retry once.
                try:
                    sub.q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    sub.q.put_nowait(event)
                    sub.dropped += 1
                    self.total_dropped += 1
                except queue.Full:
                    # Should not happen (we just freed a slot) but be safe.
                    sub.dropped += 1
                    self.total_dropped += 1

    # ── Consumer side ────────────────────────────────────────────────────
    def subscribe(self) -> Subscriber:
        with self._lock:
            sub = Subscriber(self._next_id)
            self._next_id += 1
            self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        with self._lock:
            try:
                self._subs.remove(sub)
            except ValueError:
                pass

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)


# Module-level singleton used by detection threads and the Flask SSE route.
stats_bus = StatsBus()


def iter_sse(
    sub: Subscriber,
    *,
    serialize: Callable[[dict[str, Any]], str],
    sleeper: Callable[[float], None],
    heartbeat_interval: float = 15.0,
    poll_timeout: float = 0.25,
    stop_check: Callable[[], bool] | None = None,
) -> Iterator[bytes]:
    """Yield SSE-framed bytes from a subscriber's queue.

    Parameters
    ----------
    sub
        The subscriber handle returned by :meth:`StatsBus.subscribe`.
    serialize
        Callable that turns a payload dict into a JSON string (injected so
        this module doesn't depend on Flask's ``jsonify``).
    sleeper
        Function used between empty polls. In Flask+gevent we pass
        ``gevent.sleep`` so the greenlet yields.
    heartbeat_interval
        Seconds between ``: ping`` comments when no real events arrive.
        Keeps NATs and reverse proxies from killing the idle connection.
    poll_timeout
        How long we block on the underlying ``queue.Queue.get`` before
        yielding control back to gevent.
    stop_check
        Optional predicate; when it returns True the generator exits cleanly
        (used on shutdown).
    """
    last_beat = time.monotonic()
    while True:
        if stop_check is not None and stop_check():
            return
        try:
            event = sub.q.get_nowait()
        except queue.Empty:
            now = time.monotonic()
            if now - last_beat >= heartbeat_interval:
                last_beat = now
                yield b": ping\n\n"
            # Let other greenlets run.
            sleeper(poll_timeout)
            continue

        # Attach per-subscriber drop counter so clients can surface it.
        if sub.dropped:
            event = {**event, "dropped": sub.dropped}

        payload = serialize(event)
        yield (
            b"event: stats\n"
            b"data: " + payload.encode("utf-8") + b"\n\n"
        )
        last_beat = time.monotonic()
