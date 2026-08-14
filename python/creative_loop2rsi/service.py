"""Structured app-side governance API.

This module never accepts or reads a model credential.  Requests arrive over
stdin from the trusted desktop main process and are limited to a small
operation allowlist.  Model execution remains outside the Python controller.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from argparse import Namespace
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from ._legacy import load_controller


APP_PROTOCOL_VERSION = "1"
ALLOWED_OPERATIONS = {
    "begin_work",
    "bootstrap_intent",
    "candidate_summary",
    "cancel_work",
    "complete_work",
    "create_system_lab_candidate",
    "record_feedback",
    "resume_feedback",
    "seal_feedback",
    "submit_feedback",
    "system_snapshot",
}
SENSITIVE_FIELD_NAMES = {
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "credential",
    "credentials",
    "key",
    "password",
    "secret",
    "token",
}
FEEDBACK_ACTIONS = {"keep", "reject", "rewrite", "edit"}
SYSTEM_LAB_TARGETS = {
    "app-scaffold",
    "controller",
    "improvement-controller",
    "judge",
    "learning-policy",
    "model-gateway",
    "runtime-profile",
}


class AppRequestError(RuntimeError):
    """An expected, user-actionable app bridge refusal."""


def _reject_sensitive_fields(value: Any, path: str = "request") -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            normalized = str(key).casefold().replace("-", "_")
            if (
                normalized in SENSITIVE_FIELD_NAMES
                or normalized.endswith("_api_key")
                or normalized.endswith("_access_token")
            ):
                raise AppRequestError(
                    f"{path}.{key} 不允许进入 Python Controller；凭据只能由 Model Gateway 持有"
                )
            _reject_sensitive_fields(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _reject_sensitive_fields(nested, f"{path}[{index}]")


def _mapping(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, Mapping):
        raise AppRequestError(f"{label} 必须是对象")
    return dict(value)


def _exact_keys(value: Mapping[str, Any], label: str, allowed: set[str]) -> None:
    unexpected = sorted(str(key) for key in value if key not in allowed)
    if unexpected:
        raise AppRequestError(f"{label} 包含不允许字段：{', '.join(unexpected)}")


def _text(value: Any, label: str, *, maximum: int, multiline: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AppRequestError(f"{label} 不能为空")
    if len(value) > maximum:
        raise AppRequestError(f"{label} 超过 {maximum} 字符")
    if not multiline and any(character in value for character in "\r\n"):
        raise AppRequestError(f"{label} 必须是单行文本")
    return value if multiline else value.strip()


def _id(value: Any, label: str) -> str:
    text = _text(value, label, maximum=120)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", text):
        raise AppRequestError(f"{label} 必须是 lower-kebab-case")
    return text


def _project_path(value: Any) -> Path:
    if not isinstance(value, str) or not value:
        raise AppRequestError("project 必须是绝对路径")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise AppRequestError("project 必须是绝对路径")
    if path.is_symlink():
        raise AppRequestError("project 不得是符号链接")
    return path.resolve()


def _record(core: Any, kind: str, record_id: str, values: Mapping[str, Any]) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "schema_version": core.APP_SCHEMA_VERSION,
        "kind": kind,
        "id": record_id,
        "created_at": core.utc_now(),
        "source_refs": [],
        **dict(values),
    }
    record["content_hash"] = core.app_record_content_hash(record)
    return record


def _progressive_charter(display_name: str, intent: str) -> str:
    return (
        f"# {display_name} 基础创作约束\n\n"
        "## 用户直接提出的初始意图\n\n"
        f"{intent}\n\n"
        "## 尚未由用户决定\n\n"
        "受众、最小成品、具体审美偏好与领域规则尚未确认。模型观察只能作为暂时假设，"
        "不得自动写成用户规则。\n\n"
        "## 人的最终决定权\n\n"
        "- 用户决定什么内容值得保留。\n"
        "- 第一次输入只授权一次校准创作，不等于确认完整创作宪法。\n"
        "- 系统候选必须经过隔离评价和用户明确采用，才能成为当前版本。\n"
        "- 系统不得自动修改本文件、held-out、晋升政策或人工审批边界。\n"
    )


def _work_task_receipt(
    core: Any,
    project: Path,
    *,
    run_id: str,
    work_id: str,
    task: str,
    context_sha256: str,
) -> Dict[str, Any]:
    task_bytes = task.encode("utf-8")
    if len(task_bytes) > 100000:
        raise AppRequestError("task 超过 100 KB")
    task_sha256 = core.sha256_bytes(task_bytes)
    task_reference = f"work-task-sha256:{task_sha256}"
    relative = f"creative-system/approvals/work-tasks/{run_id}.json"
    path = project / relative
    if os.path.lexists(str(path)):
        existing_path = core.regular_project_file(project, relative, "WorkTaskReceipt")
        receipt = core.load_json(existing_path)
        if (
            not isinstance(receipt, dict)
            or receipt.get("schema_version") != core.APP_SCHEMA_VERSION
            or receipt.get("kind") != "WorkTaskReceipt"
            or receipt.get("id") != f"task-{run_id}"
            or receipt.get("run_id") != run_id
            or receipt.get("work_id") != work_id
            or receipt.get("task") != task
            or receipt.get("task_sha256") != task_sha256
            or receipt.get("task_bytes") != len(task_bytes)
            or receipt.get("task_reference") != task_reference
            or receipt.get("context_sha256") != context_sha256
            or receipt.get("authority") != "direct-user-input"
            or receipt.get("public_log_disclosure") != "reference-only"
            or receipt.get("content_hash") != core.app_record_content_hash(receipt)
        ):
            raise AppRequestError("同一 run 已绑定不同创作任务，拒绝覆盖")
        return {
            "path": relative,
            "sha256": core.sha256_file(existing_path),
            "task_sha256": task_sha256,
            "task_reference": task_reference,
            "context_sha256": context_sha256,
            "idempotent": True,
        }

    receipt = _record(
        core,
        "WorkTaskReceipt",
        f"task-{run_id}",
        {
            "run_id": run_id,
            "work_id": work_id,
            "task": task,
            "task_sha256": task_sha256,
            "task_bytes": len(task_bytes),
            "task_reference": task_reference,
            "context_sha256": context_sha256,
            "authority": "direct-user-input",
            "public_log_disclosure": "reference-only",
        },
    )
    core.guarded_mkdir_project(project, path.parent, "work task receipt root")
    core.atomic_create_json(path, receipt)
    return {
        "path": relative,
        "sha256": core.sha256_file(path),
        "task_sha256": task_sha256,
        "task_reference": task_reference,
        "context_sha256": context_sha256,
        "idempotent": False,
    }


def _work_task_context_sha256(core: Any, project: Path, run_id: str) -> str:
    relative = f"creative-system/approvals/work-tasks/{run_id}.json"
    path = core.regular_project_file(project, relative, "WorkTaskReceipt")
    receipt = core.load_json(path)
    context_sha256 = receipt.get("context_sha256") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or receipt.get("kind") != "WorkTaskReceipt"
        or receipt.get("run_id") != run_id
        or receipt.get("content_hash") != core.app_record_content_hash(receipt)
        or not isinstance(context_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", context_sha256)
    ):
        raise AppRequestError("WorkTaskReceipt context 绑定无效")
    return context_sha256


def _bootstrap_intent(payload: Mapping[str, Any]) -> Dict[str, Any]:
    core = load_controller()
    project = _project_path(payload.get("project"))
    system_id = _id(payload.get("system_id"), "system_id")
    display_name = _text(payload.get("display_name"), "display_name", maximum=120)
    intent = _text(payload.get("intent"), "intent", maximum=100000, multiline=True)
    domain_skill = _id(
        payload.get("domain_skill") or f"{system_id}-loop", "domain_skill"
    )
    if project.exists() and (not project.is_dir() or any(project.iterdir())):
        raise AppRequestError(f"拒绝覆盖非空目标：{project}")
    if project.is_symlink():
        raise AppRequestError(f"拒绝把符号链接作为初始化目标：{project}")

    args = Namespace(
        target=str(project),
        project_name=display_name,
        creative_goal=intent,
        minimum_product="尚未由使用者明确",
        representative_task=intent,
        constraints="除人的最终决定权与系统安全边界外，尚未由使用者明确",
        taste="尚未由使用者明确；模型推测不得成为规则",
        domain_skill=domain_skill,
        charter_confirmed=False,
        charter_confirmed_by=None,
        charter_confirmed_at=None,
        charter_confirmation_evidence=None,
    )
    project.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{project.name}.app-init-", dir=str(project.parent))
    )
    try:
        core.write_initialized_project(staging, args)
        core.atomic_write_text(
            staging / "creative-system" / "creative-charter.md",
            _progressive_charter(display_name, intent),
        )
        receipt = _record(
            core,
            "InitialIntentReceipt",
            f"intent-{system_id}",
            {
                "system_id": system_id,
                "intent": intent,
                "authority": "direct-user-input",
                "user_action": "start-creation",
            },
        )
        receipt_relative = core.initial_intent_receipt_relative(receipt)
        receipt_path = staging / receipt_relative
        core.atomic_create_json(receipt_path, receipt)
        system = core.load_system(staging)
        system["project"]["id"] = system_id
        system["onboarding"] = {
            "mode": "progressive-app",
            "state": "BOOTSTRAP",
            "constitution_epoch": 0,
            "initial_intent_receipt": receipt_relative,
            "initial_intent_receipt_sha256": core.sha256_file(receipt_path),
        }
        system["learning_policy"]["independence_unit"] = "work"
        protected = set(str(item) for item in system.get("protected_surfaces", []))
        protected.update(
            {
                "creative-system/approvals/initial-intent/",
                "creative-system/approvals/app-feedback/",
                "creative-system/approvals/work-tasks/",
            }
        )
        system["protected_surfaces"] = sorted(protected)
        core.atomic_write_json(core.system_path(staging), system)
        report = core.validate_project(staging)
        if report["errors"]:
            raise AppRequestError(
                "应用项目未通过内部验证：" + "; ".join(report["errors"])
            )
        if project.exists():
            project.rmdir()
        os.replace(str(staging), str(project))
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return {
        "status": "PASS",
        "project": str(project),
        "system_id": system_id,
        "operating_stage": "BOOTSTRAP",
        "provable_maturity": "NONE",
        "initial_intent_receipt": receipt_relative,
        "charter_confirmed": False,
        "next_action": "begin_work",
    }


def _begin_work(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "context_id",
            "context_sha256",
            "dispatch_id",
            "loop",
            "project",
            "recovery_of",
            "run_id",
            "task",
            "work_id",
        },
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    validation = core.validate_project(project)
    if validation["errors"]:
        raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
    work_id = _id(payload.get("work_id"), "work_id")
    run_id_value = payload.get("run_id")
    run_id = _id(
        run_id_value if run_id_value is not None else core.generated_run_id(), "run_id"
    )
    task = _text(payload.get("task"), "task", maximum=100000, multiline=True)
    current_intent = _initial_intent_snapshot(core, project, core.load_system(project))
    context_sha256 = payload.get("context_sha256", current_intent["sha256"])
    if (
        not isinstance(context_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", context_sha256)
        or context_sha256 != current_intent["sha256"]
    ):
        raise AppRequestError("context_sha256 必须绑定当前 InitialIntentReceipt")
    task_receipt = _work_task_receipt(
        core,
        project,
        run_id=run_id,
        work_id=work_id,
        task=task,
        context_sha256=context_sha256,
    )
    task_reference = str(task_receipt["task_reference"])
    loop_id = _id(payload.get("loop") or "main-loop", "loop")
    raw_dispatch_id = payload.get("dispatch_id")
    raw_context_id = payload.get("context_id")
    if raw_dispatch_id is not None:
        _id(raw_dispatch_id, "dispatch_id")
    if raw_context_id is not None:
        _text(raw_context_id, "context_id", maximum=200)
    existing_run_dir = (
        project / "creative-system" / "runs" / run_id
    )
    if existing_run_dir.is_dir():
        existing_id, _, _, existing, attempt_id, attempt_dir = core.open_attempt_context(
            project, run_id
        )
        if (
            existing.get("work_id") != work_id
            or existing.get("task") != task_reference
            or existing.get("loop_id") != loop_id
            or existing.get("recovery_of") != payload.get("recovery_of")
        ):
            raise AppRequestError("已有 run 与本次 work/task/loop 不一致")
        result = {
            "status": "PASS",
            "run_id": existing_id,
            "attempt_id": attempt_id,
            "attempt_path": attempt_dir.relative_to(project).as_posix(),
            "active_version_at_start": existing.get("active_version_at_start"),
            "provable_maturity_at_start": existing.get("provable_maturity_at_start"),
            "run_phase": existing.get("run_phase"),
            "post_l4_iteration_index": existing.get("post_l4_iteration_index"),
            "idempotent_run": True,
        }
    else:
        args = Namespace(
            project=str(project),
            loop=loop_id,
            task=task_reference,
            work_id=work_id,
            run_id=run_id,
            recovery_of=payload.get("recovery_of"),
            synthetic=False,
        )
        result = core.command_begin_run(args)
        result["idempotent_run"] = False

    run_id = str(result["run_id"])
    dispatch_id = _id(
        raw_dispatch_id or f"dispatch-{run_id}", "dispatch_id"
    )
    context_id = _text(
        raw_context_id or f"app-{run_id}", "context_id", maximum=200
    )
    _, _, _, _, _, attempt_dir = core.open_attempt_context(project, run_id)
    dispatch_dir = attempt_dir / "dispatches" / dispatch_id
    if dispatch_dir.is_dir() and not dispatch_dir.is_symlink():
        record = core.load_dispatch_record(project, attempt_dir, dispatch_dir)
        stall = core.load_dispatch_stall(project, attempt_dir, dispatch_dir, record)
        if stall is not None:
            raise AppRequestError("dispatch 已结束；恢复时必须使用新的 dispatch_id")
        if record.get("context_id") != context_id:
            raise AppRequestError("同一 dispatch_id 已绑定不同 context_id")
        dispatch = {
            "status": "PASS",
            "dispatch_id": dispatch_id,
            "allowed_writes_root": record.get("allowed_writes_root"),
            "idempotent": True,
        }
    else:
        dispatch = core.command_open_dispatch(
            Namespace(
                project=str(project),
                run_id=run_id,
                dispatch_id=dispatch_id,
                context_id=context_id,
            )
        )
        dispatch["idempotent"] = False
    result.update(
        {
            "work_id": work_id,
            "task_receipt": task_receipt["path"],
            "task_receipt_sha256": task_receipt["sha256"],
            "task_sha256": task_receipt["task_sha256"],
            "context_sha256": context_sha256,
            "dispatch_id": dispatch_id,
            "allowed_writes_root": dispatch["allowed_writes_root"],
            "idempotent_dispatch": bool(dispatch.get("idempotent")),
        }
    )
    return result


def _cancel_work(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {"dispatch_id", "project", "reason", "run_id", "runtime_provenance"},
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    run_id = _id(payload.get("run_id"), "run_id")
    dispatch_id = _id(payload.get("dispatch_id"), "dispatch_id")
    reason = _text(payload.get("reason"), "reason", maximum=500)
    _, _, _, _, attempt_id, attempt_dir = core.open_attempt_context(project, run_id)
    dispatch_dir = attempt_dir / "dispatches" / dispatch_id
    record = core.load_dispatch_record(project, attempt_dir, dispatch_dir)
    provenance_relative: Optional[str] = None
    provenance_sha256: Optional[str] = None
    if payload.get("runtime_provenance") is not None:
        provenance = _runtime_provenance(
            core,
            payload.get("runtime_provenance"),
            run_id,
            require_completed=False,
            fallback_created_at=record.get("opened_at"),
            expected_context_sha256=_work_task_context_sha256(
                core, project, run_id
            ),
        )
        provenance_relative = (
            attempt_dir / f"runtime-provenance-{dispatch_id}.json"
        ).relative_to(project).as_posix()
        provenance_path = project / provenance_relative
        provenance_bytes = (
            json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        if os.path.lexists(str(provenance_path)):
            if provenance_path.is_symlink() or not provenance_path.is_file():
                raise AppRequestError("取消运行来源路径被非普通文件占用")
            if provenance_path.read_bytes() != provenance_bytes:
                raise AppRequestError("同一 dispatch 已绑定不同取消运行来源")
        else:
            core.atomic_create_bytes(provenance_path, provenance_bytes)
        provenance_sha256 = core.sha256_bytes(provenance_bytes)
    existing = core.load_dispatch_stall(project, attempt_dir, dispatch_dir, record)
    if existing is not None:
        if existing.get("orchestrator_attestation", {}).get("reason") != reason:
            raise AppRequestError("dispatch 已由不同原因结束，拒绝覆盖")
        return {
            "status": "PASS" if existing.get("state") != "BUDGET_EXHAUSTED" else "BLOCK",
            "run_id": run_id,
            "attempt_id": attempt_id,
            "dispatch_id": dispatch_id,
            "reason_code": existing.get("reason_code"),
            "state": existing.get("state"),
            "runtime_provenance": provenance_relative,
            "runtime_provenance_sha256": provenance_sha256,
            "idempotent": True,
        }
    result = core.command_record_dispatch_stall(
        Namespace(
            project=str(project),
            run_id=run_id,
            dispatch_id=dispatch_id,
            context_stopped=True,
            reason=reason,
        )
    )
    result["idempotent"] = False
    result["runtime_provenance"] = provenance_relative
    result["runtime_provenance_sha256"] = provenance_sha256
    return result


def _runtime_provenance(
    core: Any,
    value: Any,
    run_id: str,
    *,
    require_completed: bool = True,
    fallback_created_at: Optional[str] = None,
    expected_context_sha256: Optional[str] = None,
) -> Dict[str, Any]:
    raw = _mapping(value, "runtime_provenance")
    _exact_keys(
        raw,
        "runtime_provenance",
        {
            "app_version",
            "completed_at",
            "controller_version",
            "dsh_version",
            "completed_requests",
            "context_sha256",
            "failed_requests",
            "parameters",
            "profile_sha256",
            "request_count",
            "requests",
            "requested_model",
            "response_id",
            "returned_model",
            "system_fingerprint",
            "usage",
        },
    )
    requested_model = _text(
        raw.get("requested_model"), "runtime_provenance.requested_model", maximum=80
    )
    if requested_model not in {"deepseek-v4-pro", "deepseek-v4-flash"}:
        raise AppRequestError("runtime_provenance.requested_model 无效")
    context_sha256 = _text(
        raw.get("context_sha256"),
        "runtime_provenance.context_sha256",
        maximum=64,
    )
    if (
        not re.fullmatch(r"[0-9a-f]{64}", context_sha256)
        or (
            expected_context_sha256 is not None
            and context_sha256 != expected_context_sha256
        )
    ):
        raise AppRequestError("runtime_provenance.context_sha256 未绑定 WorkTaskReceipt")
    returned_model = raw.get("returned_model")
    fingerprint = raw.get("system_fingerprint")
    response_id = raw.get("response_id")
    if require_completed:
        returned_model = _text(
            returned_model, "runtime_provenance.returned_model", maximum=160
        )
        fingerprint = _text(
            fingerprint,
            "runtime_provenance.system_fingerprint",
            maximum=300,
        )
        response_id = _text(
            response_id, "runtime_provenance.response_id", maximum=300
        )
    else:
        for label, item, maximum in (
            ("returned_model", returned_model, 160),
            ("system_fingerprint", fingerprint, 300),
            ("response_id", response_id, 300),
        ):
            if item is not None:
                _text(item, f"runtime_provenance.{label}", maximum=maximum)
    profile_sha256 = _text(
        raw.get("profile_sha256"), "runtime_provenance.profile_sha256", maximum=64
    )
    if not re.fullmatch(r"[0-9a-f]{64}", profile_sha256):
        raise AppRequestError("runtime_provenance.profile_sha256 必须是 SHA256")
    parameters = _mapping(raw.get("parameters"), "runtime_provenance.parameters")
    _exact_keys(
        parameters,
        "runtime_provenance.parameters",
        {"max_tokens", "reasoning_effort", "thinking"},
    )
    if parameters != {
        "thinking": "enabled",
        "reasoning_effort": "high",
        "max_tokens": 16384,
    }:
        raise AppRequestError("runtime_provenance.parameters 与 v1 固定模型策略不一致")
    usage = _mapping(raw.get("usage"), "runtime_provenance.usage")
    allowed_usage = {
        "cache_hit_tokens",
        "cache_miss_tokens",
        "completion_tokens",
        "prompt_tokens",
        "total_tokens",
    }
    _exact_keys(usage, "runtime_provenance.usage", allowed_usage)
    normalized_usage: Dict[str, int] = {}
    for key, item in usage.items():
        if not isinstance(item, int) or isinstance(item, bool) or item < 0:
            raise AppRequestError(f"runtime_provenance.usage.{key} 必须是非负整数")
        normalized_usage[str(key)] = item
    requests = raw.get("requests")
    if not isinstance(requests, list):
        raise AppRequestError("runtime_provenance.requests 必须是数组")
    normalized_requests: list[Dict[str, Any]] = []
    for index, request in enumerate(requests, start=1):
        item = _mapping(request, f"runtime_provenance.requests[{index - 1}]")
        _exact_keys(
            item,
            f"runtime_provenance.requests[{index - 1}]",
            {
                "completed_at",
                "error_code",
                "http_status",
                "request_number",
                "response_id",
                "returned_model",
                "started_at",
                "status",
                "system_fingerprint",
                "usage",
            },
        )
        request_number = item.get("request_number")
        if request_number != index:
            raise AppRequestError("runtime provenance request_number 必须从 1 连续递增")
        status = item.get("status")
        if status not in {"STARTED", "COMPLETED", "FAILED"}:
            raise AppRequestError("runtime provenance request status 无效")
        started_at = core.utc_timestamp(
            item.get("started_at"), f"runtime request {index}.started_at"
        )
        completed_at = item.get("completed_at")
        if completed_at is not None:
            completed_at = core.utc_timestamp(
                completed_at, f"runtime request {index}.completed_at"
            )
            if core.utc_datetime(completed_at, "completed_at") < core.utc_datetime(
                started_at, "started_at"
            ):
                raise AppRequestError("runtime request completed_at 早于 started_at")
        if status in {"COMPLETED", "FAILED"} and completed_at is None:
            raise AppRequestError("终态 runtime request 必须有 completed_at")
        http_status = item.get("http_status")
        if http_status is not None and (
            not isinstance(http_status, int)
            or isinstance(http_status, bool)
            or http_status < 100
            or http_status > 599
        ):
            raise AppRequestError("runtime request http_status 无效")
        nullable_text: Dict[str, Optional[str]] = {}
        for key, maximum in (
            ("error_code", 160),
            ("response_id", 300),
            ("returned_model", 160),
            ("system_fingerprint", 300),
        ):
            raw_text = item.get(key)
            nullable_text[key] = (
                None
                if raw_text is None
                else _text(raw_text, f"runtime request {index}.{key}", maximum=maximum)
            )
        request_usage = _mapping(
            item.get("usage", {}), f"runtime request {index}.usage"
        )
        _exact_keys(
            request_usage, f"runtime request {index}.usage", allowed_usage
        )
        normalized_request_usage: Dict[str, int] = {}
        for key, value_item in request_usage.items():
            if (
                not isinstance(value_item, int)
                or isinstance(value_item, bool)
                or value_item < 0
            ):
                raise AppRequestError(
                    f"runtime request {index}.usage.{key} 必须是非负整数"
                )
            normalized_request_usage[str(key)] = value_item
        if status == "COMPLETED" and (
            nullable_text["response_id"] is None
            or nullable_text["returned_model"] is None
            or nullable_text["system_fingerprint"] is None
            or nullable_text["error_code"] is not None
        ):
            raise AppRequestError("COMPLETED runtime request 缺少成功来源或含 error")
        if status == "FAILED" and nullable_text["error_code"] is None:
            raise AppRequestError("FAILED runtime request 必须有 error_code")
        normalized_requests.append(
            {
                "request_number": request_number,
                "started_at": started_at,
                "completed_at": completed_at,
                "status": status,
                "http_status": http_status,
                **nullable_text,
                "usage": normalized_request_usage,
            }
        )
    request_count = raw.get("request_count")
    completed_requests = raw.get("completed_requests")
    failed_requests = raw.get("failed_requests")
    for label, item in (
        ("request_count", request_count),
        ("completed_requests", completed_requests),
        ("failed_requests", failed_requests),
    ):
        if not isinstance(item, int) or isinstance(item, bool) or item < 0:
            raise AppRequestError(f"runtime_provenance.{label} 必须是非负整数")
    if (
        request_count != len(normalized_requests)
        or completed_requests
        != sum(item["status"] == "COMPLETED" for item in normalized_requests)
        or failed_requests
        != sum(item["status"] == "FAILED" for item in normalized_requests)
    ):
        raise AppRequestError("runtime provenance aggregate 与 requests ledger 不一致")
    if require_completed and completed_requests < 1:
        raise AppRequestError("成功作品至少需要一条 COMPLETED runtime request")
    runtime_completed_at = raw.get("completed_at")
    if runtime_completed_at is not None:
        runtime_completed_at = core.utc_timestamp(
            runtime_completed_at, "runtime_provenance.completed_at"
        )
    if require_completed and runtime_completed_at is None:
        raise AppRequestError("成功 runtime provenance 缺少 completed_at")
    completed_items = [
        item for item in normalized_requests if item["status"] == "COMPLETED"
    ]
    if require_completed and completed_items:
        last_completed = completed_items[-1]
        if (
            response_id != last_completed["response_id"]
            or returned_model != last_completed["returned_model"]
            or fingerprint != last_completed["system_fingerprint"]
        ):
            raise AppRequestError("runtime provenance 顶层成功来源与最后 COMPLETED request 不一致")
    return _record(
        core,
        "RuntimeProvenance",
        f"runtime-{run_id}",
        {
            "created_at": runtime_completed_at
            or (
                core.utc_timestamp(fallback_created_at, "runtime_provenance.created_at")
                if fallback_created_at is not None
                else core.utc_now()
            ),
            "completed_at": runtime_completed_at,
            "run_id": run_id,
            "context_sha256": context_sha256,
            "requested_model": requested_model,
            "returned_model": returned_model,
            "system_fingerprint": fingerprint,
            "response_id": response_id,
            "parameters": parameters,
            "usage": normalized_usage,
            "request_count": request_count,
            "completed_requests": completed_requests,
            "failed_requests": failed_requests,
            "requests": normalized_requests,
            "app_version": _text(
                raw.get("app_version"), "runtime_provenance.app_version", maximum=80
            ),
            "controller_version": _text(
                raw.get("controller_version"),
                "runtime_provenance.controller_version",
                maximum=80,
            ),
            "dsh_version": _text(
                raw.get("dsh_version"), "runtime_provenance.dsh_version", maximum=80
            ),
            "profile_sha256": profile_sha256,
            "authority": "main-observed-model-gateway",
            "reasoning_content_persisted": False,
        },
    )


def _complete_work(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Atomically bind a completed model response to one open attempt.

    A retry may finish the missing review anchor, but it may never replace the
    first response or provenance already bound to the run.
    """
    _exact_keys(
        payload,
        "payload",
        {"dispatch_id", "output", "project", "run_id", "runtime_provenance"},
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    run_id = _id(payload.get("run_id"), "run_id")
    output = _text(payload.get("output"), "output", maximum=500000, multiline=True)
    output_bytes = output.encode("utf-8")
    provenance = _runtime_provenance(
        core,
        payload.get("runtime_provenance"),
        run_id,
        expected_context_sha256=_work_task_context_sha256(core, project, run_id),
    )
    provenance_bytes = (
        json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")

    with core.exclusive_controller_lock(project):
        validation = core.validate_project(project)
        if validation["errors"]:
            raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
        _, _, _, run, attempt_id, attempt_dir = core.open_attempt_context(project, run_id)
        open_dispatches = []
        for dispatch_dir in core.dispatch_directories(attempt_dir):
            record = core.load_dispatch_record(project, attempt_dir, dispatch_dir)
            if core.load_dispatch_stall(project, attempt_dir, dispatch_dir, record) is None:
                open_dispatches.append(dispatch_dir)
        raw_dispatch_id = payload.get("dispatch_id")
        if raw_dispatch_id is None:
            if len(open_dispatches) != 1:
                raise AppRequestError("当前 attempt 必须恰好有一个 open dispatch")
            dispatch_id = open_dispatches[0].name
        else:
            dispatch_id = _id(raw_dispatch_id, "dispatch_id")
            if attempt_dir / "dispatches" / dispatch_id not in open_dispatches:
                raise AppRequestError("dispatch_id 不是当前 open dispatch")
        artifact_path = attempt_dir / "dispatches" / dispatch_id / "artifacts" / "work.md"
        provenance_path = attempt_dir / "runtime-provenance.json"
        for path, expected, label in (
            (artifact_path, output_bytes, "作品"),
            (provenance_path, provenance_bytes, "运行来源"),
        ):
            if os.path.lexists(str(path)):
                if path.is_symlink() or not path.is_file():
                    raise AppRequestError(f"{label}路径被非普通文件占用")
                if path.read_bytes() != expected:
                    raise AppRequestError(f"当前 run 已绑定不同{label}，拒绝覆盖")
            else:
                core.atomic_create_bytes(path, expected)
    review = core.command_open_human_review(
        Namespace(
            project=str(project),
            run_id=run_id,
            dispatch_id=dispatch_id,
            machine_direction="UNKNOWN",
        )
    )
    return {
        "status": "PASS",
        "run_id": run_id,
        "work_id": run.get("work_id", run_id),
        "attempt_id": attempt_id,
        "dispatch_id": dispatch_id,
        "artifact": artifact_path.relative_to(project).as_posix(),
        "artifact_sha256": core.sha256_bytes(output_bytes),
        "runtime_provenance": provenance_path.relative_to(project).as_posix(),
        "runtime_provenance_sha256": core.sha256_bytes(provenance_bytes),
        "review_subject": review["review_subject"],
        "review_available_at": review["review_available_at"],
        "idempotent": bool(review.get("idempotent")),
        "next_action": "record_feedback",
    }


def _read_snapshot_artifact(path: Path, label: str) -> tuple[bytes, str]:
    raw = path.read_bytes()
    if len(raw) > 2 * 1024 * 1024:
        raise AppRequestError(f"{label}超过应用恢复读取上限")
    try:
        return raw, raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AppRequestError(f"{label}不是 UTF-8") from exc


def _manifest_work_artifact(
    core: Any, project: Path, attempt_dir: Path, manifest: Mapping[str, Any]
) -> Path:
    artifact_root = manifest.get("artifact_root")
    entries = manifest.get("artifact_files")
    if not isinstance(artifact_root, str) or not isinstance(entries, list):
        raise AppRequestError("封存作品缺少 artifact 绑定")
    work_entry = next(
        (
            item
            for item in entries
            if isinstance(item, dict) and item.get("path") == "work.md"
        ),
        None,
    )
    if not isinstance(work_entry, dict):
        raise AppRequestError("封存作品没有绑定 work.md")
    candidate = (attempt_dir / artifact_root / "work.md").resolve()
    try:
        candidate.relative_to(attempt_dir.resolve())
    except ValueError as exc:
        raise AppRequestError("封存作品路径越界") from exc
    if candidate.is_symlink() or not candidate.is_file():
        raise AppRequestError("封存作品不是普通文件")
    if (
        work_entry.get("sha256") != core.sha256_file(candidate)
        or work_entry.get("bytes") != candidate.stat().st_size
    ):
        raise AppRequestError("封存作品与 manifest 不一致")
    return candidate


def _sealed_user_revision(
    core: Any,
    project: Path,
    manifest: Mapping[str, Any],
) -> Optional[Path]:
    human = manifest.get("human_feedback_receipt")
    source = human.get("source_evidence") if isinstance(human, dict) else None
    source_sha256 = source.get("sha256") if isinstance(source, dict) else None
    if not isinstance(source_sha256, str):
        return None
    feedback_root = project / "creative-system" / "approvals" / "app-feedback"
    matches: list[Dict[str, Any]] = []
    if feedback_root.is_dir() and not feedback_root.is_symlink():
        for path in sorted(feedback_root.glob("receipt-*.json")):
            if path.is_symlink() or not path.is_file():
                continue
            raw = core.load_json(path)
            source_evidence = (
                raw.get("source_evidence") if isinstance(raw, dict) else None
            )
            if (
                isinstance(raw, dict)
                and raw.get("run_id") == manifest.get("run_id")
                and raw.get("attempt_id") == manifest.get("attempt_id")
                and isinstance(source_evidence, dict)
                and source_evidence.get("sha256") == source_sha256
            ):
                matches.append(
                    _load_app_feedback_receipt(
                        core, project, path.relative_to(project).as_posix()
                    )
                )
    if len(matches) > 1:
        raise AppRequestError("封存作品匹配到多个 AppFeedbackReceipt")
    if not matches or matches[0].get("action") != "edit":
        return None
    revision = matches[0].get("user_revision")
    if not isinstance(revision, dict) or not isinstance(revision.get("path"), str):
        raise AppRequestError("edit receipt 缺少用户修订稿")
    return core.regular_project_file(
        project, revision["path"], "AppFeedbackReceipt user revision"
    )


def _snapshot_runtime_provenance_sha256(
    core: Any,
    project: Path,
    run_id: str,
    attempt_dir: Path,
) -> Optional[str]:
    path = attempt_dir / "runtime-provenance.json"
    if not os.path.lexists(str(path)):
        return None
    if path.is_symlink() or not path.is_file():
        raise AppRequestError("RuntimeProvenance 不是普通文件")
    raw = core.load_json(path)
    if (
        not isinstance(raw, dict)
        or raw.get("kind") != "RuntimeProvenance"
        or raw.get("run_id") != run_id
        or raw.get("authority") != "main-observed-model-gateway"
        or raw.get("reasoning_content_persisted") is not False
        or raw.get("content_hash") != core.app_record_content_hash(raw)
        or raw.get("context_sha256")
        != _work_task_context_sha256(core, project, run_id)
    ):
        raise AppRequestError("RuntimeProvenance 与作品任务绑定不一致")
    return core.sha256_file(path)


def _attempt_snapshot(
    core: Any,
    project: Path,
    run: Mapping[str, Any],
    run_dir: Path,
    attempt_dir: Path,
) -> Optional[Dict[str, Any]]:
    attempt_id = attempt_dir.name
    sealed = (attempt_dir / ".sealed.json").is_file()
    manifest: Dict[str, Any] = {}
    review_available_at: Optional[str] = None
    review_subject_sha256: Optional[str] = None
    if sealed:
        errors = core.verify_sealed_attempt(project, attempt_dir)
        if errors:
            raise AppRequestError("封存作品证据无效：" + "; ".join(errors))
        loaded = core.load_json(attempt_dir / "manifest.json")
        if not isinstance(loaded, dict):
            raise AppRequestError("封存作品 manifest 无效")
        manifest = loaded
        original_artifact = _manifest_work_artifact(core, project, attempt_dir, manifest)
        artifact = _sealed_user_revision(core, project, manifest) or original_artifact
        artifact_kind = "user-revision" if artifact != original_artifact else "producer-output"
        try:
            review = core.verify_human_review_subject(project, attempt_dir)
        except core.LoopCtlError:
            review = None
        if isinstance(review, dict):
            review_subject_sha256 = review.get("subject_sha256")
    else:
        try:
            review = core.verify_human_review_subject(project, attempt_dir)
        except core.LoopCtlError:
            return None
        artifact_root = review.get("subject", {}).get("artifact_root")
        if not isinstance(artifact_root, str):
            raise AppRequestError("HumanReviewSubject 缺少 artifact root")
        artifact = (attempt_dir / artifact_root / "work.md").resolve()
        try:
            artifact.relative_to(attempt_dir.resolve())
        except ValueError as exc:
            raise AppRequestError("冻结送审作品路径越界") from exc
        if artifact.is_symlink() or not artifact.is_file():
            raise AppRequestError("冻结送审作品不是普通文件")
        review_available_at = review["anchor"].get("review_available_at")
        review_subject_sha256 = review.get("subject_sha256")
        artifact_kind = "review-subject"
    raw, text = _read_snapshot_artifact(artifact, "最近作品")
    run_id = str(run.get("run_id", run_dir.name))
    return {
        "run_id": run_id,
        "work_id": run.get("work_id", run_dir.name),
        "attempt_id": attempt_id,
        "output": text,
        "artifact_sha256": core.sha256_bytes(raw),
        "artifact_kind": artifact_kind,
        "runtime_provenance_sha256": _snapshot_runtime_provenance_sha256(
            core, project, run_id, attempt_dir
        ),
        "review_subject_sha256": review_subject_sha256,
        "review_available_at": review_available_at,
        "sealed": sealed,
        "human_accepted": manifest.get("human_accepted"),
        "human_direction": manifest.get("human_direction", "UNKNOWN"),
        "decision": manifest.get("decision"),
        "quality_status": manifest.get("quality_status", "NOT_EVALUATED"),
    }


def _interrupted_attempt(
    core: Any,
    project: Path,
    run: Mapping[str, Any],
    run_dir: Path,
    attempt_dir: Path,
) -> Dict[str, Any]:
    reason_code = "OPEN_ATTEMPT"
    state = "INTERRUPTED"
    dispatch_id: Optional[str] = None
    for dispatch_dir in reversed(core.dispatch_directories(attempt_dir)):
        record = core.load_dispatch_record(project, attempt_dir, dispatch_dir)
        stall = core.load_dispatch_stall(project, attempt_dir, dispatch_dir, record)
        inventory = core.regular_file_inventory(
            dispatch_dir / "artifacts", label="app snapshot dispatch artifacts"
        )
        dispatch_id = dispatch_dir.name
        if inventory:
            reason_code = "UNBOUND_ARTIFACT"
            state = "REVIEW_BINDING_REQUIRED"
            break
        if stall is not None:
            reason_code = str(stall.get("reason_code", "ZERO_FILE_DISPATCH_STALL"))
            state = "INTERRUPTED"
            break
    return {
        "run_id": run.get("run_id", run_dir.name),
        "work_id": run.get("work_id", run_dir.name),
        "attempt_id": attempt_dir.name,
        "dispatch_id": dispatch_id,
        "state": state,
        "reason_code": reason_code,
    }


def _pending_feedback_snapshot(core: Any, project: Path) -> Optional[Dict[str, Any]]:
    root = (
        project
        / "creative-system"
        / "approvals"
        / "app-feedback"
        / "transactions"
    )
    if not root.is_dir() or root.is_symlink():
        return None
    pending: list[tuple[str, Dict[str, Any]]] = []
    for intent_path in root.glob("*/*/intent.json"):
        if intent_path.is_symlink() or not intent_path.is_file():
            continue
        if (intent_path.parent / "committed.json").is_file():
            continue
        intent = core.load_json(intent_path)
        if (
            not isinstance(intent, dict)
            or intent.get("kind") != "AppFeedbackTransactionIntent"
            or intent.get("content_hash") != core.app_record_content_hash(intent)
        ):
            raise AppRequestError("待恢复反馈事务 intent 无效")
        pending.append((str(intent.get("created_at", "")), intent))
    if not pending:
        return None
    _, intent = sorted(pending, key=lambda item: item[0], reverse=True)[0]
    semantic = intent.get("semantic")
    if not isinstance(semantic, dict):
        raise AppRequestError("待恢复反馈事务 semantic 无效")
    return {
        "submission_id": intent.get("submission_id"),
        "run_id": intent.get("run_id"),
        "attempt_id": intent.get("attempt_id"),
        "action": semantic.get("action"),
        "state": "RECOVERY_REQUIRED",
    }


def _initial_intent_snapshot(
    core: Any, project: Path, system: Mapping[str, Any]
) -> Dict[str, Any]:
    onboarding = system.get("onboarding")
    if not isinstance(onboarding, dict):
        raise AppRequestError("项目缺少 onboarding 合同")
    relative = onboarding.get("initial_intent_receipt")
    if not isinstance(relative, str):
        raise AppRequestError("项目缺少 InitialIntentReceipt")
    path = core.regular_project_file(project, relative, "InitialIntentReceipt")
    receipt = core.load_json(path)
    intent = receipt.get("intent") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or receipt.get("kind") != "InitialIntentReceipt"
        or receipt.get("content_hash") != core.app_record_content_hash(receipt)
        or onboarding.get("initial_intent_receipt_sha256") != core.sha256_file(path)
        or not isinstance(intent, str)
    ):
        raise AppRequestError("InitialIntentReceipt 合同或内容摘要无效")
    raw = intent.encode("utf-8")
    return {
        "text": intent,
        "sha256": core.sha256_bytes(raw),
        "bytes": len(raw),
        "receipt": relative,
        "receipt_sha256": core.sha256_file(path),
        "authority": "direct-user-input",
    }


def _system_snapshot(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"project"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    validation = core.validate_project(project)
    if validation["errors"]:
        raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
    system = core.load_system(project)
    runs_root = project / "creative-system" / "runs"
    ordered_attempts: list[tuple[str, Dict[str, Any], Path, Path]] = []
    if runs_root.is_dir() and not runs_root.is_symlink():
        for run_dir in runs_root.iterdir():
            if not run_dir.is_dir() or run_dir.is_symlink() or run_dir.name == ".gitkeep":
                continue
            run_path = run_dir / "run.json"
            if not run_path.is_file() or run_path.is_symlink():
                continue
            run = core.load_json(run_path)
            if not isinstance(run, dict) or not isinstance(run.get("created_at"), str):
                continue
            attempts_root = run_dir / "attempts"
            if not attempts_root.is_dir() or attempts_root.is_symlink():
                continue
            for attempt_dir in attempts_root.iterdir():
                if not attempt_dir.is_dir() or attempt_dir.is_symlink():
                    continue
                attempt_path = attempt_dir / "attempt.json"
                if not attempt_path.is_file() or attempt_path.is_symlink():
                    continue
                attempt = core.load_json(attempt_path)
                opened_at = attempt.get("opened_at") if isinstance(attempt, dict) else None
                ordering = (
                    f"{run['created_at']}\x00{opened_at if isinstance(opened_at, str) else ''}"
                    f"\x00{run_dir.name}\x00{attempt_dir.name}"
                )
                ordered_attempts.append((ordering, run, run_dir, attempt_dir))
    ordered_attempts.sort(key=lambda item: item[0], reverse=True)

    last_work: Optional[Dict[str, Any]] = None
    interrupted_work: Optional[Dict[str, Any]] = None
    for index, (_, run, run_dir, attempt_dir) in enumerate(ordered_attempts):
        ready = _attempt_snapshot(core, project, run, run_dir, attempt_dir)
        if index == 0 and ready is None:
            interrupted_work = _interrupted_attempt(
                core, project, run, run_dir, attempt_dir
            )
        if ready is not None and last_work is None:
            last_work = ready
    project_record = system.get("project", {})
    onboarding = system.get("onboarding", {})
    pending_feedback = _pending_feedback_snapshot(core, project)
    initial_intent = _initial_intent_snapshot(core, project, system)
    return {
        "status": "PASS",
        "system_id": project_record.get("id"),
        "display_name": project_record.get("name"),
        "active_version": project_record.get("active_version"),
        "operating_stage": onboarding.get("state", "CHARTER"),
        "charter_confirmed": bool(system.get("charter", {}).get("confirmed")),
        "initial_intent": initial_intent["text"],
        "initial_intent_sha256": initial_intent["sha256"],
        "initial_intent_receipt": initial_intent["receipt"],
        "initial_intent_receipt_sha256": initial_intent["receipt_sha256"],
        "adopted_principles_available": False,
        "last_work": last_work,
        "recovery_required": interrupted_work is not None,
        "interrupted_run": interrupted_work,
        "feedback_recovery_required": pending_feedback is not None,
        "pending_feedback": pending_feedback,
    }


def _feedback_claims(action: str) -> Dict[str, Any]:
    if action == "keep":
        return {"human_accepted": True, "human_direction": "PASS"}
    return {"human_accepted": False, "human_direction": "BLOCK"}


def _record_feedback(payload: Mapping[str, Any]) -> Dict[str, Any]:
    core = load_controller()
    project = _project_path(payload.get("project"))
    run_id = _id(payload.get("run_id"), "run_id")
    event_id = _id(payload.get("event_id"), "event_id")
    action = _text(payload.get("action"), "action", maximum=20)
    if action not in FEEDBACK_ACTIONS:
        raise AppRequestError("action 必须是 keep / reject / rewrite / edit")
    feedback_text = payload.get("feedback_text")
    edited_text = payload.get("edited_text")
    if feedback_text is not None:
        feedback_text = _text(
            feedback_text, "feedback_text", maximum=20000, multiline=True
        )
    if edited_text is not None:
        edited_text = _text(edited_text, "edited_text", maximum=500000, multiline=True)
    if action == "edit" and edited_text is None:
        raise AppRequestError("edit 必须提供 edited_text")
    if action != "edit" and edited_text is not None:
        raise AppRequestError("只有 edit 可以提供 edited_text")
    if action in {"reject", "rewrite"} and feedback_text is None:
        raise AppRequestError(f"{action} 必须提供 feedback_text")
    feedback_at = core.utc_timestamp(payload.get("feedback_at"), "feedback_at")

    with core.exclusive_controller_lock(project):
        validation = core.validate_project(project)
        if validation["errors"]:
            raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
        event_relative = (
            "creative-system/approvals/app-feedback/events/" f"{event_id}.json"
        )
        event_path = project / event_relative
        if os.path.lexists(str(event_path)):
            existing = core.load_json(event_path)
            if (
                not isinstance(existing, dict)
                or existing.get("kind") != "AppFeedbackEventIndex"
                or existing.get("event_id") != event_id
                or not isinstance(existing.get("receipt_path"), str)
                or existing.get("content_hash") != core.app_record_content_hash(existing)
            ):
                raise AppRequestError("同一 event_id 的索引合同无效")
            receipt_relative = existing["receipt_path"]
            receipt = _load_app_feedback_receipt(core, project, receipt_relative)
            receipt_path = project / receipt_relative
            source = receipt.get("source_evidence", {})
            source_path = project / str(source.get("path", ""))
            source_payload = core.load_json(source_path)
            if (
                existing.get("receipt_sha256") != core.sha256_file(receipt_path)
                or receipt.get("event_id") != event_id
                or receipt.get("run_id") != run_id
                or receipt.get("action") != action
                or receipt.get("feedback_at") != feedback_at
                or receipt.get("claims") != _feedback_claims(action)
                or not isinstance(source_payload, dict)
                or source_payload.get("feedback_text") != feedback_text
                or source_payload.get("edited_text") != edited_text
            ):
                raise AppRequestError("同一 event_id 已绑定不同反馈，拒绝覆盖")
            return {
                "status": "PASS",
                "event_id": event_id,
                "run_id": run_id,
                "attempt_id": receipt.get("attempt_id"),
                "work_id": receipt.get("work_id"),
                "action": action,
                "claims": _feedback_claims(action),
                "feedback_at": feedback_at,
                "source_evidence": source.get("path"),
                "user_revision": (
                    receipt.get("user_revision", {}).get("path")
                    if isinstance(receipt.get("user_revision"), dict)
                    else None
                ),
                "receipt": receipt_relative,
                "receipt_sha256": core.sha256_file(receipt_path),
                "idempotent": True,
                "next_action": "seal_feedback",
            }
        _, _, _, run, attempt_id, attempt_dir = core.open_attempt_context(project, run_id)
        review = core.verify_human_review_subject(project, attempt_dir)
        if core.utc_datetime(feedback_at, "feedback_at") < core.utc_datetime(
            review["anchor"].get("review_available_at"), "review_available_at"
        ):
            raise AppRequestError("feedback_at 不得早于冻结成品可供评审的时间")
        source_relative = (
            f"creative-system/approvals/attempt-feedback/app-{event_id}.json"
        )
        source_path = project / source_relative
        source_payload = {
            "kind": "LocalAppFeedbackSource",
            "event_id": event_id,
            "run_id": run_id,
            "attempt_id": attempt_id,
            "work_id": run.get("work_id", run_id),
            "action": action,
            "feedback_at": feedback_at,
            "feedback_text": feedback_text,
            "edited_text": edited_text,
        }
        source_bytes = (
            json.dumps(source_payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        source_sha256 = core.sha256_bytes(source_bytes)
        user_revision: Optional[Dict[str, Any]] = None
        if action == "edit":
            revision_bytes = str(edited_text).encode("utf-8")
            revision_sha256 = core.sha256_bytes(revision_bytes)
            revision_relative = (
                "creative-system/approvals/app-feedback/revisions/"
                f"revision-{revision_sha256}.md"
            )
            revision_path = project / revision_relative
            core.guarded_mkdir_project(
                project, revision_path.parent, "app feedback revision root"
            )
            if os.path.lexists(str(revision_path)):
                if revision_path.is_symlink() or not revision_path.is_file():
                    raise AppRequestError("用户修订稿路径被非普通文件占用")
                if revision_path.read_bytes() != revision_bytes:
                    raise AppRequestError("用户修订稿内容寻址冲突")
            else:
                core.atomic_create_bytes(revision_path, revision_bytes)
            user_revision = {
                "kind": "UserRevisionArtifact",
                "path": revision_relative,
                "sha256": revision_sha256,
                "bytes": len(revision_bytes),
            }
        if os.path.lexists(str(source_path)):
            if source_path.is_symlink() or not source_path.is_file():
                raise AppRequestError("feedback source 路径被非普通文件占用")
            if source_path.read_bytes() != source_bytes:
                raise AppRequestError("同一 event_id 已绑定不同反馈，拒绝覆盖")
        else:
            core.atomic_create_bytes(source_path, source_bytes)

        if os.path.lexists(str(event_path)):
            existing = core.load_json(event_path)
            if (
                not isinstance(existing, dict)
                or existing.get("kind") != "AppFeedbackEventIndex"
                or existing.get("event_id") != event_id
                or not isinstance(existing.get("receipt_path"), str)
                or existing.get("content_hash") != core.app_record_content_hash(existing)
            ):
                raise AppRequestError("同一 event_id 的索引合同无效")
            receipt_relative = existing["receipt_path"]
            receipt = _load_app_feedback_receipt(core, project, receipt_relative)
            receipt_path = project / receipt_relative
            if existing.get("receipt_sha256") != core.sha256_file(receipt_path):
                raise AppRequestError("同一 event_id 的 receipt 哈希已改变")
            if (
                receipt.get("event_id") != event_id
                or receipt.get("run_id") != run_id
                or receipt.get("attempt_id") != attempt_id
                or receipt.get("work_id") != run.get("work_id", run_id)
                or receipt.get("action") != action
                or receipt.get("feedback_at") != feedback_at
                or receipt.get("claims") != _feedback_claims(action)
                or receipt.get("source_evidence", {}).get("sha256") != source_sha256
                or receipt.get("review_subject", {}).get("sha256")
                != review["subject_sha256"]
            ):
                raise AppRequestError("同一 event_id 已绑定不同反馈，拒绝覆盖")
            idempotent = True
        else:
            receipt = _record(
                core,
                "AppFeedbackReceipt",
                f"feedback-{event_id}",
                {
                    "created_at": feedback_at,
                    "source_refs": [review["subject_path"]]
                    + ([user_revision["path"]] if user_revision is not None else []),
                    "event_id": event_id,
                    "run_id": run_id,
                    "attempt_id": attempt_id,
                    "work_id": run.get("work_id", run_id),
                    "action": action,
                    "feedback_at": feedback_at,
                    "claims": _feedback_claims(action),
                    "source_evidence": {
                        "path": source_relative,
                        "sha256": source_sha256,
                        "bytes": len(source_bytes),
                    },
                    "review_subject": {
                        "path": review["subject_path"],
                        "sha256": review["subject_sha256"],
                        "artifact_subject_sha256": review["subject"].get(
                            "artifact_subject_sha256"
                        ),
                    },
                    "user_revision": user_revision,
                    "authority": "direct-user-action",
                    "preference_interpretation": "provisional-until-user-adopts-rule",
                    "promotion_authority": False,
                    "identity_authentication": "local-app-session-not-person-verified",
                },
            )
            receipt_relative = (
                "creative-system/approvals/app-feedback/"
                f"receipt-{receipt['content_hash']}.json"
            )
            receipt_path = project / receipt_relative
            receipt_bytes = (
                json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
            ).encode("utf-8")
            if os.path.lexists(str(receipt_path)):
                if receipt_path.is_symlink() or receipt_path.read_bytes() != receipt_bytes:
                    raise AppRequestError("反馈 receipt 已存在且内容不同")
            else:
                core.atomic_create_json(receipt_path, receipt)
            event_index = _record(
                core,
                "AppFeedbackEventIndex",
                f"feedback-event-{event_id}",
                {
                    "event_id": event_id,
                    "receipt_path": receipt_relative,
                    "receipt_sha256": core.sha256_file(receipt_path),
                },
            )
            core.atomic_create_json(event_path, event_index)
            idempotent = False
    return {
        "status": "PASS",
        "event_id": event_id,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "work_id": run.get("work_id", run_id),
        "action": action,
        "claims": _feedback_claims(action),
        "feedback_at": feedback_at,
        "source_evidence": source_relative,
        "user_revision": (
            user_revision.get("path") if user_revision is not None else None
        ),
        "receipt": receipt_relative,
        "receipt_sha256": core.sha256_file(receipt_path),
        "idempotent": idempotent,
        "next_action": "seal_feedback",
    }


def _load_app_feedback_receipt(
    core: Any, project: Path, raw_relative: Any
) -> Dict[str, Any]:
    if not isinstance(raw_relative, str) or not raw_relative.startswith(
        "creative-system/approvals/app-feedback/receipt-"
    ):
        raise AppRequestError("feedback_receipt 路径无效")
    path = core.regular_project_file(project, raw_relative, "AppFeedbackReceipt")
    receipt = core.load_json(path)
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema_version") != core.APP_SCHEMA_VERSION
        or receipt.get("kind") != "AppFeedbackReceipt"
        or receipt.get("content_hash") != core.app_record_content_hash(receipt)
        or raw_relative
        != "creative-system/approvals/app-feedback/receipt-{}.json".format(
            receipt.get("content_hash")
        )
    ):
        raise AppRequestError("AppFeedbackReceipt 合同或内容摘要无效")
    event_id = receipt.get("event_id")
    action = receipt.get("action")
    if (
        not isinstance(event_id, str)
        or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", event_id)
        or receipt.get("id") != f"feedback-{event_id}"
        or action not in FEEDBACK_ACTIONS
        or receipt.get("claims") != _feedback_claims(str(action))
        or receipt.get("authority") != "direct-user-action"
        or receipt.get("preference_interpretation")
        != "provisional-until-user-adopts-rule"
        or receipt.get("promotion_authority") is not False
        or receipt.get("identity_authentication")
        != "local-app-session-not-person-verified"
    ):
        raise AppRequestError("AppFeedbackReceipt 用户行为边界无效")
    try:
        feedback_at = core.utc_timestamp(
            receipt.get("feedback_at"), "AppFeedbackReceipt.feedback_at"
        )
        created_at = core.utc_timestamp(
            receipt.get("created_at"), "AppFeedbackReceipt.created_at"
        )
    except core.LoopCtlError as exc:
        raise AppRequestError(str(exc)) from exc
    if created_at != feedback_at:
        raise AppRequestError("AppFeedbackReceipt.created_at 必须绑定 feedback_at")
    source = receipt.get("source_evidence")
    if not isinstance(source, dict) or not isinstance(source.get("path"), str):
        raise AppRequestError("AppFeedbackReceipt.source_evidence 无效")
    source_path = core.regular_project_file(
        project, source["path"], "AppFeedbackReceipt source"
    )
    if (
        source.get("sha256") != core.sha256_file(source_path)
        or source.get("bytes") != source_path.stat().st_size
    ):
        raise AppRequestError("AppFeedbackReceipt source evidence 已改变")
    source_payload = core.load_json(source_path)
    if (
        not isinstance(source_payload, dict)
        or source_payload.get("kind") != "LocalAppFeedbackSource"
        or source_payload.get("event_id") != event_id
        or source_payload.get("run_id") != receipt.get("run_id")
        or source_payload.get("attempt_id") != receipt.get("attempt_id")
        or source_payload.get("work_id") != receipt.get("work_id")
        or source_payload.get("action") != action
        or source_payload.get("feedback_at") != feedback_at
    ):
        raise AppRequestError("AppFeedbackReceipt 与 source evidence 不一致")
    review = receipt.get("review_subject")
    if not isinstance(review, dict) or not isinstance(review.get("path"), str):
        raise AppRequestError("AppFeedbackReceipt.review_subject 无效")
    review_path = core.regular_project_file(
        project, review["path"], "AppFeedbackReceipt review subject"
    )
    review_subject = core.load_json(review_path)
    expected_source_refs = [review["path"]]
    if (
        review.get("sha256") != core.sha256_file(review_path)
        or not isinstance(review_subject, dict)
        or review.get("artifact_subject_sha256")
        != review_subject.get("artifact_subject_sha256")
    ):
        raise AppRequestError("AppFeedbackReceipt 未绑定冻结送审版本")
    revision = receipt.get("user_revision")
    if action == "edit":
        if not isinstance(revision, dict) or not isinstance(revision.get("path"), str):
            raise AppRequestError("edit receipt 缺少 UserRevisionArtifact")
        revision_path = core.regular_project_file(
            project, revision["path"], "AppFeedbackReceipt user revision"
        )
        revision_bytes = revision_path.read_bytes()
        if (
            revision.get("kind") != "UserRevisionArtifact"
            or revision.get("sha256") != core.sha256_bytes(revision_bytes)
            or revision.get("bytes") != len(revision_bytes)
            or revision.get("path")
            != "creative-system/approvals/app-feedback/revisions/"
            f"revision-{revision.get('sha256')}.md"
        ):
            raise AppRequestError("UserRevisionArtifact 内容摘要无效")
        try:
            revision_text = revision_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AppRequestError("UserRevisionArtifact 不是 UTF-8") from exc
        if source_payload.get("edited_text") != revision_text:
            raise AppRequestError("UserRevisionArtifact 与用户反馈原文不一致")
        expected_source_refs.append(revision["path"])
    elif revision is not None or source_payload.get("edited_text") is not None:
        raise AppRequestError("非 edit 反馈不得绑定 UserRevisionArtifact")
    if receipt.get("source_refs") != expected_source_refs:
        raise AppRequestError("AppFeedbackReceipt source_refs 未绑定完整证据")
    event_path = (
        project
        / "creative-system"
        / "approvals"
        / "app-feedback"
        / "events"
        / f"{event_id}.json"
    )
    event = core.load_json(event_path)
    if (
        not isinstance(event, dict)
        or event.get("kind") != "AppFeedbackEventIndex"
        or event.get("event_id") != event_id
        or event.get("receipt_path") != raw_relative
        or event.get("receipt_sha256") != core.sha256_file(path)
        or event.get("content_hash") != core.app_record_content_hash(event)
    ):
        raise AppRequestError("AppFeedbackReceipt event index 无效")
    return receipt


def _seal_feedback(payload: Mapping[str, Any]) -> Dict[str, Any]:
    core = load_controller()
    project = _project_path(payload.get("project"))
    receipt = _load_app_feedback_receipt(
        core, project, payload.get("feedback_receipt")
    )
    run_id = _id(receipt.get("run_id"), "receipt.run_id")
    claims = _mapping(receipt.get("claims"), "receipt.claims")
    action = str(receipt.get("action"))
    attempt_id = _id(receipt.get("attempt_id"), "receipt.attempt_id")
    attempt_dir = (
        project
        / "creative-system"
        / "runs"
        / run_id
        / "attempts"
        / attempt_id
    )
    if (attempt_dir / ".sealed.json").is_file():
        errors = core.verify_sealed_attempt(project, attempt_dir)
        manifest = core.load_json(attempt_dir / "manifest.json")
        human_receipt = (
            manifest.get("human_feedback_receipt") if isinstance(manifest, dict) else None
        )
        source = receipt.get("source_evidence", {})
        if (
            errors
            or not isinstance(manifest, dict)
            or not isinstance(human_receipt, dict)
            or manifest.get("run_id") != run_id
            or manifest.get("attempt_id") != attempt_id
            or manifest.get("human_accepted") != claims.get("human_accepted")
            or manifest.get("human_direction") != claims.get("human_direction")
            or human_receipt.get("source_evidence", {}).get("sha256")
            != source.get("sha256")
        ):
            raise AppRequestError("已封存 attempt 与 AppFeedbackReceipt 不一致")
        return {
            "status": "PASS",
            "run_id": run_id,
            "attempt_id": attempt_id,
            "manifest": (attempt_dir / "manifest.json").relative_to(project).as_posix(),
            "manifest_sha256": core.sha256_file(attempt_dir / "manifest.json"),
            "idempotent": True,
        }
    default_decision = "commit" if action == "keep" else ("revise" if action in {"rewrite", "edit"} else "stop")
    finding_paths = list(payload.get("finding_paths", []))
    default_quality_status = "WARN" if finding_paths else "NOT_EVALUATED"
    review_reference = _mapping(
        receipt.get("review_subject"), "receipt.review_subject"
    )
    review_path = core.regular_project_file(
        project,
        review_reference.get("path"),
        "AppFeedbackReceipt review subject",
    )
    review_subject = core.load_json(review_path)
    if not isinstance(review_subject, dict):
        raise AppRequestError("AppFeedbackReceipt review subject 无效")
    frozen_dispatch_id = review_subject.get("dispatch_id")
    requested_dispatch_id = payload.get("dispatch_id")
    if requested_dispatch_id is not None and requested_dispatch_id != frozen_dispatch_id:
        raise AppRequestError("dispatch_id 与冻结送审版本不一致")
    args = Namespace(
        project=str(project),
        run_id=run_id,
        attempt_id=attempt_id,
        dispatch_id=frozen_dispatch_id,
        execution_status=payload.get("execution_status", "PASS"),
        quality_status=payload.get("quality_status", default_quality_status),
        release_status=payload.get("release_status", "NOT_READY"),
        decision=payload.get("decision", default_decision),
        finding=finding_paths,
        evidence=list(payload.get("evidence_paths", [])),
        human_accepted="true" if claims.get("human_accepted") is True else "false",
        machine_direction=payload.get("machine_direction", "UNKNOWN"),
        human_direction=claims.get("human_direction", "UNKNOWN"),
        human_feedback_by="local-app-user",
        human_feedback_at=receipt.get("feedback_at"),
        human_feedback_evidence=receipt.get("source_evidence", {}).get("path"),
        improved=payload.get("improved", "unknown"),
        stop_reason=payload.get("stop_reason"),
        hard_contract_false_pass=bool(payload.get("hard_contract_false_pass", False)),
        recovery_exercised=bool(payload.get("recovery_exercised", False)),
        local_recovery_preserved_upstream=bool(
            payload.get("local_recovery_preserved_upstream", False)
        ),
        end_to_end_no_regression=bool(payload.get("end_to_end_no_regression", False)),
        resolved_observed_problem=bool(payload.get("resolved_observed_problem", False)),
    )
    return core.command_seal_attempt(args)


def _validate_feedback_transaction_intent(
    core: Any,
    project: Path,
    intent_path: Path,
    *,
    expected_run_id: str,
    expected_attempt_id: Optional[str] = None,
) -> Dict[str, Any]:
    relative = intent_path.relative_to(project).as_posix()
    path = core.regular_project_file(
        project, relative, "AppFeedbackTransaction intent"
    )
    intent = core.load_json(path)
    allowed_intent_keys = {
        "attempt_id",
        "content_hash",
        "created_at",
        "feedback_at",
        "id",
        "kind",
        "recovery_policy",
        "run_id",
        "schema_version",
        "semantic",
        "source_refs",
        "submission_id",
    }
    if not isinstance(intent, dict) or set(intent) != allowed_intent_keys:
        raise AppRequestError("AppFeedbackTransaction intent 合同无效")
    run_id = _id(intent.get("run_id"), "intent.run_id")
    attempt_id = _id(intent.get("attempt_id"), "intent.attempt_id")
    semantic = _mapping(intent.get("semantic"), "intent.semantic")
    allowed_semantic_keys = {
        "action",
        "attempt_id",
        "edited_text",
        "feedback_text",
        "machine_direction",
        "run_id",
    }
    if set(semantic) != allowed_semantic_keys:
        raise AppRequestError("AppFeedbackTransaction semantic 合同无效")
    action = _text(semantic.get("action"), "intent.semantic.action", maximum=20)
    feedback_text = semantic.get("feedback_text")
    edited_text = semantic.get("edited_text")
    if feedback_text is not None:
        feedback_text = _text(
            feedback_text,
            "intent.semantic.feedback_text",
            maximum=20000,
            multiline=True,
        )
    if edited_text is not None:
        edited_text = _text(
            edited_text,
            "intent.semantic.edited_text",
            maximum=500000,
            multiline=True,
        )
    machine_direction = semantic.get("machine_direction")
    normalized_semantic = {
        "run_id": run_id,
        "attempt_id": attempt_id,
        "action": action,
        "feedback_text": feedback_text,
        "edited_text": edited_text,
        "machine_direction": machine_direction,
    }
    semantic_bytes = core.canonical_json_bytes(normalized_semantic)
    submission_id = f"submission-{core.sha256_bytes(semantic_bytes)[:32]}"
    try:
        created_at = core.utc_timestamp(intent.get("created_at"), "intent.created_at")
        feedback_at = core.utc_timestamp(
            intent.get("feedback_at"), "intent.feedback_at"
        )
    except core.LoopCtlError as exc:
        raise AppRequestError(str(exc)) from exc
    if (
        intent.get("schema_version") != core.APP_SCHEMA_VERSION
        or intent.get("kind") != "AppFeedbackTransactionIntent"
        or intent.get("id") != f"feedback-transaction-{submission_id}"
        or intent.get("source_refs") != []
        or intent.get("submission_id") != submission_id
        or run_id != expected_run_id
        or (expected_attempt_id is not None and attempt_id != expected_attempt_id)
        or semantic != normalized_semantic
        or action not in FEEDBACK_ACTIONS
        or machine_direction not in {"BLOCK", "PASS", "UNKNOWN"}
        or (action == "edit" and edited_text is None)
        or (action != "edit" and edited_text is not None)
        or (action in {"reject", "rewrite"} and feedback_text is None)
        or intent.get("created_at") != created_at
        or intent.get("feedback_at") != feedback_at
        or intent.get("recovery_policy") != "roll-forward-same-semantic-only"
        or intent.get("content_hash") != core.app_record_content_hash(intent)
    ):
        raise AppRequestError("AppFeedbackTransaction intent 或 semantic 已漂移")
    return intent


def _validate_feedback_recorded_marker(
    core: Any,
    project: Path,
    marker_path: Path,
    intent: Mapping[str, Any],
) -> Dict[str, Any]:
    marker = core.load_json(
        core.regular_project_file(
            project,
            marker_path.relative_to(project).as_posix(),
            "AppFeedbackTransaction recorded marker",
        )
    )
    allowed_keys = {
        "attempt_id",
        "content_hash",
        "created_at",
        "id",
        "kind",
        "receipt",
        "receipt_sha256",
        "run_id",
        "schema_version",
        "source_refs",
        "submission_id",
    }
    if not isinstance(marker, dict) or set(marker) != allowed_keys:
        raise AppRequestError("AppFeedbackTransaction recorded marker 合同无效")
    semantic = _mapping(intent.get("semantic"), "intent.semantic")
    receipt_relative = marker.get("receipt")
    receipt = _load_app_feedback_receipt(core, project, receipt_relative)
    receipt_path = core.regular_project_file(
        project, receipt_relative, "AppFeedbackTransaction receipt"
    )
    source = _mapping(receipt.get("source_evidence"), "receipt.source_evidence")
    source_payload = core.load_json(
        core.regular_project_file(
            project, source.get("path"), "AppFeedbackTransaction source"
        )
    )
    if (
        marker.get("schema_version") != core.APP_SCHEMA_VERSION
        or marker.get("kind") != "AppFeedbackTransactionRecorded"
        or marker.get("id")
        != f"feedback-recorded-{intent.get('submission_id')}"
        or marker.get("source_refs") != []
        or marker.get("submission_id") != intent.get("submission_id")
        or marker.get("run_id") != intent.get("run_id")
        or marker.get("attempt_id") != intent.get("attempt_id")
        or marker.get("receipt_sha256") != core.sha256_file(receipt_path)
        or marker.get("content_hash") != core.app_record_content_hash(marker)
        or receipt.get("event_id") != intent.get("submission_id")
        or receipt.get("run_id") != intent.get("run_id")
        or receipt.get("attempt_id") != intent.get("attempt_id")
        or receipt.get("action") != semantic.get("action")
        or receipt.get("feedback_at") != intent.get("feedback_at")
        or not isinstance(source_payload, dict)
        or source_payload.get("feedback_text") != semantic.get("feedback_text")
        or source_payload.get("edited_text") != semantic.get("edited_text")
    ):
        raise AppRequestError("AppFeedbackTransaction recorded 证据已漂移")
    return marker


def _validate_feedback_committed_marker(
    core: Any,
    project: Path,
    marker_path: Path,
    intent: Mapping[str, Any],
    recorded: Mapping[str, Any],
) -> Dict[str, Any]:
    marker = core.load_json(
        core.regular_project_file(
            project,
            marker_path.relative_to(project).as_posix(),
            "AppFeedbackTransaction committed marker",
        )
    )
    allowed_keys = {
        "attempt_id",
        "content_hash",
        "created_at",
        "id",
        "kind",
        "manifest",
        "manifest_sha256",
        "receipt",
        "receipt_sha256",
        "run_id",
        "schema_version",
        "source_refs",
        "submission_id",
    }
    if not isinstance(marker, dict) or set(marker) != allowed_keys:
        raise AppRequestError("AppFeedbackTransaction committed marker 合同无效")
    expected_manifest = (
        f"creative-system/runs/{intent.get('run_id')}/attempts/"
        f"{intent.get('attempt_id')}/manifest.json"
    )
    manifest_path = core.regular_project_file(
        project, expected_manifest, "AppFeedbackTransaction manifest"
    )
    attempt_dir = manifest_path.parent
    errors = core.verify_sealed_attempt(project, attempt_dir)
    if (
        marker.get("schema_version") != core.APP_SCHEMA_VERSION
        or marker.get("kind") != "AppFeedbackTransactionCommitted"
        or marker.get("id")
        != f"feedback-committed-{intent.get('submission_id')}"
        or marker.get("source_refs") != []
        or marker.get("submission_id") != intent.get("submission_id")
        or marker.get("run_id") != intent.get("run_id")
        or marker.get("attempt_id") != intent.get("attempt_id")
        or marker.get("receipt") != recorded.get("receipt")
        or marker.get("receipt_sha256") != recorded.get("receipt_sha256")
        or marker.get("manifest") != expected_manifest
        or marker.get("manifest_sha256") != core.sha256_file(manifest_path)
        or marker.get("content_hash") != core.app_record_content_hash(marker)
        or errors
    ):
        raise AppRequestError("AppFeedbackTransaction committed 证据已漂移")
    return marker


def _feedback_transaction_intent(
    core: Any,
    project: Path,
    run_id: str,
    attempt_id: str,
    semantic: Mapping[str, Any],
    feedback_at: str,
) -> tuple[Dict[str, Any], Path]:
    transaction_dir = (
        project
        / "creative-system"
        / "approvals"
        / "app-feedback"
        / "transactions"
        / run_id
        / attempt_id
    )
    intent_path = transaction_dir / "intent.json"
    if os.path.lexists(str(intent_path)):
        intent = _validate_feedback_transaction_intent(
            core,
            project,
            intent_path,
            expected_run_id=run_id,
            expected_attempt_id=attempt_id,
        )
        if intent.get("semantic") != dict(semantic):
            raise AppRequestError(
                "当前作品存在未解决的反馈事务，拒绝提交不同 action 或内容"
            )
        return intent, transaction_dir

    semantic_bytes = core.canonical_json_bytes(dict(semantic))
    submission_id = f"submission-{core.sha256_bytes(semantic_bytes)[:32]}"
    intent = _record(
        core,
        "AppFeedbackTransactionIntent",
        f"feedback-transaction-{submission_id}",
        {
            "submission_id": submission_id,
            "run_id": run_id,
            "attempt_id": attempt_id,
            "feedback_at": feedback_at,
            "semantic": dict(semantic),
            "recovery_policy": "roll-forward-same-semantic-only",
        },
    )
    core.guarded_mkdir_project(project, transaction_dir, "app feedback transaction")
    core.atomic_create_json(intent_path, intent)
    return (
        _validate_feedback_transaction_intent(
            core,
            project,
            intent_path,
            expected_run_id=run_id,
            expected_attempt_id=attempt_id,
        ),
        transaction_dir,
    )


def _roll_forward_feedback_transaction(
    core: Any,
    project: Path,
    intent: Mapping[str, Any],
    transaction_dir: Path,
) -> Dict[str, Any]:
    semantic = _mapping(intent.get("semantic"), "intent.semantic")
    submission_id = str(intent.get("submission_id"))
    run_id = str(intent.get("run_id"))
    attempt_id = str(intent.get("attempt_id"))
    recorded_path = transaction_dir / "recorded.json"
    committed_path = transaction_dir / "committed.json"
    recorded_exists = os.path.lexists(str(recorded_path))
    committed_exists = os.path.lexists(str(committed_path))
    if committed_exists and not recorded_exists:
        raise AppRequestError("反馈事务 committed 存在但 recorded 缺失")

    existing_recorded: Optional[Dict[str, Any]] = None
    if recorded_exists:
        existing_recorded = _validate_feedback_recorded_marker(
            core, project, recorded_path, intent
        )
    if committed_exists:
        assert existing_recorded is not None
        _validate_feedback_committed_marker(
            core, project, committed_path, intent, existing_recorded
        )

    feedback_text = semantic.get("feedback_text")
    edited_text = semantic.get("edited_text")
    record_payload = {
        "project": str(project),
        "run_id": run_id,
        "event_id": submission_id,
        "action": semantic.get("action"),
        "feedback_at": intent.get("feedback_at"),
        **({"feedback_text": feedback_text} if feedback_text is not None else {}),
        **({"edited_text": edited_text} if edited_text is not None else {}),
    }
    recorded = _record_feedback(record_payload)
    if existing_recorded is not None:
        if (
            existing_recorded.get("receipt") != recorded.get("receipt")
            or existing_recorded.get("receipt_sha256")
            != recorded.get("receipt_sha256")
        ):
            raise AppRequestError("反馈事务 recorded 与恢复结果不一致")
    else:
        recorded_record = _record(
            core,
            "AppFeedbackTransactionRecorded",
            f"feedback-recorded-{submission_id}",
            {
                "submission_id": submission_id,
                "run_id": run_id,
                "attempt_id": attempt_id,
                "receipt": recorded["receipt"],
                "receipt_sha256": recorded["receipt_sha256"],
            },
        )
        core.atomic_create_json(recorded_path, recorded_record)
        existing_recorded = _validate_feedback_recorded_marker(
            core, project, recorded_path, intent
        )

    sealed = _seal_feedback(
        {
            "project": str(project),
            "feedback_receipt": recorded["receipt"],
            "machine_direction": semantic.get("machine_direction"),
        }
    )
    if committed_exists:
        assert existing_recorded is not None
        existing_committed = _validate_feedback_committed_marker(
            core, project, committed_path, intent, existing_recorded
        )
        if (
            existing_committed.get("manifest") != sealed.get("manifest")
            or existing_committed.get("manifest_sha256")
            != sealed.get("manifest_sha256")
        ):
            raise AppRequestError("反馈事务 committed 与恢复结果不一致")
        idempotent = True
    else:
        committed_record = _record(
            core,
            "AppFeedbackTransactionCommitted",
            f"feedback-committed-{submission_id}",
            {
                "submission_id": submission_id,
                "run_id": run_id,
                "attempt_id": attempt_id,
                "receipt": recorded["receipt"],
                "receipt_sha256": recorded["receipt_sha256"],
                "manifest": sealed["manifest"],
                "manifest_sha256": sealed["manifest_sha256"],
            },
        )
        core.atomic_create_json(committed_path, committed_record)
        assert existing_recorded is not None
        _validate_feedback_committed_marker(
            core, project, committed_path, intent, existing_recorded
        )
        idempotent = False
    return {
        "status": "PASS",
        "submission_id": submission_id,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "receipt": recorded["receipt"],
        "receipt_sha256": recorded["receipt_sha256"],
        "manifest": sealed["manifest"],
        "manifest_sha256": sealed["manifest_sha256"],
        "idempotent": idempotent,
        "snapshot": _system_snapshot({"project": str(project)}),
    }


def _submit_feedback(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "action",
            "edited_text",
            "feedback_at",
            "feedback_text",
            "machine_direction",
            "project",
            "run_id",
        },
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    run_id = _id(payload.get("run_id"), "run_id")
    action = _text(payload.get("action"), "action", maximum=20)
    if action not in FEEDBACK_ACTIONS:
        raise AppRequestError("action 必须是 keep / reject / rewrite / edit")
    feedback_text = payload.get("feedback_text")
    edited_text = payload.get("edited_text")
    if feedback_text is not None:
        feedback_text = _text(
            feedback_text, "feedback_text", maximum=20000, multiline=True
        )
    if edited_text is not None:
        edited_text = _text(
            edited_text, "edited_text", maximum=500000, multiline=True
        )
    if action == "edit" and edited_text is None:
        raise AppRequestError("edit 必须提供 edited_text")
    if action != "edit" and edited_text is not None:
        raise AppRequestError("只有 edit 可以提供 edited_text")
    if action in {"reject", "rewrite"} and feedback_text is None:
        raise AppRequestError(f"{action} 必须提供 feedback_text")
    feedback_at = core.utc_timestamp(payload.get("feedback_at"), "feedback_at")
    machine_direction = payload.get("machine_direction", "UNKNOWN")
    if machine_direction not in {"BLOCK", "PASS", "UNKNOWN"}:
        raise AppRequestError("machine_direction 无效")

    run_path = core.regular_project_file(
        project,
        f"creative-system/runs/{run_id}/run.json",
        "AppFeedbackTransaction run",
    )
    run = core.load_json(run_path)
    if not isinstance(run, dict):
        raise AppRequestError("run.json 无效")
    current_attempt = run.get("current_attempt")
    transaction_root = (
        project
        / "creative-system"
        / "approvals"
        / "app-feedback"
        / "transactions"
        / run_id
    )
    if isinstance(current_attempt, str):
        attempt_id = current_attempt
    else:
        intent_paths = (
            sorted(transaction_root.glob("*/intent.json"))
            if transaction_root.is_dir() and not transaction_root.is_symlink()
            else []
        )
        if not intent_paths:
            raise AppRequestError("这个 run 没有可提交或恢复的反馈事务")
        attempt_id = intent_paths[-1].parent.name
    _id(attempt_id, "attempt_id")
    attempt_dir = run_path.parent / "attempts" / attempt_id

    semantic = {
        "run_id": run_id,
        "attempt_id": attempt_id,
        "action": action,
        "feedback_text": feedback_text,
        "edited_text": edited_text,
        "machine_direction": machine_direction,
    }
    intent_path = transaction_root / attempt_id / "intent.json"
    if not os.path.lexists(str(intent_path)):
        review = core.verify_human_review_subject(project, attempt_dir)
        if core.utc_datetime(feedback_at, "feedback_at") < core.utc_datetime(
            review["anchor"].get("review_available_at"), "review_available_at"
        ):
            raise AppRequestError("feedback_at 不得早于冻结成品可供评审的时间")
    intent, transaction_dir = _feedback_transaction_intent(
        core,
        project,
        run_id,
        attempt_id,
        semantic,
        feedback_at,
    )
    return _roll_forward_feedback_transaction(
        core, project, intent, transaction_dir
    )


def _feedback_transaction_for_run(
    core: Any, project: Path, run_id: str
) -> Optional[tuple[Dict[str, Any], Path]]:
    transaction_root = (
        project
        / "creative-system"
        / "approvals"
        / "app-feedback"
        / "transactions"
        / run_id
    )
    if not os.path.lexists(str(transaction_root)):
        return None
    if transaction_root.is_symlink() or not transaction_root.is_dir():
        raise AppRequestError("反馈事务 run root 不是普通目录")
    transaction_dirs = sorted(transaction_root.iterdir(), key=lambda path: path.name)
    if not transaction_dirs:
        return None
    if len(transaction_dirs) != 1:
        raise AppRequestError("同一 run 存在多个反馈事务，拒绝猜测恢复目标")
    transaction_dir = transaction_dirs[0]
    if transaction_dir.is_symlink() or not transaction_dir.is_dir():
        raise AppRequestError("反馈事务 attempt root 不是普通目录")
    attempt_id = _id(transaction_dir.name, "transaction attempt_id")
    allowed_entries = {"committed.json", "intent.json", "recorded.json"}
    entries = list(transaction_dir.iterdir())
    if any(
        entry.name not in allowed_entries or entry.is_symlink() or not entry.is_file()
        for entry in entries
    ):
        raise AppRequestError("反馈事务目录含未声明或非普通文件")
    intent_path = transaction_dir / "intent.json"
    if not intent_path.is_file() or intent_path.is_symlink():
        raise AppRequestError("反馈事务缺少不可变 intent")
    intent = _validate_feedback_transaction_intent(
        core,
        project,
        intent_path,
        expected_run_id=run_id,
        expected_attempt_id=attempt_id,
    )
    return intent, transaction_dir


def _resume_feedback(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"project", "run_id"})
    if set(payload) != {"project", "run_id"}:
        raise AppRequestError("resume_feedback 只接收 project 与 run_id")
    core = load_controller()
    project = _project_path(payload.get("project"))
    run_id = _id(payload.get("run_id"), "run_id")
    validation = core.validate_project(project)
    if validation["errors"]:
        raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
    run_path = core.regular_project_file(
        project,
        f"creative-system/runs/{run_id}/run.json",
        "resume_feedback run",
    )
    run = core.load_json(run_path)
    if not isinstance(run, dict) or run.get("run_id") != run_id:
        raise AppRequestError("resume_feedback run 合同无效")
    transaction = _feedback_transaction_for_run(core, project, run_id)
    if transaction is None:
        return {
            "status": "PASS",
            "resume_status": "NO_TRANSACTION",
            "run_id": run_id,
            "submission_id": None,
            "attempt_id": None,
            "receipt": None,
            "receipt_sha256": None,
            "manifest": None,
            "manifest_sha256": None,
            "idempotent": True,
            "snapshot": _system_snapshot({"project": str(project)}),
        }
    intent, transaction_dir = transaction
    already_committed = os.path.lexists(str(transaction_dir / "committed.json"))
    result = _roll_forward_feedback_transaction(
        core, project, intent, transaction_dir
    )
    result["resume_status"] = (
        "ALREADY_COMMITTED" if already_committed else "RECOVERED"
    )
    return result


def _create_system_lab_candidate(payload: Mapping[str, Any]) -> Dict[str, Any]:
    core = load_controller()
    project = _project_path(payload.get("project"))
    target = _text(payload.get("target_component"), "target_component", maximum=80)
    if target not in SYSTEM_LAB_TARGETS:
        raise AppRequestError("target_component 不是允许的 system lab 候选面")
    changed_paths = payload.get("changed_paths")
    if not isinstance(changed_paths, list) or not changed_paths:
        raise AppRequestError("changed_paths 必须是非空数组")
    args = Namespace(
        project=str(project),
        candidate_id=_id(payload.get("candidate_id"), "candidate_id"),
        finding_code=_text(payload.get("finding_code"), "finding_code", maximum=80),
        root_cause=_text(payload.get("root_cause"), "root_cause", maximum=1000, multiline=True),
        target_component=target,
        level="L5",
        change_summary=_text(
            payload.get("change_summary"), "change_summary", maximum=2000, multiline=True
        ),
        changed_path=[str(item) for item in changed_paths],
        evaluation_plan=payload.get("evaluation_plan"),
        budget=int(payload.get("budget", 3)),
        builder_role_id=_id(payload.get("builder_role_id"), "builder_role_id"),
        builder_context_id=_text(
            payload.get("builder_context_id"), "builder_context_id", maximum=300
        ),
        builder_task_id=_text(
            payload.get("builder_task_id"), "builder_task_id", maximum=300
        ),
        builder_attested_by=_text(
            payload.get("builder_attested_by"), "builder_attested_by", maximum=300
        ),
        builder_input_boundary=[
            "creative-charter",
            "editable-surface",
            "evaluation-policy",
            "finding-evidence",
            "system-contract",
        ],
    )
    result = core.command_create_candidate(args)
    result["candidate_class"] = "CANDIDATE_ONLY"
    result["code_execution_allowed"] = False
    return result


def _candidate_summary(payload: Mapping[str, Any]) -> Dict[str, Any]:
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    candidate_root, proposal, status = core.load_candidate(project, candidate_id)
    opened = list((candidate_root / "control" / "eval-open-anchors").glob("*.json"))
    sealed = list((candidate_root / "evaluations").glob("*/.sealed.json"))
    stored = status.get("status")
    if stored in {"PROMOTED", "ROLLED_BACK", "BLOCKED", "REJECTED"}:
        lifecycle = stored
    elif len(sealed) == 3:
        lifecycle = "READY_FOR_HUMAN"
    elif opened:
        lifecycle = "EVALUATING"
    else:
        lifecycle = "CANDIDATE"
    level = proposal.get("level")
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "lifecycle_status": lifecycle,
        "level": level,
        "candidate_class": "CANDIDATE_ONLY" if level == "L5" else "PROMOTABLE",
        "code_execution_allowed": False if level == "L5" else None,
        "opened_evaluations": len(opened),
        "sealed_evaluations": len(sealed),
    }


def handle_request(request: Mapping[str, Any]) -> Dict[str, Any]:
    request_value = _mapping(request, "request")
    _reject_sensitive_fields(request_value)
    if request_value.get("protocol_version") != APP_PROTOCOL_VERSION:
        raise AppRequestError(
            f"protocol_version 必须为 {APP_PROTOCOL_VERSION}"
        )
    request_id = _id(request_value.get("request_id"), "request_id")
    operation = request_value.get("operation")
    if operation not in ALLOWED_OPERATIONS:
        raise AppRequestError("operation 不在允许列表")
    payload = _mapping(request_value.get("payload", {}), "payload")
    handlers = {
        "bootstrap_intent": _bootstrap_intent,
        "begin_work": _begin_work,
        "cancel_work": _cancel_work,
        "complete_work": _complete_work,
        "record_feedback": _record_feedback,
        "resume_feedback": _resume_feedback,
        "seal_feedback": _seal_feedback,
        "submit_feedback": _submit_feedback,
        "create_system_lab_candidate": _create_system_lab_candidate,
        "candidate_summary": _candidate_summary,
        "system_snapshot": _system_snapshot,
    }
    result = handlers[str(operation)](payload)
    return {
        "protocol_version": APP_PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": operation,
        **result,
    }


def error_response(request: Any, exc: BaseException) -> Dict[str, Any]:
    request_id: Optional[str] = None
    operation: Optional[str] = None
    if isinstance(request, Mapping):
        raw_id = request.get("request_id")
        raw_operation = request.get("operation")
        request_id = raw_id if isinstance(raw_id, str) else None
        operation = raw_operation if isinstance(raw_operation, str) else None
    return {
        "protocol_version": APP_PROTOCOL_VERSION,
        "request_id": request_id,
        "operation": operation,
        "status": "BLOCK",
        "error": {
            "code": exc.__class__.__name__,
            "message": str(exc),
        },
    }
