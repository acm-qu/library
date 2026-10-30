import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageCms

from mediaworker import images

SAMPLE_HEIC = Path.home() / "Downloads" / "IMG_0231.HEIC"


def _jpeg_with_orientation(path: Path, size=(4000, 3000), orientation=6):
    im = Image.new("RGB", size, (200, 30, 30))
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x010F] = "Apple"
    exif[0x0110] = "iPhone 15 Pro"
    exif.get_ifd(0x8769)[0x9003] = "2026:10:17 21:47:05"
    exif.get_ifd(0x8769)[0x9011] = "+03:00"
    im.save(path, "JPEG", exif=exif.tobytes())


def test_rotation_sizes_and_metadata(tmp_path):
    src = tmp_path / "IMG.JPG"
    _jpeg_with_orientation(src)
    r = images.process(str(src), str(tmp_path / "out"))
    assert (r["width"], r["height"]) == (3000, 4000)
    assert r["files"]["view"]["height"] == 2560 and r["files"]["view"]["width"] == 1920
    assert max(r["files"]["thumb"]["width"], r["files"]["thumb"]["height"]) == 480
    assert r["captured_at"] == "2026-10-17T21:47:05+03:00"
    assert r["device"] == "Apple iPhone 15 Pro"
    with Image.open(tmp_path / "out" / "view.webp") as v:
        assert v.size == (1920, 2560)


def test_never_upscales_and_flattens_alpha(tmp_path):
    src = tmp_path / "logo.png"
    im = Image.new("RGBA", (300, 200), (0, 0, 0, 0))
    im.paste((10, 10, 10, 255), (0, 0, 100, 100))
    im.save(src)
    r = images.process(str(src), str(tmp_path / "out"))
    assert r["files"]["view"]["width"] == 300
    with Image.open(tmp_path / "out" / "thumb.webp") as t:
        assert t.mode == "RGB"
        assert t.getpixel((250, 150))[0] > 240  # transparent area became white


def test_p3_profile_is_converted_to_srgb(tmp_path):
    src = tmp_path / "p3.jpg"
    p3 = ImageCms.createProfile("sRGB")  # stand-in profile: conversion path must run without error
    Image.new("RGB", (64, 64), (0, 255, 0)).save(src, icc_profile=ImageCms.ImageCmsProfile(p3).tobytes())
    r = images.process(str(src), str(tmp_path / "out"))
    assert r["width"] == 64


@pytest.mark.skipif(not SAMPLE_HEIC.exists(), reason="local iPhone sample not present")
def test_real_iphone_heic(tmp_path):
    r = images.process(str(SAMPLE_HEIC), str(tmp_path / "out"))
    assert r["width"] > 0 and r["captured_at"]
    assert set(r["files"]) == {"view", "thumb"}


def test_cli_prints_json(tmp_path):
    src = tmp_path / "a.png"
    Image.new("RGB", (10, 10)).save(src)
    p = subprocess.run([sys.executable, "-m", "mediaworker", "images", "--src", str(src), "--out", str(tmp_path / "o")], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout)["files"]["thumb"]["file"] == "thumb.webp"


def test_cli_reports_decode_errors_as_json(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"\xff\xd8\xff" + os.urandom(100))
    p = subprocess.run([sys.executable, "-m", "mediaworker", "images", "--src", str(bad), "--out", str(tmp_path / "o")], capture_output=True, text=True)
    assert p.returncode == 1
    assert json.loads(p.stdout)["error"]
