#!/usr/bin/env python3
"""Build and audit the exact Git archive intended for release."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Dict, List, Optional, Sequence, Tuple

from audit_public_tree import (
    DEFAULT_MAX_BYTES,
    AuditConfigurationError,
    Finding,
    _collect_full,
    _load_denylist,
    audit_paths,
)


class ArchiveAuditError(RuntimeError):
    """Raised when a release archive cannot be built or verified safely."""


@dataclass(frozen=True)
class GitTreeEntry:
    mode: str
    object_type: str
    object_id: str
    path: str


def _run_git(repo: Path, args: Sequence[str]) -> bytes:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise ArchiveAuditError("git is required") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ArchiveAuditError(detail or f"git {' '.join(args)} failed")
    return result.stdout


def _resolve_commit(repo: Path, treeish: str) -> str:
    if not treeish or treeish.startswith("-"):
        raise ArchiveAuditError("treeish must not be empty or start with '-'")
    raw = _run_git(repo, ["rev-parse", "--verify", f"{treeish}^{{commit}}"])
    return raw.decode("ascii").strip()


def _git_tree_entries(repo: Path, commit: str) -> List[GitTreeEntry]:
    raw = _run_git(repo, ["ls-tree", "-r", "-z", commit])
    entries: List[GitTreeEntry] = []
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, separator, raw_path = record.partition(b"\t")
        if not separator:
            raise ArchiveAuditError("cannot parse git ls-tree output")
        fields = metadata.decode("ascii").split()
        if len(fields) != 3:
            raise ArchiveAuditError("cannot parse git tree metadata")
        path = os.fsdecode(raw_path)
        entries.append(GitTreeEntry(fields[0], fields[1], fields[2], path))
    if not entries:
        raise ArchiveAuditError("release tree contains no files")
    return entries


def _validate_relative_path(raw_path: str) -> PurePosixPath:
    path = PurePosixPath(raw_path)
    if not raw_path or path.is_absolute() or ".." in path.parts:
        raise ArchiveAuditError(f"unsafe archive path: {raw_path!r}")
    if "\\" in raw_path:
        raise ArchiveAuditError(f"archive path contains a backslash: {raw_path!r}")
    return path


def _extract_regular_files(
    archive_bytes: bytes,
    target_root: Path,
) -> Tuple[List[str], Dict[str, Dict[str, object]]]:
    file_paths: List[str] = []
    manifest: Dict[str, Dict[str, object]] = {}
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:") as archive:
        for member in archive.getmembers():
            normalized = _validate_relative_path(member.name)
            display = normalized.as_posix().rstrip("/")
            if member.isdir():
                continue
            if not member.isfile():
                raise ArchiveAuditError(
                    f"archive contains a non-regular entry: {display} ({member.type!r})"
                )
            if display in seen:
                raise ArchiveAuditError(f"archive contains a duplicate path: {display}")
            seen.add(display)

            source = archive.extractfile(member)
            if source is None:
                raise ArchiveAuditError(f"cannot read archived file: {display}")
            data = source.read()
            destination = target_root.joinpath(*normalized.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)

            file_paths.append(display)
            manifest[display] = {
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
    return sorted(file_paths), manifest


def build_and_audit_archive(
    repo: Path,
    *,
    treeish: str,
    denylist_path: Optional[Path],
    max_bytes: int,
) -> Tuple[bytes, Dict[str, object], List[Finding]]:
    commit = _resolve_commit(repo, treeish)
    tree_entries = _git_tree_entries(repo, commit)
    unsupported = [
        entry
        for entry in tree_entries
        if entry.object_type != "blob" or entry.mode not in {"100644", "100755"}
    ]
    if unsupported:
        detail = ", ".join(f"{entry.mode} {entry.path}" for entry in unsupported[:5])
        raise ArchiveAuditError(f"release tree contains unsupported Git entries: {detail}")

    archive_bytes = _run_git(repo, ["archive", "--format=tar", commit])
    archive_sha256 = hashlib.sha256(archive_bytes).hexdigest()
    denylist = _load_denylist(denylist_path)

    with tempfile.TemporaryDirectory(prefix="creative-loop2rsi-archive-") as raw_temp:
        extracted_root = Path(raw_temp)
        archived_paths, file_manifest = _extract_regular_files(archive_bytes, extracted_root)
        git_paths = sorted(entry.path for entry in tree_entries)
        if archived_paths != git_paths:
            missing = sorted(set(git_paths) - set(archived_paths))
            extra = sorted(set(archived_paths) - set(git_paths))
            raise ArchiveAuditError(
                f"archive/tree manifest mismatch; missing={missing[:5]} extra={extra[:5]}"
            )
        findings, scanned_files = audit_paths(
            extracted_root,
            _collect_full(extracted_root),
            denylist=denylist,
            max_bytes=max_bytes,
        )

    manifest: Dict[str, object] = {
        "schema_version": "1",
        "kind": "ReleaseArchiveAudit",
        "commit": commit,
        "tree": _run_git(repo, ["rev-parse", f"{commit}^{{tree}}"])
        .decode("ascii")
        .strip(),
        "archive_format": "tar",
        "archive_sha256": archive_sha256,
        "file_count": len(tree_entries),
        "scanned_file_count": scanned_files,
        "files": [
            {
                "path": entry.path,
                "mode": entry.mode,
                "git_blob": entry.object_id,
                **file_manifest[entry.path],
            }
            for entry in tree_entries
        ],
    }
    return archive_bytes, manifest, findings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build git archive for a commit, compare its manifest, and audit its bytes."
    )
    parser.add_argument("repo", nargs="?", default=".", help="repository root")
    parser.add_argument("--treeish", default="HEAD", help="commit-ish to archive (default: HEAD)")
    parser.add_argument("--output", type=Path, help="optional output path for the verified tar archive")
    parser.add_argument("--manifest", type=Path, help="optional output path for the JSON manifest")
    parser.add_argument("--denylist", type=Path, help="optional private denylist outside the repository")
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help=f"maximum size of one public file (default: {DEFAULT_MAX_BYTES})",
    )
    return parser


def _atomic_write(path: Path, data: bytes) -> None:
    target = path.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temp = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    except Exception:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.max_bytes <= 0:
        print("configuration error: --max-bytes must be positive", file=sys.stderr)
        return 2
    repo = Path(args.repo).expanduser().resolve()
    if not repo.is_dir():
        print(f"configuration error: repository is not a directory: {repo}", file=sys.stderr)
        return 2
    if args.output and args.manifest:
        output_path = args.output.expanduser().resolve()
        manifest_path = args.manifest.expanduser().resolve()
        if output_path == manifest_path:
            print(
                "configuration error: --output and --manifest must be different paths",
                file=sys.stderr,
            )
            return 2

    try:
        archive_bytes, manifest, findings = build_and_audit_archive(
            repo,
            treeish=args.treeish,
            denylist_path=args.denylist,
            max_bytes=args.max_bytes,
        )
    except (ArchiveAuditError, AuditConfigurationError, OSError, tarfile.TarError) as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    if findings:
        for finding in findings:
            print(f"ERROR [{finding.code}] {finding.path}: {finding.message}")
        print(
            f"FAILED: {len(findings)} finding(s) in release archive "
            f"{manifest['archive_sha256']}."
        )
        return 1

    if args.output:
        _atomic_write(args.output, archive_bytes)
    if args.manifest:
        encoded = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        _atomic_write(args.manifest, encoded)

    print(
        "OK: audited release archive "
        f"commit={manifest['commit']} files={manifest['file_count']} "
        f"sha256={manifest['archive_sha256']}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
