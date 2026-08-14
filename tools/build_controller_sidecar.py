#!/usr/bin/env python3
"""Build the CPython 3.11 governance sidecar as a self-contained onedir tree."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Dict, Optional, Sequence


SIDECAR_NAME = "creative-rsi-controller"
SUPPORTED = {("Darwin", "arm64"), ("Windows", "AMD64"), ("Windows", "x86_64")}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        help="new, empty target directory; defaults below dist/ for the current platform",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    system = platform.system()
    machine = platform.machine()
    if sys.version_info[:2] != (3, 11):
        print("controller sidecar must be built with CPython 3.11", file=sys.stderr)
        return 2
    if (system, machine) not in SUPPORTED:
        print(
            f"unsupported v1 sidecar target: {system}/{machine}; expected macOS arm64 or Windows x64",
            file=sys.stderr,
        )
        return 2
    entrypoint = root / "python" / "controller_sidecar.py"
    skill_root = root / "skills" / "creative-loop2rsi"
    if not entrypoint.is_file() or not (skill_root / "scripts" / "loopctl.py").is_file():
        print("repository sidecar inputs are incomplete", file=sys.stderr)
        return 2

    suffix = "macos-arm64" if system == "Darwin" else "windows-x64"
    output = (args.output or root / "dist" / f"controller-sidecar-{suffix}").resolve()
    manifest_path = output.with_name(f"{output.name}.manifest.json")
    if os.path.lexists(str(output)) or os.path.lexists(str(manifest_path)):
        print(
            f"refusing to overwrite existing sidecar target or manifest: {output}",
            file=sys.stderr,
        )
        return 2
    output.parent.mkdir(parents=True, exist_ok=True)

    try:
        import PyInstaller.__main__  # type: ignore[import-not-found]
        import PyInstaller  # type: ignore[import-not-found]
    except ImportError:
        print(
            "PyInstaller is unavailable; install python/requirements-build.txt in an isolated CPython 3.11 environment",
            file=sys.stderr,
        )
        return 2

    temporary = Path(tempfile.mkdtemp(prefix="creative-rsi-sidecar-build-"))
    try:
        dist_path = temporary / "dist"
        work_path = temporary / "work"
        spec_path = temporary / "spec"
        data_argument = f"{skill_root}{os.pathsep}skills/creative-loop2rsi"
        PyInstaller.__main__.run(
            [
                str(entrypoint),
                "--name",
                SIDECAR_NAME,
                "--onedir",
                "--noupx",
                "--noconfirm",
                "--paths",
                str(root / "python"),
                "--hidden-import",
                "uuid",
                "--add-data",
                data_argument,
                "--distpath",
                str(dist_path),
                "--workpath",
                str(work_path),
                "--specpath",
                str(spec_path),
            ]
        )
        built = dist_path / SIDECAR_NAME
        if not built.is_dir():
            print("PyInstaller did not produce the expected onedir tree", file=sys.stderr)
            return 2
        os.replace(built, output)
        files: Dict[str, Dict[str, object]] = {}
        for path in sorted(item for item in output.rglob("*") if item.is_file()):
            relative = path.relative_to(output).as_posix()
            files[relative] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
        atomic_write_json(
            manifest_path,
            {
                "schema_version": "1",
                "kind": "ControllerSidecarBuildManifest",
                "platform": {"system": system, "machine": machine},
                "python": platform.python_version(),
                "pyinstaller": PyInstaller.__version__,
                "entrypoint": "python/controller_sidecar.py",
                "bundled_skill": "skills/creative-loop2rsi",
                "sidecar_name": SIDECAR_NAME,
                "files": files,
            },
        )
        print(
            json.dumps(
                {"status": "PASS", "output": str(output), "manifest": str(manifest_path), "files": len(files)},
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return 0
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
