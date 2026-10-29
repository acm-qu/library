"""Reading video frames with ffmpeg as float R′G′B′ arrays, and choosing which frames to score.

Frames come out still encoded (HLG or PQ for the original, BT.709 for SDR clips), the way the encoder's
lut3d sees them, so the candidates can be computed from the same numbers the tables will be applied to.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass

import numpy as np

from . import colour as C
from . import curves

_ZSCALE_IN = {
    # Convert YUV → RGB float only: transfer and primaries stay as they are.
    "hlg": "zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:t=arib-std-b67:p=bt2020",
    "pq": "zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:t=smpte2084:p=bt2020",
    "sdr": "zscale=tin=bt709:min=bt709:pin=bt709:t=bt709:p=bt709",
}


@dataclass(frozen=True)
class Probe:
    duration: float
    width: int  # as displayed, after rotation
    height: int
    transfer: str | None


@dataclass(frozen=True)
class Proxy:
    t: float
    p99_nits: float  # 99th-percentile luminance
    luma_std: float  # of the encoded luma; < 0.02 means black or near-uniform


@dataclass(frozen=True)
class Pick:
    t: float
    why: str  # 'even' (centre of an equal interval) or 'bright' (one of the brightest frames)


def probe(ffprobe: str, src: str) -> Probe:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", src],
        capture_output=True, check=True, timeout=60,
    ).stdout
    p = json.loads(out)
    v = next(s for s in p.get("streams", []) if s.get("codec_type") == "video")
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    w, h = int(v["width"]), int(v["height"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    transfer = {"arib-std-b67": "hlg", "smpte2084": "pq", "bt709": "sdr"}.get(v.get("color_transfer", ""))
    return Probe(float(p.get("format", {}).get("duration") or 0.0), w, h, transfer)


def fit(width: int, height: int, long_edge: int) -> tuple[int, int]:
    """Even dimensions with the given long edge (never upscaled) and the source's aspect ratio."""
    scale = min(1.0, long_edge / max(width, height))
    even = lambda x: max(2, int(round(x * scale / 2.0)) * 2)  # noqa: E731
    return even(width), even(height)


def _raw_to_rgb(raw: bytes, w: int, h: int) -> np.ndarray:
    """gbrpf32le planes → (frames, h, w, 3) RGB float64."""
    a = np.frombuffer(raw, dtype="<f4")
    n = a.size // (3 * w * h)
    a = a[: n * 3 * w * h].reshape(n, 3, h, w)
    return np.stack([a[:, 2], a[:, 0], a[:, 1]], axis=-1).astype(np.float64)


def _vf(size: tuple[int, int], kind: str) -> str:
    w, h = size
    return f"scale={w}:{h}:flags=area,{_ZSCALE_IN[kind]},format=gbrpf32le"


def extract(ffmpeg: str, src: str, t: float, size: tuple[int, int], kind: str, timeout: float = 120) -> np.ndarray:
    """One frame at time t (accurate seek), downscaled to size, as encoded R′G′B′ (h, w, 3)."""
    out = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-v", "error", "-threads", "2", "-ss", f"{t:.3f}", "-i", src,
         "-frames:v", "1", "-an", "-sn", "-dn", "-vf", _vf(size, kind), "-f", "rawvideo", "-"],
        capture_output=True, check=True, timeout=timeout,
    ).stdout
    frames = _raw_to_rgb(out, *size)
    if not len(frames):
        raise RuntimeError(f"no frame at {t:.2f}s")
    return frames[0]


def proxy_scan(ffmpeg: str, src: str, p: Probe, kind: str, long_edge: int = 160, timeout: float = 1800) -> list[Proxy]:
    """Every keyframe at a small size (about one per second on phones): brightness and uniformity per frame."""
    size = fit(p.width, p.height, long_edge)
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-v", "info", "-threads", "2", "-skip_frame", "nokey", "-i", src,
         "-an", "-sn", "-dn", "-fps_mode", "passthrough", "-vf", f"showinfo,{_vf(size, kind)}", "-f", "rawvideo", "-"],
        capture_output=True, check=True, timeout=timeout,
    )
    times = [float(m) for m in re.findall(r"pts_time:\s*(-?[\d.]+)", proc.stderr.decode("utf-8", "replace"))]
    frames = _raw_to_rgb(proc.stdout, *size)
    out = []
    for t, f in zip(times, frames):
        luma = f @ C.BT2020_Y if kind != "sdr" else f @ np.array([0.2126, 0.7152, 0.0722])
        nits = curves.decode(f, kind) @ C.BT2020_Y if kind != "sdr" else luma * 100.0
        out.append(Proxy(t, float(np.percentile(nits, 99)), float(luma.std())))
    return out


UNIFORM_STD = 0.02


def choose_times(duration: float, proxies: list[Proxy], n_even: int = 6, n_bright: int = 2) -> list[Pick]:
    """Handoff §8.5 step 1: n_even frames at the centres of equal intervals, skipping black or near-uniform
    ones (each moves to the nearest usable keyframe in its interval, or is dropped), then the frames with the
    highest 99th-percentile luminance until there are n_even + n_bright. Picks stay max(1 s, a 48th of the
    duration) apart, so the bright frames aren't near-copies of the others."""
    if duration <= 0:
        return []
    gap = min(max(duration / 48.0, 1.0), duration / 16.0)
    usable = [p for p in proxies if p.luma_std >= UNIFORM_STD]
    picks: list[Pick] = []
    for i in range(n_even):
        lo, hi = i * duration / n_even, (i + 1) * duration / n_even
        centre = (lo + hi) / 2.0
        inside = [p for p in proxies if lo <= p.t < hi]
        if not inside:  # no keyframe in this interval (short clip): trust the centre
            picks.append(Pick(centre, "even"))
            continue
        nearest = min(inside, key=lambda p: abs(p.t - centre))
        if nearest.luma_std >= UNIFORM_STD:
            picks.append(Pick(centre, "even"))
            continue
        ok = [p for p in inside if p.luma_std >= UNIFORM_STD]
        if ok:
            picks.append(Pick(min(ok, key=lambda p: abs(p.t - centre)).t, "even"))

    def far(t: float) -> bool:
        return all(abs(t - q.t) >= gap for q in picks)

    want = n_even + n_bright
    for p in sorted(usable, key=lambda p: -p.p99_nits):
        if len(picks) >= want:
            break
        if far(p.t):
            picks.append(Pick(p.t, "bright"))
    return sorted(picks, key=lambda q: q.t)
