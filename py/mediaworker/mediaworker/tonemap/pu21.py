"""Putting the HDR original and an SDR candidate on one perceptual scale before scoring (handoff §8.5 step 4).

Both images become absolute luminance (cd/m²): the original through BT.2100's decode (curves.reference_nits),
the candidate through a model of a 200 cd/m², 1000:1 SDR display. Then both go through PU21, so that equal
differences are roughly equally visible. This is the "DM + PU21" adaptation of Chen et al., *Adapting Quality
Metrics to Tone Mapping* (SIGGRAPH 2026).

PU21 is Mantiuk & Azimi, *PU21: A novel perceptually uniform encoding for adapting existing quality metrics for
HDR* (PCS 2021), with its recommended "banding + glare" parameters. It is not the quadratic in log₂ L that the
pipeline notes give (a·u² + b·u with a = 0.001908, b = 0.0078): that curve has a different shape and isn't PU21.
PU21 maps 100 cd/m² to about 256, like an 8-bit SDR code; we divide by its value at 10 000 cd/m² (≈ 595) so the
metrics get inputs in [0, 1].
"""

from __future__ import annotations

import numpy as np

L_MIN = 0.005  # cd/m², PU21's valid range
L_MAX = 10000.0
# banding_glare, from the authors' reference implementation (pu21_encoder.m)
_P = (0.353487901, 0.3734658629, 8.277049286e-05, 0.9062562627, 0.09150303166, 0.9099517204, 596.3148142)

SDR_PEAK = 200.0  # the SDR display the candidate is modelled on
SDR_BLACK = 0.2  # 1000:1
SDR_GAMMA = 2.2


def pu21(lum: np.ndarray) -> np.ndarray:
    """cd/m² → PU21 units (≈ 0 at 0.005 cd/m², ≈ 256 at 100, ≈ 595 at 10 000)."""
    p = _P
    y = np.clip(lum, L_MIN, L_MAX) ** p[3]
    return np.maximum(p[6] * (((p[0] + p[1] * y) / (1.0 + p[2] * y)) ** p[4] - p[5]), 0.0)


_V_MAX = float(pu21(np.array(L_MAX)))


def encode(lum: np.ndarray) -> np.ndarray:
    """cd/m² → [0, 1]: PU21 divided by its value at 10 000 cd/m²."""
    return pu21(lum) / _V_MAX


def sdr_display(v: np.ndarray) -> np.ndarray:
    """SDR code value v in [0, 1] → cd/m² on the modelled display: (200 − 0.2)·v^2.2 + 0.2."""
    return (SDR_PEAK - SDR_BLACK) * np.clip(v, 0.0, 1.0) ** SDR_GAMMA + SDR_BLACK
