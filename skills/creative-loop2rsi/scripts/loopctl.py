#!/usr/bin/env python3
"""Local, provider-free controller for creative-loop2rsi projects.

The controller manages contracts and evidence. It never calls a model, judges
creative taste, publishes work, or changes model weights.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple


SCHEMA_VERSION = "0.1"
LEVELS = ("L0", "L1", "L2", "L3", "L4", "L5")
EXECUTION_STATUSES = ("NOT_STARTED", "RUNNING", "PASS", "BLOCK")
QUALITY_STATUSES = ("NOT_EVALUATED", "PASS", "WARN", "NEEDS_TASTE")
RELEASE_STATUSES = ("NOT_READY", "CANDIDATE", "PASS", "BLOCK")
DECISIONS = ("commit", "revise", "stop", "escalate")
HUMAN_ACCEPTANCE = ("true", "false", "unknown")
EVAL_INPUT_BOUNDARIES = {
    "creative-charter",
    "rubric",
    "baseline-output",
    "candidate-output",
    "necessary-facts",
    "heldout-input",
    "candidate-proposal",
    "producer-reasoning",
    "version-identity",
    "heldout-answer",
    "mapping-table",
}
EVAL_REQUIRED_INPUTS = {
    "targeted": {"creative-charter", "rubric", "baseline-output", "candidate-output"},
    "regression": {"creative-charter", "rubric", "baseline-output", "candidate-output"},
    "heldout": {
        "creative-charter",
        "rubric",
        "baseline-output",
        "candidate-output",
        "heldout-input",
    },
}
EVAL_FORBIDDEN_INPUTS = {
    "candidate-proposal",
    "producer-reasoning",
    "version-identity",
    "heldout-answer",
    "mapping-table",
}
BUILDER_INPUT_BOUNDARIES = {
    "finding-evidence",
    "creative-charter",
    "editable-surface",
    "system-contract",
    "evaluation-policy",
    "heldout-input",
    "heldout-answer",
    "mapping-table",
    "producer-reasoning",
    "version-identity",
}
BUILDER_REQUIRED_INPUTS = {
    "finding-evidence",
    "creative-charter",
    "editable-surface",
    "system-contract",
    "evaluation-policy",
}
BUILDER_FORBIDDEN_INPUTS = {
    "heldout-input",
    "heldout-answer",
    "mapping-table",
    "producer-reasoning",
    "version-identity",
}
L4_TARGETS = {
    "prompts",
    "context",
    "loop-graph",
    "memory-policy",
    "recovery-policy",
}
L5_TARGETS = {"judge", "learning-policy", "improvement-controller"}
REQUIRED_PROTECTED = {
    "creative-system/creative-charter.md",
    "creative-system/approvals/",
    "inputs/",
    "creative-system/evals/heldout/",
    "LICENSE",
    "promotion-policy",
    "human-approval-boundary",
}
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HAN_METRIC_VERSION = "unicode-han-v1"
HAN_RANGES = (
    (0x2E80, 0x2EF3),
    (0x2F00, 0x2FD5),
    (0x3005, 0x3005),
    (0x3007, 0x3007),
    (0x3021, 0x3029),
    (0x3038, 0x303B),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x16FE2, 0x16FE3),
    (0x16FF0, 0x16FF1),
    (0x20000, 0x2A6DF),
    (0x2A700, 0x2B73F),
    (0x2B740, 0x2B81F),
    (0x2B820, 0x2CEAF),
    (0x2CEB0, 0x2EBEF),
    (0x2EBF0, 0x2EE5F),
    (0x2F800, 0x2FA1F),
    (0x30000, 0x3134F),
    (0x31350, 0x323AF),
)


class LoopCtlError(RuntimeError):
    """Expected user-facing refusal or contract failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary), str(path))
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def atomic_write_json(path: Path, value: Any) -> None:
    data = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    atomic_write_bytes(path, data)


