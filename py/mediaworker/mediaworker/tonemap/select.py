"""Automatic tone-curve choice for one HDR video (handoff §8.5).

    python -m mediaworker select --src SRC --transfer hlg|pq --luts DIR --ffmpeg FF --ffprobe FP \\
        --frames-out DIR [--size 1024]

1. Sample 8 frames: 6 at the centres of equal intervals (black or uniform ones skipped), 2 of the brightest.
2. Reference: each frame as BT.2100 renders it, in BT.709 light (cd/m²). Candidates: each curve's .cube table
   applied to the same encoded frame, quantised to 8 bits, then shown on a modelled 200 cd/m² SDR display.
3. PU21 puts both on one scale; DISTS and TOPIQ-FR score candidate against reference.
4. Average per metric, rank (1 = best, in each metric's own direction), pick the lowest rank sum.
5. Fall back to hable203 when the metrics disagree: either metric places the other's favourite 2 or more
   positions below its own.

Prints one JSON object. Writes the 8 frames, as converted by the chosen curve, to --frames-out as
<n>.webp (long edge 320) for the admin's Item details screen.
"""

from __future__ import annotations

import argparse
import contextlib
import resource
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import curves, frames, luts, pu21

METRICS = ("dists", "topiq")
PYIQA_NAMES = {"dists": "dists", "topiq": "topiq_fr"}
DISAGREE_POSITIONS = 2
THUMB_EDGE = 320


def ranks(values: dict[str, float], lower_better: bool) -> dict[str, float]:
    """1 = best. Ties share the average of the positions they cover."""
    order = sorted(values, key=lambda k: values[k] if lower_better else -values[k])
    out: dict[str, float] = {}
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in order[i : j + 1]:
            out[k] = (i + j) / 2.0 + 1.0
        i = j + 1
    return out


def choose(means: dict[str, dict[str, float]], lower_better: dict[str, bool]) -> dict[str, Any]:
    """means[metric][curve] → the chosen curve, whether it is the fallback, and the per-curve table."""
    cands = list(next(iter(means.values())))
    if any(not np.isfinite(v) for m in means.values() for v in m.values()):
        return {"curve": curves.FALLBACK, "source": "fallback", "reason": "score_not_finite", "candidates": []}
    r = {m: ranks(means[m], lower_better[m]) for m in METRICS}
    total = {c: r["dists"][c] + r["topiq"][c] for c in cands}
    # Ties: the fallback first, then the better DISTS rank, then the candidate order.
    best = min(cands, key=lambda c: (total[c], c != curves.FALLBACK, r["dists"][c], cands.index(c)))
    top = {m: min(cands, key=lambda c: (r[m][c], cands.index(c))) for m in METRICS}
    spread = max(r["topiq"][top["dists"]] - r["topiq"][top["topiq"]], r["dists"][top["topiq"]] - r["dists"][top["dists"]])
    table = [
        {"curve": c, "dists": means["dists"][c], "topiq": means["topiq"][c], "r_dists": r["dists"][c], "r_topiq": r["topiq"][c], "sum": total[c]}
        for c in cands
    ]
    if spread >= DISAGREE_POSITIONS:
        return {"curve": curves.FALLBACK, "source": "fallback", "reason": "metrics_disagree", "candidates": table, "best": best}
    return {"curve": best, "source": "auto", "reason": None, "candidates": table, "best": best}


class Scorer:
    """DISTS and TOPIQ-FR from pyiqa on the CPU. Weights must already be in the cache (see `weights`)."""

    def __init__(self, threads: int = 2) -> None:
        import torch
        import pyiqa

        torch.set_num_threads(threads)
        self._torch = torch
        with contextlib.redirect_stdout(sys.stderr):  # pyiqa logs to stdout; stdout carries our JSON
            self.metrics = {m: pyiqa.create_metric(PYIQA_NAMES[m], device=torch.device("cpu")) for m in METRICS}
        self.lower_better = {m: bool(self.metrics[m].lower_better) for m in METRICS}

    def _t(self, a: np.ndarray):  # (h, w, 3) → (1, 3, h, w) float32
        return self._torch.from_numpy(np.ascontiguousarray(a.transpose(2, 0, 1)[None], dtype=np.float32))

    def __call__(self, ref: np.ndarray, cand: np.ndarray) -> dict[str, float]:
        with self._torch.no_grad(), contextlib.redirect_stdout(sys.stderr):
            r, c = self._t(ref), self._t(cand)
            return {m: float(self.metrics[m](c, r).item()) for m in METRICS}


