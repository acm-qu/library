"""Tone-curve maths, tables, ranking and frame choice. No ffmpeg or torch needed."""

from pathlib import Path

import numpy as np
import pytest

from mediaworker.tonemap import colour as C
from mediaworker.tonemap import curves, frames, luts, pu21
from mediaworker.tonemap.frames import Pick, Proxy
from mediaworker.tonemap.select import choose, ranks

RNG = np.random.default_rng(7)


# ── colour ────────────────────────────────────────────────────────────────────────────────────────────


def test_hlg_round_trip_and_constants():
    e = np.linspace(0, 1, 1001)
    assert np.allclose(C.hlg_oetf(C.hlg_inverse_oetf(e)), e, atol=1e-9)
    assert C.hlg_inverse_oetf(np.array(0.5)) == pytest.approx(1 / 12)  # the two pieces meet at E′ = 0.5
    assert C.hlg_inverse_oetf(np.array(1.0)) == pytest.approx(1.0, abs=1e-6)
    assert C.hlg_inverse_oetf(np.array(-0.2)) == 0.0
    assert C.hlg_inverse_oetf(np.array(1.09)) > 1.5  # super-white extrapolates, as zscale does


def test_hlg_reference_white_is_203_nits_both_ways():
    grey = np.full((1, 3), 0.75)
    assert C.hlg_to_nits(grey)[0, 0] == pytest.approx(203, abs=0.5)  # BT.2100 OOTF (luminance-based)
    assert curves.zimg_hlg_to_nits(grey)[0, 0] == pytest.approx(203, abs=0.5)  # zimg: per channel
    # On a saturated colour the two disagree; the encoder uses zimg's.
    red = np.array([[1.0, 0.0, 0.0]])
    assert curves.zimg_hlg_to_nits(red)[0, 0] == pytest.approx(1000, abs=0.01)
    assert C.hlg_to_nits(red)[0, 0] == pytest.approx(1000 * 0.2627**0.2, rel=1e-6)


def test_pq_round_trip_and_known_points():
    nits = np.array([0.0, 0.01, 1, 100, 203, 1000, 10000])
    assert np.allclose(C.pq_eotf(C.pq_inverse_eotf(nits)), nits, rtol=1e-9, atol=1e-9)
    assert C.pq_inverse_eotf(np.array(100.0)) == pytest.approx(0.5081, abs=1e-4)
    assert C.pq_inverse_eotf(np.array(1000.0)) == pytest.approx(0.7518, abs=1e-4)


def test_bt2020_to_bt709_matrix():
    m = C.BT2020_TO_BT709
    assert np.allclose(m.sum(axis=1), 1.0)  # white stays white
    expected = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]]  # BT.2087
    assert np.allclose(m, expected, atol=1e-4)


def test_reference_uses_the_bt2100_ootf():
    grey = np.full((1, 3), 0.75)
    assert curves.reference_nits(grey, "hlg")[0, 0] == pytest.approx(203, abs=0.5)
    sat = np.array([[0.9, 0.2, 0.1]])
    # Saturated: BT.2100 scales by luminance, so it is dimmer than zimg's per-channel decode.
    assert curves.reference_nits(sat, "hlg").max() < curves.to_bt709_nits(sat, "hlg").max()
    pq = np.array([[0.6, 0.5, 0.4]])
    assert np.allclose(curves.reference_nits(pq, "pq"), curves.to_bt709_nits(pq, "pq"))


def test_bt709_oetf_round_trip():
    lin = np.linspace(0, 1, 1001)
    assert np.allclose(C.bt709_inverse_oetf(C.bt709_oetf(lin)), lin, atol=1e-9)


# ── curves ────────────────────────────────────────────────────────────────────────────────────────────

S = np.concatenate([np.linspace(0, 1, 200), np.geomspace(1, 1000, 400)])


@pytest.mark.parametrize("curve", curves.CURVES)
def test_curves_are_tone_curves(curve):
    f = curves.TONE[curve]
    y = f(S)
    assert f(np.array([0.0]))[0] == pytest.approx(0.0, abs=1e-6)
    assert np.all(np.diff(y) >= -1e-12), "brighter must stay brighter"
    assert np.all((y >= 0) & (y <= 1.0 + 1e-12))
    assert np.all(np.diff(f(np.geomspace(1, 900, 200))) > 0), "strictly increasing below the source peak"


