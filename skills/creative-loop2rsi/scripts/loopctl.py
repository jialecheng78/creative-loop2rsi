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
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple


SCHEMA_VERSION = "0.1"
LEVELS = ("L0", "L1", "L2", "L3", "L4", "L5")
EXECUTION_STATUSES = ("NOT_STARTED", "RUNNING", "PASS", "BLOCK")
QUALITY_STATUSES = ("NOT_EVALUATED", "PASS", "WARN", "NEEDS_TASTE")
RELEASE_STATUSES = ("NOT_READY", "CANDIDATE", "PASS", "BLOCK")
DECISIONS = ("commit", "revise", "stop", "escalate")
HUMAN_ACCEPTANCE = ("true", "false", "unknown")
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
    "inputs/",
    "creative-system/evals/heldout/",
    "LICENSE",
    "promotion-policy",
    "human-approval-boundary",
}
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class LoopCtlError(RuntimeError):
    """Expected user-facing refusal or contract failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def project_root(value: str) -> Path:
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise LoopCtlError(f"项目目录不存在：{root}")
    if not (root / "creative-system" / "system.json").is_file():
        raise LoopCtlError(f"不是 creative-loop2rsi 项目：{root}")
    return root


def system_path(root: Path) -> Path:
    return root / "creative-system" / "system.json"


def load_system(root: Path) -> Dict[str, Any]:
    value = load_json(system_path(root))
    if not isinstance(value, dict):
        raise LoopCtlError("creative-system/system.json 顶层必须是对象")
    return value


def output(payload: Mapping[str, Any], *, stream: Any = sys.stdout) -> None:
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
            "confirmed": bool(args.charter_confirmed),
            "confirmed_by": "user" if args.charter_confirmed else None,
            "confirmed_at": "user-confirmed" if args.charter_confirmed else None,
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
        "CHARTER_STATUS": "已由使用者确认" if args.charter_confirmed else "待使用者确认",
    }
    directories = [
        "inputs",
        "outputs",
        "creative-system/loops",
        "creative-system/judges",
        "creative-system/evals/development",
        "creative-system/evals/heldout",
        "creative-system/memory",
        "creative-system/runs",
        "creative-system/candidates",
        "creative-system/releases",
        f"skills/{args.domain_skill}/agents",
        f"skills/{args.domain_skill}/references",
    ]
    for relative in directories:
        (destination / relative).mkdir(parents=True, exist_ok=True)

    text_files = {
        "README.md": "README.md.tmpl",
        "AGENTS.md": "AGENTS.md.tmpl",
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
    atomic_write_json(destination / "creative-system/system.json", initial_system(args))
    atomic_write_json(destination / "creative-system/loops/main-loop.json", initial_loop())
    atomic_write_json(destination / "creative-system/judges/hard-contract.json", hard)
    atomic_write_json(destination / "creative-system/judges/taste-gate.json", taste)


def command_init(args: argparse.Namespace) -> Dict[str, Any]:
    target = Path(args.target).expanduser().resolve()
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
            else "阅读并明确确认 creative-system/creative-charter.md"
        ),
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


def verify_sealed_attempt(attempt: Path) -> List[str]:
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
    current = {
        path.relative_to(attempt).as_posix(): sha256_file(path)
        for path in sorted(attempt.rglob("*"))
        if path.is_file() and path.name not in {"manifest.json", ".sealed.json"}
    }
    if set(current) != set(declared):
        errors.append(f"sealed attempt 文件集合已改变：{attempt}")
    for name, digest in declared.items():
        if current.get(name) != digest:
            errors.append(f"sealed attempt 文件哈希不匹配：{attempt / name}")
    return errors


def validate_project(root: Path) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []
    try:
        system = load_system(root)
    except LoopCtlError as exc:
        return {"status": "BLOCK", "errors": [str(exc)], "warnings": []}

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

    maturity = _required_dict(system.get("maturity"), "maturity", errors)
    declared_maturity = maturity.get("declared")
    if declared_maturity not in LEVELS:
        errors.append("maturity.declared 必须是 L0–L5")

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

    runs_root = root / "creative-system" / "runs"
    if runs_root.is_dir():
        for seal in sorted(runs_root.glob("*/attempts/*/.sealed.json")):
            errors.extend(verify_sealed_attempt(seal.parent))

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
    report = validate_project(root)
    report["project"] = str(root)
    return report, 0 if report["status"] == "PASS" else 1


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
    evidence: Dict[str, Any] = {
        "charter_confirmed": charter.get("confirmed") is True,
        "sealed_runs": len(finals),
        "representative_tasks": len({str(item.get("task", "")) for item in finals if item.get("task")}),
        "human_accepted": sum(item.get("human_accepted") is True for item in finals),
    }
    provable = "NONE"
    gaps: List[str] = []

    if charter.get("confirmed") is not True:
        gaps.append("请使用者明确确认 creative-system/creative-charter.md")
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
                for item in finals
                if item.get("machine_direction") in {"PASS", "BLOCK"}
                and item.get("human_direction") in {"PASS", "BLOCK"}
            ]
            agreements = sum(
                item.get("machine_direction") == item.get("human_direction") for item in direction_pairs
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


def command_begin_run(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
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
    run_dir = root / "creative-system" / "runs" / run_id
    run_path = run_dir / "run.json"
    if run_path.exists():
        run = load_json(run_path)
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
        }
    maximum_attempts = int(loop.get("retry_budget", {}).get("max_attempts", 0))
    if next_number > maximum_attempts:
        raise LoopCtlError(f"retry budget 已耗尽：最多 {maximum_attempts} 个 attempt")
    if args.recovery_of:
        ensure_id(args.recovery_of, "--recovery-of")
        if not (root / "creative-system" / "runs" / args.recovery_of / "run.json").is_file():
            raise LoopCtlError(f"--recovery-of 指向的 run 不存在：{args.recovery_of}")

    attempt_id = f"attempt-{next_number:03d}"
    attempt_dir = run_dir / "attempts" / attempt_id
    if attempt_dir.exists():
        raise LoopCtlError(f"attempt 已存在，拒绝覆盖：{attempt_dir}")
    attempt_dir.mkdir(parents=True)
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
        "next_step": "把产物、评价和 finding 写入 attempt 后运行 seal-attempt",
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


def command_seal_attempt(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("项目合同或历史证据未通过：" + "; ".join(validation["errors"]))
    run_id = ensure_id(args.run_id, "--run-id")
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
    attempt_dir = run_dir / "attempts" / attempt_id
    if not (attempt_dir / "attempt.json").is_file():
        raise LoopCtlError(f"attempt 不存在：{attempt_dir}")
    if (attempt_dir / ".sealed.json").exists():
        raise LoopCtlError(f"attempt 已封存，拒绝覆盖：{attempt_id}")

    human_accepted = bool_choice(args.human_accepted)
    improved = bool_choice(args.improved)
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

    findings: List[Dict[str, Any]] = []
    findings_dir = attempt_dir / "findings"
    for index, raw_path in enumerate(args.finding or [], start=1):
        source = Path(raw_path).expanduser().resolve()
        finding = validate_finding(load_json(source), str(source))
        findings.append(finding)
        finding_name = f"{index:03d}-{str(finding['code']).lower().replace('_', '-')}.json"
        atomic_write_json(findings_dir / finding_name, finding)

    evidence_paths: List[str] = []
    for relative in args.evidence or []:
        evidence_path = safe_relative(root, relative, "--evidence")
        if not evidence_path.exists():
            raise LoopCtlError(f"证据路径不存在：{relative}")
        evidence_paths.append(Path(relative).as_posix())

    file_entries = []
    for path in sorted(attempt_dir.rglob("*")):
        if path.is_file() and path.name not in {"manifest.json", ".sealed.json"}:
            file_entries.append(
                {"path": path.relative_to(attempt_dir).as_posix(), "sha256": sha256_file(path), "bytes": path.stat().st_size}
            )
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "kind": "AttemptManifest",
        "run_id": run_id,
        "attempt_id": attempt_id,
        "loop_id": run.get("loop_id"),
        "task": run.get("task"),
        "real_run": bool(run.get("real_run", True)),
        "sealed_at": utc_now(),
        "execution_status": args.execution_status,
        "quality_status": args.quality_status,
        "release_status": args.release_status,
        "decision": args.decision,
        "human_accepted": human_accepted,
        "machine_direction": args.machine_direction,
        "human_direction": args.human_direction,
        "improved": improved,
        "stop_reason": args.stop_reason,
        "hard_contract_false_pass": bool(args.hard_contract_false_pass),
        "recovery_exercised": bool(args.recovery_exercised),
        "local_recovery_preserved_upstream": bool(args.local_recovery_preserved_upstream),
        "end_to_end_no_regression": bool(args.end_to_end_no_regression),
        "resolved_observed_problem": bool(args.resolved_observed_problem),
        "evidence_paths": evidence_paths,
        "findings": findings,
        "files": file_entries,
    }
    manifest_path = attempt_dir / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    atomic_write_json(
        attempt_dir / ".sealed.json",
        {
            "kind": "SealedAttempt",
            "manifest_sha256": sha256_file(manifest_path),
            "sealed_at": manifest["sealed_at"],
        },
    )
    run.setdefault("attempts", []).append(attempt_id)
    run["current_attempt"] = None
    run["execution_status"] = args.execution_status
    run["quality_status"] = args.quality_status
    run["release_status"] = args.release_status
    run["last_decision"] = args.decision
    atomic_write_json(run_path, run)

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
        append_jsonl_atomic(root / "creative-system" / "memory" / "finding-index.jsonl", index_records)

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


def command_create_candidate(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
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

    system = load_system(root)
    protected = [str(item) for item in system.get("protected_surfaces", [])]
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
    if candidate_root.exists():
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
    proposal = load_json(proposal_path)
    status = load_json(status_path)
    if not isinstance(proposal, dict) or proposal.get("kind") != "LearningProposal":
        raise LoopCtlError(f"候选 proposal 无效：{candidate_id}")
    if not isinstance(status, dict):
        raise LoopCtlError(f"候选 status 无效：{candidate_id}")
    if status.get("proposal_sha256") != sha256_file(proposal_path):
        raise LoopCtlError("候选 proposal 已在创建后被改写；请创建新候选")
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
    if not changes_root.is_dir():
        return hashes
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


def evidence_paths(root: Path, section_name: str, section: Mapping[str, Any]) -> List[str]:
    raw = section.get("evidence", section.get("evidence_paths"))
    if not isinstance(raw, list) or not raw:
        raise LoopCtlError(f"{section_name} 必须提供非空 evidence 路径数组")
    paths: List[str] = []
    for item in raw:
        if not isinstance(item, str):
            raise LoopCtlError(f"{section_name}.evidence 只能包含路径字符串")
        path = safe_relative(root, item, f"{section_name}.evidence")
        if not path.is_file():
            raise LoopCtlError(f"评价证据不存在：{item}")
        paths.append(Path(item).as_posix())
    return paths


def command_promote(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
    validation = validate_project(root)
    if validation["errors"]:
        raise LoopCtlError("validate 未通过：" + "; ".join(validation["errors"]))
    candidate_id = ensure_id(args.candidate_id, "--candidate-id")
    candidate_root, proposal, candidate_status = load_candidate(root, candidate_id)
    if proposal.get("level") == "L5" or proposal.get("target_component") in L5_TARGETS:
        raise LoopCtlError("L5 属于 experimental / unvalidated；v0.1 永不自动晋升")
    if candidate_status.get("status") != "CANDIDATE":
        raise LoopCtlError("只有 CANDIDATE 状态可以晋升")
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

    evidence_file = Path(args.evaluation).expanduser().resolve()
    try:
        evidence_file.relative_to(root)
    except ValueError as exc:
        raise LoopCtlError("--evaluation 必须位于项目内") from exc
    evaluation = load_json(evidence_file)
    if not isinstance(evaluation, dict):
        raise LoopCtlError("评价证据顶层必须是对象")
    if evaluation.get("independent_evaluator") is not True or not evaluation.get("evaluator"):
        raise LoopCtlError("必须声明独立评价者，且评价者不得参与候选生成")
    evaluation_runs = evaluation.get("evaluation_runs")
    budget = proposal.get("budget", {}).get("max_evaluation_runs")
    if (
        not isinstance(evaluation_runs, int)
        or isinstance(evaluation_runs, bool)
        or evaluation_runs <= 0
        or not isinstance(budget, int)
        or evaluation_runs > budget
    ):
        raise LoopCtlError("评价运行数无效或超过候选预算")
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
    if human.get("approved") is not True or not human.get("approved_by") or not human.get("scope"):
        raise LoopCtlError("缺少明确人工批准人和批准范围")
    approved_by = single_line(args.approved_by, "--approved-by")
    if human.get("approved_by") != approved_by:
        raise LoopCtlError("--approved-by 与评价证据中的批准人不一致")
    evidence_paths(root, "targeted", targeted)
    evidence_paths(root, "regression", regression)
    evidence_paths(root, "heldout", heldout)
    evidence_paths(root, "human_approval", human)

    change_hashes = verify_candidate_changes(root, candidate_root, proposal)
    system = load_system(root)
    active = system.get("project", {}).get("active_version")
    expected = proposal.get("rollback_plan", {}).get("previous_version")
    if active != expected:
        raise LoopCtlError(f"active version 已变化；候选基线为 {expected}，当前为 {active}")
    to_version = ensure_id(args.to_version or candidate_id, "--to-version")
    if to_version == active:
        raise LoopCtlError("新版本不能与当前 active version 相同")
    release_root = root / "creative-system" / "releases" / to_version
    if release_root.exists():
        raise LoopCtlError(f"release 已存在，拒绝覆盖：{to_version}")
    release_root.mkdir(parents=True)
    atomic_write_json(release_root / "system-before.json", system)
    atomic_write_json(release_root / "evaluation.json", evaluation)
    record = {
        "schema_version": SCHEMA_VERSION,
        "kind": "PromotionRecord",
        "action": "promote",
        "state": "COMMITTED",
        "level": "L4",
        "candidate_id": candidate_id,
        "previous_version": active,
        "new_version": to_version,
        "promoted_at": utc_now(),
        "approved_by": approved_by,
        "evaluation_sha256": sha256_file(release_root / "evaluation.json"),
        "candidate_change_hashes": change_hashes,
        "rollback_to": active,
    }
    promotion_path = release_root / "promotion.json"
    atomic_write_json(promotion_path, record)

    system["project"]["active_version"] = to_version
    system["maturity"] = {
        "declared": "L4",
        "evidence": [promotion_path.relative_to(root).as_posix()],
    }
    system["statuses"]["release_status"] = "PASS"
    atomic_write_json(system_path(root), system)
    candidate_status.update(
        {
            "status": "PROMOTED",
            "promoted_version": to_version,
            "promotion_record": promotion_path.relative_to(root).as_posix(),
        }
    )
    atomic_write_json(candidate_root / "status.json", candidate_status)
    registry_path = root / "creative-system" / "releases" / "registry.json"
    registry = load_json(registry_path) if registry_path.is_file() else {
        "schema_version": SCHEMA_VERSION,
        "kind": "ReleaseRegistry",
        "history": [],
    }
    if not isinstance(registry, dict) or not isinstance(registry.get("history"), list):
        raise LoopCtlError("release registry 无效")
    registry["active_version"] = to_version
    registry["history"].append(record)
    atomic_write_json(registry_path, registry)
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "previous_version": active,
        "active_version": to_version,
        "promotion_record": promotion_path.relative_to(root).as_posix(),
    }


def command_rollback(args: argparse.Namespace) -> Dict[str, Any]:
    root = project_root(args.project)
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
        evidence = safe_relative(root, args.evidence, "--evidence")
        if not evidence.is_file():
            raise LoopCtlError(f"回滚证据不存在：{args.evidence}")
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
    atomic_write_json(rollback_path, rollback_record)
    system["project"]["active_version"] = previous
    system["statuses"]["release_status"] = "PASS"
    system["maturity"] = {
        "declared": "L3" if previous == "baseline-v1" else "L4",
        "evidence": [rollback_path.relative_to(root).as_posix()],
    }
    atomic_write_json(system_path(root), system)
    candidate_id = str(promotion.get("candidate_id"))
    candidate_root, proposal, candidate_status = load_candidate(root, candidate_id)
    candidate_status.update(
        {
            "status": "ROLLED_BACK",
            "rollback_record": rollback_path.relative_to(root).as_posix(),
        }
    )
    atomic_write_json(candidate_root / "status.json", candidate_status)
    registry["active_version"] = previous
    registry["history"].append(rollback_record)
    atomic_write_json(registry_path, registry)
    return {
        "status": "PASS",
        "active_version": previous,
        "rolled_back_from": active,
        "rollback_record": rollback_path.relative_to(root).as_posix(),
        "history_retained": True,
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
    init.add_argument("--charter-confirmed", action="store_true")
    init.set_defaults(handler=command_init)

    validate = subparsers.add_parser("validate", help="检查 Schema、引用、不变量与封存哈希")
    validate.add_argument("project")
    validate.set_defaults(handler=command_validate)

    audit = subparsers.add_parser("audit", help="给出当前可证明成熟度与下一等级缺口")
    audit.add_argument("project")
    audit.set_defaults(handler=command_audit)

    begin = subparsers.add_parser("begin-run", help="创建 run，或在上一 attempt 封存后开始重试")
    begin.add_argument("project")
    begin.add_argument("--loop", required=True)
    begin.add_argument("--task", required=True, help="自然语言代表任务；独立任务用于成熟度审计")
    begin.add_argument("--run-id")
    begin.add_argument("--recovery-of")
    begin.add_argument("--synthetic", action="store_true", help="演示 run，不计入 finding 聚类")
    begin.set_defaults(handler=command_begin_run)

    seal = subparsers.add_parser("seal-attempt", help="封存 attempt、manifest 与哈希；封存后拒绝覆盖")
    seal.add_argument("project")
    seal.add_argument("--run-id", required=True)
    seal.add_argument("--attempt-id")
    seal.add_argument("--execution-status", choices=("PASS", "BLOCK"), required=True)
    seal.add_argument("--quality-status", choices=QUALITY_STATUSES, required=True)
    seal.add_argument("--release-status", choices=RELEASE_STATUSES, default="NOT_READY")
    seal.add_argument("--decision", choices=DECISIONS, required=True)
    seal.add_argument("--finding", action="append", default=[], help="可重复传入单个 Finding JSON")
    seal.add_argument("--evidence", action="append", default=[], help="可重复传入项目内相对证据路径")
    seal.add_argument("--human-accepted", choices=HUMAN_ACCEPTANCE, default="unknown")
    seal.add_argument("--machine-direction", choices=("PASS", "BLOCK", "UNKNOWN"), default="UNKNOWN")
    seal.add_argument("--human-direction", choices=("PASS", "BLOCK", "UNKNOWN"), default="UNKNOWN")
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
    candidate.add_argument("--budget", type=int, default=12)
    candidate.set_defaults(handler=command_create_candidate)

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
