"""Tone mapping against a real ffmpeg: the table path's acceptance test, frame extraction, and the whole selection
pipeline with a stand-in scorer. The real DISTS/TOPIQ scorer is in test_tonemap_scorer.py (needs torch)."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from mediaworker.tonemap import curves, frames, gate, luts, select

FF = shutil.which("ffmpeg")
FP = shutil.which("ffprobe")


def _has_filters() -> bool:
    if not FF:
        return False
    out = subprocess.run([FF, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    return all(f" {f} " in out for f in ("zscale", "lut3d", "tonemap"))


pytestmark = [pytest.mark.ffmpeg, pytest.mark.skipif(not _has_filters(), reason="ffmpeg with zscale, lut3d and tonemap")]

# The encoder's filters (apps/worker/src/lib/ffmpeg.ts baseFilter); the gate itself receives them from the worker.
def chain(t: str) -> str:
    return f"zscale=tin={t}:min=bt2020nc:pin=bt2020:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"


def table(t: str) -> str:
    return f"zscale=tin={t}:min=bt2020nc:pin=bt2020:t={t}:p=bt2020,format=gbrpf32le,lut3d=file='{{lut}}':interp=tetrahedral,zscale=tin=bt709:pin=bt709:t=bt709:p=bt709:m=bt709:r=tv,format=yuv420p"


TIN = {"hlg": "arib-std-b67", "pq": "smpte2084"}
FILTERS = {t: {"chain": chain(TIN[t]), "table": table(TIN[t])} for t in curves.TRANSFERS}


@pytest.fixture(scope="module")
def lut_dir(tmp_path_factory) -> Path:
    """Full-size Hable tables (what the acceptance test needs) and small ones for the other curves (HLG only)."""
    d = tmp_path_factory.mktemp("luts")
    for t in curves.TRANSFERS:
        luts.write_cube(d / luts.lut_name("hable203", t), luts.build("hable203", t), "test")
    for c in curves.CURVES[1:]:
        luts.write_cube(d / luts.lut_name(c, "hlg"), luts.build(c, "hlg", 17), "test")
    return d


@pytest.fixture(scope="module")
def hlg_clip(tmp_path_factory) -> Path:
    """6 s of moving test pattern, 10-bit HEVC tagged HLG, a keyframe every second, with a black second at 1–2 s."""
    out = tmp_path_factory.mktemp("clip") / "hlg.mp4"
    subprocess.run(
        [FF, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "6",
         "-vf", "drawbox=enable='between(t,1,1.9)':x=0:y=0:w=iw:h=ih:color=black:t=fill,"
                 "zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv,format=yuv420p10le",
         "-pix_fmt", "yuv420p10le", "-c:v", "libx265",
         "-x265-params", "log-level=none:keyint=30:min-keyint=30:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
         "-color_trc", "arib-std-b67", "-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-tag:v", "hvc1", str(out)],
        check=True,
    )
    return out


@pytest.mark.parametrize("transfer", curves.TRANSFERS)
def test_table_path_matches_the_verified_chain(lut_dir: Path, tmp_path: Path, transfer: str):
    clip = gate.synthetic_clip(FF, transfer, tmp_path / f"p-{transfer}.mkv")
    r = gate.compare(FF, str(clip), FILTERS[transfer]["chain"], gate.with_lut(FILTERS[transfer]["table"], lut_dir / luts.lut_name("hable203", transfer)))
    # The gate's limit is a mean of 2 code values. This pattern is nearly all saturated colour, where the table is
    # least exact (a channel crossing 0 after the BT.709 matrix), and its sharp patch edges stress 4:2:0 chroma, so
    # the tail is checked at the 99th percentile. Camera footage measures ~0.02 (IMG_4515.MOV, in the gate).
    assert r["mean"] < 0.5, r
    assert r["p99"] <= 4, r


def test_old_table_filter_converted_twice(lut_dir: Path, tmp_path: Path):
    # Regression: without tin/pin on the last zscale, the transfer and primaries were converted a second time.
    clip = gate.synthetic_clip(FF, "hlg", tmp_path / "p.mkv")
    old = FILTERS["hlg"]["table"].replace("zscale=tin=bt709:pin=bt709:t=bt709", "zscale=t=bt709")
    r = gate.compare(FF, str(clip), FILTERS["hlg"]["chain"], gate.with_lut(old, lut_dir / "hable203.hlg.cube"))
    assert r["mean"] > 10


def test_acceptance_reports_every_clip(lut_dir: Path, hlg_clip: Path):
    r = gate.acceptance(FF, lut_dir, FILTERS, hlg_clip, "hlg")
    assert r["ok"] and set(r["results"]) == {"pattern_hlg", "pattern_pq", "source"}
    assert all(v["mean"] < gate.ACCEPT_MEAN for v in r["results"].values())


def test_probe_extract_and_proxy_scan(hlg_clip: Path):
    p = frames.probe(FP, str(hlg_clip))
    assert (p.width, p.height, p.transfer) == (640, 360, "hlg") and p.duration == pytest.approx(6, abs=0.1)
    x = frames.extract(FF, str(hlg_clip), 3.0, (320, 180), "hlg")
    assert x.shape == (180, 320, 3) and -0.05 <= x.min() and x.max() <= luts.DOMAIN_MAX
    prox = frames.proxy_scan(FF, str(hlg_clip), p, "hlg")
    assert [round(q.t) for q in prox] == [0, 1, 2, 3, 4, 5]  # one keyframe a second
    black = next(q for q in prox if round(q.t) == 1)
    assert black.luma_std < frames.UNIFORM_STD and black.p99_nits < 1
    assert all(q.luma_std > frames.UNIFORM_STD for q in prox if round(q.t) != 1)


class FakeScorer:
    """Deterministic stand-in for DISTS/TOPIQ: distance and similarity between the PU21 images."""

    lower_better = {"dists": True, "topiq": False}

    def __init__(self, *_a, **_k) -> None:
        self.calls = 0

    def __call__(self, ref: np.ndarray, cand: np.ndarray) -> dict[str, float]:
        self.calls += 1
        d = float(np.abs(ref - cand).mean())
        return {"dists": d, "topiq": 1.0 - d}


def test_select_pipeline_with_a_stand_in_scorer(monkeypatch, lut_dir: Path, hlg_clip: Path, tmp_path: Path):
    monkeypatch.setattr(select, "Scorer", FakeScorer)
    out = tmp_path / "frames"
    r = select.run(str(hlg_clip), "hlg", lut_dir, FF, FP, out, size=320)
    json.dumps(r)  # the worker reads it as JSON
    assert r["source"] == "auto" and r["curve"] in curves.CURVES  # the two fake metrics always agree
    assert {c["curve"] for c in r["candidates"]} == set(curves.CURVES)
    assert len(r["frames"]) == 8 and r["size"] == [320, 180]
    assert not any(1.0 <= f["t"] < 2.0 for f in r["frames"]), "the black second is skipped"
    assert sorted(p.name for p in out.iterdir()) == [f"{i}.webp" for i in range(8)]
    best = min(r["candidates"], key=lambda c: c["sum"])
    assert best["curve"] == r["curve"] and best["r_dists"] == 1 and best["r_topiq"] == 1


def test_select_cli_prints_one_json_object_and_fails_cleanly(lut_dir: Path, tmp_path: Path):
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])}
    bad = subprocess.run(
        [os.sys.executable, "-m", "mediaworker", "select", "--src", str(tmp_path / "missing.mov"), "--transfer", "hlg",
         "--luts", str(lut_dir), "--ffmpeg", FF, "--ffprobe", FP, "--frames-out", str(tmp_path / "f")],
        capture_output=True, text=True, env=env,
    )
    assert bad.returncode == 1 and "error" in json.loads(bad.stdout)