def test_hable203_matches_ffmpeg_tonemap():
    def hable(x):
        a, b, c, d, e, f = 0.15, 0.50, 0.10, 0.20, 0.02, 0.30
        return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f

    x = S / 203
    assert np.allclose(curves.hable203(S), hable(x) / hable(10.0))


def test_reinhard203_and_bt2390_reference_points():
    assert curves.reinhard203(np.array(203.0)) == pytest.approx(0.5)
    # BT.2390 leaves everything below the knee alone (in the PQ domain), so low light passes through.
    assert curves.bt2390(np.array(10.0)) == pytest.approx(10.0 / 100.0, rel=1e-6)
    assert curves.bt2390(np.array(1000.0)) == pytest.approx(1.0, abs=1e-6)


def test_bt2446a_reference_white():
    # Hand-computed from BT.2446 §5.1.1 for 203 cd/m² on a 1000 cd/m² source: Y′_SDR ≈ 0.687.
    assert curves.bt2446a(np.array(203.0)) ** (1 / 2.4) == pytest.approx(0.687, abs=0.002)
    assert curves.bt2446a(np.array(1000.0)) == pytest.approx(1.0, abs=1e-9)


@pytest.mark.parametrize("curve", curves.CURVES)
def test_tone_map_keeps_hue(curve):
    lin = RNG.uniform(1, 800, size=(500, 3))
    out = curves.tone_map(lin, curve)
    assert np.allclose(out / out.max(-1, keepdims=True), lin / lin.max(-1, keepdims=True), atol=1e-9)


@pytest.mark.parametrize("transfer", curves.TRANSFERS)
def test_convert_black_white_and_range(transfer):
    rgb = RNG.uniform(0, 1, size=(2000, 3))
    out = curves.convert(rgb, transfer, "hable203")
    assert out.min() >= 0 and out.max() <= (1 if transfer == "hlg" else 1.15)  # PQ above 2030 cd/m² exceeds 1
    for c in ("bt2446a", "bt2390", "reinhard203"):
        assert curves.convert(rgb, transfer, c).max() <= 1 + 1e-9
    assert np.allclose(curves.convert(np.zeros((1, 3)), transfer, "bt2390"), 0)
    grey = curves.convert(np.full((1, 3), 0.75 if transfer == "hlg" else 0.58), transfer, "reinhard203")
    assert np.ptp(grey) < 1e-9  # greys stay grey


# ── PU21 ──────────────────────────────────────────────────────────────────────────────────────────────


def test_pu21_is_mantiuk_azimi_banding_glare():
    # Reference values of PU21 (banding + glare): ~0 at the bottom of the range, ~256 at 100 cd/m² (an 8-bit SDR
    # white), ~595 at 10 000 cd/m².
    assert pu21.pu21(np.array(0.005)) < 0.5
    assert pu21.pu21(np.array(100.0)) == pytest.approx(256.4, abs=0.5)
    assert pu21.pu21(np.array(10000.0)) == pytest.approx(595.4, abs=0.5)
    # Not the quadratic in log₂ L from the pipeline notes, which puts 100 cd/m² at half of its range.
    u = np.log2(100 / 0.005)
    assert (0.001908 * u * u + 0.0078 * u) == pytest.approx(0.5, abs=0.01)
    assert pu21.encode(np.array(100.0)) == pytest.approx(256.4 / 595.4, abs=0.002)


def test_pu21_scale():
    assert pu21.encode(np.array(0.005)) == pytest.approx(0.0, abs=1e-3)
    assert pu21.encode(np.array(10000.0)) == pytest.approx(1.0)
    assert pu21.encode(np.array(0.0)) == pytest.approx(pu21.encode(np.array(0.005)))  # clamped at 0.005
    lum = np.geomspace(0.005, 10000, 500)
    assert np.all(np.diff(pu21.encode(lum)) > 0)
    assert pu21.sdr_display(np.array(0.0)) == pytest.approx(0.2)
    assert pu21.sdr_display(np.array(1.0)) == pytest.approx(200.0)


# ── tables ────────────────────────────────────────────────────────────────────────────────────────────


