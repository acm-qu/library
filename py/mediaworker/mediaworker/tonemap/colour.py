"""Transfer functions and primaries for the HDR → SDR conversion.

Everything here works on numpy arrays of shape (..., 3) in float64, R, G, B in the last axis.
Sources: ITU-R BT.2100 (HLG and PQ), BT.709 (SDR OETF and primaries), BT.2020 (primaries),
BT.1886 (SDR display EOTF).
"""

from __future__ import annotations

import numpy as np

# ── HLG (BT.2100 Table 5) ─────────────────────────────────────────────────────────────────────────────
HLG_A = 0.17883277
HLG_B = 1.0 - 4.0 * HLG_A
HLG_C = 0.5 - HLG_A * float(np.log(4.0 * HLG_A))
HLG_PEAK = 1000.0  # nominal peak of the HLG reference display, cd/m²
HLG_GAMMA = 1.2  # system gamma at 1000 cd/m²
REFERENCE_WHITE = 203.0  # BT.2408: HDR reference (graphics) white, cd/m²

# Luma weights of BT.2020 (used by the HLG OOTF).
BT2020_Y = np.array([0.2627, 0.6780, 0.0593])


def hlg_inverse_oetf(e: np.ndarray) -> np.ndarray:
    """E′ → normalised scene light E (1 at E′ = 1). Negatives clip to 0; super-white above 1 extrapolates, as in zimg."""
    e = np.maximum(e, 0.0)
    with np.errstate(over="ignore"):
        hi = (np.exp((e - HLG_C) / HLG_A) + HLG_B) / 12.0
    return np.where(e <= 0.5, e * e / 3.0, hi)


def hlg_oetf(x: np.ndarray) -> np.ndarray:
    """Scene light E in [0, 1] → E′ (the inverse of hlg_inverse_oetf)."""
    x = np.clip(x, 0.0, 1.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        hi = HLG_A * np.log(np.maximum(12.0 * x - HLG_B, 1e-12)) + HLG_C
    return np.where(x <= 1.0 / 12.0, np.sqrt(3.0 * x), hi)


def hlg_to_nits(rgb_e: np.ndarray) -> np.ndarray:
    """HLG R′G′B′ → display light in cd/m² on the 1000 cd/m² reference display, per BT.2100: inverse OETF,
    then the OOTF, which scales each pixel by Ys^(γ−1) with Ys its BT.2020 luminance in scene light.

    zimg (and so the encoder) applies γ per channel instead; see curves.zimg_hlg_to_nits.
    """
    e = hlg_inverse_oetf(rgb_e)
    ys = np.maximum(e @ BT2020_Y, 0.0)
    return HLG_PEAK * (ys ** (HLG_GAMMA - 1.0))[..., None] * e


# ── PQ (BT.2100 Table 4) ──────────────────────────────────────────────────────────────────────────────
PQ_M1 = 2610.0 / 16384.0
PQ_M2 = 2523.0 / 4096.0 * 128.0
PQ_C1 = 3424.0 / 4096.0
PQ_C2 = 2413.0 / 4096.0 * 32.0
PQ_C3 = 2392.0 / 4096.0 * 32.0
PQ_PEAK = 10000.0


def pq_eotf(e: np.ndarray) -> np.ndarray:
    """PQ E′ → cd/m². Negatives clip to 0; values a little above 1 (super-white) extrapolate, as in zimg."""
    p = np.clip(e, 0.0, 1.5) ** (1.0 / PQ_M2)
    return PQ_PEAK * (np.maximum(p - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * p)) ** (1.0 / PQ_M1)


def pq_inverse_eotf(nits: np.ndarray) -> np.ndarray:
    """cd/m² → PQ E′ in [0, 1]."""
    y = (np.clip(nits, 0.0, PQ_PEAK) / PQ_PEAK) ** PQ_M1
    return ((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y)) ** PQ_M2


# ── Primaries ─────────────────────────────────────────────────────────────────────────────────────────
_WHITE_D65 = (0.3127, 0.3290)
_BT709 = ((0.640, 0.330), (0.300, 0.600), (0.150, 0.060))
_BT2020 = ((0.708, 0.292), (0.170, 0.797), (0.131, 0.046))


def _rgb_to_xyz(primaries: tuple[tuple[float, float], ...], white: tuple[float, float]) -> np.ndarray:
    xyz = np.array([[x / y, 1.0, (1.0 - x - y) / y] for x, y in primaries]).T
    wx, wy = white
    w = np.array([wx / wy, 1.0, (1.0 - wx - wy) / wy])
    return xyz * np.linalg.solve(xyz, w)


# BT.2020 → BT.709 in linear light (BT.2087), computed from the primaries rather than rounded to 4 places.
BT2020_TO_BT709 = np.linalg.solve(_rgb_to_xyz(_BT709, _WHITE_D65), _rgb_to_xyz(_BT2020, _WHITE_D65))


def bt2020_to_bt709(rgb: np.ndarray) -> np.ndarray:
    """Linear BT.2020 → linear BT.709. Out-of-gamut colours come back with negative components."""
    return rgb @ BT2020_TO_BT709.T


# ── SDR encoding ──────────────────────────────────────────────────────────────────────────────────────
BT709_ALPHA = 1.09929682680944
BT709_BETA = 0.018053968510807


def bt709_oetf(lin: np.ndarray) -> np.ndarray:
    """Linear [0, 1] → BT.709 R′G′B′ (the camera OETF; negatives clip to 0)."""
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin < BT709_BETA, 4.5 * lin, BT709_ALPHA * lin**0.45 - (BT709_ALPHA - 1.0))


def bt709_inverse_oetf(v: np.ndarray) -> np.ndarray:
    v = np.clip(v, 0.0, 1.0)
    return np.where(v < 4.5 * BT709_BETA, v / 4.5, ((v + (BT709_ALPHA - 1.0)) / BT709_ALPHA) ** (1.0 / 0.45))


def bt1886_inverse_eotf(lin: np.ndarray) -> np.ndarray:
    """Linear [0, 1] → R′G′B′ for a gamma-2.4 display (BT.1886 with zero black)."""
    return np.clip(lin, 0.0, 1.0) ** (1.0 / 2.4)
