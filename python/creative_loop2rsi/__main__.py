"""One-request JSON stdin/stdout entrypoint for the packaged controller."""

from __future__ import annotations

import json
import sys
from typing import Any

from .service import error_response, handle_request


def main() -> int:
    request: Any = None
    try:
        raw = sys.stdin.buffer.read()
        if not raw:
            raise ValueError("stdin 缺少 JSON request")
        request = json.loads(raw.decode("utf-8"))
        response = handle_request(request)
        exit_code = 0
    except (Exception, KeyboardInterrupt) as exc:
        response = error_response(request, exc)
        exit_code = 130 if isinstance(exc, KeyboardInterrupt) else 2
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    print(json.dumps(response, ensure_ascii=False, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
