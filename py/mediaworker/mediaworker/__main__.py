"""Entry point: ``python -m mediaworker <command> [args]``.

Contract with apps/worker: exactly one JSON object on stdout, logs on stderr, exit code 0 on success.
On failure the process exits non-zero and prints ``{"error": "<code>", "message": "..."}``.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any


def _versions(_args: list[str]) -> dict[str, Any]:
    import numpy
    import PIL
    import pillow_heif

    return {
        "python": sys.version.split()[0],
        "pillow": PIL.__version__,
        "pillow_heif": pillow_heif.__version__,
        "numpy": numpy.__version__,
        "heif_decode": bool(pillow_heif.libheif_info().get("decoders")),
        **_tonemap_versions(),
    }


def _tonemap_versions() -> dict[str, Any]:
    try:
        import pyiqa
        import torch
    except ImportError:
        return {"torch": None, "pyiqa": None}
    return {"torch": torch.__version__, "pyiqa": pyiqa.__version__}


def _images(args: list[str]) -> dict[str, Any]:
    from . import images

    return images.main(args)


def _luts(args: list[str]) -> dict[str, Any]:
    from .tonemap import luts

    return luts.main(args)


def _select(args: list[str]) -> dict[str, Any]:
    import os

    os.environ.setdefault("HF_HUB_OFFLINE", "1")  # weights are fetched at deploy time, never during a job
    from .tonemap import select

    return select.main(args)


def _gate(args: list[str]) -> dict[str, Any]:
    from .tonemap import gate

    return gate.main(args)


def _weights(_args: list[str]) -> dict[str, Any]:
    """Download (once) and load the DISTS and TOPIQ-FR weights, so jobs never touch the network."""
    import time

    from .tonemap.select import Scorer

    t = time.monotonic()
    s = Scorer()
    return {"metrics": list(s.metrics), "lowerBetter": s.lower_better, "seconds": round(time.monotonic() - t, 1), **_tonemap_versions()}


COMMANDS: dict[str, Callable[[list[str]], dict[str, Any]]] = {
    "versions": _versions,
    "images": _images,
    "luts": _luts,
    "select": _select,
    "tonemap-gate": _gate,
    "tonemap-weights": _weights,
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in COMMANDS:
        print(json.dumps({"error": "usage", "message": f"commands: {', '.join(COMMANDS)}"}))
        return 2
    try:
        result = COMMANDS[argv[0]](argv[1:])
    except Exception as e:  # reported to the worker as a structured failure
        print(json.dumps({"error": type(e).__name__, "message": str(e)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