def test_cube_round_trip_and_red_fastest(tmp_path: Path):
    t = luts.build("reinhard203", "hlg", 9)
    p = tmp_path / "t.cube"
    luts.write_cube(p, t, "test")
    lines = [l for l in p.read_text().splitlines() if l and l[0].isdigit()]
    assert len(lines) == 9**3
    assert np.allclose([float(v) for v in lines[1].split()], t[1, 0, 0], atol=1e-6)  # second row: r = 1
    assert np.allclose([float(v) for v in lines[9].split()], t[0, 1, 0], atol=1e-6)  # then g
    assert np.allclose(luts.read_cube(p), t, atol=1e-6)


def test_tetrahedral_is_exact_on_grid_and_close_between():
    t = luts.build("hable203", "hlg", 65)
    g = np.linspace(0, luts.DOMAIN_MAX, 65)
    nodes = np.stack(np.meshgrid(g[::8], g[::8], g[::8], indexing="ij"), -1).reshape(-1, 3)
    assert np.allclose(luts.apply(t, nodes), curves.convert(nodes, "hlg", "hable203"), atol=1e-12)
    pts = RNG.uniform(0, 1, size=(20000, 3))
    err = np.abs(luts.apply(t, pts) - curves.convert(pts, "hlg", "hable203")) * 255
    # Uniform random R′G′B′ is mostly saturated colour. The worst cells sit where a channel falls to 0 after
    # the BT.709 matrix: the clip and the steep 1/2.4 power there aren't aligned with the tetrahedra. That
    # channel then carries well under 1% of the pixel's light.
    assert err.mean() < 0.1 and np.percentile(err, 99) < 2.5
    greys = np.repeat(RNG.uniform(0, 1, size=(2000, 1)), 3, axis=1)
    assert np.abs(luts.apply(t, greys) - curves.convert(greys, "hlg", "hable203")).max() * 255 < 0.25


def test_tetrahedral_reproduces_linear_tables_exactly():
    # Any affine map is reproduced exactly by tetrahedral interpolation, whichever tetrahedron is used.
    g = np.linspace(0, luts.DOMAIN_MAX, 5)
    grid = np.stack(np.meshgrid(g, g, g, indexing="ij"), -1)
    m = np.array([[0.2, 0.5, 0.3], [0.1, 0.1, 0.8], [0.6, 0.3, 0.1]])
    pts = RNG.uniform(0, 1, size=(5000, 3))
    assert np.allclose(luts.apply(grid @ m.T, pts), pts @ m.T, atol=1e-12)


def test_ensure_writes_once(tmp_path: Path):
    first = luts.ensure(tmp_path, size=5)
    assert first["generated"] and len(first["files"]) == len(curves.CURVES) * len(curves.TRANSFERS)
    assert not luts.ensure(tmp_path, size=5)["generated"]
    (tmp_path / luts.lut_name("bt2390", "pq")).unlink()
    assert luts.ensure(tmp_path, size=5)["generated"]
    assert luts.ensure(tmp_path, size=7)["generated"]  # a different size is a different table set


# ── ranking and choice ────────────────────────────────────────────────────────────────────────────────


def test_ranks_direction_and_ties():
    assert ranks({"a": 0.1, "b": 0.3, "c": 0.2}, lower_better=True) == {"a": 1, "c": 2, "b": 3}
    assert ranks({"a": 0.1, "b": 0.3, "c": 0.2}, lower_better=False) == {"b": 1, "c": 2, "a": 3}
    assert ranks({"a": 1.0, "b": 1.0, "c": 2.0}, lower_better=True) == {"a": 1.5, "b": 1.5, "c": 3}


LB = {"dists": True, "topiq": False}


def means(d: list[float], t: list[float]) -> dict:
    return {"dists": dict(zip(curves.CURVES, d)), "topiq": dict(zip(curves.CURVES, t))}


def test_choose_agreeing_metrics_pick_the_lowest_rank_sum():
    # CURVES order: hable203, bt2446a, bt2390, reinhard203. Both metrics like bt2390 best.
    r = choose(means([0.20, 0.15, 0.10, 0.30], [0.60, 0.70, 0.80, 0.50]), LB)
    assert (r["curve"], r["source"]) == ("bt2390", "auto")
    row = next(c for c in r["candidates"] if c["curve"] == "bt2390")
    assert (row["r_dists"], row["r_topiq"], row["sum"]) == (1, 1, 2)


def test_choose_falls_back_when_metrics_disagree_by_two_positions():
    # DISTS's favourite (bt2390) is third for TOPIQ, whose favourite (reinhard203) is last for DISTS.
    r = choose(means([0.20, 0.15, 0.10, 0.30], [0.60, 0.65, 0.55, 0.80]), LB)
    assert (r["curve"], r["source"], r["reason"]) == ("hable203", "fallback", "metrics_disagree")
    assert r["best"] in curves.CURVES


