#!/usr/bin/env python3
"""Verify that every selected commit has an author-matching DCO sign-off."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple


SIGNOFF_RE = re.compile(
    r"^Signed-off-by:\s*(?P<name>.+?)\s*<(?P<email>[^<>\s]+)>\s*$",
    re.IGNORECASE,
)


class DcoConfigurationError(RuntimeError):
    """Raised when Git history cannot be inspected safely."""


@dataclass(frozen=True)
class DcoFailure:
    commit: str
    reason: str


def _run_git(repo: Path, args: Sequence[str]) -> bytes:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise DcoConfigurationError("git is required") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise DcoConfigurationError(detail or f"git {' '.join(args)} failed")
    return result.stdout


def _selected_commits(repo: Path, revision_range: str) -> List[str]:
    if not revision_range or revision_range.startswith("-"):
        raise DcoConfigurationError("revision range must not be empty or start with '-'")
    raw = _run_git(repo, ["rev-list", "--reverse", revision_range])
    commits = [line.decode("ascii") for line in raw.splitlines() if line]
    if not commits:
        raise DcoConfigurationError(f"revision range selects no commits: {revision_range}")
    return commits


def _commit_identity_and_message(repo: Path, commit: str) -> Tuple[str, str, str]:
    raw = _run_git(repo, ["show", "-s", "--format=%an%x00%ae%x00%B", commit])
    fields = raw.decode("utf-8", errors="strict").split("\0", 2)
    if len(fields) != 3:
        raise DcoConfigurationError(f"cannot parse commit metadata: {commit}")
    return fields[0].strip(), fields[1].strip(), fields[2]


def _normalized_identity(name: str, email: str) -> Tuple[str, str]:
    return " ".join(name.split()), email.casefold()


def _parse_trailer_lines(repo: Path, message: str) -> List[str]:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "interpret-trailers", "--parse"],
            input=message.encode("utf-8"),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise DcoConfigurationError("git is required") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise DcoConfigurationError(detail or "git interpret-trailers failed")
    return result.stdout.decode("utf-8", errors="strict").splitlines()


def check_dco(repo: Path, revision_range: str) -> Tuple[List[DcoFailure], int]:
    failures: List[DcoFailure] = []
    commits = _selected_commits(repo, revision_range)
    for commit in commits:
        try:
            author_name, author_email, message = _commit_identity_and_message(repo, commit)
        except UnicodeDecodeError:
            failures.append(DcoFailure(commit, "commit metadata is not valid UTF-8"))
            continue

        if not author_name or not author_email:
            failures.append(DcoFailure(commit, "author name and email are required"))
            continue

        author = _normalized_identity(author_name, author_email)
        signoffs: List[Tuple[str, str]] = []
        for line in _parse_trailer_lines(repo, message):
            match = SIGNOFF_RE.match(line)
            if match:
                signoffs.append(
                    _normalized_identity(match.group("name"), match.group("email"))
                )

        if not signoffs:
            failures.append(DcoFailure(commit, "missing Signed-off-by trailer"))
        elif author not in signoffs:
            failures.append(
                DcoFailure(commit, "no Signed-off-by trailer matches the commit author")
            )

    return failures, len(commits)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Check DCO sign-offs for every commit in a Git revision range."
    )
    parser.add_argument(
        "repo",
        nargs="?",
        default=".",
        help="Git repository root (default: current directory)",
    )
    parser.add_argument(
        "--range",
        dest="revision_range",
        default="HEAD",
        help="revision range accepted by git rev-list (default: HEAD)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    repo = Path(args.repo).expanduser().resolve()
    if not repo.is_dir():
        print(f"configuration error: repository is not a directory: {repo}", file=sys.stderr)
        return 2

    try:
        failures, checked = check_dco(repo, args.revision_range)
    except DcoConfigurationError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    if failures:
        for failure in failures:
            print(f"ERROR {failure.commit[:12]}: {failure.reason}")
        print(f"FAILED: {len(failures)} DCO failure(s) across {checked} commit(s).")
        return 1

    print(f"OK: {checked} commit(s) have author-matching DCO sign-offs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
