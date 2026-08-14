#!/usr/bin/env python3
"""Remove machine-local paths from pnpm license inventory JSON."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence


ALLOWED_FIELDS = {"author", "description", "homepage", "license", "name", "versions"}


def sanitize(raw: Any) -> Dict[str, List[Dict[str, Any]]]:
    if not isinstance(raw, Mapping):
        raise ValueError("pnpm licenses JSON must be an object")
    result: Dict[str, List[Dict[str, Any]]] = {}
    for raw_license, raw_packages in raw.items():
        if not isinstance(raw_license, str) or not isinstance(raw_packages, list):
            raise ValueError("pnpm licenses JSON has an invalid license group")
        packages: List[Dict[str, Any]] = []
        for raw_package in raw_packages:
            if not isinstance(raw_package, Mapping):
                raise ValueError("pnpm licenses JSON has an invalid package record")
            record = {
                key: value
                for key, value in raw_package.items()
                if key in ALLOWED_FIELDS and value is not None
            }
            if not isinstance(record.get("name"), str) or not isinstance(record.get("versions"), list):
                raise ValueError("license package name or versions are missing")
            packages.append(dict(record))
        packages.sort(key=lambda item: (str(item.get("name")), json.dumps(item.get("versions"), sort_keys=True)))
        result[raw_license] = packages
    return dict(sorted(result.items()))


def atomic_write(path: Path, value: object) -> None:
    target = path.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, target)
    except BaseException:
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = sanitize(json.loads(args.input.read_text(encoding="utf-8-sig")))
        atomic_write(args.output, result)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"license inventory sanitization failed: {exc}", file=os.sys.stderr)
        return 2
    print(json.dumps({"status": "PASS", "licenses": len(result), "output": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
