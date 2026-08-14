#!/usr/bin/env python3
"""Compare the packaged controller with the source module over the JSON protocol."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple


def invoke(command: Sequence[str], request: Dict[str, Any], *, cwd: Path, env: Dict[str, str]) -> Tuple[int, Dict[str, Any]]:
    completed = subprocess.run(
        list(command),
        cwd=str(cwd),
        env=env,
        input=json.dumps(request, ensure_ascii=False),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    if completed.stderr:
        raise RuntimeError("controller wrote unexpected stderr")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("controller stdout is not one JSON document") from exc
    if not isinstance(response, dict):
        raise RuntimeError("controller response must be an object")
    return completed.returncode, response


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sidecar", type=Path, help="absolute or relative sidecar executable path")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    sidecar = args.sidecar.expanduser().resolve()
    if not sidecar.is_file() or sidecar.is_symlink():
        print(f"invalid sidecar executable: {sidecar}", file=sys.stderr)
        return 2
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in {"LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "TZ", "WINDIR"}
    }
    environment.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "PYTHONPATH": str(root / "python"),
        }
    )
    source_command = [sys.executable, "-m", "creative_loop2rsi"]
    with tempfile.TemporaryDirectory(prefix="creative-rsi-sidecar-check-") as temporary:
        project = Path(temporary) / "synthetic-system"
        bootstrap = {
            "protocol_version": "1",
            "request_id": "bootstrap-sidecar-check",
            "operation": "bootstrap_intent",
            "payload": {
                "project": str(project),
                "system_id": "synthetic-story",
                "display_name": "虚构故事系统",
                "intent": "写一则只用于测试的虚构短故事",
            },
        }
        code, response = invoke(source_command, bootstrap, cwd=root, env=environment)
        if code != 0 or response.get("status") != "PASS":
            raise RuntimeError("source controller could not create the synthetic fixture")
        snapshot = {
            "protocol_version": "1",
            "request_id": "snapshot-sidecar-check",
            "operation": "system_snapshot",
            "payload": {"project": str(project)},
        }
        source_result = invoke(source_command, snapshot, cwd=root, env=environment)
        sidecar_environment = dict(environment)
        sidecar_environment.pop("PYTHONPATH", None)
        packaged_result = invoke([str(sidecar)], snapshot, cwd=root, env=sidecar_environment)
        if source_result != packaged_result:
            print("source and packaged controller responses differ", file=sys.stderr)
            print(
                json.dumps(
                    {"source": source_result, "packaged": packaged_result},
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                ),
                file=sys.stderr,
            )
            return 1
    print(json.dumps({"status": "PASS", "operation": "system_snapshot", "equivalent": True}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
