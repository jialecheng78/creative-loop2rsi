"""Structured app-side governance API.

This module never accepts or reads a model credential.  Requests arrive over
stdin from the trusted desktop main process and are limited to a small
operation allowlist.  Model execution remains outside the Python controller.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import tempfile
import unicodedata
from argparse import Namespace
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from ._legacy import load_controller


APP_PROTOCOL_VERSION = "1"
ALLOWED_OPERATIONS = {
    "begin_work",
    "begin_method_candidate_preparation",
    "begin_method_generation",
    "bootstrap_intent",
    "candidate_summary",
    "cancel_work",
    "complete_work",
    "create_method_candidate",
    "create_system_lab_candidate",
    "adopt_method_candidate",
    "method_candidate_context",
    "production_context",
    "record_feedback",
    "record_method_generation",
    "record_method_generation_failure",
    "record_method_builder_failure",
    "reject_method_candidate",
    "resume_feedback",
    "rollback_method",
    "seal_feedback",
    "stage_method_comparisons",
    "submit_method_comparison",
    "submit_feedback",
    "system_snapshot",
    "terminate_work",
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
METHOD_PHASES = ("targeted", "regression", "heldout")
METHOD_CHOICES = {"A", "B", "TIE"}
METHOD_GENERATION_LABELS = (
    "targeted_candidate",
    "regression_candidate",
    "heldout_baseline",
    "heldout_candidate",
)
METHOD_REGISTRY_RELATIVE = "creative-system/app-methods/registry.json"
TERMINATION_OUTCOMES = {"FAILED", "CANCELLED"}
LEGACY_APP_TERMINATION_REASONS = {
    "application-closed",
    "completion-evidence-or-commit-failed",
    "runtime-cancelled-before-commit",
    "runtime-failed-before-commit",
    "runtime-launch-failed-before-output",
    "user-cancelled",
    "user-cancelled-during-launch",
}
LEGACY_APP_CANCELLED_REASONS = {
    "application-closed",
    "runtime-cancelled-before-commit",
    "user-cancelled",
    "user-cancelled-during-launch",
}
CURRENT_MODEL_MAX_OUTPUT_TOKENS = 32768
LEGACY_MODEL_MAX_OUTPUT_TOKENS = 16384


class AppRequestError(RuntimeError):
    """An expected, user-actionable app bridge refusal."""


def _uses_fixed_model_parameters(
    parameters: Mapping[str, Any], max_output_tokens: int
) -> bool:
    return parameters == {
        "thinking": "enabled",
        "reasoning_effort": "high",
        "max_tokens": max_output_tokens,
    }


def _method_epoch_uses_current_policy(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    parameters = value.get("parameters")
    return isinstance(parameters, Mapping) and _uses_fixed_model_parameters(
        parameters, CURRENT_MODEL_MAX_OUTPUT_TOKENS
    )


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


def _method_registry(core: Any, project: Path) -> Dict[str, Any]:
    path = project / METHOD_REGISTRY_RELATIVE
    if not os.path.lexists(str(path)):
        system = core.load_system(project)
        onboarding = system.get("onboarding")
        if not isinstance(onboarding, dict) or onboarding.get("mode") != "progressive-app":
            raise AppRequestError("非应用项目缺少方法注册表，拒绝自动迁移")
        registry = _record(
            core,
            "AppMethodRegistry",
            "app-method-registry",
            {
                "active_method_version": "baseline-v1",
                "active_guidance_sha256": None,
                "history": [],
                "formal_l4_authority": False,
            },
        )
        core.guarded_mkdir_project(project, path.parent, "app method root")
        core.atomic_create_json(path, registry)
    if path.is_symlink() or not path.is_file():
        raise AppRequestError("应用方法注册表不是普通文件")
    registry = core.load_json(path)
    if (
        not isinstance(registry, dict)
        or registry.get("kind") != "AppMethodRegistry"
        or registry.get("id") != "app-method-registry"
        or registry.get("content_hash") != core.app_record_content_hash(registry)
        or not isinstance(registry.get("history"), list)
        or not isinstance(registry.get("active_method_version"), str)
    ):
        raise AppRequestError("应用方法注册表合同或摘要无效")
    return registry


def _write_method_registry(core: Any, project: Path, registry: Mapping[str, Any]) -> None:
    value = dict(registry)
    value["content_hash"] = core.app_record_content_hash(value)
    core.atomic_write_json(project / METHOD_REGISTRY_RELATIVE, value)


def _validated_method_rollback_receipts(
    core: Any,
    project: Path,
    registry: Mapping[str, Any],
) -> list[tuple[Path, Dict[str, Any]]]:
    root = project / "creative-system" / "app-methods" / "rollbacks"
    history = registry.get("history")
    if not isinstance(history, list):
        raise AppRequestError("应用方法历史无效")
    referenced = {
        str(item.get("receipt"))
        for item in history
        if isinstance(item, dict) and item.get("action") == "ROLLBACK"
    }
    if not os.path.lexists(str(root)):
        if referenced:
            raise AppRequestError("应用方法历史引用了不存在的 rollback receipt")
        return []
    if root.is_symlink() or not root.is_dir():
        raise AppRequestError("应用方法 rollback root 不是普通目录")
    pending: list[tuple[Path, Dict[str, Any]]] = []
    observed: Dict[str, tuple[Path, Dict[str, Any]]] = {}
    for path in sorted(root.iterdir(), key=lambda item: item.name):
        if path.name == ".gitkeep":
            continue
        receipt_file = core.regular_project_file(
            project,
            path.relative_to(project).as_posix(),
            "AppMethodRollbackReceipt",
        )
        receipt = core.load_json(receipt_file)
        relative = receipt_file.relative_to(project).as_posix()
        if (
            not isinstance(receipt, dict)
            or receipt.get("kind") != "AppMethodRollbackReceipt"
            or receipt.get("id") != receipt_file.stem
            or not isinstance(receipt.get("previous_version"), str)
            or not isinstance(receipt.get("restored_version"), str)
            or receipt.get("previous_version") == receipt.get("restored_version")
            or receipt.get("requested_by") != "local-app-user"
            or receipt.get("history_retained") is not True
            or receipt.get("formal_l4_authority") is not False
            or receipt.get("content_hash") != core.app_record_content_hash(receipt)
        ):
            raise AppRequestError("AppMethodRollbackReceipt 合同或摘要无效")
        observed[relative] = (receipt_file, receipt)
        if relative not in referenced:
            pending.append((receipt_file, receipt))
    if referenced - set(observed):
        raise AppRequestError("应用方法历史引用了不存在的 rollback receipt")
    for item in history:
        if not isinstance(item, dict) or item.get("action") != "ROLLBACK":
            continue
        relative = str(item.get("receipt"))
        path, receipt = observed[relative]
        if (
            item.get("version") != receipt.get("restored_version")
            or item.get("previous_version") != receipt.get("previous_version")
            or item.get("created_at") != receipt.get("created_at")
            or item.get("receipt_sha256") != core.sha256_file(path)
        ):
            raise AppRequestError("rollback history 与不可变 receipt 不一致")
    return pending


def _reconcile_method_rollbacks_locked(core: Any, project: Path) -> Dict[str, Any]:
    registry = _method_registry(core, project)
    pending = _validated_method_rollback_receipts(core, project, registry)
    if not pending:
        return registry
    if len(pending) != 1:
        raise AppRequestError("存在多个未投影 rollback receipt，拒绝猜测顺序")
    receipt_path, receipt = pending[0]
    previous = str(receipt["previous_version"])
    restored = str(receipt["restored_version"])
    if registry.get("active_method_version") != previous:
        raise AppRequestError("rollback receipt 与当前 active method 不一致")
    known = {"baseline-v1"}
    for item in registry.get("history", []):
        if isinstance(item, dict) and isinstance(item.get("version"), str):
            known.add(str(item["version"]))
    if restored not in known:
        raise AppRequestError("rollback receipt 的目标不是已知稳定方法")
    guidance_sha256: Optional[str] = None
    if restored != "baseline-v1":
        _, proposal, status = _load_method_candidate(core, project, restored)
        if status.get("lifecycle") != "PROMOTED":
            raise AppRequestError("rollback receipt 的目标不是已采用方法")
        _validated_method_promotion_receipt(core, project, restored, proposal)
        guidance_sha256 = str(proposal.get("guidance_sha256"))
    relative = receipt_path.relative_to(project).as_posix()
    history = list(registry.get("history", []))
    history.append(
        {
            "action": "ROLLBACK",
            "version": restored,
            "previous_version": previous,
            "created_at": receipt.get("created_at"),
            "receipt": relative,
            "receipt_sha256": core.sha256_file(receipt_path),
        }
    )
    reconciled = {
        **registry,
        "active_method_version": restored,
        "active_guidance_sha256": guidance_sha256,
        "history": history,
    }
    _write_method_registry(core, project, reconciled)
    return reconciled


def _feedback_normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _feedback_finding_code(value: str) -> str:
    digest = hashlib.sha256(_feedback_normalized(value).encode("utf-8")).hexdigest()[:12]
    return f"APP-FEEDBACK-{digest.upper()}"


def _feedback_finding(
    core: Any,
    project: Path,
    receipt: Mapping[str, Any],
) -> Optional[str]:
    source = _mapping(receipt.get("source_evidence"), "receipt.source_evidence")
    source_path = core.regular_project_file(
        project, source.get("path"), "AppFeedbackSource"
    )
    source_payload = core.load_json(source_path)
    feedback_text = (
        source_payload.get("feedback_text")
        if isinstance(source_payload, dict)
        else None
    )
    if not isinstance(feedback_text, str) or not feedback_text.strip():
        return None
    run_id = _id(receipt.get("run_id"), "receipt.run_id")
    attempt_id = _id(receipt.get("attempt_id"), "receipt.attempt_id")
    code = _feedback_finding_code(feedback_text)
    relative = (
        "creative-system/memory/app-findings/"
        f"{run_id}-{attempt_id}-{code.lower()}.json"
    )
    path = project / relative
    finding = {
        "code": code,
        "category": "soft-quality",
        "severity": "medium",
        "confidence": 1.0,
        "evidence": [
            {
                "path": str(source.get("path")),
                "sha256": str(source.get("sha256")),
                "authority": "direct-user-feedback",
            }
        ],
        "owner": "creative-producer",
        "suggested_action": feedback_text,
        "normalized_feedback_sha256": hashlib.sha256(
            _feedback_normalized(feedback_text).encode("utf-8")
        ).hexdigest(),
        "source_feedback_receipt": str(receipt.get("source_evidence", {}).get("path")),
    }
    encoded = (
        json.dumps(finding, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    core.guarded_mkdir_project(project, path.parent, "app finding root")
    if os.path.lexists(str(path)):
        if path.is_symlink() or not path.is_file() or path.read_bytes() != encoded:
            raise AppRequestError("同一反馈已绑定不同 finding，拒绝覆盖")
    else:
        core.atomic_create_bytes(path, encoded)
    return str(path)


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
    method_version: str = "baseline-v1",
    method_guidance_sha256: Optional[str] = None,
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
            or receipt.get("method_version", "baseline-v1") != method_version
            or receipt.get("method_guidance_sha256") != method_guidance_sha256
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
            **(
                {
                    "method_version": method_version,
                    "method_guidance_sha256": method_guidance_sha256,
                }
                if method_version != "baseline-v1"
                else {}
            ),
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
            **(
                {
                    "method_version": method_version,
                    "method_guidance_sha256": method_guidance_sha256,
                }
                if method_version != "baseline-v1"
                else {}
            ),
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
        **(
            {
                "method_version": method_version,
                "method_guidance_sha256": method_guidance_sha256,
            }
            if method_version != "baseline-v1"
            else {}
        ),
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
                "creative-system/app-methods/registry.json",
                "creative-system/app-methods/promotions/",
                "creative-system/app-methods/rollbacks/",
                "creative-system/approvals/initial-intent/",
                "creative-system/approvals/app-feedback/",
                "creative-system/approvals/work-tasks/",
            }
        )
        system["protected_surfaces"] = sorted(protected)
        core.atomic_write_json(core.system_path(staging), system)
        method_registry = _record(
            core,
            "AppMethodRegistry",
            "app-method-registry",
            {
                "active_method_version": "baseline-v1",
                "active_guidance_sha256": None,
                "history": [],
                "formal_l4_authority": False,
            },
        )
        method_registry_path = staging / METHOD_REGISTRY_RELATIVE
        core.guarded_mkdir_project(
            staging, method_registry_path.parent, "app method root"
        )
        core.atomic_create_json(method_registry_path, method_registry)
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
    with core.exclusive_controller_lock(project):
        _reconcile_terminated_attempts_locked(core, project)
        _reconcile_method_rollbacks_locked(core, project)
    validation = core.validate_project(project)
    if validation["errors"]:
        raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
    work_id = _id(payload.get("work_id"), "work_id")
    run_id_value = payload.get("run_id")
    run_id = _id(
        run_id_value if run_id_value is not None else core.generated_run_id(), "run_id"
    )
    task = _text(payload.get("task"), "task", maximum=100000, multiline=True)
    production_context = _production_context_snapshot(
        core, project, core.load_system(project)
    )
    context_sha256 = payload.get(
        "context_sha256", production_context["context_sha256"]
    )
    if (
        not isinstance(context_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", context_sha256)
        or context_sha256 != production_context["context_sha256"]
    ):
        raise AppRequestError("context_sha256 必须绑定当前生产方法上下文")
    task_receipt = _work_task_receipt(
        core,
        project,
        run_id=run_id,
        work_id=work_id,
        task=task,
        context_sha256=context_sha256,
        method_version=str(production_context["method_version"]),
        method_guidance_sha256=production_context["guidance_sha256"],
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
        existing_record = core.load_json(
            core.regular_project_file(
                project,
                (existing_run_dir / "run.json").relative_to(project).as_posix(),
                "existing app run record",
            )
        )
        if isinstance(existing_record, dict) and (
            existing_record.get("terminal_receipt") is not None
            or existing_record.get("terminal_attempt") is not None
        ):
            raise AppRequestError(
                "run 已终止，必须使用新 run_id 并通过 recovery_of 关联"
            )
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

    run_path = project / "creative-system" / "runs" / run_id / "run.json"
    run_record = core.load_json(run_path)
    if not isinstance(run_record, dict):
        raise AppRequestError("run.json 无效")
    expected_method = str(production_context["method_version"])
    recorded_method = run_record.get("app_method_version_at_start")
    if recorded_method is None and expected_method != "baseline-v1":
        run_record["app_method_version_at_start"] = expected_method
        run_record["app_method_guidance_sha256"] = production_context[
            "guidance_sha256"
        ]
        run_record["app_method_context_sha256"] = context_sha256
        core.atomic_write_json(run_path, run_record)
        recorded_method = expected_method
    elif recorded_method is None:
        recorded_method = "baseline-v1"
    if recorded_method != expected_method:
        raise AppRequestError("已有 run 绑定不同应用方法版本")

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
            "method_version": expected_method,
            "method_guidance_sha256": production_context["guidance_sha256"],
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
    with core.exclusive_controller_lock(project):
        _reconcile_terminated_attempts_locked(core, project)
        _, _, _, _, attempt_id, attempt_dir = core.open_attempt_context(
            project, run_id
        )
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
                json.dumps(
                    provenance, ensure_ascii=False, indent=2, sort_keys=True
                )
                + "\n"
            ).encode("utf-8")
            if os.path.lexists(str(provenance_path)):
                if provenance_path.is_symlink() or not provenance_path.is_file():
                    raise AppRequestError("取消运行来源路径被非普通文件占用")
                if provenance_path.read_bytes() != provenance_bytes:
                    raise AppRequestError("同一 dispatch 已绑定不同取消运行来源")
            else:
                core.atomic_create_bytes(provenance_path, provenance_bytes)
            provenance_sha256 = core.sha256_bytes(provenance_bytes)
        existing = core.load_dispatch_stall(
            project, attempt_dir, dispatch_dir, record
        )
        if existing is not None:
            if existing.get("orchestrator_attestation", {}).get("reason") != reason:
                raise AppRequestError("dispatch 已由不同原因结束，拒绝覆盖")
            return {
                "status": (
                    "PASS"
                    if existing.get("state") != "BUDGET_EXHAUSTED"
                    else "BLOCK"
                ),
                "run_id": run_id,
                "attempt_id": attempt_id,
                "dispatch_id": dispatch_id,
                "reason_code": existing.get("reason_code"),
                "state": existing.get("state"),
                "runtime_provenance": provenance_relative,
                "runtime_provenance_sha256": provenance_sha256,
                "idempotent": True,
            }
        result = core.command_record_dispatch_stall_locked(
            Namespace(
                project=str(project),
                run_id=run_id,
                dispatch_id=dispatch_id,
                context_stopped=True,
                reason=reason,
            ),
            project,
            run_id,
        )
        result["idempotent"] = False
        result["runtime_provenance"] = provenance_relative
        result["runtime_provenance_sha256"] = provenance_sha256
        return result


def _termination_receipt_path(attempt_dir: Path) -> Path:
    return attempt_dir / ".terminated.json"


def _termination_context(
    core: Any, project: Path, run_id: str, dispatch_id: str
) -> tuple[Dict[str, Any], Path, str, Path, Path, Dict[str, Any]]:
    run_dir = project / "creative-system" / "runs" / run_id
    run_path = core.regular_project_file(
        project, (run_dir / "run.json").relative_to(project).as_posix(), "run record"
    )
    run = core.load_json(run_path)
    if not isinstance(run, dict) or run.get("run_id") != run_id:
        raise AppRequestError("terminate_work run record 无效")
    attempt_id = run.get("current_attempt") or run.get("terminal_attempt")
    if not isinstance(attempt_id, str) or not re.fullmatch(r"attempt-[0-9]{3}", attempt_id):
        raise AppRequestError("该 run 没有可终止的 attempt")
    attempt_dir = run_dir / "attempts" / attempt_id
    if attempt_dir.is_symlink() or not attempt_dir.is_dir():
        raise AppRequestError("terminate_work attempt 不是普通目录")
    core.regular_project_file(
        project,
        (attempt_dir / "attempt.json").relative_to(project).as_posix(),
        "attempt record",
    )
    dispatch_dir = attempt_dir / "dispatches" / dispatch_id
    dispatch = core.load_dispatch_record(project, attempt_dir, dispatch_dir)
    return run, run_path, attempt_id, attempt_dir, dispatch_dir, dispatch


def _evidence_ref(core: Any, project: Path, path: Path, label: str) -> Dict[str, str]:
    relative = path.relative_to(project).as_posix()
    verified = core.regular_project_file(project, relative, label)
    return {"path": relative, "sha256": core.sha256_file(verified)}


def _validate_runtime_provenance_record(
    core: Any, project: Path, run_id: str, path: Path
) -> Dict[str, Any]:
    relative = path.relative_to(project).as_posix()
    verified = core.regular_project_file(project, relative, "termination runtime provenance")
    raw = core.load_json(verified)
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
        raise AppRequestError("termination runtime provenance 与 work 绑定不一致")
    return raw


def _persist_termination_provenance_locked(
    core: Any,
    project: Path,
    run_id: str,
    attempt_dir: Path,
    dispatch_id: str,
    dispatch: Mapping[str, Any],
    raw_provenance: Any,
) -> Optional[Dict[str, str]]:
    canonical = attempt_dir / "runtime-provenance.json"
    dispatch_specific = attempt_dir / f"runtime-provenance-{dispatch_id}.json"
    existing = [
        path
        for path in (canonical, dispatch_specific)
        if os.path.lexists(str(path))
    ]
    if len(existing) > 1:
        raise AppRequestError("同一 attempt 存在多份 runtime provenance")
    if raw_provenance is None:
        if not existing:
            return None
        _validate_runtime_provenance_record(core, project, run_id, existing[0])
        return _evidence_ref(
            core, project, existing[0], "termination runtime provenance"
        )

    provenance = _runtime_provenance(
        core,
        raw_provenance,
        run_id,
        require_completed=False,
        allow_legacy_termination=True,
        fallback_created_at=dispatch.get("opened_at"),
        expected_context_sha256=_work_task_context_sha256(core, project, run_id),
    )
    encoded = (
        json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    path = existing[0] if existing else dispatch_specific
    if os.path.lexists(str(path)):
        if path.is_symlink() or not path.is_file() or path.read_bytes() != encoded:
            raise AppRequestError("同一 run 已绑定不同 runtime provenance")
    else:
        core.atomic_create_bytes(path, encoded)
    _validate_runtime_provenance_record(core, project, run_id, path)
    return _evidence_ref(core, project, path, "termination runtime provenance")


def _termination_semantic(record: Mapping[str, Any]) -> Dict[str, Any]:
    keys = (
        "run_id",
        "work_id",
        "attempt_id",
        "dispatch_id",
        "outcome",
        "execution_status",
        "quality_status",
        "release_status",
        "lifecycle_reason",
        "error_code",
        "termination_class",
        "dispatch_stall",
        "runtime_provenance",
        "artifact_inventory",
        "content_attempt_consumed",
        "finding_eligible",
        "successor_run_required",
    )
    return {key: record.get(key) for key in keys}


def _build_termination_receipt(
    core: Any,
    *,
    run: Mapping[str, Any],
    run_id: str,
    attempt_id: str,
    dispatch_id: str,
    outcome: str,
    reason: str,
    error_code: Optional[str],
    termination_class: str,
    stall_ref: Optional[Mapping[str, str]],
    provenance_ref: Optional[Mapping[str, str]],
    artifact_inventory: list[Dict[str, Any]],
) -> Dict[str, Any]:
    source_refs = [
        str(reference["path"])
        for reference in (stall_ref, provenance_ref)
        if isinstance(reference, Mapping)
    ]
    return _record(
        core,
        "TerminatedAttempt",
        f"termination-{attempt_id}",
        {
            "source_refs": source_refs,
            "run_id": run_id,
            "work_id": run.get("work_id", run_id),
            "attempt_id": attempt_id,
            "dispatch_id": dispatch_id,
            "outcome": outcome,
            "execution_status": "BLOCK",
            "quality_status": "NOT_EVALUATED",
            "release_status": "BLOCK",
            "lifecycle_reason": reason,
            "error_code": error_code,
            "termination_class": termination_class,
            "dispatch_stall": dict(stall_ref) if stall_ref is not None else None,
            "runtime_provenance": (
                dict(provenance_ref) if provenance_ref is not None else None
            ),
            "artifact_inventory": artifact_inventory,
            "content_attempt_consumed": termination_class
            == "UNCOMMITTED_OUTPUT_FAILURE",
            "finding_eligible": False,
            "successor_run_required": True,
        },
    )


def _load_termination_receipt(
    core: Any, project: Path, attempt_dir: Path
) -> Dict[str, Any]:
    path = _termination_receipt_path(attempt_dir)
    verified = core.regular_project_file(
        project, path.relative_to(project).as_posix(), "terminated attempt receipt"
    )
    receipt = core.load_json(verified)
    if (
        not isinstance(receipt, dict)
        or receipt.get("kind") != "TerminatedAttempt"
        or receipt.get("id") != f"termination-{attempt_dir.name}"
        or receipt.get("content_hash") != core.app_record_content_hash(receipt)
    ):
        raise AppRequestError("TerminatedAttempt 合同或内容哈希无效")
    return receipt


def _verify_termination_receipt(
    core: Any, project: Path, attempt_dir: Path, receipt: Mapping[str, Any]
) -> None:
    run_id = attempt_dir.parent.parent.name
    if (
        receipt.get("run_id") != run_id
        or receipt.get("attempt_id") != attempt_dir.name
        or receipt.get("outcome") not in TERMINATION_OUTCOMES
        or receipt.get("execution_status") != "BLOCK"
        or receipt.get("quality_status") != "NOT_EVALUATED"
        or receipt.get("release_status") != "BLOCK"
        or receipt.get("finding_eligible") is not False
        or receipt.get("successor_run_required") is not True
    ):
        raise AppRequestError("TerminatedAttempt 身份或终态字段无效")
    if receipt.get("outcome") == "FAILED":
        if not isinstance(receipt.get("error_code"), str) or not receipt.get("error_code"):
            raise AppRequestError("FAILED TerminatedAttempt 缺少 error_code")
    elif receipt.get("error_code") is not None:
        raise AppRequestError("CANCELLED TerminatedAttempt 不得含 error_code")
    if (attempt_dir / ".sealed.json").exists():
        raise AppRequestError("attempt 不得同时 sealed 与 terminated")
    review_subject, review_anchor = core.human_review_paths(project, attempt_dir)
    if os.path.lexists(str(review_subject)) or os.path.lexists(str(review_anchor)):
        raise AppRequestError("terminated attempt 不得存在送审版本或评审锚点")
    core.ensure_attempt_not_terminal_invalid(attempt_dir)
    dispatch_id = _id(receipt.get("dispatch_id"), "TerminatedAttempt.dispatch_id")
    dispatch_dir = attempt_dir / "dispatches" / dispatch_id
    inventory = _termination_attempt_inventory(
        core,
        project,
        attempt_dir,
        dispatch_id,
    )
    recorded_inventory = receipt.get("artifact_inventory")
    if not isinstance(recorded_inventory, list) or inventory != recorded_inventory:
        raise AppRequestError("TerminatedAttempt artifact inventory 已变化")

    termination_class = receipt.get("termination_class")
    stall_ref = receipt.get("dispatch_stall")
    if termination_class == "ZERO_FILE_RUNTIME_FAILURE":
        if inventory or receipt.get("content_attempt_consumed") is not False:
            raise AppRequestError("zero-file termination 的内容计数无效")
        if not isinstance(stall_ref, dict):
            raise AppRequestError("zero-file termination 缺少 dispatch stall")
        expected_stall = (dispatch_dir / "stall.json").relative_to(project).as_posix()
        if stall_ref.get("path") != expected_stall:
            raise AppRequestError("TerminatedAttempt dispatch stall 路径无效")
        stall_path = core.regular_project_file(project, expected_stall, "dispatch stall")
        if stall_ref.get("sha256") != core.sha256_file(stall_path):
            raise AppRequestError("TerminatedAttempt dispatch stall 哈希无效")
        stall = core.load_json(stall_path)
        attestation = stall.get("orchestrator_attestation") if isinstance(stall, dict) else None
        if (
            not isinstance(attestation, dict)
            or attestation.get("reason") != receipt.get("lifecycle_reason")
        ):
            raise AppRequestError("TerminatedAttempt 与 dispatch stall reason 不一致")
    elif termination_class == "UNCOMMITTED_OUTPUT_FAILURE":
        if not inventory or receipt.get("content_attempt_consumed") is not True:
            raise AppRequestError("uncommitted-output termination 缺少产物清单")
        if stall_ref is not None:
            raise AppRequestError("uncommitted-output termination 不得伪造 zero-file stall")
    else:
        raise AppRequestError("TerminatedAttempt.termination_class 无效")

    provenance_ref = receipt.get("runtime_provenance")
    if provenance_ref is not None:
        if not isinstance(provenance_ref, dict) or not isinstance(
            provenance_ref.get("path"), str
        ):
            raise AppRequestError("TerminatedAttempt runtime provenance 引用无效")
        provenance_path = core.regular_project_file(
            project, provenance_ref["path"], "termination runtime provenance"
        )
        try:
            provenance_path.relative_to(attempt_dir)
        except ValueError as exc:
            raise AppRequestError("termination runtime provenance 不属于当前 attempt") from exc
        if provenance_ref.get("sha256") != core.sha256_file(provenance_path):
            raise AppRequestError("TerminatedAttempt runtime provenance 哈希无效")
        _validate_runtime_provenance_record(core, project, run_id, provenance_path)


def _termination_attempt_inventory(
    core: Any,
    project: Path,
    attempt_dir: Path,
    terminal_dispatch_id: str,
) -> list[Dict[str, Any]]:
    """Verify that a terminal receipt covers the only non-empty dispatch.

    Earlier dispatches may exist only as mechanically zero-file stalls.  A
    write that arrives in any of those roots after the terminal marker is a
    late-write contamination of the whole attempt, not ignorable content.
    """

    legacy_inventory = core.regular_file_inventory(
        attempt_dir / "artifacts", label="terminated legacy artifacts"
    )
    if legacy_inventory:
        raise AppRequestError(
            "LATE_WRITE_CONTAMINATION：terminated attempt 的 legacy artifacts 出现产物"
        )

    terminal_inventory: Optional[list[Dict[str, Any]]] = None
    for dispatch_dir in core.dispatch_directories(attempt_dir):
        dispatch = core.load_dispatch_record(
            project, attempt_dir, dispatch_dir
        )
        inventory = core.regular_file_inventory(
            dispatch_dir / "artifacts",
            label=f"terminated dispatch artifacts {dispatch_dir.name}",
        )
        stall = core.load_dispatch_stall(
            project, attempt_dir, dispatch_dir, dispatch
        )
        if dispatch_dir.name == terminal_dispatch_id:
            terminal_inventory = inventory
            continue
        if stall is None:
            raise AppRequestError(
                "terminated attempt 存在未结束的其他 dispatch"
            )
        if inventory:
            raise AppRequestError(
                "LATE_WRITE_CONTAMINATION：已 stall dispatch 后出现产物"
            )
    if terminal_inventory is None:
        raise AppRequestError("TerminatedAttempt 指向不存在的 dispatch")
    return terminal_inventory


def _apply_termination_run_projection_locked(
    core: Any, project: Path, receipt_path: Path, receipt: Mapping[str, Any]
) -> None:
    run_id = str(receipt["run_id"])
    attempt_id = str(receipt["attempt_id"])
    run_path = project / "creative-system" / "runs" / run_id / "run.json"
    run = core.load_json(
        core.regular_project_file(
            project, run_path.relative_to(project).as_posix(), "terminated run record"
        )
    )
    if not isinstance(run, dict) or run.get("run_id") != run_id:
        raise AppRequestError("terminated run record 无效")
    if attempt_id in run.get("attempts", []):
        raise AppRequestError("terminated attempt 不得同时进入 sealed attempts")
    current = run.get("current_attempt")
    if current not in {attempt_id, None}:
        raise AppRequestError("run.current_attempt 与 TerminatedAttempt 冲突")
    terminated = run.get("terminated_attempts", [])
    if not isinstance(terminated, list) or any(
        not isinstance(item, str) for item in terminated
    ):
        raise AppRequestError("run.terminated_attempts 无效")
    if attempt_id not in terminated:
        terminated = [*terminated, attempt_id]
    relative = receipt_path.relative_to(project).as_posix()
    digest = core.sha256_file(receipt_path)
    projected = dict(run)
    projected.update(
        {
            "current_attempt": None,
            "execution_status": "BLOCK",
            "quality_status": "NOT_EVALUATED",
            "release_status": "BLOCK",
            "last_decision": "stop",
            "terminated_attempts": terminated,
            "terminal_attempt": attempt_id,
            "terminal_outcome": receipt.get("outcome"),
            "terminal_error_code": receipt.get("error_code"),
            "terminal_receipt": relative,
            "terminal_receipt_sha256": digest,
        }
    )
    if projected != run:
        core.atomic_write_json(run_path, projected)


def _project_system_from_latest_run_locked(core: Any, project: Path) -> None:
    runs_root = project / "creative-system" / "runs"
    latest: Optional[tuple[str, Dict[str, Any]]] = None
    if runs_root.is_dir() and not runs_root.is_symlink():
        for run_path in runs_root.glob("*/run.json"):
            if run_path.is_symlink() or not run_path.is_file():
                continue
            run = core.load_json(run_path)
            if not isinstance(run, dict) or not isinstance(run.get("created_at"), str):
                continue
            ordering = f"{run['created_at']}\x00{run_path.parent.name}"
            if latest is None or ordering > latest[0]:
                latest = (ordering, run)
    if latest is None:
        return
    run = latest[1]
    statuses = {
        "execution_status": run.get("execution_status"),
        "quality_status": run.get("quality_status"),
        "release_status": run.get("release_status"),
    }
    if (
        statuses["execution_status"] not in {"NOT_STARTED", "RUNNING", "PASS", "BLOCK"}
        or statuses["quality_status"]
        not in {"NOT_EVALUATED", "PASS", "WARN", "NEEDS_TASTE"}
        or statuses["release_status"]
        not in {"NOT_READY", "CANDIDATE", "PASS", "BLOCK"}
    ):
        raise AppRequestError("最新 run 状态无效，无法恢复 system 投影")
    system = core.load_system(project)
    if system.get("statuses") != statuses:
        system["statuses"] = statuses
        core.atomic_write_json(core.system_path(project), system)


def _legacy_error_code_from_provenance(provenance: Mapping[str, Any]) -> str:
    requests = provenance.get("requests")
    if isinstance(requests, list) and requests:
        item = requests[-1]
        if (
            isinstance(item, dict)
            and item.get("status") == "FAILED"
            and isinstance(item.get("error_code"), str)
            and item.get("error_code")
        ):
            return str(item["error_code"])
    return "RUNTIME_FAILED"


def _migrate_legacy_app_terminations_locked(core: Any, project: Path) -> None:
    runs_root = project / "creative-system" / "runs"
    if not runs_root.is_dir() or runs_root.is_symlink():
        return
    for run_path in sorted(runs_root.glob("*/run.json")):
        run = core.load_json(run_path)
        if not isinstance(run, dict) or not isinstance(run.get("work_id"), str):
            continue
        attempt_id = run.get("current_attempt")
        if not isinstance(attempt_id, str):
            continue
        attempt_dir = run_path.parent / "attempts" / attempt_id
        marker = _termination_receipt_path(attempt_dir)
        if marker.exists() or (attempt_dir / ".sealed.json").exists():
            continue
        stalled: list[tuple[str, Path, Dict[str, Any], Dict[str, Any]]] = []
        has_open = False
        for dispatch_dir in core.dispatch_directories(attempt_dir):
            dispatch = core.load_dispatch_record(project, attempt_dir, dispatch_dir)
            stall = core.load_dispatch_stall(project, attempt_dir, dispatch_dir, dispatch)
            if stall is None:
                has_open = True
                break
            stalled.append((str(stall.get("recorded_at", "")), dispatch_dir, dispatch, stall))
        if has_open or not stalled:
            continue
        _, dispatch_dir, dispatch, stall = sorted(stalled, key=lambda item: item[0])[-1]
        attestation = stall.get("orchestrator_attestation")
        reason = attestation.get("reason") if isinstance(attestation, dict) else None
        if reason not in LEGACY_APP_TERMINATION_REASONS:
            continue
        provenance_path = attempt_dir / f"runtime-provenance-{dispatch_dir.name}.json"
        if not provenance_path.is_file() or provenance_path.is_symlink():
            continue
        provenance = _validate_runtime_provenance_record(
            core, project, str(run.get("run_id", run_path.parent.name)), provenance_path
        )
        inventory = core.regular_file_inventory(
            dispatch_dir / "artifacts", label="legacy terminated dispatch artifacts"
        )
        if inventory:
            continue
        outcome = (
            "CANCELLED"
            if reason in LEGACY_APP_CANCELLED_REASONS
            else "FAILED"
        )
        receipt = _build_termination_receipt(
            core,
            run=run,
            run_id=str(run.get("run_id", run_path.parent.name)),
            attempt_id=attempt_id,
            dispatch_id=dispatch_dir.name,
            outcome=outcome,
            reason=str(reason),
            error_code=(
                None
                if outcome == "CANCELLED"
                else _legacy_error_code_from_provenance(provenance)
            ),
            termination_class="ZERO_FILE_RUNTIME_FAILURE",
            stall_ref=_evidence_ref(core, project, dispatch_dir / "stall.json", "dispatch stall"),
            provenance_ref=_evidence_ref(
                core, project, provenance_path, "termination runtime provenance"
            ),
            artifact_inventory=[],
        )
        core.atomic_create_json(marker, receipt)


def _reconcile_terminated_attempts_locked(core: Any, project: Path) -> None:
    _migrate_legacy_app_terminations_locked(core, project)
    runs_root = project / "creative-system" / "runs"
    if runs_root.is_dir() and not runs_root.is_symlink():
        for receipt_path in sorted(runs_root.glob("*/attempts/attempt-*/.terminated.json")):
            attempt_dir = receipt_path.parent
            receipt = _load_termination_receipt(core, project, attempt_dir)
            _verify_termination_receipt(core, project, attempt_dir, receipt)
            _apply_termination_run_projection_locked(
                core, project, receipt_path, receipt
            )
    _project_system_from_latest_run_locked(core, project)


def _assert_run_not_terminated_locked(
    core: Any, project: Path, run_id: str
) -> Dict[str, Any]:
    run_path = core.regular_project_file(
        project,
        f"creative-system/runs/{run_id}/run.json",
        "mutable app run",
    )
    run = core.load_json(run_path)
    if not isinstance(run, dict) or run.get("run_id") != run_id:
        raise AppRequestError("run.json 无效")
    if run.get("terminal_receipt") is not None or run.get("terminal_attempt") is not None:
        raise AppRequestError("run 已终止，拒绝继续写入、反馈或封存")
    current_attempt = run.get("current_attempt")
    if isinstance(current_attempt, str):
        marker = run_path.parent / "attempts" / current_attempt / ".terminated.json"
        if os.path.lexists(str(marker)):
            raise AppRequestError("run 已有 TerminatedAttempt marker，拒绝继续修改")
    return run


def _assert_existing_termination_matches_request(
    core: Any,
    project: Path,
    run_id: str,
    dispatch: Mapping[str, Any],
    receipt: Mapping[str, Any],
    *,
    dispatch_id: str,
    outcome: str,
    reason: str,
    error_code: Optional[str],
    raw_provenance: Any,
) -> None:
    """Compare a retry against the immutable terminal fact without writing.

    A ``.terminated.json`` marker is the commit point.  Once it exists, even a
    conflicting retry must be a zero-side-effect rejection: in particular it
    must not create a new runtime provenance file before discovering that the
    first writer already committed a different semantic.
    """

    if (
        receipt.get("dispatch_id") != dispatch_id
        or receipt.get("outcome") != outcome
        or receipt.get("lifecycle_reason") != reason
        or receipt.get("error_code") != error_code
    ):
        raise AppRequestError("同一 attempt 已绑定不同终止语义")
    if raw_provenance is None:
        return
    provenance_ref = receipt.get("runtime_provenance")
    if not isinstance(provenance_ref, dict) or not isinstance(
        provenance_ref.get("path"), str
    ):
        raise AppRequestError("同一 attempt 已绑定不同终止语义")
    provenance = _runtime_provenance(
        core,
        raw_provenance,
        run_id,
        require_completed=False,
        allow_legacy_termination=True,
        fallback_created_at=dispatch.get("opened_at"),
        expected_context_sha256=_work_task_context_sha256(core, project, run_id),
    )
    encoded = (
        json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    provenance_path = core.regular_project_file(
        project,
        provenance_ref["path"],
        "termination runtime provenance",
    )
    if provenance_path.read_bytes() != encoded:
        raise AppRequestError("同一 attempt 已绑定不同终止语义")


def _terminate_work(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "dispatch_id",
            "error_code",
            "outcome",
            "project",
            "reason",
            "run_id",
            "runtime_provenance",
        },
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    run_id = _id(payload.get("run_id"), "run_id")
    dispatch_id = _id(payload.get("dispatch_id"), "dispatch_id")
    outcome = _text(payload.get("outcome"), "outcome", maximum=20)
    if outcome not in TERMINATION_OUTCOMES:
        raise AppRequestError("outcome 必须是 FAILED 或 CANCELLED")
    reason = _text(payload.get("reason"), "reason", maximum=500)
    raw_error_code = payload.get("error_code")
    error_code = (
        None
        if raw_error_code is None
        else _text(raw_error_code, "error_code", maximum=160)
    )
    if outcome == "FAILED" and error_code is None:
        raise AppRequestError("FAILED terminate_work 必须提供 error_code")
    if outcome == "CANCELLED" and error_code is not None:
        raise AppRequestError("CANCELLED terminate_work 不得提供 error_code")

    with core.exclusive_controller_lock(project):
        validation = core.validate_project(project)
        if validation["errors"]:
            raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
        run, _, attempt_id, attempt_dir, dispatch_dir, dispatch = _termination_context(
            core, project, run_id, dispatch_id
        )
        if (attempt_dir / ".sealed.json").exists():
            raise AppRequestError("已封存作品不得转为 terminated")
        core.ensure_attempt_not_terminal_invalid(attempt_dir)
        receipt_path = _termination_receipt_path(attempt_dir)
        if os.path.lexists(str(receipt_path)):
            if receipt_path.is_symlink() or not receipt_path.is_file():
                raise AppRequestError("TerminatedAttempt 路径被非普通文件占用")
            receipt = _load_termination_receipt(core, project, attempt_dir)
            _verify_termination_receipt(core, project, attempt_dir, receipt)
            _assert_existing_termination_matches_request(
                core,
                project,
                run_id,
                dispatch,
                receipt,
                dispatch_id=dispatch_id,
                outcome=outcome,
                reason=reason,
                error_code=error_code,
                raw_provenance=payload.get("runtime_provenance"),
            )
            _apply_termination_run_projection_locked(
                core, project, receipt_path, receipt
            )
            _project_system_from_latest_run_locked(core, project)
            return {
                "status": "PASS",
                "run_id": run_id,
                "attempt_id": attempt_id,
                "dispatch_id": dispatch_id,
                "outcome": outcome,
                "execution_status": "BLOCK",
                "terminal_receipt": receipt_path.relative_to(project).as_posix(),
                "terminal_receipt_sha256": core.sha256_file(receipt_path),
                "content_attempt_consumed": receipt.get(
                    "content_attempt_consumed"
                ),
                "finding_eligible": False,
                "idempotent": True,
                "next_action": "使用新 run_id 并通过 recovery_of 关联本 run",
            }
        try:
            core.verify_human_review_subject(project, attempt_dir)
        except core.LoopCtlError:
            pass
        else:
            raise AppRequestError("已冻结送审作品不得转为 terminated")

        provenance_ref = _persist_termination_provenance_locked(
            core,
            project,
            run_id,
            attempt_dir,
            dispatch_id,
            dispatch,
            payload.get("runtime_provenance"),
        )
        inventory = core.regular_file_inventory(
            dispatch_dir / "artifacts", label="terminate_work dispatch artifacts"
        )
        stall = core.load_dispatch_stall(project, attempt_dir, dispatch_dir, dispatch)
        stall_ref: Optional[Dict[str, str]] = None
        if inventory:
            if stall is not None:
                raise AppRequestError(
                    "LATE_WRITE_CONTAMINATION：已 stall dispatch 后出现产物"
                )
            termination_class = "UNCOMMITTED_OUTPUT_FAILURE"
        else:
            termination_class = "ZERO_FILE_RUNTIME_FAILURE"
            if stall is None:
                core.command_record_dispatch_stall_locked(
                    Namespace(
                        project=str(project),
                        run_id=run_id,
                        dispatch_id=dispatch_id,
                        context_stopped=True,
                        reason=reason,
                    ),
                    project,
                    run_id,
                )
            else:
                attestation = stall.get("orchestrator_attestation")
                if (
                    not isinstance(attestation, dict)
                    or attestation.get("reason") != reason
                ):
                    raise AppRequestError("dispatch 已由不同原因结束，拒绝覆盖")
            stall_ref = _evidence_ref(
                core, project, dispatch_dir / "stall.json", "dispatch stall"
            )

        verified_inventory = _termination_attempt_inventory(
            core,
            project,
            attempt_dir,
            dispatch_id,
        )
        if verified_inventory != inventory:
            raise AppRequestError(
                "terminate_work artifact inventory 在终态提交前发生变化"
            )

        candidate = _build_termination_receipt(
            core,
            run=run,
            run_id=run_id,
            attempt_id=attempt_id,
            dispatch_id=dispatch_id,
            outcome=outcome,
            reason=reason,
            error_code=error_code,
            termination_class=termination_class,
            stall_ref=stall_ref,
            provenance_ref=provenance_ref,
            artifact_inventory=inventory,
        )
        receipt_path = _termination_receipt_path(attempt_dir)
        idempotent = os.path.lexists(str(receipt_path))
        if idempotent:
            if receipt_path.is_symlink() or not receipt_path.is_file():
                raise AppRequestError("TerminatedAttempt 路径被非普通文件占用")
            receipt = _load_termination_receipt(core, project, attempt_dir)
            if _termination_semantic(receipt) != _termination_semantic(candidate):
                raise AppRequestError("同一 attempt 已绑定不同终止语义")
        else:
            core.atomic_create_json(receipt_path, candidate)
            receipt = candidate
        _verify_termination_receipt(core, project, attempt_dir, receipt)
        _apply_termination_run_projection_locked(
            core, project, receipt_path, receipt
        )
        _project_system_from_latest_run_locked(core, project)
        return {
            "status": "PASS",
            "run_id": run_id,
            "attempt_id": attempt_id,
            "dispatch_id": dispatch_id,
            "outcome": outcome,
            "execution_status": "BLOCK",
            "terminal_receipt": receipt_path.relative_to(project).as_posix(),
            "terminal_receipt_sha256": core.sha256_file(receipt_path),
            "content_attempt_consumed": receipt.get("content_attempt_consumed"),
            "finding_eligible": False,
            "idempotent": idempotent,
            "next_action": "使用新 run_id 并通过 recovery_of 关联本 run",
        }


def _runtime_provenance(
    core: Any,
    value: Any,
    run_id: str,
    *,
    require_completed: bool = True,
    allow_legacy_termination: bool = False,
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
    current_policy = _uses_fixed_model_parameters(
        parameters, CURRENT_MODEL_MAX_OUTPUT_TOKENS
    )
    legacy_termination = allow_legacy_termination and _uses_fixed_model_parameters(
        parameters, LEGACY_MODEL_MAX_OUTPUT_TOKENS
    )
    if not current_policy and not legacy_termination:
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
        _reconcile_terminated_attempts_locked(core, project)
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
    if _termination_receipt_path(attempt_dir).is_file():
        receipt = _load_termination_receipt(core, project, attempt_dir)
        _verify_termination_receipt(core, project, attempt_dir, receipt)
        return None
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
        "method_version": run.get("app_method_version_at_start", "baseline-v1"),
        "method_guidance_sha256": run.get("app_method_guidance_sha256"),
    }


def _interrupted_attempt(
    core: Any,
    project: Path,
    run: Mapping[str, Any],
    run_dir: Path,
    attempt_dir: Path,
) -> Dict[str, Any]:
    termination_path = _termination_receipt_path(attempt_dir)
    if termination_path.is_file():
        receipt = _load_termination_receipt(core, project, attempt_dir)
        _verify_termination_receipt(core, project, attempt_dir, receipt)
        return {
            "run_id": run.get("run_id", run_dir.name),
            "work_id": run.get("work_id", run_dir.name),
            "attempt_id": attempt_dir.name,
            "dispatch_id": receipt.get("dispatch_id"),
            "state": f"TERMINATED_{receipt.get('outcome')}",
            "reason_code": receipt.get("error_code")
            or receipt.get("lifecycle_reason"),
            "outcome": receipt.get("outcome"),
            "execution_status": "BLOCK",
            "termination_class": receipt.get("termination_class"),
            "terminal_receipt": termination_path.relative_to(project).as_posix(),
            "terminal_receipt_sha256": core.sha256_file(termination_path),
            "content_attempt_consumed": receipt.get("content_attempt_consumed"),
            "finding_eligible": False,
        }
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


def _candidate_root(project: Path, candidate_id: str) -> Path:
    return project / "creative-system" / "app-methods" / "candidates" / candidate_id


def _candidate_pending_root(project: Path, candidate_id: str) -> Path:
    return (
        project
        / "creative-system"
        / "app-methods"
        / "candidates"
        / f".pending-{candidate_id}"
    )


def _method_builder_intent_path(project: Path, candidate_id: str) -> Path:
    return (
        project
        / "creative-system"
        / "app-methods"
        / "builder-preparations"
        / f"{candidate_id}.json"
    )


def _method_builder_failure_path(project: Path, candidate_id: str) -> Path:
    return (
        project
        / "creative-system"
        / "app-methods"
        / "builder-failures"
        / f"{candidate_id}.json"
    )


def _method_builder_rejection_path(project: Path, candidate_id: str) -> Path:
    return (
        project
        / "creative-system"
        / "app-methods"
        / "builder-rejections"
        / f"{candidate_id}.json"
    )


def _validated_method_builder_intent(
    core: Any,
    project: Path,
    candidate_id: str,
    *,
    required: bool = False,
) -> Optional[tuple[Path, Dict[str, Any]]]:
    path = _method_builder_intent_path(project, candidate_id)
    if not os.path.lexists(str(path)):
        if required:
            raise AppRequestError("Candidate Builder 调用缺少不可变准备 intent")
        return None
    verified = core.regular_project_file(
        project,
        path.relative_to(project).as_posix(),
        "AppMethodBuilderIntent",
    )
    intent = core.load_json(verified)
    expected_keys = {
        "builder_context_sha256",
        "candidate_id",
        "content_hash",
        "created_at",
        "expected_epoch_sha256",
        "guidance_persisted",
        "id",
        "kind",
        "observation_id",
        "output_persisted",
        "reasoning_persisted",
        "runtime_provenance_persisted",
        "schema_version",
        "source_refs",
    }
    if (
        not isinstance(intent, dict)
        or set(intent) != expected_keys
        or intent.get("kind") != "AppMethodBuilderIntent"
        or intent.get("id") != f"builder-intent-{candidate_id}"
        or intent.get("candidate_id") != candidate_id
        or not isinstance(intent.get("observation_id"), str)
        or not re.fullmatch(
            r"[0-9a-f]{64}", str(intent.get("builder_context_sha256", ""))
        )
        or not re.fullmatch(
            r"[0-9a-f]{64}", str(intent.get("expected_epoch_sha256", ""))
        )
        or intent.get("guidance_persisted") is not False
        or intent.get("output_persisted") is not False
        or intent.get("reasoning_persisted") is not False
        or intent.get("runtime_provenance_persisted") is not False
        or intent.get("source_refs") != []
        or intent.get("content_hash") != core.app_record_content_hash(intent)
    ):
        raise AppRequestError("Candidate Builder 准备 intent 合同或摘要无效")
    return verified, intent


def _validated_method_builder_failure(
    core: Any,
    project: Path,
    candidate_id: str,
    intent: Mapping[str, Any],
) -> Optional[tuple[Path, Dict[str, Any]]]:
    path = _method_builder_failure_path(project, candidate_id)
    if not os.path.lexists(str(path)):
        return None
    verified = core.regular_project_file(
        project,
        path.relative_to(project).as_posix(),
        "AppMethodBuilderFailure",
    )
    failure = core.load_json(verified)
    expected_keys = {
        "candidate_id",
        "content_hash",
        "created_at",
        "error_code",
        "expected_context_sha256",
        "expected_epoch_sha256",
        "id",
        "kind",
        "observed_evidence_sha256",
        "observation_id",
        "schema_version",
        "source_refs",
    }
    if (
        not isinstance(failure, dict)
        or set(failure) != expected_keys
        or failure.get("kind") != "AppMethodBuilderFailure"
        or failure.get("id") != f"builder-failure-{candidate_id}"
        or failure.get("candidate_id") != candidate_id
        or failure.get("observation_id") != intent.get("observation_id")
        or failure.get("error_code")
        not in {"METHOD_EPOCH_CHANGED", "METHOD_EPOCH_UNVERIFIABLE"}
        or failure.get("expected_context_sha256")
        != intent.get("builder_context_sha256")
        or failure.get("expected_epoch_sha256")
        != intent.get("expected_epoch_sha256")
        or not re.fullmatch(
            r"[0-9a-f]{64}", str(failure.get("observed_evidence_sha256", ""))
        )
        or failure.get("source_refs") != []
        or failure.get("content_hash") != core.app_record_content_hash(failure)
    ):
        raise AppRequestError("Candidate Builder failure marker 合同或摘要无效")
    return verified, failure


def _write_method_builder_failure_marker_locked(
    core: Any,
    project: Path,
    candidate_id: str,
    intent: Mapping[str, Any],
    *,
    error_code: str,
    observed_evidence_sha256: str,
) -> tuple[bool, Path, Dict[str, Any]]:
    if error_code not in {"METHOD_EPOCH_CHANGED", "METHOD_EPOCH_UNVERIFIABLE"}:
        raise AppRequestError("Candidate Builder failure error_code 无效")
    existing = _validated_method_builder_failure(
        core, project, candidate_id, intent
    )
    if existing is not None:
        failure_path, failure = existing
        if (
            failure.get("error_code") != error_code
            or failure.get("observed_evidence_sha256")
            != observed_evidence_sha256
        ):
            raise AppRequestError("Candidate Builder 已绑定不同 failure 证据")
        return True, failure_path, failure
    failure = _record(
        core,
        "AppMethodBuilderFailure",
        f"builder-failure-{candidate_id}",
        {
            "candidate_id": candidate_id,
            "observation_id": intent.get("observation_id"),
            "error_code": error_code,
            "expected_context_sha256": intent.get("builder_context_sha256"),
            "expected_epoch_sha256": intent.get("expected_epoch_sha256"),
            "observed_evidence_sha256": observed_evidence_sha256,
        },
    )
    failure_path = _method_builder_failure_path(project, candidate_id)
    core.guarded_mkdir_project(
        project, failure_path.parent, "method builder failure markers"
    )
    core.atomic_create_json(failure_path, failure)
    validated_failure = _validated_method_builder_failure(
        core, project, candidate_id, intent
    )
    if validated_failure is None:
        raise AppRequestError("Candidate Builder failure marker 未成功封存")
    failure_path, failure = validated_failure
    return False, failure_path, failure


def _validated_method_builder_rejection(
    core: Any,
    project: Path,
    candidate_id: str,
    intent: Mapping[str, Any],
) -> Optional[tuple[Path, Dict[str, Any]]]:
    path = _method_builder_rejection_path(project, candidate_id)
    if not os.path.lexists(str(path)):
        return None
    verified = core.regular_project_file(
        project,
        path.relative_to(project).as_posix(),
        "AppMethodBuilderRejectionReceipt",
    )
    receipt = core.load_json(verified)
    expected_keys = {
        "active_method_unchanged",
        "candidate_id",
        "content_hash",
        "created_at",
        "id",
        "intent_sha256",
        "kind",
        "rejected_by",
        "schema_version",
        "source_refs",
    }
    if (
        not isinstance(receipt, dict)
        or set(receipt) != expected_keys
        or receipt.get("kind") != "AppMethodBuilderRejectionReceipt"
        or receipt.get("id") != f"builder-rejection-{candidate_id}"
        or receipt.get("candidate_id") != candidate_id
        or receipt.get("intent_sha256")
        != core.sha256_file(_method_builder_intent_path(project, candidate_id))
        or receipt.get("rejected_by") != "local-app-user"
        or receipt.get("active_method_unchanged") is not True
        or receipt.get("source_refs") != []
        or receipt.get("content_hash") != core.app_record_content_hash(receipt)
    ):
        raise AppRequestError("Candidate Builder 拒绝 receipt 合同或摘要无效")
    return verified, receipt


def _active_method_builder_preparation(
    core: Any, project: Path, observation_id: str
) -> Optional[tuple[str, Dict[str, Any]]]:
    root = (
        project
        / "creative-system"
        / "app-methods"
        / "builder-preparations"
    )
    if not os.path.lexists(str(root)):
        return None
    if root.is_symlink() or not root.is_dir():
        raise AppRequestError("Candidate Builder 准备根目录无效")
    matches: list[tuple[str, Dict[str, Any]]] = []
    for item in sorted(root.iterdir(), key=lambda path: path.name):
        if item.name == ".gitkeep":
            continue
        if item.is_symlink() or not item.is_file() or item.suffix != ".json":
            raise AppRequestError("Candidate Builder 准备目录含未声明条目")
        candidate_id = _id(item.stem, "builder preparation candidate_id")
        validated = _validated_method_builder_intent(
            core, project, candidate_id, required=True
        )
        if validated is None:
            raise AppRequestError("Candidate Builder 准备 intent 缺失")
        _, intent = validated
        _validated_method_builder_failure(
            core, project, candidate_id, intent
        )
        rejection = _validated_method_builder_rejection(
            core, project, candidate_id, intent
        )
        if (
            intent.get("observation_id") == observation_id
            and rejection is None
            and not os.path.lexists(str(_candidate_root(project, candidate_id)))
        ):
            matches.append((candidate_id, intent))
    if len(matches) > 1:
        raise AppRequestError(
            "同一观察存在多个未完成 Candidate Builder 准备；请先放弃多余准备"
        )
    return matches[0] if matches else None


def _reconcile_method_candidate_pending(core: Any, project: Path) -> None:
    candidates_root = project / "creative-system" / "app-methods" / "candidates"
    if not os.path.lexists(str(candidates_root)):
        return
    if candidates_root.is_symlink() or not candidates_root.is_dir():
        raise AppRequestError("方法候选根目录不是普通目录")
    pending_entries = [
        item
        for item in candidates_root.iterdir()
        if item.name.startswith(".") and item.name != ".gitkeep"
    ]
    for pending in sorted(pending_entries, key=lambda item: item.name):
        if not pending.name.startswith(".pending-"):
            raise AppRequestError(
                "方法候选存在旧版未治理的崩溃残留；为避免重复付费，拒绝新建候选"
            )
        candidate_id = pending.name.removeprefix(".pending-")
        _id(candidate_id, "pending candidate_id")
        builder_intent = _validated_method_builder_intent(
            core, project, candidate_id, required=True
        )
        if builder_intent is None:
            raise AppRequestError("pending 方法候选缺少 Builder intent")
        if _validated_method_builder_rejection(
            core, project, candidate_id, builder_intent[1]
        ) is not None:
            # The user explicitly abandoned this paid-result window.  Keep the
            # immutable pending tree for audit, but do not let it lock a later
            # candidate for the same observation.
            continue
        if pending.is_symlink() or not pending.is_dir():
            raise AppRequestError("pending 方法候选不是普通目录")
        if {item.name for item in pending.iterdir()} != {
            "builder-provenance.json",
            "proposal.json",
            "status.json",
        }:
            raise AppRequestError(
                "Candidate Builder 付费结果只完成部分持久化；不会重跑，请保留现场处理"
            )
        final = _candidate_root(project, candidate_id)
        if os.path.lexists(str(final)):
            raise AppRequestError("同一 candidate 同时存在 committed 与 pending 目录")
        os.rename(str(pending), str(final))
        _, proposal, _ = _load_method_candidate(core, project, candidate_id)
        # A structurally complete tree is not recoverable until Builder
        # provenance, frozen source context and epoch all bind back to proposal.
        _candidate_evaluation_plan(core, project, proposal)


def _load_method_candidate(
    core: Any, project: Path, candidate_id: str
) -> tuple[Path, Dict[str, Any], Dict[str, Any]]:
    root = _candidate_root(project, candidate_id)
    if root.is_symlink() or not root.is_dir():
        raise AppRequestError("方法候选不存在或不是普通目录")
    proposal_path = core.regular_project_file(
        project,
        (root / "proposal.json").relative_to(project).as_posix(),
        "AppMethodCandidate proposal",
    )
    status_path = core.regular_project_file(
        project,
        (root / "status.json").relative_to(project).as_posix(),
        "AppMethodCandidate status",
    )
    proposal = core.load_json(proposal_path)
    status = core.load_json(status_path)
    if (
        not isinstance(proposal, dict)
        or proposal.get("kind") != "AppMethodCandidate"
        or proposal.get("id") != candidate_id
        or proposal.get("content_hash") != core.app_record_content_hash(proposal)
        or not isinstance(status, dict)
        or status.get("kind") != "AppMethodCandidateStatus"
        or status.get("candidate_id") != candidate_id
        or status.get("proposal_sha256") != core.sha256_file(proposal_path)
        or status.get("content_hash") != core.app_record_content_hash(status)
    ):
        raise AppRequestError("方法候选合同或摘要无效")
    return root, proposal, status


def _production_context_snapshot(
    core: Any, project: Path, system: Optional[Mapping[str, Any]] = None
) -> Dict[str, Any]:
    current_system = dict(system) if system is not None else core.load_system(project)
    initial = _initial_intent_snapshot(core, project, current_system)
    registry = _method_registry(core, project)
    if _validated_method_rollback_receipts(core, project, registry):
        raise AppRequestError("rollback receipt 尚未投影；请先恢复方法注册表")
    active = str(registry.get("active_method_version"))
    if active == "baseline-v1":
        if registry.get("active_guidance_sha256") is not None:
            raise AppRequestError("基线方法不得绑定候选指导")
        return {
            "status": "PASS",
            "method_version": active,
            "guidance": None,
            "guidance_sha256": None,
            "context_sha256": initial["sha256"],
            "initial_intent": initial["text"],
            "formal_l4": False,
        }
    _, proposal, status = _load_method_candidate(core, project, active)
    if status.get("lifecycle") != "PROMOTED":
        raise AppRequestError("active method 未绑定 PROMOTED 候选")
    promotion_relative = status.get("promotion_receipt")
    promotion_path = core.regular_project_file(
        project, promotion_relative, "AppMethodPromotionReceipt"
    )
    promotion = core.load_json(promotion_path)
    guidance = proposal.get("guidance")
    guidance_sha256 = proposal.get("guidance_sha256")
    if (
        not isinstance(promotion, dict)
        or promotion.get("kind") != "AppMethodPromotionReceipt"
        or promotion.get("candidate_id") != active
        or promotion.get("content_hash") != core.app_record_content_hash(promotion)
        or not isinstance(guidance, str)
        or guidance_sha256 != core.sha256_bytes(guidance.encode("utf-8"))
        or registry.get("active_guidance_sha256") != guidance_sha256
    ):
        raise AppRequestError("active method 晋升证据或指导摘要无效")
    context_sha256 = core.sha256_bytes(
        core.canonical_json_bytes(
            {
                "initial_intent_sha256": initial["sha256"],
                "method_version": active,
                "guidance_sha256": guidance_sha256,
            }
        )
    )
    return {
        "status": "PASS",
        "method_version": active,
        "guidance": guidance,
        "guidance_sha256": guidance_sha256,
        "context_sha256": context_sha256,
        "initial_intent": initial["text"],
        "formal_l4": False,
    }


def _production_context(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"project"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    with core.exclusive_controller_lock(project):
        _reconcile_method_rollbacks_locked(core, project)
    validation = core.validate_project(project)
    if validation["errors"]:
        raise AppRequestError("项目合同未通过：" + "; ".join(validation["errors"]))
    return _production_context_snapshot(core, project)


def _method_epoch_value(
    core: Any,
    run: Mapping[str, Any],
    provenance: Mapping[str, Any],
) -> Dict[str, Any]:
    method_version = _id(
        run.get("app_method_version_at_start", "baseline-v1"),
        "method epoch method_version",
    )
    requested_model = _text(
        provenance.get("requested_model"),
        "method epoch requested_model",
        maximum=80,
    )
    returned_model = _text(
        provenance.get("returned_model"),
        "method epoch returned_model",
        maximum=160,
    )
    if requested_model != returned_model:
        raise AppRequestError("方法基线 requested/returned model 不一致")
    fingerprint = _text(
        provenance.get("system_fingerprint"),
        "method epoch system_fingerprint",
        maximum=300,
    )
    profile_sha256 = _text(
        provenance.get("profile_sha256"),
        "method epoch profile_sha256",
        maximum=64,
    )
    if not re.fullmatch(r"[0-9a-f]{64}", profile_sha256):
        raise AppRequestError("方法基线 profile_sha256 无效")
    parameters = _mapping(provenance.get("parameters"), "method epoch parameters")
    _exact_keys(
        parameters,
        "method epoch parameters",
        {"max_tokens", "reasoning_effort", "thinking"},
    )
    if not (
        _uses_fixed_model_parameters(parameters, LEGACY_MODEL_MAX_OUTPUT_TOKENS)
        or _uses_fixed_model_parameters(parameters, CURRENT_MODEL_MAX_OUTPUT_TOKENS)
    ):
        raise AppRequestError("方法基线模型参数与 v1 固定策略不一致")
    value = {
        "method_version": method_version,
        "requested_model": requested_model,
        "returned_model": returned_model,
        "system_fingerprint": fingerprint,
        "profile_sha256": profile_sha256,
        "parameters": dict(parameters),
    }
    return {
        "value": value,
        "sha256": core.sha256_bytes(core.canonical_json_bytes(value)),
    }


def _method_epoch_for_attempt(
    core: Any,
    project: Path,
    run_id: str,
    attempt_id: str,
) -> Optional[Dict[str, Any]]:
    run_dir = project / "creative-system" / "runs" / run_id
    run_path = core.regular_project_file(
        project,
        (run_dir / "run.json").relative_to(project).as_posix(),
        "method epoch run",
    )
    raw_provenance_path = run_dir / "attempts" / attempt_id / "runtime-provenance.json"
    if not os.path.lexists(str(raw_provenance_path)):
        return None
    provenance_path = core.regular_project_file(
        project,
        raw_provenance_path.relative_to(project).as_posix(),
        "method epoch RuntimeProvenance",
    )
    run = core.load_json(run_path)
    provenance = core.load_json(provenance_path)
    if (
        not isinstance(run, dict)
        or run.get("run_id") != run_id
        or not isinstance(provenance, dict)
        or provenance.get("kind") != "RuntimeProvenance"
        or provenance.get("run_id") != run_id
        or provenance.get("content_hash") != core.app_record_content_hash(provenance)
    ):
        raise AppRequestError("方法基线 run 或 RuntimeProvenance 无效")
    return _method_epoch_value(core, run, provenance)


def _validated_method_feedback_finding(
    core: Any,
    project: Path,
    manifest: Mapping[str, Any],
    finding: Mapping[str, Any],
) -> Optional[Dict[str, Any]]:
    """Return direct app-feedback authority or exclude unverified legacy findings.

    A sealed manifest may contain a mechanically valid Finding copied through the
    legacy ``seal_feedback(finding_paths=...)`` seam.  That is historical evidence,
    but it is not proof that the local user actually submitted the text through the
    app.  Method learning therefore requires the complete app transaction chain.
    """

    run_id = manifest.get("run_id")
    attempt_id = manifest.get("attempt_id")
    work_id = manifest.get("work_id")
    if not all(isinstance(value, str) for value in (run_id, attempt_id, work_id)):
        return None

    human_receipt = manifest.get("human_feedback_receipt")
    if not isinstance(human_receipt, dict):
        return None
    manifest_source = human_receipt.get("source_evidence")
    if not isinstance(manifest_source, dict):
        return None
    source_path_value = manifest_source.get("path")
    if not isinstance(source_path_value, str) or not source_path_value.startswith(
        "creative-system/approvals/attempt-feedback/app-"
    ):
        return None

    transaction = _feedback_transaction_for_run(core, project, str(run_id))
    if transaction is None:
        return None
    intent, transaction_dir = transaction
    if intent.get("attempt_id") != attempt_id:
        return None
    recorded_path = transaction_dir / "recorded.json"
    committed_path = transaction_dir / "committed.json"
    if not os.path.lexists(str(recorded_path)) or not os.path.lexists(
        str(committed_path)
    ):
        return None

    recorded = _validate_feedback_recorded_marker(
        core, project, recorded_path, intent
    )
    committed = _validate_feedback_committed_marker(
        core, project, committed_path, intent, recorded
    )
    receipt_relative = recorded.get("receipt")
    receipt = _load_app_feedback_receipt(core, project, receipt_relative)
    receipt_path = core.regular_project_file(
        project, receipt_relative, "method AppFeedbackReceipt"
    )
    source = _mapping(receipt.get("source_evidence"), "method feedback source")
    source_path = core.regular_project_file(
        project, source.get("path"), "method feedback source"
    )
    source_payload = core.load_json(source_path)
    feedback_text = (
        source_payload.get("feedback_text")
        if isinstance(source_payload, dict)
        else None
    )
    if not isinstance(feedback_text, str) or not feedback_text.strip():
        return None

    normalized_sha256 = hashlib.sha256(
        _feedback_normalized(feedback_text).encode("utf-8")
    ).hexdigest()
    expected_code = _feedback_finding_code(feedback_text)
    expected_evidence = [
        {
            "path": source.get("path"),
            "sha256": source.get("sha256"),
            "authority": "direct-user-feedback",
        }
    ]
    if (
        receipt.get("run_id") != run_id
        or receipt.get("attempt_id") != attempt_id
        or receipt.get("work_id") != work_id
        or receipt.get("claims") != human_receipt.get("claims")
        or receipt.get("feedback_at") != human_receipt.get("feedback_at")
        or manifest_source != source
        or source.get("sha256") != core.sha256_file(source_path)
        or source.get("bytes") != source_path.stat().st_size
        or finding.get("code") != expected_code
        or finding.get("category") != "soft-quality"
        or finding.get("severity") != "medium"
        or finding.get("confidence") != 1.0
        or finding.get("owner") != "creative-producer"
        or finding.get("suggested_action") != feedback_text
        or finding.get("normalized_feedback_sha256") != normalized_sha256
        or finding.get("evidence") != expected_evidence
        or finding.get("source_feedback_receipt") != source.get("path")
        or committed.get("receipt") != receipt_relative
        or committed.get("receipt_sha256") != core.sha256_file(receipt_path)
        or committed.get("manifest") != manifest.get("_manifest_path")
    ):
        raise AppRequestError(
            "APP-FEEDBACK finding 未绑定完整且一致的直接用户反馈事务"
        )
    return {
        "receipt": receipt_relative,
        "receipt_sha256": core.sha256_file(receipt_path),
        "transaction": committed_path.relative_to(project).as_posix(),
        "transaction_sha256": core.sha256_file(committed_path),
        "feedback": feedback_text,
        "finding_code": expected_code,
    }


def _method_observations(core: Any, project: Path) -> list[Dict[str, Any]]:
    clusters: Dict[str, Dict[str, Any]] = {}
    for manifest in core.sealed_manifests(project):
        run_id = manifest.get("run_id")
        work_id = manifest.get("work_id")
        task = manifest.get("task")
        attempt_id = manifest.get("attempt_id")
        sealed_at = manifest.get("sealed_at")
        if not all(
            isinstance(value, str)
            for value in (run_id, work_id, task, attempt_id, sealed_at)
        ):
            continue
        relevant_findings = []
        for finding in manifest.get("findings", []):
            if not isinstance(finding, dict):
                continue
            code = finding.get("code")
            feedback = finding.get("suggested_action")
            if (
                not isinstance(code, str)
                or not code.startswith("APP-FEEDBACK-")
                or not isinstance(feedback, str)
                or not feedback.strip()
            ):
                continue
            authority = _validated_method_feedback_finding(
                core, project, manifest, finding
            )
            if authority is None:
                continue
            relevant_findings.append((finding, authority))
        if not relevant_findings:
            continue
        epoch = _method_epoch_for_attempt(
            core, project, str(run_id), str(attempt_id)
        )
        for finding, authority in relevant_findings:
            code = str(finding["code"])
            feedback = str(finding["suggested_action"])
            epoch_sha256 = epoch["sha256"] if isinstance(epoch, dict) else None
            epoch_value = epoch["value"] if isinstance(epoch, dict) else None
            epoch_label = epoch_sha256 or "unverified"
            cluster_key = f"{code}:{epoch_label}"
            cluster = clusters.setdefault(
                cluster_key,
                {
                    "id": f"{code.lower()}-epoch-{epoch_label[:12]}",
                    "finding_code": code,
                    "feedback": feedback,
                    "epoch": epoch_value,
                    "epoch_sha256": epoch_sha256,
                    "run_ids": set(),
                    "work_ids": set(),
                    "tasks": set(),
                    "evidence": [],
                },
            )
            cluster["run_ids"].add(run_id)
            cluster["work_ids"].add(work_id)
            cluster["tasks"].add(task)
            cluster["evidence"].append(
                {
                    "run_id": run_id,
                    "work_id": work_id,
                    "attempt_id": attempt_id,
                    "sealed_at": sealed_at,
                    "manifest": manifest.get("_manifest_path"),
                    "manifest_sha256": core.sha256_file(
                        core.regular_project_file(
                            project,
                            manifest.get("_manifest_path"),
                            "method source manifest",
                        )
                    ),
                    "epoch_sha256": epoch_sha256,
                    "feedback_receipt": authority["receipt"],
                    "feedback_receipt_sha256": authority["receipt_sha256"],
                    "feedback_transaction": authority["transaction"],
                    "feedback_transaction_sha256": authority[
                        "transaction_sha256"
                    ],
                }
            )
    result: list[Dict[str, Any]] = []
    for cluster in clusters.values():
        works = sorted(cluster.pop("work_ids"))
        runs = sorted(cluster.pop("run_ids"))
        tasks = sorted(cluster.pop("tasks"))
        result.append(
            {
                **cluster,
                "run_ids": runs,
                "work_ids": works,
                "independent_works": len(works),
                "independent_runs": len(runs),
                "independent_tasks": len(tasks),
                "ready_for_candidate": _method_epoch_uses_current_policy(
                    cluster.get("epoch")
                )
                and isinstance(cluster.get("epoch_sha256"), str)
                and len(works) >= 3
                and len(runs) >= 3
                and len(tasks) >= 3,
            }
        )
    return sorted(result, key=lambda item: str(item["id"]))


def _validated_method_promotion_receipt(
    core: Any,
    project: Path,
    candidate_id: str,
    proposal: Mapping[str, Any],
) -> Optional[tuple[Path, Dict[str, Any]]]:
    promotion_path = (
        project
        / "creative-system"
        / "app-methods"
        / "promotions"
        / f"{candidate_id}.json"
    )
    if not os.path.lexists(str(promotion_path)):
        return None
    promotion_file = core.regular_project_file(
        project,
        promotion_path.relative_to(project).as_posix(),
        "AppMethodPromotionReceipt",
    )
    promotion = core.load_json(promotion_file)
    root = _candidate_root(project, candidate_id)
    decision_hashes: Dict[str, str] = {}
    for phase in METHOD_PHASES:
        decision = _validated_method_decision(
            core, project, root, candidate_id, phase
        )
        if decision is None:
            raise AppRequestError("PromotionReceipt 缺少 exact-three 盲比决定")
        decision_hashes[phase] = core.sha256_file(
            core.regular_project_file(
                project,
                (root / "comparisons" / phase / "decision.json")
                .relative_to(project)
                .as_posix(),
                f"{phase} decision",
            )
        )
    if (
        not isinstance(promotion, dict)
        or promotion.get("kind") != "AppMethodPromotionReceipt"
        or promotion.get("id") != f"promotion-{candidate_id}"
        or promotion.get("candidate_id") != candidate_id
        or promotion.get("previous_version")
        != proposal.get("previous_method_version")
        or promotion.get("new_version") != candidate_id
        or promotion.get("guidance") != proposal.get("guidance")
        or promotion.get("guidance_sha256")
        != proposal.get("guidance_sha256")
        or promotion.get("decision_sha256") != decision_hashes
        or promotion.get("approved_by") != "local-app-user"
        or promotion.get("approval_action") != "adopt-new-method"
        or promotion.get("content_hash") != core.app_record_content_hash(promotion)
    ):
        raise AppRequestError("方法候选 PromotionReceipt 合同或摘要无效")
    return promotion_file, promotion


def _validated_method_rejection_receipt(
    core: Any,
    project: Path,
    candidate_id: str,
) -> Optional[tuple[Path, Dict[str, Any]]]:
    path = _candidate_root(project, candidate_id) / "rejection.json"
    if not os.path.lexists(str(path)):
        return None
    verified = core.regular_project_file(
        project,
        path.relative_to(project).as_posix(),
        "AppMethodRejectionReceipt",
    )
    receipt = core.load_json(verified)
    if (
        not isinstance(receipt, dict)
        or receipt.get("kind") != "AppMethodRejectionReceipt"
        or receipt.get("id") != f"rejection-{candidate_id}"
        or receipt.get("candidate_id") != candidate_id
        or receipt.get("rejected_by") != "local-app-user"
        or receipt.get("active_method_unchanged") is not True
        or receipt.get("content_hash") != core.app_record_content_hash(receipt)
    ):
        raise AppRequestError("方法候选 RejectionReceipt 合同或摘要无效")
    return verified, receipt


def _method_candidate_activation_projection(
    core: Any,
    project: Path,
    candidate_id: str,
    proposal: Mapping[str, Any],
    status: Mapping[str, Any],
    registry: Mapping[str, Any],
) -> Dict[str, bool]:
    validated_rejection = _validated_method_rejection_receipt(
        core, project, candidate_id
    )
    validated_promotion = _validated_method_promotion_receipt(
        core, project, candidate_id, proposal
    )
    if validated_rejection is not None and validated_promotion is not None:
        raise AppRequestError("方法候选同时存在采用与拒绝凭证")
    if validated_promotion is None:
        if status.get("lifecycle") == "PROMOTED":
            raise AppRequestError("PROMOTED 方法候选缺少 PromotionReceipt")
        return {"adoption_pending": False, "rolled_back": False}
    promotion_path, promotion = validated_promotion
    if status.get("lifecycle") == "REJECTED":
        raise AppRequestError("方法候选同时存在采用与拒绝凭证")
    promotion_relative = promotion_path.relative_to(project).as_posix()
    if status.get("lifecycle") == "PROMOTED" and status.get(
        "promotion_receipt"
    ) != promotion_relative:
        raise AppRequestError("PROMOTED 方法候选未绑定 canonical PromotionReceipt")
    previous_version = proposal.get("previous_method_version")

    history = registry.get("history")
    if not isinstance(history, list):
        raise AppRequestError("应用方法历史无效")
    activations: list[int] = []
    promotion_activations: list[int] = []
    for index, item in enumerate(history):
        if not isinstance(item, dict):
            raise AppRequestError("应用方法历史条目无效")
        action = item.get("action")
        if action not in {"PROMOTE", "ROLLBACK"}:
            raise AppRequestError("应用方法历史动作无效")
        if item.get("version") == candidate_id:
            activations.append(index)
            if action == "PROMOTE":
                promotion_activations.append(index)
    if activations and not promotion_activations:
        raise AppRequestError("方法历史含无 PromotionReceipt 根基的恢复动作")
    active_version = registry.get("active_method_version")
    if active_version == candidate_id:
        if not promotion_activations:
            raise AppRequestError("active method 缺少对应历史动作")
        if status.get("lifecycle") != "PROMOTED":
            raise AppRequestError("active method 的候选状态尚未完成投影")
        return {"adoption_pending": False, "rolled_back": False}
    if not promotion_activations:
        if active_version != previous_version:
            raise AppRequestError("待完成采用的稳定版本指针已漂移")
        return {"adoption_pending": True, "rolled_back": False}
    last_activation = max(activations)
    departed = any(
        isinstance(item, dict)
        and index > last_activation
        and item.get("previous_version") == candidate_id
        and item.get("version") != candidate_id
        for index, item in enumerate(history)
    )
    if not departed:
        raise AppRequestError("PROMOTED 候选与 active method 历史不一致")
    return {"adoption_pending": False, "rolled_back": True}


def _method_builder_preparation_public_snapshots(
    core: Any, project: Path
) -> list[Dict[str, Any]]:
    intents_root = (
        project
        / "creative-system"
        / "app-methods"
        / "builder-preparations"
    )
    if not os.path.lexists(str(intents_root)):
        return []
    if intents_root.is_symlink() or not intents_root.is_dir():
        raise AppRequestError("Candidate Builder 准备根目录无效")
    snapshots: list[Dict[str, Any]] = []
    for item in sorted(intents_root.iterdir(), key=lambda path: path.name):
        if item.name == ".gitkeep":
            continue
        if item.is_symlink() or not item.is_file() or item.suffix != ".json":
            raise AppRequestError("Candidate Builder 准备目录含未声明条目")
        candidate_id = _id(item.stem, "builder preparation candidate_id")
        validated = _validated_method_builder_intent(
            core, project, candidate_id, required=True
        )
        if validated is None:
            raise AppRequestError("Candidate Builder 准备 intent 缺失")
        _, intent = validated
        failure = _validated_method_builder_failure(
            core, project, candidate_id, intent
        )
        rejection = _validated_method_builder_rejection(
            core, project, candidate_id, intent
        )
        if os.path.lexists(str(_candidate_root(project, candidate_id))):
            continue
        rejected = rejection is not None
        blocked_reason = None if rejected else (
            "Candidate Builder 的模型基线无法验真；"
            "未保存指导正文，为避免重复付费，本次准备只能放弃"
            if failure is not None
            else
            "Candidate Builder 可能正在调用或已在封存前中断；"
            "本记录不会触发重复付费，重启后只能放弃"
        )
        snapshots.append(
            {
                "id": candidate_id,
                "observation_id": intent.get("observation_id"),
                "title": "未完成的新方式准备",
                "summary": "此次准备未封存可用的创作指导。",
                "tradeoff": "未改变当前方法，也未保存模型生成正文。",
                "status": "REJECTED" if rejected else "CANDIDATE",
                "ready": False,
                "adoption_pending": False,
                "rolled_back": False,
                "preparation_completed": 0,
                "preparation_total": len(METHOD_GENERATION_LABELS),
                "preparation_resumable": False,
                "preparation_blocked_reason": blocked_reason,
                "comparisons": [],
                "evaluation_summary": None,
            }
        )
    return snapshots


def _method_public_snapshot(core: Any, project: Path) -> Dict[str, Any]:
    registry = _method_registry(core, project)
    active = _production_context_snapshot(core, project)
    candidates: list[Dict[str, Any]] = []
    root = project / "creative-system" / "app-methods" / "candidates"
    if root.is_dir() and not root.is_symlink():
        for candidate_dir in sorted(root.iterdir(), key=lambda path: path.name):
            if candidate_dir.name.startswith("."):
                continue
            if not candidate_dir.is_dir() or candidate_dir.is_symlink():
                continue
            _, proposal, status = _load_method_candidate(
                core, project, candidate_dir.name
            )
            rejection = _validated_method_rejection_receipt(
                core, project, candidate_dir.name
            )
            if status.get("lifecycle") == "REJECTED" and rejection is None:
                raise AppRequestError("REJECTED 方法候选缺少 RejectionReceipt")
            projected_lifecycle, projected_summary = _method_evaluation_projection(
                core,
                project,
                candidate_dir,
                candidate_dir.name,
                status,
            )
            activation = _method_candidate_activation_projection(
                core,
                project,
                candidate_dir.name,
                proposal,
                status,
                registry,
            )
            if activation["adoption_pending"]:
                projected_lifecycle = "PROMOTED"
            elif rejection is not None:
                projected_lifecycle = "REJECTED"
            preparation_valid = True
            if status.get("lifecycle") == "CANDIDATE" and rejection is None:
                preparation_completed = 0
                try:
                    preparation_plan = _candidate_evaluation_plan(
                        core, project, proposal
                    )
                    preparation_completed = len(
                        _method_generation_progress(
                            core,
                            project,
                            candidate_dir,
                            proposal,
                            preparation_plan,
                        )
                    )
                    _reconcile_method_generation_pending(
                        core,
                        project,
                        candidate_dir,
                        proposal,
                        preparation_plan,
                    )
                    preparation_completed = len(
                        _method_generation_progress(
                            core,
                            project,
                            candidate_dir,
                            proposal,
                            preparation_plan,
                        )
                    )
                    preparation_failure = _validated_method_generation_failure(
                        core,
                        project,
                        candidate_dir,
                        proposal,
                        preparation_plan,
                    )
                    unresolved_generation = _unresolved_method_generation_intent(
                        core,
                        project,
                        candidate_dir,
                        proposal,
                        preparation_plan,
                    )
                    if (
                        preparation_failure is None
                        and unresolved_generation is None
                        and (
                        os.path.lexists(
                            str(_method_comparisons_pending_root(candidate_dir))
                        )
                        or os.path.lexists(str(candidate_dir / "comparisons"))
                        )
                    ):
                        _finalize_method_comparisons_locked(
                            core,
                            project,
                            candidate_dir.name,
                            include_snapshot=False,
                        )
                        _, proposal, status = _load_method_candidate(
                            core, project, candidate_dir.name
                        )
                        projected_lifecycle, projected_summary = (
                            _method_evaluation_projection(
                                core,
                                project,
                                candidate_dir,
                                candidate_dir.name,
                                status,
                            )
                        )
                    preparation_resumable = (
                        preparation_failure is None
                        and unresolved_generation is None
                        and status.get("lifecycle") == "CANDIDATE"
                    )
                    preparation_blocked_reason = (
                        None
                        if preparation_failure is None
                        and unresolved_generation is None
                        else (
                            "模型、fingerprint、Profile 或固定参数已变化；"
                            "为避免重复付费，本次准备只能放弃"
                            if preparation_failure is not None
                            else
                            f"{unresolved_generation} 可能正在调用或已在付费后中断；"
                            "为避免重复付费，重启后只能放弃"
                        )
                    )
                except AppRequestError as exc:
                    # A frozen candidate may become non-resumable after a method
                    # epoch change or durable-receipt damage.  Keep it visible so
                    # the renderer can offer the immutable rejection path instead
                    # of making the entire system snapshot unavailable.
                    preparation_valid = False
                    preparation_resumable = False
                    preparation_blocked_reason = str(exc)
            else:
                preparation_completed = (
                    len(METHOD_GENERATION_LABELS)
                    if (candidate_dir / "comparisons").is_dir()
                    and not (candidate_dir / "comparisons").is_symlink()
                    else 0
                )
                preparation_resumable = False
                preparation_blocked_reason = None
            comparisons = []
            comparison_phases = (
                METHOD_PHASES
                if status.get("lifecycle") != "CANDIDATE" or preparation_valid
                else ()
            )
            for phase in comparison_phases:
                input_path = candidate_dir / "comparisons" / phase / "public.json"
                if input_path.is_file() and not input_path.is_symlink():
                    _, _, public, _ = _validated_method_comparison(
                        core, project, candidate_dir, candidate_dir.name, phase
                    )
                    decision = _validated_method_decision(
                        core, project, candidate_dir, candidate_dir.name, phase
                    )
                    comparisons.append(
                        {
                            "phase": phase,
                            "left": public.get("left"),
                            "right": public.get("right"),
                            "choice": (
                                decision.get("choice")
                                if isinstance(decision, dict)
                                else None
                            ),
                        }
                    )
            candidates.append(
                {
                    "id": candidate_dir.name,
                    "observation_id": proposal.get("observation_id"),
                    "title": "针对重复反馈的新方式",
                    "summary": proposal.get("guidance"),
                    "tradeoff": "只改变后续作品的创作指导，不改写既有作品。",
                    "status": projected_lifecycle,
                    "ready": projected_lifecycle == "READY_FOR_HUMAN",
                    "adoption_pending": activation["adoption_pending"],
                    "rolled_back": activation["rolled_back"],
                    "preparation_completed": preparation_completed,
                    "preparation_total": len(METHOD_GENERATION_LABELS),
                    "preparation_resumable": preparation_resumable,
                    "preparation_blocked_reason": preparation_blocked_reason,
                    "comparisons": comparisons,
                    "evaluation_summary": projected_summary,
                }
            )
    candidates.extend(_method_builder_preparation_public_snapshots(core, project))
    principles = [
        {
            "version": item.get("version"),
            "guidance": item.get("guidance"),
            "adopted_at": item.get("created_at"),
            "active": item.get("version") == registry.get("active_method_version"),
        }
        for item in registry.get("history", [])
        if isinstance(item, dict) and item.get("action") == "PROMOTE"
    ]
    return {
        "observations": _method_observations(core, project),
        "adopted_principles": principles,
        "candidates": candidates,
        "active_version": active["method_version"],
        "active_guidance": active["guidance"],
        "history": list(registry.get("history", [])),
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
    method = _method_public_snapshot(core, project)
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
        "adopted_principles_available": bool(method["adopted_principles"]),
        "learning": {
            "observations": method["observations"],
            "adopted_principles": method["adopted_principles"],
        },
        "method": {
            "active_version": method["active_version"],
            "active_guidance": method["active_guidance"],
            "history": method["history"],
        },
        "method_candidates": method["candidates"],
        "last_work": last_work,
        "recovery_required": interrupted_work is not None,
        "interrupted_run": interrupted_work,
        "feedback_recovery_required": pending_feedback is not None,
        "pending_feedback": pending_feedback,
    }


def _system_snapshot_request(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"project"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    with core.exclusive_controller_lock(project):
        _reconcile_terminated_attempts_locked(core, project)
        _reconcile_method_rollbacks_locked(core, project)
        try:
            _reconcile_method_candidate_pending(core, project)
        except AppRequestError:
            # An incomplete paid-result candidate tree is never deleted or
            # guessed.  Its pre-call Builder intent remains public and
            # rejectable, while method_candidate_context still fails closed.
            pass
        _reconcile_method_rejections_locked(core, project)
        _reconcile_method_preparations_locked(core, project)
        return _system_snapshot({"project": str(project)})


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
        _reconcile_terminated_attempts_locked(core, project)
        _assert_run_not_terminated_locked(core, project, run_id)
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
    with core.exclusive_controller_lock(project):
        _reconcile_terminated_attempts_locked(core, project)
        _assert_run_not_terminated_locked(core, project, run_id)
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

    feedback_receipt = _load_app_feedback_receipt(
        core, project, recorded["receipt"]
    )
    finding_path = _feedback_finding(core, project, feedback_receipt)
    sealed = _seal_feedback(
        {
            "project": str(project),
            "feedback_receipt": recorded["receipt"],
            "machine_direction": semantic.get("machine_direction"),
            **({"finding_paths": [finding_path]} if finding_path is not None else {}),
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

    with core.exclusive_controller_lock(project):
        _reconcile_terminated_attempts_locked(core, project)
        _assert_run_not_terminated_locked(core, project, run_id)

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
    with core.exclusive_controller_lock(project):
        _reconcile_terminated_attempts_locked(core, project)
        _assert_run_not_terminated_locked(core, project, run_id)
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


def _work_for_method_evaluation(
    core: Any, project: Path, evidence: Mapping[str, Any]
) -> Dict[str, Any]:
    run_id = _id(evidence.get("run_id"), "evidence.run_id")
    attempt_id = _id(evidence.get("attempt_id"), "evidence.attempt_id")
    run_dir = project / "creative-system" / "runs" / run_id
    run_path = core.regular_project_file(
        project, (run_dir / "run.json").relative_to(project).as_posix(), "run"
    )
    run = core.load_json(run_path)
    attempt_dir = run_dir / "attempts" / attempt_id
    if not isinstance(run, dict) or not (attempt_dir / ".sealed.json").is_file():
        raise AppRequestError("方法候选来源 run 尚未封存")
    snapshot = _attempt_snapshot(core, project, run, run_dir, attempt_dir)
    if snapshot is None or snapshot.get("sealed") is not True:
        raise AppRequestError("方法候选来源作品不可用")
    task_path = core.regular_project_file(
        project,
        f"creative-system/approvals/work-tasks/{run_id}.json",
        "WorkTaskReceipt",
    )
    task_receipt = core.load_json(task_path)
    manifest_relative = (attempt_dir / "manifest.json").relative_to(project).as_posix()
    manifest_path = core.regular_project_file(
        project, manifest_relative, "method source manifest"
    )
    provenance_path = core.regular_project_file(
        project,
        (attempt_dir / "runtime-provenance.json").relative_to(project).as_posix(),
        "RuntimeProvenance",
    )
    provenance = core.load_json(provenance_path)
    if (
        not isinstance(task_receipt, dict)
        or task_receipt.get("schema_version") != core.APP_SCHEMA_VERSION
        or task_receipt.get("kind") != "WorkTaskReceipt"
        or task_receipt.get("id") != f"task-{run_id}"
        or task_receipt.get("run_id") != run_id
        or task_receipt.get("work_id") != snapshot.get("work_id")
        or not isinstance(task_receipt.get("task"), str)
        or task_receipt.get("task_sha256")
        != core.sha256_bytes(task_receipt["task"].encode("utf-8"))
        or task_receipt.get("task_bytes")
        != len(task_receipt["task"].encode("utf-8"))
        or task_receipt.get("task_reference") != run.get("task")
        or task_receipt.get("authority") != "direct-user-input"
        or task_receipt.get("public_log_disclosure") != "reference-only"
        or task_receipt.get("content_hash")
        != core.app_record_content_hash(task_receipt)
        or not isinstance(provenance, dict)
        or provenance.get("kind") != "RuntimeProvenance"
        or provenance.get("content_hash") != core.app_record_content_hash(provenance)
    ):
        raise AppRequestError("方法候选来源任务或模型来源无效")
    transaction = _feedback_transaction_for_run(core, project, run_id)
    if transaction is None:
        raise AppRequestError("方法候选来源缺少直接用户反馈事务")
    intent, transaction_dir = transaction
    recorded_path = transaction_dir / "recorded.json"
    committed_path = transaction_dir / "committed.json"
    if (
        intent.get("attempt_id") != attempt_id
        or not os.path.lexists(str(recorded_path))
        or not os.path.lexists(str(committed_path))
    ):
        raise AppRequestError("方法候选来源反馈事务尚未完整提交")
    recorded = _validate_feedback_recorded_marker(
        core, project, recorded_path, intent
    )
    committed = _validate_feedback_committed_marker(
        core, project, committed_path, intent, recorded
    )
    feedback_receipt_relative = recorded.get("receipt")
    feedback_receipt_path = core.regular_project_file(
        project, feedback_receipt_relative, "method source feedback receipt"
    )
    feedback_receipt = _load_app_feedback_receipt(
        core, project, feedback_receipt_relative
    )
    if (
        feedback_receipt.get("run_id") != run_id
        or feedback_receipt.get("attempt_id") != attempt_id
        or feedback_receipt.get("work_id") != snapshot.get("work_id")
        or committed.get("manifest") != manifest_relative
        or evidence.get("manifest") != manifest_relative
        or evidence.get("manifest_sha256") != core.sha256_file(manifest_path)
        or evidence.get("feedback_receipt") != feedback_receipt_relative
        or evidence.get("feedback_receipt_sha256")
        != core.sha256_file(feedback_receipt_path)
        or evidence.get("feedback_transaction")
        != committed_path.relative_to(project).as_posix()
        or evidence.get("feedback_transaction_sha256")
        != core.sha256_file(committed_path)
    ):
        raise AppRequestError("方法候选来源反馈、任务或封存证据已漂移")
    epoch = _method_epoch_value(core, run, provenance)
    return {
        "run_id": run_id,
        "work_id": snapshot["work_id"],
        "attempt_id": attempt_id,
        "task": task_receipt["task"],
        "task_sha256": task_receipt["task_sha256"],
        "task_receipt": task_path.relative_to(project).as_posix(),
        "task_receipt_sha256": core.sha256_file(task_path),
        "output": snapshot["output"],
        "artifact_sha256": snapshot["artifact_sha256"],
        "manifest": manifest_relative,
        "manifest_sha256": core.sha256_file(manifest_path),
        "feedback_receipt": feedback_receipt_relative,
        "feedback_receipt_sha256": core.sha256_file(feedback_receipt_path),
        "feedback_transaction": committed_path.relative_to(project).as_posix(),
        "feedback_transaction_sha256": core.sha256_file(committed_path),
        "provenance": provenance,
        "provenance_path": provenance_path.relative_to(project).as_posix(),
        "provenance_sha256": core.sha256_file(provenance_path),
        "method_epoch": epoch["value"],
        "method_epoch_sha256": epoch["sha256"],
    }


def _method_source_work_reference(item: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "run_id": item["run_id"],
        "work_id": item["work_id"],
        "attempt_id": item["attempt_id"],
        "task_sha256": item["task_sha256"],
        "task_receipt": item["task_receipt"],
        "task_receipt_sha256": item["task_receipt_sha256"],
        "artifact_sha256": item["artifact_sha256"],
        "manifest": item["manifest"],
        "manifest_sha256": item["manifest_sha256"],
        "feedback_receipt": item["feedback_receipt"],
        "feedback_receipt_sha256": item["feedback_receipt_sha256"],
        "feedback_transaction": item["feedback_transaction"],
        "feedback_transaction_sha256": item["feedback_transaction_sha256"],
        "provenance_sha256": item["provenance_sha256"],
        "method_epoch_sha256": item["method_epoch_sha256"],
    }


def _candidate_context_value(
    core: Any,
    project: Path,
    observation_id: str,
    candidate_id: str,
    *,
    frozen_sources: Optional[list[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    observation = next(
        (
            item
            for item in _method_observations(core, project)
            if item.get("id") == observation_id
        ),
        None,
    )
    if not isinstance(observation, dict):
        raise AppRequestError("这条观察尚未达到三个独立作品的候选门槛")
    epoch = observation.get("epoch")
    if isinstance(epoch, Mapping) and not _method_epoch_uses_current_policy(epoch):
        raise AppRequestError(
            "这条观察来自旧版 16384 输出策略，只能保留查看；请用当前固定 32768 策略重新积累三个独立作品"
        )
    if observation.get("ready_for_candidate") is not True:
        raise AppRequestError("这条观察尚未达到三个独立作品的候选门槛")
    evidence = observation.get("evidence")
    if not isinstance(evidence, list) or len(evidence) < 3:
        raise AppRequestError("候选缺少三项独立封存证据")
    if frozen_sources is None:
        selected = sorted(
            evidence,
            key=lambda item: (
                str(item.get("sealed_at")),
                str(item.get("run_id")),
                str(item.get("attempt_id")),
            ),
        )[:3]
    else:
        selected = []
        for source in frozen_sources:
            matches = [
                item
                for item in evidence
                if isinstance(item, dict)
                and item.get("run_id") == source.get("run_id")
                and item.get("work_id") == source.get("work_id")
                and item.get("attempt_id") == source.get("attempt_id")
            ]
            if len(matches) != 1:
                raise AppRequestError("候选冻结的来源作品不在同一观察 epoch 中")
            selected.append(matches[0])
    works = [_work_for_method_evaluation(core, project, item) for item in selected]
    if len({str(item["work_id"]) for item in works}) != 3:
        raise AppRequestError("候选来源必须是三个不同作品")
    current = _production_context_snapshot(core, project)
    epoch_sha256 = observation.get("epoch_sha256")
    if (
        not isinstance(epoch, dict)
        or not isinstance(epoch_sha256, str)
        or epoch_sha256
        != core.sha256_bytes(core.canonical_json_bytes(epoch))
        or {str(item["method_epoch_sha256"]) for item in works}
        != {epoch_sha256}
        or epoch.get("method_version") != current["method_version"]
    ):
        raise AppRequestError("重复反馈不属于当前方法的同一模型基线；请继续建立新基线")
    initial = _initial_intent_snapshot(core, project, core.load_system(project))
    builder_input = {
        "candidate_id": candidate_id,
        "observation_id": observation_id,
        "finding_code": observation["finding_code"],
        "feedback": observation["feedback"],
        "initial_intent_sha256": initial["sha256"],
        "current_method_version": current["method_version"],
        "current_guidance_sha256": current["guidance_sha256"],
        "method_epoch_sha256": epoch_sha256,
        "source_works": [_method_source_work_reference(item) for item in works],
        "heldout_included": False,
    }
    context_sha256 = core.sha256_bytes(core.canonical_json_bytes(builder_input))
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "observation_id": observation_id,
        "finding_code": observation["finding_code"],
        "feedback": observation["feedback"],
        "initial_intent": initial["text"],
        "current_method_version": current["method_version"],
        "current_guidance": current["guidance"],
        "method_epoch": epoch,
        "method_epoch_sha256": epoch_sha256,
        "builder_context_sha256": context_sha256,
        "heldout_included": False,
        "source_works": works,
    }


def _begin_method_candidate_preparation(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "builder_context_sha256",
            "candidate_id",
            "expected_epoch_sha256",
            "observation_id",
            "project",
        },
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    observation_id = _text(
        payload.get("observation_id"), "observation_id", maximum=100
    )
    builder_context_sha256 = _text(
        payload.get("builder_context_sha256"),
        "builder_context_sha256",
        maximum=64,
    )
    expected_epoch_sha256 = _text(
        payload.get("expected_epoch_sha256"),
        "expected_epoch_sha256",
        maximum=64,
    )
    if any(
        re.fullmatch(r"[0-9a-f]{64}", value) is None
        for value in (builder_context_sha256, expected_epoch_sha256)
    ):
        raise AppRequestError("Candidate Builder 准备 SHA256 无效")
    with core.exclusive_controller_lock(project):
        _reconcile_method_candidate_pending(core, project)
        context = _candidate_context_value(
            core, project, observation_id, candidate_id
        )
        if (
            context["builder_context_sha256"] != builder_context_sha256
            or context["method_epoch_sha256"] != expected_epoch_sha256
        ):
            raise AppRequestError("Candidate Builder 准备未绑定当前观察与模型基线")
        existing_candidate = _resumable_method_candidate(
            core, project, observation_id
        )
        if existing_candidate is not None:
            raise AppRequestError("同一观察已有未完成方法候选")
        active_preparation = _active_method_builder_preparation(
            core, project, observation_id
        )
        if (
            active_preparation is not None
            and active_preparation[0] != candidate_id
        ):
            raise AppRequestError(
                "同一观察已有未完成 Candidate Builder 准备；请先放弃"
            )
        existing = _validated_method_builder_intent(
            core, project, candidate_id
        )
        idempotent = existing is not None
        if existing is not None:
            _, intent = existing
            if (
                intent.get("observation_id") != observation_id
                or intent.get("builder_context_sha256")
                != builder_context_sha256
                or intent.get("expected_epoch_sha256")
                != expected_epoch_sha256
            ):
                raise AppRequestError(
                    "同一 candidate_id 已绑定不同 Builder 准备 intent"
                )
            if _validated_method_builder_rejection(
                core, project, candidate_id, intent
            ) is not None:
                raise AppRequestError("这次 Candidate Builder 准备已被用户放弃")
        else:
            intent = _record(
                core,
                "AppMethodBuilderIntent",
                f"builder-intent-{candidate_id}",
                {
                    "candidate_id": candidate_id,
                    "observation_id": observation_id,
                    "builder_context_sha256": builder_context_sha256,
                    "expected_epoch_sha256": expected_epoch_sha256,
                    "guidance_persisted": False,
                    "output_persisted": False,
                    "reasoning_persisted": False,
                    "runtime_provenance_persisted": False,
                },
            )
            intent_path = _method_builder_intent_path(project, candidate_id)
            core.guarded_mkdir_project(
                project, intent_path.parent, "method builder preparation intents"
            )
            core.atomic_create_json(intent_path, intent)
            validated = _validated_method_builder_intent(
                core, project, candidate_id, required=True
            )
            if validated is None:
                raise AppRequestError("Candidate Builder 准备 intent 未成功封存")
            _, intent = validated
        intent_path = _method_builder_intent_path(project, candidate_id)
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "observation_id": observation_id,
        "builder_context_sha256": builder_context_sha256,
        "expected_epoch_sha256": expected_epoch_sha256,
        "intent_sha256": core.sha256_file(intent_path),
        "idempotent": idempotent,
    }


def _record_method_builder_failure(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "builder_context_sha256",
            "candidate_id",
            "error_code",
            "expected_epoch_sha256",
            "observed_evidence_sha256",
            "observation_id",
            "project",
        },
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    observation_id = _text(
        payload.get("observation_id"), "observation_id", maximum=100
    )
    builder_context_sha256 = _text(
        payload.get("builder_context_sha256"),
        "builder_context_sha256",
        maximum=64,
    )
    expected_epoch_sha256 = _text(
        payload.get("expected_epoch_sha256"),
        "expected_epoch_sha256",
        maximum=64,
    )
    observed_evidence_sha256 = _text(
        payload.get("observed_evidence_sha256"),
        "observed_evidence_sha256",
        maximum=64,
    )
    error_code = _text(payload.get("error_code"), "error_code", maximum=80)
    if error_code != "METHOD_EPOCH_UNVERIFIABLE" or any(
        re.fullmatch(r"[0-9a-f]{64}", value) is None
        for value in (
            builder_context_sha256,
            expected_epoch_sha256,
            observed_evidence_sha256,
        )
    ):
        raise AppRequestError("Candidate Builder failure 合同无效")
    with core.exclusive_controller_lock(project):
        validated = _validated_method_builder_intent(
            core, project, candidate_id, required=True
        )
        if validated is None:
            raise AppRequestError("Candidate Builder 准备 intent 缺失")
        _, intent = validated
        if (
            intent.get("observation_id") != observation_id
            or intent.get("builder_context_sha256")
            != builder_context_sha256
            or intent.get("expected_epoch_sha256")
            != expected_epoch_sha256
        ):
            raise AppRequestError("Candidate Builder failure 未绑定不可变 intent")
        if os.path.lexists(str(_candidate_root(project, candidate_id))):
            raise AppRequestError("方法候选已完整封存，不能追加 Builder failure")
        if _validated_method_builder_rejection(
            core, project, candidate_id, intent
        ) is not None:
            raise AppRequestError("已放弃的 Builder 准备不能追加 failure")
        idempotent, failure_path, failure = (
            _write_method_builder_failure_marker_locked(
                core,
                project,
                candidate_id,
                intent,
                error_code=error_code,
                observed_evidence_sha256=observed_evidence_sha256,
            )
        )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "observation_id": observation_id,
        "error_code": error_code,
        "failure_marker_sha256": core.sha256_file(failure_path),
        "idempotent": idempotent,
    }


def _method_candidate_context(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"candidate_id", "observation_id", "project"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    with core.exclusive_controller_lock(project):
        _reconcile_method_candidate_pending(core, project)
        return _method_candidate_context_locked(core, project, payload)


def _method_candidate_context_locked(
    core: Any, project: Path, payload: Mapping[str, Any]
) -> Dict[str, Any]:
    observation_id = _text(
        payload.get("observation_id"), "observation_id", maximum=100
    )
    proposed_candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    resumable = _resumable_method_candidate(
        core, project, observation_id
    )
    if resumable is not None:
        return _method_candidate_preparation_context_value(
            core, project, resumable
        )
    active_builder = _active_method_builder_preparation(
        core, project, observation_id
    )
    if active_builder is not None:
        raise AppRequestError(
            "Candidate Builder 可能已经调用，但结果未完整封存；"
            "为避免重复付费，请在新方式中放弃本次准备"
        )
    context = _candidate_context_value(
        core,
        project,
        observation_id,
        proposed_candidate_id,
    )
    return {
        **context,
        "builder_required": True,
        "guidance": None,
        "evaluation_plan": None,
        "completed_generation_labels": [],
        "generation_total": len(METHOD_GENERATION_LABELS),
    }


def _method_generation_context_sha256(
    core: Any,
    *,
    candidate_id: str,
    phase: str,
    role: str,
    task: str,
    guidance_sha256: Optional[str],
) -> str:
    return core.sha256_bytes(
        core.canonical_json_bytes(
            {
                "candidate_id": candidate_id,
                "phase": phase,
                "role": role,
                "task_sha256": core.sha256_bytes(task.encode("utf-8")),
                "guidance_sha256": guidance_sha256,
            }
        )
    )


def _validated_method_candidate_builder(
    core: Any,
    project: Path,
    proposal: Mapping[str, Any],
    *,
    expected_context_sha256: str,
) -> Dict[str, Any]:
    candidate_id = _id(proposal.get("id"), "method candidate id")
    root = _candidate_root(project, candidate_id)
    builder_path = core.regular_project_file(
        project,
        (root / "builder-provenance.json").relative_to(project).as_posix(),
        "method candidate builder provenance",
    )
    provenance = core.load_json(builder_path)
    builder = proposal.get("builder")
    expected_builder_keys = {
        "attested_by",
        "context_id",
        "heldout_included",
        "input_context_sha256",
        "role_id",
        "task_id",
    }
    source_epoch = proposal.get("source_epoch")
    source_epoch_sha256 = proposal.get("source_epoch_sha256")
    validated_intent = _validated_method_builder_intent(
        core, project, candidate_id, required=True
    )
    if validated_intent is None:
        raise AppRequestError("方法候选缺少 Builder intent")
    _, builder_intent = validated_intent
    if (
        not isinstance(builder, dict)
        or set(builder) != expected_builder_keys
        or _id(builder.get("role_id"), "builder.role_id")
        != "method-candidate-builder"
        or not isinstance(builder.get("context_id"), str)
        or not isinstance(builder.get("task_id"), str)
        or builder.get("attested_by") != "local-main-supervisor"
        or builder.get("heldout_included") is not False
        or builder.get("input_context_sha256") != expected_context_sha256
        or proposal.get("builder_provenance") != "builder-provenance.json"
        or not isinstance(provenance, dict)
        or provenance.get("kind") != "RuntimeProvenance"
        or provenance.get("run_id") != f"builder-{candidate_id}"
        or provenance.get("context_sha256") != expected_context_sha256
        or provenance.get("authority") != "main-observed-model-gateway"
        or provenance.get("reasoning_content_persisted") is not False
        or provenance.get("content_hash")
        != core.app_record_content_hash(provenance)
        or not isinstance(source_epoch, dict)
        or not isinstance(source_epoch_sha256, str)
        or source_epoch_sha256
        != core.sha256_bytes(core.canonical_json_bytes(source_epoch))
        or builder_intent.get("observation_id")
        != proposal.get("observation_id")
        or builder_intent.get("builder_context_sha256")
        != expected_context_sha256
        or builder_intent.get("expected_epoch_sha256")
        != source_epoch_sha256
    ):
        raise AppRequestError("Candidate Builder provenance 与 proposal 绑定无效")
    if (
        _validated_method_builder_failure(
            core, project, candidate_id, builder_intent
        )
        is not None
        or _validated_method_builder_rejection(
            core, project, candidate_id, builder_intent
        )
        is not None
    ):
        raise AppRequestError("完整候选不能同时绑定 Builder failure 或 rejection")
    observed_epoch = _method_epoch_value(
        core,
        {"app_method_version_at_start": source_epoch.get("method_version")},
        provenance,
    )
    if observed_epoch["sha256"] != source_epoch_sha256:
        raise AppRequestError(
            "Candidate Builder provenance 与候选冻结的模型基线不一致"
        )
    return provenance


def _candidate_evaluation_plan(
    core: Any, project: Path, proposal: Mapping[str, Any]
) -> Dict[str, Any]:
    sources = proposal.get("source_works")
    if not isinstance(sources, list) or len(sources) != 3:
        raise AppRequestError("方法候选来源作品合同无效")
    context = _candidate_context_value(
        core,
        project,
        str(proposal.get("observation_id")),
        str(proposal.get("id")),
        frozen_sources=sources,
    )
    works = context["source_works"]
    expected_sources = [_method_source_work_reference(item) for item in works]
    if (
        sources != expected_sources
        or proposal.get("source_epoch") != context["method_epoch"]
        or proposal.get("source_epoch_sha256")
        != context["method_epoch_sha256"]
    ):
        raise AppRequestError("方法候选冻结的三项来源或模型基线已漂移")
    _validated_method_candidate_builder(
        core,
        project,
        proposal,
        expected_context_sha256=context["builder_context_sha256"],
    )
    heldout_task = proposal.get("heldout_task")
    guidance_sha256 = proposal.get("guidance_sha256")
    if not isinstance(heldout_task, str) or not isinstance(guidance_sha256, str):
        raise AppRequestError("方法候选 held-out 或指导摘要无效")
    current_guidance = context["current_guidance"]
    baseline_guidance_sha256 = (
        core.sha256_bytes(current_guidance.encode("utf-8"))
        if isinstance(current_guidance, str)
        else None
    )
    return {
        "targeted": {
            "task": works[2]["task"],
            "baseline_output": works[2]["output"],
            "source_run_id": works[2]["run_id"],
            "candidate_context_sha256": _method_generation_context_sha256(
                core,
                candidate_id=str(proposal["id"]),
                phase="targeted",
                role="candidate",
                task=works[2]["task"],
                guidance_sha256=guidance_sha256,
            ),
        },
        "regression": {
            "task": works[0]["task"],
            "baseline_output": works[0]["output"],
            "source_run_id": works[0]["run_id"],
            "candidate_context_sha256": _method_generation_context_sha256(
                core,
                candidate_id=str(proposal["id"]),
                phase="regression",
                role="candidate",
                task=works[0]["task"],
                guidance_sha256=guidance_sha256,
            ),
        },
        "heldout": {
            "task": heldout_task,
            "baseline_context_sha256": _method_generation_context_sha256(
                core,
                candidate_id=str(proposal["id"]),
                phase="heldout",
                role="baseline",
                task=heldout_task,
                guidance_sha256=baseline_guidance_sha256,
            ),
            "candidate_context_sha256": _method_generation_context_sha256(
                core,
                candidate_id=str(proposal["id"]),
                phase="heldout",
                role="candidate",
                task=heldout_task,
                guidance_sha256=guidance_sha256,
            ),
        },
    }


def _resumable_method_candidate(
    core: Any, project: Path, observation_id: str
) -> Optional[str]:
    candidates_root = project / "creative-system" / "app-methods" / "candidates"
    if not os.path.lexists(str(candidates_root)):
        return None
    if candidates_root.is_symlink() or not candidates_root.is_dir():
        raise AppRequestError("方法候选根目录不是普通目录")
    matches: list[str] = []
    for candidate_dir in sorted(candidates_root.iterdir(), key=lambda item: item.name):
        if candidate_dir.name.startswith("."):
            continue
        if candidate_dir.is_symlink() or not candidate_dir.is_dir():
            raise AppRequestError("方法候选路径不是普通目录")
        _, proposal, status = _load_method_candidate(
            core, project, candidate_dir.name
        )
        if (
            proposal.get("observation_id") == observation_id
            and status.get("lifecycle") == "CANDIDATE"
            and _validated_method_rejection_receipt(
                core, project, candidate_dir.name
            )
            is None
        ):
            matches.append(candidate_dir.name)
    if len(matches) > 1:
        raise AppRequestError(
            "同一观察存在多个未完成方法候选；请先在新方式中处理多余候选"
        )
    return matches[0] if matches else None


def _method_candidate_preparation_context_value(
    core: Any, project: Path, candidate_id: str
) -> Dict[str, Any]:
    root, proposal, status = _load_method_candidate(core, project, candidate_id)
    if _validated_method_rejection_receipt(core, project, candidate_id) is not None:
        raise AppRequestError("这次候选准备已被用户放弃，不能继续调用模型")
    if status.get("lifecycle") != "CANDIDATE":
        raise AppRequestError("当前候选不在可恢复的准备阶段")
    context = _candidate_context_value(
        core,
        project,
        str(proposal.get("observation_id")),
        candidate_id,
        frozen_sources=proposal.get("source_works"),
    )
    plan = _candidate_evaluation_plan(core, project, proposal)
    _reconcile_method_generation_pending(core, project, root, proposal, plan)
    if _method_comparisons_state_exists(root):
        _finalize_method_comparisons_locked(
            core, project, candidate_id, include_snapshot=False
        )
        raise AppRequestError("候选已进入盲比阶段，不能继续调用模型")
    failure = _validated_method_generation_failure(
        core, project, root, proposal, plan
    )
    if failure is not None:
        raise AppRequestError(
            "这次候选准备已因模型基线变化永久停止；"
            "为避免重复付费，请在新方式中放弃本次准备"
        )
    unresolved_intent = _unresolved_method_generation_intent(
        core, project, root, proposal, plan
    )
    if unresolved_intent is not None:
        raise AppRequestError(
            f"{unresolved_intent} 可能正在调用或已在付费后、receipt 封存前中断；"
            "为避免重复付费，请放弃本次准备"
        )
    completed = _method_generation_progress(
        core, project, root, proposal, plan
    )
    return {
        **context,
        "candidate_id": candidate_id,
        "builder_required": False,
        "guidance": proposal.get("guidance"),
        "evaluation_plan": plan,
        "completed_generation_labels": list(completed),
        "generation_total": len(METHOD_GENERATION_LABELS),
    }


def _method_candidate_creation_result(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    status: Mapping[str, Any],
    builder_provenance: Mapping[str, Any],
    *,
    builder_role_id: str,
    builder_context_id: str,
    builder_task_id: str,
    builder_attested_by: str,
    idempotent: bool,
) -> Dict[str, Any]:
    stored_builder_provenance = _validated_method_candidate_builder(
        core,
        project,
        proposal,
        expected_context_sha256=str(builder_provenance.get("context_sha256")),
    )
    builder_path = core.regular_project_file(
        project,
        (root / "builder-provenance.json").relative_to(project).as_posix(),
        "method candidate builder provenance",
    )
    expected_builder = {
        "role_id": builder_role_id,
        "context_id": builder_context_id,
        "task_id": builder_task_id,
        "attested_by": builder_attested_by,
        "input_context_sha256": builder_provenance.get("context_sha256"),
        "heldout_included": False,
    }
    if (
        stored_builder_provenance != builder_provenance
        or proposal.get("builder") != expected_builder
        or proposal.get("builder_provenance") != "builder-provenance.json"
    ):
        raise AppRequestError(
            "同一 candidate_id 已绑定不同 Builder 身份、上下文或 RuntimeProvenance"
        )
    plan = _candidate_evaluation_plan(core, project, proposal)
    _reconcile_method_generation_pending(core, project, root, proposal, plan)
    if _method_comparisons_state_exists(root):
        raise AppRequestError("候选 comparisons 已存在，不能重放 Builder 创建结果")
    completed = _method_generation_progress(
        core, project, root, proposal, plan
    )
    return {
        "status": "PASS",
        "candidate_id": proposal.get("id"),
        "observation_id": proposal.get("observation_id"),
        "lifecycle": status.get("lifecycle"),
        "guidance": proposal.get("guidance"),
        "guidance_sha256": proposal.get("guidance_sha256"),
        "builder_context_sha256": builder_provenance.get("context_sha256"),
        "builder_provenance_sha256": core.sha256_file(builder_path),
        "proposal_sha256": core.sha256_file(root / "proposal.json"),
        "source_epoch_sha256": proposal.get("source_epoch_sha256"),
        "evaluation_plan": plan,
        "completed_generation_labels": list(completed),
        "generation_total": len(METHOD_GENERATION_LABELS),
        "idempotent": idempotent,
    }


def _create_method_candidate(payload: Mapping[str, Any]) -> Dict[str, Any]:
    core = load_controller()
    project = _project_path(payload.get("project"))
    with core.exclusive_controller_lock(project):
        return _create_method_candidate_locked(core, project, payload)


def _create_method_candidate_locked(
    core: Any, project: Path, payload: Mapping[str, Any]
) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "builder_attested_by",
            "builder_context_id",
            "builder_provenance",
            "builder_role_id",
            "builder_task_id",
            "candidate_id",
            "guidance",
            "observation_id",
            "project",
        },
    )
    _reconcile_method_candidate_pending(core, project)
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    observation_id = _text(payload.get("observation_id"), "observation_id", maximum=100)
    existing_candidate_id = _resumable_method_candidate(
        core, project, observation_id
    )
    if (
        existing_candidate_id is not None
        and existing_candidate_id != candidate_id
    ):
        raise AppRequestError(
            "同一观察已有未完成方法候选；请继续准备或先放弃本次准备"
        )
    context = _candidate_context_value(core, project, observation_id, candidate_id)
    builder_intent_value = _validated_method_builder_intent(
        core, project, candidate_id, required=True
    )
    if builder_intent_value is None:
        raise AppRequestError("Candidate Builder 准备 intent 缺失")
    _, builder_intent = builder_intent_value
    if (
        builder_intent.get("observation_id") != observation_id
        or builder_intent.get("builder_context_sha256")
        != context["builder_context_sha256"]
        or builder_intent.get("expected_epoch_sha256")
        != context["method_epoch_sha256"]
    ):
        raise AppRequestError("Candidate Builder 准备 intent 与当前冻结上下文不一致")
    if _validated_method_builder_rejection(
        core, project, candidate_id, builder_intent
    ) is not None:
        raise AppRequestError("已放弃的 Candidate Builder 准备不能建立候选")
    if _validated_method_builder_failure(
        core, project, candidate_id, builder_intent
    ) is not None:
        raise AppRequestError(
            "Candidate Builder 模型基线无法验真；为避免重复付费，只能放弃本次准备"
        )
    guidance = _text(payload.get("guidance"), "guidance", maximum=2000, multiline=True)
    if "```" in guidance or "<script" in guidance.casefold():
        raise AppRequestError("方法候选只能是声明式创作指导，不接受代码块或脚本")
    builder_provenance = _runtime_provenance(
        core,
        payload.get("builder_provenance"),
        f"builder-{candidate_id}",
        expected_context_sha256=context["builder_context_sha256"],
    )
    builder_epoch = _method_epoch_value(
        core,
        {"app_method_version_at_start": context["current_method_version"]},
        builder_provenance,
    )
    if builder_epoch["sha256"] != context["method_epoch_sha256"]:
        if not os.path.lexists(str(_candidate_root(project, candidate_id))):
            _write_method_builder_failure_marker_locked(
                core,
                project,
                candidate_id,
                builder_intent,
                error_code="METHOD_EPOCH_CHANGED",
                observed_evidence_sha256=str(builder_epoch["sha256"]),
            )
        raise AppRequestError("Candidate Builder 与三项来源不属于同一模型基线")
    builder_role_id = _id(payload.get("builder_role_id"), "builder_role_id")
    builder_context_id = _text(
        payload.get("builder_context_id"), "builder_context_id", maximum=300
    )
    builder_task_id = _text(
        payload.get("builder_task_id"), "builder_task_id", maximum=300
    )
    builder_attested_by = _text(
        payload.get("builder_attested_by"), "builder_attested_by", maximum=300
    )
    root = _candidate_root(project, candidate_id)
    if os.path.lexists(str(root)):
        _, proposal, status = _load_method_candidate(core, project, candidate_id)
        if _validated_method_rejection_receipt(
            core, project, candidate_id
        ) is not None:
            raise AppRequestError("已放弃的方法候选不能继续创建")
        if (
            proposal.get("guidance") != guidance
            or proposal.get("observation_id") != observation_id
            or proposal.get("source_epoch_sha256")
            != context["method_epoch_sha256"]
        ):
            raise AppRequestError("同一 candidate_id 已绑定不同观察、基线或指导")
        return _method_candidate_creation_result(
            core,
            project,
            root,
            proposal,
            status,
            builder_provenance,
            builder_role_id=builder_role_id,
            builder_context_id=builder_context_id,
            builder_task_id=builder_task_id,
            builder_attested_by=builder_attested_by,
            idempotent=True,
        )
    current = _production_context_snapshot(core, project)
    heldout_task = (
        f"围绕这个创作方向完成一项全新的代表性作品，人物、情节或表达不得复用前三项："
        f"{context['initial_intent']}"
    )
    proposal = _record(
        core,
        "AppMethodCandidate",
        candidate_id,
        {
            "candidate_class": "APP_METHOD_MINIMUM",
            "formal_l4_authority": False,
            "observation_id": observation_id,
            "finding_code": context["finding_code"],
            "feedback": context["feedback"],
            "source_epoch": context["method_epoch"],
            "source_epoch_sha256": context["method_epoch_sha256"],
            "source_works": [
                _method_source_work_reference(item)
                for item in context["source_works"]
            ],
            "builder": {
                "role_id": builder_role_id,
                "context_id": builder_context_id,
                "task_id": builder_task_id,
                "attested_by": builder_attested_by,
                "input_context_sha256": context["builder_context_sha256"],
                "heldout_included": False,
            },
            "builder_provenance": "builder-provenance.json",
            "guidance": guidance,
            "guidance_sha256": core.sha256_bytes(guidance.encode("utf-8")),
            "previous_method_version": current["method_version"],
            "heldout_task": heldout_task,
            "heldout_created_after_builder": True,
            "evaluation_policy": "exact-three-human-blind",
        },
    )
    status = _record(
        core,
        "AppMethodCandidateStatus",
        f"status-{candidate_id}",
        {
            "candidate_id": candidate_id,
            "proposal_sha256": "PENDING",
            "lifecycle": "CANDIDATE",
            "evaluation_summary": None,
            "promotion_receipt": None,
            "rejection_receipt": None,
        },
    )
    core.guarded_mkdir_project(project, root.parent, "app method candidates root")
    staging = _candidate_pending_root(project, candidate_id)
    if os.path.lexists(str(staging)):
        raise AppRequestError("pending 方法候选已存在，拒绝覆盖")
    staging.mkdir()
    core.atomic_create_json(staging / "proposal.json", proposal)
    core.atomic_create_json(staging / "builder-provenance.json", builder_provenance)
    status["proposal_sha256"] = core.sha256_file(staging / "proposal.json")
    status["content_hash"] = core.app_record_content_hash(status)
    core.atomic_create_json(staging / "status.json", status)
    os.rename(str(staging), str(root))
    loaded_root, loaded_proposal, loaded_status = _load_method_candidate(
        core, project, candidate_id
    )
    return _method_candidate_creation_result(
        core,
        project,
        loaded_root,
        loaded_proposal,
        loaded_status,
        builder_provenance,
        builder_role_id=builder_role_id,
        builder_context_id=builder_context_id,
        builder_task_id=builder_task_id,
        builder_attested_by=builder_attested_by,
        idempotent=False,
    )


def _candidate_status_update(
    core: Any, root: Path, status: Mapping[str, Any], **updates: Any
) -> Dict[str, Any]:
    value = {**dict(status), **updates}
    value["content_hash"] = core.app_record_content_hash(value)
    core.atomic_write_json(root / "status.json", value)
    return value


def _normalize_method_generation(
    core: Any,
    value: Any,
    *,
    candidate_id: str,
    label: str,
    expected_context_sha256: str,
) -> Dict[str, Any]:
    item = _mapping(value, label)
    _exact_keys(item, label, {"output", "runtime_provenance"})
    output = _text(item.get("output"), f"{label}.output", maximum=500000, multiline=True)
    provenance = _runtime_provenance(
        core,
        item.get("runtime_provenance"),
        f"{candidate_id}-{label.replace('_', '-')}",
        expected_context_sha256=expected_context_sha256,
    )
    return {
        "output": output,
        "output_sha256": core.sha256_bytes(output.encode("utf-8")),
        "provenance": provenance,
    }


def _method_generation_expected_context(
    plan: Mapping[str, Any], label: str
) -> str:
    locations = {
        "targeted_candidate": ("targeted", "candidate_context_sha256"),
        "regression_candidate": ("regression", "candidate_context_sha256"),
        "heldout_baseline": ("heldout", "baseline_context_sha256"),
        "heldout_candidate": ("heldout", "candidate_context_sha256"),
    }
    location = locations.get(label)
    if location is None:
        raise AppRequestError("候选准备 generation label 无效")
    phase = _mapping(plan.get(location[0]), f"evaluation_plan.{location[0]}")
    context_sha256 = phase.get(location[1])
    if not isinstance(context_sha256, str) or not re.fullmatch(
        r"[0-9a-f]{64}", context_sha256
    ):
        raise AppRequestError("候选准备 context SHA256 无效")
    return context_sha256


def _method_generation_epoch_hashes(
    core: Any,
    proposal: Mapping[str, Any],
    provenance: Mapping[str, Any],
) -> tuple[str, str]:
    source_epoch = proposal.get("source_epoch")
    source_epoch_sha256 = proposal.get("source_epoch_sha256")
    if (
        not isinstance(source_epoch, Mapping)
        or not isinstance(source_epoch_sha256, str)
        or source_epoch_sha256
        != core.sha256_bytes(core.canonical_json_bytes(source_epoch))
    ):
        raise AppRequestError("候选冻结的模型基线无效")
    observed = _method_epoch_value(
        core,
        {"app_method_version_at_start": source_epoch.get("method_version")},
        provenance,
    )
    return source_epoch_sha256, str(observed["sha256"])


def _assert_method_generation_epoch(
    core: Any,
    proposal: Mapping[str, Any],
    provenance: Mapping[str, Any],
) -> None:
    expected_epoch_sha256, observed_epoch_sha256 = _method_generation_epoch_hashes(
        core, proposal, provenance
    )
    if observed_epoch_sha256 != expected_epoch_sha256:
        raise AppRequestError(
            "候选比较的模型、fingerprint、Profile 或参数已变化；"
            "本项未封存，后续模型调用已阻止"
        )


def _method_generation_slot_root(root: Path, label: str) -> Path:
    return root / "preparation" / "generations" / label


def _method_generation_pending_root(root: Path, label: str) -> Path:
    return root / "preparation" / "generations" / f".pending-{label}"


def _method_generation_intent_path(root: Path, label: str) -> Path:
    return root / "preparation" / "intents" / f"{label}.json"


def _validated_method_generation_intent(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    plan: Mapping[str, Any],
    label: str,
    *,
    required: bool = False,
) -> Optional[tuple[Path, Dict[str, Any]]]:
    path = _method_generation_intent_path(root, label)
    if not os.path.lexists(str(path)):
        if required:
            raise AppRequestError(f"{label} 缺少模型调用前的不可变 intent")
        return None
    verified = core.regular_project_file(
        project,
        path.relative_to(project).as_posix(),
        f"{label} method generation intent",
    )
    intent = core.load_json(verified)
    expected_keys = {
        "candidate_id",
        "content_hash",
        "context_sha256",
        "created_at",
        "expected_epoch_sha256",
        "id",
        "kind",
        "label",
        "output_persisted",
        "reasoning_persisted",
        "runtime_provenance_persisted",
        "schema_version",
        "source_refs",
    }
    if (
        not isinstance(intent, dict)
        or set(intent) != expected_keys
        or intent.get("kind") != "AppMethodGenerationIntent"
        or intent.get("id")
        != f"generation-intent-{proposal.get('id')}-{label.replace('_', '-')}"
        or intent.get("candidate_id") != proposal.get("id")
        or intent.get("label") != label
        or intent.get("context_sha256")
        != _method_generation_expected_context(plan, label)
        or intent.get("expected_epoch_sha256")
        != proposal.get("source_epoch_sha256")
        or intent.get("output_persisted") is not False
        or intent.get("reasoning_persisted") is not False
        or intent.get("runtime_provenance_persisted") is not False
        or intent.get("source_refs") != []
        or intent.get("content_hash") != core.app_record_content_hash(intent)
    ):
        raise AppRequestError(f"{label} generation intent 合同或摘要无效")
    return verified, intent


def _unresolved_method_generation_intent(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> Optional[str]:
    intents_root = root / "preparation" / "intents"
    if not os.path.lexists(str(intents_root)):
        return None
    if intents_root.is_symlink() or not intents_root.is_dir():
        raise AppRequestError("候选 generation intents 根目录无效")
    allowed = {f"{label}.json" for label in METHOD_GENERATION_LABELS}
    observed = {item.name for item in intents_root.iterdir()}
    if not observed.issubset(allowed):
        raise AppRequestError("候选 generation intents 目录含未声明条目")
    for label in METHOD_GENERATION_LABELS:
        intent = _validated_method_generation_intent(
            core, project, root, proposal, plan, label
        )
        if intent is None:
            continue
        slot = _validated_staged_method_generation(
            core, project, root, proposal, plan, label
        )
        if slot is None:
            return label
    return None


def _method_generation_failures_root(root: Path) -> Path:
    return root / "preparation" / "failures"


def _validated_method_generation_failure(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> Optional[Dict[str, Any]]:
    failures_root = _method_generation_failures_root(root)
    if not os.path.lexists(str(failures_root)):
        return None
    if failures_root.is_symlink() or not failures_root.is_dir():
        raise AppRequestError("候选准备 failure marker 根目录无效")
    entries = sorted(failures_root.iterdir(), key=lambda item: item.name)
    if not entries:
        return None
    if len(entries) != 1:
        raise AppRequestError("候选准备只能有一个终止性 failure marker")
    path = entries[0]
    if path.is_symlink() or not path.is_file() or path.suffix != ".json":
        raise AppRequestError("候选准备 failure marker 不是普通 JSON 文件")
    marker_path = core.regular_project_file(
        project,
        path.relative_to(project).as_posix(),
        "method generation failure marker",
    )
    marker = core.load_json(marker_path)
    label = marker.get("label") if isinstance(marker, dict) else None
    expected_keys = {
        "candidate_id",
        "content_hash",
        "context_sha256",
        "created_at",
        "error_code",
        "expected_epoch_sha256",
        "id",
        "kind",
        "label",
        "observed_evidence_sha256",
        "observed_epoch_sha256",
        "schema_version",
        "source_refs",
    }
    observed_epoch_sha256 = (
        marker.get("observed_epoch_sha256") if isinstance(marker, dict) else None
    )
    observed_evidence_sha256 = (
        marker.get("observed_evidence_sha256") if isinstance(marker, dict) else None
    )
    error_code = marker.get("error_code") if isinstance(marker, dict) else None
    if (
        not isinstance(marker, dict)
        or set(marker) != expected_keys
        or label not in METHOD_GENERATION_LABELS
        or path.name != f"{label}.json"
        or marker.get("kind") != "AppMethodGenerationFailure"
        or marker.get("id")
        != f"generation-failure-{proposal.get('id')}-{str(label).replace('_', '-')}"
        or marker.get("candidate_id") != proposal.get("id")
        or error_code not in {"METHOD_EPOCH_CHANGED", "METHOD_EPOCH_UNVERIFIABLE"}
        or marker.get("context_sha256")
        != _method_generation_expected_context(plan, str(label))
        or marker.get("expected_epoch_sha256")
        != proposal.get("source_epoch_sha256")
        or not isinstance(observed_evidence_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", observed_evidence_sha256)
        or (
            error_code == "METHOD_EPOCH_CHANGED"
            and (
                not isinstance(observed_epoch_sha256, str)
                or not re.fullmatch(r"[0-9a-f]{64}", observed_epoch_sha256)
                or observed_epoch_sha256 == proposal.get("source_epoch_sha256")
            )
        )
        or (
            error_code == "METHOD_EPOCH_UNVERIFIABLE"
            and observed_epoch_sha256 is not None
        )
        or marker.get("source_refs") != []
        or marker.get("content_hash") != core.app_record_content_hash(marker)
    ):
        raise AppRequestError("候选准备 failure marker 合同或摘要无效")
    return marker


def _write_method_generation_failure_marker(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    plan: Mapping[str, Any],
    label: str,
    *,
    error_code: str,
    observed_epoch_sha256: Optional[str],
    observed_evidence_sha256: str,
) -> Dict[str, Any]:
    existing = _validated_method_generation_failure(
        core, project, root, proposal, plan
    )
    if existing is not None:
        if (
            existing.get("label") != label
            or existing.get("error_code") != error_code
            or existing.get("observed_epoch_sha256") != observed_epoch_sha256
            or existing.get("observed_evidence_sha256")
            != observed_evidence_sha256
        ):
            raise AppRequestError("候选准备已绑定不同终止性 failure marker")
        return existing
    failures_root = _method_generation_failures_root(root)
    core.guarded_mkdir_project(
        project, failures_root, "method generation failure markers"
    )
    marker = _record(
        core,
        "AppMethodGenerationFailure",
        f"generation-failure-{proposal.get('id')}-{label.replace('_', '-')}",
        {
            "candidate_id": proposal.get("id"),
            "label": label,
            "error_code": error_code,
            "context_sha256": _method_generation_expected_context(plan, label),
            "expected_epoch_sha256": proposal.get("source_epoch_sha256"),
            "observed_epoch_sha256": observed_epoch_sha256,
            "observed_evidence_sha256": observed_evidence_sha256,
        },
    )
    core.atomic_create_json(failures_root / f"{label}.json", marker)
    validated = _validated_method_generation_failure(
        core, project, root, proposal, plan
    )
    if validated is None:
        raise AppRequestError("候选准备 failure marker 未成功封存")
    return validated


def _validated_staged_method_generation(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    plan: Mapping[str, Any],
    label: str,
) -> Optional[Dict[str, Any]]:
    slot_root = _method_generation_slot_root(root, label)
    if not os.path.lexists(str(slot_root)):
        return None
    if slot_root.is_symlink() or not slot_root.is_dir():
        raise AppRequestError(f"{label} 候选准备 slot 不是普通目录")
    _validated_method_generation_intent(
        core,
        project,
        root,
        proposal,
        plan,
        label,
        required=True,
    )
    if {item.name for item in slot_root.iterdir()} != {
        "output.md",
        "receipt.json",
        "runtime-provenance.json",
    }:
        raise AppRequestError(f"{label} generation slot 清单不是 exact-three")
    output_path = core.regular_project_file(
        project,
        (slot_root / "output.md").relative_to(project).as_posix(),
        f"{label} generation output",
    )
    provenance_path = core.regular_project_file(
        project,
        (slot_root / "runtime-provenance.json").relative_to(project).as_posix(),
        f"{label} generation provenance",
    )
    receipt_path = core.regular_project_file(
        project,
        (slot_root / "receipt.json").relative_to(project).as_posix(),
        f"{label} generation receipt",
    )
    try:
        output = output_path.read_bytes().decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise AppRequestError(f"{label} generation output 不是 UTF-8") from exc
    _text(output, f"{label}.output", maximum=500000, multiline=True)
    provenance = core.load_json(provenance_path)
    receipt = core.load_json(receipt_path)
    expected_context_sha256 = _method_generation_expected_context(plan, label)
    expected_output_sha256 = core.sha256_bytes(output.encode("utf-8"))
    if (
        not isinstance(provenance, dict)
        or provenance.get("kind") != "RuntimeProvenance"
        or provenance.get("content_hash") != core.app_record_content_hash(provenance)
        or provenance.get("context_sha256") != expected_context_sha256
    ):
        raise AppRequestError(f"{label} generation RuntimeProvenance 无效")
    _assert_method_generation_epoch(core, proposal, provenance)
    output_ref = receipt.get("output") if isinstance(receipt, dict) else None
    provenance_ref = (
        receipt.get("runtime_provenance") if isinstance(receipt, dict) else None
    )
    if (
        not isinstance(receipt, dict)
        or receipt.get("kind") != "AppMethodGenerationReceipt"
        or receipt.get("id") != f"generation-{proposal.get('id')}-{label.replace('_', '-')}"
        or receipt.get("candidate_id") != proposal.get("id")
        or receipt.get("label") != label
        or receipt.get("context_sha256") != expected_context_sha256
        or receipt.get("source_epoch_sha256")
        != proposal.get("source_epoch_sha256")
        or not isinstance(output_ref, dict)
        or output_ref.get("path") != output_path.relative_to(project).as_posix()
        or output_ref.get("sha256") != expected_output_sha256
        or output_ref.get("bytes") != output_path.stat().st_size
        or not isinstance(provenance_ref, dict)
        or provenance_ref.get("path")
        != provenance_path.relative_to(project).as_posix()
        or provenance_ref.get("sha256") != core.sha256_file(provenance_path)
        or receipt.get("content_hash") != core.app_record_content_hash(receipt)
    ):
        raise AppRequestError(f"{label} generation receipt 无效")
    return {
        "output": output,
        "output_sha256": expected_output_sha256,
        "provenance": provenance,
        "receipt": receipt,
    }


def _method_generation_progress(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> tuple[str, ...]:
    return tuple(
        label
        for label in METHOD_GENERATION_LABELS
        if _validated_staged_method_generation(
            core, project, root, proposal, plan, label
        )
        is not None
    )


def _reconcile_method_generation_pending(
    core: Any,
    project: Path,
    root: Path,
    proposal: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> None:
    generations_root = root / "preparation" / "generations"
    if not os.path.lexists(str(generations_root)):
        return
    if generations_root.is_symlink() or not generations_root.is_dir():
        raise AppRequestError("候选 preparation/generations 不是普通目录")
    allowed_entries = set(METHOD_GENERATION_LABELS) | {
        f".pending-{label}" for label in METHOD_GENERATION_LABELS
    }
    unexpected = sorted(
        item.name for item in generations_root.iterdir()
        if item.name not in allowed_entries
    )
    if unexpected:
        raise AppRequestError(
            "候选 generation 存在未治理的崩溃残留；为避免重复付费，只能放弃本次准备"
        )
    for label in METHOD_GENERATION_LABELS:
        pending = _method_generation_pending_root(root, label)
        if not os.path.lexists(str(pending)):
            continue
        if pending.is_symlink() or not pending.is_dir():
            raise AppRequestError(
                f"{label} pending slot 无效；为避免重复付费，只能放弃本次准备"
            )
        final = _method_generation_slot_root(root, label)
        if os.path.lexists(str(final)):
            raise AppRequestError(
                f"{label} 同时存在 committed 与 pending slot；只能放弃本次准备"
            )
        if {item.name for item in pending.iterdir()} != {
            "output.md",
            "receipt.json",
            "runtime-provenance.json",
        }:
            raise AppRequestError(
                f"{label} 付费结果只完成部分持久化；不会重跑，只能放弃本次准备"
            )
        _validated_method_generation_intent(
            core,
            project,
            root,
            proposal,
            plan,
            label,
            required=True,
        )
        os.rename(str(pending), str(final))
        _validated_staged_method_generation(
            core, project, root, proposal, plan, label
        )


def _begin_method_generation_locked(
    core: Any,
    project: Path,
    candidate_id: str,
    label: str,
    context_sha256: str,
    expected_epoch_sha256: str,
) -> tuple[bool, Path]:
    if label not in METHOD_GENERATION_LABELS:
        raise AppRequestError("候选准备 generation label 无效")
    root, proposal, status = _load_method_candidate(core, project, candidate_id)
    if _validated_method_rejection_receipt(core, project, candidate_id) is not None:
        raise AppRequestError("已放弃的方法候选不能开始 generation")
    if status.get("lifecycle") != "CANDIDATE":
        raise AppRequestError("当前候选已经离开可恢复的准备阶段")
    plan = _candidate_evaluation_plan(core, project, proposal)
    _reconcile_method_generation_pending(core, project, root, proposal, plan)
    if _method_comparisons_state_exists(root):
        raise AppRequestError("候选 comparisons 已存在，不能发起新的模型调用")
    if _validated_method_generation_failure(
        core, project, root, proposal, plan
    ) is not None:
        raise AppRequestError("这次候选准备已终止；请放弃本次准备")
    _method_generation_progress(core, project, root, proposal, plan)
    if (
        context_sha256 != _method_generation_expected_context(plan, label)
        or expected_epoch_sha256 != proposal.get("source_epoch_sha256")
    ):
        raise AppRequestError("generation intent 未绑定候选冻结上下文")
    if _validated_staged_method_generation(
        core, project, root, proposal, plan, label
    ) is not None:
        raise AppRequestError(f"{label} 已封存，不能重新开始模型调用")
    unresolved = _unresolved_method_generation_intent(
        core, project, root, proposal, plan
    )
    if unresolved is not None and unresolved != label:
        raise AppRequestError(
            f"{unresolved} 可能已经调用模型但未完整封存；"
            "为避免重复付费，只能放弃本次准备"
        )
    existing = _validated_method_generation_intent(
        core, project, root, proposal, plan, label
    )
    idempotent = existing is not None
    if existing is None:
        intent = _record(
            core,
            "AppMethodGenerationIntent",
            f"generation-intent-{candidate_id}-{label.replace('_', '-')}",
            {
                "candidate_id": candidate_id,
                "label": label,
                "context_sha256": context_sha256,
                "expected_epoch_sha256": expected_epoch_sha256,
                "output_persisted": False,
                "reasoning_persisted": False,
                "runtime_provenance_persisted": False,
            },
        )
        intent_path = _method_generation_intent_path(root, label)
        core.guarded_mkdir_project(
            project, intent_path.parent, "method generation intents"
        )
        core.atomic_create_json(intent_path, intent)
        existing = _validated_method_generation_intent(
            core, project, root, proposal, plan, label, required=True
        )
    if existing is None:
        raise AppRequestError(f"{label} generation intent 未成功封存")
    return idempotent, existing[0]


def _begin_method_generation(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "candidate_id",
            "context_sha256",
            "expected_epoch_sha256",
            "label",
            "project",
        },
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    label = _text(payload.get("label"), "label", maximum=40)
    context_sha256 = _text(
        payload.get("context_sha256"), "context_sha256", maximum=64
    )
    expected_epoch_sha256 = _text(
        payload.get("expected_epoch_sha256"),
        "expected_epoch_sha256",
        maximum=64,
    )
    if any(
        re.fullmatch(r"[0-9a-f]{64}", value) is None
        for value in (context_sha256, expected_epoch_sha256)
    ):
        raise AppRequestError("generation intent SHA256 无效")
    with core.exclusive_controller_lock(project):
        idempotent, intent_path = _begin_method_generation_locked(
            core,
            project,
            candidate_id,
            label,
            context_sha256,
            expected_epoch_sha256,
        )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "label": label,
        "context_sha256": context_sha256,
        "expected_epoch_sha256": expected_epoch_sha256,
        "intent_sha256": core.sha256_file(intent_path),
        "idempotent": idempotent,
    }


def _record_method_generation_locked(
    core: Any,
    project: Path,
    candidate_id: str,
    label: str,
    generation: Any,
) -> tuple[bool, tuple[str, ...]]:
    if label not in METHOD_GENERATION_LABELS:
        raise AppRequestError("候选准备 generation label 无效")
    root, proposal, status = _load_method_candidate(core, project, candidate_id)
    if _validated_method_rejection_receipt(core, project, candidate_id) is not None:
        raise AppRequestError("已放弃的方法候选不能继续封存 generation")
    if status.get("lifecycle") != "CANDIDATE":
        raise AppRequestError("当前候选已经离开可恢复的准备阶段")
    plan = _candidate_evaluation_plan(core, project, proposal)
    _reconcile_method_generation_pending(core, project, root, proposal, plan)
    if _method_comparisons_state_exists(root):
        raise AppRequestError("候选 comparisons 已存在，不能追加 generation")
    if _validated_method_generation_failure(
        core, project, root, proposal, plan
    ) is not None:
        raise AppRequestError(
            "这次候选准备已因模型基线变化永久停止；请放弃本次准备"
        )
    _method_generation_progress(core, project, root, proposal, plan)
    expected_context_sha256 = _method_generation_expected_context(plan, label)
    _validated_method_generation_intent(
        core,
        project,
        root,
        proposal,
        plan,
        label,
        required=True,
    )
    existing = _validated_staged_method_generation(
        core, project, root, proposal, plan, label
    )
    normalized = _normalize_method_generation(
        core,
        generation,
        candidate_id=candidate_id,
        label=label,
        expected_context_sha256=expected_context_sha256,
    )
    idempotent = existing is not None
    if existing is not None:
        if (
            existing["output"] != normalized["output"]
            or existing["provenance"] != normalized["provenance"]
        ):
            raise AppRequestError(f"{label} 已绑定不同生成结果，拒绝覆盖")
    else:
        expected_epoch_sha256, observed_epoch_sha256 = (
            _method_generation_epoch_hashes(
                core, proposal, normalized["provenance"]
            )
        )
        if observed_epoch_sha256 != expected_epoch_sha256:
            _write_method_generation_failure_marker(
                core,
                project,
                root,
                proposal,
                plan,
                label,
                error_code="METHOD_EPOCH_CHANGED",
                observed_epoch_sha256=observed_epoch_sha256,
                observed_evidence_sha256=observed_epoch_sha256,
            )
            raise AppRequestError(
                "候选比较的模型、fingerprint、Profile 或参数已变化；"
                "未保存生成正文，后续模型调用已永久阻止"
            )
        slot_root = _method_generation_slot_root(root, label)
        parent = slot_root.parent
        core.guarded_mkdir_project(project, parent, "method generation slots")
        staging = _method_generation_pending_root(root, label)
        if os.path.lexists(str(staging)):
            raise AppRequestError(f"{label} pending slot 已存在，拒绝覆盖")
        staging.mkdir()
        output_path = staging / "output.md"
        provenance_path = staging / "runtime-provenance.json"
        receipt_path = staging / "receipt.json"
        core.atomic_create_bytes(output_path, normalized["output"].encode("utf-8"))
        core.atomic_create_json(provenance_path, normalized["provenance"])
        final_output = slot_root / "output.md"
        final_provenance = slot_root / "runtime-provenance.json"
        receipt = _record(
            core,
            "AppMethodGenerationReceipt",
            f"generation-{candidate_id}-{label.replace('_', '-')}",
            {
                "candidate_id": candidate_id,
                "label": label,
                "context_sha256": expected_context_sha256,
                "source_epoch_sha256": proposal.get("source_epoch_sha256"),
                "output": {
                    "path": final_output.relative_to(project).as_posix(),
                    "sha256": normalized["output_sha256"],
                    "bytes": output_path.stat().st_size,
                },
                "runtime_provenance": {
                    "path": final_provenance.relative_to(project).as_posix(),
                    "sha256": core.sha256_file(provenance_path),
                },
            },
        )
        core.atomic_create_json(receipt_path, receipt)
        os.rename(str(staging), str(slot_root))
        _validated_staged_method_generation(
            core, project, root, proposal, plan, label
        )
    return idempotent, _method_generation_progress(
        core, project, root, proposal, plan
    )


def _record_method_generation(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload, "payload", {"candidate_id", "generation", "label", "project"}
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    label = _text(payload.get("label"), "label", maximum=40)
    with core.exclusive_controller_lock(project):
        idempotent, completed = _record_method_generation_locked(
            core, project, candidate_id, label, payload.get("generation")
        )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "label": label,
        "completed_generation_labels": list(completed),
        "generation_total": len(METHOD_GENERATION_LABELS),
        "idempotent": idempotent,
    }


def _record_method_generation_failure(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(
        payload,
        "payload",
        {
            "candidate_id",
            "context_sha256",
            "error_code",
            "expected_epoch_sha256",
            "label",
            "observed_evidence_sha256",
            "project",
        },
    )
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    label = _text(payload.get("label"), "label", maximum=40)
    if label not in METHOD_GENERATION_LABELS:
        raise AppRequestError("候选准备 generation label 无效")
    error_code = _text(payload.get("error_code"), "error_code", maximum=80)
    if error_code != "METHOD_EPOCH_UNVERIFIABLE":
        raise AppRequestError("generation failure error_code 无效")
    context_sha256 = _text(
        payload.get("context_sha256"), "context_sha256", maximum=64
    )
    expected_epoch_sha256 = _text(
        payload.get("expected_epoch_sha256"),
        "expected_epoch_sha256",
        maximum=64,
    )
    observed_evidence_sha256 = _text(
        payload.get("observed_evidence_sha256"),
        "observed_evidence_sha256",
        maximum=64,
    )
    if any(
        re.fullmatch(r"[0-9a-f]{64}", value) is None
        for value in (
            context_sha256,
            expected_epoch_sha256,
            observed_evidence_sha256,
        )
    ):
        raise AppRequestError("generation failure SHA256 无效")
    with core.exclusive_controller_lock(project):
        root, proposal, status = _load_method_candidate(
            core, project, candidate_id
        )
        if _validated_method_rejection_receipt(
            core, project, candidate_id
        ) is not None or status.get("lifecycle") != "CANDIDATE":
            raise AppRequestError("当前候选不能封存 generation failure")
        plan = _candidate_evaluation_plan(core, project, proposal)
        _reconcile_method_generation_pending(core, project, root, proposal, plan)
        if _method_comparisons_state_exists(root):
            raise AppRequestError("候选 comparisons 已存在，不能追加 generation failure")
        if (
            context_sha256 != _method_generation_expected_context(plan, label)
            or expected_epoch_sha256 != proposal.get("source_epoch_sha256")
        ):
            raise AppRequestError("generation failure 未绑定候选冻结上下文")
        _validated_method_generation_intent(
            core,
            project,
            root,
            proposal,
            plan,
            label,
            required=True,
        )
        if _validated_staged_method_generation(
            core, project, root, proposal, plan, label
        ) is not None:
            raise AppRequestError("generation 已成功封存，不能追加 failure marker")
        marker = _write_method_generation_failure_marker(
            core,
            project,
            root,
            proposal,
            plan,
            label,
            error_code=error_code,
            observed_epoch_sha256=None,
            observed_evidence_sha256=observed_evidence_sha256,
        )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "label": label,
        "error_code": marker.get("error_code"),
        "failure_marker_sha256": core.sha256_file(
            _method_generation_failures_root(root) / f"{label}.json"
        ),
    }


def _stage_method_comparisons(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"candidate_id", "generations", "project"})
    keys = set(payload)
    if keys not in (
        {"candidate_id", "project"},
        {"candidate_id", "generations", "project"},
    ):
        raise AppRequestError("stage_method_comparisons payload 字段无效")
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    with core.exclusive_controller_lock(project):
        if "generations" in payload:
            generations = _mapping(payload.get("generations"), "generations")
            _exact_keys(generations, "generations", set(METHOD_GENERATION_LABELS))
            if set(generations) != set(METHOD_GENERATION_LABELS):
                raise AppRequestError("generations 必须精确包含四个候选准备 slot")
            _, proposal, _ = _load_method_candidate(
                core, project, candidate_id
            )
            plan = _candidate_evaluation_plan(core, project, proposal)
            for label in METHOD_GENERATION_LABELS:
                _begin_method_generation_locked(
                    core,
                    project,
                    candidate_id,
                    label,
                    _method_generation_expected_context(plan, label),
                    str(proposal.get("source_epoch_sha256")),
                )
                _record_method_generation_locked(
                    core, project, candidate_id, label, generations.get(label)
                )
        result = _finalize_method_comparisons_locked(
            core, project, candidate_id
        )
    return result


def _write_method_comparisons_tree(
    core: Any,
    project: Path,
    comparisons_root: Path,
    candidate_id: str,
    pairs: Mapping[str, tuple[str, str]],
    generations: Mapping[str, Mapping[str, Any]],
    model: str,
    fingerprint: str,
) -> None:
    for phase in METHOD_PHASES:
        baseline, candidate = pairs[phase]
        candidate_left = int(
            hashlib.sha256(f"{candidate_id}:{phase}".encode("utf-8")).hexdigest()[:2],
            16,
        ) % 2 == 0
        left = candidate if candidate_left else baseline
        right = baseline if candidate_left else candidate
        mapping = _record(
            core,
            "AppMethodBlindMapping",
            f"mapping-{candidate_id}-{phase}",
            {
                "candidate_id": candidate_id,
                "phase": phase,
                "candidate_label": "A" if candidate_left else "B",
                "baseline_label": "B" if candidate_left else "A",
                "hidden_from_renderer_until_decision": True,
            },
        )
        public = _record(
            core,
            "AppMethodBlindComparison",
            f"comparison-{candidate_id}-{phase}",
            {
                "candidate_id": candidate_id,
                "phase": phase,
                "left": left,
                "left_sha256": core.sha256_bytes(left.encode("utf-8")),
                "right": right,
                "right_sha256": core.sha256_bytes(right.encode("utf-8")),
                "model": model,
                "system_fingerprint": fingerprint,
                "mapping_disclosed": False,
            },
        )
        phase_root = comparisons_root / phase
        generation_root = phase_root / "generation"
        generation_root.mkdir(parents=True)
        core.atomic_create_json(phase_root / "mapping.json", mapping)
        core.atomic_create_json(phase_root / "public.json", public)
        if phase == "heldout":
            phase_generations = {
                "baseline": generations["heldout_baseline"],
                "candidate": generations["heldout_candidate"],
            }
        else:
            phase_generations = {
                "candidate": generations[f"{phase}_candidate"],
            }
        for name, item in phase_generations.items():
            core.atomic_create_json(
                generation_root / f"{name}-provenance.json", item["provenance"]
            )


def _method_comparisons_pending_root(root: Path) -> Path:
    return root / ".pending-comparisons"


def _method_comparisons_state_exists(root: Path) -> bool:
    return (
        os.path.lexists(str(root / "comparisons"))
        or os.path.lexists(str(_method_comparisons_pending_root(root)))
        or any(item.name.startswith(".comparisons.") for item in root.iterdir())
    )


def _reconcile_method_comparisons_pending(root: Path) -> None:
    legacy_pending = [
        item for item in root.iterdir()
        if item.name.startswith(".comparisons.")
    ]
    if legacy_pending:
        raise AppRequestError(
            "候选 comparisons 存在旧版崩溃残留；不会重复生成，只能放弃本次准备"
        )
    pending = _method_comparisons_pending_root(root)
    if not os.path.lexists(str(pending)):
        return
    if pending.is_symlink() or not pending.is_dir():
        raise AppRequestError("候选 pending comparisons 无效；只能放弃本次准备")
    final = root / "comparisons"
    if os.path.lexists(str(final)):
        raise AppRequestError(
            "候选同时存在 committed 与 pending comparisons；只能放弃本次准备"
        )
    phases = {item.name: item for item in pending.iterdir()}
    if set(phases) != set(METHOD_PHASES):
        raise AppRequestError(
            "候选 comparisons 只完成部分持久化；不会重跑，只能放弃本次准备"
        )
    for phase, phase_root in phases.items():
        if phase_root.is_symlink() or not phase_root.is_dir():
            raise AppRequestError("候选 pending comparison phase 无效")
        entries = {item.name: item for item in phase_root.iterdir()}
        if set(entries) != {"generation", "mapping.json", "public.json"}:
            raise AppRequestError(
                "候选 comparison phase 只完成部分持久化；只能放弃本次准备"
            )
        generation_root = entries["generation"]
        if generation_root.is_symlink() or not generation_root.is_dir():
            raise AppRequestError("候选 pending comparison generation 无效")
        expected_generation_files = (
            {"baseline-provenance.json", "candidate-provenance.json"}
            if phase == "heldout"
            else {"candidate-provenance.json"}
        )
        if {item.name for item in generation_root.iterdir()} != expected_generation_files:
            raise AppRequestError(
                "候选 comparison provenance 只完成部分持久化；只能放弃本次准备"
            )
    os.rename(str(pending), str(final))


def _validate_final_method_comparisons(
    core: Any,
    project: Path,
    root: Path,
    candidate_id: str,
    pairs: Mapping[str, tuple[str, str]],
    generations: Mapping[str, Mapping[str, Any]],
    model: str,
    fingerprint: str,
) -> None:
    comparisons_root = root / "comparisons"
    if comparisons_root.is_symlink() or not comparisons_root.is_dir():
        raise AppRequestError("候选 comparisons 不是普通目录")
    observed_phases = {
        item.name
        for item in comparisons_root.iterdir()
        if item.name != ".gitkeep"
    }
    if observed_phases != set(METHOD_PHASES):
        raise AppRequestError("候选 comparisons 不是完整 exact-three")
    for phase in METHOD_PHASES:
        baseline, candidate = pairs[phase]
        public_path, mapping_path, public, mapping = _validated_method_comparison(
            core, project, root, candidate_id, phase
        )
        candidate_left = int(
            hashlib.sha256(f"{candidate_id}:{phase}".encode("utf-8")).hexdigest()[:2],
            16,
        ) % 2 == 0
        expected_left = candidate if candidate_left else baseline
        expected_right = baseline if candidate_left else candidate
        if (
            mapping.get("candidate_label") != ("A" if candidate_left else "B")
            or mapping.get("baseline_label") != ("B" if candidate_left else "A")
            or public.get("left") != expected_left
            or public.get("right") != expected_right
            or public.get("model") != model
            or public.get("system_fingerprint") != fingerprint
        ):
            raise AppRequestError("候选 comparisons 与已封存 generation 不一致")
        if not public_path.is_file() or not mapping_path.is_file():
            raise AppRequestError("候选 comparisons 公开文本或映射缺失")
        generation_root = comparisons_root / phase / "generation"
        if generation_root.is_symlink() or not generation_root.is_dir():
            raise AppRequestError("候选 comparison generation 不是普通目录")
        expected_generations = (
            {
                "baseline": generations["heldout_baseline"],
                "candidate": generations["heldout_candidate"],
            }
            if phase == "heldout"
            else {"candidate": generations[f"{phase}_candidate"]}
        )
        observed_files = {item.name for item in generation_root.iterdir()}
        expected_files = {
            f"{name}-provenance.json" for name in expected_generations
        }
        if observed_files != expected_files:
            raise AppRequestError("候选 comparison generation 清单无效")
        for name, item in expected_generations.items():
            provenance_path = core.regular_project_file(
                project,
                (generation_root / f"{name}-provenance.json")
                .relative_to(project)
                .as_posix(),
                f"{phase} {name} comparison provenance",
            )
            if core.load_json(provenance_path) != item["provenance"]:
                raise AppRequestError("候选 comparison provenance 与准备 receipt 不一致")


def _finalize_method_comparisons_locked(
    core: Any,
    project: Path,
    candidate_id: str,
    *,
    include_snapshot: bool = True,
) -> Dict[str, Any]:
    root, proposal, status = _load_method_candidate(core, project, candidate_id)
    if _validated_method_rejection_receipt(core, project, candidate_id) is not None:
        raise AppRequestError("已放弃的方法候选不能建立或继续盲比")
    if status.get("lifecycle") not in {"CANDIDATE", "EVALUATING", "READY_FOR_HUMAN"}:
        raise AppRequestError("当前方法候选不能建立盲比")
    plan = _candidate_evaluation_plan(core, project, proposal)
    _reconcile_method_generation_pending(core, project, root, proposal, plan)
    if _validated_method_generation_failure(
        core, project, root, proposal, plan
    ) is not None:
        raise AppRequestError(
            "这次候选准备已因模型基线变化永久停止；请放弃本次准备"
        )
    unresolved_intent = _unresolved_method_generation_intent(
        core, project, root, proposal, plan
    )
    if unresolved_intent is not None:
        raise AppRequestError(
            f"{unresolved_intent} 可能已在付费后中断；为避免重复付费，请放弃本次准备"
        )
    normalized: Dict[str, Dict[str, Any]] = {}
    for label in METHOD_GENERATION_LABELS:
        item = _validated_staged_method_generation(
            core, project, root, proposal, plan, label
        )
        if item is None:
            raise AppRequestError(
                f"候选准备尚未完成 {label}；已封存结果会保留，请继续准备"
            )
        normalized[label] = item
    context = _candidate_context_value(
        core,
        project,
        str(proposal["observation_id"]),
        candidate_id,
        frozen_sources=proposal.get("source_works"),
    )
    source_provenance = [item["provenance"] for item in context["source_works"]]
    builder_provenance = core.load_json(
        core.regular_project_file(
            project,
            (root / "builder-provenance.json").relative_to(project).as_posix(),
            "builder provenance",
        )
    )
    provenances = [
        *source_provenance,
        builder_provenance,
        *(item["provenance"] for item in normalized.values()),
    ]
    source_epoch = proposal.get("source_epoch")
    source_epoch_sha256 = proposal.get("source_epoch_sha256")
    if (
        not isinstance(source_epoch, dict)
        or not isinstance(source_epoch_sha256, str)
        or source_epoch_sha256
        != core.sha256_bytes(core.canonical_json_bytes(source_epoch))
    ):
        raise AppRequestError("候选冻结的模型基线无效")
    for provenance in provenances:
        if not isinstance(provenance, dict):
            raise AppRequestError("候选比较缺少 RuntimeProvenance")
        observed_epoch = _method_epoch_value(
            core,
            {
                "app_method_version_at_start": source_epoch.get(
                    "method_version"
                )
            },
            provenance,
        )
        if observed_epoch["sha256"] != source_epoch_sha256:
            raise AppRequestError(
                "候选比较期间方法、模型、fingerprint、Profile 或参数已变化；请建立新基线"
            )
    model = str(source_epoch["returned_model"])
    fingerprint = str(source_epoch["system_fingerprint"])

    pairs = {
        "targeted": (
            str(plan["targeted"]["baseline_output"]),
            normalized["targeted_candidate"]["output"],
        ),
        "regression": (
            str(plan["regression"]["baseline_output"]),
            normalized["regression_candidate"]["output"],
        ),
        "heldout": (
            normalized["heldout_baseline"]["output"],
            normalized["heldout_candidate"]["output"],
        ),
    }
    comparisons_root = root / "comparisons"
    _reconcile_method_comparisons_pending(root)
    if os.path.lexists(str(comparisons_root)):
        _validate_final_method_comparisons(
            core,
            project,
            root,
            candidate_id,
            pairs,
            normalized,
            model,
            fingerprint,
        )
    else:
        staging = _method_comparisons_pending_root(root)
        if os.path.lexists(str(staging)):
            raise AppRequestError("候选 pending comparisons 已存在，拒绝覆盖")
        staging.mkdir()
        _write_method_comparisons_tree(
            core,
            project,
            staging,
            candidate_id,
            pairs,
            normalized,
            model,
            fingerprint,
        )
        os.rename(str(staging), str(comparisons_root))
        _validate_final_method_comparisons(
            core,
            project,
            root,
            candidate_id,
            pairs,
            normalized,
            model,
            fingerprint,
        )
    lifecycle = (
        "EVALUATING" if status.get("lifecycle") == "CANDIDATE" else str(status.get("lifecycle"))
    )
    _candidate_status_update(
        core,
        root,
        status,
        lifecycle=lifecycle,
        model=model,
        system_fingerprint=fingerprint,
        source_epoch_sha256=source_epoch_sha256,
    )
    result = {
        "status": "PASS",
        "candidate_id": candidate_id,
        "lifecycle": lifecycle,
    }
    if include_snapshot:
        result["snapshot"] = _system_snapshot({"project": str(project)})
    return result


def _reconcile_method_preparations_locked(core: Any, project: Path) -> None:
    candidates_root = project / "creative-system" / "app-methods" / "candidates"
    if not os.path.lexists(str(candidates_root)):
        return
    if candidates_root.is_symlink() or not candidates_root.is_dir():
        raise AppRequestError("方法候选根目录不是普通目录")
    for candidate_dir in sorted(candidates_root.iterdir(), key=lambda item: item.name):
        if candidate_dir.name.startswith("."):
            continue
        if candidate_dir.is_symlink() or not candidate_dir.is_dir():
            raise AppRequestError("方法候选路径不是普通目录")
        _, _, status = _load_method_candidate(core, project, candidate_dir.name)
        comparisons_root = candidate_dir / "comparisons"
        pending_comparisons = _method_comparisons_pending_root(candidate_dir)
        if status.get("lifecycle") != "CANDIDATE" or not (
            os.path.lexists(str(comparisons_root))
            or os.path.lexists(str(pending_comparisons))
        ):
            continue
        try:
            _finalize_method_comparisons_locked(
                core,
                project,
                candidate_dir.name,
                include_snapshot=False,
            )
        except AppRequestError:
            # Public projection will keep this candidate visible with a precise
            # non-resumable reason and only the immutable rejection action.
            continue


def _reconcile_method_rejections_locked(core: Any, project: Path) -> None:
    candidates_root = project / "creative-system" / "app-methods" / "candidates"
    if not os.path.lexists(str(candidates_root)):
        return
    if candidates_root.is_symlink() or not candidates_root.is_dir():
        raise AppRequestError("方法候选根目录不是普通目录")
    for candidate_dir in sorted(candidates_root.iterdir(), key=lambda item: item.name):
        if candidate_dir.name.startswith("."):
            continue
        if candidate_dir.is_symlink() or not candidate_dir.is_dir():
            raise AppRequestError("方法候选路径不是普通目录")
        root, proposal, status = _load_method_candidate(
            core, project, candidate_dir.name
        )
        rejection = _validated_method_rejection_receipt(
            core, project, candidate_dir.name
        )
        if rejection is None:
            if status.get("lifecycle") == "REJECTED":
                raise AppRequestError("REJECTED 方法候选缺少 RejectionReceipt")
            continue
        if (
            status.get("lifecycle") == "PROMOTED"
            or _validated_method_promotion_receipt(
                core, project, candidate_dir.name, proposal
            )
            is not None
        ):
            raise AppRequestError("方法候选同时存在采用与拒绝凭证")
        relative = rejection[0].relative_to(project).as_posix()
        if (
            status.get("lifecycle") != "REJECTED"
            or status.get("rejection_receipt") != relative
        ):
            _candidate_status_update(
                core,
                root,
                status,
                lifecycle="REJECTED",
                rejection_receipt=relative,
            )


def _submit_method_comparison(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"candidate_id", "choice", "phase", "project"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    phase = _text(payload.get("phase"), "phase", maximum=20)
    choice = _text(payload.get("choice"), "choice", maximum=10).upper()
    if phase not in METHOD_PHASES or choice not in METHOD_CHOICES:
        raise AppRequestError("盲比 phase 或 choice 无效")
    root, _, status = _load_method_candidate(core, project, candidate_id)
    if _validated_method_rejection_receipt(
        core, project, candidate_id
    ) is not None:
        raise AppRequestError("已放弃的方法候选不能继续提交盲比")
    if status.get("lifecycle") not in {"EVALUATING", "READY_FOR_HUMAN", "BLOCKED"}:
        raise AppRequestError("当前候选不能提交盲比")
    phase_root = root / "comparisons" / phase
    public_path, mapping_path, _, mapping = _validated_method_comparison(
        core, project, root, candidate_id, phase
    )
    decision_path = phase_root / "decision.json"
    if os.path.lexists(str(decision_path)):
        decision = _validated_method_decision(
            core, project, root, candidate_id, phase
        )
        if decision is None or decision.get("choice") != choice:
            raise AppRequestError("这组盲比已提交不同选择，拒绝覆盖")
    else:
        candidate_label = mapping.get("candidate_label") if isinstance(mapping, dict) else None
        if candidate_label not in {"A", "B"}:
            raise AppRequestError("盲比映射无效")
        candidate_result = "TIE" if choice == "TIE" else (
            "PREFERRED" if choice == candidate_label else "INFERIOR"
        )
        decision = _record(
            core,
            "AppMethodBlindDecision",
            f"decision-{candidate_id}-{phase}",
            {
                "candidate_id": candidate_id,
                "phase": phase,
                "choice": choice,
                "candidate_result": candidate_result,
                "public_comparison_sha256": core.sha256_file(public_path),
                "mapping_sha256": core.sha256_file(mapping_path),
                "decided_by": "local-app-user",
            },
        )
        core.atomic_create_json(decision_path, decision)
    lifecycle, summary = _method_evaluation_projection(
        core, project, root, candidate_id, status
    )
    if lifecycle in {"CANDIDATE", "EVALUATING"}:
        lifecycle = "EVALUATING"
    _candidate_status_update(
        core, root, status, lifecycle=lifecycle, evaluation_summary=summary
    )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "lifecycle": lifecycle,
        "snapshot": _system_snapshot({"project": str(project)}),
    }


def _validated_method_comparison(
    core: Any,
    project: Path,
    root: Path,
    candidate_id: str,
    phase: str,
) -> tuple[Path, Path, Dict[str, Any], Dict[str, Any]]:
    phase_root = root / "comparisons" / phase
    public_path = core.regular_project_file(
        project,
        (phase_root / "public.json").relative_to(project).as_posix(),
        "comparison public",
    )
    mapping_path = core.regular_project_file(
        project,
        (phase_root / "mapping.json").relative_to(project).as_posix(),
        "comparison mapping",
    )
    public = core.load_json(public_path)
    mapping = core.load_json(mapping_path)
    left = public.get("left") if isinstance(public, dict) else None
    right = public.get("right") if isinstance(public, dict) else None
    if (
        not isinstance(public, dict)
        or public.get("kind") != "AppMethodBlindComparison"
        or public.get("candidate_id") != candidate_id
        or public.get("phase") != phase
        or public.get("mapping_disclosed") is not False
        or public.get("content_hash") != core.app_record_content_hash(public)
        or not isinstance(left, str)
        or not isinstance(right, str)
        or public.get("left_sha256") != core.sha256_bytes(left.encode("utf-8"))
        or public.get("right_sha256") != core.sha256_bytes(right.encode("utf-8"))
    ):
        raise AppRequestError("候选盲比 public 合同或摘要无效")
    candidate_label = mapping.get("candidate_label") if isinstance(mapping, dict) else None
    baseline_label = mapping.get("baseline_label") if isinstance(mapping, dict) else None
    if (
        not isinstance(mapping, dict)
        or mapping.get("kind") != "AppMethodBlindMapping"
        or mapping.get("candidate_id") != candidate_id
        or mapping.get("phase") != phase
        or candidate_label not in {"A", "B"}
        or baseline_label not in {"A", "B"}
        or candidate_label == baseline_label
        or mapping.get("hidden_from_renderer_until_decision") is not True
        or mapping.get("content_hash") != core.app_record_content_hash(mapping)
    ):
        raise AppRequestError("候选盲比 mapping 合同或摘要无效")
    return public_path, mapping_path, public, mapping


def _validated_method_decision(
    core: Any,
    project: Path,
    root: Path,
    candidate_id: str,
    phase: str,
) -> Optional[Dict[str, Any]]:
    decision_path = root / "comparisons" / phase / "decision.json"
    if not os.path.lexists(str(decision_path)):
        return None
    decision_file = core.regular_project_file(
        project,
        decision_path.relative_to(project).as_posix(),
        "comparison decision",
    )
    public_path, mapping_path, _, mapping = _validated_method_comparison(
        core, project, root, candidate_id, phase
    )
    decision = core.load_json(decision_file)
    choice = decision.get("choice") if isinstance(decision, dict) else None
    candidate_label = mapping.get("candidate_label")
    expected_result = (
        "TIE"
        if choice == "TIE"
        else "PREFERRED"
        if choice == candidate_label
        else "INFERIOR"
    )
    if (
        not isinstance(decision, dict)
        or decision.get("kind") != "AppMethodBlindDecision"
        or decision.get("candidate_id") != candidate_id
        or decision.get("phase") != phase
        or choice not in METHOD_CHOICES
        or decision.get("candidate_result") != expected_result
        or decision.get("public_comparison_sha256") != core.sha256_file(public_path)
        or decision.get("mapping_sha256") != core.sha256_file(mapping_path)
        or decision.get("decided_by") != "local-app-user"
        or decision.get("content_hash") != core.app_record_content_hash(decision)
    ):
        raise AppRequestError("候选盲比 decision 合同或摘要无效")
    return decision


def _method_evaluation_projection(
    core: Any,
    project: Path,
    root: Path,
    candidate_id: str,
    status: Mapping[str, Any],
) -> tuple[str, Optional[Dict[str, Any]]]:
    decisions: Dict[str, Dict[str, Any]] = {}
    for phase in METHOD_PHASES:
        decision = _validated_method_decision(
            core, project, root, candidate_id, phase
        )
        if decision is not None:
            decisions[phase] = decision

    recorded_lifecycle = status.get("lifecycle")
    recorded_summary = status.get("evaluation_summary")
    if len(decisions) < len(METHOD_PHASES):
        if recorded_lifecycle in {"READY_FOR_HUMAN", "BLOCKED", "PROMOTED"}:
            raise AppRequestError("候选状态声称评价完成，但缺少 exact-three 决定")
        return str(recorded_lifecycle), (
            dict(recorded_summary) if isinstance(recorded_summary, dict) else None
        )

    targeted_pass = decisions["targeted"].get("candidate_result") == "PREFERRED"
    regression_pass = decisions["regression"].get("candidate_result") in {
        "PREFERRED",
        "TIE",
    }
    heldout_pass = decisions["heldout"].get("candidate_result") in {
        "PREFERRED",
        "TIE",
    }
    summary = {
        "targeted": "IMPROVED" if targeted_pass else "NOT_IMPROVED",
        "regression": "NON_INFERIOR" if regression_pass else "REGRESSED",
        "heldout": "NON_INFERIOR" if heldout_pass else "WORSE",
        "exact_three": True,
        "human_blind": True,
    }
    derived_lifecycle = (
        "READY_FOR_HUMAN"
        if all((targeted_pass, regression_pass, heldout_pass))
        else "BLOCKED"
    )
    if recorded_lifecycle == "PROMOTED":
        if derived_lifecycle != "READY_FOR_HUMAN":
            raise AppRequestError("已采用候选的 exact-three 决定不再满足采用门")
        return "PROMOTED", summary
    if recorded_lifecycle == "REJECTED":
        return "REJECTED", summary
    if recorded_lifecycle in {"READY_FOR_HUMAN", "BLOCKED"}:
        if recorded_lifecycle != derived_lifecycle:
            raise AppRequestError("候选状态与不可变 exact-three 决定不一致")
    return derived_lifecycle, summary


def _adopt_method_candidate(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"candidate_id", "project"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    with core.exclusive_controller_lock(project):
        root, proposal, status = _load_method_candidate(core, project, candidate_id)
        if _validated_method_rejection_receipt(
            core, project, candidate_id
        ) is not None:
            raise AppRequestError("已放弃的方法候选不能采用")
        projected_lifecycle, projected_summary = _method_evaluation_projection(
            core, project, root, candidate_id, status
        )
        if projected_lifecycle not in {"READY_FOR_HUMAN", "PROMOTED"}:
            raise AppRequestError("候选未通过三组盲比，不能采用")
        if status.get("lifecycle") != projected_lifecycle or status.get(
            "evaluation_summary"
        ) != projected_summary:
            status = _candidate_status_update(
                core,
                root,
                status,
                lifecycle=projected_lifecycle,
                evaluation_summary=projected_summary,
            )
        summary = projected_summary
        if not isinstance(summary, dict) or (
            summary.get("targeted") != "IMPROVED"
            or summary.get("regression") != "NON_INFERIOR"
            or summary.get("heldout") != "NON_INFERIOR"
            or summary.get("exact_three") is not True
            or summary.get("human_blind") is not True
        ):
            raise AppRequestError("候选评价摘要未通过采用门")
        registry = _method_registry(core, project)
        activation = _method_candidate_activation_projection(
            core, project, candidate_id, proposal, status, registry
        )
        if activation["rolled_back"]:
            raise AppRequestError(
                "该方法已显式回滚；不能通过采用按钮重新激活，请在版本页恢复历史版本"
            )
        previous = str(proposal.get("previous_method_version"))
        if registry.get("active_method_version") not in {previous, candidate_id}:
            raise AppRequestError("当前方法已变化，请建立新候选")
        promotion_path = (
            project
            / "creative-system"
            / "app-methods"
            / "promotions"
            / f"{candidate_id}.json"
        )
        decision_hashes: Dict[str, str] = {}
        for phase in METHOD_PHASES:
            decision = _validated_method_decision(
                core, project, root, candidate_id, phase
            )
            if decision is None:
                raise AppRequestError("候选缺少 exact-three 盲比决定")
            decision_hashes[phase] = core.sha256_file(
                core.regular_project_file(
                    project,
                    (root / "comparisons" / phase / "decision.json")
                    .relative_to(project)
                    .as_posix(),
                    f"{phase} decision",
                )
            )
        if os.path.lexists(str(promotion_path)):
            promotion = core.load_json(promotion_path)
            if (
                not isinstance(promotion, dict)
                or promotion.get("candidate_id") != candidate_id
                or promotion.get("decision_sha256") != decision_hashes
                or promotion.get("content_hash")
                != core.app_record_content_hash(promotion)
            ):
                raise AppRequestError("既有方法采用凭证无效")
        else:
            promotion = _record(
                core,
                "AppMethodPromotionReceipt",
                f"promotion-{candidate_id}",
                {
                    "candidate_id": candidate_id,
                    "previous_version": previous,
                    "new_version": candidate_id,
                    "guidance": proposal.get("guidance"),
                    "guidance_sha256": proposal.get("guidance_sha256"),
                    "decision_sha256": decision_hashes,
                    "approved_by": "local-app-user",
                    "approval_action": "adopt-new-method",
                    "formal_l4_authority": False,
                    "rollback_to": previous,
                },
            )
            core.guarded_mkdir_project(
                project, promotion_path.parent, "app method promotions"
            )
            core.atomic_create_json(promotion_path, promotion)
        history = list(registry.get("history", []))
        if not any(
            isinstance(item, dict)
            and item.get("action") == "PROMOTE"
            and item.get("version") == candidate_id
            for item in history
        ):
            history.append(
                {
                    "action": "PROMOTE",
                    "version": candidate_id,
                    "previous_version": previous,
                    "guidance": proposal.get("guidance"),
                    "guidance_sha256": proposal.get("guidance_sha256"),
                    "created_at": promotion.get("created_at"),
                    "receipt": promotion_path.relative_to(project).as_posix(),
                    "receipt_sha256": core.sha256_file(promotion_path),
                }
            )
        registry = {
            **registry,
            "active_method_version": candidate_id,
            "active_guidance_sha256": proposal.get("guidance_sha256"),
            "history": history,
        }
        status = _candidate_status_update(
            core,
            root,
            status,
            lifecycle="PROMOTED",
            promotion_receipt=promotion_path.relative_to(project).as_posix(),
        )
        # A promoted-but-not-yet-active candidate is safe and recoverable: the
        # production pointer still references the previous stable method.  The
        # inverse ordering could make production point at an unpromoted
        # candidate and block every status read after a crash.
        _write_method_registry(core, project, registry)
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "active_method_version": candidate_id,
        "formal_l4": False,
        "snapshot": _system_snapshot({"project": str(project)}),
    }


def _reject_method_candidate(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"candidate_id", "project"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    candidate_id = _id(payload.get("candidate_id"), "candidate_id")
    with core.exclusive_controller_lock(project):
        if not os.path.lexists(str(_candidate_root(project, candidate_id))):
            validated_intent = _validated_method_builder_intent(
                core, project, candidate_id, required=True
            )
            if validated_intent is None:
                raise AppRequestError("Candidate Builder 准备 intent 缺失")
            intent_path, intent = validated_intent
            existing_builder_rejection = _validated_method_builder_rejection(
                core, project, candidate_id, intent
            )
            if existing_builder_rejection is None:
                builder_rejection = _record(
                    core,
                    "AppMethodBuilderRejectionReceipt",
                    f"builder-rejection-{candidate_id}",
                    {
                        "candidate_id": candidate_id,
                        "intent_sha256": core.sha256_file(intent_path),
                        "rejected_by": "local-app-user",
                        "active_method_unchanged": True,
                    },
                )
                builder_rejection_path = _method_builder_rejection_path(
                    project, candidate_id
                )
                core.guarded_mkdir_project(
                    project,
                    builder_rejection_path.parent,
                    "method builder rejection receipts",
                )
                core.atomic_create_json(
                    builder_rejection_path, builder_rejection
                )
                existing_builder_rejection = (
                    _validated_method_builder_rejection(
                        core, project, candidate_id, intent
                    )
                )
            if existing_builder_rejection is None:
                raise AppRequestError("Candidate Builder 拒绝 receipt 未成功封存")
            return {
                "status": "PASS",
                "candidate_id": candidate_id,
                "snapshot": _system_snapshot({"project": str(project)}),
            }
        root, proposal, status = _load_method_candidate(core, project, candidate_id)
        if (
            status.get("lifecycle") == "PROMOTED"
            or _validated_method_promotion_receipt(
                core, project, candidate_id, proposal
            )
            is not None
        ):
            raise AppRequestError("已采用方法不能改写为拒绝；请使用回滚")
        receipt_path = root / "rejection.json"
        validated_rejection = _validated_method_rejection_receipt(
            core, project, candidate_id
        )
        if validated_rejection is None:
            receipt = _record(
                core,
                "AppMethodRejectionReceipt",
                f"rejection-{candidate_id}",
                {
                    "candidate_id": candidate_id,
                    "rejected_by": "local-app-user",
                    "active_method_unchanged": True,
                },
            )
            core.atomic_create_json(receipt_path, receipt)
            validated_rejection = _validated_method_rejection_receipt(
                core, project, candidate_id
            )
        if validated_rejection is None:
            raise AppRequestError("RejectionReceipt 未成功封存")
        _candidate_status_update(
            core,
            root,
            status,
            lifecycle="REJECTED",
            rejection_receipt=receipt_path.relative_to(project).as_posix(),
        )
    return {
        "status": "PASS",
        "candidate_id": candidate_id,
        "snapshot": _system_snapshot({"project": str(project)}),
    }


def _rollback_method(payload: Mapping[str, Any]) -> Dict[str, Any]:
    _exact_keys(payload, "payload", {"project", "to_version"})
    core = load_controller()
    project = _project_path(payload.get("project"))
    to_version = _id(payload.get("to_version"), "to_version")
    with core.exclusive_controller_lock(project):
        registry = _reconcile_method_rollbacks_locked(core, project)
        previous = str(registry.get("active_method_version"))
        if previous == to_version:
            return {
                "status": "PASS",
                "active_method_version": to_version,
                "idempotent": True,
                "snapshot": _system_snapshot({"project": str(project)}),
            }
        known = {"baseline-v1"}
        for item in registry.get("history", []):
            if isinstance(item, dict) and isinstance(item.get("version"), str):
                known.add(str(item["version"]))
        if to_version not in known:
            raise AppRequestError("回滚目标不是已知稳定方法版本")
        guidance_sha256: Optional[str] = None
        if to_version != "baseline-v1":
            _, proposal, status = _load_method_candidate(core, project, to_version)
            if status.get("lifecycle") != "PROMOTED":
                raise AppRequestError("回滚目标没有有效采用凭证")
            if (
                _validated_method_promotion_receipt(
                    core, project, to_version, proposal
                )
                is None
            ):
                raise AppRequestError("回滚目标缺少不可变采用凭证")
            guidance_sha256 = str(proposal.get("guidance_sha256"))
        history = list(registry.get("history", []))
        receipt_id = (
            f"rollback-{len(history) + 1:06d}-{previous}-to-{to_version}"
        )
        receipt_path = (
            project
            / "creative-system"
            / "app-methods"
            / "rollbacks"
            / f"{receipt_id}.json"
        )
        if not os.path.lexists(str(receipt_path)):
            receipt = _record(
                core,
                "AppMethodRollbackReceipt",
                receipt_id,
                {
                    "previous_version": previous,
                    "restored_version": to_version,
                    "requested_by": "local-app-user",
                    "history_retained": True,
                    "formal_l4_authority": False,
                },
            )
            core.guarded_mkdir_project(
                project, receipt_path.parent, "app method rollbacks"
            )
            core.atomic_create_json(receipt_path, receipt)
        pending = _validated_method_rollback_receipts(core, project, registry)
        matching = [item for item in pending if item[0] == receipt_path]
        if len(matching) != 1:
            raise AppRequestError("本次 rollback receipt 未形成唯一待投影动作")
        _, receipt = matching[0]
        history.append(
            {
                "action": "ROLLBACK",
                "version": to_version,
                "previous_version": previous,
                "created_at": receipt.get("created_at") if isinstance(receipt, dict) else core.utc_now(),
                "receipt": receipt_path.relative_to(project).as_posix(),
                "receipt_sha256": core.sha256_file(receipt_path),
            }
        )
        _write_method_registry(
            core,
            project,
            {
                **registry,
                "active_method_version": to_version,
                "active_guidance_sha256": guidance_sha256,
                "history": history,
            },
        )
    return {
        "status": "PASS",
        "previous_method_version": previous,
        "active_method_version": to_version,
        "idempotent": False,
        "snapshot": _system_snapshot({"project": str(project)}),
    }


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
        "begin_method_candidate_preparation": _begin_method_candidate_preparation,
        "begin_method_generation": _begin_method_generation,
        "cancel_work": _cancel_work,
        "complete_work": _complete_work,
        "create_method_candidate": _create_method_candidate,
        "record_feedback": _record_feedback,
        "record_method_generation": _record_method_generation,
        "record_method_generation_failure": _record_method_generation_failure,
        "record_method_builder_failure": _record_method_builder_failure,
        "adopt_method_candidate": _adopt_method_candidate,
        "method_candidate_context": _method_candidate_context,
        "production_context": _production_context,
        "reject_method_candidate": _reject_method_candidate,
        "resume_feedback": _resume_feedback,
        "rollback_method": _rollback_method,
        "seal_feedback": _seal_feedback,
        "stage_method_comparisons": _stage_method_comparisons,
        "submit_method_comparison": _submit_method_comparison,
        "submit_feedback": _submit_feedback,
        "create_system_lab_candidate": _create_system_lab_candidate,
        "candidate_summary": _candidate_summary,
        "system_snapshot": _system_snapshot_request,
        "terminate_work": _terminate_work,
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
