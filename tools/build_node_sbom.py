#!/usr/bin/env python3
"""Create a deterministic, path-free CycloneDX SBOM from pnpm list JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Set, Tuple


def atomic_write_json(path: Path, value: object) -> None:
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


def collect_dependencies(value: Any, components: Set[Tuple[str, str]]) -> None:
    if not isinstance(value, Mapping):
        return
    dependencies = value.get("dependencies")
    if not isinstance(dependencies, Mapping):
        return
    for raw_name, raw_record in dependencies.items():
        if not isinstance(raw_name, str) or not isinstance(raw_record, Mapping):
            raise ValueError("pnpm dependency record is malformed")
        version = raw_record.get("version")
        if not isinstance(version, str) or not version:
            raise ValueError(f"pnpm dependency version is missing: {raw_name}")
        if not version.startswith("link:"):
            components.add((raw_name, version))
        collect_dependencies(raw_record, components)


def build_sbom(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("pnpm list JSON must be a non-empty array")
    components: Set[Tuple[str, str]] = set()
    for root in raw:
        collect_dependencies(root, components)
    ordered = sorted(components)
    canonical = json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))
    serial = uuid.uuid5(uuid.NAMESPACE_URL, "creative-loop2rsi:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest())
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{serial}",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "name": "Creative RSI Studio",
                "version": "1.0.0-alpha.1",
            },
            "properties": [
                {"name": "creative-loop2rsi:scope", "value": "desktop-production-dependencies"},
                {"name": "creative-loop2rsi:source", "value": "pnpm-list-prod-depth-infinity"},
            ],
        },
        "components": [
            {
                "type": "library",
                "name": name,
                "version": version,
                "bom-ref": f"npm:{name}@{version}",
            }
            for name, version in ordered
        ],
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="pnpm list --json output")
    parser.add_argument("--output", required=True, type=Path, help="new or replaceable SBOM JSON")
    args = parser.parse_args(argv)
    try:
        raw = json.loads(args.input.read_text(encoding="utf-8"))
        sbom = build_sbom(raw)
        atomic_write_json(args.output, sbom)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"SBOM generation failed: {exc}", file=os.sys.stderr)
        return 2
    print(json.dumps({"status": "PASS", "components": len(sbom["components"]), "output": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
