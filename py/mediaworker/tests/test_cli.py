import json
import subprocess
import sys


def run(*args: str) -> tuple[int, dict]:
    p = subprocess.run([sys.executable, "-m", "mediaworker", *args], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


def test_versions_reports_heif_support():
    code, out = run("versions")
    assert code == 0
    assert out["heif_decode"] is True


def test_unknown_command_is_a_json_error():
    code, out = run("nope")
    assert code == 2
    assert out["error"] == "usage"