def reference_pu(rgb_e: np.ndarray, transfer: str) -> np.ndarray:
    return pu21.encode(curves.reference_nits(rgb_e, transfer))


def candidate_codes(table: np.ndarray, rgb_e: np.ndarray) -> np.ndarray:
    """Apply a table and keep what an 8-bit encode keeps."""
    return np.round(np.clip(luts.apply(table, rgb_e), 0.0, 1.0) * 255.0) / 255.0


def candidate_pu(v: np.ndarray) -> np.ndarray:
    return pu21.encode(pu21.sdr_display(v))


def thumb(v: np.ndarray):
    from PIL import Image

    im = Image.fromarray(np.round(v * 255.0).astype(np.uint8), "RGB")
    im.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.Resampling.LANCZOS)
    return im


def run(src: str, transfer: str, lut_dir: Path, ffmpeg: str, ffprobe: str, frames_out: Path, size: int = 1024, threads: int = 2) -> dict[str, Any]:
    started = time.monotonic()
    if transfer not in curves.TRANSFERS:
        raise ValueError(f"transfer must be one of {curves.TRANSFERS}")
    tables = {c: luts.read_cube(lut_dir / luts.lut_name(c, transfer)) for c in curves.CURVES}
    p = frames.probe(ffprobe, src)
    picks = frames.choose_times(p.duration, frames.proxy_scan(ffmpeg, src, p, transfer))
    if not picks:
        raise RuntimeError("no usable frames")
    dims = frames.fit(p.width, p.height, size)
    scorer = Scorer(threads)
    sampled = time.monotonic()
    # One frame at a time: at 1024 px a converted frame is ~14 MB, and 8 frames × 4 curves would not fit.
    acc: dict[str, dict[str, list[float]]] = {m: {c: [] for c in curves.CURVES} for m in METRICS}
    thumbs: dict[str, list[Any]] = {c: [] for c in curves.CURVES}
    convert_s = 0.0
    for q in picks:
        t0 = time.monotonic()
        x = frames.extract(ffmpeg, src, q.t, dims, transfer)
        ref = reference_pu(x, transfer)
        convert_s += time.monotonic() - t0
        for c in curves.CURVES:
            t0 = time.monotonic()
            v = candidate_codes(tables[c], x)
            thumbs[c].append(thumb(v))
            cand = candidate_pu(v)
            convert_s += time.monotonic() - t0
            for m, score in scorer(ref, cand).items():
                acc[m][c].append(score)
    means = {m: {c: float(np.mean(v)) for c, v in per.items()} for m, per in acc.items()}
    result = choose(means, scorer.lower_better)
    frames_out.mkdir(parents=True, exist_ok=True)
    for i, im in enumerate(thumbs[result["curve"]]):
        im.save(frames_out / f"{i}.webp", "WEBP", quality=80, method=4)
    total = time.monotonic() - started
    return {
        **result,
        "frames": [{"t": round(q.t, 3), "why": q.why} for q in picks],
        "size": list(dims),
        "lowerBetter": scorer.lower_better,
        "ms": {
            "total": round(total * 1000),
            "sample": round((sampled - started) * 1000),
            "convert": round(convert_s * 1000),
            "score": round((total - (sampled - started) - convert_s) * 1000),
        },
        "maxRssMb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024)),
    }


def main(argv: list[str]) -> dict[str, Any]:
    a = argparse.ArgumentParser(prog="mediaworker select")
    a.add_argument("--src", required=True)
    a.add_argument("--transfer", required=True, choices=curves.TRANSFERS)
    a.add_argument("--luts", required=True)
    a.add_argument("--ffmpeg", default="ffmpeg")
    a.add_argument("--ffprobe", default="ffprobe")
    a.add_argument("--frames-out", required=True)
    a.add_argument("--size", type=int, default=1024)
    a.add_argument("--threads", type=int, default=2)
    o = a.parse_args(argv)
    return run(o.src, o.transfer, Path(o.luts), o.ffmpeg, o.ffprobe, Path(o.frames_out), o.size, o.threads)
