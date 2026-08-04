#!/usr/bin/env python3
"""Audit the current public tree without reading network or secret stores.

The default mode is ``tracked`` because a release archive is built from tracked
files. Use ``--mode full`` before staging to include untracked files. This tool
audits the current tree only; it does not replace a full Git-history scanner.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple


DEFAULT_MAX_BYTES = 1_000_000
IGNORED_FULL_DIRS = {".git"}
CACHE_PARTS = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    ".venv",
    "venv",
    "htmlcov",
}
LOCAL_FILE_NAMES = {".DS_Store", "Thumbs.db", ".coverage"}
LOCAL_SUFFIXES = {".log", ".tmp", ".bak", ".pyc", ".pyo"}
SENSITIVE_FILE_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}
ROOT_RUNTIME_DIRS = {"inputs", "outputs", "runs"}


def _compiled_content_patterns() -> Tuple[Tuple[str, re.Pattern[str]], ...]:
    # Construct absolute-path markers in pieces so this source file does not
    # itself contain a machine-specific path that it is designed to reject.
    mac_home = re.escape("/" + "Users" + "/") + r"[^/\s]+/"
    linux_home = re.escape("/" + "home" + "/") + r"[^/\s]+/"
    windows_home = r"[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\r\n]+\\"
    return (
        (
            "PRIVATE_KEY",
            re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
        ),
        ("OPENAI_STYLE_KEY", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
        (
            "GITHUB_TOKEN",
            re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b"),
        ),
        ("AWS_ACCESS_KEY", re.compile(r"\bAKIA[A-Z0-9]{16}\b")),
        (
            "ASSIGNED_SECRET",
            re.compile(
                r"(?i)\b(?:api[_-]?key|access[_-]?token|secret|password)\b"
                r"\s*[:=]\s*[\"']?[A-Za-z0-9_./+=-]{16,}"
            ),
        ),
        ("ABSOLUTE_MAC_PATH", re.compile(mac_home)),
        ("ABSOLUTE_LINUX_PATH", re.compile(linux_home)),
        ("ABSOLUTE_WINDOWS_PATH", re.compile(windows_home)),
        (
            "INTERNAL_DOMAIN",
            re.compile(
                r"(?i)\b(?:[a-z0-9-]+\.)+(?:corp|internal|intranet|lan)"
                r"(?::\d+)?\b"
            ),
        ),
    )


CONTENT_PATTERNS = _compiled_content_patterns()


@dataclass(frozen=True, order=True)
class Finding:
    path: str
    code: str
    message: str


class AuditConfigurationError(RuntimeError):
    """Raised when an audit cannot be configured or enumerated safely."""


def _display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _collect_full(root: Path) -> List[Path]:
    paths: List[Path] = []
    for directory, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        directory_path = Path(directory)
        retained_dirs: List[str] = []
        for name in sorted(dirnames):
            candidate = directory_path / name
            if name in IGNORED_FULL_DIRS:
                continue
            if candidate.is_symlink():
                paths.append(candidate)
                continue
            retained_dirs.append(name)
        dirnames[:] = retained_dirs
        paths.extend(directory_path / name for name in sorted(filenames))
    return paths


def _collect_tracked(root: Path) -> List[Path]:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--cached"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise AuditConfigurationError("git is required for tracked mode") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise AuditConfigurationError(
            "tracked mode requires a Git worktree" + (f": {detail}" if detail else "")
        )

    paths: List[Path] = []
    for raw in result.stdout.split(b"\0"):
        if not raw:
            continue
        relative = Path(os.fsdecode(raw))
        if relative.is_absolute() or ".." in relative.parts:
            raise AuditConfigurationError(f"unsafe path returned by Git: {relative}")
        paths.append(root / relative)
    if not paths:
        raise AuditConfigurationError(
            "Git index contains no tracked files; use --mode full before the initial commit"
        )
    return sorted(paths, key=lambda item: item.as_posix())


def _load_denylist(path: Optional[Path]) -> List[str]:
    if path is None:
        return []
    if not path.is_file():
        raise AuditConfigurationError(f"denylist file does not exist: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise AuditConfigurationError(f"cannot read denylist: {path}") from exc

    entries: List[str] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        if len(value) < 3:
            raise AuditConfigurationError(
                f"denylist entry on line {line_number} is shorter than 3 characters"
            )
        entries.append(value)
    return entries


def _path_findings(path: Path, root: Path) -> List[Finding]:
    relative = path.relative_to(root)
    display = relative.as_posix()
    parts = relative.parts
    name = relative.name
    findings: List[Finding] = []

    if any(part in CACHE_PARTS for part in parts):
        findings.append(Finding(display, "CACHE_ARTIFACT", "cache directory must not be public"))
    if name in LOCAL_FILE_NAMES or path.suffix.lower() in LOCAL_SUFFIXES:
        findings.append(Finding(display, "LOCAL_ARTIFACT", "local runtime artifact must not be public"))
    if parts and parts[0] in ROOT_RUNTIME_DIRS:
        findings.append(
            Finding(display, "RUNTIME_ARTIFACT", "root-level input, output, or run data must not be public")
        )
    if name == ".env" or name.startswith(".env."):
        findings.append(Finding(display, "SECRET_FILE", "environment file must not be public"))
    if path.suffix.lower() in SENSITIVE_FILE_SUFFIXES:
        findings.append(Finding(display, "SECRET_FILE", "credential-like file must not be public"))
    if name == "private-denylist.txt" or name.endswith(".private-denylist"):
        findings.append(Finding(display, "PRIVATE_DENYLIST", "private denylist must stay outside the repository"))
    return findings


def _content_findings(
    text: str,
    display: str,
    denylist: Sequence[str],
) -> List[Finding]:
    findings: List[Finding] = []
    for code, pattern in CONTENT_PATTERNS:
        match = pattern.search(text)
        if match:
            line = text.count("\n", 0, match.start()) + 1
            findings.append(
                Finding(display, code, f"sensitive content pattern found on line {line}")
            )

    folded = text.casefold()
    for entry in denylist:
        index = folded.find(entry.casefold())
        if index >= 0:
            line = text.count("\n", 0, index) + 1
            findings.append(
                Finding(display, "PRIVATE_DENYLIST_MATCH", f"private denylist match found on line {line}")
            )
    return findings


def audit_paths(
    root: Path,
    paths: Iterable[Path],
    *,
    denylist: Sequence[str],
    max_bytes: int,
) -> Tuple[List[Finding], int]:
    findings: List[Finding] = []
    scanned_files = 0
    for path in paths:
        display = _display_path(path, root)
        folded_display = display.casefold()
        for entry in denylist:
            if entry.casefold() in folded_display:
                findings.append(
                    Finding(
                        display,
                        "PRIVATE_DENYLIST_PATH",
                        "private denylist match found in path",
                    )
                )
        try:
            metadata = path.lstat()
        except OSError as exc:
            findings.append(Finding(display, "UNREADABLE", f"cannot stat path: {exc}"))
            continue

        if stat.S_ISLNK(metadata.st_mode):
            findings.append(Finding(display, "SYMLINK", "symbolic links are not allowed in the public tree"))
            continue
        if not stat.S_ISREG(metadata.st_mode):
            findings.append(Finding(display, "NON_REGULAR_FILE", "only regular files are allowed"))
            continue

        scanned_files += 1
        findings.extend(_path_findings(path, root))
        if metadata.st_size > max_bytes:
            findings.append(
                Finding(
                    display,
                    "LARGE_FILE",
                    f"file is {metadata.st_size} bytes; limit is {max_bytes}",
                )
            )
            continue

        try:
            data = path.read_bytes()
        except OSError as exc:
            findings.append(Finding(display, "UNREADABLE", f"cannot read file: {exc}"))
            continue
        if b"\0" in data:
            findings.append(Finding(display, "BINARY_FILE", "binary content is not allowed"))
            continue
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            findings.append(Finding(display, "BINARY_FILE", "file is not valid UTF-8 text"))
            continue
        findings.extend(_content_findings(text, display, denylist))

    return sorted(set(findings)), scanned_files


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Audit tracked release files or the full working tree for public-safety risks."
    )
    parser.add_argument("root", nargs="?", default=".", help="repository root (default: current directory)")
    parser.add_argument(
        "--mode",
        choices=("tracked", "full"),
        default="tracked",
        help="tracked checks git ls-files; full includes untracked files (default: tracked)",
    )
    parser.add_argument(
        "--denylist",
        type=Path,
        help="optional UTF-8 file of private literal terms; keep this file outside the repository",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help=f"maximum size of one public file (default: {DEFAULT_MAX_BYTES})",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.max_bytes <= 0:
        parser.error("--max-bytes must be positive")

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"configuration error: repository root is not a directory: {root}", file=sys.stderr)
        return 2

    try:
        denylist = _load_denylist(args.denylist)
        paths = _collect_tracked(root) if args.mode == "tracked" else _collect_full(root)
        findings, scanned_files = audit_paths(
            root,
            paths,
            denylist=denylist,
            max_bytes=args.max_bytes,
        )
    except AuditConfigurationError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    if findings:
        for finding in findings:
            print(f"ERROR [{finding.code}] {finding.path}: {finding.message}")
        print(
            f"FAILED: {len(findings)} finding(s) across {scanned_files} file(s) in {args.mode} mode."
        )
        return 1

    print(f"OK: audited {scanned_files} file(s) in {args.mode} mode; no findings.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
