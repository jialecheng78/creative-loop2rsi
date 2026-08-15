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

    @staticmethod
    def tree_hashes(root):
        root = Path(root)
        return {
            path.relative_to(root).as_posix(): hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
            for path in sorted(root.rglob("*"))
            if path.is_file() and not path.is_symlink()
        }

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
    def runtime_provenance(
        *,
        completed_at="2026-08-14T00:00:00Z",
        context_sha256=None,
        model="deepseek-v4-pro",
        fingerprint="fp-synthetic-v1",
        response_id="response-synthetic-one",
    ):
        usage = {
            "prompt_tokens": 120,
            "completion_tokens": 300,
            "total_tokens": 420,
        }
        return {
            "context_sha256": context_sha256
            or hashlib.sha256("写克制的近未来悬疑故事".encode("utf-8")).hexdigest(),
            "requested_model": model,
            "returned_model": model,
            "system_fingerprint": fingerprint,
            "response_id": response_id,
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
                    "response_id": response_id,
                    "returned_model": model,
                    "system_fingerprint": fingerprint,
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

    def test_terminate_work_commits_zero_file_terminal_state_idempotently(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-failed",
                "work_id": "work-failed",
                "task": "不会完成的创作任务",
                "dispatch_id": "dispatch-failed",
                "context_id": "context-failed",
            },
        )
        payload = {
            "project": str(project),
            "run_id": "run-failed",
            "dispatch_id": begun["dispatch_id"],
            "outcome": "FAILED",
            "reason": "runtime-failed-before-commit",
            "error_code": "UPSTREAM_UNAVAILABLE",
            "runtime_provenance": self.failed_runtime_provenance(),
        }
        first = self.request("terminate_work", payload)
        second = self.request("terminate_work", payload)
        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertFalse(first["content_attempt_consumed"])
        self.assertFalse(first["finding_eligible"])

        run_root = project / "creative-system/runs/run-failed"
        run = self.read_json(run_root / "run.json")
        attempt = self.read_json(
            run_root / "attempts/attempt-001/attempt.json"
        )
        dispatch = self.read_json(
            run_root
            / "attempts/attempt-001/dispatches/dispatch-failed/dispatch.json"
        )
        receipt = self.read_json(project / first["terminal_receipt"])
        self.assertEqual(run["execution_status"], "BLOCK")
        self.assertIsNone(run["current_attempt"])
        self.assertEqual(run["last_decision"], "stop")
        self.assertEqual(run["terminated_attempts"], ["attempt-001"])
        self.assertEqual(run["attempts"], [])
        self.assertEqual(attempt["execution_status"], "RUNNING")
        self.assertEqual(dispatch["state"], "OPEN")
        self.assertEqual(receipt["kind"], "TerminatedAttempt")
        self.assertEqual(receipt["termination_class"], "ZERO_FILE_RUNTIME_FAILURE")
        self.assertEqual(receipt["error_code"], "UPSTREAM_UNAVAILABLE")

        system = self.read_json(project / "creative-system/system.json")
        self.assertEqual(system["statuses"]["execution_status"], "BLOCK")
        snapshot = self.request("system_snapshot", {"project": str(project)})
        self.assertIsNone(snapshot["last_work"])
        self.assertTrue(snapshot["recovery_required"])
        self.assertEqual(
            snapshot["interrupted_run"]["state"], "TERMINATED_FAILED"
        )
        self.assertEqual(
            snapshot["interrupted_run"]["reason_code"], "UPSTREAM_UNAVAILABLE"
        )
        self.assertEqual(snapshot["interrupted_run"]["outcome"], "FAILED")
        self.assertEqual(
            snapshot["interrupted_run"]["execution_status"], "BLOCK"
        )
        self.assertEqual(
            snapshot["interrupted_run"]["termination_class"],
            "ZERO_FILE_RUNTIME_FAILURE",
        )
        self.assertEqual(
            snapshot["interrupted_run"]["terminal_receipt"],
            first["terminal_receipt"],
        )
        self.assertEqual(
            snapshot["interrupted_run"]["terminal_receipt_sha256"],
            first["terminal_receipt_sha256"],
        )
        self.assertFalse(snapshot["interrupted_run"]["content_attempt_consumed"])
        self.assertFalse(snapshot["interrupted_run"]["finding_eligible"])

        with self.assertRaises(AppRequestError):
            self.request(
                "begin_work",
                {
                    "project": str(project),
                    "run_id": "run-failed",
                    "work_id": "work-failed",
                    "task": "不会完成的创作任务",
                    "dispatch_id": "dispatch-reopen",
                    "context_id": "context-reopen",
                },
            )
        successor = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-successor",
                "work_id": "work-successor",
                "task": "重新生成",
                "recovery_of": "run-failed",
            },
        )
        self.assertEqual(successor["run_id"], "run-successor")
        self.request("system_snapshot", {"project": str(project)})
        system_after_successor = self.read_json(
            project / "creative-system/system.json"
        )
        self.assertEqual(
            system_after_successor["statuses"]["execution_status"], "RUNNING"
        )
        self.assertEqual(
            load_controller().finding_occurrences(project, "APP-FEEDBACK-NOT-THERE"),
            [],
        )

    def test_terminate_work_rejects_semantic_drift(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-drift",
                "work_id": "work-drift",
                "task": "失败语义不可覆盖",
            },
        )
        payload = {
            "project": str(project),
            "run_id": "run-drift",
            "dispatch_id": begun["dispatch_id"],
            "outcome": "FAILED",
            "reason": "runtime-failed-before-commit",
            "error_code": "UPSTREAM_UNAVAILABLE",
        }
        self.request("terminate_work", payload)
        attempt_dir = (
            project
            / "creative-system/runs/run-drift/attempts/attempt-001"
        )
        before = self.tree_hashes(attempt_dir)
        changed = dict(payload)
        changed["error_code"] = "DEEPSEEK_TOTAL_TIMEOUT"
        changed["runtime_provenance"] = self.failed_runtime_provenance()
        with self.assertRaises(AppRequestError) as caught:
            self.request("terminate_work", changed)
        self.assertIn("不同终止语义", str(caught.exception))
        self.assertEqual(self.tree_hashes(attempt_dir), before)
        self.assertFalse(
            (attempt_dir / f"runtime-provenance-{begun['dispatch_id']}.json").exists()
        )

    def test_system_snapshot_rolls_forward_after_terminal_marker_crash(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-crashed-terminal",
                "work_id": "work-crashed-terminal",
                "task": "终态投影崩溃恢复",
            },
        )
        original = app_service._apply_termination_run_projection_locked
        calls = 0

        def crash_once(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("injected crash after terminal marker")
            return original(*args, **kwargs)

        with mock.patch.object(
            app_service,
            "_apply_termination_run_projection_locked",
            side_effect=crash_once,
        ):
            with self.assertRaises(RuntimeError):
                self.request(
                    "terminate_work",
                    {
                        "project": str(project),
                        "run_id": "run-crashed-terminal",
                        "dispatch_id": begun["dispatch_id"],
                        "outcome": "FAILED",
                        "reason": "runtime-failed-before-commit",
                        "error_code": "UPSTREAM_UNAVAILABLE",
                        "runtime_provenance": self.failed_runtime_provenance(),
                    },
                )
            run_before = self.read_json(
                project / "creative-system/runs/run-crashed-terminal/run.json"
            )
            self.assertEqual(run_before["execution_status"], "RUNNING")
            marker = (
                project
                / "creative-system/runs/run-crashed-terminal/attempts/attempt-001/.terminated.json"
            )
            self.assertTrue(marker.is_file())
            snapshot = self.request("system_snapshot", {"project": str(project)})

        run_after = self.read_json(
            project / "creative-system/runs/run-crashed-terminal/run.json"
        )
        self.assertEqual(run_after["execution_status"], "BLOCK")
        self.assertIsNone(run_after["current_attempt"])
        self.assertEqual(
            snapshot["interrupted_run"]["state"], "TERMINATED_FAILED"
        )
        self.assertEqual(
            snapshot["interrupted_run"]["termination_class"],
            "ZERO_FILE_RUNTIME_FAILURE",
        )
        self.assertFalse(snapshot["interrupted_run"]["content_attempt_consumed"])
        self.assertFalse(snapshot["interrupted_run"]["finding_eligible"])

    def test_terminal_marker_blocks_completion_before_run_projection_recovers(self):
        project, _ = self.bootstrap()
        begun, artifact = self.begin_with_artifact(
            project,
            run_id="run-terminal-commit-point",
            work_id="work-terminal-commit-point",
        )
        with mock.patch.object(
            app_service,
            "_apply_termination_run_projection_locked",
            side_effect=RuntimeError("injected crash after terminal marker"),
        ):
            with self.assertRaisesRegex(RuntimeError, "terminal marker"):
                self.request(
                    "terminate_work",
                    {
                        "project": str(project),
                        "run_id": "run-terminal-commit-point",
                        "dispatch_id": begun["dispatch_id"],
                        "outcome": "FAILED",
                        "reason": "completion-evidence-or-commit-failed",
                        "error_code": "COMMIT_FAILED",
                        "runtime_provenance": self.failed_runtime_provenance(),
                    },
                )

        attempt_dir = (
            project
            / "creative-system/runs/run-terminal-commit-point/attempts/attempt-001"
        )
        marker = attempt_dir / ".terminated.json"
        self.assertTrue(marker.is_file())
        marker_sha256 = hashlib.sha256(marker.read_bytes()).hexdigest()
        run_before = self.read_json(attempt_dir.parent.parent / "run.json")
        self.assertEqual(run_before["execution_status"], "RUNNING")

        source = project / "outputs/terminal-measure-source.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("终止后不得测量\n", encoding="utf-8")
        late_facts = (
            "creative-system/runs/run-terminal-commit-point/attempts/"
            "attempt-001/controller-facts/late.json"
        )
        blocked_measure = self.command(
            "measure-artifact",
            project,
            "--source",
            "outputs/terminal-measure-source.md",
            "--output",
            late_facts,
            expected=2,
        )
        self.assertIn("attempt 已终止", blocked_measure["error"])
        self.assertFalse((project / late_facts).exists())
        self.assertEqual(
            hashlib.sha256(marker.read_bytes()).hexdigest(), marker_sha256
        )

        core = load_controller()
        with self.assertRaises(core.LoopCtlError):
            core.command_open_human_review(
                type(
                    "Args",
                    (),
                    {
                        "project": str(project),
                        "run_id": "run-terminal-commit-point",
                        "dispatch_id": begun["dispatch_id"],
                        "machine_direction": "UNKNOWN",
                    },
                )()
            )
        with self.assertRaises(core.LoopCtlError):
            self.request(
                "complete_work",
                {
                    "project": str(project),
                    "run_id": "run-terminal-commit-point",
                    "dispatch_id": begun["dispatch_id"],
                    "output": artifact.read_text(encoding="utf-8"),
                    "runtime_provenance": self.runtime_provenance(),
                },
            )
        run_after = self.read_json(attempt_dir.parent.parent / "run.json")
        self.assertEqual(run_after["execution_status"], "BLOCK")
        self.assertIsNone(run_after["current_attempt"])
        self.assertFalse((attempt_dir / "human-review/subject.json").exists())
        self.assertFalse((attempt_dir / ".sealed.json").exists())

    def test_terminal_receipt_rejects_late_write_in_any_prior_stalled_dispatch(self):
        project, _ = self.bootstrap()
        first = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-late-prior-dispatch",
                "work_id": "work-late-prior-dispatch",
                "task": "验证旧派发晚写",
                "dispatch_id": "dispatch-first",
                "context_id": "context-first",
            },
        )
        self.request(
            "cancel_work",
            {
                "project": str(project),
                "run_id": "run-late-prior-dispatch",
                "dispatch_id": "dispatch-first",
                "reason": "user-cancelled-before-output",
            },
        )
        second = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-late-prior-dispatch",
                "work_id": "work-late-prior-dispatch",
                "task": "验证旧派发晚写",
                "dispatch_id": "dispatch-second",
                "context_id": "context-second",
            },
        )
        terminal = self.request(
            "terminate_work",
            {
                "project": str(project),
                "run_id": "run-late-prior-dispatch",
                "dispatch_id": second["dispatch_id"],
                "outcome": "FAILED",
                "reason": "runtime-failed-before-commit",
                "error_code": "UPSTREAM_UNAVAILABLE",
                "runtime_provenance": self.failed_runtime_provenance(),
            },
        )
        receipt_path = project / terminal["terminal_receipt"]
        receipt_sha256 = load_controller().sha256_file(receipt_path)
        late = project / first["allowed_writes_root"] / "late.md"
        late.write_text("旧 Worker 在终态后晚到的内容", encoding="utf-8")

        with self.assertRaises(AppRequestError) as caught:
            self.request("system_snapshot", {"project": str(project)})
        self.assertIn("LATE_WRITE_CONTAMINATION", str(caught.exception))
        self.assertEqual(load_controller().sha256_file(receipt_path), receipt_sha256)
        run = self.read_json(
            project / "creative-system/runs/run-late-prior-dispatch/run.json"
        )
        self.assertEqual(run["execution_status"], "BLOCK")

    def test_system_snapshot_repairs_system_projection_after_run_commit(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-system-crash",
                "work_id": "work-system-crash",
                "task": "系统投影崩溃恢复",
            },
        )
        original = app_service._project_system_from_latest_run_locked
        calls = 0

        def crash_once(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("injected crash before system projection")
            return original(*args, **kwargs)

        with mock.patch.object(
            app_service,
            "_project_system_from_latest_run_locked",
            side_effect=crash_once,
        ):
            with self.assertRaises(RuntimeError):
                self.request(
                    "terminate_work",
                    {
                        "project": str(project),
                        "run_id": "run-system-crash",
                        "dispatch_id": begun["dispatch_id"],
                        "outcome": "FAILED",
                        "reason": "runtime-failed-before-commit",
                        "error_code": "UPSTREAM_UNAVAILABLE",
                        "runtime_provenance": self.failed_runtime_provenance(),
                    },
                )
            run = self.read_json(
                project / "creative-system/runs/run-system-crash/run.json"
            )
            system_before = self.read_json(project / "creative-system/system.json")
            self.assertEqual(run["execution_status"], "BLOCK")
            self.assertEqual(
                system_before["statuses"]["execution_status"], "RUNNING"
            )
            self.request("system_snapshot", {"project": str(project)})

        system_after = self.read_json(project / "creative-system/system.json")
        self.assertEqual(system_after["statuses"]["execution_status"], "BLOCK")

    def test_terminate_work_binds_uncommitted_output_without_fake_stall(self):
        project, _ = self.bootstrap()
        begun, _ = self.begin_with_artifact(
            project, run_id="run-uncommitted", work_id="work-uncommitted"
        )
        result = self.request(
            "terminate_work",
            {
                "project": str(project),
                "run_id": "run-uncommitted",
                "dispatch_id": begun["dispatch_id"],
                "outcome": "FAILED",
                "reason": "completion-evidence-or-commit-failed",
                "error_code": "RUNTIME_FAILED",
                "runtime_provenance": self.failed_runtime_provenance(),
            },
        )
        receipt = self.read_json(project / result["terminal_receipt"])
        self.assertEqual(
            receipt["termination_class"], "UNCOMMITTED_OUTPUT_FAILURE"
        )
        self.assertTrue(receipt["content_attempt_consumed"])
        self.assertIsNone(receipt["dispatch_stall"])
        self.assertGreater(len(receipt["artifact_inventory"]), 0)
        stall = (
            project
            / begun["allowed_writes_root"]
        ).parent / "stall.json"
        self.assertFalse(stall.exists())
        snapshot = self.request("system_snapshot", {"project": str(project)})
        self.assertIsNone(snapshot["last_work"])
        self.assertEqual(
            snapshot["interrupted_run"]["state"], "TERMINATED_FAILED"
        )
        self.assertEqual(
            snapshot["interrupted_run"]["termination_class"],
            "UNCOMMITTED_OUTPUT_FAILURE",
        )
        self.assertTrue(snapshot["interrupted_run"]["content_attempt_consumed"])
        self.assertFalse(snapshot["interrupted_run"]["finding_eligible"])
        self.assertEqual(snapshot["interrupted_run"]["outcome"], "FAILED")
        self.assertEqual(
            snapshot["interrupted_run"]["terminal_receipt"],
            result["terminal_receipt"],
        )
        self.assertEqual(
            snapshot["interrupted_run"]["terminal_receipt_sha256"],
            result["terminal_receipt_sha256"],
        )

    def test_snapshot_migrates_legacy_app_stall_to_terminal_receipt(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-legacy-stall",
                "work_id": "work-legacy-stall",
                "task": "旧版失败记录",
            },
        )
        self.request(
            "cancel_work",
            {
                "project": str(project),
                "run_id": "run-legacy-stall",
                "dispatch_id": begun["dispatch_id"],
                "reason": "runtime-failed-before-commit",
                "runtime_provenance": self.failed_runtime_provenance(),
            },
        )
        run_path = project / "creative-system/runs/run-legacy-stall/run.json"
        self.assertEqual(self.read_json(run_path)["execution_status"], "RUNNING")
        snapshot = self.request("system_snapshot", {"project": str(project)})
        run = self.read_json(run_path)
        self.assertEqual(run["execution_status"], "BLOCK")
        self.assertEqual(
            snapshot["interrupted_run"]["state"], "TERMINATED_FAILED"
        )
        self.assertEqual(snapshot["interrupted_run"]["outcome"], "FAILED")
        self.assertEqual(
            snapshot["interrupted_run"]["terminal_receipt"],
            run["terminal_receipt"],
        )
        self.assertEqual(
            snapshot["interrupted_run"]["terminal_receipt_sha256"],
            run["terminal_receipt_sha256"],
        )
        self.assertTrue(
            (
                run_path.parent
                / "attempts/attempt-001/.terminated.json"
            ).is_file()
        )

    def test_legacy_migration_does_not_reuse_an_earlier_timeout_after_success(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-legacy-recovered-timeout",
                "work_id": "work-legacy-recovered-timeout",
                "task": "旧版请求超时后曾成功恢复",
            },
        )
        provenance = self.runtime_provenance()
        completed = dict(provenance["requests"][0])
        completed["request_number"] = 2
        provenance.update(
            {
                "request_count": 2,
                "completed_requests": 1,
                "failed_requests": 1,
                "requests": [
                    {
                        "request_number": 1,
                        "started_at": "2026-08-14T00:00:00Z",
                        "completed_at": "2026-08-14T00:00:01Z",
                        "status": "FAILED",
                        "http_status": 504,
                        "error_code": "DEEPSEEK_FIRST_EVENT_TIMEOUT",
                        "response_id": None,
                        "returned_model": None,
                        "system_fingerprint": None,
                        "usage": {},
                    },
                    completed,
                ],
            }
        )
        self.request(
            "cancel_work",
            {
                "project": str(project),
                "run_id": "run-legacy-recovered-timeout",
                "dispatch_id": begun["dispatch_id"],
                "reason": "runtime-failed-before-commit",
                "runtime_provenance": provenance,
            },
        )
        snapshot = self.request("system_snapshot", {"project": str(project)})
        self.assertEqual(snapshot["interrupted_run"]["outcome"], "FAILED")
        self.assertEqual(
            snapshot["interrupted_run"]["reason_code"], "RUNTIME_FAILED"
        )

    def test_snapshot_preserves_legacy_application_close_as_cancelled(self):
        project, _ = self.bootstrap()
        begun = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "run-legacy-application-close",
                "work_id": "work-legacy-application-close",
                "task": "旧版应用关闭中的任务",
            },
        )
        self.request(
            "cancel_work",
            {
                "project": str(project),
                "run_id": "run-legacy-application-close",
                "dispatch_id": begun["dispatch_id"],
                "reason": "application-closed",
                "runtime_provenance": self.failed_runtime_provenance(),
            },
        )
        snapshot = self.request("system_snapshot", {"project": str(project)})
        self.assertEqual(snapshot["interrupted_run"]["outcome"], "CANCELLED")
        self.assertEqual(
            snapshot["interrupted_run"]["reason_code"], "application-closed"
        )

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

    def test_minimum_app_method_loop_requires_three_works_and_binds_next_work(self):
        project, _ = self.bootstrap()
        feedback_text = "减少解释性句子，让人物通过可见行动推进情节。"
        source_runs = []
        for number in range(1, 4):
            run_id = f"method-run-{number}"
            work_id = f"method-work-{number}"
            task = f"创作第 {number} 个相互独立的近未来悬疑短篇"
            begun = self.request(
                "begin_work",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "work_id": work_id,
                    "task": task,
                },
            )
            completed = self.request(
                "complete_work",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "output": f"第 {number} 个基线作品：人物解释了来龙去脉。",
                    "runtime_provenance": self.runtime_provenance(
                        response_id=f"response-source-{number}"
                    ),
                },
            )
            self.request(
                "submit_feedback",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "action": "rewrite",
                    "feedback_at": completed["review_available_at"],
                    "feedback_text": feedback_text,
                    "machine_direction": "UNKNOWN",
                },
            )
            source_runs.append((run_id, work_id, task, begun))

        snapshot = self.request("system_snapshot", {"project": str(project)})
        ready = [
            item
            for item in snapshot["learning"]["observations"]
            if item["ready_for_candidate"]
        ]
        self.assertEqual(len(ready), 1)
        self.assertEqual(ready[0]["independent_works"], 3)
        self.assertEqual(ready[0]["independent_runs"], 3)
        self.assertEqual(ready[0]["independent_tasks"], 3)

        candidate_id = "method-action-first-v1"
        context = self.request(
            "method_candidate_context",
            {
                "project": str(project),
                "candidate_id": candidate_id,
                "observation_id": ready[0]["id"],
            },
        )
        self.assertFalse(context["heldout_included"])
        self.assertNotIn("heldout_task", context)
        self.assertNotIn("heldout_output", context)
        self.assertEqual(len(context["source_works"]), 3)
        guidance = "优先用人物可见的选择、动作与后果推进情节；仅在动作无法表达必要因果时保留一句解释。"
        created = self.request(
            "create_method_candidate",
            {
                "project": str(project),
                "candidate_id": candidate_id,
                "observation_id": ready[0]["id"],
                "guidance": guidance,
                "builder_role_id": "method-candidate-builder",
                "builder_context_id": "method-builder-context-one",
                "builder_task_id": "method-builder-task-one",
                "builder_attested_by": "local-main-supervisor",
                "builder_provenance": self.runtime_provenance(
                    context_sha256=context["builder_context_sha256"],
                    response_id="response-method-builder",
                ),
            },
        )
        plan = created["evaluation_plan"]
        proposal_path = (
            project
            / "creative-system"
            / "app-methods"
            / "candidates"
            / candidate_id
            / "proposal.json"
        )
        proposal_before = proposal_path.read_bytes()
        proposal = self.read_json(proposal_path)
        expected_source_keys = {
            "artifact_sha256",
            "attempt_id",
            "feedback_receipt",
            "feedback_receipt_sha256",
            "feedback_transaction",
            "feedback_transaction_sha256",
            "manifest",
            "manifest_sha256",
            "method_epoch_sha256",
            "provenance_sha256",
            "run_id",
            "task_receipt",
            "task_receipt_sha256",
            "task_sha256",
            "work_id",
        }
        self.assertEqual(len(proposal["source_works"]), 3)
        for source in proposal["source_works"]:
            self.assertEqual(set(source), expected_source_keys)
            for key in (
                "artifact_sha256",
                "feedback_receipt_sha256",
                "feedback_transaction_sha256",
                "manifest_sha256",
                "method_epoch_sha256",
                "provenance_sha256",
                "task_receipt_sha256",
                "task_sha256",
            ):
                self.assertRegex(source[key], r"^[0-9a-f]{64}$")

        later = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "method-source-run-four",
                "work_id": "method-source-work-four",
                "task": "候选冻结后新增的第四个独立来源作品",
            },
        )
        later_completed = self.request(
            "complete_work",
            {
                "project": str(project),
                "run_id": "method-source-run-four",
                "output": "第四个后到作品：人物仍用解释推进情节。",
                "runtime_provenance": self.runtime_provenance(
                    context_sha256=later["context_sha256"],
                    response_id="response-source-four-after-freeze",
                ),
            },
        )
        self.request(
            "submit_feedback",
            {
                "project": str(project),
                "run_id": "method-source-run-four",
                "action": "rewrite",
                "feedback_at": later_completed["review_available_at"],
                "feedback_text": feedback_text,
                "machine_direction": "UNKNOWN",
            },
        )
        repeated_creation = self.request(
            "create_method_candidate",
            {
                "project": str(project),
                "candidate_id": candidate_id,
                "observation_id": ready[0]["id"],
                "guidance": guidance,
                "builder_role_id": "method-candidate-builder",
                "builder_context_id": "method-builder-context-one",
                "builder_task_id": "method-builder-task-one",
                "builder_attested_by": "local-main-supervisor",
                "builder_provenance": self.runtime_provenance(
                    context_sha256=context["builder_context_sha256"],
                    response_id="response-method-builder",
                ),
            },
        )
        self.assertTrue(repeated_creation["idempotent"])
        self.assertEqual(repeated_creation["evaluation_plan"], plan)
        self.assertEqual(proposal_path.read_bytes(), proposal_before)

        def generation(output, expected_context, suffix):
            return {
                "output": output,
                "runtime_provenance": self.runtime_provenance(
                    context_sha256=expected_context,
                    response_id=f"response-method-{suffix}",
                ),
            }

        staged = self.request(
            "stage_method_comparisons",
            {
                "project": str(project),
                "candidate_id": candidate_id,
                "generations": {
                    "targeted_candidate": generation(
                        "目标候选：她没有解释，只把停用的门卡递给警卫。",
                        plan["targeted"]["candidate_context_sha256"],
                        "targeted",
                    ),
                    "regression_candidate": generation(
                        "回归候选：他关掉广播，亲手撕掉了通行名单。",
                        plan["regression"]["candidate_context_sha256"],
                        "regression",
                    ),
                    "heldout_baseline": generation(
                        "留出基线：人物说明自己为什么必须离开。",
                        plan["heldout"]["baseline_context_sha256"],
                        "heldout-baseline",
                    ),
                    "heldout_candidate": generation(
                        "留出候选：她把最后一张返程票塞进陌生人的口袋。",
                        plan["heldout"]["candidate_context_sha256"],
                        "heldout-candidate",
                    ),
                },
            },
        )
        self.assertEqual(staged["lifecycle"], "EVALUATING")
        with self.assertRaises(AppRequestError):
            self.request(
                "adopt_method_candidate",
                {"project": str(project), "candidate_id": candidate_id},
            )

        for phase in ("targeted", "regression"):
            mapping = self.read_json(
                project
                / "creative-system"
                / "app-methods"
                / "candidates"
                / candidate_id
                / "comparisons"
                / phase
                / "mapping.json"
            )
            self.request(
                "submit_method_comparison",
                {
                    "project": str(project),
                    "candidate_id": candidate_id,
                    "phase": phase,
                    "choice": mapping["candidate_label"],
                },
            )

        heldout_mapping = self.read_json(
            project
            / "creative-system"
            / "app-methods"
            / "candidates"
            / candidate_id
            / "comparisons"
            / "heldout"
            / "mapping.json"
        )
        with mock.patch.object(
            app_service,
            "_candidate_status_update",
            side_effect=RuntimeError("synthetic status projection crash"),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "synthetic status projection crash"
            ):
                self.request(
                    "submit_method_comparison",
                    {
                        "project": str(project),
                        "candidate_id": candidate_id,
                        "phase": "heldout",
                        "choice": heldout_mapping["candidate_label"],
                    },
                )
        stale_status = self.read_json(
            project
            / "creative-system"
            / "app-methods"
            / "candidates"
            / candidate_id
            / "status.json"
        )
        self.assertEqual(stale_status["lifecycle"], "EVALUATING")
        recovered_snapshot = self.request(
            "system_snapshot", {"project": str(project)}
        )
        recovered_candidate = next(
            item
            for item in recovered_snapshot["method_candidates"]
            if item["id"] == candidate_id
        )
        self.assertEqual(recovered_candidate["status"], "READY_FOR_HUMAN")
        self.assertTrue(recovered_candidate["ready"])

        targeted_decision = (
            project
            / "creative-system"
            / "app-methods"
            / "candidates"
            / candidate_id
            / "comparisons"
            / "targeted"
            / "decision.json"
        )
        original_decision = targeted_decision.read_bytes()
        damaged_decision = self.read_json(targeted_decision)
        damaged_decision["choice"] = "TIE"
        self.write_json(targeted_decision, damaged_decision)
        with self.assertRaises(AppRequestError):
            self.request("system_snapshot", {"project": str(project)})
        targeted_decision.write_bytes(original_decision)

        controller = load_controller()
        atomic_create_json = controller.atomic_create_json

        def crash_after_promotion_receipt(path, value):
            atomic_create_json(path, value)
            if Path(path).parent.name == "promotions":
                raise RuntimeError("synthetic promotion receipt crash")

        with mock.patch.object(
            controller,
            "atomic_create_json",
            side_effect=crash_after_promotion_receipt,
        ):
            with self.assertRaisesRegex(
                RuntimeError, "synthetic promotion receipt crash"
            ):
                self.request(
                    "adopt_method_candidate",
                    {"project": str(project), "candidate_id": candidate_id},
                )
        receipt_pending_snapshot = self.request(
            "system_snapshot", {"project": str(project)}
        )
        receipt_pending_candidate = next(
            item
            for item in receipt_pending_snapshot["method_candidates"]
            if item["id"] == candidate_id
        )
        self.assertEqual(receipt_pending_candidate["status"], "PROMOTED")
        self.assertTrue(receipt_pending_candidate["adoption_pending"])
        with self.assertRaisesRegex(AppRequestError, "已采用方法"):
            self.request(
                "reject_method_candidate",
                {"project": str(project), "candidate_id": candidate_id},
            )

        with mock.patch.object(
            app_service,
            "_write_method_registry",
            side_effect=RuntimeError("synthetic registry crash"),
        ):
            with self.assertRaisesRegex(RuntimeError, "synthetic registry crash"):
                self.request(
                    "adopt_method_candidate",
                    {"project": str(project), "candidate_id": candidate_id},
                )
        still_stable = self.request("production_context", {"project": str(project)})
        self.assertEqual(still_stable["method_version"], "baseline-v1")
        pending_snapshot = self.request(
            "system_snapshot", {"project": str(project)}
        )
        pending_candidate = next(
            item
            for item in pending_snapshot["method_candidates"]
            if item["id"] == candidate_id
        )
        self.assertTrue(pending_candidate["adoption_pending"])
        self.assertFalse(pending_candidate["rolled_back"])
        adopted = self.request(
            "adopt_method_candidate",
            {"project": str(project), "candidate_id": candidate_id},
        )
        self.assertFalse(adopted["formal_l4"])
        production = self.request("production_context", {"project": str(project)})
        self.assertEqual(production["method_version"], candidate_id)
        self.assertEqual(production["guidance"], guidance)

        fourth = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "method-run-four",
                "work_id": "method-work-four",
                "task": "创作第四个独立近未来悬疑短篇",
                "context_sha256": production["context_sha256"],
            },
        )
        fourth_run = self.read_json(
            project / "creative-system/runs/method-run-four/run.json"
        )
        fourth_task = self.read_json(project / fourth["task_receipt"])
        self.assertEqual(fourth_run["app_method_version_at_start"], candidate_id)
        self.assertEqual(fourth_task["method_version"], candidate_id)
        self.assertEqual(
            fourth_task["method_guidance_sha256"], production["guidance_sha256"]
        )
        completed_fourth = self.request(
            "complete_work",
            {
                "project": str(project),
                "run_id": "method-run-four",
                "output": "第四个作品实际使用了候选方法：她把门卡留在警报器上。",
                "runtime_provenance": self.runtime_provenance(
                    context_sha256=fourth_task["context_sha256"],
                    response_id="response-method-work-four",
                ),
            },
        )
        self.request(
            "submit_feedback",
            {
                "project": str(project),
                "run_id": "method-run-four",
                "action": "keep",
                "feedback_at": completed_fourth["review_available_at"],
                "machine_direction": "UNKNOWN",
            },
        )
        restarted_with_fourth = self.request(
            "system_snapshot", {"project": str(project)}
        )
        self.assertEqual(restarted_with_fourth["last_work"]["run_id"], "method-run-four")
        self.assertTrue(restarted_with_fourth["last_work"]["sealed"])
        self.assertEqual(
            restarted_with_fourth["last_work"]["method_version"], candidate_id
        )
        self.assertIsNotNone(
            restarted_with_fourth["last_work"]["runtime_provenance_sha256"]
        )

        with mock.patch.object(
            app_service,
            "_write_method_registry",
            side_effect=RuntimeError("synthetic rollback projection crash"),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "synthetic rollback projection crash"
            ):
                self.request(
                    "rollback_method",
                    {"project": str(project), "to_version": "baseline-v1"},
                )
        rolled_back = {
            "active_method_version": "baseline-v1",
            "snapshot": self.request(
                "system_snapshot", {"project": str(project)}
            ),
        }
        self.assertEqual(rolled_back["active_method_version"], "baseline-v1")
        final_snapshot = rolled_back["snapshot"]
        self.assertTrue(
            any(
                item.get("action") == "PROMOTE" and item.get("version") == candidate_id
                for item in final_snapshot["method"]["history"]
            )
        )
        self.assertTrue(
            any(
                item.get("action") == "ROLLBACK"
                for item in final_snapshot["method"]["history"]
            )
        )
        historical_candidate = next(
            item
            for item in final_snapshot["method_candidates"]
            if item["id"] == candidate_id
        )
        self.assertFalse(historical_candidate["adoption_pending"])
        self.assertTrue(historical_candidate["rolled_back"])
        history_before_rejected_reactivation = list(
            final_snapshot["method"]["history"]
        )
        with self.assertRaisesRegex(AppRequestError, "已显式回滚"):
            self.request(
                "adopt_method_candidate",
                {"project": str(project), "candidate_id": candidate_id},
            )
        after_rejected_reactivation = self.request(
            "system_snapshot", {"project": str(project)}
        )
        self.assertEqual(
            after_rejected_reactivation["method"]["history"],
            history_before_rejected_reactivation,
        )
        baseline = self.request("production_context", {"project": str(project)})
        self.assertEqual(baseline["method_version"], "baseline-v1")
        fifth = self.request(
            "begin_work",
            {
                "project": str(project),
                "run_id": "method-run-five",
                "work_id": "method-work-five",
                "task": "回滚后验证基线方法上下文",
                "context_sha256": baseline["context_sha256"],
            },
        )
        fifth_run = self.read_json(
            project / "creative-system/runs/method-run-five/run.json"
        )
        self.assertEqual(
            fifth_run.get("app_method_version_at_start", "baseline-v1"),
            "baseline-v1",
        )
        self.request(
            "terminate_work",
            {
                "project": str(project),
                "run_id": "method-run-five",
                "dispatch_id": fifth["dispatch_id"],
                "outcome": "CANCELLED",
                "reason": "test-cleanup-after-baseline-context-verification",
            },
        )
        explicitly_restored = self.request(
            "rollback_method",
            {"project": str(project), "to_version": candidate_id},
        )
        self.assertEqual(
            explicitly_restored["active_method_version"], candidate_id
        )
        active_again = next(
            item
            for item in explicitly_restored["snapshot"]["method_candidates"]
            if item["id"] == candidate_id
        )
        self.assertFalse(active_again["adoption_pending"])
        self.assertFalse(active_again["rolled_back"])
        rolled_back_again = self.request(
            "rollback_method",
            {"project": str(project), "to_version": "baseline-v1"},
        )
        rollback_history = [
            item
            for item in rolled_back_again["snapshot"]["method"]["history"]
            if item.get("action") == "ROLLBACK"
        ]
        self.assertEqual(len(rollback_history), 3)
        self.assertEqual(
            len({item["receipt"] for item in rollback_history}), 3
        )
        self.assertEqual(
            rolled_back_again["active_method_version"], "baseline-v1"
        )
        audit = self.command("audit", project)
        self.assertNotEqual(audit["provable_maturity"], "L4")

    def test_method_observations_are_partitioned_by_runtime_epoch(self):
        project, _ = self.bootstrap()
        feedback_text = "让开头更快建立可见风险。"

        def seal(number, *, model="deepseek-v4-pro", fingerprint="fp-epoch-a"):
            run_id = f"epoch-run-{number}"
            begun = self.request(
                "begin_work",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "work_id": f"epoch-work-{number}",
                    "task": f"epoch 独立任务 {number}",
                },
            )
            completed = self.request(
                "complete_work",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "output": f"epoch 基线作品 {number}",
                    "runtime_provenance": self.runtime_provenance(
                        context_sha256=begun["context_sha256"],
                        model=model,
                        fingerprint=fingerprint,
                        response_id=f"response-epoch-{number}",
                    ),
                },
            )
            self.request(
                "submit_feedback",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "action": "rewrite",
                    "feedback_at": completed["review_available_at"],
                    "feedback_text": feedback_text,
                    "machine_direction": "UNKNOWN",
                },
            )

        seal(1)
        seal(2)
        seal(3, model="deepseek-v4-flash")
        snapshot = self.request("system_snapshot", {"project": str(project)})
        observations = snapshot["learning"]["observations"]
        self.assertEqual(
            sorted(item["independent_works"] for item in observations), [1, 2]
        )
        self.assertFalse(any(item["ready_for_candidate"] for item in observations))

        seal(4)
        seal(5, fingerprint="fp-epoch-b")
        snapshot = self.request("system_snapshot", {"project": str(project)})
        observations = snapshot["learning"]["observations"]
        self.assertEqual(
            sorted(item["independent_works"] for item in observations), [1, 1, 3]
        )
        ready = [item for item in observations if item["ready_for_candidate"]]
        self.assertEqual(len(ready), 1)
        self.assertEqual(ready[0]["epoch"]["method_version"], "baseline-v1")
        self.assertEqual(ready[0]["epoch"]["returned_model"], "deepseek-v4-pro")
        self.assertEqual(ready[0]["epoch"]["system_fingerprint"], "fp-epoch-a")

        candidate_id = "method-epoch-isolated-v1"
        context = self.request(
            "method_candidate_context",
            {
                "project": str(project),
                "candidate_id": candidate_id,
                "observation_id": ready[0]["id"],
            },
        )
        self.assertEqual(
            {item["run_id"] for item in context["source_works"]},
            {"epoch-run-1", "epoch-run-2", "epoch-run-4"},
        )
        with self.assertRaisesRegex(AppRequestError, "Candidate Builder"):
            self.request(
                "create_method_candidate",
                {
                    "project": str(project),
                    "candidate_id": candidate_id,
                    "observation_id": ready[0]["id"],
                    "guidance": "在开头两句建立异常和风险。",
                    "builder_role_id": "method-candidate-builder",
                    "builder_context_id": "epoch-builder-context",
                    "builder_task_id": "epoch-builder-task",
                    "builder_attested_by": "local-main-supervisor",
                    "builder_provenance": self.runtime_provenance(
                        context_sha256=context["builder_context_sha256"],
                        fingerprint="fp-epoch-b",
                        response_id="response-wrong-epoch-builder",
                    ),
                },
            )
        self.assertFalse(
            (
                project
                / "creative-system/app-methods/candidates"
                / candidate_id
            ).exists()
        )
        created = self.request(
            "create_method_candidate",
            {
                "project": str(project),
                "candidate_id": candidate_id,
                "observation_id": ready[0]["id"],
                "guidance": "在开头两句建立异常和风险。",
                "builder_role_id": "method-candidate-builder",
                "builder_context_id": "epoch-builder-context",
                "builder_task_id": "epoch-builder-task",
                "builder_attested_by": "local-main-supervisor",
                "builder_provenance": self.runtime_provenance(
                    context_sha256=context["builder_context_sha256"],
                    fingerprint="fp-epoch-a",
                    response_id="response-correct-epoch-builder",
                ),
            },
        )
        plan = created["evaluation_plan"]

        def generation(label, context_sha256, *, profile="a" * 64):
            provenance = self.runtime_provenance(
                context_sha256=context_sha256,
                fingerprint="fp-epoch-a",
                response_id=f"response-{label}",
            )
            provenance["profile_sha256"] = profile
            return {"output": f"{label} 输出", "runtime_provenance": provenance}

        with self.assertRaisesRegex(AppRequestError, "Profile"):
            self.request(
                "stage_method_comparisons",
                {
                    "project": str(project),
                    "candidate_id": candidate_id,
                    "generations": {
                        "targeted_candidate": generation(
                            "targeted",
                            plan["targeted"]["candidate_context_sha256"],
                        ),
                        "regression_candidate": generation(
                            "regression",
                            plan["regression"]["candidate_context_sha256"],
                            profile="b" * 64,
                        ),
                        "heldout_baseline": generation(
                            "heldout-baseline",
                            plan["heldout"]["baseline_context_sha256"],
                        ),
                        "heldout_candidate": generation(
                            "heldout-candidate",
                            plan["heldout"]["candidate_context_sha256"],
                        ),
                    },
                },
            )
        self.assertFalse(
            (
                project
                / "creative-system/app-methods/candidates"
                / candidate_id
                / "comparisons"
            ).exists()
        )

    def test_unverified_legacy_app_feedback_findings_never_form_method_candidate(self):
        project, _ = self.bootstrap("legacy-method-evidence")
        fake_feedback = "伪造但相同的历史反馈"
        fake_finding = self.root / "fake-app-feedback.json"
        self.write_json(
            fake_finding,
            {
                "code": "APP-FEEDBACK-DEADBEEF0001",
                "category": "soft-quality",
                "severity": "medium",
                "confidence": 1.0,
                "evidence": [
                    {"path": "legacy", "note": "not AppFeedbackReceipt"}
                ],
                "owner": "creative-producer",
                "suggested_action": fake_feedback,
            },
        )
        for number in range(1, 4):
            run_id = f"legacy-run-{number}"
            begun = self.request(
                "begin_work",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "work_id": f"legacy-work-{number}",
                    "task": f"legacy 独立任务 {number}",
                },
            )
            completed = self.request(
                "complete_work",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "output": f"legacy 作品 {number}",
                    "runtime_provenance": self.runtime_provenance(
                        context_sha256=begun["context_sha256"],
                        response_id=f"response-legacy-{number}",
                    ),
                },
            )
            receipt = self.request(
                "record_feedback",
                {
                    "project": str(project),
                    "run_id": run_id,
                    "event_id": f"legacy-keep-{number}",
                    "action": "keep",
                    "feedback_at": completed["review_available_at"],
                },
            )
            self.request(
                "seal_feedback",
                {
                    "project": str(project),
                    "feedback_receipt": receipt["receipt"],
                    "machine_direction": "UNKNOWN",
                    "finding_paths": [str(fake_finding)],
                },
            )

        snapshot = self.request("system_snapshot", {"project": str(project)})
        observations = snapshot["learning"]["observations"]
        self.assertFalse(
            any(
                item.get("finding_code") == "APP-FEEDBACK-DEADBEEF0001"
                for item in observations
            )
        )
        self.assertNotIn(fake_feedback, json.dumps(snapshot, ensure_ascii=False))

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
