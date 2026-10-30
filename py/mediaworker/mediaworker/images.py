"""Image renditions (handoff §8.3).

``python -m mediaworker images --src FILE --out DIR`` writes:

- ``view.webp``  long edge <= 2560, quality 82, method 4
- ``thumb.webp`` long edge <= 480, quality 75

and prints one JSON object with the oriented size, capture time, camera and whether the still is true HDR.
Never upscales. EXIF rotation is applied, embedded ICC profiles (iPhone Display P3) are converted to sRGB,
and transparency is flattened onto white.
"""

from __future__ import annotations

import io
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageCms, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover - the worker venv always has it
    pillow_heif = None

VIEW_EDGE, VIEW_Q = 2560, 82
THUMB_EDGE, THUMB_Q = 480, 75
Image.MAX_IMAGE_PIXELS = 250_000_000  # ~16k x 16k; larger is almost certainly not a photo

_SRGB = ImageCms.createProfile("sRGB")

EXIF_DATETIME_ORIGINAL = 0x9003
EXIF_OFFSET_TIME_ORIGINAL = 0x9011
EXIF_IFD = 0x8769
EXIF_MAKE, EXIF_MODEL = 0x010F, 0x0110


def _to_srgb(im: Image.Image) -> Image.Image:
    icc = im.info.get("icc_profile")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            mode = "RGBA" if im.mode in ("RGBA", "LA", "PA") else "RGB"
            im = ImageCms.profileToProfile(im.convert(mode), src, _SRGB, outputMode=mode, renderingIntent=ImageCms.Intent.PERCEPTUAL)
        except (ImageCms.PyCMSError, OSError, ValueError):
            pass  # a broken profile is treated as sRGB rather than failing the photo
    return im


def _flatten(im: Image.Image) -> Image.Image:
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.getchannel("A"))
        return bg
    return im.convert("RGB")


def _fit(im: Image.Image, edge: int) -> Image.Image:
    if max(im.size) <= edge:
        return im
    out = im.copy()
    out.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    return out


def _captured_at(exif: Image.Exif) -> str | None:
    sub = exif.get_ifd(EXIF_IFD)
    raw = sub.get(EXIF_DATETIME_ORIGINAL) or exif.get(0x0132)
    if not raw:
        return None
    try:
        dt = datetime.strptime(str(raw).strip("\x00 "), "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    offset = str(sub.get(EXIF_OFFSET_TIME_ORIGINAL) or "").strip("\x00 ")
    if len(offset) == 6 and offset[0] in "+-":
        sign = 1 if offset[0] == "+" else -1
        tz = timezone(sign * timedelta(hours=int(offset[1:3]), minutes=int(offset[4:6])))
        return dt.replace(tzinfo=tz).isoformat()
    return dt.isoformat()  # naive: local time of the camera, offset unknown


def _is_hdr_still(im: Image.Image) -> bool:
    """A PQ/HLG still with no SDR base can't be shown faithfully without tone mapping (needs review in v1)."""
    nclx = im.info.get("nclx_profile") or {}
    transfer = nclx.get("transfer_characteristics") if isinstance(nclx, dict) else None
    return transfer in (16, 18)  # SMPTE ST 2084 (PQ), ARIB STD-B67 (HLG)


def process(src: str, out: str, allow_hdr: bool = False) -> dict[str, Any]:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as opened:
        opened.load()
        exif = opened.getexif()
        hdr = _is_hdr_still(opened)
        icc = opened.info.get("icc_profile")
        im = ImageOps.exif_transpose(opened) or opened
        if icc and "icc_profile" not in im.info:
            im.info["icc_profile"] = icc
    if hdr and not allow_hdr:
        return {"needs_review": "hdr_still", "width": im.width, "height": im.height}
    # allow_hdr (admin chose "Process anyway"): convert to 8-bit sRGB with clipping, no tone mapping.

    im = _flatten(_to_srgb(im))
    view = _fit(im, VIEW_EDGE)
    view.save(out_dir / "view.webp", "WEBP", quality=VIEW_Q, method=4)
    thumb = _fit(im, THUMB_EDGE)
    thumb.save(out_dir / "thumb.webp", "WEBP", quality=THUMB_Q, method=4)

    files = {
        "view": {"file": "view.webp", "width": view.width, "height": view.height},
        "thumb": {"file": "thumb.webp", "width": thumb.width, "height": thumb.height},
    }
    for f in files.values():
        f["bytes"] = os.path.getsize(out_dir / f["file"])
    make = str(exif.get(EXIF_MAKE) or "").strip("\x00 ")
    model = str(exif.get(EXIF_MODEL) or "").strip("\x00 ")
    device = model if model.lower().startswith(make.lower()) else " ".join(x for x in (make, model) if x)
    return {
        "width": im.width,
        "height": im.height,
        "captured_at": _captured_at(exif),
        "device": device or None,
        "files": files,
    }


def main(args: list[str]) -> dict[str, Any]:
    import argparse

    p = argparse.ArgumentParser(prog="mediaworker images")
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--allow-hdr", action="store_true")
    a = p.parse_args(args)
    return process(a.src, a.out, a.allow_hdr)
