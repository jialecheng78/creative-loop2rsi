#!/usr/bin/env python3
"""Build the CPython 3.11 governance sidecar as a self-contained onedir tree."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import sysconfig
import tempfile
from pathlib import Path
from typing import Dict, Optional, Sequence


SIDECAR_NAME = "creative-rsi-controller"
SUPPORTED = {("Darwin", "arm64"), ("Windows", "AMD64"), ("Windows", "x86_64")}
PYTHON_LICENSE_EXPRESSION = "PSF-2.0"
PYINSTALLER_LICENSE_EXPRESSION = "GPL-2.0-or-later WITH Bootloader-exception"


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


def git_text(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout


def tracked_sidecar_inputs(root: Path) -> list[str]:
    output = subprocess.run(
        ["git", "ls-files", "-z", "--", "python", "skills/creative-loop2rsi"],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    values = [item.decode("utf-8") for item in output.split(b"\0") if item]
    if not values:
        raise RuntimeError("no tracked controller sidecar inputs")
    return sorted(values)


def target_file_mode(path: Path, system: str) -> Optional[str]:
    """Return the v2 manifest mode for a regular file on the target platform."""
    if system == "Windows":
        return None
    return f"{stat.S_IMODE(path.lstat().st_mode):04o}"


def inventory_sidecar_tree(output: Path, system: str) -> Dict[str, Dict[str, object]]:
    if output.is_symlink() or not output.is_dir():
        raise RuntimeError("sidecar inventory root must be a regular directory")
    files: Dict[str, Dict[str, object]] = {
        ".": {"type": "directory", "mode": target_file_mode(output, system)}
    }
    resolved_output = output.resolve(strict=True)
    for path in sorted(output.rglob("*")):
        relative = path.relative_to(output).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target):
                raise RuntimeError(
                    f"sidecar symlink target must be relative: {relative}"
                )
            try:
                path.resolve(strict=True).relative_to(resolved_output)
            except (FileNotFoundError, ValueError) as error:
                raise RuntimeError(
                    f"sidecar symlink escapes or is broken: {relative}"
                ) from error
            files[relative] = {
                "type": "symlink",
                "target": target,
                "mode": target_file_mode(path, system),
            }
        elif path.is_dir():
            files[relative] = {
                "type": "directory",
                "mode": target_file_mode(path, system),
            }
        elif path.is_file():
            files[relative] = {
                "type": "file",
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "mode": target_file_mode(path, system),
            }
        else:
            raise RuntimeError(f"unsupported sidecar output entry: {relative}")
    return files


def validate_sidecar_executable(
    output: Path,
    system: str,
    files: Dict[str, Dict[str, object]],
) -> None:
    executable_name = f"{SIDECAR_NAME}.exe" if system == "Windows" else SIDECAR_NAME
    executable = output / executable_name
    declared = files.get(executable_name)
    if executable.is_symlink() or not executable.is_file() or declared is None:
        raise RuntimeError("sidecar executable is missing or is not a regular file")
    if declared.get("type") != "file":
        raise RuntimeError("sidecar executable inventory entry is invalid")
    if system == "Windows":
        if declared.get("mode") is not None:
            raise RuntimeError("Windows sidecar executable mode must be null")
        return
    mode = declared.get("mode")
    if mode != "0755":
        raise RuntimeError("POSIX sidecar executable mode must be 0755")


def create_sidecar_build_directory(output: Path) -> Path:
    return Path(
        tempfile.mkdtemp(
            prefix=f".{output.name}-build-",
            dir=output.parent,
        )
    )


def _regular_notice(path: Path, label: str) -> Path:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"{label} notice must be a regular file")
    return path


def python_license_path() -> Path:
    stdlib = sysconfig.get_path("stdlib")
    if not stdlib:
        raise RuntimeError("CPython stdlib path is unavailable")
    return select_python_license(
        [Path(stdlib) / "LICENSE.txt", Path(sys.base_prefix) / "LICENSE.txt"],
        Path(sys.base_prefix),
    )


def select_python_license(candidates: Sequence[Path], base_prefix: Path) -> Path:
    resolved_base = base_prefix.resolve(strict=True)
    selected: Dict[Path, Path] = {}
    for candidate in candidates:
        if not candidate.exists():
            continue
        candidate = _regular_notice(candidate, "CPython")
        resolved = candidate.resolve(strict=True)
        try:
            resolved.relative_to(resolved_base)
        except ValueError as error:
            raise RuntimeError("CPython notice escapes the runtime base prefix") from error
        selected.setdefault(resolved, candidate)
    if not selected:
        raise RuntimeError("CPython distribution contains no LICENSE.txt")
    hashes = {sha256_file(path) for path in selected.values()}
    if len(hashes) != 1:
        raise RuntimeError("CPython distribution contains conflicting LICENSE.txt files")
    return selected[sorted(selected, key=str)[0]]


def pyinstaller_license_path() -> Path:
    distribution = importlib.metadata.distribution("pyinstaller")
    if distribution.version != "6.22.0":
        raise RuntimeError(f"unsupported PyInstaller distribution version: {distribution.version}")
    candidates = []
    for item in distribution.files or []:
        normalized = str(item).replace("\\", "/").lower()
        if normalized.endswith("/licenses/copying.txt"):
            candidates.append(Path(distribution.locate_file(item)))
    if len(candidates) != 1:
        raise RuntimeError("PyInstaller distribution must contain exactly one licenses/COPYING.txt")
    return _regular_notice(candidates[0], "PyInstaller")


def install_runtime_notices(
    output: Path,
    python_version: str,
    pyinstaller_version: str,
    *,
    python_license: Optional[Path] = None,
    pyinstaller_license: Optional[Path] = None,
) -> list[Dict[str, object]]:
    """Install path-free runtime notices and return their hash-bound identities."""
    if not python_version.startswith("3.11."):
        raise RuntimeError(f"unsupported CPython runtime version: {python_version}")
    if pyinstaller_version != "6.22.0":
        raise RuntimeError(f"unsupported PyInstaller runtime version: {pyinstaller_version}")
    if output.is_symlink() or not output.is_dir():
        raise RuntimeError("sidecar notice target must be a regular directory")

    definitions = [
        (
            "CPython",
            python_version,
            PYTHON_LICENSE_EXPRESSION,
            python_license or python_license_path(),
            "_licenses/CPython-LICENSE.txt",
        ),
        (
            "PyInstaller",
            pyinstaller_version,
            PYINSTALLER_LICENSE_EXPRESSION,
            pyinstaller_license or pyinstaller_license_path(),
            "_licenses/PyInstaller-COPYING.txt",
        ),
    ]
    components: list[Dict[str, object]] = []
    for name, version, license_expression, source, relative in definitions:
        source = _regular_notice(Path(source), name)
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if os.path.lexists(str(destination)):
            raise RuntimeError(f"sidecar runtime notice target already exists: {relative}")
        shutil.copyfile(source, destination)
        destination.chmod(0o644)
        components.append(
            {
                "name": name,
                "version": version,
                "license": license_expression,
                "notice": {
                    "path": relative,
                    "bytes": destination.stat().st_size,
                    "sha256": sha256_file(destination),
                },
            }
        )
    return sorted(components, key=lambda component: str(component["name"]))


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
    if git_text(root, "status", "--porcelain=v1", "--untracked-files=all") != "":
        print("controller sidecar build requires a clean tracked and untracked source tree", file=sys.stderr)
        return 2
    git_commit = git_text(root, "rev-parse", "HEAD").strip()
    git_tree = git_text(root, "rev-parse", "HEAD^{tree}").strip()
    tracked_inputs = tracked_sidecar_inputs(root)

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

    temporary = create_sidecar_build_directory(output)
    try:
        source_root = temporary / "source"
        source_hashes: Dict[str, str] = {}
        for relative in tracked_inputs:
            source = root / relative
            if not source.is_file() or source.is_symlink():
                raise RuntimeError(f"tracked sidecar input must be a regular file: {relative}")
            destination = source_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            source_hashes[relative] = sha256_file(source)
        staged_entrypoint = source_root / "python" / "controller_sidecar.py"
        staged_skill_root = source_root / "skills" / "creative-loop2rsi"
        dist_path = temporary / "dist"
        work_path = temporary / "work"
        spec_path = temporary / "spec"
        data_argument = f"{staged_skill_root}{os.pathsep}skills/creative-loop2rsi"
        PyInstaller.__main__.run(
            [
                str(staged_entrypoint),
                "--name",
                SIDECAR_NAME,
                "--onedir",
                "--noupx",
                "--noconfirm",
                "--paths",
                str(source_root / "python"),
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
        runtime_components = install_runtime_notices(
            built,
            platform.python_version(),
            PyInstaller.__version__,
        )
        os.replace(built, output)
        files = inventory_sidecar_tree(output, system)
        validate_sidecar_executable(output, system, files)
        for component in runtime_components:
            notice = component["notice"]
            relative = str(notice["path"])
            declared = files.get(relative)
            if declared is None or declared.get("type") != "file":
                raise RuntimeError(f"sidecar runtime notice is absent from inventory: {relative}")
            component["notice"] = {
                "path": relative,
                "bytes": declared["bytes"],
                "sha256": declared["sha256"],
            }
        atomic_write_json(
            manifest_path,
            {
                "schema_version": "2",
                "kind": "ControllerSidecarBuildManifest",
                "platform": {"system": system, "machine": machine},
                "python": platform.python_version(),
                "pyinstaller": PyInstaller.__version__,
                "entrypoint": "python/controller_sidecar.py",
                "bundled_skill": "skills/creative-loop2rsi",
                "sidecar_name": SIDECAR_NAME,
                "runtime_components": runtime_components,
                "source": {
                    "git_commit": git_commit,
                    "git_tree": git_tree,
                    "inputs": source_hashes,
                    "builder_sha256": sha256_file(root / "tools" / "build_controller_sidecar.py"),
                    "requirements_sha256": sha256_file(
                        root / "python" / "requirements-build-hashed.txt"
                    ),
                },
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