def atomic_create_bytes(path: Path, data: bytes) -> None:
    """Create *path* atomically without ever replacing an existing file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(str(temporary), str(path))
        except FileExistsError as exc:
            raise LoopCtlError(f"目标已存在，拒绝覆盖：{path}") from exc
        except OSError:
            # Some Windows filesystems and mounted volumes do not permit hard
            # links. O_EXCL retains the no-clobber concurrency guarantee. The
            # fully-fsynced hard-link path above remains the preferred route.
            try:
                target_descriptor = os.open(
                    str(path),
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
            except FileExistsError as exc:
                raise LoopCtlError(f"目标已存在，拒绝覆盖：{path}") from exc
            try:
                with os.fdopen(target_descriptor, "wb") as target:
                    target.write(data)
                    target.flush()
                    os.fsync(target.fileno())
            except BaseException:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                raise
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_create_json(path: Path, value: Any) -> None:
    data = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    atomic_create_bytes(path, data)


@contextmanager
def exclusive_controller_lock(root: Path) -> Iterable[None]:
    """Serialize every controller mutation through one guarded project lock.

    Separate run/candidate/release locks used to permit two commands to replace
    ``system.json`` from stale snapshots.  A single lock is deliberately less
    concurrent: the project is a small local control plane, and correctness is
    more important than parallel metadata writes.
    """
    for relative in (
        "creative-system",
        "creative-system/control",
        "creative-system/control/locks",
        "creative-system/control/transactions",
    ):
        reject_symlink_components(root, relative, "项目 mutation lock")
        path = root / relative
        if not path.is_dir():
            raise LoopCtlError(f"项目 mutation lock 目录缺失或不是普通目录：{relative}")
    lock_root = root / "creative-system" / "control" / "locks"
    lock_path = lock_root / "project-mutation.lock"
    if lock_path.is_symlink() or not lock_path.is_file():
        raise LoopCtlError("项目 mutation lock 缺失或不是普通文件")
    flags = os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(str(lock_path), flags)
    except OSError as exc:
        raise LoopCtlError(f"无法安全打开项目 mutation lock：{exc}") from exc
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise LoopCtlError("项目 mutation lock 必须是普通文件")
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise LoopCtlError("CONTROLLER_BUSY：项目正由另一个控制器操作") from exc
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise LoopCtlError(f"缺少文件：{path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise LoopCtlError(f"无法读取 JSON：{path}: {exc}") from exc


def append_jsonl_atomic(path: Path, records: Iterable[Mapping[str, Any]]) -> None:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    additions = "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records)
    atomic_write_text(path, existing + additions)


def ensure_id(value: str, label: str) -> str:
    if not ID_PATTERN.fullmatch(value):
        raise LoopCtlError(f"{label} 必须是 lower-kebab-case：{value!r}")
    return value


def slugify(value: str) -> str:
    ascii_slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if ascii_slug:
        return ascii_slug[:64].rstrip("-")
    return "creative-project"


def single_line(value: str, label: str, *, maximum: int = 160) -> str:
    normalized = " ".join(value.split())
    if not normalized:
        raise LoopCtlError(f"{label} 不能为空")
    if len(normalized) > maximum:
        raise LoopCtlError(f"{label} 不能超过 {maximum} 个字符")
    return normalized


def utc_timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise LoopCtlError(f"{label} 必须是带 Z 的 UTC 时间")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise LoopCtlError(f"{label} 不是有效 ISO 8601 时间") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise LoopCtlError(f"{label} 必须使用 UTC")
    return value


def utc_datetime(value: Any, label: str) -> datetime:
    normalized = utc_timestamp(value, label)
    return datetime.fromisoformat(normalized[:-1] + "+00:00")


def regular_project_file(root: Path, relative: str, label: str) -> Path:
    path = safe_relative(root, relative, label)
    reject_symlink_components(root, Path(relative).as_posix(), label)
    if path.is_symlink() or not path.is_file():
        raise LoopCtlError(f"{label} 必须是项目内普通文件：{relative!r}")
    return path


def yaml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")


def safe_relative(root: Path, relative: str, label: str = "路径") -> Path:
    candidate_value = Path(relative)
    if candidate_value.is_absolute() or ".." in candidate_value.parts:
        raise LoopCtlError(f"{label} 必须是项目内相对路径：{relative!r}")
    root_resolved = root.resolve()
    candidate = (root / candidate_value).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise LoopCtlError(f"{label} 越出项目目录：{relative!r}") from exc
    return candidate


def reject_symlink_components(root: Path, relative: str, label: str) -> None:
    current = root
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise LoopCtlError(f"{label} 不允许经过符号链接：{relative!r}")


def guard_project_directory(
    root: Path, path: Path, label: str, *, allow_missing: bool = False
) -> None:
    """Reject symlinks, dangling symlinks and non-directory collisions."""
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError as exc:
        raise LoopCtlError(f"{label} 越出项目目录：{path}") from exc
    reject_symlink_components(root, relative, label)
    exists_lexically = os.path.lexists(str(path))
    if not exists_lexically:
        if allow_missing:
            return
        raise LoopCtlError(f"{label} 目录不存在：{relative}")
    if path.is_symlink() or not path.is_dir():
        raise LoopCtlError(f"{label} 必须是项目内普通目录：{relative}")


def guarded_mkdir_project(root: Path, path: Path, label: str) -> None:
    """Create missing in-project directories one component at a time."""
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise LoopCtlError(f"{label} 越出项目目录：{path}") from exc
    current = root
    for part in relative.parts:
        current = current / part
        if os.path.lexists(str(current)):
            if current.is_symlink() or not current.is_dir():
                raise LoopCtlError(f"{label} 不允许经过非普通目录：{relative.as_posix()}")
            continue
        current.mkdir()


def guard_project_file_target(
    root: Path, path: Path, label: str, *, allow_missing: bool = True
) -> None:
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError as exc:
        raise LoopCtlError(f"{label} 越出项目目录：{path}") from exc
    reject_symlink_components(root, relative, label)
    guard_project_directory(root, path.parent, f"{label} parent")
    if not os.path.lexists(str(path)):
        if allow_missing:
            return
        raise LoopCtlError(f"{label} 不存在：{relative}")
    if path.is_symlink() or not path.is_file():
        raise LoopCtlError(f"{label} 必须是项目内普通文件：{relative}")


def resolve_project_cli_path(root: Path, raw_value: str, label: str) -> Path:
    """Resolve a CLI path inside *root* while rejecting in-project symlinks.

    macOS commonly exposes ``/var`` as an alias of ``/private/var``. Walking
    from the first lexical prefix that resolves to the project root lets the
    controller tolerate that host alias without overlooking a symlink created
    inside the governed project.
    """
    raw_path = Path(raw_value).expanduser()
    lexical = Path(
        os.path.abspath(str(raw_path if raw_path.is_absolute() else Path.cwd() / raw_path))
    )
    resolved = lexical.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise LoopCtlError(f"{label} 必须位于项目内") from exc

    parts = lexical.parts
    current = Path(parts[0])
    root_position: Optional[int] = None
    if current.resolve() == root:
        root_position = 0
    else:
        for position, part in enumerate(parts[1:], start=1):
            current = current / part
            if current.resolve() == root:
                root_position = position
                break
    if root_position is None:
        raise LoopCtlError(f"{label} 无法绑定到项目根目录")
    current = Path(*parts[: root_position + 1])
    for part in parts[root_position + 1 :]:
        current = current / part
        if current.is_symlink():
            raise LoopCtlError(f"{label} 不允许经过项目内符号链接：{raw_value!r}")
    return resolved


def regular_file_inventory(directory: Path, *, label: str) -> List[Dict[str, Any]]:
    """Return controller facts for regular files below a governed write root."""
    if directory.is_symlink():
        raise LoopCtlError(f"{label} 不允许是符号链接：{directory}")
    if not directory.is_dir():
        raise LoopCtlError(f"{label} 不是目录：{directory}")
    files: List[Dict[str, Any]] = []
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise LoopCtlError(f"{label} 不允许包含符号链接：{path}")
        if path.is_file():
            files.append(
                {
                    "path": path.relative_to(directory).as_posix(),
                    "sha256": sha256_file(path),
                    "bytes": path.stat().st_size,
                }
            )
    return files


def unicode_han_count(text: str) -> int:
    return sum(
        1
        for character in text
        if any(start <= ord(character) <= end for start, end in HAN_RANGES)
    )


def scoped_text_metrics(text: str, exclude_first_markdown_h1: bool) -> Dict[str, Any]:
    lines = text.splitlines(keepends=True)
    excluded = ""
    scoped = text
    if exclude_first_markdown_h1 and lines and re.match(r"^ {0,3}#(?:[ \t]|(?:\r?\n)?$)", lines[0]):
        excluded = lines[0]
        scoped = "".join(lines[1:])
    return {
        "scope": (
            "exclude-first-markdown-h1"
            if exclude_first_markdown_h1
            else "whole-file"
        ),
        "excluded_first_markdown_h1": {
            "requested": exclude_first_markdown_h1,
            "applied": bool(excluded),
            "sha256": sha256_bytes(excluded.encode("utf-8")) if excluded else None,
            "unicode_han_count": unicode_han_count(excluded),
        },
        "metrics": {
            "line_count": len(scoped.splitlines()),
            "unicode_codepoint_count": len(scoped),
            "unicode_han_count": unicode_han_count(scoped),
            "unicode_han_metric_version": HAN_METRIC_VERSION,
        },
    }


def project_root(value: str) -> Path:
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise LoopCtlError(f"项目目录不存在：{root}")
    for relative in (
        "creative-system",
        "creative-system/loops",
        "creative-system/judges",
        "creative-system/approvals",
        "creative-system/evals",
        "creative-system/memory",
        "creative-system/runs",
        "creative-system/candidates",
        "creative-system/releases",
        "creative-system/control",
        "creative-system/control/locks",
        "creative-system/control/transactions",
    ):
        path = root / relative
        reject_symlink_components(root, relative, "项目控制目录")
        if not path.is_dir():
            raise LoopCtlError(f"项目控制目录缺失或不是目录：{relative}")
    reject_symlink_components(root, "creative-system/system.json", "系统入口")
    if not (root / "creative-system" / "system.json").is_file():
        raise LoopCtlError(f"不是 creative-loop2rsi 项目：{root}")
    reject_symlink_components(
        root,
        "creative-system/control/locks/project-mutation.lock",
        "项目 mutation lock",
    )
    if not (root / "creative-system/control/locks/project-mutation.lock").is_file():
        raise LoopCtlError("项目 mutation lock 缺失或不是普通文件")
    return root


def containing_attempt(root: Path, path: Path) -> Optional[Path]:
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return None
    for index in range(0, len(parts) - 4):
        if (
            parts[index : index + 2] == ("creative-system", "runs")
            and parts[index + 3] == "attempts"
            and re.fullmatch(r"attempt-[0-9]{3}", parts[index + 4])
        ):
            return root.joinpath(*parts[: index + 5])
    return None


def containing_eval_run(root: Path, path: Path) -> Optional[Path]:
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return None
    for index in range(0, len(parts) - 4):
        if (
            parts[index : index + 2] == ("creative-system", "candidates")
            and parts[index + 3] == "evaluations"
        ):
            return root.joinpath(*parts[: index + 5])
    return None


def ensure_candidate_eval_paths_safe(root: Path, candidate_root: Path) -> None:
    """Reject symlink or non-directory control planes before any eval write."""
    for path, label in (
        (candidate_root, "candidate root"),
        (candidate_root / "evaluations", "candidate evaluations root"),
        (candidate_root / "control", "candidate control root"),
        (candidate_root / "control" / "eval-open-anchors", "eval open-anchor root"),
        (candidate_root / "control" / "eval-terminal-invalid", "eval terminal root"),
    ):
        relative = path.relative_to(root).as_posix()
        reject_symlink_components(root, relative, label)
        if path.exists() and not path.is_dir():
            raise LoopCtlError(f"{label} 必须是目录：{relative}")


def system_path(root: Path) -> Path:
    return root / "creative-system" / "system.json"


def load_system(root: Path) -> Dict[str, Any]:
    value = load_json(system_path(root))
    if not isinstance(value, dict):
        raise LoopCtlError("creative-system/system.json 顶层必须是对象")
    return value


def output(payload: Mapping[str, Any], *, stream: Any = sys.stdout) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8", errors="strict")
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), file=stream)


def template_root() -> Path:
    return Path(__file__).resolve().parent.parent / "assets" / "starter-project"


def render_template(relative: str, replacements: Mapping[str, str]) -> str:
    path = template_root() / relative
    try:
        rendered = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise LoopCtlError(f"无法读取 starter template：{relative}: {exc}") from exc
    for key, value in replacements.items():
        rendered = rendered.replace("{{" + key + "}}", value)
    unresolved = sorted(set(re.findall(r"\{\{[A-Z0-9_]+\}\}", rendered)))
    if unresolved:
        raise LoopCtlError(f"starter template 仍有未替换字段：{relative}: {', '.join(unresolved)}")
    return rendered


CHARTER_CONFIRMATION_ROOT = "creative-system/approvals/charter-confirmations"
CHARTER_CONFIRMATION_EVIDENCE_ROOT = CHARTER_CONFIRMATION_ROOT + "/evidence"
CHARTER_CONFIRMATION_LEDGER = CHARTER_CONFIRMATION_ROOT + "/ledger.json"
CHARTER_CONFIRMATION_RECEIPT_PATTERN = re.compile(
    re.escape(CHARTER_CONFIRMATION_ROOT) + r"/confirmation-[0-9a-f]{64}\.json"
)
LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE = "LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE"
TRACKED_EMPTY_MARKERS = (
    "inputs/.gitkeep",
    "outputs/.gitkeep",
    "creative-system/evals/development/.gitkeep",
    "creative-system/evals/heldout/.gitkeep",
    "creative-system/memory/.gitkeep",
    "creative-system/runs/.gitkeep",
    "creative-system/candidates/.gitkeep",
    "creative-system/releases/.gitkeep",
    "creative-system/control/transactions/.gitkeep",
    CHARTER_CONFIRMATION_EVIDENCE_ROOT + "/.gitkeep",
    "creative-system/approvals/attempt-feedback/.gitkeep",
)


def add_validation_warning(warnings: Optional[List[str]], warning: str) -> None:
    if warnings is not None and warning not in warnings:
        warnings.append(warning)


def human_evidence_bytes(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise LoopCtlError(f"{label} 必须是普通文本文件：{path}")
    try:
        data = path.read_bytes()
        text = data.decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise LoopCtlError(f"{label} 必须是有效 UTF-8 文本：{path}: {exc}") from exc
    if not text.strip():
        raise LoopCtlError(f"{label} 不能为空：{path}")
    return data


def make_charter_confirmation_receipt(
    root: Path,
    *,
    confirmed_by: str,
    confirmed_at: str,
    recorded_at: str,
    evidence_relative: str,
) -> Dict[str, Any]:
    charter_relative = "creative-system/creative-charter.md"
    charter_path = regular_project_file(root, charter_relative, "创作宪法")
    evidence_relative = Path(evidence_relative).as_posix()
    if not evidence_relative.startswith(CHARTER_CONFIRMATION_EVIDENCE_ROOT + "/"):
        raise LoopCtlError(
            f"创作宪法人工确认依据必须位于 {CHARTER_CONFIRMATION_EVIDENCE_ROOT}/"
        )
    evidence_path = regular_project_file(root, evidence_relative, "创作宪法人工确认依据")
    confirmed_by = single_line(confirmed_by, "--confirmed-by")
    confirmed_at = utc_timestamp(confirmed_at, "--confirmed-at")
    recorded_at = utc_timestamp(recorded_at, "recorded_at")
    if utc_datetime(confirmed_at, "--confirmed-at") > utc_datetime(recorded_at, "recorded_at"):
        raise LoopCtlError("--confirmed-at 不得晚于控制器记录时间")
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "CharterConfirmation",
        "confirmed_by": confirmed_by,
        "confirmed_at": confirmed_at,
        "recorded_at": recorded_at,
        "charter": {
            "path": charter_relative,
            "sha256": sha256_file(charter_path),
            "bytes": charter_path.stat().st_size,
        },
        "evidence": {
            "path": evidence_relative,
            "sha256": sha256_file(evidence_path),
            "bytes": evidence_path.stat().st_size,
        },
        "identity_authentication": "external-attestation-not-controller-verified",
    }


def charter_confirmation_receipt_relative(receipt: Mapping[str, Any]) -> str:
    identity = {
        "charter": receipt.get("charter"),
        "evidence": receipt.get("evidence"),
        "confirmed_by": receipt.get("confirmed_by"),
        "confirmed_at": receipt.get("confirmed_at"),
    }
    digest = sha256_bytes(canonical_json_bytes(identity))
    return f"{CHARTER_CONFIRMATION_ROOT}/confirmation-{digest}.json"


def empty_charter_confirmation_ledger() -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "CharterConfirmationLedger",
        "entries": [],
    }


def charter_confirmation_ledger_entry(
    sequence: int,
    receipt_relative: str,
    receipt_sha256: str,
    previous_entry_sha256: Optional[str],
) -> Dict[str, Any]:
    core = {
        "sequence": sequence,
        "receipt_path": receipt_relative,
        "receipt_sha256": receipt_sha256,
        "previous_entry_sha256": previous_entry_sha256,
    }
    return {
        **core,
        "entry_sha256": sha256_bytes(canonical_json_bytes(core)),
    }


def validate_charter_confirmation_receipt_file(
    root: Path,
    receipt_relative: str,
    *,
    expected_sha256: Optional[str] = None,
    warnings: Optional[List[str]] = None,
) -> Tuple[List[str], Optional[Dict[str, Any]]]:
    errors: List[str] = []
    if not CHARTER_CONFIRMATION_RECEIPT_PATTERN.fullmatch(receipt_relative):
        return [f"创作宪法确认凭证路径无效：{receipt_relative}"], None
    try:
        receipt_path = regular_project_file(root, receipt_relative, "创作宪法确认凭证")
        actual_sha256 = sha256_file(receipt_path)
        if expected_sha256 is not None and actual_sha256 != expected_sha256:
            errors.append(f"创作宪法确认凭证哈希不一致：{receipt_relative}")
        receipt = load_json(receipt_path)
    except LoopCtlError as exc:
        return [str(exc)], None
    if not isinstance(receipt, dict):
        return [f"创作宪法确认凭证顶层必须是对象：{receipt_relative}"], None
    if receipt.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"创作宪法确认凭证 schema_version 无效：{receipt_relative}")
    if receipt.get("kind") != "CharterConfirmation":
        errors.append(f"创作宪法确认凭证 kind 无效：{receipt_relative}")
    if charter_confirmation_receipt_relative(receipt) != receipt_relative:
        errors.append(f"创作宪法确认凭证路径与内容摘要不一致：{receipt_relative}")
    if receipt.get("identity_authentication") != "external-attestation-not-controller-verified":
        errors.append(f"创作宪法确认凭证未声明外部身份认证边界：{receipt_relative}")
    if not isinstance(receipt.get("confirmed_by"), str) or not receipt["confirmed_by"].strip():
        errors.append(f"创作宪法确认凭证缺少 confirmed_by：{receipt_relative}")
    try:
        confirmed_dt = utc_datetime(receipt.get("confirmed_at"), "receipt.confirmed_at")
        recorded_dt = utc_datetime(receipt.get("recorded_at"), "receipt.recorded_at")
        if confirmed_dt > recorded_dt:
            errors.append(f"创作宪法确认时间晚于控制器记录时间：{receipt_relative}")
    except LoopCtlError as exc:
        errors.append(str(exc))

    for section_name in ("charter", "evidence"):
        section = receipt.get(section_name)
        if not isinstance(section, dict):
            errors.append(f"创作宪法确认凭证缺少 {section_name}：{receipt_relative}")
            continue
        relative = section.get("path")
        if not isinstance(relative, str):
            errors.append(f"创作宪法确认凭证 {section_name}.path 无效：{receipt_relative}")
            continue
        if section_name == "charter" and relative != "creative-system/creative-charter.md":
            errors.append(f"创作宪法确认凭证 charter.path 无效：{receipt_relative}")
            continue
        if section_name == "evidence" and not relative.startswith(
            CHARTER_CONFIRMATION_EVIDENCE_ROOT + "/"
        ):
            errors.append(f"创作宪法确认依据不在受保护 evidence 目录：{receipt_relative}")
            continue
        if (
            not isinstance(section.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", str(section.get("sha256")))
            or not isinstance(section.get("bytes"), int)
            or isinstance(section.get("bytes"), bool)
            or section["bytes"] < 1
        ):
            errors.append(
                f"创作宪法确认凭证 {section_name} 摘要字段无效：{receipt_relative}"
            )
        if section_name == "charter":
            # Historical confirmations intentionally bind the charter bytes at
            # that time.  A later explicit edit + reconfirm changes the live
            # charter, so history validation must not compare old receipts to
            # today's file.  The ledger still detects any receipt mutation.
            continue
        try:
            safe_relative(root, relative, f"确认凭证 {section_name}")
            reject_symlink_components(root, relative, f"确认凭证 {section_name}")
            if not os.path.lexists(str(root / Path(relative))):
                add_validation_warning(warnings, LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE)
                continue
            source = regular_project_file(root, relative, f"确认凭证 {section_name}")
            if section.get("sha256") != sha256_file(source):
                errors.append(f"创作宪法确认凭证 {section_name} 哈希不一致：{receipt_relative}")
            if section.get("bytes") != source.stat().st_size:
                errors.append(f"创作宪法确认凭证 {section_name} 字节数不一致：{receipt_relative}")
            if section_name == "evidence":
                human_evidence_bytes(source, "创作宪法人工确认依据")
        except LoopCtlError as exc:
            errors.append(str(exc))
    return errors, receipt


def validate_charter_confirmation_ledger_entries(
    root: Path, warnings: Optional[List[str]] = None
) -> Tuple[List[str], Optional[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    errors: List[str] = []
    try:
        ledger_path = regular_project_file(root, CHARTER_CONFIRMATION_LEDGER, "确认历史账本")
        ledger = load_json(ledger_path)
    except LoopCtlError as exc:
        return [str(exc)], None, {}
    if (
        not isinstance(ledger, dict)
        or ledger.get("schema_version") != SCHEMA_VERSION
        or ledger.get("kind") != "CharterConfirmationLedger"
        or not isinstance(ledger.get("entries"), list)
    ):
        return ["创作宪法确认历史账本合同无效"], None, {}
    previous: Optional[str] = None
    seen_paths: Set[str] = set()
    receipts: Dict[str, Dict[str, Any]] = {}
    for position, raw_entry in enumerate(ledger["entries"], start=1):
        if not isinstance(raw_entry, dict):
            errors.append(f"确认历史账本第 {position} 条不是对象")
            continue
        receipt_relative = raw_entry.get("receipt_path")
        receipt_sha256 = raw_entry.get("receipt_sha256")
        if (
            raw_entry.get("sequence") != position
            or not isinstance(receipt_relative, str)
            or not isinstance(receipt_sha256, str)
            or not re.fullmatch(r"[0-9a-f]{64}", receipt_sha256)
            or raw_entry.get("previous_entry_sha256") != previous
        ):
            errors.append(f"确认历史账本第 {position} 条链字段无效")
            continue
        expected_entry = charter_confirmation_ledger_entry(
            position, receipt_relative, receipt_sha256, previous
        )
        if raw_entry != expected_entry:
            errors.append(f"确认历史账本第 {position} 条摘要无效")
        if receipt_relative in seen_paths:
            errors.append(f"确认历史账本重复引用凭证：{receipt_relative}")
        seen_paths.add(receipt_relative)
        receipt_errors, receipt = validate_charter_confirmation_receipt_file(
            root,
            receipt_relative,
            expected_sha256=receipt_sha256,
            warnings=warnings,
        )
        errors.extend(receipt_errors)
        if receipt is not None:
            receipts[receipt_relative] = receipt
        previous = raw_entry.get("entry_sha256")
    return errors, ledger, receipts


def scan_charter_confirmation_receipts(root: Path) -> Tuple[Set[str], List[str]]:
    receipt_root = root / CHARTER_CONFIRMATION_ROOT
    errors: List[str] = []
    try:
        guard_project_directory(root, receipt_root, "创作宪法确认凭证目录")
    except LoopCtlError as exc:
        return set(), [str(exc)]
    receipts: Set[str] = set()
    for entry in sorted(receipt_root.iterdir()):
        if not entry.name.startswith("confirmation-"):
            continue
        relative = entry.relative_to(root).as_posix()
        receipts.add(relative)
        if not CHARTER_CONFIRMATION_RECEIPT_PATTERN.fullmatch(relative):
            errors.append(f"创作宪法确认凭证文件名无效：{relative}")
            continue
        if entry.is_symlink() or not entry.is_file():
            errors.append(f"创作宪法确认凭证必须是普通文件：{relative}")
    return receipts, errors


def validate_charter_confirmation_history(
    root: Path, warnings: Optional[List[str]] = None
) -> List[str]:
    errors, ledger, _ = validate_charter_confirmation_ledger_entries(root, warnings)
    disk_receipts, scan_errors = scan_charter_confirmation_receipts(root)
    errors.extend(scan_errors)
    if ledger is None:
        return errors
    ledger_receipts = {
        entry.get("receipt_path")
        for entry in ledger.get("entries", [])
        if isinstance(entry, dict) and isinstance(entry.get("receipt_path"), str)
    }
    for relative in sorted(disk_receipts - ledger_receipts):
        errors.append(f"UNLEDGERED_CHARTER_CONFIRMATION：{relative}")
    for relative in sorted(ledger_receipts - disk_receipts):
        errors.append(f"CHARTER_CONFIRMATION_RECEIPT_SET_MISMATCH：磁盘缺少 {relative}")
    return errors


def append_charter_confirmation_ledger(
    root: Path, receipt_relative: str, receipt_sha256: str
) -> bool:
    errors, ledger, _ = validate_charter_confirmation_ledger_entries(root)
    disk_receipts, scan_errors = scan_charter_confirmation_receipts(root)
    errors.extend(scan_errors)
    if ledger is None:
        raise LoopCtlError("确认历史账本无效：" + "; ".join(errors))
    entries = ledger.get("entries", [])
    ledger_receipts = {
        entry.get("receipt_path")
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("receipt_path"), str)
    }
    unrelated_orphans = disk_receipts - ledger_receipts - {receipt_relative}
    if unrelated_orphans:
        errors.append(
            "存在不相关的未入账创作宪法确认凭证：" + ", ".join(sorted(unrelated_orphans))
        )
    if receipt_relative not in disk_receipts:
        errors.append(f"待追加的创作宪法确认凭证不存在：{receipt_relative}")
    target_errors, _ = validate_charter_confirmation_receipt_file(
        root, receipt_relative, expected_sha256=receipt_sha256
    )
    errors.extend(target_errors)
    if errors:
        raise LoopCtlError("确认历史账本无效：" + "; ".join(errors))
    for entry in entries:
        if isinstance(entry, dict) and entry.get("receipt_path") == receipt_relative:
            if entry.get("receipt_sha256") != receipt_sha256:
                raise LoopCtlError("确认历史账本已有同路径但哈希不同的凭证")
            return False
    previous = entries[-1].get("entry_sha256") if entries else None
    next_entry = charter_confirmation_ledger_entry(
        len(entries) + 1, receipt_relative, receipt_sha256, previous
    )
    next_ledger = dict(ledger)
    next_ledger["entries"] = list(entries) + [next_entry]
    atomic_write_json(root / CHARTER_CONFIRMATION_LEDGER, next_ledger)
    post_errors = validate_charter_confirmation_history(root)
    if post_errors:
        raise LoopCtlError("确认历史账本追加后无效：" + "; ".join(post_errors))
    return True


def apply_charter_confirmation_fields(
    system: Dict[str, Any], receipt: Mapping[str, Any], receipt_relative: str, receipt_sha256: str
) -> None:
    charter = system.setdefault("charter", {})
    charter.update(
        {
            "confirmed": True,
            "confirmed_by": receipt.get("confirmed_by"),
            "confirmed_at": receipt.get("confirmed_at"),
            "confirmation_receipt": receipt_relative,
            "confirmation_receipt_sha256": receipt_sha256,
        }
    )


def charter_confirmation_matches_request(
    receipt: Mapping[str, Any],
    *,
    charter_identity: Mapping[str, Any],
    evidence_identity: Mapping[str, Any],
    confirmed_by: str,
    confirmed_at: Optional[str],
) -> bool:
    return (
        receipt.get("charter") == charter_identity
        and receipt.get("evidence") == evidence_identity
        and receipt.get("confirmed_by") == confirmed_by
        and (confirmed_at is None or receipt.get("confirmed_at") == confirmed_at)
    )


def system_charter_points_to_confirmation(
    charter: Mapping[str, Any],
    receipt: Mapping[str, Any],
    receipt_relative: str,
    receipt_sha256: str,
) -> bool:
    return (
        charter.get("confirmed") is True
        and charter.get("confirmed_by") == receipt.get("confirmed_by")
        and charter.get("confirmed_at") == receipt.get("confirmed_at")
        and charter.get("confirmation_receipt") == receipt_relative
        and charter.get("confirmation_receipt_sha256") == receipt_sha256
    )


def initial_system(args: argparse.Namespace) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "CreativeSystem",
        "project": {
            "id": slugify(args.project_name),
            "name": args.project_name,
            "domain_skill": args.domain_skill,
            "active_version": "baseline-v1",
        },
        "charter": {
            "path": "creative-system/creative-charter.md",
            "confirmed": False,
            "confirmed_by": None,
            "confirmed_at": None,
            "confirmation_receipt": None,
            "confirmation_receipt_sha256": None,
        },
        "maturity": {"declared": "L0", "evidence": []},
        "loops": ["creative-system/loops/main-loop.json"],
        "artifacts": [
            {
                "id": "creative-brief",
                "path": "inputs/creative-brief.md",
                "owner": "human-creator",
                "kind": "input",
                "protected": True,
            },
            {
                "id": "creative-work",
                "path": "outputs/creative-work.md",
                "owner": "creative-producer",
                "kind": "output",
                "protected": False,
            },
        ],
        "judges": [
            "creative-system/judges/hard-contract.json",
            "creative-system/judges/taste-gate.json",
        ],
        "memory": {
            "partitions": [
                {
                    "id": "confirmed-preferences",
                    "writer": "human-creator",
                    "path": "creative-system/memory/confirmed-preferences.jsonl",
                },
                {
                    "id": "run-lessons",
                    "writer": "creative-reviewer",
                    "path": "creative-system/memory/run-lessons.jsonl",
                },
                {
                    "id": "finding-index",
                    "writer": "loopctl",
                    "path": "creative-system/memory/finding-index.jsonl",
                },
            ]
        },
        "recovery_policy": {
            "max_attempts": 3,
            "stop_after_no_improvement": 2,
            "runtime_dispatch_budget": {
                "max_zero_file_stalls": 2,
                "zero_output_consumes_content_attempt": False,
                "on_exhausted": "escalate",
            },
            "mechanical_evidence": {
                "governing_source": "loopctl.py measure-artifact",
                "producer_self_report": "non-governing",
            },
            "automatic_actions": [
                "retry-runtime-failure",
                "deterministic-nonsemantic-repair",
                "rerun-responsible-loop",
            ],
        },
        "learning_policy": {
            "minimum_independent_runs": 3,
            "candidate_isolation_required": True,
            "heldout_blind_required": True,
        },
        "promotion_policy": {
            "human_approval_required": True,
            "l5_auto_promotion": False,
        },
        "protected_surfaces": sorted(REQUIRED_PROTECTED),
        "editable_surfaces": sorted(L4_TARGETS),
        "statuses": {
            "execution_status": "NOT_STARTED",
            "quality_status": "NOT_EVALUATED",
            "release_status": "NOT_READY",
        },
    }


def initial_loop() -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "LoopSpec",
        "id": "main-loop",
        "goal": "完成一份符合创作宪法的最小完整成品",
        "reads": ["creative-brief"],
        "writes": ["creative-work"],
        "owner": "creative-producer",
        "trigger": {"on": ["manual", "creative-brief.changed"]},
        "producer": {"agent": "creative-producer", "separate_from_judges": True},
        "judges": ["hard-contract", "taste-gate"],
        "decision_policy": ["hard-block", "needs-taste", "revise", "commit"],
        "memory_updates": ["confirmed-preferences", "run-lessons", "finding-index"],
        "retry_budget": {
            "max_attempts": 3,
            "max_no_improvement": 2,
            "on_budget_exhausted": "escalate",
        },
        "stop_conditions": ["retry-budget-exhausted", "no-improvement-twice"],
        "human_gate": {"required": True, "when": "before-release"},
    }


def initial_judges() -> Tuple[Dict[str, Any], Dict[str, Any]]:
    hard = {
        "schema_version": SCHEMA_VERSION,
        "kind": "JudgeSpec",
        "id": "hard-contract",
        "type": "deterministic",
        "mode": "block",
        "agent": "contract-checker",
        "rubric": ["检查已确认的格式、事实、来源和明确禁区"],
        "evidence_requirements": ["creative-brief", "creative-work"],
        "calibration": None,
        "promotion_requirements": {"hard_false_passes": 0},
    }
    taste = {
        "schema_version": SCHEMA_VERSION,
        "kind": "JudgeSpec",
        "id": "taste-gate",
        "type": "human",
        "mode": "warn",
        "agent": "human-creator",
        "rubric": ["判断作品是否符合创作宪法中值得保留的审美偏好"],
        "evidence_requirements": ["creative-work"],
        "calibration": None,
        "promotion_requirements": {"directional_agreement": 0.8},
    }
    return hard, taste


def write_initialized_project(destination: Path, args: argparse.Namespace) -> None:
    replacements = {
        "PROJECT_NAME": args.project_name,
        "PROJECT_NAME_YAML": yaml_escape(args.project_name),
        "DISPLAY_NAME": yaml_escape(args.project_name),
        "DISPLAY_NAME_YAML": yaml_escape(args.project_name),
        "DOMAIN_SKILL": args.domain_skill,
        "CREATIVE_GOAL": args.creative_goal,
        "MINIMUM_PRODUCT": args.minimum_product,
        "REPRESENTATIVE_TASK": args.representative_task,
        "CONSTRAINTS": args.constraints,
        "TASTE": args.taste,
    }
    directories = [
        "inputs",
        "outputs",
        "creative-system/loops",
        "creative-system/judges",
        "creative-system/approvals",
        CHARTER_CONFIRMATION_EVIDENCE_ROOT,
        "creative-system/approvals/attempt-feedback",
        "creative-system/evals/development",
        "creative-system/evals/heldout",
        "creative-system/memory",
        "creative-system/runs",
        "creative-system/candidates",
        "creative-system/releases",
        "creative-system/control/locks",
        "creative-system/control/transactions",
        f"skills/{args.domain_skill}/agents",
        f"skills/{args.domain_skill}/references",
    ]
    for relative in directories:
        (destination / relative).mkdir(parents=True, exist_ok=True)
    for relative in TRACKED_EMPTY_MARKERS:
        atomic_create_bytes(destination / relative, b"")
    atomic_create_bytes(
        destination / "creative-system/control/locks/project-mutation.lock",
        b"creative-loop2rsi project mutation lock\n",
    )

    text_files = {
        "README.md": "README.md.tmpl",
        "AGENTS.md": "AGENTS.md.tmpl",
        ".gitattributes": "gitattributes.tmpl",
        ".gitignore": "gitignore.tmpl",
        "creative-system/creative-charter.md": "creative-system/creative-charter.md.tmpl",
        f"skills/{args.domain_skill}/SKILL.md": "domain-skill/SKILL.md.tmpl",
        f"skills/{args.domain_skill}/agents/openai.yaml": "domain-skill/openai.yaml.tmpl",
        f"skills/{args.domain_skill}/references/project-contract.md": (
            "domain-skill/references/project-contract.md.tmpl"
        ),
    }
    for output_name, template_name in text_files.items():
        atomic_write_text(destination / output_name, render_template(template_name, replacements))

    hard, taste = initial_judges()
    system = initial_system(args)
    atomic_create_json(
        destination / CHARTER_CONFIRMATION_LEDGER,
        empty_charter_confirmation_ledger(),
    )
    if args.charter_confirmed:
        evidence_relative = CHARTER_CONFIRMATION_EVIDENCE_ROOT + "/initial-confirmation.txt"
        evidence_path = destination / evidence_relative
        atomic_create_bytes(evidence_path, args.charter_confirmation_bytes)
        recorded_at = utc_now()
        confirmed_at = args.charter_confirmed_at or recorded_at
        receipt = make_charter_confirmation_receipt(
            destination,
            confirmed_by=args.charter_confirmed_by,
            confirmed_at=confirmed_at,
            recorded_at=recorded_at,
            evidence_relative=evidence_relative,
        )
        receipt_relative = charter_confirmation_receipt_relative(receipt)
        receipt_path = destination / receipt_relative
        atomic_create_json(receipt_path, receipt)
        append_charter_confirmation_ledger(
            destination, receipt_relative, sha256_file(receipt_path)
        )
        apply_charter_confirmation_fields(
            system, receipt, receipt_relative, sha256_file(receipt_path)
        )
    atomic_write_json(destination / "creative-system/system.json", system)
    atomic_write_json(destination / "creative-system/loops/main-loop.json", initial_loop())
    atomic_write_json(destination / "creative-system/judges/hard-contract.json", hard)
    atomic_write_json(destination / "creative-system/judges/taste-gate.json", taste)


def command_init(args: argparse.Namespace) -> Dict[str, Any]:
    target_input = Path(args.target).expanduser()
    if target_input.is_symlink():
        raise LoopCtlError(f"拒绝把符号链接作为初始化目标：{target_input}")
    target = target_input.resolve()
    args.project_name = single_line(args.project_name, "--project-name")
    args.domain_skill = ensure_id(args.domain_skill, "--domain-skill")
    for field, label in (
        ("creative_goal", "--creative-goal"),
        ("minimum_product", "--minimum-product"),
        ("representative_task", "--representative-task"),
        ("constraints", "--constraints"),
        ("taste", "--taste"),
    ):
        value = getattr(args, field)
        if not value.strip():
            raise LoopCtlError(f"{label} 不能为空")

    confirmation_companions = (
        args.charter_confirmed_by,
        args.charter_confirmed_at,
        args.charter_confirmation_evidence,
    )
    if args.charter_confirmed:
        if not args.charter_confirmed_by or not args.charter_confirmation_evidence:
            raise LoopCtlError(
                "--charter-confirmed 必须同时提供 --charter-confirmed-by 与 "
                "--charter-confirmation-evidence；控制器不得代签人工确认"
            )
        args.charter_confirmed_by = single_line(
            args.charter_confirmed_by, "--charter-confirmed-by"
        )
        if args.charter_confirmed_at:
            utc_timestamp(args.charter_confirmed_at, "--charter-confirmed-at")
        evidence_source = Path(args.charter_confirmation_evidence).expanduser()
        args.charter_confirmation_bytes = human_evidence_bytes(
            evidence_source, "--charter-confirmation-evidence"
        )
    elif any(value is not None for value in confirmation_companions):
        raise LoopCtlError("创作宪法确认参数只能与 --charter-confirmed 一起使用")

    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise LoopCtlError(f"拒绝覆盖非空目标：{target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.init-", dir=str(target.parent)))
    try:
        write_initialized_project(staging, args)
        report = validate_project(staging)
        if report["errors"]:
            raise LoopCtlError("生成项目未通过内部验证：" + "; ".join(report["errors"]))
        if target.exists():
            target.rmdir()
        os.replace(str(staging), str(target))
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return {
        "status": "PASS",
        "project": str(target),
        "charter_status": "PASS" if args.charter_confirmed else "NEEDS_TASTE",
        "provable_maturity": "L0" if args.charter_confirmed else "NONE",
        "next_step": (
            "运行 validate 与 audit，开始第一个 L1 Loop"
            if args.charter_confirmed
            else (
                "阅读 creative-system/creative-charter.md；用户明确确认后保存原始回复，"
                "再运行 confirm-charter"
            )
        ),
    }


def command_confirm_charter(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    with exclusive_controller_lock(root):
        history_warnings: List[str] = []
        history_errors, ledger, ledger_receipts = validate_charter_confirmation_ledger_entries(
            root, history_warnings
        )
        disk_receipts, scan_errors = scan_charter_confirmation_receipts(root)
        history_errors.extend(scan_errors)
        if ledger is None:
            raise LoopCtlError("确认历史未通过：" + "; ".join(history_errors))
        entries = ledger.get("entries", [])
        ledger_paths = {
            entry.get("receipt_path")
            for entry in entries
            if isinstance(entry, dict) and isinstance(entry.get("receipt_path"), str)
        }
        missing_receipts = ledger_paths - disk_receipts
        if missing_receipts:
            history_errors.append(
                "CHARTER_CONFIRMATION_RECEIPT_SET_MISMATCH：磁盘缺少 "
                + ", ".join(sorted(missing_receipts))
            )
        orphan_paths = disk_receipts - ledger_paths
        if len(orphan_paths) > 1:
            history_errors.append(
                "存在多个未入账创作宪法确认凭证，拒绝猜测恢复："
                + ", ".join(sorted(orphan_paths))
            )
        orphan_receipt: Optional[Dict[str, Any]] = None
        orphan_relative: Optional[str] = None
        if len(orphan_paths) == 1:
            orphan_relative = next(iter(orphan_paths))
            orphan_errors, orphan_receipt = validate_charter_confirmation_receipt_file(
                root, orphan_relative, warnings=history_warnings
            )
            history_errors.extend(orphan_errors)
        if history_errors:
            raise LoopCtlError("确认历史未通过：" + "; ".join(history_errors))

        system = load_system(root)
        charter = system.get("charter")
        if not isinstance(charter, dict):
            raise LoopCtlError("system.charter 无效")

        evidence_relative = Path(args.evidence).as_posix()
        evidence_source = regular_project_file(root, evidence_relative, "--evidence")
        human_evidence_bytes(evidence_source, "--evidence")
        if not evidence_relative.startswith(CHARTER_CONFIRMATION_EVIDENCE_ROOT + "/"):
            raise LoopCtlError(
                f"--evidence 必须位于 {CHARTER_CONFIRMATION_EVIDENCE_ROOT}/"
            )
        confirmed_by = single_line(args.confirmed_by, "--confirmed-by")
        requested_confirmed_at = (
            utc_timestamp(args.confirmed_at, "--confirmed-at") if args.confirmed_at else None
        )
        charter_path = regular_project_file(
            root, "creative-system/creative-charter.md", "创作宪法"
        )
        charter_identity = {
            "path": "creative-system/creative-charter.md",
            "sha256": sha256_file(charter_path),
            "bytes": charter_path.stat().st_size,
        }
        evidence_identity = {
            "path": evidence_relative,
            "sha256": sha256_file(evidence_source),
            "bytes": evidence_source.stat().st_size,
        }

        active_relative = charter.get("confirmation_receipt")
        active_receipt = (
            ledger_receipts.get(active_relative) if isinstance(active_relative, str) else None
        )
        if (
            active_receipt is not None
            and charter_confirmation_matches_request(
                active_receipt,
                charter_identity=charter_identity,
                evidence_identity=evidence_identity,
                confirmed_by=confirmed_by,
                confirmed_at=requested_confirmed_at,
            )
        ):
            active_sha256 = sha256_file(root / str(active_relative))
            if system_charter_points_to_confirmation(
                charter, active_receipt, str(active_relative), active_sha256
            ):
                report = validate_project(root)
                if report["errors"]:
                    raise LoopCtlError("现有确认未通过验证：" + "; ".join(report["errors"]))
                return {
                    "status": "PASS",
                    "charter_status": "PASS",
                    "confirmation_receipt": active_relative,
                    "confirmation_receipt_sha256": active_sha256,
                    "idempotent": True,
                    "next_step": "运行 audit，开始当前最小成熟度任务",
                }

        recovery_kind: Optional[str] = None
        target_relative: Optional[str] = None
        target_receipt: Optional[Dict[str, Any]] = None
        target_sha256: Optional[str] = None
        if orphan_relative is not None and orphan_receipt is not None:
            if not charter_confirmation_matches_request(
                orphan_receipt,
                charter_identity=charter_identity,
                evidence_identity=evidence_identity,
                confirmed_by=confirmed_by,
                confirmed_at=requested_confirmed_at,
            ):
                raise LoopCtlError(
                    "存在不相关的未入账创作宪法确认凭证，拒绝创建或猜测恢复："
                    + orphan_relative
                )
            target_relative = orphan_relative
            target_receipt = orphan_receipt
            target_sha256 = sha256_file(root / orphan_relative)
            append_charter_confirmation_ledger(root, target_relative, target_sha256)
            recovery_kind = "orphan-receipt"
        elif entries:
            tail = entries[-1]
            tail_relative = tail.get("receipt_path") if isinstance(tail, dict) else None
            tail_receipt = (
                ledger_receipts.get(tail_relative) if isinstance(tail_relative, str) else None
            )
            if (
                tail_receipt is not None
                and charter_confirmation_matches_request(
                    tail_receipt,
                    charter_identity=charter_identity,
                    evidence_identity=evidence_identity,
                    confirmed_by=confirmed_by,
                    confirmed_at=requested_confirmed_at,
                )
            ):
                tail_sha256 = sha256_file(root / str(tail_relative))
                if not system_charter_points_to_confirmation(
                    charter, tail_receipt, str(tail_relative), tail_sha256
                ):
                    target_relative = str(tail_relative)
                    target_receipt = tail_receipt
                    target_sha256 = tail_sha256
                    recovery_kind = "ledger-ahead-system"

        if recovery_kind is not None:
            assert target_relative is not None
            assert target_receipt is not None
            assert target_sha256 is not None
            system_before = json.loads(json.dumps(system))
            apply_charter_confirmation_fields(
                system, target_receipt, target_relative, target_sha256
            )
            atomic_write_json(system_path(root), system)
            report = validate_project(root)
            if report["errors"]:
                atomic_write_json(system_path(root), system_before)
                raise LoopCtlError("确认恢复后未通过验证：" + "; ".join(report["errors"]))
            return {
                "status": "PASS",
                "charter_status": "PASS",
                "confirmation_receipt": target_relative,
                "confirmation_receipt_sha256": target_sha256,
                "recovered": recovery_kind,
                "identity_authentication": "external-attestation-not-controller-verified",
                "next_step": "运行 audit，开始当前最小成熟度任务",
            }

        confirmed_at = requested_confirmed_at or utc_now()
        provisional_receipt = make_charter_confirmation_receipt(
            root,
            confirmed_by=confirmed_by,
            confirmed_at=confirmed_at,
            recorded_at=utc_now(),
            evidence_relative=evidence_relative,
        )
        receipt_relative = charter_confirmation_receipt_relative(provisional_receipt)
        receipt_path = root / receipt_relative
        if receipt_path.exists():
            if receipt_path.is_symlink() or not receipt_path.is_file():
                raise LoopCtlError("创作宪法确认凭证路径已被非普通文件占用")
            raw_receipt = load_json(receipt_path)
            if not isinstance(raw_receipt, dict):
                raise LoopCtlError("创作宪法确认凭证无效")
            expected_receipt = make_charter_confirmation_receipt(
                root,
                confirmed_by=confirmed_by,
                confirmed_at=confirmed_at,
                recorded_at=str(raw_receipt.get("recorded_at")),
                evidence_relative=evidence_relative,
            )
            if raw_receipt != expected_receipt:
                raise LoopCtlError("创作宪法确认凭证已存在且内容不一致，拒绝覆盖")
        else:
            expected_receipt = provisional_receipt
            atomic_create_json(receipt_path, expected_receipt)

        receipt_sha256 = sha256_file(receipt_path)
        append_charter_confirmation_ledger(root, receipt_relative, receipt_sha256)

        system_before = json.loads(json.dumps(system))
        apply_charter_confirmation_fields(
            system, expected_receipt, receipt_relative, receipt_sha256
        )
        atomic_write_json(system_path(root), system)
        report = validate_project(root)
        if report["errors"]:
            atomic_write_json(system_path(root), system_before)
            raise LoopCtlError("确认写入后未通过验证：" + "; ".join(report["errors"]))
        return {
            "status": "PASS",
            "charter_status": "PASS",
            "confirmation_receipt": receipt_relative,
            "confirmation_receipt_sha256": receipt_sha256,
            "identity_authentication": "external-attestation-not-controller-verified",
            "next_step": "运行 audit，开始当前最小成熟度任务",
        }


def _required_dict(value: Any, name: str, errors: List[str]) -> Dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{name} 必须是对象")
        return {}
    return value


def _required_list(value: Any, name: str, errors: List[str]) -> List[Any]:
    if not isinstance(value, list):
        errors.append(f"{name} 必须是数组")
        return []
    return value


def _surface_overlap(left: str, right: str) -> bool:
    a = left.strip("/").casefold()
    b = right.strip("/").casefold()
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def _find_cycle_nodes(graph: Mapping[str, Set[str]]) -> Set[str]:
    visiting: Set[str] = set()
    visited: Set[str] = set()
    stack: List[str] = []
    cyclic: Set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            try:
                start = stack.index(node)
            except ValueError:
                start = 0
            cyclic.update(stack[start:])
            cyclic.add(node)
            return
        if node in visited:
            return
        visiting.add(node)
        stack.append(node)
        for neighbour in graph.get(node, set()):
            visit(neighbour)
        stack.pop()
        visiting.remove(node)
        visited.add(node)

    for item in graph:
        visit(item)
    return cyclic


def validate_human_feedback_receipt(
    root: Path, attempt: Path, manifest: Mapping[str, Any]
) -> List[str]:
    errors: List[str] = []
    has_claim = (
        manifest.get("human_accepted") in {True, False}
        or manifest.get("human_direction") in {"PASS", "BLOCK"}
    )
    receipt = manifest.get("human_feedback_receipt")
    if not has_claim:
        if receipt is not None:
            errors.append(f"无人工判断的 attempt 不得携带 human feedback receipt：{attempt}")
        return errors
    if not isinstance(receipt, dict):
        return [f"人工判断缺少 human feedback receipt：{attempt}"]
    if receipt.get("schema_version") != SCHEMA_VERSION or receipt.get("kind") != "HumanFeedbackReceipt":
        errors.append(f"human feedback receipt 合同无效：{attempt}")
    if receipt.get("identity_authentication") != "external-attestation-not-controller-verified":
        errors.append(f"human feedback receipt 未声明外部身份认证边界：{attempt}")
    if receipt.get("controller_verification") != {
        "evidence_hash_verified": True,
        "human_identity_verified": False,
    }:
        errors.append(f"human feedback receipt 的控制器验证边界无效：{attempt}")
    feedback_by = receipt.get("feedback_by")
    if not isinstance(feedback_by, str) or not feedback_by.strip():
        errors.append(f"human feedback receipt 缺少 feedback_by：{attempt}")
    claims = receipt.get("claims")
    if not isinstance(claims, dict) or claims != {
        "human_accepted": manifest.get("human_accepted"),
        "human_direction": manifest.get("human_direction"),
    }:
        errors.append(f"human feedback receipt 未绑定 manifest 人工判断：{attempt}")
    subject = receipt.get("subject")
    review: Optional[Dict[str, Any]] = None
    try:
        review = verify_human_review_subject(root, attempt)
        review_subject = review["subject"]
        review_anchor = review["anchor"]
        expected_subject = {
            "run_id": manifest.get("run_id"),
            "attempt_id": manifest.get("attempt_id"),
            "loop_id": manifest.get("loop_id"),
            "review_subject_path": review["subject_path"],
            "review_subject_sha256": review["subject_sha256"],
            "review_open_anchor_path": review["anchor_path"],
            "review_open_anchor_sha256": review["anchor_sha256"],
            "review_available_at": review_anchor.get("review_available_at"),
            "artifact_subject_sha256": review_subject.get("artifact_subject_sha256"),
        }
        if subject != expected_subject:
            errors.append(f"human feedback receipt 未绑定冻结送审 subject/anchor：{attempt}")
        if manifest.get("machine_direction") != review_subject.get("machine_direction"):
            errors.append(f"manifest 机器方向不是人工反馈前冻结的方向：{attempt}")
    except LoopCtlError as exc:
        errors.append(str(exc))
    try:
        feedback_at = utc_datetime(receipt.get("feedback_at"), "human_feedback.feedback_at")
        sealed_at = utc_datetime(manifest.get("sealed_at"), "manifest.sealed_at")
        recorded_at = utc_datetime(receipt.get("recorded_at"), "human_feedback.recorded_at")
        if recorded_at != sealed_at:
            errors.append(f"human feedback receipt 的记录时间未绑定封存时间：{attempt}")
        if review is not None:
            review_at = utc_datetime(
                review["anchor"].get("review_available_at"),
                "review_available_at",
            )
            if feedback_at < review_at:
                errors.append(f"人工反馈时间早于冻结成品可评审时间：{attempt}")
        if feedback_at > sealed_at:
            errors.append(f"人工反馈时间晚于 attempt 封存时间：{attempt}")
    except LoopCtlError as exc:
        errors.append(str(exc))

    source = receipt.get("source_evidence")
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("path"), str)
        or not source["path"].startswith("creative-system/approvals/attempt-feedback/")
        or not isinstance(source.get("sha256"), str)
        or not isinstance(source.get("bytes"), int)
        or isinstance(source.get("bytes"), bool)
    ):
        errors.append(f"human feedback receipt 的 source_evidence 无效：{attempt}")

    snapshot = receipt.get("snapshot")
    expected_snapshot = "human-feedback/evidence.txt"
    if not isinstance(snapshot, dict) or snapshot.get("path") != expected_snapshot:
        errors.append(f"human feedback receipt 的 snapshot 无效：{attempt}")
    else:
        path = attempt / expected_snapshot
        if path.is_symlink() or not path.is_file():
            errors.append(f"human feedback snapshot 缺失或不是普通文件：{path}")
        else:
            if snapshot.get("sha256") != sha256_file(path):
                errors.append(f"human feedback snapshot 哈希不一致：{path}")
            if snapshot.get("bytes") != path.stat().st_size:
                errors.append(f"human feedback snapshot 字节数不一致：{path}")
            try:
                human_evidence_bytes(path, "human feedback snapshot")
            except LoopCtlError as exc:
                errors.append(str(exc))
            if isinstance(source, dict):
                if source.get("sha256") != snapshot.get("sha256"):
                    errors.append(f"human feedback source/snapshot 哈希不一致：{attempt}")
                if source.get("bytes") != snapshot.get("bytes"):
                    errors.append(f"human feedback source/snapshot 字节数不一致：{attempt}")
    return errors


def verify_sealed_attempt(root: Path, attempt: Path) -> List[str]:
    errors: List[str] = []
    seal_path = attempt / ".sealed.json"
    manifest_path = attempt / "manifest.json"
    if not seal_path.exists():
        return errors
    try:
        seal = load_json(seal_path)
        manifest = load_json(manifest_path)
    except LoopCtlError as exc:
        return [str(exc)]
    expected_manifest_hash = seal.get("manifest_sha256") if isinstance(seal, dict) else None
    actual_manifest_hash = sha256_file(manifest_path) if manifest_path.is_file() else None
    if expected_manifest_hash != actual_manifest_hash:
        errors.append(f"sealed attempt manifest 已改变：{attempt}")
        return errors
    if isinstance(manifest, dict):
        errors.extend(validate_human_feedback_receipt(root, attempt, manifest))
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list):
        errors.append(f"sealed attempt manifest.files 无效：{attempt}")
        return errors
    declared: Dict[str, str] = {}
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            errors.append(f"sealed attempt 文件清单无效：{attempt}")
            continue
        declared[entry["path"]] = str(entry.get("sha256", ""))
    current: Dict[str, str] = {}
    for path in sorted(attempt.rglob("*")):
        if path.is_symlink():
            errors.append(f"sealed attempt 含符号链接：{path}")
            continue
        if path.is_file() and path.name not in {"manifest.json", ".sealed.json"}:
            current[path.relative_to(attempt).as_posix()] = sha256_file(path)
    if set(current) != set(declared):
        errors.append(f"sealed attempt 文件集合已改变：{attempt}")
    for name, digest in declared.items():
        if current.get(name) != digest:
            errors.append(f"sealed attempt 文件哈希不匹配：{attempt / name}")
    return errors


def validate_charter_confirmation(
    root: Path, charter: Mapping[str, Any], warnings: Optional[List[str]] = None
) -> List[str]:
    errors: List[str] = []
    confirmed = charter.get("confirmed")
    confirmation_fields = (
        "confirmed_by",
        "confirmed_at",
        "confirmation_receipt",
        "confirmation_receipt_sha256",
    )
    if confirmed is False:
        for field in confirmation_fields:
            if charter.get(field) is not None:
                errors.append(f"未确认宪法的 charter.{field} 必须为 null")
        return errors
    if confirmed is not True:
        return errors

    confirmed_by = charter.get("confirmed_by")
    confirmed_at = charter.get("confirmed_at")
    receipt_relative = charter.get("confirmation_receipt")
    receipt_sha256 = charter.get("confirmation_receipt_sha256")
    if not isinstance(confirmed_by, str) or not confirmed_by.strip():
        errors.append("已确认宪法缺少 charter.confirmed_by")
    try:
        utc_timestamp(confirmed_at, "charter.confirmed_at")
    except LoopCtlError as exc:
        errors.append(str(exc))
    if (
        not isinstance(receipt_relative, str)
        or not CHARTER_CONFIRMATION_RECEIPT_PATTERN.fullmatch(receipt_relative)
    ):
        errors.append("charter.confirmation_receipt 必须是内容寻址的确认凭证")
        return errors
    if not isinstance(receipt_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", receipt_sha256):
        errors.append("charter.confirmation_receipt_sha256 无效")

    try:
        receipt_path = regular_project_file(root, receipt_relative, "创作宪法确认凭证")
        actual_receipt_sha256 = sha256_file(receipt_path)
        if receipt_sha256 != actual_receipt_sha256:
            errors.append("创作宪法确认凭证哈希与 system.json 不一致")
        receipt = load_json(receipt_path)
    except LoopCtlError as exc:
        errors.append(str(exc))
        return errors
    if not isinstance(receipt, dict):
        errors.append("创作宪法确认凭证顶层必须是对象")
        return errors
    if receipt.get("schema_version") != SCHEMA_VERSION:
        errors.append("创作宪法确认凭证 schema_version 无效")
    if receipt.get("kind") != "CharterConfirmation":
        errors.append("创作宪法确认凭证 kind 无效")
    if charter_confirmation_receipt_relative(receipt) != receipt_relative:
        errors.append("创作宪法确认凭证路径与其内容摘要不一致")
    if receipt.get("confirmed_by") != confirmed_by or receipt.get("confirmed_at") != confirmed_at:
        errors.append("创作宪法确认凭证与 system.json 的确认人或时间不一致")
    try:
        ledger = load_json(root / CHARTER_CONFIRMATION_LEDGER)
        ledger_entries = ledger.get("entries", []) if isinstance(ledger, dict) else []
        active_entries = [
            entry
            for entry in ledger_entries
            if isinstance(entry, dict)
            and entry.get("receipt_path") == receipt_relative
            and entry.get("receipt_sha256") == receipt_sha256
        ]
        if len(active_entries) != 1:
            errors.append("当前创作宪法确认凭证必须恰好出现于确认历史账本一次")
    except LoopCtlError as exc:
        errors.append(str(exc))
    if receipt.get("identity_authentication") != "external-attestation-not-controller-verified":
        errors.append("创作宪法确认凭证必须声明外部身份认证边界")
    try:
        confirmed_dt = utc_datetime(receipt.get("confirmed_at"), "receipt.confirmed_at")
        recorded_dt = utc_datetime(receipt.get("recorded_at"), "receipt.recorded_at")
        if confirmed_dt > recorded_dt:
            errors.append("创作宪法确认时间不得晚于控制器记录时间")
    except LoopCtlError as exc:
        errors.append(str(exc))

    for section_name, expected_path in (("charter", charter.get("path")), ("evidence", None)):
        section = receipt.get(section_name)
        if not isinstance(section, dict):
            errors.append(f"创作宪法确认凭证缺少 {section_name}")
            continue
        relative = section.get("path")
        if not isinstance(relative, str) or (
            expected_path is not None and relative != expected_path
        ):
            errors.append(f"创作宪法确认凭证 {section_name}.path 无效")
            continue
        if section_name == "evidence" and not relative.startswith(
            CHARTER_CONFIRMATION_EVIDENCE_ROOT + "/"
        ):
            errors.append("创作宪法确认依据不在受保护的 evidence 目录")
            continue
        try:
            safe_relative(root, relative, f"确认凭证 {section_name}")
            reject_symlink_components(root, relative, f"确认凭证 {section_name}")
            if (
                section_name == "evidence"
                and not os.path.lexists(str(root / Path(relative)))
            ):
                add_validation_warning(warnings, LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE)
                continue
            path = regular_project_file(root, relative, f"确认凭证 {section_name}")
            if section.get("sha256") != sha256_file(path):
                errors.append(f"创作宪法确认凭证 {section_name} 哈希不一致")
            if section.get("bytes") != path.stat().st_size:
                errors.append(f"创作宪法确认凭证 {section_name} 字节数不一致")
            if section_name == "evidence":
                human_evidence_bytes(path, "创作宪法人工确认依据")
        except LoopCtlError as exc:
            errors.append(str(exc))
    return errors


def validate_project(
    root: Path, system_override: Optional[Mapping[str, Any]] = None
) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []
    if system_override is None:
        try:
            system = load_system(root)
        except LoopCtlError as exc:
            return {"status": "BLOCK", "errors": [str(exc)], "warnings": []}
    else:
        system = json.loads(json.dumps(system_override))

    if system.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version 必须为 {SCHEMA_VERSION}")
    if system.get("kind") != "CreativeSystem":
        errors.append("system.kind 必须为 CreativeSystem")
    project = _required_dict(system.get("project"), "project", errors)
    for key in ("id", "name", "domain_skill", "active_version"):
        if not isinstance(project.get(key), str) or not project.get(key):
            errors.append(f"project.{key} 必须是非空字符串")
    if isinstance(project.get("domain_skill"), str) and not ID_PATTERN.fullmatch(project["domain_skill"]):
        errors.append("project.domain_skill 必须是 lower-kebab-case")

    charter = _required_dict(system.get("charter"), "charter", errors)
    charter_path = charter.get("path")
    if not isinstance(charter.get("confirmed"), bool):
        errors.append("charter.confirmed 必须是 boolean")
    if not isinstance(charter_path, str):
        errors.append("charter.path 必须是字符串")
    else:
        try:
            if not safe_relative(root, charter_path, "charter.path").is_file():
                errors.append(f"创作宪法不存在：{charter_path}")
        except LoopCtlError as exc:
            errors.append(str(exc))
    errors.extend(validate_charter_confirmation(root, charter, warnings))
    errors.extend(validate_charter_confirmation_history(root, warnings))

    maturity = _required_dict(system.get("maturity"), "maturity", errors)
    declared_maturity = maturity.get("declared")
    if declared_maturity not in LEVELS:
        errors.append("maturity.declared 必须是 L0–L5")
    elif declared_maturity == "L5":
        errors.append("v0.1 不允许把 L5 声明为 active maturity；L5 只能保留为实验候选")

    artifacts = _required_list(system.get("artifacts"), "artifacts", errors)
    artifact_by_id: Dict[str, Dict[str, Any]] = {}
    for index, raw in enumerate(artifacts):
        artifact = _required_dict(raw, f"artifacts[{index}]", errors)
        artifact_id = artifact.get("id")
        if not isinstance(artifact_id, str) or not ID_PATTERN.fullmatch(artifact_id):
            errors.append(f"artifacts[{index}].id 必须是 lower-kebab-case")
            continue
        if artifact_id in artifact_by_id:
            errors.append(f"artifact id 重复：{artifact_id}")
        artifact_by_id[artifact_id] = artifact
        if not isinstance(artifact.get("owner"), str) or not artifact.get("owner"):
            errors.append(f"artifact {artifact_id} 缺少唯一 owner")
        path_value = artifact.get("path")
        if not isinstance(path_value, str):
            errors.append(f"artifact {artifact_id}.path 必须是字符串")
        else:
            try:
                safe_relative(root, path_value, f"artifact {artifact_id}.path")
            except LoopCtlError as exc:
                errors.append(str(exc))

    judge_refs = _required_list(system.get("judges"), "judges", errors)
    judge_by_id: Dict[str, Dict[str, Any]] = {}
    for raw_ref in judge_refs:
        if not isinstance(raw_ref, str):
            errors.append("judges 引用必须是字符串")
            continue
        try:
            path = safe_relative(root, raw_ref, "Judge 引用")
            judge = load_json(path)
        except LoopCtlError as exc:
            errors.append(str(exc))
            continue
        if not isinstance(judge, dict) or judge.get("kind") != "JudgeSpec":
            errors.append(f"JudgeSpec 无效：{raw_ref}")
            continue
        judge_id = judge.get("id")
        if not isinstance(judge_id, str) or not ID_PATTERN.fullmatch(judge_id):
            errors.append(f"Judge id 无效：{raw_ref}")
            continue
        if judge_id in judge_by_id:
            errors.append(f"Judge id 重复：{judge_id}")
        judge_by_id[judge_id] = judge
        if judge.get("schema_version") != SCHEMA_VERSION:
            errors.append(f"Judge {judge_id}.schema_version 无效")
        if judge.get("type") not in {"deterministic", "model", "human"}:
            errors.append(f"Judge {judge_id}.type 无效")
        if judge.get("mode") not in {"shadow", "warn", "block"}:
            errors.append(f"Judge {judge_id}.mode 无效")
        for key in ("rubric", "evidence_requirements"):
            if not isinstance(judge.get(key), list):
                errors.append(f"Judge {judge_id}.{key} 必须是数组")
        if "calibration" not in judge:
            errors.append(f"Judge {judge_id} 缺少 calibration")
        if not isinstance(judge.get("promotion_requirements"), (dict, list)):
            errors.append(f"Judge {judge_id}.promotion_requirements 必须是对象或数组")

    loop_refs = _required_list(system.get("loops"), "loops", errors)
    loop_by_id: Dict[str, Dict[str, Any]] = {}
    writers: Dict[str, List[str]] = {}
    for raw_ref in loop_refs:
        if not isinstance(raw_ref, str):
            errors.append("loops 引用必须是字符串")
            continue
        try:
            path = safe_relative(root, raw_ref, "Loop 引用")
            loop = load_json(path)
        except LoopCtlError as exc:
            errors.append(str(exc))
            continue
        if not isinstance(loop, dict) or loop.get("kind") != "LoopSpec":
            errors.append(f"LoopSpec 无效：{raw_ref}")
            continue
        loop_id = loop.get("id")
        if not isinstance(loop_id, str) or not ID_PATTERN.fullmatch(loop_id):
            errors.append(f"Loop id 无效：{raw_ref}")
            continue
        if loop_id in loop_by_id:
            errors.append(f"Loop id 重复：{loop_id}")
        loop_by_id[loop_id] = loop
        for key in ("goal", "owner"):
            if not isinstance(loop.get(key), str) or not loop.get(key):
                errors.append(f"Loop {loop_id}.{key} 必须是非空字符串")
        producer = _required_dict(loop.get("producer"), f"Loop {loop_id}.producer", errors)
        if not isinstance(producer.get("agent"), str) or not producer.get("agent"):
            errors.append(f"Loop {loop_id}.producer.agent 必须是非空字符串")
        if producer.get("separate_from_judges") is not True:
            errors.append(f"Loop {loop_id}.producer 必须声明与 Judge 分离")
        for key in ("reads", "writes", "judges", "decision_policy", "memory_updates", "stop_conditions"):
            if not isinstance(loop.get(key), list):
                errors.append(f"Loop {loop_id}.{key} 必须是数组")
        if not isinstance(loop.get("trigger"), dict) or not loop["trigger"]:
            errors.append(f"Loop {loop_id}.trigger 必须是非空对象")
        human_gate = _required_dict(loop.get("human_gate"), f"Loop {loop_id}.human_gate", errors)
        if not isinstance(human_gate.get("required"), bool) or not isinstance(human_gate.get("when"), str):
            errors.append(f"Loop {loop_id}.human_gate 必须包含 required/when")
        retry_budget = _required_dict(loop.get("retry_budget"), f"Loop {loop_id}.retry_budget", errors)
        max_attempts = retry_budget.get("max_attempts")
        max_no_improvement = retry_budget.get("max_no_improvement")
        if not isinstance(max_attempts, int) or isinstance(max_attempts, bool) or not 1 <= max_attempts <= 3:
            errors.append(f"Loop {loop_id}.retry_budget.max_attempts 必须是 1–3 的整数")
        if (
            not isinstance(max_no_improvement, int)
            or isinstance(max_no_improvement, bool)
            or not 1 <= max_no_improvement <= 2
        ):
            errors.append(f"Loop {loop_id}.retry_budget.max_no_improvement 必须是 1–2 的整数")
        if not isinstance(retry_budget.get("on_budget_exhausted"), str):
            errors.append(f"Loop {loop_id}.retry_budget.on_budget_exhausted 必须是字符串")
        stops = loop.get("stop_conditions", []) if isinstance(loop.get("stop_conditions"), list) else []
        stop_text = " ".join(str(item) for item in stops).casefold()
        if "budget" not in stop_text or ("improvement" not in stop_text and "改善" not in stop_text):
            errors.append(f"Loop {loop_id} 必须同时定义预算耗尽与连续无改善停止条件")
        for artifact_id in loop.get("reads", []) + loop.get("writes", []):
            if artifact_id not in artifact_by_id:
                errors.append(f"Loop {loop_id} 引用了未知 artifact：{artifact_id}")
        for artifact_id in loop.get("writes", []):
            writers.setdefault(str(artifact_id), []).append(loop_id)
            artifact = artifact_by_id.get(str(artifact_id), {})
            if artifact.get("owner") != loop.get("owner"):
                errors.append(
                    f"Loop {loop_id} 写入 {artifact_id}，但 loop.owner 与 artifact.owner 不一致"
                )
        for judge_id in loop.get("judges", []):
            judge = judge_by_id.get(str(judge_id))
            if judge is None:
                errors.append(f"Loop {loop_id} 引用了未知 Judge：{judge_id}")
            elif judge.get("mode") == "block" and judge.get("agent") == producer.get("agent"):
                errors.append(f"Loop {loop_id} 的 Producer 不得与阻断 Judge 共用身份")

    for artifact_id, owner_loops in writers.items():
        if len(owner_loops) != 1:
            errors.append(f"artifact {artifact_id} 必须恰好有一个写入 owner，当前为 {owner_loops}")

    graph: Dict[str, Set[str]] = {loop_id: set() for loop_id in loop_by_id}
    for source_id, source in loop_by_id.items():
        source_writes = set(source.get("writes", []))
        for target_id, target in loop_by_id.items():
            if source_writes.intersection(target.get("reads", [])):
                graph[source_id].add(target_id)
    cyclic_nodes = _find_cycle_nodes(graph)
    for loop_id in cyclic_nodes:
        loop = loop_by_id[loop_id]
        retry_budget = loop.get("retry_budget", {})
        if not isinstance(retry_budget, dict) or retry_budget.get("max_attempts", 0) <= 0:
            errors.append(f"循环依赖中的 Loop {loop_id} 必须有正数 retry_budget")
        if not loop.get("stop_conditions"):
            errors.append(f"循环依赖中的 Loop {loop_id} 必须有 stop_conditions")

    protected = _required_list(system.get("protected_surfaces"), "protected_surfaces", errors)
    editable = _required_list(system.get("editable_surfaces"), "editable_surfaces", errors)
    protected_strings = {item for item in protected if isinstance(item, str)}
    missing_protected = REQUIRED_PROTECTED - protected_strings
    if missing_protected:
        errors.append("缺少受保护表面：" + ", ".join(sorted(missing_protected)))
    for left in protected_strings:
        for right in (item for item in editable if isinstance(item, str)):
            if _surface_overlap(left, right):
                errors.append(f"受保护表面与可修改表面重叠：{left} / {right}")

    promotion = _required_dict(system.get("promotion_policy"), "promotion_policy", errors)
    if promotion.get("human_approval_required") is not True:
        errors.append("promotion_policy 必须要求人工批准")
    if promotion.get("l5_auto_promotion") is not False:
        errors.append("L5 自动晋升必须关闭")

    recovery = _required_dict(system.get("recovery_policy"), "recovery_policy", errors)
    runtime_budget = _required_dict(
        recovery.get("runtime_dispatch_budget"),
        "recovery_policy.runtime_dispatch_budget",
        errors,
    )
    max_zero_stalls = runtime_budget.get("max_zero_file_stalls")
    if (
        not isinstance(max_zero_stalls, int)
        or isinstance(max_zero_stalls, bool)
        or not 1 <= max_zero_stalls <= 10
    ):
        errors.append("runtime_dispatch_budget.max_zero_file_stalls 必须是 1–10 的整数")
    if runtime_budget.get("zero_output_consumes_content_attempt") is not False:
        errors.append("runtime_dispatch_budget.zero_output_consumes_content_attempt 必须为 false")
    if runtime_budget.get("on_exhausted") not in {"stop", "escalate"}:
        errors.append("runtime_dispatch_budget.on_exhausted 必须是 stop 或 escalate")
    mechanical = _required_dict(
        recovery.get("mechanical_evidence"),
        "recovery_policy.mechanical_evidence",
        errors,
    )
    if mechanical.get("governing_source") != "loopctl.py measure-artifact":
        errors.append("mechanical_evidence.governing_source 必须是 loopctl.py measure-artifact")
    if mechanical.get("producer_self_report") != "non-governing":
        errors.append("mechanical_evidence.producer_self_report 必须是 non-governing")

    memory = _required_dict(system.get("memory"), "memory", errors)
    memory_partitions = memory.get("partitions", []) if isinstance(memory.get("partitions"), list) else []
    memory_ids = {
        partition.get("id")
        for partition in memory_partitions
        if isinstance(partition, dict) and isinstance(partition.get("id"), str)
    }
    for loop_id, loop in loop_by_id.items():
        for partition_id in loop.get("memory_updates", []):
            if partition_id not in memory_ids:
                errors.append(f"Loop {loop_id} 引用了未知 memory partition：{partition_id}")
    for partition in memory_partitions:
        if isinstance(partition, dict) and isinstance(partition.get("path"), str):
            if "heldout" in partition["path"].casefold():
                errors.append("held-out 答案不得写入学习记忆")
    for artifact in artifact_by_id.values():
        if "heldout" in str(artifact.get("path", "")).casefold():
            artifact_id = artifact.get("id")
            for loop_id, loop in loop_by_id.items():
                if artifact_id in loop.get("reads", []) or artifact_id in loop.get("writes", []):
                    errors.append(f"Loop {loop_id} 不得读取或写入 held-out 答案")

    statuses = _required_dict(system.get("statuses"), "statuses", errors)
    if statuses.get("execution_status") not in EXECUTION_STATUSES:
        errors.append("statuses.execution_status 无效")
    if statuses.get("quality_status") not in QUALITY_STATUSES:
        errors.append("statuses.quality_status 无效")
    if statuses.get("release_status") not in RELEASE_STATUSES:
        errors.append("statuses.release_status 无效")

    errors.extend(validate_controller_transactions(root))

    runs_root = root / "creative-system" / "runs"
    if runs_root.is_dir():
        for run_entry in sorted(runs_root.iterdir()):
            if run_entry.name == ".gitkeep" and run_entry.is_file() and not run_entry.is_symlink():
                continue
            if run_entry.is_symlink():
                errors.append(f"run root 不允许是符号链接：{run_entry.name}")
                continue
            if not run_entry.is_dir():
                errors.append(f"runs/ 只允许 run 目录：{run_entry.name}")
                continue
            try:
                regular_project_file(
                    root,
                    (run_entry / "run.json").relative_to(root).as_posix(),
                    f"run {run_entry.name} record",
                )
            except LoopCtlError as exc:
                errors.append(str(exc))
        for attempt_dir in sorted(runs_root.glob("*/attempts/attempt-*")):
            if attempt_dir.is_symlink() or not attempt_dir.is_dir():
                errors.append(f"attempt root 必须是普通目录：{attempt_dir}")
                continue
            try:
                subject_path, anchor_path = human_review_paths(root, attempt_dir)
                if os.path.lexists(str(subject_path)) or os.path.lexists(str(anchor_path)):
                    verify_human_review_subject(root, attempt_dir)
            except LoopCtlError as exc:
                errors.append(str(exc))
        for seal in sorted(runs_root.glob("*/attempts/*/.sealed.json")):
            errors.extend(verify_sealed_attempt(root, seal.parent))

    candidates_root = root / "creative-system" / "candidates"
    for entry in sorted(candidates_root.iterdir()):
        if entry.name == ".gitkeep" and entry.is_file() and not entry.is_symlink():
            continue
        if entry.is_symlink() or not entry.is_dir():
            errors.append(f"candidate root 必须是普通目录：{entry.name}")
            continue
        for child_name in ("changes", "evaluations", "control"):
            child = entry / child_name
            if os.path.lexists(str(child)) and (child.is_symlink() or not child.is_dir()):
                errors.append(
                    f"candidate {entry.name} 的 {child_name}/ 不允许经过符号链接或使用非普通目录"
                )
        for child_name in ("proposal.json", "status.json"):
            child = entry / child_name
            if os.path.lexists(str(child)):
                try:
                    regular_project_file(
                        root,
                        child.relative_to(root).as_posix(),
                        f"candidate {entry.name} {child_name}",
                    )
                except LoopCtlError as exc:
                    errors.append(str(exc))

    releases_root = root / "creative-system" / "releases"
    for entry in sorted(releases_root.iterdir()):
        if entry.is_symlink():
            errors.append(f"release control entry 不允许是符号链接：{entry.name}")

    active_version = project.get("active_version")
    errors.extend(validate_release_registry_lifecycle(root, active_version))
    if isinstance(active_version, str) and active_version != "baseline-v1":
        registry_path = root / "creative-system" / "releases" / "registry.json"
        try:
            registry = load_json(registry_path)
            if not isinstance(registry, dict) or registry.get("active_version") != active_version:
                errors.append("active version 与 release registry 不一致")
            history = registry.get("history", []) if isinstance(registry, dict) else []
            receipts = [
                item
                for item in history
                if (
                    isinstance(item, dict)
                    and item.get("action") == "promote"
                    and item.get("state") == "COMMITTED"
                    and item.get("new_version") == active_version
                )
            ]
            if len(receipts) != 1:
                errors.append("active version 必须恰好对应一个 COMMITTED 晋升记录")
            else:
                receipt = receipts[0]
                candidate_id = str(receipt.get("candidate_id", ""))
                candidate_root, proposal, candidate_status = load_candidate(root, candidate_id)
                if candidate_status.get("status") != "PROMOTED":
                    errors.append("active candidate 状态不是 PROMOTED")
                current_hashes = verify_candidate_changes(root, candidate_root, proposal)
                if current_hashes != receipt.get("candidate_change_hashes"):
                    errors.append("active candidate changes 哈希与晋升记录不一致")
                try:
                    current_eval_ledger = controller_eval_open_ledger(
                        root,
                        candidate_root,
                        candidate_id,
                        proposal,
                        require_anchored=True,
                    )
                    if current_eval_ledger != receipt.get("eval_open_ledger"):
                        errors.append("active candidate eval open ledger 与晋升记录不一致")
                except LoopCtlError as exc:
                    errors.append(str(exc))
                promotion_path = root / "creative-system" / "releases" / active_version / "promotion.json"
                if not promotion_path.is_file() or load_json(promotion_path) != receipt:
                    errors.append("active version 的 promotion receipt 缺失或与 registry 不一致")
                else:
                    expected_promotion_hashes = maturity.get("evidence_hashes", {})
                    promotion_relative = promotion_path.relative_to(root).as_posix()
                    if (
                        not isinstance(expected_promotion_hashes, dict)
                        or expected_promotion_hashes.get(promotion_relative) != sha256_file(promotion_path)
                    ):
                        errors.append("active version 的 promotion receipt 哈希与 system 不一致")
                release_root = root / "creative-system" / "releases" / active_version
                evaluation_path = release_root / "evaluation.json"
                if evaluation_path.is_symlink() or not evaluation_path.is_file():
                    errors.append("active version 的 evaluation.json 缺失或为符号链接")
                elif receipt.get("evaluation_sha256") != sha256_file(evaluation_path):
                    errors.append("active version 的 evaluation.json 哈希不一致")
                else:
                    evaluation = load_json(evaluation_path)
                    if not isinstance(evaluation, dict):
                        errors.append("active version 的 evaluation.json 无效")
                    else:
                        seals = receipt.get("eval_run_seals")
                        if not isinstance(seals, dict):
                            errors.append("active version 缺少 eval run seals")
                        else:
                            for phase in ("targeted", "regression", "heldout"):
                                section = evaluation.get(phase)
                                seal_entry = seals.get(phase)
                                if not isinstance(section, dict) or not isinstance(seal_entry, dict):
                                    errors.append(f"active version 的 {phase} eval 证据无效")
                                    continue
                                try:
                                    verified_eval = verify_sealed_eval_run(
                                        root,
                                        candidate_root,
                                        candidate_id,
                                        str(section.get("run_id", "")),
                                        phase,
                                        str(section.get("output_root", "")),
                                    )
                                    if (
                                        seal_entry.get("eval_run_id") != section.get("run_id")
                                        or seal_entry.get("seal_path") != verified_eval["seal_path"]
                                        or seal_entry.get("seal_sha256") != verified_eval["seal_sha256"]
                                        or seal_entry.get("execution_receipt_sha256")
                                        != verified_eval["execution_receipt_sha256"]
                                        or seal_entry.get("execution_receipt")
                                        != verified_eval["execution_receipt"]
                                    ):
                                        errors.append(f"active version 的 {phase} eval seal 与晋升记录不一致")
                                except LoopCtlError as exc:
                                    errors.append(str(exc))
                evidence_hashes = receipt.get("evaluation_evidence_hashes")
                if not isinstance(evidence_hashes, dict) or not evidence_hashes:
                    errors.append("active version 缺少 evaluation evidence 哈希")
                else:
                    for relative, digest in evidence_hashes.items():
                        if not isinstance(relative, str) or not isinstance(digest, str):
                            errors.append("active version 的 evaluation evidence 哈希表无效")
                            continue
                        try:
                            evidence_path = safe_relative(root, relative, "evaluation evidence")
                            reject_symlink_components(root, relative, "evaluation evidence")
                            if not evidence_path.is_file() or sha256_file(evidence_path) != digest:
                                errors.append(f"active version 的 evaluation evidence 已改变：{relative}")
                        except LoopCtlError as exc:
                            errors.append(str(exc))
        except LoopCtlError as exc:
            errors.append(str(exc))

    if not charter.get("confirmed"):
        warnings.append("创作宪法尚未由使用者确认；只能停在 L0 onboarding")
    status = "PASS" if not errors else "BLOCK"
    return {
        "status": status,
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "loops": len(loop_by_id),
            "judges": len(judge_by_id),
            "artifacts": len(artifact_by_id),
            "cyclic_loops": len(cyclic_nodes),
        },
    }


def command_validate(args: argparse.Namespace) -> Tuple[Dict[str, Any], int]:
    root = project_root(args.project)
    with exclusive_controller_lock(root):
        report = validate_project(root)
    report["project"] = str(root)
    return report, 0 if report["status"] == "PASS" else 1


def controller_facts_chain_state(root: Path, attempt_dir: Path) -> Dict[str, Any]:
    """Validate immutable ControllerArtifactFacts chains and derive their active tips.

    A facts file never changes state in place.  Each successor freezes the path,
    digest and byte count of its predecessor; the only active record is the one
    not referenced by a successor.  This lets normal remeasurement retain old
    evidence without treating every historical record as simultaneously active.
    """
    records: Dict[str, Dict[str, Any]] = {}
    by_source: Dict[str, List[str]] = {}
    for facts_path in sorted(attempt_dir.rglob("*.json")):
        if facts_path.is_symlink():
            raise LoopCtlError(f"attempt 不允许包含符号链接：{facts_path}")
        try:
            facts = load_json(facts_path)
        except LoopCtlError:
            continue
        if not isinstance(facts, dict) or facts.get("kind") != "ControllerArtifactFacts":
            continue
        relative_facts = facts_path.relative_to(attempt_dir)
        if not relative_facts.parts or relative_facts.parts[0] != "controller-facts":
            raise LoopCtlError(
                f"CONTROLLER_FACTS_IN_PRODUCER_ROOT：facts 必须位于 attempt/controller-facts/：{facts_path}"
            )
        facts_relative = facts_path.relative_to(root).as_posix()
        source = facts.get("source")
        if not isinstance(source, dict) or not isinstance(source.get("path"), str):
            raise LoopCtlError(f"ControllerArtifactFacts.source 无效：{facts_path}")
        source_relative = str(source["path"])
        source_path = safe_relative(root, source_relative, "ControllerArtifactFacts.source.path")
        reject_symlink_components(root, source_relative, "ControllerArtifactFacts.source.path")
        if source_relative != source_path.relative_to(root).as_posix():
            raise LoopCtlError(f"ControllerArtifactFacts.source.path 必须是规范相对路径：{facts_path}")
        if (
            not isinstance(source.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", str(source.get("sha256")))
            or not isinstance(source.get("bytes"), int)
            or isinstance(source.get("bytes"), bool)
            or int(source.get("bytes")) < 0
            or source.get("encoding") != "UTF-8"
        ):
            raise LoopCtlError(f"ControllerArtifactFacts.source 摘要无效：{facts_path}")
        scope = facts.get("scope")
        if scope not in {"whole-file", "exclude-first-markdown-h1"}:
            raise LoopCtlError(f"ControllerArtifactFacts.scope 无效：{facts_path}")
        authority = facts.get("authority")
        if (
            not isinstance(authority, dict)
            or authority.get("generator") != "loopctl.py measure-artifact"
            or authority.get("mechanical_fields_governing") is not True
            or authority.get("producer_self_report_governing") is not False
        ):
            raise LoopCtlError(f"ControllerArtifactFacts.authority 无效：{facts_path}")
        supersession = facts.get("supersession")
        if not isinstance(supersession, dict):
            raise LoopCtlError(f"BROKEN_CONTROLLER_FACTS_CHAIN：缺少 supersession：{facts_relative}")
        generation = supersession.get("generation")
        if (
            not isinstance(generation, int)
            or isinstance(generation, bool)
            or generation < 1
        ):
            raise LoopCtlError(f"BROKEN_CONTROLLER_FACTS_CHAIN：generation 无效：{facts_relative}")
        predecessor = supersession.get("predecessor")
        if generation == 1:
            if predecessor is not None:
                raise LoopCtlError(
                    f"BROKEN_CONTROLLER_FACTS_CHAIN：generation=1 必须没有 predecessor：{facts_relative}"
                )
        else:
            if not isinstance(predecessor, dict):
                raise LoopCtlError(
                    f"BROKEN_CONTROLLER_FACTS_CHAIN：generation>1 必须绑定 predecessor：{facts_relative}"
                )
            predecessor_path = predecessor.get("path")
            predecessor_sha256 = predecessor.get("sha256")
            predecessor_bytes = predecessor.get("bytes")
            if (
                not isinstance(predecessor_path, str)
                or not isinstance(predecessor_sha256, str)
                or not re.fullmatch(r"[0-9a-f]{64}", predecessor_sha256)
                or not isinstance(predecessor_bytes, int)
                or isinstance(predecessor_bytes, bool)
                or predecessor_bytes < 0
            ):
                raise LoopCtlError(
                    f"BROKEN_CONTROLLER_FACTS_CHAIN：predecessor 摘要无效：{facts_relative}"
                )
            predecessor_resolved = safe_relative(
                root, predecessor_path, "ControllerArtifactFacts.predecessor.path"
            )
            reject_symlink_components(
                root, predecessor_path, "ControllerArtifactFacts.predecessor.path"
            )
            if predecessor_path != predecessor_resolved.relative_to(root).as_posix():
                raise LoopCtlError(
                    f"BROKEN_CONTROLLER_FACTS_CHAIN：predecessor.path 必须是规范相对路径：{facts_relative}"
                )
        records[facts_relative] = {
            "path": facts_path,
            "facts": facts,
            "source": source_relative,
            "source_path": source_path,
            "generation": generation,
            "predecessor": predecessor,
        }
        by_source.setdefault(source_relative, []).append(facts_relative)

    active_by_source: Dict[str, Dict[str, Any]] = {}
    for source_relative, source_records in sorted(by_source.items()):
        roots: List[str] = []
        child_by_predecessor: Dict[str, str] = {}
        for facts_relative in sorted(source_records):
            record = records[facts_relative]
            predecessor = record["predecessor"]
            if predecessor is None:
                roots.append(facts_relative)
                continue
            predecessor_relative = str(predecessor["path"])
            previous = records.get(predecessor_relative)
            if previous is None or previous.get("source") != source_relative:
                raise LoopCtlError(
                    "BROKEN_CONTROLLER_FACTS_CHAIN：predecessor 不属于同一 source/attempt："
                    f"{facts_relative}"
                )
            if int(previous["generation"]) + 1 != int(record["generation"]):
                raise LoopCtlError(
                    f"BROKEN_CONTROLLER_FACTS_CHAIN：generation 不连续：{facts_relative}"
                )
            previous_path = previous["path"]
            if (
                predecessor.get("sha256") != sha256_file(previous_path)
                or predecessor.get("bytes") != previous_path.stat().st_size
            ):
                raise LoopCtlError(
                    f"BROKEN_CONTROLLER_FACTS_CHAIN：superseded facts 摘要不一致：{predecessor_relative}"
                )
            if predecessor_relative in child_by_predecessor:
                raise LoopCtlError(
                    "BROKEN_CONTROLLER_FACTS_CHAIN：同一 predecessor 出现分叉："
                    f"{predecessor_relative}"
                )
            child_by_predecessor[predecessor_relative] = facts_relative
        if len(roots) != 1:
            raise LoopCtlError(
                f"BROKEN_CONTROLLER_FACTS_CHAIN：同一 source 必须恰好一个根：{source_relative}"
            )
        tips = [path for path in source_records if path not in child_by_predecessor]
        if len(tips) != 1:
            raise LoopCtlError(
                f"BROKEN_CONTROLLER_FACTS_CHAIN：同一 source 必须恰好一个 active facts：{source_relative}"
            )
        visited: Set[str] = set()
        cursor: Optional[str] = roots[0]
        while cursor is not None and cursor not in visited:
            visited.add(cursor)
            cursor = child_by_predecessor.get(cursor)
        if cursor is not None or visited != set(source_records):
            raise LoopCtlError(
                f"BROKEN_CONTROLLER_FACTS_CHAIN：链不连续或含循环：{source_relative}"
            )
        active_by_source[source_relative] = records[tips[0]]
    return {"records": records, "active_by_source": active_by_source}


def controller_facts_snapshots(root: Path, facts_paths: Sequence[str]) -> List[Dict[str, Any]]:
    snapshots: List[Dict[str, Any]] = []
    for relative in facts_paths:
        path = regular_project_file(root, relative, "active ControllerArtifactFacts")
        snapshots.append(
            {
                "path": relative,
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            }
        )
    return snapshots


def command_measure_artifact(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    with exclusive_controller_lock(root):
        output_path = safe_relative(root, args.output, "--output")
        output_attempt = containing_attempt(root, output_path)
        if output_attempt is not None:
            ensure_attempt_not_terminal_invalid(output_attempt)
            return command_measure_artifact_locked(args, root)
        output_eval_run = containing_eval_run(root, output_path)
        if output_eval_run is not None:
            return command_measure_artifact_locked(args, root)
        return command_measure_artifact_locked(args, root)


def command_measure_artifact_locked(args: argparse.Namespace, root: Path) -> Dict[str, Any]:
    source_path = safe_relative(root, args.source, "--source")
    output_path = safe_relative(root, args.output, "--output")
    reject_symlink_components(root, args.source, "--source")
    reject_symlink_components(root, args.output, "--output")
    if not source_path.is_file():
        raise LoopCtlError(f"--source 不是文件：{args.source}")
    if output_path.suffix.lower() != ".json":
        raise LoopCtlError("--output 必须是 .json 文件")
    if output_path == source_path:
        raise LoopCtlError("--output 不得覆盖 --source")
    output_attempt = containing_attempt(root, output_path)
    if output_attempt is not None:
        if not (output_attempt / "attempt.json").is_file():
            raise LoopCtlError("--output 指向不存在的 attempt")
        if (output_attempt / ".sealed.json").is_file():
            raise LoopCtlError("--output 不得写入已封存 attempt")
        run_path = output_attempt.parent.parent / "run.json"
        run = load_json(run_path)
        if not isinstance(run, dict) or run.get("current_attempt") != output_attempt.name:
            raise LoopCtlError("--output 只能写入 run 的 current open attempt")
        try:
            within_attempt = output_path.relative_to(output_attempt)
        except ValueError as exc:
            raise LoopCtlError("--output attempt 路径无效") from exc
        if not within_attempt.parts or within_attempt.parts[0] != "controller-facts":
            raise LoopCtlError(
                "attempt 内的 --output 只能写入 controller-facts/，不得进入 Producer allowed-writes root"
            )
    output_eval_run = containing_eval_run(root, output_path)
    if output_eval_run is not None:
        candidate_root = output_eval_run.parent.parent
        ensure_candidate_eval_paths_safe(root, candidate_root)
        _, _, candidate_status = load_candidate(root, candidate_root.name)
        ensure_eval_not_terminal_invalid(candidate_root, output_eval_run.name)
        if (output_eval_run / ".sealed.json").exists():
            raise LoopCtlError("--output 不得写入已封存 eval run；封存输出永久只读")
        if candidate_status.get("status") != "CANDIDATE":
            raise LoopCtlError("--output 不得写入非 CANDIDATE 候选的 eval run")
        try:
            within_eval = output_path.relative_to(output_eval_run)
        except ValueError as exc:
            raise LoopCtlError("--output eval run 路径无效") from exc
        if not within_eval.parts or within_eval.parts[0] != "output":
            raise LoopCtlError("open eval run 内的 --output 只能写入 output/")
    source_bytes = source_path.read_bytes()
    try:
        text = source_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise LoopCtlError(f"--source 必须是有效 UTF-8 文本：{args.source}: {exc}") from exc

    scoped = scoped_text_metrics(text, bool(args.exclude_first_markdown_h1))
    source_relative = source_path.relative_to(root).as_posix()
    supersession: Dict[str, Any] = {
        "generation": 1,
        "predecessor": None,
    }
    if output_attempt is not None:
        chain = controller_facts_chain_state(root, output_attempt)
        previous = chain["active_by_source"].get(source_relative)
        if previous is not None:
            previous_path = previous["path"]
            supersession = {
                "generation": int(previous["generation"]) + 1,
                "predecessor": {
                    "path": previous_path.relative_to(root).as_posix(),
                    "sha256": sha256_file(previous_path),
                    "bytes": previous_path.stat().st_size,
                },
            }
    facts = {
        "schema_version": SCHEMA_VERSION,
        "kind": "ControllerArtifactFacts",
        "source": {
            "path": source_relative,
            "sha256": sha256_bytes(source_bytes),
            "bytes": len(source_bytes),
            "encoding": "UTF-8",
        },
        "supersession": supersession,
        "whole_file_metrics": {
            "line_count": len(text.splitlines()),
            "unicode_codepoint_count": len(text),
            "unicode_han_count": unicode_han_count(text),
            "unicode_han_metric_version": HAN_METRIC_VERSION,
        },
        **scoped,
        "authority": {
            "generator": "loopctl.py measure-artifact",
            "mechanical_fields_governing": True,
            "producer_self_report_governing": False,
        },
    }
    try:
        atomic_create_json(output_path, facts)
    except LoopCtlError as exc:
        if output_path.exists():
            raise LoopCtlError(
                f"--output 已存在，拒绝覆盖：{args.output}；"
                "请改用新的 --output 路径重新运行 measure-artifact，旧 facts 会自动保留"
            ) from exc
        raise
    return {
        "status": "PASS",
        "source": facts["source"],
        "facts": output_path.relative_to(root).as_posix(),
        "facts_sha256": sha256_file(output_path),
        "generation": supersession["generation"],
        "supersedes": (
            supersession["predecessor"]["path"]
            if isinstance(supersession.get("predecessor"), dict)
            else None
        ),
        "active": True,
        "scope": facts["scope"],
        "unicode_han_count": facts["metrics"]["unicode_han_count"],
    }


def sealed_manifests(root: Path) -> List[Dict[str, Any]]:
    manifests: List[Dict[str, Any]] = []
    runs_root = root / "creative-system" / "runs"
    if not runs_root.is_dir():
        return manifests
    for manifest_path in sorted(runs_root.glob("*/attempts/*/manifest.json")):
        if not (manifest_path.parent / ".sealed.json").is_file():
            continue
        value = load_json(manifest_path)
        if isinstance(value, dict):
            value = dict(value)
            value["_manifest_path"] = manifest_path.relative_to(root).as_posix()
            manifests.append(value)
    return manifests


def final_run_manifests(root: Path) -> List[Dict[str, Any]]:
    by_run: Dict[str, Dict[str, Any]] = {}
    for manifest in sealed_manifests(root):
        run_id = str(manifest.get("run_id", ""))
        attempt_id = str(manifest.get("attempt_id", ""))
        previous = by_run.get(run_id)
        if previous is None or attempt_id > str(previous.get("attempt_id", "")):
            by_run[run_id] = manifest
    return [by_run[key] for key in sorted(by_run)]


def maturity_index(level: str) -> int:
    try:
        return LEVELS.index(level)
    except ValueError:
        return -1


def audit_project(root: Path) -> Dict[str, Any]:
    validation = validate_project(root)
    if validation["errors"]:
        return {
            "status": "BLOCK",
            "provable_maturity": "NONE",
            "next_level": "L0",
            "gaps": ["先修复 validate 报告中的合同错误"],
            "evidence": {"validation": validation},
        }

    system = load_system(root)
    charter = system.get("charter", {})
    finals = [item for item in final_run_manifests(root) if item.get("real_run") is True]
    post_l4_finals = [
        item
        for item in finals
        if (
            item.get("run_phase") == "post-l4"
            and item.get("provable_maturity_at_start") == "L4"
            and item.get("active_version_at_start") not in {None, "", "baseline-v1"}
        )
    ]
    human_receipt_finals = [
        item for item in finals if isinstance(item.get("human_feedback_receipt"), dict)
    ]
    evidence: Dict[str, Any] = {
        "charter_confirmed": charter.get("confirmed") is True,
        "sealed_runs": len(finals),
        "representative_tasks": len({str(item.get("task", "")) for item in finals if item.get("task")}),
        "verified_human_feedback_receipts": len(human_receipt_finals),
        "human_accepted": sum(
            item.get("human_feedback_receipt", {}).get("claims", {}).get("human_accepted")
            is True
            for item in human_receipt_finals
        ),
        "post_l4_runs": len(post_l4_finals),
        "post_l4_improved_runs": sum(item.get("improved") is True for item in post_l4_finals),
        "post_l4_committed_runs": sum(item.get("decision") == "commit" for item in post_l4_finals),
    }
    provable = "NONE"
    gaps: List[str] = []

    if charter.get("confirmed") is not True:
        gaps.append(
            "请使用者明确确认 creative-system/creative-charter.md，并用 confirm-charter 绑定原始回复"
        )
        next_level = "L0"
    else:
        provable = "L0"
        representative_tasks = evidence["representative_tasks"]
        accepted = evidence["human_accepted"]
        failures_stoppable = all(
            item.get("execution_status") != "BLOCK"
            or bool(item.get("findings"))
            or bool(item.get("stop_reason"))
            for item in finals
        )
        evidence["failures_stoppable"] = failures_stoppable
        if len(finals) >= 3 and representative_tasks >= 3 and accepted >= 2 and failures_stoppable:
            provable = "L1"
        else:
            if len(finals) < 3:
                gaps.append(f"还需 {3 - len(finals)} 个已封存代表 run")
            if representative_tasks < 3:
                gaps.append(f"还需 {3 - representative_tasks} 条不同的代表任务")
            if accepted < 2:
                gaps.append(f"还需 {2 - accepted} 个使用者认可结果")
            if not failures_stoppable:
                gaps.append("失败 run 必须有 finding 或明确停止原因")

        if provable == "L1":
            direction_pairs = [
                item
                for item in human_receipt_finals
                if item.get("machine_direction") in {"PASS", "BLOCK"}
                and item.get("human_feedback_receipt", {})
                .get("claims", {})
                .get("human_direction")
                in {"PASS", "BLOCK"}
            ]
            agreements = sum(
                item.get("machine_direction")
                == item.get("human_feedback_receipt", {}).get("claims", {}).get("human_direction")
                for item in direction_pairs
            )
            agreement = agreements / len(direction_pairs) if direction_pairs else 0.0
            hard_false_passes = sum(bool(item.get("hard_contract_false_pass")) for item in finals)
            recovery_exercises = sum(bool(item.get("recovery_exercised")) for item in finals)
            evidence.update(
                {
                    "calibrated_direction_pairs": len(direction_pairs),
                    "human_machine_direction_agreement": round(agreement, 4),
                    "hard_contract_false_passes": hard_false_passes,
                    "recovery_exercises": recovery_exercises,
                }
            )
            if (
                len(finals) >= 5
                and len(direction_pairs) >= 5
                and agreement >= 0.8
                and hard_false_passes == 0
                and recovery_exercises >= 1
            ):
                provable = "L2"
            else:
                if len(finals) < 5:
                    gaps.append(f"L2 还需 {5 - len(finals)} 个已封存样本")
                if len(direction_pairs) < 5:
                    gaps.append(f"L2 还需 {5 - len(direction_pairs)} 个人机方向校准样本")
                if direction_pairs and agreement < 0.8:
                    gaps.append("人机 PASS/BLOCK 方向一致率低于 80%")
                if hard_false_passes:
                    gaps.append("存在硬合同假通过")
                if recovery_exercises < 1:
                    gaps.append("还需成功演练一次局部恢复")

        if provable == "L2":
            loop_count = len(system.get("loops", [])) if isinstance(system.get("loops"), list) else 0
            local_recovery = any(bool(item.get("local_recovery_preserved_upstream")) for item in finals)
            no_regression = any(bool(item.get("end_to_end_no_regression")) for item in finals)
            solved_problem = any(bool(item.get("resolved_observed_problem")) for item in finals)
            evidence.update(
                {
                    "loop_count": loop_count,
                    "local_recovery_preserved_upstream": local_recovery,
                    "end_to_end_no_regression": no_regression,
                    "resolved_observed_problem": solved_problem,
                }
            )
            if loop_count >= 2 and local_recovery and no_regression and solved_problem:
                provable = "L3"
            else:
                if loop_count < 2:
                    gaps.append("L3 至少需要两个有唯一 owner 的关联 Loop")
                if not local_recovery:
                    gaps.append("还需证明局部重跑不破坏已确认上游")
                if not no_regression:
                    gaps.append("还需证明端到端不低于 L2 基线")
                if not solved_problem:
                    gaps.append("还需解决一个真实观察到的问题")

        registry_path = root / "creative-system" / "releases" / "registry.json"
        registry = load_json(registry_path) if registry_path.is_file() else {"history": []}
        active_version = system.get("project", {}).get("active_version")
        promotions = [
            item
            for item in registry.get("history", [])
            if (
                isinstance(item, dict)
                and item.get("action") == "promote"
                and item.get("state") == "COMMITTED"
                and item.get("new_version") == active_version
            )
        ] if isinstance(registry, dict) else []
        evidence["promoted_l4_candidates"] = len(promotions)
        if provable == "L3":
            if promotions:
                provable = "L4"
            else:
                gaps.append("还需一个通过目标、回归、held-out 盲评和人工批准的 L4 候选")

        next_level = "L5" if provable == "L4" else LEVELS[maturity_index(provable) + 1]

    candidates_root = root / "creative-system" / "candidates"
    open_candidates = 0
    if candidates_root.is_dir():
        for status_path in candidates_root.glob("*/status.json"):
            status_value = load_json(status_path)
            if isinstance(status_value, dict) and status_value.get("status") in {
                "DRAFT",
                "CANDIDATE",
                "META_EVALUATED",
            }:
                open_candidates += 1
    user_status = "NEEDS_TASTE" if provable == "NONE" else ("CANDIDATE" if open_candidates else "PASS")
    declared = str(system.get("maturity", {}).get("declared", "L0"))
    if maturity_index(declared) > maturity_index(provable):
        validation["warnings"].append(
            f"declared_maturity={declared} 高于当前可证明成熟度 {provable}；audit 不采信声明"
        )
    return {
        "status": user_status,
        "provable_maturity": provable,
        "declared_maturity": declared,
        "next_level": next_level,
        "gaps": gaps,
        "evidence": evidence,
        "warnings": validation["warnings"],
        "l5_boundary": "experimental / unvalidated / CANDIDATE only",
    }


def command_audit(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    with exclusive_controller_lock(root):
        report = audit_project(root)
    report["project"] = str(root)
    return report


def find_loop(root: Path, loop_id: str) -> Dict[str, Any]:
    system = load_system(root)
    for relative in system.get("loops", []):
        if not isinstance(relative, str):
            continue
        loop = load_json(safe_relative(root, relative, "Loop 引用"))
        if isinstance(loop, dict) and loop.get("id") == loop_id:
            return loop
    raise LoopCtlError(f"未知 Loop：{loop_id}")


def generated_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dt%H%M%Sz").lower()
    return f"run-{stamp}-{uuid.uuid4().hex[:8]}"


def run_start_snapshot(root: Path, system: Mapping[str, Any]) -> Dict[str, Any]:
    audit = audit_project(root)
    if audit.get("status") == "BLOCK":
        raise LoopCtlError("无法建立 run 起点快照：audit 当前为 BLOCK")
    maturity = str(audit.get("provable_maturity", "NONE"))
    project = system.get("project", {})
    active_version = project.get("active_version") if isinstance(project, Mapping) else None
    if not isinstance(active_version, str) or not active_version:
        raise LoopCtlError("无法建立 run 起点快照：active version 无效")
    phase = "post-l4" if maturity == "L4" and active_version != "baseline-v1" else "bootstrap"
    post_l4_index: Optional[int] = None
    if phase == "post-l4":
        evidence = audit.get("evidence", {})
        prior = evidence.get("post_l4_runs", 0) if isinstance(evidence, Mapping) else 0
        post_l4_index = int(prior) + 1
    return {
        "active_version_at_start": active_version,
        "provable_maturity_at_start": maturity,
        "run_phase": phase,
        "post_l4_iteration_index": post_l4_index,
    }


def open_attempt_context(
    root: Path, run_id_value: str
) -> Tuple[str, Path, Path, Dict[str, Any], str, Path]:
    run_id = ensure_id(run_id_value, "--run-id")
    run_dir = root / "creative-system" / "runs" / run_id
    guard_project_directory(root, run_dir, "run root")
    guard_project_directory(root, run_dir / "control", "run control", allow_missing=True)
    run_path = run_dir / "run.json"
    run_file = regular_project_file(
        root, run_path.relative_to(root).as_posix(), "run record"
    )
    run = load_json(run_file)
    if not isinstance(run, dict):
        raise LoopCtlError("run.json 无效")
    attempt_id = run.get("current_attempt")
    if not isinstance(attempt_id, str) or not re.fullmatch(r"attempt-[0-9]{3}", attempt_id):
        raise LoopCtlError("run 没有可用的 open attempt")
    attempt_dir = run_dir / "attempts" / attempt_id
    guard_project_directory(root, attempt_dir, "attempt root")
    if not (attempt_dir / "attempt.json").is_file():
        raise LoopCtlError(f"attempt 不存在：{attempt_dir}")
    if (attempt_dir / ".sealed.json").exists():
        raise LoopCtlError(f"attempt 已封存：{attempt_id}")
    return run_id, run_dir, run_path, run, attempt_id, attempt_dir


def human_review_paths(root: Path, attempt_dir: Path) -> Tuple[Path, Path]:
    run_dir = attempt_dir.parent.parent
    subject = attempt_dir / "human-review" / "subject.json"
    anchor = (
        run_dir
        / "control"
        / "human-review-open-anchors"
        / f"{attempt_dir.name}.json"
    )
    for path, label in ((subject, "human review subject"), (anchor, "human review anchor")):
        reject_symlink_components(root, path.relative_to(root).as_posix(), label)
    return subject, anchor


def human_review_artifact_identity(
    dispatch_id: Optional[str],
    artifact_root: str,
    artifact_files: Sequence[Mapping[str, Any]],
    verified_controller_facts: Sequence[str],
    active_controller_facts: Sequence[Mapping[str, Any]],
    machine_direction: str,
) -> Dict[str, Any]:
    return {
        "dispatch_id": dispatch_id,
        "artifact_root": artifact_root,
        "artifact_files": list(artifact_files),
        "verified_controller_facts": list(verified_controller_facts),
        "active_controller_facts": list(active_controller_facts),
        "machine_direction": machine_direction,
    }


def review_available_timestamp(attempt_dir: Path) -> str:
    attempt = load_json(attempt_dir / "attempt.json")
    opened = utc_datetime(
        attempt.get("opened_at") if isinstance(attempt, dict) else None,
        "attempt.opened_at",
    )
    current = datetime.now(timezone.utc)
    if current <= opened:
        current = opened + timedelta(microseconds=1)
    return current.isoformat(timespec="microseconds").replace("+00:00", "Z")


def verify_human_review_subject(
    root: Path, attempt_dir: Path
) -> Dict[str, Any]:
    subject_path, anchor_path = human_review_paths(root, attempt_dir)
    if subject_path.is_symlink() or anchor_path.is_symlink():
        raise LoopCtlError("human review subject/anchor 不允许是符号链接")
    if not subject_path.is_file() or not anchor_path.is_file():
        raise LoopCtlError("人工判断前必须先运行 open-human-review 冻结送审版本")
    subject = load_json(subject_path)
    anchor = load_json(anchor_path)
    run_id = attempt_dir.parent.parent.name
    attempt_id = attempt_dir.name
    attempt_record = load_json(attempt_dir / "attempt.json")
    loop_id = attempt_record.get("loop_id") if isinstance(attempt_record, dict) else None
    if (
        not isinstance(subject, dict)
        or subject.get("schema_version") != SCHEMA_VERSION
        or subject.get("kind") != "HumanReviewSubject"
        or subject.get("state") != "OPEN"
        or subject.get("run_id") != run_id
        or subject.get("attempt_id") != attempt_id
        or subject.get("loop_id") != loop_id
        or subject.get("machine_direction") not in {"PASS", "BLOCK", "UNKNOWN"}
    ):
        raise LoopCtlError("HumanReviewSubject 合同无效")
    subject_relative = subject_path.relative_to(root).as_posix()
    anchor_relative = anchor_path.relative_to(root).as_posix()
    subject_sha256 = sha256_file(subject_path)
    if (
        not isinstance(anchor, dict)
        or anchor.get("schema_version") != SCHEMA_VERSION
        or anchor.get("kind") != "HumanReviewOpenAnchor"
        or anchor.get("state") != "OPEN_ANCHORED"
        or anchor.get("run_id") != run_id
        or anchor.get("attempt_id") != attempt_id
        or anchor.get("subject_path") != subject_relative
        or anchor.get("subject_sha256") != subject_sha256
        or anchor.get("artifact_subject_sha256") != subject.get("artifact_subject_sha256")
        or anchor.get("review_available_at") != subject.get("frozen_at")
    ):
        raise LoopCtlError("HumanReviewOpenAnchor 与 subject 不一致")
    try:
        opened_at = utc_datetime(
            attempt_record.get("opened_at") if isinstance(attempt_record, dict) else None,
            "attempt.opened_at",
        )
        review_at = utc_datetime(anchor.get("review_available_at"), "review_available_at")
        if review_at <= opened_at:
            raise LoopCtlError("review_available_at 必须严格晚于 attempt.opened_at")
    except LoopCtlError:
        raise

    dispatch_id = subject.get("dispatch_id")
    if dispatch_id is not None and not isinstance(dispatch_id, str):
        raise LoopCtlError("HumanReviewSubject.dispatch_id 无效")
    current_dispatch, artifact_root, artifact_files = governing_artifacts_for_seal(
        root, attempt_dir, dispatch_id
    )
    facts = verify_attempt_controller_facts(root, attempt_dir, artifact_root, artifact_files)
    active_facts = controller_facts_snapshots(root, facts)
    artifact_root_relative = artifact_root.relative_to(attempt_dir).as_posix()
    identity = human_review_artifact_identity(
        current_dispatch,
        artifact_root_relative,
        artifact_files,
        facts,
        active_facts,
        str(subject.get("machine_direction")),
    )
    artifact_subject_sha256 = sha256_bytes(canonical_json_bytes(identity))
    if (
        subject.get("dispatch_id") != current_dispatch
        or subject.get("artifact_root") != artifact_root_relative
        or subject.get("artifact_files") != artifact_files
        or subject.get("verified_controller_facts") != facts
        or subject.get("active_controller_facts") != active_facts
        or subject.get("artifact_subject_sha256") != artifact_subject_sha256
    ):
        raise LoopCtlError(
            "HUMAN_REVIEW_SUBJECT_STALE：作品在送审后发生变化，本次反馈不能用于该版本"
        )
    return {
        "subject": subject,
        "anchor": anchor,
        "subject_path": subject_relative,
        "subject_sha256": subject_sha256,
        "anchor_path": anchor_relative,
        "anchor_sha256": sha256_file(anchor_path),
        "artifact_identity": identity,
    }


def terminal_invalid_marker(attempt_dir: Path) -> Path:
    run_dir = attempt_dir.parent.parent
    return run_dir / "control" / "terminal-invalid" / f"{attempt_dir.name}.json"


def ensure_attempt_not_terminal_invalid(attempt_dir: Path) -> None:
    marker = terminal_invalid_marker(attempt_dir)
    if marker.is_file():
        incident = load_json(marker)
        code = incident.get("reason_code", "TERMINAL_INVALID") if isinstance(incident, dict) else "TERMINAL_INVALID"
        raise LoopCtlError(f"{code}：attempt 已永久失效，必须使用新 run")


def mark_attempt_terminal_invalid(
    attempt_dir: Path, reason_code: str, evidence: Mapping[str, Any]
) -> Path:
    marker = terminal_invalid_marker(attempt_dir)
    incident = {
        "schema_version": SCHEMA_VERSION,
        "kind": "TerminalAttemptIncident",
        "state": "TERMINAL_INVALID",
        "reason_code": reason_code,
        "run_id": attempt_dir.parent.parent.name,
        "attempt_id": attempt_dir.name,
        "recorded_at": utc_now(),
        "content_attempt_committed": False,
        "successor_run_required": True,
        "evidence": dict(evidence),
    }
    if marker.exists():
        ensure_attempt_not_terminal_invalid(attempt_dir)
    atomic_create_json(marker, incident)
    return marker


def dispatch_directories(attempt_dir: Path) -> List[Path]:
    root = attempt_dir / "dispatches"
    if not root.exists():
        return []
    if root.is_symlink() or not root.is_dir():
        raise LoopCtlError(f"dispatches 必须是普通目录：{root}")
    directories: List[Path] = []
    for path in sorted(root.iterdir()):
        if path.is_symlink():
            raise LoopCtlError(f"dispatch 不允许使用符号链接：{path}")
        record_path = path / "dispatch.json"
        if not path.is_dir() or record_path.is_symlink() or not record_path.is_file():
            raise LoopCtlError(f"dispatch 目录无效：{path}")
        directories.append(path)
    return directories


def load_dispatch_record(root: Path, attempt_dir: Path, dispatch_dir: Path) -> Dict[str, Any]:
    record = load_json(dispatch_dir / "dispatch.json")
    expected_run_id = attempt_dir.parent.parent.name
    expected_attempt_id = attempt_dir.name
    expected_dispatch_id = dispatch_dir.name
    expected_root = (dispatch_dir / "artifacts").relative_to(root).as_posix()
    if not isinstance(record, dict) or record.get("kind") != "DispatchRecord":
        raise LoopCtlError(f"dispatch record 无效：{expected_dispatch_id}")
    if (
        record.get("run_id") != expected_run_id
        or record.get("attempt_id") != expected_attempt_id
        or record.get("dispatch_id") != expected_dispatch_id
        or record.get("allowed_writes_root") != expected_root
        or record.get("state") != "OPEN"
        or not isinstance(record.get("context_id"), str)
        or not record.get("context_id")
    ):
        raise LoopCtlError(f"dispatch record 身份或 allowed-writes root 不一致：{expected_dispatch_id}")
    return record


def load_dispatch_stall(
    root: Path, attempt_dir: Path, dispatch_dir: Path, record: Mapping[str, Any]
) -> Optional[Dict[str, Any]]:
    path = dispatch_dir / "stall.json"
    if path.is_symlink():
        raise LoopCtlError(f"dispatch stall record 不允许是符号链接：{path}")
    if not path.exists():
        return None
    stall = load_json(path)
    facts = stall.get("controller_facts") if isinstance(stall, dict) else None
    attestation = stall.get("orchestrator_attestation") if isinstance(stall, dict) else None
    budget = stall.get("budget") if isinstance(stall, dict) else None
    if (
        not isinstance(stall, dict)
        or stall.get("kind") != "DispatchStallRecord"
        or stall.get("reason_code") != "ZERO_FILE_DISPATCH_STALL"
        or stall.get("run_id") != attempt_dir.parent.parent.name
        or stall.get("attempt_id") != attempt_dir.name
        or stall.get("dispatch_id") != dispatch_dir.name
        or stall.get("state") not in {"RECORDED", "BUDGET_EXHAUSTED"}
        or stall.get("content_attempt_consumed") is not False
        or stall.get("revision_consumed") is not False
        or stall.get("no_improvement_consumed") is not False
        or not isinstance(facts, dict)
        or facts.get("allowed_writes_root") != record.get("allowed_writes_root")
        or facts.get("regular_file_count") != 0
        or facts.get("inventory") != []
        or facts.get("mechanically_governing") is not True
        or not isinstance(attestation, dict)
        or attestation.get("context_id") != record.get("context_id")
        or attestation.get("context_stopped") is not True
        or attestation.get("mechanically_verified_by_loopctl") is not False
        or not isinstance(budget, dict)
        or not isinstance(budget.get("max_zero_file_stalls"), int)
        or isinstance(budget.get("max_zero_file_stalls"), bool)
        or not isinstance(budget.get("zero_file_stalls_used"), int)
        or isinstance(budget.get("zero_file_stalls_used"), bool)
        or budget.get("zero_file_stalls_used") < 1
        or budget.get("zero_file_stalls_used") > budget.get("max_zero_file_stalls")
        or budget.get("on_exhausted") not in {"stop", "escalate"}
        or (
            stall.get("state") == "BUDGET_EXHAUSTED"
            and budget.get("zero_file_stalls_used") != budget.get("max_zero_file_stalls")
        )
        or (
            stall.get("state") == "RECORDED"
            and budget.get("zero_file_stalls_used") >= budget.get("max_zero_file_stalls")
        )
    ):
        raise LoopCtlError(f"dispatch stall record 无效：{dispatch_dir.name}")
    return stall


def runtime_dispatch_budget(system: Mapping[str, Any]) -> Tuple[int, str]:
    recovery = system.get("recovery_policy", {})
    budget = recovery.get("runtime_dispatch_budget", {}) if isinstance(recovery, Mapping) else {}
    maximum = budget.get("max_zero_file_stalls") if isinstance(budget, Mapping) else None
    on_exhausted = budget.get("on_exhausted") if isinstance(budget, Mapping) else None
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
        raise LoopCtlError("runtime_dispatch_budget.max_zero_file_stalls 无效")
    if on_exhausted not in {"stop", "escalate"}:
        raise LoopCtlError("runtime_dispatch_budget.on_exhausted 无效")
    return maximum, str(on_exhausted)


def attempt_runtime_dispatch_budget(attempt_dir: Path) -> Tuple[int, str]:
    attempt = load_json(attempt_dir / "attempt.json")
    budget = attempt.get("runtime_dispatch_budget") if isinstance(attempt, dict) else None
    maximum = budget.get("max_zero_file_stalls") if isinstance(budget, dict) else None
    on_exhausted = budget.get("on_exhausted") if isinstance(budget, dict) else None
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
        raise LoopCtlError("attempt runtime_dispatch_budget.max_zero_file_stalls 无效")
    if on_exhausted not in {"stop", "escalate"}:
        raise LoopCtlError("attempt runtime_dispatch_budget.on_exhausted 无效")
    return maximum, str(on_exhausted)


def command_begin_run(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    run_id = ensure_id(args.run_id or generated_run_id(), "--run-id")
    args.run_id = run_id
    runs_root = root / "creative-system" / "runs"
    with exclusive_controller_lock(root):
        return command_begin_run_locked(args, root, run_id)


def command_begin_run_locked(
    args: argparse.Namespace, root: Path, expected_run_id: str
) -> Dict[str, Any]:
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("项目合同未通过：" + "; ".join(validation["errors"]))
    system = load_system(root)
    if not system.get("charter", {}).get("confirmed"):
        raise LoopCtlError("NEEDS_TASTE：创作宪法尚未由使用者确认")
    loop_id = ensure_id(args.loop, "--loop")
    loop = find_loop(root, loop_id)
    task = single_line(args.task, "--task", maximum=500)
    run_id = ensure_id(args.run_id or generated_run_id(), "--run-id")
    if run_id != expected_run_id:
        raise LoopCtlError("run id 在获取控制器锁期间发生变化")
    run_dir = root / "creative-system" / "runs" / run_id
    guard_project_directory(root, run_dir, "run root", allow_missing=True)
    run_path = run_dir / "run.json"
    reject_symlink_components(
        root, run_path.relative_to(root).as_posix(), "run record"
    )
    if os.path.lexists(str(run_path)):
        run = load_json(
            regular_project_file(
                root, run_path.relative_to(root).as_posix(), "run record"
            )
        )
        if not isinstance(run, dict):
            raise LoopCtlError(f"run.json 无效：{run_path}")
        if run.get("loop_id") != loop_id or run.get("task") != task:
            raise LoopCtlError("继续已有 run 时，--loop 与 --task 必须保持不变")
        previous_attempts = run.get("attempts", [])
        if not isinstance(previous_attempts, list):
            raise LoopCtlError("run.attempts 无效")
        if previous_attempts:
            latest = run_dir / "attempts" / str(previous_attempts[-1])
            if not (latest / ".sealed.json").is_file():
                raise LoopCtlError("上一 attempt 尚未封存，拒绝新建重试")
        next_number = len(previous_attempts) + 1
    else:
        if run_dir.exists() and any(run_dir.iterdir()):
            raise LoopCtlError(f"run 目录已存在且不可识别：{run_dir}")
        next_number = 1
        snapshot = run_start_snapshot(root, system)
        run = {
            "schema_version": SCHEMA_VERSION,
            "kind": "RunRecord",
            "run_id": run_id,
            "loop_id": loop_id,
            "task": task,
            "created_at": utc_now(),
            "recovery_of": args.recovery_of,
            "real_run": not bool(args.synthetic),
            "attempts": [],
            "execution_status": "RUNNING",
            "quality_status": "NOT_EVALUATED",
            "release_status": "NOT_READY",
            **snapshot,
        }
    maximum_attempts = int(loop.get("retry_budget", {}).get("max_attempts", 0))
    if next_number > maximum_attempts:
        raise LoopCtlError(f"retry budget 已耗尽：最多 {maximum_attempts} 个 attempt")
    if args.recovery_of:
        ensure_id(args.recovery_of, "--recovery-of")
        recovery_relative = (
            Path("creative-system") / "runs" / args.recovery_of / "run.json"
        ).as_posix()
        regular_project_file(root, recovery_relative, "--recovery-of run record")

    attempt_id = f"attempt-{next_number:03d}"
    attempt_dir = run_dir / "attempts" / attempt_id
    guard_project_directory(root, run_dir / "attempts", "attempts root", allow_missing=True)
    guard_project_directory(root, attempt_dir, "attempt root", allow_missing=True)
    if os.path.lexists(str(attempt_dir)):
        raise LoopCtlError(f"attempt 已存在，拒绝覆盖：{attempt_dir}")
    attempt_dir.mkdir(parents=True)
    runtime_maximum, runtime_on_exhausted = runtime_dispatch_budget(system)
    attempt_record = {
        "schema_version": SCHEMA_VERSION,
        "kind": "AttemptRecord",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "loop_id": loop_id,
        "task": task,
        "opened_at": utc_now(),
        "execution_status": "RUNNING",
        "quality_status": "NOT_EVALUATED",
        "release_status": "NOT_READY",
        "active_version_at_start": run.get("active_version_at_start"),
        "provable_maturity_at_start": run.get("provable_maturity_at_start"),
        "run_phase": run.get("run_phase"),
        "post_l4_iteration_index": run.get("post_l4_iteration_index"),
        "runtime_dispatch_budget": {
            "max_zero_file_stalls": runtime_maximum,
            "on_exhausted": runtime_on_exhausted,
        },
    }
    atomic_write_json(attempt_dir / "attempt.json", attempt_record)
    (attempt_dir / "artifacts").mkdir()
    run["current_attempt"] = attempt_id
    run["execution_status"] = "RUNNING"
    atomic_write_json(run_path, run)
    system["statuses"]["execution_status"] = "RUNNING"
    system["statuses"]["release_status"] = "NOT_READY"
    atomic_write_json(system_path(root), system)
    return {
        "status": "PASS",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "attempt_path": attempt_dir.relative_to(root).as_posix(),
        "active_version_at_start": run.get("active_version_at_start"),
        "provable_maturity_at_start": run.get("provable_maturity_at_start"),
        "run_phase": run.get("run_phase"),
        "post_l4_iteration_index": run.get("post_l4_iteration_index"),
        "next_step": "把产物、评价和 finding 写入 attempt 后运行 seal-attempt",
    }


def command_open_dispatch(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    run_id, run_dir, _, _, attempt_id, attempt_dir = open_attempt_context(root, args.run_id)
    with exclusive_controller_lock(root):
        ensure_attempt_not_terminal_invalid(attempt_dir)
        return command_open_dispatch_locked(args, root, run_id)


def command_open_dispatch_locked(
    args: argparse.Namespace, root: Path, expected_run_id: str
) -> Dict[str, Any]:
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("项目合同未通过：" + "; ".join(validation["errors"]))
    run_id, _, _, _, attempt_id, attempt_dir = open_attempt_context(root, args.run_id)
    if run_id != expected_run_id:
        raise LoopCtlError("run 在获取控制器锁期间发生变化")
    ensure_attempt_not_terminal_invalid(attempt_dir)
    dispatch_id = ensure_id(args.dispatch_id, "--dispatch-id")
    context_id = single_line(args.context_id, "--context-id", maximum=200)
    maximum, on_exhausted = attempt_runtime_dispatch_budget(attempt_dir)
    existing = dispatch_directories(attempt_dir)
    dispatch_states = [
        (path, load_dispatch_stall(root, attempt_dir, path, load_dispatch_record(root, attempt_dir, path)))
        for path in existing
    ]
    open_items = [path for path, stall in dispatch_states if stall is None]
    if open_items:
        raise LoopCtlError(f"已有未结束 dispatch：{open_items[0].name}")
    stalls_used = sum(1 for _, stall in dispatch_states if stall is not None)
    if any(
        stall is not None and stall.get("state") == "BUDGET_EXHAUSTED"
        for _, stall in dispatch_states
    ):
        raise LoopCtlError("runtime dispatch budget 已封存为 BUDGET_EXHAUSTED，attempt 不得继续")
    if stalls_used >= maximum:
        raise LoopCtlError(
            f"runtime dispatch budget 已耗尽：zero-file stalls={stalls_used}/{maximum}，必须 {on_exhausted}"
        )
    legacy_inventory = regular_file_inventory(attempt_dir / "artifacts", label="legacy artifacts root")
    if legacy_inventory:
        raise LoopCtlError("已有 legacy artifacts，禁止中途切换到独立 dispatch 模式")

    dispatch_dir = attempt_dir / "dispatches" / dispatch_id
    try:
        dispatch_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise LoopCtlError(f"dispatch 已存在，拒绝覆盖：{dispatch_id}") from exc
    artifacts_dir = dispatch_dir / "artifacts"
    artifacts_dir.mkdir()
    record = {
        "schema_version": SCHEMA_VERSION,
        "kind": "DispatchRecord",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "dispatch_id": dispatch_id,
        "context_id": context_id,
        "opened_at": utc_now(),
        "state": "OPEN",
        "allowed_writes_root": artifacts_dir.relative_to(root).as_posix(),
        "runtime_budget": {
            "max_zero_file_stalls": maximum,
            "zero_file_stalls_used_before_open": stalls_used,
            "on_exhausted": on_exhausted,
        },
    }
    try:
        atomic_create_json(dispatch_dir / "dispatch.json", record)
    except BaseException:
        try:
            artifacts_dir.rmdir()
            dispatch_dir.rmdir()
        except OSError:
            pass
        raise
    return {
        "status": "PASS",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "dispatch_id": dispatch_id,
        "allowed_writes_root": record["allowed_writes_root"],
        "zero_file_stalls_remaining": maximum - stalls_used,
        "next_step": "Producer 只能写 allowed_writes_root；完成后封存，精确零文件时运行 record-dispatch-stall",
    }


def command_record_dispatch_stall(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    run_id, run_dir, _, _, attempt_id, attempt_dir = open_attempt_context(root, args.run_id)
    with exclusive_controller_lock(root):
        ensure_attempt_not_terminal_invalid(attempt_dir)
        return command_record_dispatch_stall_locked(args, root, run_id)


def command_record_dispatch_stall_locked(
    args: argparse.Namespace, root: Path, expected_run_id: str
) -> Dict[str, Any]:
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("项目合同未通过：" + "; ".join(validation["errors"]))
    run_id, _, _, run, attempt_id, attempt_dir = open_attempt_context(root, args.run_id)
    if run_id != expected_run_id:
        raise LoopCtlError("run 在获取控制器锁期间发生变化")
    ensure_attempt_not_terminal_invalid(attempt_dir)
    dispatch_id = ensure_id(args.dispatch_id, "--dispatch-id")
    dispatch_dir = attempt_dir / "dispatches" / dispatch_id
    record = load_dispatch_record(root, attempt_dir, dispatch_dir)
    if load_dispatch_stall(root, attempt_dir, dispatch_dir, record) is not None:
        raise LoopCtlError(f"dispatch stall 已记录，拒绝覆盖：{dispatch_id}")
    if not args.context_stopped:
        raise LoopCtlError("必须由 orchestrator 明确证明 context 已停止，才能记录 zero-file stall")
    inventory = regular_file_inventory(dispatch_dir / "artifacts", label="dispatch allowed-writes root")
    if inventory:
        raise LoopCtlError(
            f"ZERO_FILE_DISPATCH_STALL 不成立：allowed-writes 内已有 {len(inventory)} 个普通文件"
        )

    maximum, on_exhausted = attempt_runtime_dispatch_budget(attempt_dir)
    prior_stall_records = []
    for path in dispatch_directories(attempt_dir):
        if path == dispatch_dir:
            continue
        prior_record = load_dispatch_record(root, attempt_dir, path)
        prior_stall = load_dispatch_stall(root, attempt_dir, path, prior_record)
        if prior_stall is None:
            raise LoopCtlError(f"已有未结束 dispatch：{path.name}")
        if prior_stall.get("state") == "BUDGET_EXHAUSTED":
            raise LoopCtlError("runtime dispatch budget 已封存为 BUDGET_EXHAUSTED，attempt 不得继续")
        prior_stall_records.append(prior_stall)
    prior_stalls = len(prior_stall_records)
    used_values = sorted(
        item.get("budget", {}).get("zero_file_stalls_used")
        for item in prior_stall_records
        if isinstance(item.get("budget"), dict)
    )
    if used_values != list(range(1, prior_stalls + 1)):
        raise LoopCtlError("既有 dispatch stall budget 计数不连续")
    if prior_stalls >= maximum:
        raise LoopCtlError(
            f"runtime dispatch budget 已耗尽：zero-file stalls={prior_stalls}/{maximum}，必须 {on_exhausted}"
        )
    used = prior_stalls + 1
    exhausted = used >= maximum
    stall = {
        "schema_version": SCHEMA_VERSION,
        "kind": "DispatchStallRecord",
        "reason_code": "ZERO_FILE_DISPATCH_STALL",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "dispatch_id": dispatch_id,
        "recorded_at": utc_now(),
        "controller_facts": {
            "allowed_writes_root": record.get("allowed_writes_root"),
            "regular_file_count": 0,
            "inventory": [],
            "mechanically_governing": True,
        },
        "orchestrator_attestation": {
            "context_id": record.get("context_id"),
            "context_stopped": True,
            "reason": single_line(args.reason, "--reason", maximum=500),
            "mechanically_verified_by_loopctl": False,
        },
        "budget": {
            "max_zero_file_stalls": maximum,
            "zero_file_stalls_used": used,
            "on_exhausted": on_exhausted,
        },
        "content_attempt_consumed": False,
        "revision_consumed": False,
        "no_improvement_consumed": False,
        "state": "BUDGET_EXHAUSTED" if exhausted else "RECORDED",
        "run_attempt_count_after_record": len(run.get("attempts", [])),
    }
    atomic_create_json(dispatch_dir / "stall.json", stall)
    return {
        "status": "BLOCK" if exhausted else "PASS",
        "reason_code": stall["reason_code"],
        "state": stall["state"],
        "run_id": run_id,
        "attempt_id": attempt_id,
        "dispatch_id": dispatch_id,
        "content_attempt_consumed": False,
        "zero_file_stalls_used": used,
        "zero_file_stalls_remaining": maximum - used,
        "next_step": on_exhausted if exhausted else "open-dispatch 使用新的 allowed-writes root 重派发",
    }


def command_open_human_review(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    with exclusive_controller_lock(root):
        validation = validate_project(root)
        if validation["errors"]:
            raise LoopCtlError("项目合同未通过：" + "; ".join(validation["errors"]))
        run_id, run_dir, _, run, attempt_id, attempt_dir = open_attempt_context(
            root, args.run_id
        )
        ensure_attempt_not_terminal_invalid(attempt_dir)
        machine_direction = args.machine_direction
        if machine_direction not in {"PASS", "BLOCK", "UNKNOWN"}:
            raise LoopCtlError("--machine-direction 无效")
        selected_dispatch, artifact_root, artifact_files = governing_artifacts_for_seal(
            root, attempt_dir, args.dispatch_id
        )
        facts = verify_attempt_controller_facts(
            root, attempt_dir, artifact_root, artifact_files
        )
        active_facts = controller_facts_snapshots(root, facts)
        artifact_root_relative = artifact_root.relative_to(attempt_dir).as_posix()
        identity = human_review_artifact_identity(
            selected_dispatch,
            artifact_root_relative,
            artifact_files,
            facts,
            active_facts,
            machine_direction,
        )
        artifact_subject_sha256 = sha256_bytes(canonical_json_bytes(identity))
        subject_path, anchor_path = human_review_paths(root, attempt_dir)
        subject_exists = os.path.lexists(str(subject_path))
        anchor_exists = os.path.lexists(str(anchor_path))
        if subject_exists or anchor_exists:
            if not (subject_exists and anchor_exists):
                raise LoopCtlError(
                    "HUMAN_REVIEW_PARTIAL_OPEN：subject/anchor 只有一侧存在，"
                    "当前 attempt 不得再接收人工声明"
                )
            verified = verify_human_review_subject(root, attempt_dir)
            existing = verified["subject"]
            if (
                existing.get("dispatch_id") != selected_dispatch
                or existing.get("artifact_subject_sha256") != artifact_subject_sha256
                or existing.get("machine_direction") != machine_direction
            ):
                raise LoopCtlError("送审版本已冻结且与本次请求不同，拒绝覆盖")
            return {
                "status": "PASS",
                "run_id": run_id,
                "attempt_id": attempt_id,
                "review_subject": verified["subject_path"],
                "review_subject_sha256": verified["subject_sha256"],
                "review_open_anchor": verified["anchor_path"],
                "review_available_at": verified["anchor"]["review_available_at"],
                "artifact_files": [item["path"] for item in artifact_files],
                "machine_direction": machine_direction,
                "idempotent": True,
                "next_step": "把冻结成品交给用户；收到原始回复后再运行 seal-attempt",
            }

        frozen_at = review_available_timestamp(attempt_dir)
        subject = {
            "schema_version": SCHEMA_VERSION,
            "kind": "HumanReviewSubject",
            "state": "OPEN",
            "run_id": run_id,
            "attempt_id": attempt_id,
            "loop_id": run.get("loop_id"),
            **identity,
            "artifact_subject_sha256": artifact_subject_sha256,
            "frozen_at": frozen_at,
        }
        guarded_mkdir_project(root, subject_path.parent, "human review subject root")
        guarded_mkdir_project(root, anchor_path.parent, "human review anchor root")
        try:
            atomic_create_json(subject_path, subject)
            anchor = {
                "schema_version": SCHEMA_VERSION,
                "kind": "HumanReviewOpenAnchor",
                "state": "OPEN_ANCHORED",
                "run_id": run_id,
                "attempt_id": attempt_id,
                "subject_path": subject_path.relative_to(root).as_posix(),
                "subject_sha256": sha256_file(subject_path),
                "artifact_subject_sha256": artifact_subject_sha256,
                "review_available_at": frozen_at,
                "anchored_at": utc_now(),
            }
            atomic_create_json(anchor_path, anchor)
        except BaseException:
            if not anchor_path.exists():
                try:
                    subject_path.unlink()
                    subject_path.parent.rmdir()
                except OSError:
                    pass
            raise
        verified = verify_human_review_subject(root, attempt_dir)
        return {
            "status": "PASS",
            "run_id": run_id,
            "attempt_id": attempt_id,
            "review_subject": verified["subject_path"],
            "review_subject_sha256": verified["subject_sha256"],
            "review_open_anchor": verified["anchor_path"],
            "review_available_at": frozen_at,
            "artifact_files": [item["path"] for item in artifact_files],
            "machine_direction": machine_direction,
            "idempotent": False,
            "next_step": "把冻结成品交给用户；收到原始回复后再运行 seal-attempt",
        }


def validate_finding(value: Any, source: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise LoopCtlError(f"Finding 顶层必须是对象：{source}")
    required = ("code", "category", "severity", "confidence", "evidence", "owner", "suggested_action")
    missing = [key for key in required if key not in value]
    if missing:
        raise LoopCtlError(f"Finding 缺少字段 {missing}：{source}")
    code = value.get("code")
    if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{2,80}", code):
        raise LoopCtlError(f"Finding.code 必须是稳定大写代码：{source}")
    if value.get("category") not in {"hard-contract", "soft-quality", "human-charter", "runtime"}:
        raise LoopCtlError(f"Finding.category 无效：{source}")
    confidence = value.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        raise LoopCtlError(f"Finding.confidence 必须在 0–1：{source}")
    if not isinstance(value.get("evidence"), list) or not value["evidence"]:
        raise LoopCtlError(f"Finding.evidence 必须是非空数组：{source}")
    for key in ("severity", "owner", "suggested_action"):
        if not isinstance(value.get(key), str) or not value[key]:
            raise LoopCtlError(f"Finding.{key} 必须是非空字符串：{source}")
    return dict(value)


def bool_choice(value: str) -> Optional[bool]:
    if value == "true":
        return True
    if value == "false":
        return False
    return None


def snapshot_human_feedback(
    root: Path,
    attempt_dir: Path,
    args: argparse.Namespace,
    *,
    human_accepted: Optional[bool],
    sealed_at: str,
    loop_id: str,
) -> Optional[Dict[str, Any]]:
    has_claim = human_accepted in {True, False} or args.human_direction in {"PASS", "BLOCK"}
    supplied = any(
        value is not None
        for value in (
            args.human_feedback_by,
            args.human_feedback_at,
            args.human_feedback_evidence,
        )
    )
    if not has_claim:
        if supplied:
            raise LoopCtlError(
                "未给出 human_accepted 或 human_direction 时不得创建人工反馈凭证"
            )
        return None
    if not all(
        value is not None
        for value in (
            args.human_feedback_by,
            args.human_feedback_at,
            args.human_feedback_evidence,
        )
    ):
        raise LoopCtlError(
            "human_accepted 或 human_direction 非 UNKNOWN 时，必须同时提供 "
            "--human-feedback-by、--human-feedback-at 与 --human-feedback-evidence；"
            "执行 Agent 不得代签裸布尔"
        )

    feedback_by = single_line(args.human_feedback_by, "--human-feedback-by")
    feedback_at = utc_timestamp(args.human_feedback_at, "--human-feedback-at")
    if utc_datetime(feedback_at, "--human-feedback-at") > utc_datetime(
        sealed_at, "sealed_at"
    ):
        raise LoopCtlError("--human-feedback-at 不得晚于 attempt 封存时间")
    evidence_relative = Path(args.human_feedback_evidence).as_posix()
    if not evidence_relative.startswith("creative-system/approvals/attempt-feedback/"):
        raise LoopCtlError(
            "--human-feedback-evidence 必须位于受保护的 "
            "creative-system/approvals/attempt-feedback/"
        )
    source = regular_project_file(root, evidence_relative, "--human-feedback-evidence")
    source_bytes = human_evidence_bytes(source, "--human-feedback-evidence")
    review = verify_human_review_subject(root, attempt_dir)
    subject = review["subject"]
    anchor = review["anchor"]
    if subject.get("loop_id") != loop_id:
        raise LoopCtlError("送审 subject 与当前 Loop 不一致")
    if subject.get("machine_direction") != args.machine_direction:
        raise LoopCtlError(
            "--machine-direction 必须等于 open-human-review 在人工反馈前冻结的方向"
        )
    review_available_at = utc_datetime(
        anchor.get("review_available_at"), "review_available_at"
    )
    if utc_datetime(feedback_at, "--human-feedback-at") < review_available_at:
        raise LoopCtlError("--human-feedback-at 不得早于冻结成品可供评审的时间")
    snapshot_relative = "human-feedback/evidence.txt"
    snapshot = attempt_dir / snapshot_relative
    guarded_mkdir_project(root, snapshot.parent, "human feedback snapshot root")
    guard_project_file_target(root, snapshot, "human feedback snapshot")
    if os.path.lexists(str(snapshot)):
        if snapshot.is_symlink() or not snapshot.is_file():
            raise LoopCtlError("human feedback snapshot 路径已被非普通文件占用")
        if snapshot.read_bytes() != source_bytes:
            raise LoopCtlError("human feedback snapshot 已存在且内容不同，拒绝覆盖")
    else:
        atomic_create_bytes(snapshot, source_bytes)
    digest = sha256_bytes(source_bytes)
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "HumanFeedbackReceipt",
        "feedback_by": feedback_by,
        "feedback_at": feedback_at,
        "recorded_at": sealed_at,
        "subject": {
            "run_id": subject.get("run_id"),
            "attempt_id": subject.get("attempt_id"),
            "loop_id": subject.get("loop_id"),
            "review_subject_path": review["subject_path"],
            "review_subject_sha256": review["subject_sha256"],
            "review_open_anchor_path": review["anchor_path"],
            "review_open_anchor_sha256": review["anchor_sha256"],
            "review_available_at": anchor.get("review_available_at"),
            "artifact_subject_sha256": subject.get("artifact_subject_sha256"),
        },
        "claims": {
            "human_accepted": human_accepted,
            "human_direction": args.human_direction,
        },
        "source_evidence": {
            "path": evidence_relative,
            "sha256": digest,
            "bytes": len(source_bytes),
        },
        "snapshot": {
            "path": snapshot_relative,
            "sha256": digest,
            "bytes": len(source_bytes),
        },
        "identity_authentication": "external-attestation-not-controller-verified",
        "controller_verification": {
            "evidence_hash_verified": True,
            "human_identity_verified": False,
        },
    }


def governing_artifacts_for_seal(
    root: Path, attempt_dir: Path, selected_dispatch_value: Optional[str]
) -> Tuple[Optional[str], Path, List[Dict[str, Any]]]:
    ensure_attempt_not_terminal_invalid(attempt_dir)
    dispatches = dispatch_directories(attempt_dir)
    legacy_root = attempt_dir / "artifacts"
    legacy_inventory = regular_file_inventory(legacy_root, label="legacy artifacts root")
    if not dispatches:
        if selected_dispatch_value:
            raise LoopCtlError("--dispatch-id 只能用于 open-dispatch 创建的独立 dispatch")
        if not legacy_inventory:
            raise LoopCtlError(
                "ZERO_FILE_DISPATCH_STALL：artifacts 内普通文件数精确为 0；"
                "不得封存或消耗 content attempt，请使用 open-dispatch/record-dispatch-stall"
            )
        return None, legacy_root, legacy_inventory

    if legacy_inventory:
        raise LoopCtlError("MIXED_DISPATCH_OUTPUT：legacy artifacts 与独立 dispatch 输出不得混用")
    if not selected_dispatch_value:
        raise LoopCtlError("独立 dispatch 模式封存时必须指定 --dispatch-id")
    selected_dispatch = ensure_id(selected_dispatch_value, "--dispatch-id")
    open_dispatches: List[Path] = []
    stall_budget_values: List[int] = []
    for dispatch_dir in dispatches:
        dispatch_record = load_dispatch_record(root, attempt_dir, dispatch_dir)
        inventory = regular_file_inventory(
            dispatch_dir / "artifacts", label=f"dispatch {dispatch_dir.name} allowed-writes root"
        )
        stall = load_dispatch_stall(root, attempt_dir, dispatch_dir, dispatch_record)
        if stall is not None:
            stall_budget_values.append(int(stall["budget"]["zero_file_stalls_used"]))
            if inventory:
                marker = mark_attempt_terminal_invalid(
                    attempt_dir,
                    "LATE_WRITE_CONTAMINATION",
                    {
                        "dispatch_id": dispatch_dir.name,
                        "stalled_allowed_writes_root": dispatch_record.get("allowed_writes_root"),
                        "late_files": inventory,
                    },
                )
                raise LoopCtlError(
                    f"LATE_WRITE_CONTAMINATION：已记录 zero-file stall 的 {dispatch_dir.name} "
                    f"后来出现 {len(inventory)} 个文件，整个 attempt 永久失效；incident={marker}"
                )
            if stall.get("state") == "BUDGET_EXHAUSTED":
                raise LoopCtlError("runtime dispatch budget 已封存为 BUDGET_EXHAUSTED，attempt 不得封存内容")
        else:
            open_dispatches.append(dispatch_dir)
    if sorted(stall_budget_values) != list(range(1, len(stall_budget_values) + 1)):
        raise LoopCtlError("dispatch stall budget 计数不连续")
    selected_dir = attempt_dir / "dispatches" / selected_dispatch
    if selected_dir not in open_dispatches:
        raise LoopCtlError(f"--dispatch-id 不是当前可封存 dispatch：{selected_dispatch}")
    if len(open_dispatches) != 1:
        raise LoopCtlError("同一 attempt 必须恰好有一个未 stall 的 dispatch")
    selected_root = selected_dir / "artifacts"
    selected_inventory = regular_file_inventory(
        selected_root, label=f"dispatch {selected_dispatch} allowed-writes root"
    )
    if not selected_inventory:
        raise LoopCtlError(
            "ZERO_FILE_DISPATCH_STALL：selected dispatch 内普通文件数精确为 0；"
            "不得封存或消耗 content attempt，请先运行 record-dispatch-stall"
        )
    return selected_dispatch, selected_root, selected_inventory


def verify_attempt_controller_facts(
    root: Path,
    attempt_dir: Path,
    artifact_root: Path,
    governed_artifacts: Sequence[Mapping[str, Any]],
) -> List[str]:
    chain = controller_facts_chain_state(root, attempt_dir)
    governed_sources = {
        (artifact_root / str(entry.get("path"))).resolve()
        for entry in governed_artifacts
        if isinstance(entry.get("path"), str)
    }
    active_by_source = chain["active_by_source"]
    for source_relative, active in sorted(active_by_source.items()):
        source_path = active["source_path"]
        if source_path.resolve() not in governed_sources:
            raise LoopCtlError(
                f"UNBOUND_CONTROLLER_FACTS：source 不属于本次 selected artifact inventory：{source_relative}"
            )

    verified: List[str] = []
    for source_relative, active in sorted(active_by_source.items()):
        facts_path = active["path"]
        facts = active["facts"]
        source_path = active["source_path"]
        if not source_path.is_file():
            raise LoopCtlError(
                f"STALE_CONTROLLER_FACTS：源文件不存在：{source_relative}；"
                "恢复或重新生成作品后，请改用新的 --output 路径运行 measure-artifact"
            )
        source_bytes = source_path.read_bytes()
        try:
            text = source_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise LoopCtlError(
                f"STALE_CONTROLLER_FACTS：源文件不再是 UTF-8：{source_relative}；"
                "修复为 UTF-8 后，请改用新的 --output 路径运行 measure-artifact"
            ) from exc
        expected_source = {
            "path": source_path.relative_to(root).as_posix(),
            "sha256": sha256_bytes(source_bytes),
            "bytes": len(source_bytes),
            "encoding": "UTF-8",
        }
        expected_whole = {
            "line_count": len(text.splitlines()),
            "unicode_codepoint_count": len(text),
            "unicode_han_count": unicode_han_count(text),
            "unicode_han_metric_version": HAN_METRIC_VERSION,
        }
        scope = facts["scope"]
        expected_scoped = scoped_text_metrics(text, scope == "exclude-first-markdown-h1")
        if (
            facts.get("source") != expected_source
            or facts.get("whole_file_metrics") != expected_whole
            or facts.get("scope") != expected_scoped["scope"]
            or facts.get("excluded_first_markdown_h1")
            != expected_scoped["excluded_first_markdown_h1"]
            or facts.get("metrics") != expected_scoped["metrics"]
        ):
            raise LoopCtlError(
                f"STALE_CONTROLLER_FACTS：facts 与当前源文件不一致：{facts_path.relative_to(root)}；"
                "请改用新的 --output 路径重新运行 measure-artifact，成功后再运行 open-human-review"
            )
        authority = facts.get("authority")
        if not isinstance(authority, dict) or authority.get("mechanical_fields_governing") is not True:
            raise LoopCtlError(f"ControllerArtifactFacts.authority 无效：{facts_path}")
        if authority.get("producer_self_report_governing") is not False:
            raise LoopCtlError(f"Producer 自报不得成为 governing facts：{facts_path}")
        verified.append(facts_path.relative_to(root).as_posix())
    return verified


def attempt_content_inventory(attempt_dir: Path) -> List[Dict[str, Any]]:
    return [
        entry
        for entry in regular_file_inventory(attempt_dir, label="attempt")
        if entry.get("path") not in {"manifest.json", ".sealed.json"}
    ]


def assert_attempt_commit_stable(
    root: Path,
    attempt_dir: Path,
    dispatch_id: Optional[str],
    expected_dispatch: Optional[str],
    expected_artifact_root: Path,
    expected_artifacts: Sequence[Mapping[str, Any]],
    expected_facts: Sequence[str],
    expected_content_inventory: Sequence[Mapping[str, Any]],
) -> None:
    current_dispatch, current_artifact_root, current_artifacts = governing_artifacts_for_seal(
        root, attempt_dir, dispatch_id
    )
    current_facts = verify_attempt_controller_facts(
        root, attempt_dir, current_artifact_root, current_artifacts
    )
    current_content_inventory = attempt_content_inventory(attempt_dir)
    if (
        current_dispatch != expected_dispatch
        or current_artifact_root != expected_artifact_root
        or current_artifacts != list(expected_artifacts)
        or current_facts != list(expected_facts)
        or current_content_inventory != list(expected_content_inventory)
    ):
        marker = mark_attempt_terminal_invalid(
            attempt_dir,
            "ATTEMPT_CHANGED_DURING_COMMIT",
            {
                "expected_dispatch": expected_dispatch,
                "current_dispatch": current_dispatch,
                "expected_content_inventory": list(expected_content_inventory),
                "current_content_inventory": current_content_inventory,
            },
        )
        raise LoopCtlError(
            "ATTEMPT_CHANGED_DURING_COMMIT：seal commit 窗口内出现写入；"
            f"attempt 永久失效且不消耗 content attempt；incident={marker}"
        )


def command_seal_attempt(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    run_id = ensure_id(args.run_id, "--run-id")
    with exclusive_controller_lock(root):
        run_dir = root / "creative-system" / "runs" / run_id
        guard_project_directory(root, run_dir, "run root")
        guard_project_directory(root, run_dir / "control", "run control", allow_missing=True)
        run = load_json(run_dir / "run.json")
        if not isinstance(run, dict):
            raise LoopCtlError("run.json 无效")
        attempt_id = args.attempt_id or run.get("current_attempt")
        if attempt_id is None and isinstance(run.get("attempts"), list) and run["attempts"]:
            attempt_id = run["attempts"][-1]
        if not isinstance(attempt_id, str) or not re.fullmatch(r"attempt-[0-9]{3}", attempt_id):
            raise LoopCtlError("--attempt-id 无效")
        attempt_dir = run_dir / "attempts" / attempt_id
        guard_project_directory(root, attempt_dir, "attempt root")
        ensure_attempt_not_terminal_invalid(attempt_dir)
        return command_seal_attempt_locked(args, root, run_id, attempt_id)


def command_seal_attempt_locked(
    args: argparse.Namespace, root: Path, expected_run_id: str, expected_attempt_id: str
) -> Dict[str, Any]:
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("项目合同或历史证据未通过：" + "; ".join(validation["errors"]))
    run_id = ensure_id(args.run_id, "--run-id")
    if run_id != expected_run_id:
        raise LoopCtlError("run 在获取控制器锁期间发生变化")
    run_dir = root / "creative-system" / "runs" / run_id
    run_path = run_dir / "run.json"
    run = load_json(run_path)
    if not isinstance(run, dict):
        raise LoopCtlError("run.json 无效")
    attempt_id = args.attempt_id or run.get("current_attempt")
    if attempt_id is None and isinstance(run.get("attempts"), list) and run["attempts"]:
        attempt_id = run["attempts"][-1]
    if not isinstance(attempt_id, str) or not re.fullmatch(r"attempt-[0-9]{3}", attempt_id):
        raise LoopCtlError("--attempt-id 无效")
    if attempt_id != expected_attempt_id:
        raise LoopCtlError("attempt 在获取控制器锁期间发生变化")
    attempt_dir = run_dir / "attempts" / attempt_id
    if not (attempt_dir / "attempt.json").is_file():
        raise LoopCtlError(f"attempt 不存在：{attempt_dir}")
    if (attempt_dir / ".sealed.json").exists():
        raise LoopCtlError(f"attempt 已封存，拒绝覆盖：{attempt_id}")
    ensure_attempt_not_terminal_invalid(attempt_dir)

    phase = run.get("run_phase", "bootstrap")
    if phase not in {"bootstrap", "post-l4"}:
        raise LoopCtlError("run_phase 无效")
    if phase == "post-l4":
        if run.get("provable_maturity_at_start") != "L4" or run.get("active_version_at_start") in {
            None,
            "",
            "baseline-v1",
        }:
            raise LoopCtlError("post-l4 run 缺少可信的 L4 起点快照")
        current_audit = audit_project(root)
        current_system = load_system(root)
        current_active = current_system.get("project", {}).get("active_version")
        if current_audit.get("provable_maturity") != "L4":
            raise LoopCtlError("post-l4 attempt 封存时系统已不再能证明 L4")
        if current_active != run.get("active_version_at_start"):
            raise LoopCtlError("post-l4 attempt 运行期间 active version 已改变")

    human_accepted = bool_choice(args.human_accepted)
    improved = bool_choice(args.improved)
    sealed_at = utc_now()
    if args.release_status == "PASS":
        if args.execution_status != "PASS" or args.quality_status != "PASS" or human_accepted is not True:
            raise LoopCtlError("release PASS 需要 execution PASS、quality PASS 和明确人工认可")
    if args.quality_status == "NEEDS_TASTE" and args.release_status == "PASS":
        raise LoopCtlError("NEEDS_TASTE 不得发布")

    loop = find_loop(root, str(run.get("loop_id")))
    attempt_number = int(attempt_id.rsplit("-", 1)[1])
    if args.decision == "revise" and attempt_number >= int(loop.get("retry_budget", {}).get("max_attempts", 0)):
        raise LoopCtlError("retry budget 已耗尽，decision 不能继续 revise")
    previous_manifests = [
        load_json(path)
        for path in sorted((run_dir / "attempts").glob("*/manifest.json"))
        if path.parent.name != attempt_id and (path.parent / ".sealed.json").is_file()
    ]
    if (
        args.decision == "revise"
        and improved is False
        and previous_manifests
        and previous_manifests[-1].get("improved") is False
    ):
        raise LoopCtlError("连续两次无改善，必须 stop 或 escalate")

    selected_dispatch, artifact_root, governed_artifacts = governing_artifacts_for_seal(
        root, attempt_dir, args.dispatch_id
    )
    verified_controller_facts = verify_attempt_controller_facts(
        root, attempt_dir, artifact_root, governed_artifacts
    )

    findings: List[Dict[str, Any]] = []
    findings_dir = attempt_dir / "findings"
    if args.finding:
        guarded_mkdir_project(root, findings_dir, "attempt findings root")
    for index, raw_path in enumerate(args.finding or [], start=1):
        source = Path(raw_path).expanduser().resolve()
        finding = validate_finding(load_json(source), str(source))
        findings.append(finding)
        finding_name = f"{index:03d}-{str(finding['code']).lower().replace('_', '-')}.json"
        atomic_write_json(findings_dir / finding_name, finding)

    evidence_paths: List[str] = []
    for relative in args.evidence or []:
        evidence_path = safe_relative(root, relative, "--evidence")
        reject_symlink_components(root, relative, "--evidence")
        if not evidence_path.exists():
            raise LoopCtlError(f"证据路径不存在：{relative}")
        evidence_paths.append(Path(relative).as_posix())

    human_feedback_receipt = snapshot_human_feedback(
        root,
        attempt_dir,
        args,
        human_accepted=human_accepted,
        sealed_at=sealed_at,
        loop_id=str(run.get("loop_id")),
    )
    file_entries = attempt_content_inventory(attempt_dir)
    final_dispatch, final_artifact_root, final_governed_artifacts = governing_artifacts_for_seal(
        root, attempt_dir, args.dispatch_id
    )
    final_verified_controller_facts = verify_attempt_controller_facts(
        root, attempt_dir, final_artifact_root, final_governed_artifacts
    )
    if (
        final_dispatch != selected_dispatch
        or final_artifact_root != artifact_root
        or final_governed_artifacts != governed_artifacts
        or final_verified_controller_facts != verified_controller_facts
    ):
        raise LoopCtlError("ATTEMPT_CHANGED_DURING_SEAL：请停止写入后重新封存")
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "kind": "AttemptManifest",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "loop_id": run.get("loop_id"),
        "task": run.get("task"),
        "real_run": bool(run.get("real_run", True)),
        "active_version_at_start": run.get("active_version_at_start"),
        "provable_maturity_at_start": run.get("provable_maturity_at_start"),
        "run_phase": phase,
        "post_l4_iteration_index": run.get("post_l4_iteration_index"),
        "sealed_at": sealed_at,
        "execution_status": args.execution_status,
        "quality_status": args.quality_status,
        "release_status": args.release_status,
        "decision": args.decision,
        "human_accepted": human_accepted,
        "machine_direction": args.machine_direction,
        "human_direction": args.human_direction,
        "human_feedback_receipt": human_feedback_receipt,
        "improved": improved,
        "stop_reason": args.stop_reason,
        "hard_contract_false_pass": bool(args.hard_contract_false_pass),
        "recovery_exercised": bool(args.recovery_exercised),
        "local_recovery_preserved_upstream": bool(args.local_recovery_preserved_upstream),
        "end_to_end_no_regression": bool(args.end_to_end_no_regression),
        "resolved_observed_problem": bool(args.resolved_observed_problem),
        "dispatch_id": selected_dispatch,
        "artifact_root": artifact_root.relative_to(attempt_dir).as_posix(),
        "artifact_file_count": len(governed_artifacts),
        "artifact_files": governed_artifacts,
        "verified_controller_facts": verified_controller_facts,
        "evidence_paths": evidence_paths,
        "findings": findings,
        "files": file_entries,
    }
    feedback_errors = validate_human_feedback_receipt(root, attempt_dir, manifest)
    if feedback_errors:
        raise LoopCtlError("人工反馈凭证未通过封存前验证：" + "; ".join(feedback_errors))
    manifest_path = attempt_dir / "manifest.json"
    atomic_create_json(manifest_path, manifest)
    atomic_create_json(
        attempt_dir / ".sealed.json",
        {
            "kind": "SealedAttempt",
            "manifest_sha256": sha256_file(manifest_path),
            "sealed_at": manifest["sealed_at"],
        },
    )
    assert_attempt_commit_stable(
        root,
        attempt_dir,
        args.dispatch_id,
        selected_dispatch,
        artifact_root,
        governed_artifacts,
        verified_controller_facts,
        file_entries,
    )
    run_before_commit = json.loads(json.dumps(run))
    run.setdefault("attempts", []).append(attempt_id)
    run["current_attempt"] = None
    run["execution_status"] = args.execution_status
    run["quality_status"] = args.quality_status
    run["release_status"] = args.release_status
    run["last_decision"] = args.decision
    atomic_write_json(run_path, run)
    try:
        assert_attempt_commit_stable(
            root,
            attempt_dir,
            args.dispatch_id,
            selected_dispatch,
            artifact_root,
            governed_artifacts,
            verified_controller_facts,
            file_entries,
        )
        feedback_errors = validate_human_feedback_receipt(root, attempt_dir, manifest)
        if feedback_errors:
            raise LoopCtlError(
                "人工反馈 subject/anchor 在提交窗口内发生变化："
                + "; ".join(feedback_errors)
            )
    except LoopCtlError:
        atomic_write_json(run_path, run_before_commit)
        raise

    if findings:
        index_records = [
            {
                "run_id": run_id,
                "attempt_id": attempt_id,
                "code": finding["code"],
                "category": finding["category"],
                "manifest": manifest_path.relative_to(root).as_posix(),
            }
            for finding in findings
        ]
        finding_index = root / "creative-system" / "memory" / "finding-index.jsonl"
        guard_project_file_target(root, finding_index, "finding index")
        append_jsonl_atomic(finding_index, index_records)

    system = load_system(root)
    system["statuses"] = {
        "execution_status": args.execution_status,
        "quality_status": args.quality_status,
        "release_status": args.release_status,
    }
    atomic_write_json(system_path(root), system)
    return {
        "status": "PASS",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "manifest": manifest_path.relative_to(root).as_posix(),
        "manifest_sha256": sha256_file(manifest_path),
        "next_step": "运行 audit；如需修订，使用同一 run-id 再次 begin-run",
    }


def finding_occurrences(root: Path, code: str) -> List[Dict[str, Any]]:
    matches: List[Dict[str, Any]] = []
    for manifest in sealed_manifests(root):
        if manifest.get("real_run") is not True:
            continue
        for finding in manifest.get("findings", []):
            if isinstance(finding, dict) and str(finding.get("code", "")).casefold() == code.casefold():
                matches.append(
                    {
                        "run_id": manifest.get("run_id"),
                        "attempt_id": manifest.get("attempt_id"),
                        "task": manifest.get("task"),
                        "manifest": manifest.get("_manifest_path"),
                        "finding": finding,
                    }
                )
    return matches


def finding_source_producer_context_ids(
    root: Path, matches: Sequence[Mapping[str, Any]]
) -> List[str]:
    context_ids: Set[str] = set()
    for match in matches:
        run_id = match.get("run_id")
        attempt_id = match.get("attempt_id")
        if not isinstance(run_id, str) or not isinstance(attempt_id, str):
            continue
        attempt_dir = root / "creative-system" / "runs" / run_id / "attempts" / attempt_id
        if not (attempt_dir / ".sealed.json").is_file():
            continue
        for dispatch_dir in dispatch_directories(attempt_dir):
            record = load_dispatch_record(root, attempt_dir, dispatch_dir)
            context_ids.add(str(record["context_id"]))
    return sorted(context_ids)


def normalized_change_path(root: Path, value: str) -> str:
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts or not candidate.parts:
        raise LoopCtlError(f"候选修改路径必须是项目内相对路径：{value!r}")
    safe_relative(root, value, "候选修改路径")
    return candidate.as_posix().lstrip("./")


def path_is_protected(value: str, protected: Iterable[str]) -> bool:
    folded_parts = {part.casefold() for part in Path(value).parts}
    folded_value = value.casefold().strip("/")
    for raw in protected:
        item = str(raw).casefold().strip("/")
        if _surface_overlap(value, str(raw)):
            return True
        if "/" not in item and (item in folded_parts or item in folded_value):
            return True
    return False


def validate_builder_input_boundary(value: Any) -> List[str]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or item not in BUILDER_INPUT_BOUNDARIES for item in value
    ):
        raise LoopCtlError("candidate Builder input_boundary 无效")
    if len(value) != len(set(value)):
        raise LoopCtlError("candidate Builder input_boundary 不得重复")
    boundary = set(value)
    missing = BUILDER_REQUIRED_INPUTS - boundary
    forbidden = BUILDER_FORBIDDEN_INPUTS.intersection(boundary)
    if missing:
        raise LoopCtlError(
            "candidate Builder input_boundary 缺少：" + ", ".join(sorted(missing))
        )
    if forbidden:
        raise LoopCtlError(
            "candidate Builder input_boundary 含禁止项：" + ", ".join(sorted(forbidden))
        )
    return sorted(boundary)


def command_create_candidate(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    with exclusive_controller_lock(root):
        return command_create_candidate_locked(args, root)


def command_create_candidate_locked(
    args: argparse.Namespace, root: Path
) -> Dict[str, Any]:
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("validate 未通过：" + "; ".join(validation["errors"]))
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    code = args.finding_code.upper()
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{2,80}", code):
        raise LoopCtlError("--finding-code 必须是稳定大写代码")
    target_component = args.target_component
    if target_component not in L4_TARGETS | L5_TARGETS:
        raise LoopCtlError(f"不支持的 target component：{target_component}")
    level = "L5" if target_component in L5_TARGETS else "L4"
    if args.level and args.level != level:
        raise LoopCtlError(f"target component {target_component} 只能建立 {level} 候选")
    if args.budget <= 0:
        raise LoopCtlError("--budget 必须是正整数")
    if level == "L4" and args.budget != 3:
        raise LoopCtlError("v0.1 的 L4 候选必须使用 selection-safe exact-three eval budget=3")
    builder_role_id = ensure_id(args.builder_role_id, "--builder-role-id")
    builder_context_id = single_line(args.builder_context_id, "--builder-context-id", maximum=300)
    builder_task_id = single_line(args.builder_task_id, "--builder-task-id", maximum=300)
    builder_attested_by = single_line(args.builder_attested_by, "--builder-attested-by", maximum=300)
    builder_input_boundary = validate_builder_input_boundary(args.builder_input_boundary)
    if builder_attested_by.casefold() in {
        builder_role_id.casefold(),
        builder_context_id.casefold(),
        builder_task_id.casefold(),
    }:
        raise LoopCtlError("candidate Builder receipt 必须由不同的 orchestrator identity 证明")

    system = load_system(root)
    producer_role_ids = project_producer_role_ids(root)
    if builder_role_id.casefold() in producer_role_ids:
        raise LoopCtlError("candidate Builder role 与 Producer role 相同，不构成独立候选构建")
    if builder_attested_by.casefold() in producer_role_ids:
        raise LoopCtlError("candidate Builder attester 不得是已知 Producer role")
    protected = [str(item) for item in system.get("protected_surfaces", [])]
    editable = {str(item) for item in system.get("editable_surfaces", [])}
    if level == "L4" and target_component not in editable:
        raise LoopCtlError(f"当前系统没有开放该 L4 修改面：{target_component}")
    changed_paths = [normalized_change_path(root, value) for value in args.changed_path]
    if not changed_paths:
        raise LoopCtlError("至少提供一个 --changed-path")
    for value in changed_paths:
        if path_is_protected(value, protected):
            raise LoopCtlError(f"候选不得修改受保护表面：{value}")

    matches = finding_occurrences(root, code)
    independent_runs = sorted({str(item.get("run_id")) for item in matches if item.get("run_id")})
    independent_tasks = sorted({str(item.get("task")) for item in matches if item.get("task")})
    minimum = int(system.get("learning_policy", {}).get("minimum_independent_runs", 3))
    if len(independent_runs) < minimum or len(independent_tasks) < minimum:
        raise LoopCtlError(
            f"重复 finding 必须来自至少 {minimum} 次独立真实 run/任务；"
            f"当前 run={len(independent_runs)}、任务={len(independent_tasks)}"
        )
    producer_context_ids = finding_source_producer_context_ids(root, matches)
    producer_context_keys = {value.casefold() for value in producer_context_ids}
    if (
        builder_context_id.casefold() in producer_context_keys
        or builder_task_id.casefold() in producer_context_keys
    ):
        raise LoopCtlError("candidate Builder context/task 与 finding 来源 Producer context 重合")
    if builder_attested_by.casefold() in producer_context_keys:
        raise LoopCtlError("candidate Builder attester 不得复用 finding 来源 Producer context")

    evaluation_plan: Dict[str, Any]
    if args.evaluation_plan:
        raw_plan = load_json(Path(args.evaluation_plan).expanduser().resolve())
        if not isinstance(raw_plan, dict):
            raise LoopCtlError("--evaluation-plan 顶层必须是对象")
        evaluation_plan = raw_plan
    else:
        evaluation_plan = {
            "targeted": {"goal": "解决 finding cluster 指向的目标问题", "status": "NOT_RUN"},
            "regression": {"goal": "确认硬合同及已有能力无阻断性退化", "status": "NOT_RUN"},
            "heldout": {"goal": "在隔离且盲评条件下不劣于基线", "status": "NOT_RUN"},
            "human_approval": {"required": True, "status": "MISSING"},
            "external_meta_evaluation": {"required": level == "L5", "status": "NOT_RUN"},
        }

    candidate_root = root / "creative-system" / "candidates" / candidate_id
    guard_project_directory(root, candidate_root.parent, "candidates root")
    guard_project_directory(root, candidate_root, "candidate root", allow_missing=True)
    if os.path.lexists(str(candidate_root)):
        raise LoopCtlError(f"候选已存在，拒绝覆盖：{candidate_id}")
    candidates_parent = candidate_root.parent
    candidates_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{candidate_id}.candidate-", dir=str(candidates_parent)))
    try:
        proposal = {
            "schema_version": SCHEMA_VERSION,
            "kind": "LearningProposal",
            "id": candidate_id,
            "level": level,
            "status": "CANDIDATE",
            "created_at": utc_now(),
            "builder_receipt": {
                "role_id": builder_role_id,
                "context_id": builder_context_id,
                "task_id": builder_task_id,
                "attested_by": builder_attested_by,
                "input_boundary": builder_input_boundary,
                "recorded_at": utc_now(),
                "identity_authentication": "external-attestation-not-controller-verified",
                "controller_frozen_at_creation": True,
            },
            "producer_execution_boundary": {
                "source_run_ids": independent_runs,
                "controller_recorded_context_ids": producer_context_ids,
                "controller_recorded_task_ids": [],
                "task_identity_coverage": "external-attestation-required",
                "controller_frozen_at_creation": True,
            },
            "finding_cluster": {
                "code": code,
                "independent_runs": independent_runs,
                "independent_tasks": independent_tasks,
                "evidence": matches,
            },
            "root_cause_hypothesis": args.root_cause,
            "target_component": target_component,
            "candidate_change": {
                "description": args.change_summary,
                "changed_paths": changed_paths,
            },
            "protected_constraints": protected,
            "evaluation_matrix": evaluation_plan,
            "budget": {"max_evaluation_runs": args.budget},
            "rollback_plan": {
                "previous_version": system.get("project", {}).get("active_version"),
                "action": "restore-active-version-pointer-and-retain-all-evidence",
            },
        }
        proposal_path = staging / "proposal.json"
        atomic_write_json(proposal_path, proposal)
        atomic_write_json(staging / "eval-plan.json", evaluation_plan)
        atomic_write_json(
            staging / "status.json",
            {
                "status": "CANDIDATE",
                "level": level,
                "proposal_sha256": sha256_file(proposal_path),
                "automatic_promotion_allowed": False,
            },
        )
        (staging / "changes").mkdir()
        (staging / "evidence").mkdir()
        os.replace(str(staging), str(candidate_root))
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return {
        "status": "CANDIDATE",
        "candidate_id": candidate_id,
        "level": level,
        "proposal": (candidate_root / "proposal.json").relative_to(root).as_posix(),
        "next_step": (
            "完成目标评估、全量回归、held-out 盲评和人工批准"
            if level == "L4"
            else "交给外部元评价；v0.1 不提供 L5 晋升"
        ),
    }


def load_candidate(root: Path, candidate_id: str) -> Tuple[Path, Dict[str, Any], Dict[str, Any]]:
    candidate_root = root / "creative-system" / "candidates" / candidate_id
    proposal_path = candidate_root / "proposal.json"
    status_path = candidate_root / "status.json"
    for path, label in (
        (candidate_root, "candidate root"),
        (proposal_path, "candidate proposal"),
        (status_path, "candidate status"),
    ):
        relative = path.relative_to(root).as_posix()
        reject_symlink_components(root, relative, label)
    if not candidate_root.is_dir():
        raise LoopCtlError(f"候选目录不存在或无效：{candidate_id}")
    proposal = load_json(proposal_path)
    status = load_json(status_path)
    if not isinstance(proposal, dict) or proposal.get("kind") != "LearningProposal":
        raise LoopCtlError(f"候选 proposal 无效：{candidate_id}")
    if not isinstance(status, dict):
        raise LoopCtlError(f"候选 status 无效：{candidate_id}")
    if status.get("proposal_sha256") != sha256_file(proposal_path):
        raise LoopCtlError("候选 proposal 已在创建后被改写；请创建新候选")
    block_path = candidate_root / "block-seal.json"
    if block_path.is_symlink():
        raise LoopCtlError(f"候选 block-seal 不允许是符号链接：{candidate_id}")
    if block_path.is_file():
        block = load_json(block_path)
        if (
            not isinstance(block, dict)
            or block.get("kind") != "CandidateBlockSeal"
            or block.get("state") != "BLOCK_SEALED"
            or block.get("candidate_id") != candidate_id
            or block.get("proposal_sha256") != sha256_file(proposal_path)
            or block.get("promotion_eligible") is not False
            or block.get("successor_candidate_required") is not True
            or not isinstance(block.get("evidence"), list)
            or not block.get("evidence")
        ):
            raise LoopCtlError(f"候选 block-seal 无效：{candidate_id}")
        for entry in block["evidence"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                raise LoopCtlError(f"候选 block-seal evidence 无效：{candidate_id}")
            evidence_path = safe_relative(root, entry["path"], "block-seal evidence")
            reject_symlink_components(root, entry["path"], "block-seal evidence")
            if (
                not evidence_path.is_file()
                or entry.get("sha256") != sha256_file(evidence_path)
                or entry.get("bytes") != evidence_path.stat().st_size
            ):
                raise LoopCtlError(f"候选 block-seal evidence 已改变：{entry['path']}")
        status = dict(status)
        status.update(
            {
                "status": "BLOCKED",
                "blocked_at": block.get("sealed_at"),
                "block_seal": block_path.relative_to(root).as_posix(),
                "block_seal_sha256": sha256_file(block_path),
                "automatic_promotion_allowed": False,
            }
        )
    elif status.get("status") == "BLOCKED" or status.get("block_seal_sha256"):
        raise LoopCtlError(f"BLOCKED 候选缺少 block-seal：{candidate_id}")
    return candidate_root, proposal, status


def verify_candidate_changes(root: Path, candidate_root: Path, proposal: Mapping[str, Any]) -> Dict[str, str]:
    protected = [str(item) for item in proposal.get("protected_constraints", [])]
    declared = set(proposal.get("candidate_change", {}).get("changed_paths", []))
    for value in declared:
        normalized = normalized_change_path(root, str(value))
        if path_is_protected(normalized, protected):
            raise LoopCtlError(f"候选声明触及受保护表面：{normalized}")
    changes_root = candidate_root / "changes"
    hashes: Dict[str, str] = {}
    changes_relative = changes_root.relative_to(root).as_posix()
    reject_symlink_components(root, changes_relative, "candidate changes root")
    if not os.path.lexists(str(changes_root)):
        return hashes
    if changes_root.is_symlink() or not changes_root.is_dir():
        raise LoopCtlError("candidate changes root 必须是项目内普通目录")
    for path in sorted(changes_root.rglob("*")):
        if path.is_symlink():
            raise LoopCtlError(f"候选 changes 不允许符号链接：{path}")
        if path.is_file():
            relative = path.relative_to(changes_root).as_posix()
            if path_is_protected(relative, protected):
                raise LoopCtlError(f"候选实际文件触及受保护表面：{relative}")
            if not any(_surface_overlap(relative, str(item)) for item in declared):
                raise LoopCtlError(f"候选实际文件不在 proposal.changed_paths 中：{relative}")
            hashes[relative] = sha256_file(path)
    if not hashes:
        raise LoopCtlError("候选 changes 为空；无法晋升一个没有可复核改动的候选")
    return hashes


def candidate_eval_run_root(candidate_root: Path, eval_run_id: str) -> Path:
    return candidate_root / "evaluations" / eval_run_id


def eval_open_anchor_path(candidate_root: Path, eval_run_id: str) -> Path:
    return candidate_root / "control" / "eval-open-anchors" / f"{eval_run_id}.json"


def eval_terminal_invalid_path(candidate_root: Path, eval_run_id: str) -> Path:
    return candidate_root / "control" / "eval-terminal-invalid" / f"{eval_run_id}.json"


def ensure_eval_not_terminal_invalid(candidate_root: Path, eval_run_id: str) -> None:
    marker = eval_terminal_invalid_path(candidate_root, eval_run_id)
    for path in (
        candidate_root / "control",
        candidate_root / "control" / "eval-terminal-invalid",
        marker,
    ):
        if path.is_symlink():
            raise LoopCtlError(f"eval terminal control path 不允许符号链接：{path}")
    if marker.is_file():
        incident = load_json(marker)
        reason = incident.get("reason_code", "EVAL_TERMINAL_INVALID") if isinstance(incident, dict) else "EVAL_TERMINAL_INVALID"
        raise LoopCtlError(
            f"{reason}：eval run 已永久失效；v0.1 exact-three 要求建立 successor candidate"
        )


def mark_eval_terminal_invalid(
    root: Path,
    candidate_root: Path,
    candidate_id: str,
    eval_run_id: str,
    reason_code: str,
    evidence: Mapping[str, Any],
) -> Path:
    ensure_candidate_eval_paths_safe(root, candidate_root)
    marker = eval_terminal_invalid_path(candidate_root, eval_run_id)
    if marker.exists():
        ensure_eval_not_terminal_invalid(candidate_root, eval_run_id)
    atomic_create_json(
        marker,
        {
            "schema_version": SCHEMA_VERSION,
            "kind": "TerminalEvalIncident",
            "state": "TERMINAL_INVALID",
            "reason_code": reason_code,
            "candidate_id": candidate_id,
            "eval_run_id": eval_run_id,
            "recorded_at": utc_now(),
            "successor_candidate_required": True,
            "evidence": dict(evidence),
        },
    )
    return marker.relative_to(root)


def verify_eval_open_anchor(
    root: Path,
    candidate_root: Path,
    candidate_id: str,
    proposal: Mapping[str, Any],
    eval_run_id: str,
    preflight_path: Path,
) -> Dict[str, Any]:
    anchor_path = eval_open_anchor_path(candidate_root, eval_run_id)
    for path, label in (
        (preflight_path, "eval preflight"),
        (anchor_path, "eval open anchor"),
    ):
        relative = path.relative_to(root).as_posix()
        reject_symlink_components(root, relative, label)
    preflight = load_json(preflight_path)
    anchor = load_json(anchor_path)
    receipt = preflight.get("execution_receipt") if isinstance(preflight, dict) else None
    receipt_hash = sha256_bytes(canonical_json_bytes(receipt))
    budget = proposal.get("budget", {}).get("max_evaluation_runs")
    if not isinstance(budget, int) or isinstance(budget, bool) or budget <= 0:
        raise LoopCtlError("候选 max_evaluation_runs 无效")
    current_change_hashes = verify_candidate_changes(root, candidate_root, proposal)
    expected_preflight = preflight_path.relative_to(root).as_posix()
    if (
        not isinstance(anchor, dict)
        or anchor.get("kind") != "EvalRunOpenAnchor"
        or anchor.get("state") != "OPEN_ANCHORED"
        or anchor.get("candidate_id") != candidate_id
        or anchor.get("proposal_sha256") != sha256_file(candidate_root / "proposal.json")
        or anchor.get("eval_run_id") != eval_run_id
        or anchor.get("phase") != preflight.get("phase")
        or anchor.get("preflight_path") != expected_preflight
        or anchor.get("preflight_sha256") != sha256_file(preflight_path)
        or anchor.get("execution_receipt_sha256") != receipt_hash
        or preflight.get("execution_receipt_sha256") != receipt_hash
        or anchor.get("candidate_change_hashes") != current_change_hashes
        or preflight.get("candidate_change_hashes") != current_change_hashes
        or anchor.get("evaluation_run_index") != preflight.get("evaluation_run_index")
        or anchor.get("max_evaluation_runs") != preflight.get("max_evaluation_runs")
        or anchor.get("max_evaluation_runs") != budget
        or not isinstance(anchor.get("evaluation_run_index"), int)
        or isinstance(anchor.get("evaluation_run_index"), bool)
        or not 1 <= anchor.get("evaluation_run_index") <= budget
    ):
        raise LoopCtlError(f"eval open anchor 与开跑 preflight/receipt 不一致：{eval_run_id}")
    return {
        "anchor": anchor,
        "anchor_path": anchor_path.relative_to(root).as_posix(),
        "anchor_sha256": sha256_file(anchor_path),
        "receipt_sha256": receipt_hash,
    }


def controller_eval_open_ledger(
    root: Path,
    candidate_root: Path,
    candidate_id: str,
    proposal: Mapping[str, Any],
    *,
    require_anchored: bool,
) -> List[Dict[str, Any]]:
    ensure_candidate_eval_paths_safe(root, candidate_root)
    evaluations_root = candidate_root / "evaluations"
    run_ids: Set[str] = set()
    if evaluations_root.is_dir():
        for child in evaluations_root.iterdir():
            if child.is_symlink():
                raise LoopCtlError(f"eval run 不允许符号链接：{child}")
            if child.is_dir() and (child / "preflight.json").exists():
                run_ids.add(child.name)
    anchors_root = candidate_root / "control" / "eval-open-anchors"
    if anchors_root.is_dir():
        for path in anchors_root.glob("*.json"):
            if path.is_symlink():
                raise LoopCtlError(f"eval open anchor 不允许符号链接：{path}")
            run_ids.add(path.stem)
    ledger: List[Dict[str, Any]] = []
    for eval_run_id in sorted(run_ids):
        ensure_id(eval_run_id, "eval ledger run id")
        preflight_path = candidate_eval_run_root(candidate_root, eval_run_id) / "preflight.json"
        anchor_path = eval_open_anchor_path(candidate_root, eval_run_id)
        if not preflight_path.is_file() or not anchor_path.is_file():
            if require_anchored:
                raise LoopCtlError(f"eval run 缺少成对 preflight/open anchor：{eval_run_id}")
            ledger.append({"eval_run_id": eval_run_id, "state": "PARTIAL_OPEN"})
            continue
        verified = verify_eval_open_anchor(
            root,
            candidate_root,
            candidate_id,
            proposal,
            eval_run_id,
            preflight_path,
        )
        preflight = load_json(preflight_path)
        terminal_marker = eval_terminal_invalid_path(candidate_root, eval_run_id)
        ledger.append(
            {
                "eval_run_id": eval_run_id,
                "phase": preflight.get("phase"),
                "evaluation_run_index": preflight.get("evaluation_run_index"),
                "anchor_path": verified["anchor_path"],
                "anchor_sha256": verified["anchor_sha256"],
                "terminal_invalid": terminal_marker.is_file(),
                "terminal_invalid_path": (
                    terminal_marker.relative_to(root).as_posix()
                    if terminal_marker.is_file()
                    else None
                ),
                "terminal_invalid_sha256": (
                    sha256_file(terminal_marker) if terminal_marker.is_file() else None
                ),
                "state": "OPEN_ANCHORED",
            }
        )
    indices = sorted(
        item.get("evaluation_run_index")
        for item in ledger
        if item.get("state") == "OPEN_ANCHORED"
    )
    if require_anchored and indices != list(range(1, len(ledger) + 1)):
        raise LoopCtlError("controller eval open ledger 的预算序号不连续")
    return ledger


def project_producer_role_ids(root: Path) -> Set[str]:
    system = load_system(root)
    roles: Set[str] = set()
    for loop_reference in system.get("loops", []):
        if not isinstance(loop_reference, str):
            continue
        loop = load_json(safe_relative(root, loop_reference, "Loop reference"))
        producer = loop.get("producer") if isinstance(loop, dict) else None
        role = producer.get("agent") if isinstance(producer, dict) else None
        if isinstance(role, str) and role:
            roles.add(role.casefold())
    return roles


def candidate_builder_receipt(proposal: Mapping[str, Any]) -> Dict[str, Any]:
    receipt = proposal.get("builder_receipt")
    if (
        not isinstance(receipt, dict)
        or not isinstance(receipt.get("role_id"), str)
        or not receipt.get("role_id")
        or not isinstance(receipt.get("context_id"), str)
        or not receipt.get("context_id")
        or not isinstance(receipt.get("task_id"), str)
        or not receipt.get("task_id")
        or not isinstance(receipt.get("attested_by"), str)
        or not receipt.get("attested_by")
        or not isinstance(receipt.get("input_boundary"), list)
        or receipt.get("identity_authentication")
        != "external-attestation-not-controller-verified"
        or receipt.get("controller_frozen_at_creation") is not True
    ):
        raise LoopCtlError("候选缺少 controller-frozen builder execution receipt；请创建新候选")
    ensure_id(receipt["role_id"], "builder_receipt.role_id")
    boundary = validate_builder_input_boundary(receipt["input_boundary"])
    if receipt["input_boundary"] != boundary:
        raise LoopCtlError("candidate Builder input_boundary 必须规范排序并在创建时冻结")
    builder_identities = {
        str(receipt["role_id"]).casefold(),
        str(receipt["context_id"]).casefold(),
        str(receipt["task_id"]).casefold(),
    }
    if str(receipt["attested_by"]).casefold() in builder_identities:
        raise LoopCtlError("candidate Builder receipt 必须由不同的 orchestrator identity 证明")
    return dict(receipt)


def candidate_producer_context_ids(proposal: Mapping[str, Any]) -> Set[str]:
    boundary = proposal.get("producer_execution_boundary")
    if (
        not isinstance(boundary, dict)
        or not isinstance(boundary.get("source_run_ids"), list)
        or not isinstance(boundary.get("controller_recorded_context_ids"), list)
        or boundary.get("controller_recorded_task_ids") != []
        or boundary.get("task_identity_coverage") != "external-attestation-required"
        or boundary.get("controller_frozen_at_creation") is not True
    ):
        raise LoopCtlError("候选缺少冻结的 Producer execution boundary")
    values = boundary["controller_recorded_context_ids"]
    if any(not isinstance(value, str) or not value for value in values) or values != sorted(set(values)):
        raise LoopCtlError("候选 Producer context ledger 无效")
    return {value.casefold() for value in values}


def validate_eval_execution_receipt(
    root: Path,
    proposal: Mapping[str, Any],
    phase: str,
    receipt: Any,
) -> Dict[str, Any]:
    if phase not in EVAL_REQUIRED_INPUTS:
        raise LoopCtlError(f"eval phase 无效：{phase}")
    if (
        not isinstance(receipt, dict)
        or not isinstance(receipt.get("role_id"), str)
        or not receipt.get("role_id")
        or not isinstance(receipt.get("context_id"), str)
        or not receipt.get("context_id")
        or not isinstance(receipt.get("task_id"), str)
        or not receipt.get("task_id")
        or not isinstance(receipt.get("attested_by"), str)
        or not receipt.get("attested_by")
        or not isinstance(receipt.get("input_boundary"), list)
        or receipt.get("identity_authentication")
        != "external-attestation-not-controller-verified"
        or receipt.get("controller_frozen_at_open") is not True
    ):
        raise LoopCtlError(f"{phase} eval 缺少 controller-frozen external execution receipt")
    role_id = ensure_id(receipt["role_id"], f"{phase}.execution_receipt.role_id")
    evaluator_identities = {
        role_id.casefold(),
        str(receipt["context_id"]).casefold(),
        str(receipt["task_id"]).casefold(),
    }
    if str(receipt["attested_by"]).casefold() in evaluator_identities:
        raise LoopCtlError(f"{phase} evaluator receipt 必须由不同的 orchestrator identity 证明")
    boundaries = receipt["input_boundary"]
    if (
        any(not isinstance(item, str) or item not in EVAL_INPUT_BOUNDARIES for item in boundaries)
        or len(boundaries) != len(set(boundaries))
    ):
        raise LoopCtlError(f"{phase} eval input_boundary 无效或重复")
    boundary_set = set(boundaries)
    missing = EVAL_REQUIRED_INPUTS[phase] - boundary_set
    forbidden = EVAL_FORBIDDEN_INPUTS.intersection(boundary_set)
    if missing:
        raise LoopCtlError(f"{phase} eval input_boundary 缺少：{', '.join(sorted(missing))}")
    if forbidden:
        raise LoopCtlError(f"{phase} eval input_boundary 含禁止项：{', '.join(sorted(forbidden))}")

    builder = candidate_builder_receipt(proposal)
    producer_roles = project_producer_role_ids(root)
    if role_id.casefold() in producer_roles:
        raise LoopCtlError(f"{phase} evaluator role 与 Producer role 相同，不构成独立评价")
    if role_id.casefold() == str(builder["role_id"]).casefold():
        raise LoopCtlError(f"{phase} evaluator role 与 candidate Builder 相同，不构成独立评价")
    if str(receipt["context_id"]).casefold() == str(builder["context_id"]).casefold():
        raise LoopCtlError(f"{phase} evaluator context 与 candidate Builder 相同")
    if str(receipt["task_id"]).casefold() == str(builder["task_id"]).casefold():
        raise LoopCtlError(f"{phase} evaluator task 与 candidate Builder 相同")
    if str(builder["attested_by"]).casefold() in evaluator_identities:
        raise LoopCtlError(
            f"{phase} evaluator identity 不得复用 candidate Builder orchestrator attester"
        )
    attester_key = str(receipt["attested_by"]).casefold()
    if attester_key in producer_roles:
        raise LoopCtlError(f"{phase} evaluator attester 不得是已知 Producer role")
    if attester_key in {
        str(builder["role_id"]).casefold(),
        str(builder["context_id"]).casefold(),
        str(builder["task_id"]).casefold(),
    }:
        raise LoopCtlError(f"{phase} evaluator attester 不得是 candidate Builder identity")
    if str(builder["attested_by"]).casefold() in producer_roles:
        raise LoopCtlError("candidate Builder attester 不得是已知 Producer role")
    producer_contexts = candidate_producer_context_ids(proposal)
    if attester_key in producer_contexts:
        raise LoopCtlError(f"{phase} evaluator attester 不得复用 finding 来源 Producer context")
    if str(receipt["context_id"]).casefold() in producer_contexts:
        raise LoopCtlError(f"{phase} evaluator context 与 finding 来源 Producer context 相同")
    if str(receipt["task_id"]).casefold() in producer_contexts:
        raise LoopCtlError(f"{phase} evaluator task 与 finding 来源 Producer context 相同")
    return dict(receipt)


def command_open_eval_run(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("validate 未通过：" + "; ".join(validation["errors"]))
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    eval_run_id = ensure_id(args.eval_run_id, "--eval-run-id")
    phase = args.phase
    with exclusive_controller_lock(root):
        candidate_root, proposal, status = load_candidate(root, candidate_id)
        ensure_candidate_eval_paths_safe(root, candidate_root)
        if status.get("status") != "CANDIDATE":
            raise LoopCtlError("只有 CANDIDATE 状态可以开启 eval run")
        ensure_eval_not_terminal_invalid(candidate_root, eval_run_id)
        evaluator_role_id = ensure_id(args.evaluator_role_id, "--evaluator-role-id")
        evaluator_context_id = single_line(
            args.evaluator_context_id, "--evaluator-context-id", maximum=300
        )
        evaluator_task_id = single_line(args.evaluator_task_id, "--evaluator-task-id", maximum=300)
        attested_by = single_line(args.attested_by, "--attested-by", maximum=300)
        boundaries = sorted(set(args.input_boundary))
        receipt = {
            "role_id": evaluator_role_id,
            "context_id": evaluator_context_id,
            "task_id": evaluator_task_id,
            "attested_by": attested_by,
            "input_boundary": boundaries,
            "identity_authentication": "external-attestation-not-controller-verified",
            "controller_frozen_at_open": True,
        }
        receipt = validate_eval_execution_receipt(root, proposal, phase, receipt)
        candidate_change_hashes = verify_candidate_changes(root, candidate_root, proposal)
        eval_ledger = controller_eval_open_ledger(
            root,
            candidate_root,
            candidate_id,
            proposal,
            require_anchored=False,
        )
        if any(item.get("terminal_invalid") is True for item in eval_ledger):
            raise LoopCtlError(
                "candidate 已含 terminal-invalid eval run；v0.1 exact-three 要求建立 successor candidate"
            )
        budget = proposal.get("budget", {}).get("max_evaluation_runs")
        if not isinstance(budget, int) or isinstance(budget, bool) or budget <= 0:
            raise LoopCtlError("候选 max_evaluation_runs 无效")
        if len(eval_ledger) >= budget:
            raise LoopCtlError(
                f"candidate eval budget 已耗尽：controller-opened={len(eval_ledger)}/{budget}"
            )
        evaluation_run_index = len(eval_ledger) + 1
        prior_phases: Set[str] = set()
        for prior_preflight_path in sorted((candidate_root / "evaluations").glob("*/preflight.json")):
            prior = load_json(prior_preflight_path)
            prior_receipt = prior.get("execution_receipt") if isinstance(prior, dict) else None
            if not isinstance(prior_receipt, dict):
                raise LoopCtlError(f"既有 eval preflight 缺少 execution receipt：{prior_preflight_path}")
            if str(prior_receipt.get("context_id", "")).casefold() == evaluator_context_id.casefold():
                raise LoopCtlError("每个 eval phase 必须使用新的 external context id")
            if str(prior_receipt.get("task_id", "")).casefold() == evaluator_task_id.casefold():
                raise LoopCtlError("每个 eval phase 必须使用新的 external task/thread id")
            prior_evaluator_ids = {
                str(prior_receipt.get("role_id", "")).casefold(),
                str(prior_receipt.get("context_id", "")).casefold(),
                str(prior_receipt.get("task_id", "")).casefold(),
            }
            if attested_by.casefold() in prior_evaluator_ids:
                raise LoopCtlError("orchestrator attester 不得复用既有 evaluator identity")
            if str(prior_receipt.get("attested_by", "")).casefold() in {
                evaluator_role_id.casefold(),
                evaluator_context_id.casefold(),
                evaluator_task_id.casefold(),
            }:
                raise LoopCtlError("新 evaluator identity 不得复用既有 orchestrator attester")
            prior_phases.add(str(prior.get("phase")))
        if phase in prior_phases:
            raise LoopCtlError(
                f"v0.1 L4 每个 eval phase 只允许 open 一次：{phase}；失败时必须创建 successor candidate"
            )
        run_root = candidate_eval_run_root(candidate_root, eval_run_id)
        try:
            run_root.mkdir(parents=True, exist_ok=False)
        except FileExistsError as exc:
            raise LoopCtlError(f"eval run 已存在，拒绝覆盖：{eval_run_id}") from exc
        output_root = run_root / "output"
        output_root.mkdir()
        if regular_file_inventory(output_root, label="new eval output root"):
            raise LoopCtlError("新 eval output root 在 preflight 前已被污染")
        preflight = {
            "schema_version": SCHEMA_VERSION,
            "kind": "EvalRunPreflight",
            "candidate_id": candidate_id,
            "proposal_sha256": sha256_file(candidate_root / "proposal.json"),
            "eval_run_id": eval_run_id,
            "phase": phase,
            "opened_at": utc_now(),
            "output_root": output_root.relative_to(root).as_posix(),
            "regular_file_count_at_open": 0,
            "fresh_empty_root_controller_verified": True,
            "execution_receipt": receipt,
            "execution_receipt_sha256": sha256_bytes(canonical_json_bytes(receipt)),
            "candidate_change_hashes": candidate_change_hashes,
            "evaluation_run_index": evaluation_run_index,
            "max_evaluation_runs": budget,
            "state": "OPEN",
        }
        try:
            preflight_path = run_root / "preflight.json"
            atomic_create_json(preflight_path, preflight)
            anchor = {
                "schema_version": SCHEMA_VERSION,
                "kind": "EvalRunOpenAnchor",
                "state": "OPEN_ANCHORED",
                "candidate_id": candidate_id,
                "proposal_sha256": preflight["proposal_sha256"],
                "eval_run_id": eval_run_id,
                "phase": phase,
                "anchored_at": utc_now(),
                "preflight_path": preflight_path.relative_to(root).as_posix(),
                "preflight_sha256": sha256_file(preflight_path),
                "execution_receipt_sha256": preflight["execution_receipt_sha256"],
                "candidate_change_hashes": candidate_change_hashes,
                "evaluation_run_index": evaluation_run_index,
                "max_evaluation_runs": budget,
            }
            anchor_path = eval_open_anchor_path(candidate_root, eval_run_id)
            atomic_create_json(anchor_path, anchor)
        except BaseException:
            try:
                (run_root / "preflight.json").unlink()
                output_root.rmdir()
                run_root.rmdir()
            except OSError:
                pass
            raise
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "eval_run_id": eval_run_id,
        "phase": phase,
        "output_root": preflight["output_root"],
        "execution_receipt_sha256": preflight["execution_receipt_sha256"],
        "open_anchor": anchor_path.relative_to(root).as_posix(),
        "open_anchor_sha256": sha256_file(anchor_path),
        "evaluation_run_index": evaluation_run_index,
        "max_evaluation_runs": budget,
        "next_step": "独立 evaluator 只写 output_root；完成后运行 seal-eval-run",
    }


def command_seal_eval_run(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("validate 未通过：" + "; ".join(validation["errors"]))
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    eval_run_id = ensure_id(args.eval_run_id, "--eval-run-id")
    with exclusive_controller_lock(root):
        candidate_root, proposal, status = load_candidate(root, candidate_id)
        ensure_candidate_eval_paths_safe(root, candidate_root)
        if status.get("status") != "CANDIDATE":
            raise LoopCtlError("只有 CANDIDATE 状态可以封存 eval run")
        ensure_eval_not_terminal_invalid(candidate_root, eval_run_id)
        run_root = candidate_eval_run_root(candidate_root, eval_run_id)
        preflight_path = run_root / "preflight.json"
        manifest_path = run_root / "manifest.json"
        seal_path = run_root / ".sealed.json"
        for path, label in (
            (candidate_root, "candidate root"),
            (run_root, "eval run root"),
            (preflight_path, "eval preflight"),
            (manifest_path, "eval manifest"),
            (seal_path, "eval seal"),
            (run_root / "output", "eval output root"),
        ):
            relative = path.relative_to(root).as_posix()
            reject_symlink_components(root, relative, label)
        if seal_path.exists():
            raise LoopCtlError(f"eval run 已封存，拒绝覆盖：{eval_run_id}")
        preflight = load_json(preflight_path)
        output_root = run_root / "output"
        expected_output = output_root.relative_to(root).as_posix()
        if (
            not isinstance(preflight, dict)
            or preflight.get("kind") != "EvalRunPreflight"
            or preflight.get("candidate_id") != candidate_id
            or preflight.get("proposal_sha256") != sha256_file(candidate_root / "proposal.json")
            or preflight.get("eval_run_id") != eval_run_id
            or preflight.get("phase") not in {"targeted", "regression", "heldout"}
            or preflight.get("output_root") != expected_output
            or preflight.get("regular_file_count_at_open") != 0
            or preflight.get("fresh_empty_root_controller_verified") is not True
            or preflight.get("state") != "OPEN"
        ):
            raise LoopCtlError(f"eval run preflight 无效：{eval_run_id}")
        verified_open = verify_eval_open_anchor(
            root,
            candidate_root,
            candidate_id,
            proposal,
            eval_run_id,
            preflight_path,
        )
        receipt = validate_eval_execution_receipt(
            root,
            proposal,
            str(preflight["phase"]),
            preflight.get("execution_receipt"),
        )
        receipt_hash = sha256_bytes(canonical_json_bytes(receipt))
        if receipt_hash != verified_open["receipt_sha256"]:
            raise LoopCtlError("eval execution receipt 与 open anchor 不一致")
        try:
            inventory = regular_file_inventory(
                output_root,
                label=f"eval run {eval_run_id} output root",
            )
        except LoopCtlError as exc:
            marker = mark_eval_terminal_invalid(
                root,
                candidate_root,
                candidate_id,
                eval_run_id,
                "EVAL_OUTPUT_INVALID",
                {"inventory_error": str(exc)},
            )
            raise LoopCtlError(
                "EVAL_OUTPUT_INVALID：评价输出根无法形成合法清单；"
                f"当前候选必须由 successor candidate 替代；incident={marker}"
            ) from exc
        if not inventory:
            marker = mark_eval_terminal_invalid(
                root,
                candidate_root,
                candidate_id,
                eval_run_id,
                "EVAL_EMPTY_OUTPUT",
                {
                    "output_root": expected_output,
                    "open_anchor_sha256": verified_open["anchor_sha256"],
                    "output_file_count": 0,
                },
            )
            raise LoopCtlError(
                "EVAL_EMPTY_OUTPUT：评价 run 已结束但 output 为空；"
                f"当前候选必须由 successor candidate 替代；incident={marker}"
            )
        if manifest_path.exists():
            manifest = load_json(manifest_path)
            if (
                not isinstance(manifest, dict)
                or manifest.get("kind") != "EvalRunManifest"
                or manifest.get("candidate_id") != candidate_id
                or manifest.get("proposal_sha256") != preflight["proposal_sha256"]
                or manifest.get("eval_run_id") != eval_run_id
                or manifest.get("phase") != preflight["phase"]
                or manifest.get("preflight_sha256") != sha256_file(preflight_path)
                or manifest.get("execution_receipt_sha256") != receipt_hash
                or manifest.get("open_anchor_path") != verified_open["anchor_path"]
                or manifest.get("open_anchor_sha256") != verified_open["anchor_sha256"]
                or manifest.get("candidate_change_hashes") != preflight.get("candidate_change_hashes")
                or manifest.get("output_root") != expected_output
                or manifest.get("output_file_count") != len(inventory)
                or manifest.get("output_files") != inventory
                or manifest.get("state") != "SEALED"
            ):
                raise LoopCtlError("未完成的 eval manifest 与当前输出不一致，不能恢复 seal")
        else:
            manifest = {
                "schema_version": SCHEMA_VERSION,
                "kind": "EvalRunManifest",
                "candidate_id": candidate_id,
                "proposal_sha256": preflight["proposal_sha256"],
                "eval_run_id": eval_run_id,
                "phase": preflight["phase"],
                "sealed_at": utc_now(),
                "preflight_sha256": sha256_file(preflight_path),
                "execution_receipt_sha256": receipt_hash,
                "open_anchor_path": verified_open["anchor_path"],
                "open_anchor_sha256": verified_open["anchor_sha256"],
                "candidate_change_hashes": preflight["candidate_change_hashes"],
                "output_root": expected_output,
                "output_file_count": len(inventory),
                "output_files": inventory,
                "state": "SEALED",
            }
            atomic_create_json(manifest_path, manifest)
        final_inventory = regular_file_inventory(
            output_root,
            label=f"eval run {eval_run_id} output root",
        )
        if final_inventory != inventory:
            marker = mark_eval_terminal_invalid(
                root,
                candidate_root,
                candidate_id,
                eval_run_id,
                "EVAL_CHANGED_DURING_SEAL",
                {
                    "initial_inventory": inventory,
                    "final_inventory": final_inventory,
                },
            )
            raise LoopCtlError(
                "EVAL_CHANGED_DURING_SEAL：评价输出在封存期间发生变化；"
                f"当前候选必须由 successor candidate 替代；incident={marker}"
            )
        atomic_create_json(
            seal_path,
            {
                "schema_version": SCHEMA_VERSION,
                "kind": "SealedEvalRun",
                "candidate_id": candidate_id,
                "eval_run_id": eval_run_id,
                "manifest_sha256": sha256_file(manifest_path),
                "sealed_at": manifest["sealed_at"],
            },
        )
        post_seal_inventory = regular_file_inventory(
            output_root,
            label=f"eval run {eval_run_id} output root",
        )
        post_seal_failure: Optional[str] = None
        try:
            verified_after_seal = verify_eval_open_anchor(
                root,
                candidate_root,
                candidate_id,
                proposal,
                eval_run_id,
                preflight_path,
            )
            sealed_receipt = preflight.get("execution_receipt")
            current_seal = load_json(seal_path)
            if (
                post_seal_inventory != inventory
                or verified_after_seal["anchor_sha256"] != manifest["open_anchor_sha256"]
                or verified_after_seal["receipt_sha256"]
                != sha256_bytes(canonical_json_bytes(sealed_receipt))
                or manifest["preflight_sha256"] != sha256_file(preflight_path)
                or current_seal.get("manifest_sha256") != sha256_file(manifest_path)
                or current_seal.get("candidate_id") != candidate_id
                or current_seal.get("eval_run_id") != eval_run_id
            ):
                post_seal_failure = "sealed bundle or output changed before seal commit completed"
        except (LoopCtlError, OSError, ValueError, TypeError, KeyError) as exc:
            post_seal_failure = str(exc)
        if post_seal_failure is not None:
            marker = mark_eval_terminal_invalid(
                root,
                candidate_root,
                candidate_id,
                eval_run_id,
                "EVAL_CHANGED_DURING_SEAL",
                {
                    "initial_inventory": inventory,
                    "post_seal_inventory": post_seal_inventory,
                    "verification_error": post_seal_failure,
                },
            )
            raise LoopCtlError(
                "EVAL_CHANGED_DURING_SEAL：评价证据在 seal commit 完成前发生变化；"
                f"当前候选必须由 successor candidate 替代；incident={marker}"
            )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "eval_run_id": eval_run_id,
        "phase": manifest["phase"],
        "manifest": manifest_path.relative_to(root).as_posix(),
        "manifest_sha256": sha256_file(manifest_path),
        "output_file_count": len(inventory),
    }


def verify_sealed_eval_run(
    root: Path,
    candidate_root: Path,
    candidate_id: str,
    eval_run_id: str,
    phase: str,
    output_root_value: str,
) -> Dict[str, Any]:
    ensure_id(eval_run_id, f"{phase}.run_id")
    ensure_eval_not_terminal_invalid(candidate_root, eval_run_id)
    run_root = candidate_eval_run_root(candidate_root, eval_run_id)
    preflight_path = run_root / "preflight.json"
    manifest_path = run_root / "manifest.json"
    seal_path = run_root / ".sealed.json"
    for path in (run_root, preflight_path, manifest_path, seal_path, run_root / "output"):
        if path.is_symlink():
            raise LoopCtlError(f"eval run 不允许符号链接：{path}")
    preflight = load_json(preflight_path)
    manifest = load_json(manifest_path)
    seal = load_json(seal_path)
    expected_output = (run_root / "output").relative_to(root).as_posix()
    proposal_hash = sha256_file(candidate_root / "proposal.json")
    if output_root_value != expected_output:
        raise LoopCtlError(f"{phase}.output_root 未绑定 controller-opened eval run")
    if (
        not isinstance(preflight, dict)
        or preflight.get("kind") != "EvalRunPreflight"
        or preflight.get("candidate_id") != candidate_id
        or preflight.get("proposal_sha256") != proposal_hash
        or preflight.get("eval_run_id") != eval_run_id
        or preflight.get("phase") != phase
        or preflight.get("output_root") != expected_output
        or preflight.get("regular_file_count_at_open") != 0
        or preflight.get("fresh_empty_root_controller_verified") is not True
        or preflight.get("state") != "OPEN"
    ):
        raise LoopCtlError(f"{phase} eval preflight 无效")
    proposal = load_json(candidate_root / "proposal.json")
    verified_open = verify_eval_open_anchor(
        root,
        candidate_root,
        candidate_id,
        proposal,
        eval_run_id,
        preflight_path,
    )
    receipt = validate_eval_execution_receipt(
        root,
        proposal,
        phase,
        preflight.get("execution_receipt"),
    )
    receipt_hash = sha256_bytes(canonical_json_bytes(receipt))
    if (
        not isinstance(manifest, dict)
        or manifest.get("kind") != "EvalRunManifest"
        or manifest.get("candidate_id") != candidate_id
        or manifest.get("proposal_sha256") != proposal_hash
        or manifest.get("eval_run_id") != eval_run_id
        or manifest.get("phase") != phase
        or manifest.get("preflight_sha256") != sha256_file(preflight_path)
        or manifest.get("execution_receipt_sha256") != receipt_hash
        or manifest.get("open_anchor_path") != verified_open["anchor_path"]
        or manifest.get("open_anchor_sha256") != verified_open["anchor_sha256"]
        or manifest.get("candidate_change_hashes") != preflight.get("candidate_change_hashes")
        or manifest.get("output_root") != expected_output
        or not isinstance(manifest.get("output_files"), list)
        or not manifest.get("output_files")
        or manifest.get("output_file_count") != len(manifest["output_files"])
    ):
        raise LoopCtlError(f"{phase} eval manifest 无效")
    if (
        not isinstance(seal, dict)
        or seal.get("kind") != "SealedEvalRun"
        or seal.get("candidate_id") != candidate_id
        or seal.get("eval_run_id") != eval_run_id
        or seal.get("manifest_sha256") != sha256_file(manifest_path)
    ):
        raise LoopCtlError(f"{phase} eval seal 无效")
    current = regular_file_inventory(run_root / "output", label=f"{phase} eval output root")
    if current != manifest["output_files"]:
        raise LoopCtlError(f"{phase} eval output 在封存后发生变化")
    return {
        "preflight": preflight,
        "manifest": manifest,
        "seal": seal,
        "seal_path": seal_path.relative_to(root).as_posix(),
        "seal_sha256": sha256_file(seal_path),
        "execution_receipt": receipt,
        "execution_receipt_sha256": receipt_hash,
        "open_anchor_path": verified_open["anchor_path"],
        "open_anchor_sha256": verified_open["anchor_sha256"],
        "output_paths": {
            (run_root / "output" / entry["path"]).resolve()
            for entry in manifest["output_files"]
        },
    }


def evidence_paths(root: Path, section_name: str, section: Mapping[str, Any]) -> List[str]:
    raw = section.get("evidence", section.get("evidence_paths"))
    if not isinstance(raw, list) or not raw:
        raise LoopCtlError(f"{section_name} 必须提供非空 evidence 路径数组")
    paths: List[str] = []
    for item in raw:
        if not isinstance(item, str):
            raise LoopCtlError(f"{section_name}.evidence 只能包含路径字符串")
        path = safe_relative(root, item, f"{section_name}.evidence")
        reject_symlink_components(root, item, f"{section_name}.evidence")
        if not path.is_file():
            raise LoopCtlError(f"评价证据不存在：{item}")
        paths.append(Path(item).as_posix())
    return paths


def command_block_candidate(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    with exclusive_controller_lock(root):
        return command_block_candidate_locked(args, root, candidate_id)


def command_block_candidate_locked(
    args: argparse.Namespace, root: Path, expected_candidate_id: str
) -> Dict[str, Any]:
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("validate 未通过：" + "; ".join(validation["errors"]))
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    if candidate_id != expected_candidate_id:
        raise LoopCtlError("candidate id 在获取控制器锁期间发生变化")
    candidate_root, proposal, status = load_candidate(root, candidate_id)
    if status.get("status") != "CANDIDATE":
        raise LoopCtlError("只有 CANDIDATE 状态可以写入最终 block-seal")
    raw_evidence = args.evidence or []
    if not raw_evidence:
        raise LoopCtlError("block-seal 至少需要一个 --evidence")
    evidence: List[Dict[str, Any]] = []
    for value in raw_evidence:
        path = safe_relative(root, value, "--evidence")
        reject_symlink_components(root, value, "--evidence")
        if not path.is_file():
            raise LoopCtlError(f"block-seal 证据不存在：{value}")
        evidence.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            }
        )
    block = {
        "schema_version": SCHEMA_VERSION,
        "kind": "CandidateBlockSeal",
        "state": "BLOCK_SEALED",
        "scope_type": "candidate",
        "scope_id": candidate_id,
        "candidate_id": candidate_id,
        "proposal_sha256": sha256_file(candidate_root / "proposal.json"),
        "sealed_at": utc_now(),
        "reason": single_line(args.reason, "--reason", maximum=500),
        "evidence": evidence,
        "promotion_eligible": False,
        "successor_candidate_required": True,
    }
    block_path = candidate_root / "block-seal.json"
    atomic_create_json(block_path, block)
    new_status = dict(status)
    new_status.update(
        {
            "status": "BLOCKED",
            "blocked_at": block["sealed_at"],
            "block_seal": block_path.relative_to(root).as_posix(),
            "block_seal_sha256": sha256_file(block_path),
            "automatic_promotion_allowed": False,
        }
    )
    atomic_write_json(candidate_root / "status.json", new_status)
    return {
        "status": "PASS",
        "candidate_status": "BLOCKED",
        "candidate_id": candidate_id,
        "block_seal": block_path.relative_to(root).as_posix(),
        "block_seal_sha256": sha256_file(block_path),
        "promotion_eligible": False,
        "next_step": "如需继续，创建新的 successor candidate；不得解封当前 candidate",
    }


def raise_terminal_promotion_failure(
    root: Path,
    candidate_id: str,
    evidence_file: Path,
    reason_code: str,
    message: str,
) -> None:
    """Monotonically disqualify a candidate after explicit negative eval evidence."""
    evidence_relative = evidence_file.relative_to(root).as_posix()
    result = command_block_candidate_locked(
        argparse.Namespace(
            candidate_id=candidate_id,
            reason=f"{reason_code}: {message}",
            evidence=[evidence_relative],
        ),
        root,
        candidate_id,
    )
    raise LoopCtlError(
        f"{message}；已写不可覆盖的 {reason_code} candidate block-seal，"
        f"必须建立 successor candidate：{result['block_seal']}"
    )


def explicit_terminal_promotion_attestation(
    evaluation: Mapping[str, Any],
) -> Optional[Tuple[str, str]]:
    """Return an irreversible failure only for explicit, typed negative claims."""
    targeted = evaluation.get("targeted")
    regression = evaluation.get("regression")
    heldout = evaluation.get("heldout")
    integrity = evaluation.get("run_integrity")
    if not all(isinstance(item, dict) for item in (targeted, regression, heldout)):
        return None
    if targeted.get("status") in {"FAIL", "BLOCK", "INFERIOR", "NOT_IMPROVED", "WORSE"}:
        return "TARGET_EVAL_FAILED", "目标 eval 已明确报告目标问题未改善"
    if regression.get("status") in {"FAIL", "BLOCK", "INFERIOR", "REGRESSED", "WORSE"}:
        return "REGRESSION_EVAL_FAILED", "全量回归已明确报告阻断性退化"
    for field in ("hard_contract_regressions", "hard_false_passes"):
        value = regression.get(field)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return "HARD_CONTRACT_REGRESSION", "回归已明确报告硬合同退化或假通过"
    if heldout.get("status") in {"FAIL", "BLOCK", "INFERIOR", "REGRESSED", "WORSE"}:
        return "HELDOUT_EVAL_FAILED", "held-out 已明确报告候选劣于基线"
    if heldout.get("blind") is False or heldout.get("baseline_comparison") in {
        "WORSE",
        "INFERIOR",
    }:
        return "HELDOUT_PROTOCOL_FAILED", "held-out 已明确报告未盲评或候选劣于基线"
    if isinstance(integrity, dict):
        if integrity.get("fresh_output_roots_verified") is False:
            return "EVAL_FRESH_ROOT_FAILED", "评价已明确报告未使用 fresh empty output root"
        if integrity.get("all_evaluation_outputs_regenerated") is False:
            return "EVAL_REGENERATION_FAILED", "评价已明确报告没有从零生成本轮全部输出"
        prior_outputs = integrity.get("prior_run_outputs_included")
        if (
            isinstance(prior_outputs, int)
            and not isinstance(prior_outputs, bool)
            and prior_outputs > 0
        ) or integrity.get("stale_output_contamination") is True:
            return "STALE_OUTPUT_CONTAMINATION", "评价已明确报告包含 prior-run output"
    return None


def command_promote(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    with exclusive_controller_lock(root):
        return command_promote_locked(args, root, candidate_id)


def command_promote_locked(
    args: argparse.Namespace, root: Path, expected_candidate_id: str
) -> Dict[str, Any]:
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    if candidate_id != expected_candidate_id:
        raise LoopCtlError("candidate id 在获取控制器锁期间发生变化")
    to_version = ensure_id(args.to_version or candidate_id, "--to-version")
    approved_by = single_line(args.approved_by, "--approved-by")
    evaluation_file = resolve_project_cli_path(root, args.evaluation, "--evaluation")
    evaluation_relative = evaluation_file.relative_to(root).as_posix()
    regular_project_file(root, evaluation_relative, "--evaluation")
    evaluation_input_sha256 = sha256_file(evaluation_file)

    pending = pending_controller_transactions(root)
    if pending:
        if len(pending) != 1:
            raise LoopCtlError("存在多个 PENDING_CONTROLLER_TRANSACTION，拒绝猜测恢复顺序")
        transaction_dir, intent = pending[0]
        if intent.get("operation") != "promote":
            raise LoopCtlError("存在 pending rollback；请使用原参数重跑 rollback")
        assert_matching_promotion_retry(
            intent,
            candidate_id=candidate_id,
            to_version=to_version,
            approved_by=approved_by,
            evaluation_sha256=evaluation_input_sha256,
        )
        record = roll_forward_promotion_transaction(root, transaction_dir, intent)
        recovered_validation = validate_project(root)
        if recovered_validation["errors"]:
            raise LoopCtlError(
                "promote 恢复后 validate 未通过："
                + "; ".join(recovered_validation["errors"])
            )
        return {
            "status": "PASS",
            "candidate_id": candidate_id,
            "previous_version": record.get("previous_version"),
            "active_version": to_version,
            "recovered_partial_commit": True,
            "promotion_record": intent["promotion_record"]["path"],
            "transaction": transaction_dir.relative_to(root).as_posix(),
        }
    validation = validate_project(root)
    if validation["errors"]:
        committed = matching_committed_promotion_transaction(
            root,
            candidate_id=candidate_id,
            to_version=to_version,
            approved_by=approved_by,
            evaluation_sha256=evaluation_input_sha256,
        )
        if committed is None:
            raise LoopCtlError("validate 未通过：" + "; ".join(validation["errors"]))
        transaction_dir, intent = committed
        record = roll_forward_promotion_transaction(root, transaction_dir, intent)
        recovered_validation = validate_project(root)
        if recovered_validation["errors"]:
            raise LoopCtlError(
                "promote 已提交事务的显式重试仍未恢复一致状态："
                + "; ".join(recovered_validation["errors"])
            )
        return {
            "status": "PASS",
            "candidate_id": candidate_id,
            "previous_version": record.get("previous_version"),
            "active_version": to_version,
            "recovered_partial_commit": True,
            "promotion_record": intent["promotion_record"]["path"],
            "transaction": transaction_dir.relative_to(root).as_posix(),
        }
    candidate_root, proposal, candidate_status = load_candidate(root, candidate_id)
    if proposal.get("level") == "L5" or proposal.get("target_component") in L5_TARGETS:
        raise LoopCtlError("L5 属于 experimental / unvalidated；v0.1 永不自动晋升")
    if candidate_status.get("status") not in {"CANDIDATE", "PROMOTED"}:
        raise LoopCtlError("只有 CANDIDATE 或待恢复的 PROMOTED 状态可以晋升")
    audit = audit_project(root)
    if maturity_index(str(audit.get("provable_maturity"))) < maturity_index("L3"):
        raise LoopCtlError(
            "晋升 L4 前必须先以证据达到 L3；当前为 "
            + str(audit.get("provable_maturity"))
            + "："
            + "；".join(audit.get("gaps", []))
        )
    source_runs = set(proposal.get("finding_cluster", {}).get("independent_runs", []))
    if len(source_runs) < 3:
        raise LoopCtlError("候选不再满足至少三次独立真实 run 的 finding 门槛")

    evidence_file = evaluation_file
    evaluation = load_json(evidence_file)
    if not isinstance(evaluation, dict):
        raise LoopCtlError("评价证据顶层必须是对象")
    controller_eval_ledger = controller_eval_open_ledger(
        root,
        candidate_root,
        candidate_id,
        proposal,
        require_anchored=True,
    )
    ledger_phase_runs = {
        str(item.get("phase")): str(item.get("eval_run_id"))
        for item in controller_eval_ledger
        if isinstance(item, dict)
    }
    sections_bound_to_ledger = (
        len(controller_eval_ledger) == 3
        and set(ledger_phase_runs) == {"targeted", "regression", "heldout"}
        and all(
            isinstance(evaluation.get(phase), dict)
            and evaluation[phase].get("run_id") == ledger_phase_runs[phase]
            for phase in ("targeted", "regression", "heldout")
        )
    )
    if sections_bound_to_ledger:
        terminal_failure = explicit_terminal_promotion_attestation(evaluation)
        if terminal_failure is not None:
            reason_code, message = terminal_failure
            raise_terminal_promotion_failure(
                root,
                candidate_id,
                evidence_file,
                reason_code,
                message,
            )
    if evaluation.get("independent_evaluator") is not True or not evaluation.get("evaluator"):
        raise LoopCtlError("必须声明独立评价者，且评价者不得参与候选生成")
    evaluator_coordinator = ensure_id(str(evaluation["evaluator"]), "evaluation.evaluator")
    builder_receipt = candidate_builder_receipt(proposal)
    coordinator_key = evaluator_coordinator.casefold()
    if coordinator_key in project_producer_role_ids(root):
        raise LoopCtlError("evaluation.evaluator 与 Producer role 相同，不构成独立评价")
    if coordinator_key in {
        str(builder_receipt["role_id"]).casefold(),
        str(builder_receipt["context_id"]).casefold(),
        str(builder_receipt["task_id"]).casefold(),
        str(builder_receipt["attested_by"]).casefold(),
    }:
        raise LoopCtlError("evaluation.evaluator 与 candidate Builder identity 相同，不构成独立评价")
    if coordinator_key in candidate_producer_context_ids(proposal):
        raise LoopCtlError("evaluation.evaluator 与 finding 来源 Producer context 相同")
    evaluation_runs = evaluation.get("evaluation_runs")
    budget = proposal.get("budget", {}).get("max_evaluation_runs")
    if (
        not isinstance(evaluation_runs, int)
        or isinstance(evaluation_runs, bool)
        or evaluation_runs != 3
        or budget != 3
        or isinstance(budget, bool)
        or len(controller_eval_ledger) != 3
        or sorted(str(item.get("phase")) for item in controller_eval_ledger)
        != ["heldout", "regression", "targeted"]
    ):
        raise LoopCtlError(
            "v0.1 L4 晋升要求 selection-safe exact-three：三条 controller-opened eval "
            "必须恰为 targeted/regression/heldout 各一"
        )
    for key in ("targeted", "regression", "heldout", "human_approval"):
        if not isinstance(evaluation.get(key), dict):
            raise LoopCtlError(f"评价证据缺少 {key} 对象")
    targeted = evaluation["targeted"]
    regression = evaluation["regression"]
    heldout = evaluation["heldout"]
    human = evaluation["human_approval"]
    if targeted.get("status") not in {"PASS", "IMPROVED"}:
        raise LoopCtlError("目标 eval 未证明目标问题改善")
    if regression.get("status") not in {"PASS", "NON_INFERIOR"}:
        raise LoopCtlError("全量回归存在阻断性退化")
    if regression.get("hard_contract_regressions") != 0 or regression.get("hard_false_passes") != 0:
        raise LoopCtlError("回归必须证明硬合同无退化且无假通过")
    if heldout.get("status") not in {"PASS", "NON_INFERIOR", "PREFERRED"}:
        raise LoopCtlError("held-out 未证明不劣于基线")
    if heldout.get("blind") is not True or heldout.get("baseline_comparison") not in {
        "NOT_WORSE",
        "PREFERRED",
    }:
        raise LoopCtlError("held-out 必须盲评且不劣于基线")
    if (
        human.get("approved") is not True
        or not human.get("approved_by")
        or not human.get("scope")
        or not human.get("approved_at")
    ):
        raise LoopCtlError("缺少明确人工批准人、批准范围或批准时间")
    utc_timestamp(human.get("approved_at"), "human_approval.approved_at")
    integrity = evaluation.get("run_integrity")
    if not isinstance(integrity, dict):
        raise LoopCtlError("评价证据缺少 run_integrity 对象")
    if integrity.get("fresh_output_roots_verified") is not True:
        raise LoopCtlError("每个 eval run 必须证明使用 fresh empty output root")
    if integrity.get("all_evaluation_outputs_regenerated") is not True:
        raise LoopCtlError("新 eval run 必须从零生成本轮全部评价输出")
    prior_outputs = integrity.get("prior_run_outputs_included")
    stale_contamination = integrity.get("stale_output_contamination")
    if prior_outputs != 0:
        raise LoopCtlError("run_integrity.prior_run_outputs_included 必须是整数 0")
    if stale_contamination is not False:
        raise LoopCtlError("run_integrity 必须明确不存在 STALE_OUTPUT_CONTAMINATION")
    phase_runs: Set[str] = set()
    evaluator_contexts: Set[str] = set()
    evaluator_tasks: Set[str] = set()
    phase_roots: List[str] = []
    eval_run_seals: Dict[str, Dict[str, str]] = {}
    evaluation_evidence: List[str] = []
    for section_name, section in (("targeted", targeted), ("regression", regression), ("heldout", heldout)):
        run_id = section.get("run_id")
        output_root_value = section.get("output_root")
        if not isinstance(run_id, str):
            raise LoopCtlError(f"{section_name}.run_id 缺失")
        ensure_id(run_id, f"{section_name}.run_id")
        if run_id in phase_runs:
            raise LoopCtlError("targeted/regression/heldout 必须使用不同 eval run id")
        phase_runs.add(run_id)
        if not isinstance(output_root_value, str):
            raise LoopCtlError(f"{section_name}.output_root 缺失")
        output_root = safe_relative(root, output_root_value, f"{section_name}.output_root")
        reject_symlink_components(root, output_root_value, f"{section_name}.output_root")
        if not output_root.is_dir():
            raise LoopCtlError(f"{section_name}.output_root 不是目录")
        normalized_root = output_root.relative_to(root).as_posix()
        if any(_surface_overlap(normalized_root, other) for other in phase_roots):
            raise LoopCtlError("targeted/regression/heldout 的 fresh output root 不得相同或互相嵌套")
        phase_roots.append(normalized_root)
        verified_eval = verify_sealed_eval_run(
            root,
            candidate_root,
            candidate_id,
            run_id,
            section_name,
            normalized_root,
        )
        receipt = verified_eval["execution_receipt"]
        context_key = str(receipt["context_id"]).casefold()
        task_key = str(receipt["task_id"]).casefold()
        if context_key in evaluator_contexts or task_key in evaluator_tasks:
            raise LoopCtlError("targeted/regression/heldout 必须来自三个不同 external context/task")
        evaluator_contexts.add(context_key)
        evaluator_tasks.add(task_key)
        section_paths = evidence_paths(root, section_name, section)
        for evidence_relative in section_paths:
            evidence_path = safe_relative(root, evidence_relative, f"{section_name}.evidence")
            if evidence_path not in verified_eval["output_paths"]:
                raise LoopCtlError(
                    f"{section_name}.evidence 必须属于对应 controller-sealed eval output root：{evidence_relative}"
                )
        evaluation_evidence.extend(section_paths)
        eval_run_seals[section_name] = {
            "eval_run_id": run_id,
            "seal_path": verified_eval["seal_path"],
            "seal_sha256": verified_eval["seal_sha256"],
            "execution_receipt_sha256": verified_eval["execution_receipt_sha256"],
            "execution_receipt": receipt,
        }
    ledger_run_ids = {str(item.get("eval_run_id")) for item in controller_eval_ledger}
    if phase_runs != ledger_run_ids:
        raise LoopCtlError("evaluation section run-id 集合必须与 controller eval open ledger 精确相等")
    if human.get("approved_by") != approved_by:
        raise LoopCtlError("--approved-by 与评价证据中的批准人不一致")
    evaluation_evidence.extend(evidence_paths(root, "human_approval", human))
    evaluation_evidence.extend(evidence_paths(root, "run_integrity", integrity))
    evaluation_evidence_hashes = {
        value: sha256_file(safe_relative(root, value, "evaluation evidence"))
        for value in sorted(set(evaluation_evidence))
    }

    change_hashes = verify_candidate_changes(root, candidate_root, proposal)
    system = load_system(root)
    active = system.get("project", {}).get("active_version")
    expected = proposal.get("rollback_plan", {}).get("previous_version")
    if to_version == expected:
        raise LoopCtlError("新版本不能与候选基线版本相同")
    if active not in {expected, to_version}:
        raise LoopCtlError(f"active version 已变化；候选基线为 {expected}，当前为 {active}")
    if candidate_status.get("status") == "PROMOTED" and candidate_status.get("promoted_version") != to_version:
        raise LoopCtlError("候选 PROMOTED 状态与目标版本不一致")
    releases_root = root / "creative-system" / "releases"
    release_root = releases_root / to_version
    guard_project_directory(root, releases_root, "releases root")
    guard_project_directory(root, release_root, "release root", allow_missing=True)
    registry_path = releases_root / "registry.json"
    registry_exists = os.path.lexists(str(registry_path))
    if registry_exists:
        registry = load_json(
            regular_project_file(root, registry_path.relative_to(root).as_posix(), "release registry")
        )
    else:
        registry = {
            "schema_version": SCHEMA_VERSION,
            "kind": "ReleaseRegistry",
            "active_version": expected,
            "history": [],
        }
    if (
        not isinstance(registry, dict)
        or registry.get("schema_version") != SCHEMA_VERSION
        or registry.get("kind") != "ReleaseRegistry"
        or not isinstance(registry.get("history"), list)
        or registry.get("active_version") != expected
    ):
        raise LoopCtlError("release registry 无效或与当前 active version 不一致")
    if os.path.lexists(str(release_root)):
        raise LoopCtlError(f"release 目标已存在但没有 matching transaction：{to_version}")

    record = {
        "schema_version": SCHEMA_VERSION,
        "kind": "PromotionRecord",
        "action": "promote",
        "state": "COMMITTED",
        "level": "L4",
        "candidate_id": candidate_id,
        "previous_version": expected,
        "new_version": to_version,
        "promoted_at": utc_now(),
        "approved_by": approved_by,
        "evaluation_sha256": json_document_sha256(evaluation),
        "evaluation_evidence_hashes": evaluation_evidence_hashes,
        "eval_run_seals": eval_run_seals,
        "eval_open_ledger": controller_eval_ledger,
        "candidate_change_hashes": change_hashes,
        "rollback_to": expected,
    }
    promotion_relative = (release_root / "promotion.json").relative_to(root).as_posix()
    promotion_sha256 = json_document_sha256(record)
    next_candidate_status = dict(candidate_status)
    next_candidate_status.update(
        {
            "status": "PROMOTED",
            "promoted_version": to_version,
            "promotion_record": promotion_relative,
        }
    )
    next_registry = json.loads(json.dumps(registry))
    next_registry["active_version"] = to_version
    next_registry["history"].append(record)
    next_system = json.loads(json.dumps(system))
    next_system["project"]["active_version"] = to_version
    next_system["maturity"] = {
        "declared": "L4",
        "evidence": [promotion_relative],
        "evidence_hashes": {promotion_relative: promotion_sha256},
    }
    next_system["statuses"]["release_status"] = "PASS"

    transaction_id = (
        f"txn-promote-{candidate_id}-{to_version}-{uuid.uuid4().hex[:8]}"
    )
    transaction_root = root / "creative-system" / "control" / "transactions"
    guard_project_directory(root, transaction_root, "controller transactions root")
    transaction_dir = transaction_root / transaction_id
    staging = Path(tempfile.mkdtemp(prefix=f".{transaction_id}.", dir=str(transaction_root)))
    try:
        bundle_snapshot = staging / "release-bundle"
        bundle_snapshot.mkdir()
        atomic_create_json(bundle_snapshot / "system-before.json", system)
        atomic_create_json(bundle_snapshot / "evaluation.json", evaluation)
        atomic_create_json(bundle_snapshot / "promotion.json", record)
        bundle_files = regular_file_inventory(bundle_snapshot, label="promotion release snapshot")
        targets = [
            controller_transaction_target(
                root,
                candidate_root / "status.json",
                next_candidate_status,
                before_exists=True,
            ),
            controller_transaction_target(
                root,
                registry_path,
                next_registry,
                before_exists=registry_exists,
            ),
            controller_transaction_target(
                root,
                system_path(root),
                next_system,
                before_exists=True,
            ),
        ]
        intent = {
            "schema_version": SCHEMA_VERSION,
            "kind": "ControllerTransactionIntent",
            "transaction_id": transaction_id,
            "operation": "promote",
            "created_at": utc_now(),
            "recovery_policy": "roll-forward",
            "candidate_id": candidate_id,
            "candidate_proposal_sha256": sha256_file(candidate_root / "proposal.json"),
            "previous_active_version": expected,
            "new_active_version": to_version,
            "approved_by": approved_by,
            "evaluation_input": {
                "path": evaluation_relative,
                "sha256": evaluation_input_sha256,
            },
            "release_bundle": {
                "path": release_root.relative_to(root).as_posix(),
                "snapshot_path": "release-bundle",
                "files": bundle_files,
                "tree_sha256": release_bundle_tree_sha256(bundle_files),
            },
            "promotion_record": {
                "path": promotion_relative,
                "sha256": promotion_sha256,
            },
            "targets": targets,
        }
        atomic_create_json(staging / "intent.json", intent)
        try:
            os.rename(str(staging), str(transaction_dir))
        except FileExistsError as exc:
            raise LoopCtlError(
                f"controller transaction 已由并发操作创建：{transaction_id}"
            ) from exc
    finally:
        if staging.exists():
            shutil.rmtree(staging)

    roll_forward_promotion_transaction(root, transaction_dir, intent)
    committed_validation = validate_project(root)
    if committed_validation["errors"]:
        raise LoopCtlError(
            "promote 提交后 validate 未通过："
            + "; ".join(committed_validation["errors"])
        )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "previous_version": expected,
        "active_version": to_version,
        "promotion_record": promotion_relative,
        "transaction": transaction_dir.relative_to(root).as_posix(),
    }


def json_document_sha256(value: Any) -> str:
    data = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    return sha256_bytes(data)


def release_bundle_tree_sha256(files: Sequence[Mapping[str, Any]]) -> str:
    return sha256_bytes(canonical_json_bytes(list(files)))


def release_file_inventory(directory: Path, *, label: str) -> List[Dict[str, Any]]:
    """Inventory a flat release bundle and reject every ungoverned entry."""
    if directory.is_symlink() or not directory.is_dir():
        raise LoopCtlError(f"{label} 必须是普通目录：{directory}")
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise LoopCtlError(f"{label} 不允许包含符号链接：{path}")
        if path.is_dir():
            raise LoopCtlError(f"{label} 不允许包含未声明子目录：{path}")
        if not path.is_file():
            raise LoopCtlError(f"{label} 不允许包含特殊文件：{path}")
    return regular_file_inventory(directory, label=label)


def controller_transaction_target(
    root: Path,
    path: Path,
    after: Mapping[str, Any],
    *,
    before_exists: bool,
) -> Dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    reject_symlink_components(root, relative, "controller transaction target")
    guard_project_directory(root, path.parent, "controller transaction target parent")
    if before_exists:
        regular_project_file(root, relative, "controller transaction target")
        before_sha256: Optional[str] = sha256_file(path)
    else:
        if os.path.lexists(str(path)):
            raise LoopCtlError(
                f"controller transaction target 应不存在但已被占用：{relative}"
            )
        before_sha256 = None
    return {
        "path": relative,
        "before_exists": before_exists,
        "before_sha256": before_sha256,
        "after_sha256": json_document_sha256(after),
        "after": dict(after),
    }


def controller_transaction_directories(root: Path) -> List[Path]:
    transaction_root = root / "creative-system" / "control" / "transactions"
    guard_project_directory(root, transaction_root, "controller transactions root")
    transactions: List[Path] = []
    for path in sorted(transaction_root.iterdir()):
        if path.name.startswith("."):
            continue
        if path.is_symlink() or not path.is_dir():
            raise LoopCtlError(f"controller transaction 必须是普通目录：{path.name}")
        transactions.append(path)
    return transactions


def load_controller_transaction(root: Path, transaction_dir: Path) -> Dict[str, Any]:
    intent_path = transaction_dir / "intent.json"
    reject_symlink_components(
        root, intent_path.relative_to(root).as_posix(), "controller transaction intent"
    )
    if intent_path.is_symlink() or not intent_path.is_file():
        raise LoopCtlError(f"controller transaction 缺少普通 intent.json：{transaction_dir.name}")
    intent = load_json(intent_path)
    if (
        not isinstance(intent, dict)
        or intent.get("schema_version") != SCHEMA_VERSION
        or intent.get("kind") != "ControllerTransactionIntent"
        or intent.get("transaction_id") != transaction_dir.name
        or intent.get("operation") not in {"promote", "rollback"}
        or intent.get("recovery_policy") != "roll-forward"
        or not isinstance(intent.get("targets"), list)
    ):
        raise LoopCtlError(f"controller transaction intent 无效：{transaction_dir.name}")
    return intent


def pending_controller_transactions(root: Path) -> List[Tuple[Path, Dict[str, Any]]]:
    pending: List[Tuple[Path, Dict[str, Any]]] = []
    for transaction_dir in controller_transaction_directories(root):
        intent = load_controller_transaction(root, transaction_dir)
        committed_path = transaction_dir / "committed.json"
        if os.path.lexists(str(committed_path)) and (
            committed_path.is_symlink() or not committed_path.is_file()
        ):
            raise LoopCtlError(
                f"controller transaction commit marker 必须是普通文件：{transaction_dir.name}"
            )
        if not os.path.lexists(str(committed_path)):
            pending.append((transaction_dir, intent))
    return pending


def validate_controller_transaction_targets(intent: Mapping[str, Any]) -> List[str]:
    errors: List[str] = []
    seen: Set[str] = set()
    for target in intent.get("targets", []):
        if not isinstance(target, dict) or not isinstance(target.get("path"), str):
            errors.append("controller transaction target 无效")
            continue
        relative = target["path"]
        if relative in seen:
            errors.append(f"controller transaction target 重复：{relative}")
        seen.add(relative)
        after = target.get("after")
        before_exists = target.get("before_exists", True)
        before_sha256 = target.get("before_sha256")
        if before_exists not in {True, False}:
            errors.append(f"controller transaction before_exists 无效：{relative}")
        elif before_exists is True and not isinstance(before_sha256, str):
            errors.append(f"controller transaction before_sha256 缺失：{relative}")
        elif before_exists is False and before_sha256 is not None:
            errors.append(f"controller transaction 不存在目标不得有 before_sha256：{relative}")
        if (
            not isinstance(after, dict)
            or json_document_sha256(after) != target.get("after_sha256")
        ):
            errors.append(f"controller transaction target snapshot 无效：{relative}")
    return errors


def promotion_transaction_bundle(
    root: Path, transaction_dir: Path, intent: Mapping[str, Any]
) -> Tuple[Path, Path, List[Dict[str, Any]]]:
    candidate_id = intent.get("candidate_id")
    new_version = intent.get("new_active_version")
    previous_version = intent.get("previous_active_version")
    approved_by = intent.get("approved_by")
    evaluation_input = intent.get("evaluation_input")
    bundle = intent.get("release_bundle")
    promotion = intent.get("promotion_record")
    if (
        not isinstance(candidate_id, str)
        or not isinstance(new_version, str)
        or not isinstance(previous_version, str)
        or not isinstance(approved_by, str)
        or not isinstance(intent.get("candidate_proposal_sha256"), str)
        or not isinstance(evaluation_input, dict)
        or not isinstance(evaluation_input.get("path"), str)
        or not isinstance(evaluation_input.get("sha256"), str)
        or not isinstance(bundle, dict)
        or not isinstance(bundle.get("path"), str)
        or not isinstance(bundle.get("snapshot_path"), str)
        or not isinstance(bundle.get("files"), list)
        or not isinstance(bundle.get("tree_sha256"), str)
        or not isinstance(promotion, dict)
        or not isinstance(promotion.get("path"), str)
        or not isinstance(promotion.get("sha256"), str)
    ):
        raise LoopCtlError(
            f"promote transaction metadata 无效：{transaction_dir.name}"
        )
    ensure_id(candidate_id, "promote transaction candidate_id")
    ensure_id(new_version, "promote transaction new_active_version")
    target_paths = {
        target.get("path")
        for target in intent.get("targets", [])
        if isinstance(target, dict)
    }
    if target_paths != {
        f"creative-system/candidates/{candidate_id}/status.json",
        "creative-system/releases/registry.json",
        "creative-system/system.json",
    } or len(intent.get("targets", [])) != 3:
        raise LoopCtlError("promote transaction target 集合无效")
    expected_bundle_relative = f"creative-system/releases/{new_version}"
    if bundle["path"] != expected_bundle_relative:
        raise LoopCtlError("promote transaction release bundle 路径与目标版本不一致")
    snapshot_relative = Path(bundle["snapshot_path"])
    if snapshot_relative.is_absolute() or ".." in snapshot_relative.parts:
        raise LoopCtlError("promote transaction snapshot_path 必须位于事务目录内")
    snapshot = transaction_dir / snapshot_relative
    reject_symlink_components(
        root, snapshot.relative_to(root).as_posix(), "promotion release snapshot"
    )
    actual_inventory = release_file_inventory(
        snapshot, label="promotion release snapshot"
    )
    expected_inventory = bundle["files"]
    if actual_inventory != expected_inventory:
        raise LoopCtlError("promote transaction release snapshot inventory 不一致")
    if release_bundle_tree_sha256(actual_inventory) != bundle["tree_sha256"]:
        raise LoopCtlError("promote transaction release snapshot tree hash 不一致")
    inventory_by_path = {item["path"]: item for item in actual_inventory}
    if set(inventory_by_path) != {
        "system-before.json",
        "evaluation.json",
        "promotion.json",
    }:
        raise LoopCtlError("promote transaction release snapshot 文件集合无效")
    formal_root = safe_relative(root, bundle["path"], "promotion release bundle")
    expected_promotion_relative = f"{bundle['path']}/promotion.json"
    if (
        promotion["path"] != expected_promotion_relative
        or inventory_by_path["promotion.json"]["sha256"] != promotion["sha256"]
    ):
        raise LoopCtlError("promote transaction promotion record 哈希或路径无效")
    record = load_json(snapshot / "promotion.json")
    if (
        not isinstance(record, dict)
        or record.get("kind") != "PromotionRecord"
        or record.get("state") != "COMMITTED"
        or record.get("candidate_id") != candidate_id
        or record.get("previous_version") != previous_version
        or record.get("new_version") != new_version
        or record.get("approved_by") != approved_by
        or record.get("evaluation_sha256")
        != inventory_by_path["evaluation.json"]["sha256"]
    ):
        raise LoopCtlError("promote transaction promotion record 内容无效")
    return snapshot, formal_root, actual_inventory


def verify_formal_promotion_bundle(
    root: Path,
    transaction_dir: Path,
    intent: Mapping[str, Any],
    *,
    exact: bool,
) -> bool:
    _, formal_root, expected_inventory = promotion_transaction_bundle(
        root, transaction_dir, intent
    )
    if not os.path.lexists(str(formal_root)):
        return False
    if formal_root.is_symlink() or not formal_root.is_dir():
        raise LoopCtlError("TRANSACTION_DIVERGED：promotion release bundle 路径被占用")
    actual_inventory = release_file_inventory(formal_root, label="promotion release bundle")
    actual_by_path = {item["path"]: item for item in actual_inventory}
    for expected in expected_inventory:
        if actual_by_path.get(expected["path"]) != expected:
            raise LoopCtlError(
                f"TRANSACTION_DIVERGED：release bundle 文件已改变：{expected['path']}"
            )
    if exact and actual_inventory != expected_inventory:
        raise LoopCtlError("TRANSACTION_DIVERGED：pending release bundle 含事务外文件")
    return True


def materialize_promotion_release_bundle(
    root: Path, transaction_dir: Path, intent: Mapping[str, Any]
) -> None:
    snapshot, formal_root, expected_inventory = promotion_transaction_bundle(
        root, transaction_dir, intent
    )
    if verify_formal_promotion_bundle(
        root, transaction_dir, intent, exact=True
    ):
        return
    guard_project_directory(root, formal_root.parent, "releases root")
    staging = Path(
        tempfile.mkdtemp(prefix=f".{formal_root.name}.promotion-", dir=str(formal_root.parent))
    )
    try:
        for item in expected_inventory:
            source = snapshot / item["path"]
            target = staging / item["path"]
            atomic_create_bytes(target, source.read_bytes())
        if release_file_inventory(staging, label="promotion release staging") != expected_inventory:
            raise LoopCtlError("promotion release staging inventory 不一致")
        try:
            os.rename(str(staging), str(formal_root))
        except FileExistsError as exc:
            raise LoopCtlError(
                "TRANSACTION_DIVERGED：promotion release bundle 被并发占用"
            ) from exc
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    verify_formal_promotion_bundle(root, transaction_dir, intent, exact=True)


def roll_forward_controller_targets(root: Path, intent: Mapping[str, Any]) -> None:
    target_errors = validate_controller_transaction_targets(intent)
    if target_errors:
        raise LoopCtlError("; ".join(target_errors))
    states: List[Tuple[Mapping[str, Any], Path, str]] = []
    for target in intent["targets"]:
        relative = target["path"]
        target_path = safe_relative(root, relative, "controller transaction target")
        reject_symlink_components(root, relative, "controller transaction target")
        guard_project_directory(root, target_path.parent, "controller transaction target parent")
        exists = os.path.lexists(str(target_path))
        if exists:
            if target_path.is_symlink() or not target_path.is_file():
                raise LoopCtlError(
                    f"TRANSACTION_DIVERGED：{relative} 不是普通文件"
                )
            current_sha256 = sha256_file(target_path)
            if current_sha256 == target["after_sha256"]:
                states.append((target, target_path, "after"))
                continue
            if (
                target.get("before_exists", True) is not True
                or current_sha256 != target.get("before_sha256")
            ):
                raise LoopCtlError(
                    f"TRANSACTION_DIVERGED：{relative} 既不是事务前也不是目标状态"
                )
            states.append((target, target_path, "before"))
        else:
            if target.get("before_exists", True) is True:
                raise LoopCtlError(
                    f"TRANSACTION_DIVERGED：{relative} 在事务中途消失"
                )
            states.append((target, target_path, "before-absent"))

    # Preflight every target before the first write.  A later third state must
    # never cause an earlier before-state target to be advanced speculatively.
    for target, target_path, state in states:
        if state == "after":
            continue
        if state == "before-absent":
            if os.path.lexists(str(target_path)):
                if (
                    target_path.is_file()
                    and not target_path.is_symlink()
                    and sha256_file(target_path) == target["after_sha256"]
                ):
                    continue
                raise LoopCtlError(
                    f"TRANSACTION_DIVERGED：{target['path']} 在提交前被占用"
                )
            atomic_create_json(target_path, target["after"])
            continue
        current_path = regular_project_file(
            root, target["path"], "controller transaction target"
        )
        current_sha256 = sha256_file(current_path)
        if current_sha256 == target["after_sha256"]:
            continue
        if current_sha256 != target.get("before_sha256"):
            raise LoopCtlError(
                f"TRANSACTION_DIVERGED：{target['path']} 在提交前发生变化"
            )
        atomic_write_json(target_path, target["after"])

    for target in intent["targets"]:
        target_path = regular_project_file(
            root, target["path"], "controller transaction target"
        )
        if sha256_file(target_path) != target["after_sha256"]:
            raise LoopCtlError(
                f"controller transaction target 未能提交：{target['path']}"
            )


def commit_controller_transaction(
    transaction_dir: Path, intent: Mapping[str, Any]
) -> None:
    intent_path = transaction_dir / "intent.json"
    committed_path = transaction_dir / "committed.json"
    if os.path.lexists(str(committed_path)):
        if committed_path.is_symlink() or not committed_path.is_file():
            raise LoopCtlError("controller transaction commit marker 路径被占用")
        committed = load_json(committed_path)
        if (
            not isinstance(committed, dict)
            or committed.get("transaction_id") != intent.get("transaction_id")
            or committed.get("intent_sha256") != sha256_file(intent_path)
        ):
            raise LoopCtlError("controller transaction commit marker 冲突")
        return
    atomic_create_json(
        committed_path,
        {
            "schema_version": SCHEMA_VERSION,
            "kind": "ControllerTransactionCommit",
            "transaction_id": intent.get("transaction_id"),
            "intent_sha256": sha256_file(intent_path),
            "committed_at": utc_now(),
        },
    )


def assert_matching_promotion_retry(
    intent: Mapping[str, Any],
    *,
    candidate_id: str,
    to_version: str,
    approved_by: str,
    evaluation_sha256: str,
) -> None:
    evaluation_input = intent.get("evaluation_input")
    if (
        intent.get("operation") != "promote"
        or intent.get("candidate_id") != candidate_id
        or intent.get("new_active_version") != to_version
        or intent.get("approved_by") != approved_by
        or not isinstance(evaluation_input, dict)
        or evaluation_input.get("sha256") != evaluation_sha256
    ):
        raise LoopCtlError(
            "恢复 pending promote 时 candidate/to-version/approved-by/evaluation hash "
            "必须与原事务一致"
        )


def matching_committed_promotion_transaction(
    root: Path,
    *,
    candidate_id: str,
    to_version: str,
    approved_by: str,
    evaluation_sha256: str,
) -> Optional[Tuple[Path, Dict[str, Any]]]:
    matches: List[Tuple[Path, Dict[str, Any]]] = []
    for transaction_dir in controller_transaction_directories(root):
        intent = load_controller_transaction(root, transaction_dir)
        committed_path = transaction_dir / "committed.json"
        if intent.get("operation") != "promote" or not committed_path.is_file():
            continue
        try:
            assert_matching_promotion_retry(
                intent,
                candidate_id=candidate_id,
                to_version=to_version,
                approved_by=approved_by,
                evaluation_sha256=evaluation_sha256,
            )
        except LoopCtlError:
            continue
        committed = load_json(committed_path)
        if (
            not isinstance(committed, dict)
            or committed.get("transaction_id") != intent.get("transaction_id")
            or committed.get("intent_sha256") != sha256_file(transaction_dir / "intent.json")
        ):
            raise LoopCtlError(
                f"controller transaction commit marker 无效：{transaction_dir.name}"
            )
        matches.append((transaction_dir, intent))
    if len(matches) > 1:
        raise LoopCtlError("存在多个 matching committed promote transaction")
    return matches[0] if matches else None


def roll_forward_promotion_transaction(
    root: Path, transaction_dir: Path, intent: Mapping[str, Any]
) -> Dict[str, Any]:
    snapshot, _, _ = promotion_transaction_bundle(root, transaction_dir, intent)
    proposal_relative = (
        f"creative-system/candidates/{intent['candidate_id']}/proposal.json"
    )
    proposal_path = regular_project_file(root, proposal_relative, "candidate proposal")
    if sha256_file(proposal_path) != intent.get("candidate_proposal_sha256"):
        raise LoopCtlError("TRANSACTION_DIVERGED：candidate proposal 已改变")
    proposal = load_json(proposal_path)
    candidate_root = proposal_path.parent
    record = load_json(snapshot / "promotion.json")
    if verify_candidate_changes(root, candidate_root, proposal) != record.get(
        "candidate_change_hashes"
    ):
        raise LoopCtlError("TRANSACTION_DIVERGED：candidate changes 已改变")
    committed = (transaction_dir / "committed.json").is_file()
    if not committed:
        materialize_promotion_release_bundle(root, transaction_dir, intent)
    else:
        verify_formal_promotion_bundle(root, transaction_dir, intent, exact=False)
    roll_forward_controller_targets(root, intent)
    verify_formal_promotion_bundle(root, transaction_dir, intent, exact=not committed)
    commit_controller_transaction(transaction_dir, intent)
    return record


def validate_controller_transactions(root: Path) -> List[str]:
    errors: List[str] = []
    try:
        transactions = controller_transaction_directories(root)
    except LoopCtlError as exc:
        return [str(exc)]
    for transaction_dir in transactions:
        try:
            intent = load_controller_transaction(root, transaction_dir)
            intent_path = transaction_dir / "intent.json"
            committed_path = transaction_dir / "committed.json"
            target_errors = validate_controller_transaction_targets(intent)
            errors.extend(
                f"{error}：{transaction_dir.name}" for error in target_errors
            )
            if intent.get("operation") == "promote":
                promotion_transaction_bundle(root, transaction_dir, intent)
            if not committed_path.is_file() or committed_path.is_symlink():
                errors.append(
                    f"PENDING_CONTROLLER_TRANSACTION：{transaction_dir.name} 必须由 matching "
                    f"{intent.get('operation')} 重试恢复"
                )
                continue
            committed = load_json(committed_path)
            if (
                not isinstance(committed, dict)
                or committed.get("kind") != "ControllerTransactionCommit"
                or committed.get("transaction_id") != transaction_dir.name
                or committed.get("intent_sha256") != sha256_file(intent_path)
            ):
                errors.append(f"controller transaction commit marker 无效：{transaction_dir.name}")
                continue
            if intent.get("operation") == "rollback":
                rollback = intent.get("rollback_record", {})
                rollback_relative = rollback.get("path") if isinstance(rollback, dict) else None
                if not isinstance(rollback_relative, str):
                    errors.append(f"controller transaction rollback record 无效：{transaction_dir.name}")
                else:
                    rollback_path = regular_project_file(
                        root, rollback_relative, "controller transaction rollback record"
                    )
                    if rollback.get("sha256") != sha256_file(rollback_path):
                        errors.append(f"controller transaction rollback record 哈希不一致：{transaction_dir.name}")
            else:
                verify_formal_promotion_bundle(
                    root, transaction_dir, intent, exact=False
                )
            for target in intent.get("targets", []):
                if not isinstance(target, dict) or not isinstance(target.get("path"), str):
                    errors.append(f"controller transaction target 无效：{transaction_dir.name}")
                    continue
                regular_project_file(
                    root, target["path"], "controller transaction target"
                )
        except LoopCtlError as exc:
            errors.append(str(exc))
    return errors


def validate_release_registry_lifecycle(root: Path, active_version: Any) -> List[str]:
    errors: List[str] = []
    releases_root = root / "creative-system" / "releases"
    release_directories: Set[str] = set()
    for entry in sorted(releases_root.iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.name == "registry.json":
            continue
        if entry.is_symlink():
            errors.append(f"release control entry 不允许是符号链接：{entry.name}")
        elif entry.is_dir():
            release_directories.add(entry.name)
        elif entry.is_file():
            errors.append(f"releases/ 根目录存在未治理文件：{entry.name}")
        else:
            errors.append(f"releases/ 根目录存在特殊文件：{entry.name}")
    registry_path = releases_root / "registry.json"
    if not os.path.lexists(str(registry_path)):
        for version in sorted(release_directories):
            errors.append(
                f"ORPHAN_COMMITTED_RELEASE_BUNDLE：{version} 没有 registry promotion 引用"
            )
        if active_version != "baseline-v1":
            errors.append("非 baseline active version 缺少 release registry")
        candidates_root = root / "creative-system" / "candidates"
        for status_path in sorted(candidates_root.glob("*/status.json")):
            status = load_json(status_path)
            if isinstance(status, dict) and status.get("status") in {"PROMOTED", "ROLLED_BACK"}:
                errors.append(
                    f"candidate {status_path.parent.name} 生命周期状态缺少 release registry"
                )
        return errors
    try:
        registry_file = regular_project_file(root, registry_path.relative_to(root).as_posix(), "release registry")
        registry = load_json(registry_file)
    except LoopCtlError as exc:
        return errors + [str(exc)] + [
            f"ORPHAN_COMMITTED_RELEASE_BUNDLE：{version} 无法由有效 registry 证明"
            for version in sorted(release_directories)
        ]
    if (
        not isinstance(registry, dict)
        or registry.get("schema_version") != SCHEMA_VERSION
        or registry.get("kind") != "ReleaseRegistry"
        or not isinstance(registry.get("history"), list)
    ):
        return errors + ["release registry 合同无效"] + [
            f"ORPHAN_COMMITTED_RELEASE_BUNDLE：{version} 无法由有效 registry 证明"
            for version in sorted(release_directories)
        ]
    if registry.get("active_version") != active_version:
        errors.append("active version 与 release registry 不一致")
    cursor = "baseline-v1"
    lifecycle: Dict[str, Tuple[str, str, Optional[str]]] = {}
    referenced_releases: Set[str] = set()
    allowed_release_files: Dict[str, Set[str]] = {}
    for index, record in enumerate(registry["history"], start=1):
        if not isinstance(record, dict) or record.get("state") != "COMMITTED":
            errors.append(f"release registry 第 {index} 条不是 COMMITTED 记录")
            continue
        action = record.get("action")
        if action == "promote":
            previous = record.get("previous_version")
            new_version = record.get("new_version")
            candidate_id = record.get("candidate_id")
            if previous != cursor or not isinstance(new_version, str) or not isinstance(candidate_id, str):
                errors.append(f"release registry 第 {index} 条 promotion 不能从当前游标重放")
                continue
            referenced_releases.add(new_version)
            allowed_release_files.setdefault(new_version, set()).update(
                {"system-before.json", "evaluation.json", "promotion.json"}
            )
            promotion_relative = f"creative-system/releases/{new_version}/promotion.json"
            try:
                promotion_path = regular_project_file(root, promotion_relative, "promotion receipt")
                if load_json(promotion_path) != record:
                    errors.append(f"registry promotion 与磁盘 receipt 不一致：{new_version}")
            except LoopCtlError as exc:
                errors.append(str(exc))
            lifecycle[candidate_id] = ("PROMOTED", promotion_relative, new_version)
            cursor = new_version
        elif action == "rollback":
            previous_active = record.get("previous_active_version")
            restored = record.get("restored_version")
            candidate_id = record.get("candidate_id")
            rollback_id = record.get("rollback_id")
            if (
                previous_active != cursor
                or not isinstance(restored, str)
                or not isinstance(candidate_id, str)
                or not isinstance(rollback_id, str)
            ):
                errors.append(f"release registry 第 {index} 条 rollback 不能从当前游标重放")
                continue
            prior_promotions = [
                item
                for item in registry["history"][: index - 1]
                if isinstance(item, dict)
                and item.get("action") == "promote"
                and item.get("new_version") == previous_active
                and item.get("candidate_id") == candidate_id
            ]
            if not prior_promotions or prior_promotions[-1].get("previous_version") != restored:
                errors.append(f"release registry 第 {index} 条 rollback 未绑定对应 promotion 基线")
            rollback_relative = (
                f"creative-system/releases/{previous_active}/{rollback_id}.json"
            )
            allowed_release_files.setdefault(str(previous_active), set()).add(
                f"{rollback_id}.json"
            )
            try:
                rollback_path = regular_project_file(root, rollback_relative, "rollback receipt")
                if load_json(rollback_path) != record:
                    errors.append(f"registry rollback 与磁盘 receipt 不一致：{rollback_id}")
            except LoopCtlError as exc:
                errors.append(str(exc))
            lifecycle[candidate_id] = ("ROLLED_BACK", rollback_relative, None)
            cursor = restored
        else:
            errors.append(f"release registry 第 {index} 条 action 无效")
    for version in sorted(release_directories - referenced_releases):
        errors.append(
            f"ORPHAN_COMMITTED_RELEASE_BUNDLE：{version} 没有 registry promotion 引用"
        )
    for version in sorted(release_directories & referenced_releases):
        release_root = releases_root / version
        try:
            inventory = release_file_inventory(
                release_root, label=f"release bundle {version}"
            )
            actual_paths = {item["path"] for item in inventory}
            expected_paths = allowed_release_files.get(version, set())
            if actual_paths != expected_paths:
                errors.append(
                    f"release bundle {version} 文件集合与 registry 不一致："
                    f"expected={sorted(expected_paths)} actual={sorted(actual_paths)}"
                )
        except LoopCtlError as exc:
            errors.append(str(exc))
    if cursor != active_version or cursor != registry.get("active_version"):
        errors.append("release registry history 重放终点与 active version 不一致")

    candidates_root = root / "creative-system" / "candidates"
    for status_path in sorted(candidates_root.glob("*/status.json")):
        candidate_id = status_path.parent.name
        try:
            _, _, status = load_candidate(root, candidate_id)
        except LoopCtlError as exc:
            errors.append(str(exc))
            continue
        lifecycle_status = lifecycle.get(candidate_id)
        if status.get("status") in {"PROMOTED", "ROLLED_BACK"} and lifecycle_status is None:
            errors.append(f"candidate {candidate_id} 生命周期状态没有 registry 记录")
            continue
        if lifecycle_status is None:
            continue
        expected_status, receipt_relative, promoted_version = lifecycle_status
        if status.get("status") != expected_status:
            errors.append(f"candidate {candidate_id} 状态与 registry 生命周期不一致")
        if expected_status == "PROMOTED":
            if (
                status.get("promotion_record") != receipt_relative
                or status.get("promoted_version") != promoted_version
            ):
                errors.append(f"candidate {candidate_id} 未绑定 registry promotion receipt")
        elif status.get("rollback_record") != receipt_relative:
            errors.append(f"candidate {candidate_id} 未绑定 registry rollback receipt")
    return errors


def roll_forward_rollback_transaction(
    root: Path, transaction_dir: Path, intent: Mapping[str, Any]
) -> Dict[str, Any]:
    rollback = intent.get("rollback_record")
    if not isinstance(rollback, dict) or not isinstance(rollback.get("path"), str):
        raise LoopCtlError("rollback transaction 缺少 rollback_record")
    rollback_path = safe_relative(root, rollback["path"], "rollback record")
    reject_symlink_components(root, rollback["path"], "rollback record")
    rollback_value = rollback.get("value")
    if not isinstance(rollback_value, dict):
        raise LoopCtlError("rollback transaction record value 无效")
    if os.path.lexists(str(rollback_path)):
        if rollback_path.is_symlink() or not rollback_path.is_file():
            raise LoopCtlError("TRANSACTION_DIVERGED：rollback record 路径被占用")
        if sha256_file(rollback_path) != rollback.get("sha256"):
            raise LoopCtlError("TRANSACTION_DIVERGED：rollback record 已改变")
    else:
        atomic_create_json(rollback_path, rollback_value)

    roll_forward_controller_targets(root, intent)
    commit_controller_transaction(transaction_dir, intent)
    return dict(rollback_value)


def command_rollback(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    with exclusive_controller_lock(root):
        return command_rollback_locked(args, root)


def command_rollback_locked(args: argparse.Namespace, root: Path) -> Dict[str, Any]:
    pending = pending_controller_transactions(root)
    if pending:
        if len(pending) != 1:
            raise LoopCtlError("存在多个 PENDING_CONTROLLER_TRANSACTION，拒绝猜测恢复顺序")
        transaction_dir, intent = pending[0]
        if intent.get("operation") != "rollback":
            raise LoopCtlError(
                "存在 pending promote；请使用原 candidate/to-version/approved-by/"
                "evaluation 参数重跑 promote"
            )
        requested_reason = single_line(args.reason, "--reason", maximum=500)
        if requested_reason != intent.get("reason"):
            raise LoopCtlError("恢复 pending rollback 时 --reason 必须与原事务一致")
        if args.to_version and args.to_version != intent.get("restored_version"):
            raise LoopCtlError("恢复 pending rollback 时 --to-version 与原事务不一致")
        evidence = intent.get("evidence")
        if args.evidence:
            evidence_path = regular_project_file(root, args.evidence, "--evidence")
            if (
                not isinstance(evidence, dict)
                or evidence.get("path") != evidence_path.relative_to(root).as_posix()
                or evidence.get("sha256") != sha256_file(evidence_path)
            ):
                raise LoopCtlError("恢复 pending rollback 时 --evidence 与原事务不一致")
        elif evidence is not None:
            raise LoopCtlError("恢复 pending rollback 必须再次提供原 --evidence")
        rollback_record = roll_forward_rollback_transaction(root, transaction_dir, intent)
        validation = validate_project(root)
        if validation["errors"]:
            raise LoopCtlError("rollback 恢复后 validate 未通过：" + "; ".join(validation["errors"]))
        return {
            "status": "PASS",
            "active_version": rollback_record.get("restored_version"),
            "rolled_back_from": rollback_record.get("previous_active_version"),
            "rollback_record": intent["rollback_record"]["path"],
            "history_retained": True,
            "recovered_partial_commit": True,
            "transaction": transaction_dir.relative_to(root).as_posix(),
        }

    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("validate 未通过：" + "; ".join(validation["errors"]))
    system = load_system(root)
    active = system.get("project", {}).get("active_version")
    registry_path = root / "creative-system" / "releases" / "registry.json"
    registry = load_json(registry_path)
    if not isinstance(registry, dict) or not isinstance(registry.get("history"), list):
        raise LoopCtlError("没有可用的 release registry")
    promotion: Optional[Dict[str, Any]] = None
    for item in reversed(registry["history"]):
        if (
            isinstance(item, dict)
            and item.get("action") == "promote"
            and item.get("state") == "COMMITTED"
            and item.get("new_version") == active
        ):
            promotion = item
            break
    if promotion is None:
        raise LoopCtlError(f"当前 active version 没有可回滚的晋升记录：{active}")
    previous = promotion.get("previous_version")
    if args.to_version and args.to_version != previous:
        raise LoopCtlError(f"只能回滚到上一稳定版本：{previous}")
    reason = single_line(args.reason, "--reason", maximum=500)
    evidence_relative: Optional[str] = None
    evidence_hash: Optional[str] = None
    if args.evidence:
        evidence = regular_project_file(root, args.evidence, "--evidence")
        evidence_relative = evidence.relative_to(root).as_posix()
        evidence_hash = sha256_file(evidence)
    rollback_id = f"rollback-{datetime.now(timezone.utc).strftime('%Y%m%dt%H%M%Sz').lower()}-{uuid.uuid4().hex[:8]}"
    release_root = root / "creative-system" / "releases" / str(active)
    rollback_record = {
        "schema_version": SCHEMA_VERSION,
        "kind": "RollbackRecord",
        "action": "rollback",
        "state": "COMMITTED",
        "rollback_id": rollback_id,
        "candidate_id": promotion.get("candidate_id"),
        "previous_active_version": active,
        "restored_version": previous,
        "reason": reason,
        "evidence": evidence_relative,
        "evidence_sha256": evidence_hash,
        "rolled_back_at": utc_now(),
        "history_retained": True,
    }
    rollback_path = release_root / f"{rollback_id}.json"
    next_system = json.loads(json.dumps(system))
    next_system["project"]["active_version"] = previous
    next_system["statuses"]["release_status"] = "PASS"
    next_system["maturity"] = {
        "declared": "L3" if previous == "baseline-v1" else "L4",
        "evidence": [rollback_path.relative_to(root).as_posix()],
    }
    candidate_id = str(promotion.get("candidate_id"))
    candidate_root, proposal, candidate_status = load_candidate(root, candidate_id)
    next_candidate_status = dict(candidate_status)
    next_candidate_status.update(
        {
            "status": "ROLLED_BACK",
            "rollback_record": rollback_path.relative_to(root).as_posix(),
        }
    )
    next_registry = json.loads(json.dumps(registry))
    next_registry["active_version"] = previous
    next_registry["history"].append(rollback_record)

    transaction_id = f"txn-{rollback_id}"
    transaction_root = root / "creative-system" / "control" / "transactions"
    guard_project_directory(root, transaction_root, "controller transactions root")
    transaction_dir = transaction_root / transaction_id
    if os.path.lexists(str(transaction_dir)):
        raise LoopCtlError(f"controller transaction 已存在：{transaction_id}")
    targets = []
    for path, after in (
        (candidate_root / "status.json", next_candidate_status),
        (registry_path, next_registry),
        (system_path(root), next_system),
    ):
        relative = path.relative_to(root).as_posix()
        regular_project_file(root, relative, "rollback transaction target")
        targets.append(
            {
                "path": relative,
                "before_sha256": sha256_file(path),
                "after_sha256": json_document_sha256(after),
                "after": after,
            }
        )
    intent = {
        "schema_version": SCHEMA_VERSION,
        "kind": "ControllerTransactionIntent",
        "transaction_id": transaction_id,
        "operation": "rollback",
        "created_at": utc_now(),
        "recovery_policy": "roll-forward",
        "reason": reason,
        "previous_active_version": active,
        "restored_version": previous,
        "candidate_id": candidate_id,
        "promotion_record_sha256": sha256_file(release_root / "promotion.json"),
        "evidence": (
            {"path": evidence_relative, "sha256": evidence_hash}
            if evidence_relative is not None
            else None
        ),
        "rollback_record": {
            "path": rollback_path.relative_to(root).as_posix(),
            "sha256": json_document_sha256(rollback_record),
            "value": rollback_record,
        },
        "targets": targets,
    }
    staging = Path(tempfile.mkdtemp(prefix=f".{transaction_id}.", dir=str(transaction_root)))
    try:
        atomic_create_json(staging / "intent.json", intent)
        os.rename(str(staging), str(transaction_dir))
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    roll_forward_rollback_transaction(root, transaction_dir, intent)
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("rollback 提交后 validate 未通过：" + "; ".join(validation["errors"]))
    return {
        "status": "PASS",
        "active_version": previous,
        "rolled_back_from": active,
        "rollback_record": rollback_path.relative_to(root).as_posix(),
        "history_retained": True,
        "transaction": transaction_dir.relative_to(root).as_posix(),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="loopctl.py",
        description="管理 creative-loop2rsi 合同、运行证据、候选、晋升和回滚；不访问网络。",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {SCHEMA_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="生成项目与领域 Skill；非空目标拒绝覆盖")
    init.add_argument("target")
    init.add_argument("--project-name", required=True)
    init.add_argument("--creative-goal", required=True)
    init.add_argument("--minimum-product", required=True)
    init.add_argument("--representative-task", required=True)
    init.add_argument("--constraints", required=True)
    init.add_argument("--taste", required=True)
    init.add_argument("--domain-skill", required=True)
    init.add_argument(
        "--charter-confirmed",
        action="store_true",
        help="仅在已有外部人工确认依据时使用；必须同时提供确认人和依据文件",
    )
    init.add_argument("--charter-confirmed-by")
    init.add_argument("--charter-confirmed-at", help="可选 UTC ISO 8601；默认控制器当前时间")
    init.add_argument("--charter-confirmation-evidence", help="已有的 UTF-8 人工确认依据文件")
    init.set_defaults(handler=command_init)

    confirm_charter = subparsers.add_parser(
        "confirm-charter",
        help="用人工确认依据原子记录创作宪法确认；不得只手改 boolean",
    )
    confirm_charter.add_argument("project")
    confirm_charter.add_argument("--confirmed-by", required=True)
    confirm_charter.add_argument("--confirmed-at", help="可选 UTC ISO 8601；默认控制器当前时间")
    confirm_charter.add_argument(
        "--evidence",
        required=True,
        help=(
            "位于 creative-system/approvals/charter-confirmations/evidence/ 的"
            "项目内 UTF-8 人工确认依据"
        ),
    )
    confirm_charter.set_defaults(handler=command_confirm_charter)

    validate = subparsers.add_parser("validate", help="检查 Schema、引用、不变量与封存哈希")
    validate.add_argument("project")
    validate.set_defaults(handler=command_validate)

    audit = subparsers.add_parser("audit", help="给出当前可证明成熟度与下一等级缺口")
    audit.add_argument("project")
    audit.set_defaults(handler=command_audit)

    measure = subparsers.add_parser(
        "measure-artifact",
        help="计算机械证据；同 source 重测时自动保留并串联旧 facts",
    )
    measure.add_argument("project")
    measure.add_argument("--source", required=True, help="项目内 UTF-8 文本相对路径")
    measure.add_argument(
        "--output",
        required=True,
        help="新建的项目内 facts JSON 相对路径；重测使用新路径，旧 facts 自动保留",
    )
    measure.add_argument(
        "--exclude-first-markdown-h1",
        action="store_true",
        help="若首行是 Markdown H1，则从 governing 文本计数中排除该行",
    )
    measure.set_defaults(handler=command_measure_artifact)

    begin = subparsers.add_parser("begin-run", help="创建 run，或在上一 attempt 封存后开始重试")
    begin.add_argument("project")
    begin.add_argument("--loop", required=True)
    begin.add_argument("--task", required=True, help="自然语言代表任务；独立任务用于成熟度审计")
    begin.add_argument("--run-id")
    begin.add_argument("--recovery-of")
    begin.add_argument("--synthetic", action="store_true", help="演示 run，不计入 finding 聚类")
    begin.set_defaults(handler=command_begin_run)

    open_dispatch = subparsers.add_parser(
        "open-dispatch",
        help="在 open attempt 内分配唯一的 Producer allowed-writes root",
    )
    open_dispatch.add_argument("project")
    open_dispatch.add_argument("--run-id", required=True)
    open_dispatch.add_argument("--dispatch-id", required=True)
    open_dispatch.add_argument("--context-id", required=True, help="外部 Agent/context 的稳定标识")
    open_dispatch.set_defaults(handler=command_open_dispatch)

    stall = subparsers.add_parser(
        "record-dispatch-stall",
        help="机械确认独立 dispatch 精确零文件，并消耗独立 runtime budget",
    )
    stall.add_argument("project")
    stall.add_argument("--run-id", required=True)
    stall.add_argument("--dispatch-id", required=True)
    stall.add_argument("--context-stopped", action="store_true")
    stall.add_argument("--reason", required=True)
    stall.set_defaults(handler=command_record_dispatch_stall)

    open_review = subparsers.add_parser(
        "open-human-review",
        help="冻结成品、active facts 摘要与机器方向，生成送审 subject/anchor",
    )
    open_review.add_argument("project")
    open_review.add_argument("--run-id", required=True)
    open_review.add_argument("--dispatch-id", help="open-dispatch 创建的当前非 stall dispatch")
    open_review.add_argument(
        "--machine-direction",
        choices=("PASS", "BLOCK", "UNKNOWN"),
        default="UNKNOWN",
        help="在人工反馈前冻结的机器判断方向",
    )
    open_review.set_defaults(handler=command_open_human_review)

    seal = subparsers.add_parser("seal-attempt", help="封存 attempt、manifest 与哈希；封存后拒绝覆盖")
    seal.add_argument("project")
    seal.add_argument("--run-id", required=True)
    seal.add_argument("--attempt-id")
    seal.add_argument("--dispatch-id", help="open-dispatch 创建的当前非 stall dispatch")
    seal.add_argument("--execution-status", choices=("PASS", "BLOCK"), required=True)
    seal.add_argument("--quality-status", choices=QUALITY_STATUSES, required=True)
    seal.add_argument("--release-status", choices=RELEASE_STATUSES, default="NOT_READY")
    seal.add_argument("--decision", choices=DECISIONS, required=True)
    seal.add_argument("--finding", action="append", default=[], help="可重复传入单个 Finding JSON")
    seal.add_argument("--evidence", action="append", default=[], help="可重复传入项目内相对证据路径")
    seal.add_argument("--human-accepted", choices=HUMAN_ACCEPTANCE, default="unknown")
    seal.add_argument("--machine-direction", choices=("PASS", "BLOCK", "UNKNOWN"), default="UNKNOWN")
    seal.add_argument("--human-direction", choices=("PASS", "BLOCK", "UNKNOWN"), default="UNKNOWN")
    seal.add_argument("--human-feedback-by")
    seal.add_argument("--human-feedback-at", help="带 Z 的 UTC ISO 8601 时间")
    seal.add_argument(
        "--human-feedback-evidence",
        help="位于 creative-system/approvals/attempt-feedback/ 的项目内 UTF-8 反馈依据",
    )
    seal.add_argument("--improved", choices=HUMAN_ACCEPTANCE, default="unknown")
    seal.add_argument("--stop-reason")
    seal.add_argument("--hard-contract-false-pass", action="store_true")
    seal.add_argument("--recovery-exercised", action="store_true")
    seal.add_argument("--local-recovery-preserved-upstream", action="store_true")
    seal.add_argument("--end-to-end-no-regression", action="store_true")
    seal.add_argument("--resolved-observed-problem", action="store_true")
    seal.set_defaults(handler=command_seal_attempt)

    candidate = subparsers.add_parser(
        "create-candidate", help="从至少三次独立真实 run 的重复 finding 建立隔离候选"
    )
    candidate.add_argument("project")
    candidate.add_argument("--candidate-id", required=True)
    candidate.add_argument("--finding-code", required=True)
    candidate.add_argument("--root-cause", required=True)
    candidate.add_argument("--target-component", choices=sorted(L4_TARGETS | L5_TARGETS), required=True)
    candidate.add_argument("--level", choices=("L4", "L5"))
    candidate.add_argument("--change-summary", required=True)
    candidate.add_argument("--changed-path", action="append", default=[])
    candidate.add_argument("--evaluation-plan")
    candidate.add_argument("--budget", type=int, default=3)
    candidate.add_argument("--builder-role-id", required=True)
    candidate.add_argument("--builder-context-id", required=True)
    candidate.add_argument("--builder-task-id", required=True)
    candidate.add_argument("--builder-attested-by", required=True)
    candidate.add_argument(
        "--builder-input-boundary",
        action="append",
        choices=sorted(BUILDER_INPUT_BOUNDARIES),
        default=[],
        help="Builder 允许读取的输入类别；必须显式给出安全必需集合，可重复",
    )
    candidate.set_defaults(handler=command_create_candidate)

    open_eval = subparsers.add_parser(
        "open-eval-run",
        help="为候选评价创建 controller-verified fresh empty output root",
    )
    open_eval.add_argument("project")
    open_eval.add_argument("--candidate-id", required=True)
    open_eval.add_argument("--eval-run-id", required=True)
    open_eval.add_argument("--phase", choices=("targeted", "regression", "heldout"), required=True)
    open_eval.add_argument("--evaluator-role-id", required=True)
    open_eval.add_argument("--evaluator-context-id", required=True)
    open_eval.add_argument("--evaluator-task-id", required=True)
    open_eval.add_argument("--attested-by", required=True)
    open_eval.add_argument(
        "--input-boundary",
        action="append",
        choices=sorted(EVAL_INPUT_BOUNDARIES),
        default=[],
        help="评价者允许读取的输入类别；可重复",
    )
    open_eval.set_defaults(handler=command_open_eval_run)

    seal_eval = subparsers.add_parser(
        "seal-eval-run",
        help="封存候选 eval run 的 preflight、输出清单与哈希",
    )
    seal_eval.add_argument("project")
    seal_eval.add_argument("--candidate-id", required=True)
    seal_eval.add_argument("--eval-run-id", required=True)
    seal_eval.set_defaults(handler=command_seal_eval_run)

    block_candidate = subparsers.add_parser(
        "block-candidate",
        help="为最终失格候选写入不可覆盖的 block-seal；同一候选不得解封",
    )
    block_candidate.add_argument("project")
    block_candidate.add_argument("--candidate-id", required=True)
    block_candidate.add_argument("--reason", required=True)
    block_candidate.add_argument("--evidence", action="append", default=[])
    block_candidate.set_defaults(handler=command_block_candidate)

    promote = subparsers.add_parser("promote", help="四门齐全时晋升 L4；L5 无条件拒绝")
    promote.add_argument("project")
    promote.add_argument("--candidate-id", required=True)
    promote.add_argument("--evaluation", required=True, help="位于项目内的评价与人工批准 JSON")
    promote.add_argument("--approved-by", required=True)
    promote.add_argument("--to-version")
    promote.set_defaults(handler=command_promote)

    rollback = subparsers.add_parser("rollback", help="恢复上一稳定版本，保留全部历史证据")
    rollback.add_argument("project")
    rollback.add_argument("--reason", required=True)
    rollback.add_argument("--evidence", help="可选的项目内相对证据路径")
    rollback.add_argument("--to-version")
    rollback.set_defaults(handler=command_rollback)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = args.handler(args)
    except LoopCtlError as exc:
        output({"status": "BLOCK", "error": str(exc)})
        return 2
    except KeyboardInterrupt:
        output({"status": "BLOCK", "error": "用户中断"})
        return 130
    if isinstance(result, tuple):
        payload, exit_code = result
    else:
        payload = result
        exit_code = 1 if payload.get("status") == "BLOCK" else 0
    output(payload)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
