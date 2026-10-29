"""The real scorer (pyiqa DISTS + TOPIQ-FR on the CPU) and, with -m validation, the gate's human-ranking check.

Needs torch and pyiqa with their weights in the cache (`python -m mediaworker tonemap-weights`). The validation
test also needs the reviewed clips: TONEMAP_CLIPS=<dir with IMG_4515.MOV and T_*.mp4> pytest -m validation
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("torch")
pytest.importorskip("pyiqa")

from mediaworker.tonemap import curves, gate, luts, select  # noqa: E402

pytestmark = pytest.mark.tonemap
FF = shutil.which("ffmpeg")
FP = shutil.which("ffprobe")
RNG = np.random.default_rng(3)


@pytest.fixture(scope="module")
def scorer() -> select.Scorer:
    return select.Scorer()


def test_metric_directions(scorer: select.Scorer):
    assert scorer.lower_better == {"dists": True, "topiq": False}


def test_identical_beats_degraded(scorer: select.Scorer):
    y, x = np.mgrid[0:256, 0:384] / np.array([255.0, 383.0])[:, None, None]
    ref = np.stack([x, y, 0.5 + 0.4 * np.sin(12 * x) * np.cos(9 * y)], -1)
    noisy = np.clip(ref + RNG.normal(0, 0.08, ref.shape), 0, 1)
    flat = np.full_like(ref, ref.mean())
    same, bad, worse = scorer(ref, ref), scorer(ref, noisy), scorer(ref, flat)
    assert same["dists"] < 0.02 < bad["dists"] < worse["dists"]
    assert same["topiq"] > bad["topiq"] > worse["topiq"]
    assert all(np.isfinite(v) for s in (same, bad, worse) for v in s.values())


@pytest.mark.skipif(not FF, reason="ffmpeg")
def test_select_end_to_end(tmp_path: Path):
    clip = tmp_path / "hlg.mp4"
    subprocess.run(
        [FF, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4",
         "-vf", "zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv,format=yuv420p10le",
         "-c:v", "libx265", "-x265-params", "log-level=none:keyint=30:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
         "-tag:v", "hvc1", str(clip)],
        check=True,
    )
    lut_dir = tmp_path / "luts"
    lut_dir.mkdir()
    for c in curves.CURVES:
        luts.write_cube(lut_dir / luts.lut_name(c, "hlg"), luts.build(c, "hlg", 33), "test")
    r = select.run(str(clip), "hlg", lut_dir, FF, FP, tmp_path / "frames", size=512)
    json.dumps(r)
    assert r["curve"] in curves.CURVES and r["source"] in ("auto", "fallback")
    assert len(r["candidates"]) == 4 and all(np.isfinite(c["dists"]) and np.isfinite(c["topiq"]) for c in r["candidates"])
    assert sorted(c["r_dists"] for c in r["candidates"]) == [1, 2, 3, 4] or len({c["dists"] for c in r["candidates"]}) < 4
    assert len(list((tmp_path / "frames").glob("*.webp"))) == len(r["frames"]) == 8
    print("\nselect on a 4 s 640×360 clip:", r["curve"], r["source"], r["ms"], f"{r['maxRssMb']} MB")


CLIPS = Path(os.environ.get("TONEMAP_CLIPS", ""))


@pytest.mark.validation
@pytest.mark.skipif(not (CLIPS / "IMG_4515.MOV").exists(), reason="set TONEMAP_CLIPS to the reviewed clips")
def test_reviewed_clips_rank_hable_first(tmp_path: Path, scorer: select.Scorer):
    lut_dir = tmp_path / "luts"
    lut_dir.mkdir()
    luts.write_cube(lut_dir / luts.lut_name("hable203", "hlg"), luts.build("hable203", "hlg"), "test")
    r = gate.validation(FF, FP, lut_dir, CLIPS, gate.DEFAULT_CLIPS, scorer)
    print("\n" + json.dumps({k: r[k] for k in ("order", "also", "alignment_psnr_db")}, indent=2))
    assert r["aligned"], "the reviewed clips don't line up with the source"
    assert r["order"][0] in ("hable_203", "hable_100"), r["order"]
    assert r["ok"]
