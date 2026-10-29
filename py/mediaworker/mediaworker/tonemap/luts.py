"""65³ lookup tables for the candidate curves, written as .cube files for ffmpeg's lut3d.

Each table samples S = ε ∘ T ∘ M ∘ ℓ (curves.convert) on a grid over encoded BT.2020 HDR R′G′B′ and stores
encoded BT.709 SDR R′G′B′. Interpolation inside a grid cube is tetrahedral, like `lut3d=interp=tetrahedral`;
the cube's six tetrahedra are bounded by the planes r = g, g = b and r = b, which is exactly where max(r, g, b)
changes channel, so the curve's kinks fall on tetrahedron faces and the error stays O(Δ²).

    python -m mediaworker luts --out DIR [--size 65] [--force]

writes <curve>.<transfer>.cube for every curve and transfer plus luts.json, and skips the work when luts.json
already describes the same version and size.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import numpy as np

from . import curves

LUT_VERSION = 1  # bump whenever curves.py changes the tables' contents
DEFAULT_SIZE = 65
# Input range. Limited-range 10-bit video reaches E′ ≈ 1.09 (code 1019, "super-white"); zscale extrapolates there,
# so the tables cover it too instead of clamping bright highlights at E′ = 1.
DOMAIN_MAX = 1.1
MANIFEST = "luts.json"


def lut_name(curve: str, transfer: str) -> str:
    return f"{curve}.{transfer}.cube"


def build(curve: str, transfer: str, size: int = DEFAULT_SIZE) -> np.ndarray:
    """The table as an array indexed [r, g, b] → (r′, g′, b′)."""
    g = np.linspace(0.0, DOMAIN_MAX, size)
    r, gg, b = np.meshgrid(g, g, g, indexing="ij")
    return curves.convert(np.stack([r, gg, b], axis=-1), transfer, curve)


def write_cube(path: Path, table: np.ndarray, title: str) -> None:
    """.cube layout: red changes fastest, then green, then blue."""
    size = table.shape[0]
    rows = table.transpose(2, 1, 0, 3).reshape(-1, 3)  # [b, g, r] order → r fastest
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="ascii") as f:
        f.write(f'TITLE "{title}"\nLUT_3D_SIZE {size}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX {DOMAIN_MAX} {DOMAIN_MAX} {DOMAIN_MAX}\n')
        np.savetxt(f, rows, fmt="%.6f")
    os.replace(tmp, path)


def read_cube(path: Path) -> np.ndarray:
    size = 0
    data: list[str] = []
    with open(path, encoding="ascii") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("LUT_3D_SIZE"):
                size = int(s.split()[1])
            elif s.startswith("DOMAIN_MAX") and not np.allclose([float(v) for v in s.split()[1:]], DOMAIN_MAX):
                raise ValueError(f"{path}: domain {s} is not 0..{DOMAIN_MAX}")
            elif s[0].isdigit() or s[0] in "-.":
                data.append(s)
    rows = np.loadtxt(data, dtype=np.float64)
    if size == 0 or rows.shape != (size**3, 3):
        raise ValueError(f"{path}: not a {size}³ cube")
    return rows.reshape(size, size, size, 3).transpose(2, 1, 0, 3)  # back to [r, g, b]


def apply(table: np.ndarray, rgb: np.ndarray) -> np.ndarray:
    """Tetrahedral interpolation, case for case the same as ffmpeg's lut3d interp_tetrahedral."""
    n = table.shape[0]
    x = np.clip(rgb, 0.0, DOMAIN_MAX) * ((n - 1) / DOMAIN_MAX)
    i = np.minimum(np.floor(x).astype(np.int64), n - 2)
    f = x - i
    fr, fg, fb = (f[..., k][..., None] for k in range(3))
    ir, ig, ib = i[..., 0], i[..., 1], i[..., 2]

    def c(dr: int, dg: int, db: int) -> np.ndarray:
        return table[ir + dr, ig + dg, ib + db]

    c000, c111 = c(0, 0, 0), c(1, 1, 1)
    out = np.empty(rgb.shape, dtype=np.float64)
    # ffmpeg's branches: r>g → (g>b | r>b | else); otherwise → (b>g | b>r | else).
    rg, gb, rb, bg, br = ((u > v)[..., 0] for u, v in ((fr, fg), (fg, fb), (fr, fb), (fb, fg), (fb, fr)))
    cases = [
        (rg & gb, (1 - fr), c(1, 0, 0), (fr - fg), c(1, 1, 0), (fg - fb), fb),
        (rg & ~gb & rb, (1 - fr), c(1, 0, 0), (fr - fb), c(1, 0, 1), (fb - fg), fg),
        (rg & ~gb & ~rb, (1 - fb), c(0, 0, 1), (fb - fr), c(1, 0, 1), (fr - fg), fg),
        (~rg & bg, (1 - fb), c(0, 0, 1), (fb - fg), c(0, 1, 1), (fg - fr), fr),
        (~rg & ~bg & br, (1 - fg), c(0, 1, 0), (fg - fb), c(0, 1, 1), (fb - fr), fr),
        (~rg & ~bg & ~br, (1 - fg), c(0, 1, 0), (fg - fr), c(1, 1, 0), (fr - fb), fb),
    ]
    for mask, w0, ca, wa, cb, wb, w1 in cases:
        if mask.any():
            out[mask] = (w0 * c000 + wa * ca + wb * cb + w1 * c111)[mask]
    return out


def ensure(out: Path, size: int = DEFAULT_SIZE, force: bool = False) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / MANIFEST
    want = {"version": LUT_VERSION, "size": size, "curves": list(curves.CURVES), "transfers": list(curves.TRANSFERS)}
    files = [lut_name(c, t) for c in curves.CURVES for t in curves.TRANSFERS]
    if not force and manifest_path.exists():
        try:
            have = json.loads(manifest_path.read_text())
        except ValueError:
            have = {}
        if {k: have.get(k) for k in want} == want and all((out / f).exists() for f in files):
            return {**have, "dir": str(out), "generated": False}
    for c in curves.CURVES:
        for t in curves.TRANSFERS:
            write_cube(out / lut_name(c, t), build(c, t, size), f"acm-media {c} {t} v{LUT_VERSION}")
    manifest = {**want, "files": files}
    tmp = manifest_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    os.replace(tmp, manifest_path)
    return {**manifest, "dir": str(out), "generated": True}


def main(argv: list[str]) -> dict[str, Any]:
    p = argparse.ArgumentParser(prog="mediaworker luts")
    p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=DEFAULT_SIZE)
    p.add_argument("--force", action="store_true")
    a = p.parse_args(argv)
    return ensure(Path(a.out), a.size, a.force)
