"""The HDR → SDR conversion S = ε ∘ T ∘ M ∘ ℓ and its four candidate tone curves T.

ℓ decodes HLG or PQ to display light. M changes BT.2020 primaries to BT.709 and clips what SDR can't show.
T applies a curve f to s = max(r, g, b) and scales the pixel by f(s)/s, so hues keep their ratios.
ε encodes for an SDR display.

ℓ, M and ε reproduce ffmpeg's zscale exactly, because the Hable candidate has to match the encoder's verified
fallback chain (zscale linear npl=203 → zscale p=bt709 → tonemap=hable:desat=0 → zscale t=bt709). Measured
against ffmpeg 7 and 8 (see docs/decisions/tone-curves.md):
- zimg's HLG decode raises each channel to the system gamma 1.2 on its own. BT.2100 scales by the pixel's
  luminance instead. The two agree on greys (0.75 → 203 cd/m²) and differ on saturated colours.
- zscale encodes `t=bt709` with the BT.1886 display gamma (V = L^(1/2.4)), not with the BT.709 camera OETF.
- ffmpeg's tonemap filter normalises Hable by its value at peak = 10 (its default for a linear input).

The reference image the candidates are scored against is the original as BT.2100 renders it (reference_nits):
HLG through the inverse OETF and the luminance-based OOTF on a 1000 cd/m² display, PQ through its EOTF.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

from . import colour as C

CURVES = ("hable203", "bt2446a", "bt2390", "reinhard203")
FALLBACK = "hable203"
TRANSFERS = ("hlg", "pq")

# Below this (cd/m²) a pixel counts as black; ffmpeg's tonemap uses 1e-6 of its 203 cd/m² unit.
_S_FLOOR = 1e-6 * C.REFERENCE_WHITE


def zimg_hlg_to_nits(rgb_e: np.ndarray) -> np.ndarray:
    """HLG R′G′B′ → cd/m² the way zimg does it: inverse OETF, then each channel to the power 1.2."""
    return C.HLG_PEAK * C.hlg_inverse_oetf(rgb_e) ** C.HLG_GAMMA


def decode(rgb_e: np.ndarray, transfer: str) -> np.ndarray:
    """ℓ: encoded BT.2020 R′G′B′ → linear BT.2020 RGB in cd/m²."""
    if transfer == "hlg":
        return zimg_hlg_to_nits(rgb_e)
    if transfer == "pq":
        return C.pq_eotf(rgb_e)
    raise ValueError(f"unknown transfer {transfer!r}")


def to_bt709_nits(rgb_e: np.ndarray, transfer: str) -> np.ndarray:
    """M ∘ ℓ: encoded BT.2020 R′G′B′ → linear BT.709 RGB in cd/m², negative components clipped to 0."""
    return np.maximum(C.bt2020_to_bt709(decode(rgb_e, transfer)), 0.0)


def reference_nits(rgb_e: np.ndarray, transfer: str) -> np.ndarray:
    """The HDR original as BT.2100 shows it, in linear BT.709 cd/m² (clipped at 0): what candidates are scored
    against. HLG is relative, not absolute: it needs the OOTF for a display peak (1000 cd/m², γ = 1.2)."""
    lin = C.hlg_to_nits(rgb_e) if transfer == "hlg" else decode(rgb_e, transfer)
    return np.maximum(C.bt2020_to_bt709(lin), 0.0)


def encode(lin: np.ndarray) -> np.ndarray:
    """ε: linear SDR → R′G′B′ as zscale writes it for `t=bt709` (BT.1886, gamma 2.4).

    Values above 1 are kept, as in the chain: Hable on very bright PQ (above 2030 cd/m²) exceeds 1, and zscale
    converts that RGB to YUV before the 8-bit clamp. Clipping each channel first would shift those colours.
    """
    return np.maximum(lin, 0.0) ** (1.0 / 2.4)


# ── Tone curves: f(s) with s = max(r, g, b) in cd/m², returning linear SDR in [0, 1] ──────────────────

_HABLE = (0.15, 0.50, 0.10, 0.20, 0.02, 0.30)  # A..F


def _hable_u(x: np.ndarray | float) -> np.ndarray:
    a, b, c, d, e, f = _HABLE
    x = np.asarray(x, dtype=np.float64)
    return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f


HABLE_PEAK = 10.0  # ffmpeg tonemap's default peak for a linear signal, in units of 203 cd/m²


def hable203(s: np.ndarray) -> np.ndarray:
    """Hable's filmic curve on x = s / 203, normalised by u(x_max) with x_max = 10 (ffmpeg's tonemap)."""
    return _hable_u(s / C.REFERENCE_WHITE) / _hable_u(HABLE_PEAK)


def reinhard203(s: np.ndarray) -> np.ndarray:
    """Reinhard: x / (1 + x), with x = s / 203 (reference white → 0.5)."""
    x = s / C.REFERENCE_WHITE
    return x / (1.0 + x)


# BT.2446 Method A, §5.1.1: the luma curve, applied here to max(r, g, b) (the paper's ratio-preserving T).
_L_HDR = 1000.0
_L_SDR = 100.0


def bt2446a(s: np.ndarray) -> np.ndarray:
    rho_hdr = 1.0 + 32.0 * (_L_HDR / 10000.0) ** (1.0 / 2.4)
    rho_sdr = 1.0 + 32.0 * (_L_SDR / 10000.0) ** (1.0 / 2.4)
    y = np.clip(s / _L_HDR, 0.0, 1.0) ** (1.0 / 2.4)  # Y′ of the HDR signal, gamma 2.4 on 1000 cd/m²
    yp = np.log1p((rho_hdr - 1.0) * y) / np.log(rho_hdr)  # perceptual linearisation
    yc = np.where(
        yp <= 0.7399,
        1.0770 * yp,
        np.where(yp < 0.9909, -1.1510 * yp**2 + 2.7811 * yp - 0.6302, 0.5 * yp + 0.5),
    )
    y_sdr = (rho_sdr**yc - 1.0) / (rho_sdr - 1.0)  # SDR Y′, gamma 2.4 on 100 cd/m²
    return np.clip(y_sdr, 0.0, 1.0) ** 2.4


# BT.2390 §5.4 EETF: Hermite roll-off in the PQ domain, from a 1000 cd/m² source to a 100 cd/m² SDR display.
_SRC_PEAK = 1000.0
_DST_PEAK = 100.0


def bt2390(s: np.ndarray) -> np.ndarray:
    src_max = float(C.pq_inverse_eotf(np.array(_SRC_PEAK)))
    max_lum = float(C.pq_inverse_eotf(np.array(_DST_PEAK))) / src_max
    ks = 1.5 * max_lum - 0.5
    e1 = np.clip(C.pq_inverse_eotf(s) / src_max, 0.0, 1.0)
    t = (e1 - ks) / (1.0 - ks)
    t2, t3 = t * t, t * t * t
    p = (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1.0 - ks) + (-2 * t3 + 3 * t2) * max_lum
    e2 = np.where(e1 < ks, e1, p)
    return np.clip(C.pq_eotf(e2 * src_max) / _DST_PEAK, 0.0, 1.0)


TONE: dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "hable203": hable203,
    "bt2446a": bt2446a,
    "bt2390": bt2390,
    "reinhard203": reinhard203,
}


def tone_map(lin709: np.ndarray, curve: str) -> np.ndarray:
    """T: scale each pixel by f(s)/s with s = max(r, g, b), so the RGB ratios (the hue) are kept."""
    s = np.maximum(lin709.max(axis=-1), _S_FLOOR)
    return lin709 * (TONE[curve](s) / s)[..., None]


def convert(rgb_e: np.ndarray, transfer: str, curve: str) -> np.ndarray:
    """S = ε ∘ T ∘ M ∘ ℓ: encoded BT.2020 HDR R′G′B′ → encoded BT.709 SDR R′G′B′ (≤ 1 except very bright Hable)."""
    return encode(tone_map(to_bt709_nits(rgb_e, transfer), curve))
