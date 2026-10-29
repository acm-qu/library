#!/usr/bin/env bash
# Create or update the worker's own Python virtualenv (~/venvs/worker). Nothing is installed system-wide:
# deleting ~/venvs/worker removes all of it. Safe to re-run; deploy.sh runs it on every release.
#   setup-worker-venv.sh <release dir> [--with-tonemap]
set -euo pipefail
REL=${1:?usage: setup-worker-venv.sh <release dir> [--with-tonemap]}
VENV=$HOME/venvs/worker
PY=/opt/alt/python313/bin/python3.13
export TMPDIR=$HOME/tmp PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# Same caps as the worker (THREAD_ENV): uncapped, OpenBLAS starts a thread per core (64) and dies on the LVE limit.
export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
mkdir -p "$TMPDIR"
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
# torch from the CPU-only index: the CUDA build is ~2.5 GB of libraries this host can't use.
extra=()
[ "${2:-}" = "--with-tonemap" ] && extra=(--extra-index-url https://download.pytorch.org/whl/cpu)
spec="$REL/py/mediaworker"
[ "${2:-}" = "--with-tonemap" ] && spec="$REL/py/mediaworker[tonemap]"
"$VENV/bin/pip" install --quiet --upgrade "${extra[@]}" "$spec"
"$VENV/bin/python" -m mediaworker versions
# DISTS and TOPIQ-FR weights (~0.6 GB, once) go into ~/.cache now, so a job never downloads anything.
[ "${2:-}" = "--with-tonemap" ] && "$VENV/bin/python" -m mediaworker tonemap-weights
