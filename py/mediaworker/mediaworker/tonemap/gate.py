"""The tone-curve validation gate (handoff §8.5); admins see its result next to the `tonemap_auto` setting.

    python -m mediaworker tonemap-gate --luts DIR --clips DIR --ffmpeg FF --ffprobe FP \\
        --chain-hlg VF --table-hlg VF --chain-pq VF --table-pq VF [--force]

The filters are passed in by the worker's gate script, so this tests the exact filter strings the encoder runs.
A table filter contains {lut}, replaced by the table's path.

1. Tables: generate them if luts.json is missing or out of date.
2. Acceptance: hable203 through lut3d against the verified zscale + tonemap chain, on synthetic HLG and PQ
   patterns and on the real source clip. Mean absolute difference < 2 code values (8-bit Y, U and V).
3. Validation: the scorer ranks the chapter's six reviewed clips (T_hable/mobius/reinhard_100/203) against
   their HDR source. It must put a Hable clip first: reviewers picked hable_203, and the chapter accepts hable_100.

Writes gate-passed.json (shown to admins as "validation passed") or gate-failed.json into --luts, each with a
fingerprint of the code, versions and filters. A result with the same fingerprint is reused unless --force.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
from importlib import metadata
from pathlib import Path
from typing import Any

import numpy as np

from . import curves, frames, luts
from .select import Scorer, candidate_codes, candidate_pu, ranks, reference_pu

PASSED = "gate-passed.json"
FAILED = "gate-failed.json"
ACCEPT_MEAN = 2.0  # code values
ALIGN_PSNR_DB = 30.0  # below this the reviewed clips don't line up with the source

# The chapter's review (Oct 2026): hable_203 best, hable_100 accepted too (29 Oct); Reinhard better than Möbius. The clips are 10 s cut from 5 s
# into the source (ffmpeg -ss 5 -t 10, zscale npl=100/203 → tonemap=<curve>:desat=0 → BT.709, scale=-2:720).
DEFAULT_CLIPS = {
    "source": "IMG_4515.MOV",
    "offset": 5.0,
    "transfer": "hlg",
    "clips": {n: f"T_{n}.mp4" for n in ("hable_100", "hable_203", "mobius_100", "mobius_203", "reinhard_100", "reinhard_203")},
    "best": ["hable_203", "hable_100"],
    "better": [["reinhard_203", "mobius_203"], ["reinhard_100", "mobius_100"]],
}


def _ff(ffmpeg: str, args: list[str], timeout: float = 600, stdin: bytes | None = None) -> bytes:
    """args end with the output; decoder, filter and encoder pools are capped (the host reports 64 CPUs)."""
    capped = ["-filter_threads", "1", "-threads", "1", *args[:-1], "-threads", "1", args[-1]]
    return subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-v", "error", "-y", *capped], input=stdin, capture_output=True, check=True, timeout=timeout).stdout


def pattern() -> np.ndarray:
    """Test frame in encoded BT.2020 R′G′B′: a 12³ colour cube in 16 px patches, a grey ramp and smooth blends."""
    n, px, cols = 12, 16, 48
    g = np.linspace(0.0, 1.0, n)
    r, gg, b = np.meshgrid(g, g, g, indexing="ij")
    cube = np.stack([r.ravel(), gg.ravel(), b.ravel()], -1)
    rows = -(-len(cube) // cols)
    img = np.zeros((rows * px + 64 + 128, cols * px, 3))
    for i, v in enumerate(cube):
        y, x = divmod(i, cols)
        img[y * px : (y + 1) * px, x * px : (x + 1) * px] = v
    w = img.shape[1]
    img[rows * px : rows * px + 64] = np.linspace(0.0, 1.0, w)[None, :, None]
    yy, xx = np.mgrid[0:128, 0:w] / np.array([127.0, w - 1.0])[:, None, None]
    img[rows * px + 64 :] = np.stack([xx, yy, 1.0 - xx * yy], -1)
    return img


def synthetic_clip(ffmpeg: str, transfer: str, out: Path) -> Path:
    img = pattern().astype(np.float32)
    h, w = img.shape[:2]
    planes = np.stack([img[..., 1], img[..., 2], img[..., 0]]).astype("<f4").tobytes()
    tin = {"hlg": "arib-std-b67", "pq": "smpte2084"}[transfer]
    _ff(ffmpeg, ["-f", "rawvideo", "-pix_fmt", "gbrpf32le", "-s", f"{w}x{h}", "-r", "1", "-i", "-",
                 "-vf", f"zscale=tin={tin}:pin=bt2020:min=gbr:rin=full:t={tin}:p=bt2020:m=bt2020nc:r=tv,format=yuv420p10le",
                 "-color_trc", tin, "-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-c:v", "ffv1", str(out)], stdin=planes)
    return out


def _yuv(ffmpeg: str, src: str, vf: str, seconds: float | None) -> np.ndarray:
    lim = ["-t", str(seconds)] if seconds else []
    return np.frombuffer(_ff(ffmpeg, [*lim, "-i", src, "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]), np.uint8)


def compare(ffmpeg: str, src: str, chain: str, table: str, seconds: float | None = None) -> dict[str, float]:
    a = _yuv(ffmpeg, src, chain, seconds).astype(np.int16)
    b = _yuv(ffmpeg, src, table, seconds).astype(np.int16)
    if a.shape != b.shape or not a.size:
        raise RuntimeError("chain and table produced different frame counts")
    d = np.abs(a - b)
    return {"mean": round(float(d.mean()), 4), "p99": float(np.percentile(d, 99)), "p999": float(np.percentile(d, 99.9)), "max": int(d.max())}


def with_lut(vf: str, lut: Path) -> str:
    return vf.replace("{lut}", str(lut).replace("'", "\\'"))


def acceptance(ffmpeg: str, lut_dir: Path, filters: dict[str, dict[str, str]], source: Path | None, source_transfer: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="acm-gate-", dir=os.environ.get("TMPDIR")) as tmp:
        for t in curves.TRANSFERS:
            clip = synthetic_clip(ffmpeg, t, Path(tmp) / f"pattern-{t}.mkv")
            table = with_lut(filters[t]["table"], lut_dir / luts.lut_name(curves.FALLBACK, t))
            out[f"pattern_{t}"] = compare(ffmpeg, str(clip), filters[t]["chain"], table)
    if source is not None:
        table = with_lut(filters[source_transfer]["table"], lut_dir / luts.lut_name(curves.FALLBACK, source_transfer))
        out["source"] = compare(ffmpeg, str(source), filters[source_transfer]["chain"], table, seconds=2)
    ok = all(v["mean"] < ACCEPT_MEAN for v in out.values())
    return {"ok": ok, "limit": ACCEPT_MEAN, "results": out}


def _psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    return 99.0 if mse == 0 else 10.0 * np.log10(1.0 / mse)


def validation(ffmpeg: str, ffprobe: str, lut_dir: Path, clip_dir: Path, spec: dict[str, Any], scorer: Scorer) -> dict[str, Any]:
    src = clip_dir / spec["source"]
    transfer = spec["transfer"]
    paths = {n: clip_dir / f for n, f in spec["clips"].items()}
    missing = [str(p.name) for p in [src, *paths.values()] if not p.exists()]
    if missing:
        return {"ok": False, "reason": "missing_clips", "missing": missing}
    first = frames.probe(ffprobe, str(next(iter(paths.values()))))
    dims = (first.width, first.height)
    duration = min(frames.probe(ffprobe, str(p)).duration for p in paths.values())
    times = [(i + 0.5) * duration / 8 for i in range(8)]
    hable = luts.read_cube(lut_dir / luts.lut_name(curves.FALLBACK, transfer))
    acc: dict[str, dict[str, list[float]]] = {m: {n: [] for n in paths} for m in ("dists", "topiq")}
    align: list[float] = []
    offset = float(spec.get("offset", 0.0))
    for t in times:
        x = frames.extract(ffmpeg, str(src), t + offset, dims, transfer)
        ref = reference_pu(x, transfer)
        ours = candidate_codes(hable, x)
        for n, p in paths.items():
            v = frames.extract(ffmpeg, str(p), t, dims, "sdr")
            if n == "hable_203":
                align.append(_psnr(ours, v))
            for m, s in scorer(ref, candidate_pu(v)).items():
                acc[m][n].append(s)
    means = {m: {n: float(np.mean(v)) for n, v in per.items()} for m, per in acc.items()}
    r = {m: ranks(means[m], scorer.lower_better[m]) for m in means}
    total = {n: r["dists"][n] + r["topiq"][n] for n in paths}
    order = sorted(paths, key=lambda n: (total[n], r["dists"][n]))
    aligned = float(np.median(align)) >= ALIGN_PSNR_DB
    agrees = {f"{a}>{b}": total[a] < total[b] for a, b in spec.get("better", [])}
    return {
        "ok": aligned and order[0] in spec["best"],
        "order": order,
        "expected_first": spec["best"],
        "also": agrees,
        "alignment_psnr_db": round(float(np.median(align)), 2),
        "aligned": aligned,
        "frames": [round(t, 3) for t in times],
        "size": list(dims),
        "scores": {n: {"dists": means["dists"][n], "topiq": means["topiq"][n], "r_dists": r["dists"][n], "r_topiq": r["topiq"][n], "sum": total[n]} for n in paths},
    }


def fingerprint(ffmpeg: str, filters: dict[str, dict[str, str]]) -> str:
    h = hashlib.sha256()
    for f in sorted(Path(__file__).parent.glob("*.py")):
        h.update(f.read_bytes())
    h.update(json.dumps(filters, sort_keys=True).encode())
    h.update(subprocess.run([ffmpeg, "-version"], capture_output=True, check=True, timeout=60).stdout.split(b"\n", 1)[0])
    # Installed versions from metadata: importing torch here cost seconds and memory on every deploy.
    try:
        h.update(f"{metadata.version('torch')} {metadata.version('pyiqa')}".encode())
    except metadata.PackageNotFoundError:
        h.update(b"no-torch")
    h.update(str(luts.LUT_VERSION).encode())
    return h.hexdigest()[:16]


def _write(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, path)


def run(lut_dir: Path, clip_dir: Path, ffmpeg: str, ffprobe: str, filters: dict[str, dict[str, str]], force: bool = False) -> dict[str, Any]:
    started = time.monotonic()
    fp = fingerprint(ffmpeg, filters)
    passed = lut_dir / PASSED
    # A failed result is reused too: re-running an unchanged gate fails the same way (it used to re-run every deploy).
    for prev_file in (() if force else (passed, lut_dir / FAILED)):
        try:
            prev = json.loads(prev_file.read_text())
            if prev.get("fingerprint") == fp:
                return {**prev, "reused": True}
        except (OSError, ValueError):
            pass
    table_info = luts.ensure(lut_dir)
    spec = DEFAULT_CLIPS
    if (clip_dir / "validation.json").exists():
        spec = {**DEFAULT_CLIPS, **json.loads((clip_dir / "validation.json").read_text())}
    source = clip_dir / spec["source"]
    acc = acceptance(ffmpeg, lut_dir, filters, source if source.exists() else None, spec["transfer"])
    try:
        val = validation(ffmpeg, ffprobe, lut_dir, clip_dir, spec, Scorer())
    except ImportError as e:
        val = {"ok": False, "reason": "no_scorer", "message": str(e)}
    result = {
        "ok": bool(acc["ok"] and val["ok"]),
        "fingerprint": fp,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "seconds": round(time.monotonic() - started, 1),
        "luts": {k: table_info[k] for k in ("version", "size", "generated")},
        "acceptance": acc,
        "validation": val,
    }
    if result["ok"]:
        _write(passed, result)
        (lut_dir / FAILED).unlink(missing_ok=True)
    else:
        _write(lut_dir / FAILED, result)
        passed.unlink(missing_ok=True)
    return {**result, "reused": False}


def main(argv: list[str]) -> dict[str, Any]:
    a = argparse.ArgumentParser(prog="mediaworker tonemap-gate")
    a.add_argument("--luts", required=True)
    a.add_argument("--clips", required=True)
    a.add_argument("--ffmpeg", default="ffmpeg")
    a.add_argument("--ffprobe", default="ffprobe")
    for t in curves.TRANSFERS:
        a.add_argument(f"--chain-{t}", required=True)
        a.add_argument(f"--table-{t}", required=True)
    a.add_argument("--force", action="store_true")
    o = a.parse_args(argv)
    filters = {t: {"chain": getattr(o, f"chain_{t}"), "table": getattr(o, f"table_{t}")} for t in curves.TRANSFERS}
    return run(Path(o.luts), Path(o.clips), o.ffmpeg, o.ffprobe, filters, o.force)
