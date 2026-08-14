import json
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
PYTHON_ROOT = REPO / "python"
SCRIPT = REPO / "skills" / "creative-loop2rsi" / "scripts" / "loopctl.py"
sys.path.insert(0, str(PYTHON_ROOT))

from creative_loop2rsi.service import AppRequestError, handle_request  # noqa: E402
import creative_loop2rsi.service as app_service  # noqa: E402
from creative_loop2rsi._legacy import load_controller  # noqa: E402


class AppControllerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sequence = 0

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, operation, payload):
        self.sequence += 1
        return handle_request(
            {
                "protocol_version": "1",
                "request_id": f"request-{self.sequence}",
                "operation": operation,
                "payload": payload,
            }
        )

    def command(self, *arguments, expected=0):
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, arguments)],
            cwd=str(REPO),
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            expected,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        return json.loads(result.stdout)

    @staticmethod
    def read_json(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    @staticmethod
    def write_json(path, value):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def bootstrap(self, name="app-project"):
        project = self.root / name
        result = self.request(
            "bootstrap_intent",
            {
                "project": str(project),
                "system_id": "quiet-mystery",
                "display_name": "克制悬疑创作系统",
                "intent": "写克制的近未来悬疑故事",
            },
        )
        self.assertEqual(result["status"], "PASS")
        return project, result

    def begin_with_artifact(self, project, *, run_id="run-one", work_id="work-one"):
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": run_id,
                "work_id": work_id,
                "task": f"创作任务 {work_id}",
            },
        )
        artifact = project / begun["allowed_writes_root"] / "work.md"
        artifact.write_text(f"虚构作品 {work_id}\n", encoding="utf-8")
        return begun, artifact

    @staticmethod
    def runtime_provenance(*, completed_at="2026-08-14T00:00:00Z"):
        usage = {
            "prompt_tokens": 120,
            "completion_tokens": 300,
            "total_tokens": 420,
        }
        return {
            "context_sha256": hashlib.sha256(
                "写克制的近未来悬疑故事".encode("utf-8")
            ).hexdigest(),
            "requested_model": "deepseek-v4-pro",
            "returned_model": "deepseek-v4-pro",
            "system_fingerprint": "fp-synthetic-v1",
            "response_id": "response-synthetic-one",
            "completed_at": completed_at,
            "parameters": {
                "thinking": "enabled",
                "reasoning_effort": "high",
                "max_tokens": 16384,
            },
            "usage": usage,
            "request_count": 1,
            "completed_requests": 1,
            "failed_requests": 0,
            "requests": [
                {
                    "request_number": 1,
                    "started_at": completed_at,
                    "completed_at": completed_at,
                    "status": "COMPLETED",
                    "http_status": 200,
                    "error_code": None,
                    "response_id": "response-synthetic-one",
                    "returned_model": "deepseek-v4-pro",
                    "system_fingerprint": "fp-synthetic-v1",
                    "usage": usage,
                }
            ],
            "app_version": "1.0.0-alpha.1",
            "controller_version": "1",
            "dsh_version": "0.1.0-rc.6",
            "profile_sha256": "a" * 64,
        }

    @staticmethod
    def failed_runtime_provenance():
        value = AppControllerTests.runtime_provenance()
        value.update(
            {
                "returned_model": None,
                "system_fingerprint": None,
                "response_id": None,
                "completed_at": None,
                "usage": {},
                "completed_requests": 0,
                "failed_requests": 1,
                "requests": [
                    {
                        "request_number": 1,
                        "started_at": "2026-08-14T00:00:00Z",
                        "completed_at": "2026-08-14T00:00:01Z",
                        "status": "FAILED",
                        "http_status": 503,
                        "error_code": "UPSTREAM_UNAVAILABLE",
                        "response_id": None,
                        "returned_model": None,
                        "system_fingerprint": None,
                        "usage": {},
                    }
                ],
            }
        )
        return value

    def open_review(self, project, run_id, machine_direction="PASS"):
        run = self.read_json(
            project / "creative-system" / "runs" / run_id / "run.json"
        )
        dispatch = (
            project
            / "creative-system"
            / "runs"
            / run_id
            / "attempts"
            / run["current_attempt"]
            / "dispatches"
            / f"dispatch-{run_id}"
        )
        arguments = [
            "open-human-review",
            project,
            "--run-id",
            run_id,
            "--machine-direction",
            machine_direction,
        ]
        if dispatch.is_dir():
            arguments.extend(["--dispatch-id", f"dispatch-{run_id}"])
        return self.command(*arguments)

    def test_progressive_bootstrap_allows_work_without_faking_charter_confirmation(self):
        project, initialized = self.bootstrap()
        system = self.read_json(project / "creative-system/system.json")
        self.assertFalse(system["charter"]["confirmed"])
        self.assertEqual(system["onboarding"]["state"], "BOOTSTRAP")
        self.assertEqual(system["learning_policy"]["independence_unit"], "work")
        self.assertEqual(initialized["provable_maturity"], "NONE")

        begun, _ = self.begin_with_artifact(project)
        self.assertEqual(begun["work_id"], "work-one")
        self.assertEqual(begun["provable_maturity_at_start"], "NONE")
        audit = self.command("audit", project)
        self.assertEqual(audit["provable_maturity"], "NONE")
        self.assertEqual(audit["status"], "NEEDS_TASTE")

    def test_initial_intent_is_exact_and_tamper_evident(self):
        project, initialized = self.bootstrap()
        receipt_path = project / initialized["initial_intent_receipt"]
        receipt = self.read_json(receipt_path)
        self.assertEqual(receipt["intent"], "写克制的近未来悬疑故事")
        self.assertEqual(receipt["authority"], "direct-user-input")
        receipt["intent"] = "被改写的意图"
        self.write_json(receipt_path, receipt)

        validation = self.command("validate", project, expected=1)
        self.assertTrue(
            any("InitialIntentReceipt" in error for error in validation["errors"])
        )
        with self.assertRaises(Exception) as caught:
            self.request(
                "begin_work",
                {
                    "project": str(project),
                    "run_id": "run-one",
                    "work_id": "work-one",
                    "task": "创作任务",
                },
            )
        self.assertIn("项目合同未通过", str(caught.exception))

    def test_complete_work_freezes_exact_output_and_snapshot_restores_it(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-one",
                "work_id": "work-one",
                "task": "创作第一个完整故事",
            },
        )
        payload = {
            "project": str(project),
            "run_id": "run-one",
            "output": "# 第一个版本\n\n风停以后，屋顶上的天线仍在轻响。",
            "runtime_provenance": self.runtime_provenance(),
        }
        first = self.request("complete_work", payload)
        second = self.request("complete_work", payload)
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(first["attempt_id"], begun["attempt_id"])
        self.assertEqual(
            (project / first["artifact"]).read_text(encoding="utf-8"),
            payload["output"],
        )
        provenance = self.read_json(project / first["runtime_provenance"])
        self.assertEqual(provenance["authority"], "main-observed-model-gateway")
        self.assertFalse(provenance["reasoning_content_persisted"])

        snapshot = self.request("system_snapshot", {"project": str(project)})
        self.assertEqual(snapshot["last_work"]["output"], payload["output"])
        self.assertFalse(snapshot["last_work"]["sealed"])
        self.assertEqual(
            snapshot["last_work"]["review_available_at"],
            first["review_available_at"],
        )
        self.assertEqual(
            snapshot["last_work"]["runtime_provenance_sha256"],
            first["runtime_provenance_sha256"],
        )
        self.assertEqual(
            snapshot["last_work"]["review_subject_sha256"],
            load_controller().sha256_file(project / first["review_subject"]),
        )

        changed = dict(payload)
        changed["output"] = "试图覆盖的另一个版本"
        with self.assertRaises(AppRequestError) as caught:
            self.request("complete_work", changed)
        self.assertIn("拒绝覆盖", str(caught.exception))

    def test_snapshot_never_exposes_unbound_artifact_as_saved_work(self):
        project, _ = self.bootstrap()
        self.begin_with_artifact(project)

        snapshot = self.request("system_snapshot", {"project": str(project)})
        self.assertIsNone(snapshot["last_work"])
        self.assertTrue(snapshot["recovery_required"])
        self.assertEqual(snapshot["interrupted_run"]["run_id"], "run-one")
        self.assertEqual(
            snapshot["interrupted_run"]["state"], "REVIEW_BINDING_REQUIRED"
        )
        self.assertEqual(
            snapshot["interrupted_run"]["reason_code"], "UNBOUND_ARTIFACT"
        )

    def test_complete_work_rejects_unfixed_model_policy_and_hidden_reasoning(self):
        project, _ = self.bootstrap()
        self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-one",
                "work_id": "work-one",
                "task": "创作任务",
            },
        )
        provenance = self.runtime_provenance()
        provenance["parameters"] = dict(provenance["parameters"])
        provenance["parameters"]["reasoning_effort"] = "max"
        with self.assertRaises(AppRequestError) as caught:
            self.request(
                "complete_work",
                {
                    "project": str(project),
                    "run_id": "run-one",
                    "output": "作品",
                    "runtime_provenance": provenance,
                },
            )
        self.assertIn("固定模型策略", str(caught.exception))

        hidden = self.runtime_provenance()
        hidden["reasoning_content"] = "不得进入证据层"
        with self.assertRaises(AppRequestError) as caught:
            self.request(
                "complete_work",
                {
                    "project": str(project),
                    "run_id": "run-one",
                    "output": "作品",
                    "runtime_provenance": hidden,
                },
            )
        self.assertIn("不允许字段", str(caught.exception))

    def test_cancel_work_records_zero_file_stall_and_allows_local_redispatch(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-one",
                "work_id": "work-one",
                "task": "创作任务",
                "dispatch_id": "dispatch-first",
                "context_id": "context-first",
            },
        )
        payload = {
            "project": str(project),
            "run_id": "run-one",
            "dispatch_id": begun["dispatch_id"],
            "reason": "user-cancelled-before-output",
        }
        first = self.request("cancel_work", payload)
        second = self.request("cancel_work", payload)
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(first["reason_code"], "ZERO_FILE_DISPATCH_STALL")

        resumed = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-one",
                "work_id": "work-one",
                "task": "创作任务",
                "dispatch_id": "dispatch-second",
                "context_id": "context-second",
            },
        )
        self.assertTrue(resumed["idempotent_run"])
        self.assertFalse(resumed["idempotent_dispatch"])
        self.assertEqual(resumed["dispatch_id"], "dispatch-second")

    def test_snapshot_keeps_sealed_a_when_newer_b_is_cancelled(self):
        project, _ = self.bootstrap()
        _, artifact_a = self.begin_with_artifact(
            project, run_id="run-a", work_id="work-a"
        )
        review = self.open_review(project, "run-a", machine_direction="UNKNOWN")
        feedback = self.request(
            "record_feedback",
            {
                "project": str(project),
                "run_id": "run-a",
                "event_id": "keep-a",
                "action": "keep",
                "feedback_at": review["review_available_at"],
            },
        )
        sealed = self.request(
            "seal_feedback",
            {
                "project": str(project),
                "feedback_receipt": feedback["receipt"],
                "machine_direction": "UNKNOWN",
            },
        )
        manifest = self.read_json(project / sealed["manifest"])
        self.assertEqual(manifest["quality_status"], "NOT_EVALUATED")
        self.assertTrue(manifest["human_accepted"])

        begun_b = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-b",
                "work_id": "work-b",
                "task": "第二个作品",
            },
        )
        self.request(
            "cancel_work",
            {
                "project": str(project),
                "run_id": "run-b",
                "dispatch_id": begun_b["dispatch_id"],
                "reason": "user-cancelled-before-output",
                "runtime_provenance": self.failed_runtime_provenance(),
            },
        )

        snapshot = self.request("system_snapshot", {"project": str(project)})
        self.assertEqual(snapshot["last_work"]["run_id"], "run-a")
        self.assertEqual(
            snapshot["last_work"]["output"], artifact_a.read_text(encoding="utf-8")
        )
        self.assertTrue(snapshot["last_work"]["sealed"])
        self.assertTrue(snapshot["recovery_required"])
        self.assertEqual(snapshot["interrupted_run"]["run_id"], "run-b")
        provenance = self.read_json(
            project
            / "creative-system/runs/run-b/attempts/attempt-001"
            / f"runtime-provenance-{begun_b['dispatch_id']}.json"
        )
        self.assertEqual(provenance["failed_requests"], 1)
        self.assertEqual(provenance["requests"][0]["error_code"], "UPSTREAM_UNAVAILABLE")

    def test_sensitive_credential_fields_never_enter_controller(self):
        project = self.root / "must-not-exist"
        with self.assertRaises(AppRequestError) as caught:
            self.request(
                "bootstrap_intent",
                {
                    "project": str(project),
                    "system_id": "quiet-mystery",
                    "display_name": "克制悬疑创作系统",
                    "intent": "写故事",
                    "api_key": "synthetic-credential-value",
                },
            )
        self.assertIn("不允许进入 Python Controller", str(caught.exception))
        self.assertFalse(project.exists())

    def test_json_sidecar_returns_one_sanitized_error_document(self):
        project = self.root / "must-not-exist-sidecar"
        synthetic_value = "synthetic-credential-value"
        request = {
            "protocol_version": "1",
            "request_id": "sidecar-one",
            "operation": "bootstrap_intent",
            "payload": {
                "project": str(project),
                "system_id": "quiet-mystery",
                "display_name": "克制悬疑创作系统",
                "intent": "写故事",
                "api_key": synthetic_value,
            },
        }
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PYTHONPATH"] = str(PYTHON_ROOT)
        result = subprocess.run(
            [sys.executable, "-m", "creative_loop2rsi"],
            cwd=str(REPO),
            env=environment,
            input=json.dumps(request, ensure_ascii=False),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, "")
        response = json.loads(result.stdout)
        self.assertEqual(response["status"], "BLOCK")
        self.assertEqual(response["request_id"], "sidecar-one")
        self.assertNotIn(synthetic_value, result.stdout)
        self.assertFalse(project.exists())

    def test_feedback_binds_frozen_subject_and_is_idempotent(self):
        project, _ = self.bootstrap()
        _, artifact = self.begin_with_artifact(project)
        original = artifact.read_bytes()
        review = self.open_review(project, "run-one")
        payload = {
            "project": str(project),
            "run_id": "run-one",
            "event_id": "feedback-one",
            "action": "keep",
            "feedback_at": review["review_available_at"],
        }
        first = self.request("record_feedback", payload)
        second = self.request("record_feedback", payload)
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(first["receipt"], second["receipt"])
        self.assertEqual(artifact.read_bytes(), original)

        changed = dict(payload)
        changed["action"] = "reject"
        changed["feedback_text"] = "不接受这个版本"
        with self.assertRaises(AppRequestError) as caught:
            self.request("record_feedback", changed)
        self.assertIn("同一 event_id", str(caught.exception))

    def test_feedback_retry_recovers_receipt_ahead_of_event_index(self):
        project, _ = self.bootstrap()
        self.begin_with_artifact(project)
        review = self.open_review(project, "run-one")
        payload = {
            "project": str(project),
            "run_id": "run-one",
            "event_id": "crash-recovery",
            "action": "keep",
            "feedback_at": review["review_available_at"],
        }
        core = load_controller()
        original = core.atomic_create_json

        def fail_event_index(path, value):
            if "/app-feedback/events/" in Path(path).as_posix():
                raise RuntimeError("synthetic event-index crash")
            return original(path, value)

        with mock.patch.object(core, "atomic_create_json", side_effect=fail_event_index):
            with self.assertRaisesRegex(RuntimeError, "synthetic event-index crash"):
                self.request("record_feedback", payload)
        receipts = list(
            (project / "creative-system/approvals/app-feedback").glob("receipt-*.json")
        )
        self.assertEqual(len(receipts), 1)
        recovered = self.request("record_feedback", payload)
        self.assertFalse(recovered["idempotent"])
        self.assertEqual(project / recovered["receipt"], receipts[0])

    def test_edit_feedback_preserves_producer_artifact_and_seals_receipt(self):
        project, _ = self.bootstrap()
        _, artifact = self.begin_with_artifact(project)
        original = artifact.read_bytes()
        review = self.open_review(project, "run-one", machine_direction="BLOCK")
        feedback = self.request(
            "record_feedback",
            {
                "project": str(project),
                "run_id": "run-one",
                "event_id": "edit-one",
                "action": "edit",
                "feedback_at": review["review_available_at"],
                "edited_text": "这是用户直接修改后的版本。",
                "feedback_text": "减少解释，保留动作。",
            },
        )
        self.assertEqual(artifact.read_bytes(), original)
        sealed = self.request(
            "seal_feedback",
            {
                "project": str(project),
                "feedback_receipt": feedback["receipt"],
                "machine_direction": "BLOCK",
            },
        )
        self.assertEqual(sealed["status"], "PASS")
        manifest = self.read_json(project / sealed["manifest"])
        self.assertFalse(manifest["human_accepted"])
        self.assertEqual(manifest["human_direction"], "BLOCK")
        self.assertEqual(manifest["work_id"], "work-one")
        repeated_feedback = self.request(
            "record_feedback",
            {
                "project": str(project),
                "run_id": "run-one",
                "event_id": "edit-one",
                "action": "edit",
                "feedback_at": review["review_available_at"],
                "edited_text": "这是用户直接修改后的版本。",
                "feedback_text": "减少解释，保留动作。",
            },
        )
        self.assertTrue(repeated_feedback["idempotent"])
        repeated_seal = self.request(
            "seal_feedback",
            {
                "project": str(project),
                "feedback_receipt": feedback["receipt"],
                "machine_direction": "BLOCK",
            },
        )
        self.assertTrue(repeated_seal["idempotent"])
        receipt = self.read_json(project / feedback["receipt"])
        revision = receipt["user_revision"]
        self.assertEqual(
            (project / revision["path"]).read_text(encoding="utf-8"),
            "这是用户直接修改后的版本。",
        )
        self.assertEqual(
            revision["sha256"],
            load_controller().sha256_file(project / revision["path"]),
        )
        restarted = self.request("system_snapshot", {"project": str(project)})
        self.assertEqual(
            restarted["last_work"]["output"], "这是用户直接修改后的版本。"
        )
        self.assertEqual(restarted["last_work"]["artifact_kind"], "user-revision")
        self.assertEqual(artifact.read_bytes(), original)

    def test_submit_feedback_rolls_forward_after_record_crash_and_blocks_drift(self):
        project, _ = self.bootstrap()
        self.begin_with_artifact(project)
        review = self.open_review(project, "run-one", machine_direction="BLOCK")
        payload = {
            "project": str(project),
            "run_id": "run-one",
            "action": "edit",
            "feedback_at": review["review_available_at"],
            "feedback_text": "保留动作，减少解释。",
            "edited_text": "用户修订后的精确文本\n第二行。",
            "machine_direction": "BLOCK",
        }
        with mock.patch.object(
            app_service, "_seal_feedback", side_effect=RuntimeError("synthetic seal crash")
        ):
            with self.assertRaisesRegex(RuntimeError, "synthetic seal crash"):
                self.request("submit_feedback", payload)

        pending = self.request("system_snapshot", {"project": str(project)})
        self.assertTrue(pending["feedback_recovery_required"])
        self.assertEqual(pending["pending_feedback"]["action"], "edit")
        changed = dict(payload)
        changed["action"] = "keep"
        changed.pop("edited_text")
        changed.pop("feedback_text")
        with self.assertRaises(AppRequestError) as caught:
            self.request("submit_feedback", changed)
        self.assertIn("拒绝提交不同 action", str(caught.exception))

        recorded_path = (
            project
            / "creative-system/approvals/app-feedback/transactions"
            / "run-one/attempt-001/recorded.json"
        )
        original_recorded = recorded_path.read_bytes()
        damaged_recorded = self.read_json(recorded_path)
        damaged_recorded["receipt_sha256"] = "0" * 64
        self.write_json(recorded_path, damaged_recorded)
        with self.assertRaises(AppRequestError) as caught:
            self.request(
                "resume_feedback", {"project": str(project), "run_id": "run-one"}
            )
        self.assertIn("recorded", str(caught.exception))
        recorded_path.write_bytes(original_recorded)

        recovered = self.request(
            "resume_feedback", {"project": str(project), "run_id": "run-one"}
        )
        self.assertEqual(recovered["resume_status"], "RECOVERED")
        self.assertFalse(recovered["idempotent"])
        self.assertEqual(
            recovered["snapshot"]["last_work"]["output"], payload["edited_text"]
        )
        self.assertFalse(recovered["snapshot"]["feedback_recovery_required"])
        repeated = self.request(
            "resume_feedback", {"project": str(project), "run_id": "run-one"}
        )
        self.assertEqual(repeated["resume_status"], "ALREADY_COMMITTED")
        self.assertTrue(repeated["idempotent"])
        receipts = list(
            (project / "creative-system/approvals/app-feedback").glob("receipt-*.json")
        )
        self.assertEqual(len(receipts), 1)

    def test_resume_feedback_uses_intent_only_and_distinguishes_no_transaction(self):
        project, _ = self.bootstrap()
        self.begin_with_artifact(project)
        review = self.open_review(project, "run-one", machine_direction="BLOCK")
        empty = self.request(
            "resume_feedback", {"project": str(project), "run_id": "run-one"}
        )
        self.assertEqual(
            set(empty),
            {
                "attempt_id",
                "idempotent",
                "manifest",
                "manifest_sha256",
                "operation",
                "protocol_version",
                "receipt",
                "receipt_sha256",
                "request_id",
                "resume_status",
                "run_id",
                "snapshot",
                "status",
                "submission_id",
            },
        )
        self.assertEqual(empty["resume_status"], "NO_TRANSACTION")
        self.assertTrue(empty["idempotent"])
        for key in (
            "submission_id",
            "attempt_id",
            "receipt",
            "receipt_sha256",
            "manifest",
            "manifest_sha256",
        ):
            self.assertIsNone(empty[key])

        feedback = {
            "project": str(project),
            "run_id": "run-one",
            "action": "rewrite",
            "feedback_at": review["review_available_at"],
            "feedback_text": "删掉解释，让人物用选择推进情节。",
            "machine_direction": "BLOCK",
        }
        with mock.patch.object(
            app_service,
            "_record_feedback",
            side_effect=RuntimeError("synthetic record crash"),
        ):
            with self.assertRaisesRegex(RuntimeError, "synthetic record crash"):
                self.request("submit_feedback", feedback)

        with self.assertRaises(AppRequestError) as caught:
            self.request(
                "resume_feedback",
                {
                    "project": str(project),
                    "run_id": "run-one",
                    "feedback_text": feedback["feedback_text"],
                },
            )
        self.assertIn("不允许字段", str(caught.exception))
        recovered = self.request(
            "resume_feedback", {"project": str(project), "run_id": "run-one"}
        )
        self.assertEqual(recovered["resume_status"], "RECOVERED")
        self.assertEqual(recovered["run_id"], "run-one")
        self.assertFalse(recovered["idempotent"])
        repeated = self.request(
            "resume_feedback", {"project": str(project), "run_id": "run-one"}
        )
        self.assertEqual(repeated["resume_status"], "ALREADY_COMMITTED")
        self.assertTrue(repeated["idempotent"])

    def test_resume_feedback_fails_closed_on_damaged_intent(self):
        project, _ = self.bootstrap()
        self.begin_with_artifact(project)
        review = self.open_review(project, "run-one", machine_direction="BLOCK")
        feedback = {
            "project": str(project),
            "run_id": "run-one",
            "action": "reject",
            "feedback_at": review["review_available_at"],
            "feedback_text": "这个版本不成立。",
            "machine_direction": "BLOCK",
        }
        with mock.patch.object(
            app_service,
            "_record_feedback",
            side_effect=RuntimeError("synthetic record crash"),
        ):
            with self.assertRaisesRegex(RuntimeError, "synthetic record crash"):
                self.request("submit_feedback", feedback)
        intent_path = (
            project
            / "creative-system/approvals/app-feedback/transactions"
            / "run-one/attempt-001/intent.json"
        )
        intent = self.read_json(intent_path)
        intent["semantic"]["feedback_text"] = "被篡改的反馈"
        self.write_json(intent_path, intent)

        with self.assertRaises(AppRequestError) as caught:
            self.request(
                "resume_feedback", {"project": str(project), "run_id": "run-one"}
            )
        self.assertIn("漂移", str(caught.exception))
        self.assertFalse((intent_path.parent / "committed.json").exists())

    def test_each_work_task_receipt_binds_exact_multiline_input_and_context(self):
        project, _ = self.bootstrap()
        first_snapshot = self.request("system_snapshot", {"project": str(project)})
        task_one = "第一个作品\n必须保留这一行。"
        first = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-first",
                "work_id": "work-first",
                "task": task_one,
                "context_sha256": first_snapshot["initial_intent_sha256"],
            },
        )
        task_two = "第二个作品\n与第一个不同。"
        second = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-second",
                "work_id": "work-second",
                "task": task_two,
                "context_sha256": first_snapshot["initial_intent_sha256"],
            },
        )
        first_receipt = self.read_json(project / first["task_receipt"])
        second_receipt = self.read_json(project / second["task_receipt"])
        self.assertEqual(first_receipt["task"], task_one)
        self.assertEqual(second_receipt["task"], task_two)
        self.assertEqual(
            first_receipt["context_sha256"], first_snapshot["initial_intent_sha256"]
        )
        first_run = self.read_json(
            project / "creative-system/runs/run-first/run.json"
        )
        self.assertEqual(first_run["task"], first_receipt["task_reference"])
        self.assertNotIn(task_one, json.dumps(first_run, ensure_ascii=False))
        restarted = self.request("system_snapshot", {"project": str(project)})
        self.assertEqual(restarted["initial_intent"], first_snapshot["initial_intent"])
        self.assertEqual(
            restarted["initial_intent_sha256"],
            first_snapshot["initial_intent_sha256"],
        )

    def test_feedback_requires_review_and_valid_action_payload(self):
        project, _ = self.bootstrap()
        self.begin_with_artifact(project)
        with self.assertRaises(Exception) as caught:
            self.request(
                "record_feedback",
                {
                    "project": str(project),
                    "run_id": "run-one",
                    "event_id": "feedback-one",
                    "action": "keep",
                    "feedback_at": "2026-08-14T00:00:00Z",
                },
            )
        self.assertIn("open-human-review", str(caught.exception))

        self.open_review(project, "run-one")
        with self.assertRaises(AppRequestError):
            self.request(
                "record_feedback",
                {
                    "project": str(project),
                    "run_id": "run-one",
                    "event_id": "edit-without-content",
                    "action": "edit",
                    "feedback_at": "2026-08-14T00:00:00Z",
                },
            )

    def test_progressive_candidate_requires_three_distinct_works_not_three_runs(self):
        project, _ = self.bootstrap()
        finding = self.root / "repeated-finding.json"
        self.write_json(
            finding,
            {
                "code": "SCAFFOLD.RECOVERY",
                "category": "runtime",
                "severity": "medium",
                "confidence": 0.8,
                "evidence": [{"path": "artifacts/work.md", "note": "恢复提示重复"}],
                "owner": "improvement-controller",
                "suggested_action": "研究恢复策略候选",
            },
        )
        for number in range(1, 4):
            run_id = f"same-work-run-{number}"
            begun = self.request(
                "begin_work",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "work_id": "same-work",
                    "task": f"同一作品的第 {number} 次任务",
                },
            )
            (project / begun["allowed_writes_root"] / "work.md").write_text(
                f"同一虚构作品版本 {number}\n", encoding="utf-8"
            )
            review = self.open_review(project, run_id)
            feedback = self.request(
                "record_feedback",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "event_id": f"same-work-feedback-{number}",
                    "action": "keep",
                    "feedback_at": review["review_available_at"],
                },
            )
            self.request(
                "seal_feedback",
                {
                    "project": str(project),
                    "feedback_receipt": feedback["receipt"],
                    "machine_direction": "PASS",
                    "quality_status": "PASS",
                    "finding_paths": [str(finding)],
                },
            )

        with self.assertRaises(Exception) as caught:
            self.request(
                "create_system_lab_candidate",
                {
                    "project": str(project),
                    "candidate_id": "too-narrow",
                    "finding_code": "SCAFFOLD.RECOVERY",
                    "root_cause": "恢复策略可能需要调整",
                    "target_component": "app-scaffold",
                    "change_summary": "生成候选",
                    "changed_paths": ["system-lab/too-narrow.patch"],
                    "builder_role_id": "candidate-builder",
                    "builder_context_id": "builder-context",
                    "builder_task_id": "builder-task",
                    "builder_attested_by": "test-orchestrator",
                },
            )
        self.assertIn("作品=1", str(caught.exception))

    def confirmed_project(self):
        project = self.root / "confirmed-project"
        self.command(
            "init",
            project,
            "--project-name",
            "纸灯故事实验",
            "--creative-goal",
            "创作虚构短篇",
            "--minimum-product",
            "一篇完整短篇",
            "--representative-task",
            "写一个关于旧车站的故事",
            "--constraints",
            "不得使用真实个人信息",
            "--taste",
            "喜欢动作细节",
            "--domain-skill",
            "paper-lantern-story",
        )
        evidence = (
            project
            / "creative-system/approvals/charter-confirmations/evidence/confirmation.md"
        )
        evidence.write_text("测试项目所有者确认虚构创作宪法。\n", encoding="utf-8")
        self.command(
            "confirm-charter",
            project,
            "--confirmed-by",
            "test-owner",
            "--confirmed-at",
            "2000-01-01T00:00:00Z",
            "--evidence",
            evidence.relative_to(project),
        )
        return project

    def test_legacy_begin_run_shape_stays_unchanged_without_work_id(self):
        project = self.confirmed_project()
        begun = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "旧 CLI 代表任务",
            "--run-id",
            "legacy-run",
        )
        run = self.read_json(
            project / "creative-system/runs/legacy-run/run.json"
        )
        attempt = self.read_json(project / begun["attempt_path"] / "attempt.json")
        self.assertNotIn("work_id", run)
        self.assertNotIn("work_id", attempt)

    def seal_finding_run(self, project, number, finding):
        run_id = f"run-{number}"
        work_id = f"work-{number}"
        begun = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            f"独立任务 {number}",
            "--work-id",
            work_id,
            "--run-id",
            run_id,
        )
        attempt = project / begun["attempt_path"]
        (attempt / "artifacts/work.md").write_text(
            f"虚构作品 {number}\n", encoding="utf-8"
        )
        review = self.open_review(project, run_id)
        evidence = project / f"creative-system/approvals/attempt-feedback/{run_id}.md"
        evidence.write_text("测试项目所有者保留该虚构样本。\n", encoding="utf-8")
        self.command(
            "seal-attempt",
            project,
            "--run-id",
            run_id,
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--finding",
            finding,
            "--human-accepted",
            "true",
            "--machine-direction",
            "PASS",
            "--human-direction",
            "PASS",
            "--human-feedback-by",
            "test-owner",
            "--human-feedback-at",
            review["review_available_at"],
            "--human-feedback-evidence",
            evidence.relative_to(project),
        )

    def test_system_lab_candidate_is_candidate_only_and_never_promotable(self):
        project = self.confirmed_project()
        finding = self.root / "finding.json"
        self.write_json(
            finding,
            {
                "code": "SCAFFOLD.RECOVERY",
                "category": "runtime",
                "severity": "medium",
                "confidence": 0.8,
                "evidence": [{"path": "artifacts/work.md", "note": "恢复提示重复"}],
                "owner": "improvement-controller",
                "suggested_action": "研究声明式恢复策略候选",
            },
        )
        for number in range(1, 4):
            self.seal_finding_run(project, number, finding)

        created = self.request(
            "create_system_lab_candidate",
            {
                "project": str(project),
                "candidate_id": "scaffold-recovery",
                "finding_code": "SCAFFOLD.RECOVERY",
                "root_cause": "恢复策略可能没有区分可重试错误与内容问题",
                "target_component": "app-scaffold",
                "change_summary": "只生成供维护者审查的声明式恢复候选",
                "changed_paths": ["system-lab/scaffold-recovery.patch"],
                "builder_role_id": "candidate-builder",
                "builder_context_id": "builder-context",
                "builder_task_id": "builder-task",
                "builder_attested_by": "test-orchestrator",
            },
        )
        self.assertEqual(created["candidate_class"], "CANDIDATE_ONLY")
        self.assertFalse(created["code_execution_allowed"])
        status = self.read_json(
            project / "creative-system/candidates/scaffold-recovery/status.json"
        )
        self.assertEqual(status["candidate_class"], "CANDIDATE_ONLY")
        self.assertFalse(status["code_execution_allowed"])
        summary = self.request(
            "candidate_summary",
            {
                "project": str(project),
                "candidate_id": "scaffold-recovery",
            },
        )
        self.assertEqual(summary["candidate_class"], "CANDIDATE_ONLY")

        evaluation = project / "creative-system/evals/development/never-promote.json"
        self.write_json(evaluation, {})
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "scaffold-recovery",
            "--evaluation",
            evaluation,
            "--approved-by",
            "test-owner",
            expected=2,
        )
        self.assertIn("永不自动晋升", blocked["error"])


if __name__ == "__main__":
    unittest.main()
