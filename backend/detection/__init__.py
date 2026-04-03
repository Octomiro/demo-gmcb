"""Detection package — split from the original monolithic tracking_state.py.

Submodules:
  anomaly     – EfficientAD anomaly detection helpers (AnomalyMixin)
  tracker     – Tracking-mode per-frame processing (TrackerMixin)
  reader      – Video reader thread (ReaderMixin)
  compositor  – Overlay compositor + JPEG encoder thread (CompositorMixin)
  base        – TrackingState class (inherits all mixins above)
"""

from .base import TrackingState

__all__ = ["TrackingState"]