def test_choose_one_position_apart_is_not_disagreement():
    r = choose(means([0.10, 0.15, 0.20, 0.30], [0.70, 0.80, 0.60, 0.50]), LB)  # hable: 1st and 2nd
    assert r["source"] == "auto"


def test_choose_ties_prefer_the_fallback():
    r = choose(means([0.10, 0.10, 0.30, 0.40], [0.80, 0.80, 0.60, 0.50]), LB)
    assert r["curve"] == "hable203" and r["source"] == "auto"


def test_choose_non_finite_scores_fall_back():
    r = choose(means([0.1, float("nan"), 0.2, 0.3], [0.5, 0.6, 0.7, 0.8]), LB)
    assert (r["curve"], r["source"], r["reason"]) == ("hable203", "fallback", "score_not_finite")


# ── frame choice ──────────────────────────────────────────────────────────────────────────────────────


def proxies(duration: float, *, dark: set[int] = frozenset(), bright: dict[int, float] | None = None) -> list[Proxy]:
    bright = bright or {}
    return [Proxy(float(t), bright.get(t, 100.0), 0.001 if t in dark else 0.2) for t in range(int(duration))]


def test_choose_times_six_even_plus_two_brightest():
    picks = frames.choose_times(60, proxies(60, bright={3: 900.0, 4: 880.0, 48: 850.0}))
    assert [p.t for p in picks if p.why == "even"] == [5, 15, 25, 35, 45, 55]
    assert sorted(p.t for p in picks if p.why == "bright") == [3, 48]  # 4 is within 1.25 s of 3 and of 5
    assert picks == sorted(picks, key=lambda p: p.t)


def test_choose_times_moves_off_black_frames():
    # The centre of the first interval (5 s) is black, so the nearest usable keyframe stands in.
    picks = frames.choose_times(60, proxies(60, dark={4, 5, 6}))
    assert [p for p in picks if p.why == "even"][0] in (Pick(3.0, "even"), Pick(7.0, "even"))
    assert len(picks) == 8


def test_choose_times_drops_an_all_black_interval_and_fills_with_bright_frames():
    picks = frames.choose_times(60, proxies(60, dark=set(range(0, 10))))
    assert len([p for p in picks if p.why == "even"]) == 5
    assert len(picks) == 8 and all(p.t >= 10 for p in picks)


def test_choose_times_short_clip_without_keyframes():
    picks = frames.choose_times(2.0, [Proxy(0.0, 50.0, 0.3)])
    assert len([p for p in picks if p.why == "even"]) == 6
    assert frames.choose_times(0, []) == []


def test_fit_keeps_aspect_and_even_sizes():
    assert frames.fit(1080, 1920, 1024) == (576, 1024)
    assert frames.fit(1920, 1080, 1024) == (1024, 576)
    assert frames.fit(640, 360, 1024) == (640, 360)  # never upscaled
    w, h = frames.fit(1080, 1920, 720)
    assert h == 720 and w % 2 == 0


# ── gate ──────────────────────────────────────────────────────────────────────────────────────────────


def test_gate_reuses_a_failed_result_with_the_same_fingerprint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from mediaworker.tonemap import gate

    monkeypatch.setattr(gate, "fingerprint", lambda *_: "fp1")
    monkeypatch.setattr(gate.luts, "ensure", lambda *_: pytest.fail("an unchanged gate must not re-run"))
    (tmp_path / gate.FAILED).write_text('{"ok": false, "fingerprint": "fp1"}')
    r = gate.run(tmp_path, tmp_path, "ffmpeg", "ffprobe", {})
    assert r == {"ok": False, "fingerprint": "fp1", "reused": True}


def test_scan_readrate_keeps_reads_under_budget(tmp_path):
    from mediaworker.tonemap import frames
    f = tmp_path / "clip.mov"
    f.write_bytes(b"\0" * (16 * 2**20))  # 16 MiB over 1 s = 16 MiB/s → 5/16 = 0.31x real time
    assert frames.readrate(str(f), 1.0) == ["-readrate", "0.31"]
    assert frames.readrate(str(f), 0.01) == ["-readrate", "0.05"]  # absurd bitrate: the floor
    assert frames.readrate(str(f), 0.0) == []
