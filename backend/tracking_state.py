"""Backward-compatibility shim — re-exports from the detection package.

All code has been split into:
  detection/base.py        — TrackingState class + lifecycle
  detection/anomaly.py     — EfficientAD helpers + anomaly-mode processor
  detection/tracker.py     — Tracking-mode processor (barcode+date+exit line)
  detection/reader.py      — Video reader thread
  detection/compositor.py  — Overlay compositor + JPEG encoder thread

Existing imports like ``from tracking_state import TrackingState``
continue to work unchanged.
"""

from detection import TrackingState

__all__ = ["TrackingState"]
