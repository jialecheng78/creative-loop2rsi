import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "skills" / "creative-loop2rsi" / "scripts" / "loopctl.py"
BUILDER_INPUT_ARGS = (
    "--builder-input-boundary",
    "finding-evidence",
    "--builder-input-boundary",
    "creative-charter",
    "--builder-input-boundary",
    "editable-surface",
    "--builder-input-boundary",
    "system-contract",
    "--builder-input-boundary",
    "evaluation-policy",
)


class LoopCtlTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def command(self, *arguments, expected=0, environment_overrides=None):
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        if environment_overrides:
            environment.update(environment_overrides)
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
            msg="stdout:\n{}\nstderr:\n{}".format(result.stdout, result.stderr),
        )
        return json.loads(result.stdout)

    def init_project(self, name="project", *, confirmed=True):
        target = self.root / name
        arguments = [
            "init",
            target,
            "--project-name",
            "纸灯故事实验",
            "--creative-goal",
            "为青少年创作克制而完整的成长短篇",
            "--minimum-product",
            "一篇有选择、后果和结尾的短故事",
            "--representative-task",
            "写一个孩子用行动化解误会的故事",
            "--constraints",
            "不能靠梦醒复位；不得使用真实个人信息",
            "--taste",
            "喜欢动作细节与克制幽默；不喜欢旁白说教",
            "--domain-skill",
            "paper-lantern-story",
        ]
        self.command(*arguments)
        if confirmed:
            evidence = (
                target
                / "creative-system"
                / "approvals"
                / "charter-confirmations"
                / "evidence"
                / "initial-charter-confirmation.md"
            )
            evidence.parent.mkdir(parents=True, exist_ok=True)
            evidence.write_text(
                "项目所有者已阅读并明确确认当前 creative-charter.md。\n",
                encoding="utf-8",
            )
            self.command(
                "confirm-charter",
                target,
                "--confirmed-by",
                "test-project-owner",
                "--confirmed-at",
                "2000-01-01T00:00:00Z",
                "--evidence",
                evidence.relative_to(target),
            )
        return target

    @staticmethod
    def read_json(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    @staticmethod
    def write_json(path, value):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    @staticmethod
    def tree_hashes(root):
        return {
            path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*"))
            if path.is_file()
        }

    def clear_charter_confirmation_mirror(self, project):
        system_path = project / "creative-system/system.json"
        system = self.read_json(system_path)
        system["charter"].update(
            {
                "confirmed": False,
                "confirmed_by": None,
                "confirmed_at": None,
                "confirmation_receipt": None,
                "confirmation_receipt_sha256": None,
            }
        )
        self.write_json(system_path, system)

    def clear_charter_confirmation_ledger(self, project):
        self.write_json(
            project / "creative-system/approvals/charter-confirmations/ledger.json",
            {
                "schema_version": "0.1",
                "kind": "CharterConfirmationLedger",
                "entries": [],
            },
        )

    def finding_file(self, code="PACE-MIDDLE-STALL"):
        path = self.root / (code.lower() + ".json")
        self.write_json(
            path,
            {
                "code": code,
                "category": "soft-quality",
                "severity": "medium",
                "confidence": 0.8,
                "evidence": [{"path": "artifacts/work.md", "note": "中段没有新行动"}],
                "owner": "creative-producer",
                "suggested_action": "让中点事件改变角色选择",
            },
        )
        return path

    def human_feedback_args(
        self,
        project,
        run_id,
        *,
        accepted=True,
        direction="PASS",
        machine_direction="UNKNOWN",
        dispatch_id=None,
    ):
        run = self.read_json(project / "creative-system" / "runs" / run_id / "run.json")
        attempt_id = run["current_attempt"]
        attempt = project / "creative-system" / "runs" / run_id / "attempts" / attempt_id
        if dispatch_id is None:
            dispatch_root = attempt / "dispatches"
            produced = []
            if dispatch_root.is_dir():
                for candidate in sorted(dispatch_root.iterdir()):
                    artifact_root = candidate / "artifacts"
                    if artifact_root.is_dir() and any(path.is_file() for path in artifact_root.rglob("*")):
                        produced.append(candidate.name)
            if len(produced) == 1:
                dispatch_id = produced[0]
        review_arguments = [
            "open-human-review",
            project,
            "--run-id",
            run_id,
            "--machine-direction",
            machine_direction,
        ]
        if dispatch_id is not None:
            review_arguments += ["--dispatch-id", dispatch_id]
        review = self.command(*review_arguments)
        relative = Path("creative-system/approvals/attempt-feedback") / (
            "{}-{}.md".format(run_id, attempt_id)
        )
        evidence = project / relative
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(
            "外部人工反馈：accepted={}；direction={}；subject={}/{}。\n".format(
                accepted, direction, run_id, attempt_id
            ),
            encoding="utf-8",
        )
        return [
            "--human-feedback-by",
            "test-project-owner",
            "--human-feedback-at",
            review["review_available_at"],
            "--human-feedback-evidence",
            relative,
        ]

    def seal_run(
        self,
        project,
        number,
        *,
        finding=None,
        accepted=True,
        recovery=False,
        l3_flags=False,
    ):
        run_id = "run-{}".format(number)
        task = "代表任务 {}".format(number)
        begin = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            task,
            "--run-id",
            run_id,
        )
        attempt = project / begin["attempt_path"]
        (attempt / "artifacts" / "work.md").write_text("虚构成品 {}\n".format(number), encoding="utf-8")
        arguments = [
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
            "--human-accepted",
            "true" if accepted else "false",
            "--machine-direction",
            "PASS",
            "--human-direction",
            "PASS",
            "--improved",
            "true",
            *self.human_feedback_args(
                project,
                run_id,
                accepted=accepted,
                direction="PASS",
                machine_direction="PASS",
            ),
        ]
        if finding:
            arguments += ["--finding", finding]
        if recovery:
            arguments.append("--recovery-exercised")
        if l3_flags:
            arguments += [
                "--local-recovery-preserved-upstream",
                "--end-to-end-no-regression",
                "--resolved-observed-problem",
            ]
        return self.command(*arguments)

    def add_second_loop(self, project):
        system_path = project / "creative-system" / "system.json"
        system = self.read_json(system_path)
        system["artifacts"].append(
            {
                "id": "edited-work",
                "path": "outputs/edited-work.md",
                "owner": "creative-editor",
                "kind": "output",
                "protected": False,
            }
        )
        system["loops"].append("creative-system/loops/edit-loop.json")
        self.write_json(system_path, system)
        self.write_json(
            project / "creative-system" / "loops" / "edit-loop.json",
            {
                "schema_version": "0.1",
                "kind": "LoopSpec",
                "id": "edit-loop",
                "goal": "把初稿编辑成满足创作宪法的完整成品",
                "reads": ["creative-work"],
                "writes": ["edited-work"],
                "owner": "creative-editor",
                "trigger": {"on": ["creative-work.changed"]},
                "producer": {"agent": "creative-editor", "separate_from_judges": True},
                "judges": ["hard-contract", "taste-gate"],
                "decision_policy": ["hard-block", "needs-taste", "revise", "commit"],
                "memory_updates": ["run-lessons", "finding-index"],
                "retry_budget": {
                    "max_attempts": 3,
                    "max_no_improvement": 2,
                    "on_budget_exhausted": "escalate",
                },
                "stop_conditions": ["retry-budget-exhausted", "no-improvement-twice"],
                "human_gate": {"required": True, "when": "before-release"},
            },
        )

    def make_l3_project(self, name="project"):
        project = self.init_project(name)
        self.add_second_loop(project)
        finding = self.finding_file()
        for number in range(1, 6):
            self.seal_run(
                project,
                number,
                finding=finding,
                recovery=number == 1,
                l3_flags=number == 1,
            )
        audit = self.command("audit", project)
        self.assertEqual(audit["provable_maturity"], "L3")
        return project

    def create_l4_candidate(self, project, candidate_id="pace-fix", *, budget=3):
        result = self.command(
            "create-candidate",
            project,
            "--candidate-id",
            candidate_id,
            "--finding-code",
            "PACE-MIDDLE-STALL",
            "--root-cause",
            "主 Loop 的中点上下文没有要求产生不可逆选择",
            "--target-component",
            "prompts",
            "--change-summary",
            "在生产指导中加入中点选择约束",
            "--changed-path",
            "skills/paper-lantern-story/references/production-guidance.md",
            "--builder-role-id",
            "candidate-builder",
            "--builder-context-id",
            "builder-context-{}".format(candidate_id),
            "--builder-task-id",
            "builder-task-{}".format(candidate_id),
            "--builder-attested-by",
            "test-orchestrator",
            *BUILDER_INPUT_ARGS,
            "--budget",
            str(budget),
        )
        change = (
            project
            / "creative-system"
            / "candidates"
            / candidate_id
            / "changes"
            / "skills"
            / "paper-lantern-story"
            / "references"
            / "production-guidance.md"
        )
        change.parent.mkdir(parents=True, exist_ok=True)
        change.write_text("# 候选生产指导\n\n中点必须产生改变角色选择的新事件。\n", encoding="utf-8")
        return result

    def promotion_evaluation(self, project, candidate_id="pace-fix"):
        evidence_files = {
            "creative-system/evals/development/human-approval.md": "Alice 批准候选范围\n",
            "creative-system/evals/development/run-integrity.md": "三个评价 run 均使用全新空输出根；未复用旧输出\n",
        }
        for relative, content in evidence_files.items():
            path = project / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        eval_specs = {
            "targeted": ("target-run", "target.md", "目标问题改善\n"),
            "regression": ("regression-run", "regression.md", "回归无硬退化\n"),
            "heldout": ("heldout-run", "result.md", "盲评不劣于基线\n"),
        }
        eval_results = {}
        for phase, (run_id, filename, content) in eval_specs.items():
            opened = self.command(
                "open-eval-run",
                project,
                "--candidate-id",
                candidate_id,
                "--eval-run-id",
                run_id,
                "--phase",
                phase,
                "--evaluator-role-id",
                "{}-evaluator".format(phase),
                "--evaluator-context-id",
                "{}-context".format(run_id),
                "--evaluator-task-id",
                "{}-task".format(run_id),
                "--attested-by",
                "test-orchestrator",
                "--input-boundary",
                "creative-charter",
                "--input-boundary",
                "rubric",
                "--input-boundary",
                "baseline-output",
                "--input-boundary",
                "candidate-output",
                *(
                    ["--input-boundary", "heldout-input"]
                    if phase == "heldout"
                    else []
                ),
            )
            output_file = project / opened["output_root"] / filename
            output_file.write_text(content, encoding="utf-8")
            self.command(
                "seal-eval-run",
                project,
                "--candidate-id",
                candidate_id,
                "--eval-run-id",
                run_id,
            )
            eval_results[phase] = {
                "run_id": run_id,
                "output_root": opened["output_root"],
                "evidence": [output_file.relative_to(project).as_posix()],
            }
        evaluation_path = project / "creative-system" / "evals" / "development" / "promotion.json"
        self.write_json(
            evaluation_path,
            {
                "independent_evaluator": True,
                "evaluator": "frozen-external-reviewer",
                "evaluation_runs": 3,
                "targeted": {
                    "status": "IMPROVED",
                    **eval_results["targeted"],
                },
                "regression": {
                    "status": "PASS",
                    "hard_contract_regressions": 0,
                    "hard_false_passes": 0,
                    **eval_results["regression"],
                },
                "heldout": {
                    "status": "NON_INFERIOR",
                    "blind": True,
                    "baseline_comparison": "NOT_WORSE",
                    **eval_results["heldout"],
                },
                "human_approval": {
                    "approved": True,
                    "approved_by": "Alice",
                    "approved_at": "2026-08-04T00:00:00Z",
                    "scope": "只晋升 production guidance 候选",
                    "evidence": ["creative-system/evals/development/human-approval.md"],
                },
                "run_integrity": {
                    "fresh_output_roots_verified": True,
                    "all_evaluation_outputs_regenerated": True,
                    "prior_run_outputs_included": 0,
                    "stale_output_contamination": False,
                    "evidence": ["creative-system/evals/development/run-integrity.md"],
                },
            },
        )
        return evaluation_path

    def test_init_refuses_nonempty_and_is_deterministic(self):
        occupied = self.root / "occupied"
        occupied.mkdir()
        (occupied / "keep.txt").write_text("keep", encoding="utf-8")
        payload = self.command(
            "init",
            occupied,
            "--project-name",
            "X",
            "--creative-goal",
            "G",
            "--minimum-product",
            "M",
            "--representative-task",
            "T",
            "--constraints",
            "C",
            "--taste",
            "P",
            "--domain-skill",
            "domain-loop",
            expected=2,
        )
        self.assertEqual(payload["status"], "BLOCK")
        self.assertEqual((occupied / "keep.txt").read_text(encoding="utf-8"), "keep")

        first = self.init_project("first", confirmed=False)
        second = self.init_project("second", confirmed=False)
        self.assertEqual(self.tree_hashes(first), self.tree_hashes(second))

    def test_cli_emits_utf8_json_when_platform_stdio_is_non_utf8(self):
        target = self.root / "non-utf8-stdio"
        payload = self.command(
            "init",
            target,
            "--project-name",
            "纸灯故事实验",
            "--creative-goal",
            "创作一篇完整的成长短篇",
            "--minimum-product",
            "一篇有结尾的短故事",
            "--representative-task",
            "写一个孩子修好风筝的故事",
            "--constraints",
            "不得使用真实个人信息",
            "--taste",
            "喜欢具体动作，不喜欢说教",
            "--domain-skill",
            "non-utf8-story-loop",
            environment_overrides={
                "PYTHONIOENCODING": "cp1252",
                "PYTHONUTF8": "0",
            },
        )
        self.assertEqual(payload["status"], "PASS")
        self.assertTrue(payload["next_step"].startswith("阅读"))
        system = self.read_json(target / "creative-system/system.json")
        self.assertEqual(system["project"]["name"], "纸灯故事实验")

    def test_measure_artifact_writes_governing_controller_facts(self):
        project = self.init_project()
        source = project / "outputs" / "draft.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("# 标题\n汉字A。\n𠀀\n", encoding="utf-8")
        output_path = "creative-system/runs/metric-run/controller-facts.json"

        measured = self.command(
            "measure-artifact",
            project,
            "--source",
            "outputs/draft.md",
            "--output",
            output_path,
            "--exclude-first-markdown-h1",
        )
        facts = self.read_json(project / output_path)
        self.assertEqual(measured["unicode_han_count"], 3)
        self.assertEqual(facts["whole_file_metrics"]["unicode_han_count"], 5)
        self.assertEqual(facts["metrics"]["unicode_han_count"], 3)
        self.assertEqual(facts["metrics"]["line_count"], 2)
        self.assertEqual(facts["metrics"]["unicode_codepoint_count"], 7)
        self.assertEqual(facts["source"]["bytes"], len(source.read_bytes()))
        self.assertEqual(facts["source"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertTrue(facts["excluded_first_markdown_h1"]["requested"])
        self.assertTrue(facts["excluded_first_markdown_h1"]["applied"])
        self.assertEqual(facts["excluded_first_markdown_h1"]["unicode_han_count"], 2)
        self.assertTrue(facts["authority"]["mechanical_fields_governing"])
        self.assertFalse(facts["authority"]["producer_self_report_governing"])
        self.assertEqual(
            measured["facts_sha256"],
            hashlib.sha256((project / output_path).read_bytes()).hexdigest(),
        )

        original_facts = (project / output_path).read_bytes()
        blocked = self.command(
            "measure-artifact",
            project,
            "--source",
            "outputs/draft.md",
            "--output",
            output_path,
            expected=2,
        )
        self.assertIn("拒绝覆盖", blocked["error"])
        self.assertEqual((project / output_path).read_bytes(), original_facts)

    def test_measure_artifact_rejects_invalid_utf8_and_path_escape(self):
        project = self.init_project()
        invalid = project / "outputs" / "invalid.bin"
        invalid.parent.mkdir(parents=True, exist_ok=True)
        invalid.write_bytes(b"\xff\xfe")
        blocked = self.command(
            "measure-artifact",
            project,
            "--source",
            "outputs/invalid.bin",
            "--output",
            "creative-system/runs/invalid-facts.json",
            expected=2,
        )
        self.assertIn("UTF-8", blocked["error"])
        self.assertFalse((project / "creative-system/runs/invalid-facts.json").exists())

        valid = project / "outputs" / "valid.md"
        valid.write_text("正文\n", encoding="utf-8")
        escaped = self.command(
            "measure-artifact",
            project,
            "--source",
            "outputs/valid.md",
            "--output",
            "../outside.json",
            expected=2,
        )
        self.assertIn("项目内相对路径", escaped["error"])
        self.assertFalse((project.parent / "outside.json").exists())

    def test_controller_facts_are_recomputed_and_sealed_with_artifact(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "机械证据封存",
            "--run-id",
            "facts-run",
        )
        attempt_relative = Path(started["attempt_path"])
        source_relative = attempt_relative / "artifacts" / "work.md"
        facts_relative = attempt_relative / "controller-facts" / "work.json"
        source = project / source_relative
        source.write_text("# 标题\n正文𠀀\n", encoding="utf-8")
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            facts_relative,
            "--exclude-first-markdown-h1",
        )
        sealed = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "facts-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            *self.human_feedback_args(project, "facts-run"),
        )
        manifest = self.read_json(project / sealed["manifest"])
        names = {entry["path"] for entry in manifest["files"]}
        self.assertIn("artifacts/work.md", names)
        self.assertIn("controller-facts/work.json", names)
        self.assertEqual(
            manifest["verified_controller_facts"],
            [facts_relative.as_posix()],
        )

    def test_stale_controller_facts_block_seal_without_consuming_attempt(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "过期机械证据",
            "--run-id",
            "stale-facts-run",
        )
        attempt_relative = Path(started["attempt_path"])
        source_relative = attempt_relative / "artifacts" / "work.md"
        facts_relative = attempt_relative / "controller-facts" / "work.json"
        source = project / source_relative
        source.write_text("第一版\n", encoding="utf-8")
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            facts_relative,
        )
        source.write_text("第二版\n", encoding="utf-8")
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "stale-facts-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            expected=2,
        )
        self.assertIn("STALE_CONTROLLER_FACTS", blocked["error"])
        self.assertIn("新的 --output 路径", blocked["error"])
        self.assertIn("open-human-review", blocked["error"])
        attempt = project / attempt_relative
        self.assertFalse((attempt / "manifest.json").exists())
        run = self.read_json(project / "creative-system/runs/stale-facts-run/run.json")
        self.assertEqual(run["attempts"], [])

    def test_remeasure_keeps_history_and_opens_review_with_one_active_facts(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "改稿后正常重测",
            "--run-id",
            "remeasure-run",
        )
        attempt_relative = Path(started["attempt_path"])
        source_relative = attempt_relative / "artifacts" / "work.md"
        first_relative = attempt_relative / "controller-facts" / "work-v1.json"
        second_relative = attempt_relative / "controller-facts" / "work-v2.json"
        source = project / source_relative
        source.write_text("第一版\n", encoding="utf-8")
        first = self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            first_relative,
        )
        first_bytes = (project / first_relative).read_bytes()

        source.write_text("第二版已经补足行动\n", encoding="utf-8")
        reused_output = self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            first_relative,
            expected=2,
        )
        self.assertIn("新的 --output 路径", reused_output["error"])
        second = self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            second_relative,
        )
        self.assertEqual((project / first_relative).read_bytes(), first_bytes)
        self.assertEqual(first["generation"], 1)
        self.assertEqual(second["generation"], 2)
        self.assertEqual(second["supersedes"], first_relative.as_posix())

        review = self.command(
            "open-human-review",
            project,
            "--run-id",
            "remeasure-run",
            "--machine-direction",
            "PASS",
        )
        subject = self.read_json(project / review["review_subject"])
        self.assertEqual(subject["verified_controller_facts"], [second_relative.as_posix()])
        self.assertEqual(
            [item["path"] for item in subject["active_controller_facts"]],
            [second_relative.as_posix()],
        )
        self.assertTrue(project.joinpath(first_relative).is_file())

    def test_same_bytes_new_scope_supersedes_to_one_active_facts(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "同字节改计量范围",
            "--run-id",
            "scope-remeasure-run",
        )
        attempt_relative = Path(started["attempt_path"])
        source_relative = attempt_relative / "artifacts" / "work.md"
        first_relative = attempt_relative / "controller-facts" / "whole.json"
        second_relative = attempt_relative / "controller-facts" / "without-title.json"
        source = project / source_relative
        source.write_text("# 标题\n正文\n", encoding="utf-8")
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            first_relative,
        )
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            second_relative,
            "--exclude-first-markdown-h1",
        )
        review = self.command(
            "open-human-review",
            project,
            "--run-id",
            "scope-remeasure-run",
        )
        subject = self.read_json(project / review["review_subject"])
        self.assertEqual(subject["verified_controller_facts"], [second_relative.as_posix()])
        self.assertEqual(self.read_json(project / first_relative)["scope"], "whole-file")
        self.assertEqual(
            self.read_json(project / second_relative)["scope"],
            "exclude-first-markdown-h1",
        )

    def test_replacing_reviewed_facts_at_same_path_makes_subject_stale(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "送审 facts 不可偷换",
            "--run-id",
            "facts-review-stale-run",
        )
        attempt_relative = Path(started["attempt_path"])
        source_relative = attempt_relative / "artifacts" / "work.md"
        facts_relative = attempt_relative / "controller-facts" / "work.json"
        source = project / source_relative
        source.write_text("# 标题\n送审正文\n", encoding="utf-8")
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            facts_relative,
        )
        self.command(
            "open-human-review",
            project,
            "--run-id",
            "facts-review-stale-run",
        )

        alternate_relative = Path("creative-system/runs/legal-alternate-facts.json")
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            alternate_relative,
            "--exclude-first-markdown-h1",
        )
        alternate = self.read_json(project / alternate_relative)
        self.write_json(project / facts_relative, alternate)

        validation = self.command("validate", project, expected=1)
        self.assertTrue(
            any("HUMAN_REVIEW_SUBJECT_STALE" in error for error in validation["errors"])
        )
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "facts-review-stale-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            expected=2,
        )
        self.assertIn("HUMAN_REVIEW_SUBJECT_STALE", blocked["error"])

    def test_tampered_superseded_facts_breaks_chain(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "历史 facts 验哈",
            "--run-id",
            "tampered-history-run",
        )
        attempt_relative = Path(started["attempt_path"])
        source_relative = attempt_relative / "artifacts" / "work.md"
        first_relative = attempt_relative / "controller-facts" / "work-v1.json"
        second_relative = attempt_relative / "controller-facts" / "work-v2.json"
        source = project / source_relative
        source.write_text("旧版\n", encoding="utf-8")
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            first_relative,
        )
        source.write_text("新版\n", encoding="utf-8")
        self.command(
            "measure-artifact",
            project,
            "--source",
            source_relative,
            "--output",
            second_relative,
        )
        old = self.read_json(project / first_relative)
        old["metrics"]["unicode_han_count"] += 1
        self.write_json(project / first_relative, old)
        blocked = self.command(
            "open-human-review",
            project,
            "--run-id",
            "tampered-history-run",
            expected=2,
        )
        self.assertIn("BROKEN_CONTROLLER_FACTS_CHAIN", blocked["error"])

    def test_controller_facts_cannot_masquerade_as_content_or_bind_other_source(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "facts 边界",
            "--run-id",
            "facts-boundary-run",
        )
        opened = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "facts-boundary-run",
            "--dispatch-id",
            "producer-context",
            "--context-id",
            "producer-context",
        )
        producer_facts = Path(opened["allowed_writes_root"]) / "only-facts.json"
        rejected = self.command(
            "measure-artifact",
            project,
            "--source",
            "creative-system/creative-charter.md",
            "--output",
            producer_facts,
            expected=2,
        )
        self.assertIn("不得进入 Producer allowed-writes root", rejected["error"])
        self.assertFalse((project / producer_facts).exists())

        content = project / opened["allowed_writes_root"] / "work.md"
        content.write_text("本次内容\n", encoding="utf-8")
        attempt_relative = Path(started["attempt_path"])
        self.command(
            "measure-artifact",
            project,
            "--source",
            "creative-system/creative-charter.md",
            "--output",
            attempt_relative / "controller-facts" / "wrong-source.json",
        )
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "facts-boundary-run",
            "--dispatch-id",
            "producer-context",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            expected=2,
        )
        self.assertIn("UNBOUND_CONTROLLER_FACTS", blocked["error"])
        run = self.read_json(project / "creative-system/runs/facts-boundary-run/run.json")
        self.assertEqual(run["attempts"], [])

    def test_measure_artifact_cannot_modify_sealed_attempt(self):
        project = self.init_project()
        sealed = self.seal_run(project, 1)
        attempt = Path(sealed["manifest"]).parent
        before = self.tree_hashes(project / attempt)
        blocked = self.command(
            "measure-artifact",
            project,
            "--source",
            attempt / "artifacts" / "work.md",
            "--output",
            attempt / "controller-facts" / "late.json",
            expected=2,
        )
        self.assertIn("已封存 attempt", blocked["error"])
        self.assertEqual(self.tree_hashes(project / attempt), before)
        self.assertEqual(self.command("validate", project)["status"], "PASS")

    @unittest.skipIf(os.name == "nt", "Windows CI 不保证允许创建符号链接")
    def test_measure_artifact_rejects_source_and_output_symlinks(self):
        project = self.init_project()
        real_source = project / "outputs" / "real.md"
        real_source.parent.mkdir(parents=True, exist_ok=True)
        real_source.write_text("正文\n", encoding="utf-8")
        source_link = project / "outputs" / "linked.md"
        source_link.symlink_to(real_source)
        blocked_source = self.command(
            "measure-artifact",
            project,
            "--source",
            "outputs/linked.md",
            "--output",
            "creative-system/runs/source-link.json",
            expected=2,
        )
        self.assertIn("符号链接", blocked_source["error"])

        real_output_dir = project / "creative-system" / "real-facts"
        real_output_dir.mkdir()
        output_link = project / "creative-system" / "linked-facts"
        output_link.symlink_to(real_output_dir, target_is_directory=True)
        blocked_output = self.command(
            "measure-artifact",
            project,
            "--source",
            "outputs/real.md",
            "--output",
            "creative-system/linked-facts/facts.json",
            expected=2,
        )
        self.assertIn("符号链接", blocked_output["error"])
        self.assertFalse((real_output_dir / "facts.json").exists())

    @unittest.skipIf(os.name == "nt", "Windows CI 不保证允许创建符号链接")
    def test_mutations_reject_symlinked_control_and_run_roots(self):
        project = self.init_project("control-link-project")
        outside_control = self.root / "outside-control"
        outside_control.mkdir()
        control = project / "creative-system/control"
        saved_control = project / "creative-system/control-real"
        control.rename(saved_control)
        control.symlink_to(outside_control, target_is_directory=True)
        blocked_control = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "控制面越界",
            "--run-id",
            "control-escape",
            expected=2,
        )
        self.assertIn("符号链接", blocked_control["error"])
        self.assertEqual(list(outside_control.iterdir()), [])

        run_project = self.init_project("run-link-project")
        outside_run = self.root / "outside-run"
        outside_run.mkdir()
        run_link = run_project / "creative-system/runs/escaped-run"
        run_link.symlink_to(outside_run, target_is_directory=True)
        blocked_run = self.command(
            "begin-run",
            run_project,
            "--loop",
            "main-loop",
            "--task",
            "运行目录越界",
            "--run-id",
            "escaped-run",
            expected=2,
        )
        self.assertIn("符号链接", blocked_run["error"])
        self.assertEqual(list(outside_run.iterdir()), [])

    @unittest.skipIf(os.name == "nt", "Windows CI 不保证允许创建符号链接")
    def test_init_rejects_symlink_target_without_touching_destination(self):
        destination = self.root / "real-destination"
        destination.mkdir()
        marker = destination / "keep.txt"
        marker.write_text("keep", encoding="utf-8")
        link = self.root / "linked-destination"
        link.symlink_to(destination, target_is_directory=True)

        blocked = self.command(
            "init",
            link,
            "--project-name",
            "X",
            "--creative-goal",
            "G",
            "--minimum-product",
            "M",
            "--representative-task",
            "T",
            "--constraints",
            "C",
            "--taste",
            "P",
            "--domain-skill",
            "domain-loop",
            expected=2,
        )
        self.assertIn("符号链接", blocked["error"])
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_unconfirmed_charter_stops_at_needs_taste(self):
        project = self.init_project(confirmed=False)
        audit = self.command("audit", project)
        self.assertEqual(audit["status"], "NEEDS_TASTE")
        self.assertEqual(audit["provable_maturity"], "NONE")
        blocked = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "未确认任务",
            expected=2,
        )
        self.assertIn("NEEDS_TASTE", blocked["error"])

    def test_bare_charter_confirmed_flag_fails_before_creating_target(self):
        target = self.root / "unsafe-confirmed"
        blocked = self.command(
            "init",
            target,
            "--project-name",
            "X",
            "--creative-goal",
            "G",
            "--minimum-product",
            "M",
            "--representative-task",
            "T",
            "--constraints",
            "C",
            "--taste",
            "P",
            "--domain-skill",
            "domain-loop",
            "--charter-confirmed",
            expected=2,
        )
        self.assertIn("不得代签", blocked["error"])
        self.assertFalse(target.exists())

    def test_init_can_bind_preexisting_external_charter_confirmation(self):
        target = self.root / "safe-confirmed"
        external_evidence = self.root / "explicit-user-confirmation.md"
        external_evidence.write_text("用户已阅读并在当前交互明确确认。\n", encoding="utf-8")
        result = self.command(
            "init",
            target,
            "--project-name",
            "X",
            "--creative-goal",
            "G",
            "--minimum-product",
            "M",
            "--representative-task",
            "T",
            "--constraints",
            "C",
            "--taste",
            "P",
            "--domain-skill",
            "domain-loop",
            "--charter-confirmed",
            "--charter-confirmed-by",
            "test-project-owner",
            "--charter-confirmed-at",
            "2000-01-01T00:00:00Z",
            "--charter-confirmation-evidence",
            external_evidence,
        )
        self.assertEqual(result["provable_maturity"], "L0")
        system = self.read_json(target / "creative-system/system.json")
        self.assertTrue(system["charter"]["confirmed"])
        self.assertTrue((target / system["charter"]["confirmation_receipt"]).is_file())
        self.assertEqual(self.command("validate", target)["status"], "PASS")

    def test_confirm_charter_receipt_is_idempotent_and_binds_current_charter(self):
        project = self.init_project(confirmed=False)
        evidence = (
            project
            / "creative-system/approvals/charter-confirmations/evidence/explicit-confirmation.md"
        )
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text("项目所有者在本轮明确回复：确认。\n", encoding="utf-8")
        arguments = [
            "confirm-charter",
            project,
            "--confirmed-by",
            "test-project-owner",
            "--confirmed-at",
            "2000-01-01T00:00:00Z",
            "--evidence",
            evidence.relative_to(project),
        ]
        first = self.command(*arguments)
        self.assertFalse(first.get("idempotent", False))
        second = self.command(*arguments)
        self.assertTrue(second["idempotent"])
        system = self.read_json(project / "creative-system/system.json")
        receipt = project / system["charter"]["confirmation_receipt"]
        self.assertTrue(receipt.is_file())
        self.assertEqual(self.command("audit", project)["provable_maturity"], "L0")

        charter = project / "creative-system/creative-charter.md"
        charter.write_text(charter.read_text(encoding="utf-8") + "\n事后改写\n", encoding="utf-8")
        report = self.command("validate", project, expected=1)
        self.assertTrue(any("charter 哈希不一致" in item for item in report["errors"]))
        audit = self.command("audit", project, expected=1)
        self.assertEqual(audit["provable_maturity"], "NONE")

        old_receipt = receipt
        new_evidence = evidence.parent / "reconfirmation.md"
        new_evidence.write_text("项目所有者明确确认修改后的新宪法。\n", encoding="utf-8")
        reconfirmed = self.command(
            "confirm-charter",
            project,
            "--confirmed-by",
            "test-project-owner",
            "--confirmed-at",
            "2000-01-02T00:00:00Z",
            "--evidence",
            new_evidence.relative_to(project),
        )
        self.assertNotEqual(reconfirmed["confirmation_receipt"], old_receipt.relative_to(project).as_posix())
        self.assertTrue(old_receipt.is_file())
        self.assertEqual(self.command("audit", project)["provable_maturity"], "L0")

        old_value = self.read_json(old_receipt)
        old_value["confirmed_by"] = "tampered-history"
        self.write_json(old_receipt, old_value)
        historical_tamper = self.command("validate", project, expected=1)
        self.assertTrue(
            any(
                "确认凭证哈希不一致" in item or "路径与内容摘要不一致" in item
                for item in historical_tamper["errors"]
            )
        )

    def test_git_round_trip_preserves_project_and_reports_local_evidence_warning(self):
        project = self.init_project()
        system = self.read_json(project / "creative-system/system.json")
        receipt = self.read_json(project / system["charter"]["confirmation_receipt"])
        evidence_relative = receipt["evidence"]["path"]
        evidence_bytes = (project / evidence_relative).read_bytes()
        markers = (
            "inputs/.gitkeep",
            "outputs/.gitkeep",
            "creative-system/evals/development/.gitkeep",
            "creative-system/evals/heldout/.gitkeep",
            "creative-system/memory/.gitkeep",
            "creative-system/runs/.gitkeep",
            "creative-system/candidates/.gitkeep",
            "creative-system/releases/.gitkeep",
            "creative-system/control/transactions/.gitkeep",
            "creative-system/approvals/charter-confirmations/evidence/.gitkeep",
            "creative-system/approvals/attempt-feedback/.gitkeep",
        )
        for relative in markers:
            self.assertTrue((project / relative).is_file(), relative)

        subprocess.run(["git", "init", "--quiet"], cwd=project, check=True)
        subprocess.run(["git", "add", "--all"], cwd=project, check=True)
        subprocess.run(
            [
                "git",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Loop Test",
                "-c",
                "user.email=loop-test@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "round trip fixture",
            ],
            cwd=project,
            check=True,
        )
        clone = self.root / "round-trip-clone"
        subprocess.run(["git", "clone", "--quiet", str(project), str(clone)], check=True)
        self.assertFalse((clone / evidence_relative).exists())
        cloned = self.command("validate", clone)
        self.assertEqual(cloned["status"], "PASS")
        self.assertIn("LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE", cloned["warnings"])

        (clone / evidence_relative).write_bytes(evidence_bytes)
        restored = self.command("validate", clone)
        self.assertNotIn("LOCAL_CONFIRMATION_EVIDENCE_UNAVAILABLE", restored["warnings"])
        (clone / evidence_relative).write_text("确认原文已被改写。\n", encoding="utf-8")
        changed = self.command("validate", clone, expected=1)
        self.assertTrue(any("evidence 哈希不一致" in item for item in changed["errors"]))

    def test_local_confirmation_evidence_directory_and_symlink_still_block(self):
        project = self.init_project()
        system = self.read_json(project / "creative-system/system.json")
        receipt = self.read_json(project / system["charter"]["confirmation_receipt"])
        evidence = project / receipt["evidence"]["path"]
        evidence.unlink()
        evidence.mkdir()
        directory = self.command("validate", project, expected=1)
        self.assertTrue(any("普通文件" in item for item in directory["errors"]))
        evidence.rmdir()
        target = evidence.parent / "symlink-target.md"
        target.write_text("项目所有者确认。\n", encoding="utf-8")
        evidence.symlink_to(target)
        linked = self.command("validate", project, expected=1)
        self.assertTrue(any("符号链接" in item for item in linked["errors"]))

    def test_unledgered_confirmation_blocks_validate_and_matching_retry_recovers(self):
        project = self.init_project(confirmed=False)
        evidence = project / (
            "creative-system/approvals/charter-confirmations/evidence/orphan-confirmation.md"
        )
        evidence.write_text("项目所有者明确确认当前创作宪法。\n", encoding="utf-8")
        arguments = (
            "confirm-charter",
            project,
            "--confirmed-by",
            "test-project-owner",
            "--confirmed-at",
            "2000-01-01T00:00:00Z",
            "--evidence",
            evidence.relative_to(project),
        )
        first = self.command(*arguments)
        self.clear_charter_confirmation_ledger(project)
        self.clear_charter_confirmation_mirror(project)
        blocked = self.command("validate", project, expected=1)
        self.assertTrue(
            any("UNLEDGERED_CHARTER_CONFIRMATION" in item for item in blocked["errors"])
        )
        recovered = self.command(*arguments)
        self.assertEqual(recovered["recovered"], "orphan-receipt")
        self.assertEqual(recovered["confirmation_receipt"], first["confirmation_receipt"])
        self.assertEqual(self.command("validate", project)["status"], "PASS")

    def test_ledger_ahead_recovery_and_default_retry_are_idempotent(self):
        project = self.init_project(confirmed=False)
        evidence = project / (
            "creative-system/approvals/charter-confirmations/evidence/ledger-ahead.md"
        )
        evidence.write_text("项目所有者明确确认当前创作宪法。\n", encoding="utf-8")
        explicit = (
            "confirm-charter",
            project,
            "--confirmed-by",
            "test-project-owner",
            "--confirmed-at",
            "2000-01-01T00:00:00Z",
            "--evidence",
            evidence.relative_to(project),
        )
        first = self.command(*explicit)
        self.clear_charter_confirmation_mirror(project)
        recovered = self.command(*explicit)
        self.assertEqual(recovered["recovered"], "ledger-ahead-system")
        self.assertEqual(recovered["confirmation_receipt"], first["confirmation_receipt"])

        retry_project = self.init_project("default-time-retry", confirmed=False)
        retry_evidence = retry_project / (
            "creative-system/approvals/charter-confirmations/evidence/default-time.md"
        )
        retry_evidence.write_text("项目所有者明确确认当前创作宪法。\n", encoding="utf-8")
        default_arguments = (
            "confirm-charter",
            retry_project,
            "--confirmed-by",
            "test-project-owner",
            "--evidence",
            retry_evidence.relative_to(retry_project),
        )
        default_first = self.command(*default_arguments)
        default_second = self.command(*default_arguments)
        self.assertTrue(default_second["idempotent"])
        self.assertEqual(
            default_second["confirmation_receipt"], default_first["confirmation_receipt"]
        )
        ledger = self.read_json(
            retry_project / "creative-system/approvals/charter-confirmations/ledger.json"
        )
        self.assertEqual(len(ledger["entries"]), 1)

    def test_confirm_charter_blocks_unrelated_and_multiple_orphans(self):
        project = self.init_project(confirmed=False)
        evidence = project / (
            "creative-system/approvals/charter-confirmations/evidence/original.md"
        )
        evidence.write_text("项目所有者确认原始依据。\n", encoding="utf-8")
        self.command(
            "confirm-charter",
            project,
            "--confirmed-by",
            "test-project-owner",
            "--confirmed-at",
            "2000-01-01T00:00:00Z",
            "--evidence",
            evidence.relative_to(project),
        )
        self.clear_charter_confirmation_ledger(project)
        self.clear_charter_confirmation_mirror(project)
        unrelated_evidence = evidence.parent / "unrelated.md"
        unrelated_evidence.write_text("另一条确认依据。\n", encoding="utf-8")
        unrelated = self.command(
            "confirm-charter",
            project,
            "--confirmed-by",
            "test-project-owner",
            "--evidence",
            unrelated_evidence.relative_to(project),
            expected=2,
        )
        self.assertIn("不相关", unrelated["error"])

        multiple = self.init_project("multiple-orphans", confirmed=False)
        first_evidence = multiple / (
            "creative-system/approvals/charter-confirmations/evidence/first.md"
        )
        second_evidence = first_evidence.parent / "second.md"
        first_evidence.write_text("第一次明确确认。\n", encoding="utf-8")
        second_evidence.write_text("第二次明确确认。\n", encoding="utf-8")
        for timestamp, source in (
            ("2000-01-01T00:00:00Z", first_evidence),
            ("2000-01-02T00:00:00Z", second_evidence),
        ):
            self.command(
                "confirm-charter",
                multiple,
                "--confirmed-by",
                "test-project-owner",
                "--confirmed-at",
                timestamp,
                "--evidence",
                source.relative_to(multiple),
            )
        self.clear_charter_confirmation_ledger(multiple)
        self.clear_charter_confirmation_mirror(multiple)
        blocked = self.command(
            "confirm-charter",
            multiple,
            "--confirmed-by",
            "test-project-owner",
            "--confirmed-at",
            "2000-01-02T00:00:00Z",
            "--evidence",
            second_evidence.relative_to(multiple),
            expected=2,
        )
        self.assertIn("多个未入账", blocked["error"])

    def test_manual_charter_boolean_cannot_unlock_l0(self):
        project = self.init_project(confirmed=False)
        system_path = project / "creative-system/system.json"
        system = self.read_json(system_path)
        system["charter"].update(
            {
                "confirmed": True,
                "confirmed_by": "forged-user",
                "confirmed_at": "2000-01-01T00:00:00Z",
            }
        )
        self.write_json(system_path, system)
        report = self.command("validate", project, expected=1)
        self.assertTrue(any("confirmation_receipt" in item for item in report["errors"]))
        self.assertEqual(self.command("audit", project, expected=1)["provable_maturity"], "NONE")

    def test_generated_contract_and_domain_skill_shape(self):
        project = self.init_project()
        report = self.command("validate", project)
        self.assertEqual(report["status"], "PASS")
        system = self.read_json(project / "creative-system" / "system.json")
        self.assertIn("charter", system)
        self.assertEqual(system["maturity"]["declared"], "L0")
        runtime_budget = system["recovery_policy"]["runtime_dispatch_budget"]
        self.assertEqual(runtime_budget["max_zero_file_stalls"], 2)
        self.assertFalse(runtime_budget["zero_output_consumes_content_attempt"])
        self.assertEqual(
            system["recovery_policy"]["mechanical_evidence"]["producer_self_report"],
            "non-governing",
        )
        skill = project / "skills" / "paper-lantern-story" / "SKILL.md"
        self.assertTrue(skill.is_file())
        agents_text = (project / "AGENTS.md").read_text(encoding="utf-8")
        skill_text = skill.read_text(encoding="utf-8")
        contract_text = (skill.parent / "references" / "project-contract.md").read_text(encoding="utf-8")
        for text in (agents_text, skill_text, contract_text):
            self.assertIn("ZERO_FILE_DISPATCH_STALL", text)
            self.assertIn("block-seal", text)
        self.assertIn("measure-artifact", skill_text)
        self.assertIn("STALE_OUTPUT_CONTAMINATION", contract_text)
        metadata = (skill.parent / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn("$paper-lantern-story", metadata)
        self.assertIn("policy:\n  allow_implicit_invocation: true", metadata)

    def test_validate_rejects_schema_missing_reference_and_bad_status(self):
        project = self.init_project()
        system_path = project / "creative-system" / "system.json"
        system = self.read_json(system_path)
        system["schema_version"] = "9"
        system["loops"].append("creative-system/loops/missing.json")
        system["statuses"]["release_status"] = "MAYBE"
        self.write_json(system_path, system)
        report = self.command("validate", project, expected=1)
        joined = "\n".join(report["errors"])
        self.assertIn("schema_version", joined)
        self.assertIn("missing.json", joined)
        self.assertIn("release_status", joined)

    def test_validate_rejects_invalid_runtime_and_mechanical_evidence_policy(self):
        project = self.init_project()
        system_path = project / "creative-system" / "system.json"
        system = self.read_json(system_path)
        system["recovery_policy"]["runtime_dispatch_budget"]["max_zero_file_stalls"] = 0
        system["recovery_policy"]["mechanical_evidence"]["producer_self_report"] = "governing"
        self.write_json(system_path, system)
        report = self.command("validate", project, expected=1)
        joined = "\n".join(report["errors"])
        self.assertIn("max_zero_file_stalls", joined)
        self.assertIn("non-governing", joined)

    def test_validate_rejects_l5_as_active_maturity(self):
        project = self.init_project()
        system_path = project / "creative-system" / "system.json"
        system = self.read_json(system_path)
        system["maturity"]["declared"] = "L5"
        self.write_json(system_path, system)

        report = self.command("validate", project, expected=1)
        self.assertTrue(any("L5" in item and "实验候选" in item for item in report["errors"]))

    def test_validate_rejects_duplicate_owner_cycle_and_budget(self):
        project = self.init_project()
        system_path = project / "creative-system" / "system.json"
        system = self.read_json(system_path)
        system["loops"].append("creative-system/loops/conflict.json")
        self.write_json(system_path, system)
        loop = self.read_json(project / "creative-system" / "loops" / "main-loop.json")
        loop["id"] = "conflict-loop"
        loop["reads"] = ["creative-work"]
        loop["retry_budget"]["max_attempts"] = 0
        self.write_json(project / "creative-system" / "loops" / "conflict.json", loop)
        report = self.command("validate", project, expected=1)
        joined = "\n".join(report["errors"])
        self.assertIn("恰好有一个写入 owner", joined)
        self.assertIn("max_attempts", joined)
        self.assertIn("循环依赖", joined)

    def test_validate_rejects_producer_judge_collision_and_protected_overlap(self):
        project = self.init_project()
        judge_path = project / "creative-system" / "judges" / "hard-contract.json"
        judge = self.read_json(judge_path)
        judge["agent"] = "creative-producer"
        self.write_json(judge_path, judge)
        system_path = project / "creative-system" / "system.json"
        system = self.read_json(system_path)
        system["editable_surfaces"].append("creative-system/creative-charter.md")
        self.write_json(system_path, system)
        report = self.command("validate", project, expected=1)
        joined = "\n".join(report["errors"])
        self.assertIn("Producer", joined)
        self.assertIn("重叠", joined)

    def test_sealed_attempt_is_non_overwritable_and_tamper_evident(self):
        project = self.init_project()
        seal = self.seal_run(project, 1, finding=self.finding_file())
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "run-1",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            expected=2,
        )
        self.assertIn("已封存", blocked["error"])
        attempt = project / Path(seal["manifest"]).parent
        (attempt / "after-seal.txt").write_text("tamper", encoding="utf-8")
        report = self.command("validate", project, expected=1)
        self.assertTrue(any("文件集合已改变" in item for item in report["errors"]))

    def test_human_claim_requires_bound_feedback_receipt_and_snapshot(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "人工拒绝也要有依据",
            "--run-id",
            "human-receipt-run",
        )
        attempt = project / started["attempt_path"]
        (attempt / "artifacts/work.md").write_text("待人工判断的成品\n", encoding="utf-8")
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "human-receipt-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "WARN",
            "--decision",
            "stop",
            "--human-accepted",
            "false",
            "--human-direction",
            "BLOCK",
            expected=2,
        )
        self.assertIn("不得代签裸布尔", blocked["error"])
        self.assertFalse((attempt / "manifest.json").exists())

        receipt_args = self.human_feedback_args(
            project, "human-receipt-run", accepted=False, direction="BLOCK"
        )
        receipt_args[3] = "1999-01-01T00:00:00Z"
        early = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "human-receipt-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "WARN",
            "--decision",
            "stop",
            "--human-accepted",
            "false",
            "--human-direction",
            "BLOCK",
            *receipt_args,
            expected=2,
        )
        self.assertIn("不得早于冻结成品", early["error"])

        receipt_args = self.human_feedback_args(
            project, "human-receipt-run", accepted=False, direction="BLOCK"
        )
        sealed = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "human-receipt-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "WARN",
            "--decision",
            "stop",
            "--human-accepted",
            "false",
            "--human-direction",
            "BLOCK",
            *receipt_args,
        )
        manifest = self.read_json(project / sealed["manifest"])
        self.assertEqual(manifest["human_feedback_receipt"]["claims"]["human_direction"], "BLOCK")
        snapshot = attempt / manifest["human_feedback_receipt"]["snapshot"]["path"]
        self.assertTrue(snapshot.is_file())
        snapshot.write_text("事后篡改\n", encoding="utf-8")
        report = self.command("validate", project, expected=1)
        self.assertTrue(any("human feedback snapshot 哈希不一致" in item for item in report["errors"]))

    def test_human_feedback_evidence_must_be_in_protected_approval_inbox(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "错误反馈路径",
            "--run-id",
            "bad-feedback-path",
        )
        attempt = project / started["attempt_path"]
        (attempt / "artifacts/work.md").write_text("成品\n", encoding="utf-8")
        bad_evidence = project / "inputs/agent-authored-feedback.md"
        bad_evidence.write_text("伪装成人工反馈\n", encoding="utf-8")
        opened_at = self.read_json(attempt / "attempt.json")["opened_at"]
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "bad-feedback-path",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            "--human-feedback-by",
            "test-project-owner",
            "--human-feedback-at",
            opened_at,
            "--human-feedback-evidence",
            bad_evidence.relative_to(project),
            expected=2,
        )
        self.assertIn("creative-system/approvals/attempt-feedback", blocked["error"])
        self.assertFalse((attempt / "manifest.json").exists())

    def test_human_feedback_requires_frozen_review_subject_and_machine_direction(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "先送审再反馈",
            "--run-id",
            "review-order-run",
        )
        attempt = project / started["attempt_path"]
        (attempt / "artifacts/work.md").write_text("冻结版本\n", encoding="utf-8")
        evidence_relative = Path("creative-system/approvals/attempt-feedback/review-order.md")
        evidence = project / evidence_relative
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text("用户认可冻结版本。\n", encoding="utf-8")
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "review-order-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            "--machine-direction",
            "PASS",
            "--human-feedback-by",
            "test-project-owner",
            "--human-feedback-at",
            self.read_json(attempt / "attempt.json")["opened_at"],
            "--human-feedback-evidence",
            evidence_relative,
            expected=2,
        )
        self.assertIn("open-human-review", blocked["error"])

        feedback = self.human_feedback_args(
            project,
            "review-order-run",
            machine_direction="PASS",
        )
        mismatched = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "review-order-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            "--machine-direction",
            "BLOCK",
            *feedback,
            expected=2,
        )
        self.assertIn("人工反馈前冻结", mismatched["error"])
        sealed = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "review-order-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            "--machine-direction",
            "PASS",
            *feedback,
        )
        manifest = self.read_json(project / sealed["manifest"])
        self.assertEqual(manifest["machine_direction"], "PASS")
        self.assertIn("review_subject_sha256", manifest["human_feedback_receipt"]["subject"])

    def test_human_review_rejects_early_feedback_and_changed_artifact(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "冻结版本不可偷换",
            "--run-id",
            "review-stale-run",
        )
        attempt = project / started["attempt_path"]
        work = attempt / "artifacts/work.md"
        work.write_text("送审原版\n", encoding="utf-8")
        feedback = self.human_feedback_args(project, "review-stale-run")
        attempt_opened = self.read_json(attempt / "attempt.json")["opened_at"]
        early = list(feedback)
        early[3] = attempt_opened
        blocked_early = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "review-stale-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            *early,
            expected=2,
        )
        self.assertIn("不得早于冻结成品", blocked_early["error"])

        work.write_text("反馈后偷换版\n", encoding="utf-8")
        blocked_stale = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "review-stale-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            *feedback,
            expected=2,
        )
        self.assertIn("HUMAN_REVIEW_SUBJECT_STALE", blocked_stale["error"])
        self.assertFalse((attempt / "manifest.json").exists())

        work.write_text("送审原版\n", encoding="utf-8")
        sealed = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "review-stale-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            *feedback,
        )
        receipt = self.read_json(project / sealed["manifest"])["human_feedback_receipt"]
        anchor = project / receipt["subject"]["review_open_anchor_path"]
        anchor_value = self.read_json(anchor)
        anchor_value["review_available_at"] = "1999-01-01T00:00:00Z"
        self.write_json(anchor, anchor_value)
        report = self.command("validate", project, expected=1)
        self.assertTrue(any("OpenAnchor" in item for item in report["errors"]))

    def test_zero_file_cannot_open_human_review(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "零文件不可送审",
            "--run-id",
            "empty-review-run",
        )
        blocked = self.command(
            "open-human-review",
            project,
            "--run-id",
            "empty-review-run",
            expected=2,
        )
        self.assertIn("ZERO_FILE_DISPATCH_STALL", blocked["error"])

    def test_zero_file_cannot_consume_content_attempt(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "零文件防误记",
            "--run-id",
            "zero-file-run",
        )
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "zero-file-run",
            "--execution-status",
            "BLOCK",
            "--quality-status",
            "NOT_EVALUATED",
            "--decision",
            "escalate",
            expected=2,
        )
        self.assertIn("ZERO_FILE_DISPATCH_STALL", blocked["error"])
        run_path = project / "creative-system/runs/zero-file-run/run.json"
        run = self.read_json(run_path)
        self.assertEqual(run["attempts"], [])
        self.assertEqual(run["current_attempt"], "attempt-001")
        attempt = project / started["attempt_path"]
        self.assertFalse((attempt / "manifest.json").exists())
        self.assertFalse((attempt / ".sealed.json").exists())

        (attempt / "artifacts" / "work.md").write_text("恢复后成品\n", encoding="utf-8")
        sealed = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "zero-file-run",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            *self.human_feedback_args(project, "zero-file-run"),
        )
        manifest = self.read_json(project / sealed["manifest"])
        self.assertEqual(manifest["artifact_file_count"], 1)
        self.assertEqual(self.read_json(run_path)["attempts"], ["attempt-001"])

    def test_independent_dispatch_stall_budget_and_zero_byte_semantics(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "独立 dispatch 恢复",
            "--run-id",
            "dispatch-run",
        )
        first = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "dispatch-run",
            "--dispatch-id",
            "producer-one",
            "--context-id",
            "context-one",
        )
        self.assertTrue((project / first["allowed_writes_root"]).is_dir())
        stall = self.command(
            "record-dispatch-stall",
            project,
            "--run-id",
            "dispatch-run",
            "--dispatch-id",
            "producer-one",
            "--context-stopped",
            "--reason",
            "Agent context 已结束且未写文件",
        )
        self.assertFalse(stall["content_attempt_consumed"])
        run_path = project / "creative-system/runs/dispatch-run/run.json"
        self.assertEqual(self.read_json(run_path)["attempts"], [])

        second = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "dispatch-run",
            "--dispatch-id",
            "producer-two",
            "--context-id",
            "context-two",
        )
        zero_byte = project / second["allowed_writes_root"] / "work.md"
        zero_byte.write_bytes(b"")
        not_a_stall = self.command(
            "record-dispatch-stall",
            project,
            "--run-id",
            "dispatch-run",
            "--dispatch-id",
            "producer-two",
            "--context-stopped",
            "--reason",
            "存在零字节文件",
            expected=2,
        )
        self.assertIn("已有 1 个普通文件", not_a_stall["error"])
        sealed = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "dispatch-run",
            "--dispatch-id",
            "producer-two",
            "--execution-status",
            "BLOCK",
            "--quality-status",
            "WARN",
            "--decision",
            "stop",
        )
        manifest = self.read_json(project / sealed["manifest"])
        self.assertEqual(manifest["dispatch_id"], "producer-two")
        self.assertEqual(manifest["artifact_file_count"], 1)
        self.assertEqual(manifest["artifact_files"][0]["bytes"], 0)
        self.assertEqual(self.read_json(run_path)["attempts"], ["attempt-001"])

    def test_runtime_budget_exhaustion_does_not_append_content_attempt(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "runtime 预算",
            "--run-id",
            "budget-run",
        )
        for index in (1, 2):
            dispatch_id = "dispatch-{}".format(index)
            self.command(
                "open-dispatch",
                project,
                "--run-id",
                "budget-run",
                "--dispatch-id",
                dispatch_id,
                "--context-id",
                "context-{}".format(index),
            )
            result = self.command(
                "record-dispatch-stall",
                project,
                "--run-id",
                "budget-run",
                "--dispatch-id",
                dispatch_id,
                "--context-stopped",
                "--reason",
                "没有写入",
                expected=0 if index == 1 else 1,
            )
        self.assertEqual(result["state"], "BUDGET_EXHAUSTED")
        self.assertFalse(result["content_attempt_consumed"])
        run = self.read_json(project / "creative-system/runs/budget-run/run.json")
        self.assertEqual(run["attempts"], [])
        self.assertEqual(run["current_attempt"], "attempt-001")
        system_path = project / "creative-system/system.json"
        system = self.read_json(system_path)
        system["recovery_policy"]["runtime_dispatch_budget"]["max_zero_file_stalls"] = 3
        self.write_json(system_path, system)
        self.assertEqual(self.command("validate", project)["status"], "PASS")
        refused = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "budget-run",
            "--dispatch-id",
            "dispatch-three",
            "--context-id",
            "context-three",
            expected=2,
        )
        self.assertIn("BUDGET_EXHAUSTED", refused["error"])

    def test_late_write_to_stalled_dispatch_invalidates_attempt(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "迟到写入检测",
            "--run-id",
            "late-write-run",
        )
        first = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "late-write-run",
            "--dispatch-id",
            "old-context",
            "--context-id",
            "old-context",
        )
        self.command(
            "record-dispatch-stall",
            project,
            "--run-id",
            "late-write-run",
            "--dispatch-id",
            "old-context",
            "--context-stopped",
            "--reason",
            "停止时精确零文件",
        )
        second = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "late-write-run",
            "--dispatch-id",
            "fresh-context",
            "--context-id",
            "fresh-context",
        )
        (project / second["allowed_writes_root"] / "work.md").write_text("新输出\n", encoding="utf-8")
        (project / first["allowed_writes_root"] / "late.md").write_text("迟到输出\n", encoding="utf-8")
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "late-write-run",
            "--dispatch-id",
            "fresh-context",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            expected=2,
        )
        self.assertIn("LATE_WRITE_CONTAMINATION", blocked["error"])
        run = self.read_json(project / "creative-system/runs/late-write-run/run.json")
        self.assertEqual(run["attempts"], [])
        (project / first["allowed_writes_root"] / "late.md").unlink()
        still_blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "late-write-run",
            "--dispatch-id",
            "fresh-context",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            "--human-accepted",
            "true",
            expected=2,
        )
        self.assertIn("attempt 已永久失效", still_blocked["error"])
        marker = project / "creative-system/runs/late-write-run/control/terminal-invalid/attempt-001.json"
        self.assertTrue(marker.is_file())

    def test_forged_dispatch_stall_record_cannot_bypass_runtime_budget(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "伪造 stall 防护",
            "--run-id",
            "forged-stall-run",
        )
        opened = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "forged-stall-run",
            "--dispatch-id",
            "forged-one",
            "--context-id",
            "forged-context",
        )
        dispatch_dir = (project / opened["allowed_writes_root"]).parent
        self.write_json(dispatch_dir / "stall.json", {"state": "RECORDED"})
        blocked = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "forged-stall-run",
            "--dispatch-id",
            "next-one",
            "--context-id",
            "next-context",
            expected=2,
        )
        self.assertIn("dispatch stall record 无效", blocked["error"])

    def test_concurrent_open_and_seal_have_single_winner(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "并发 open",
            "--run-id",
            "concurrent-open-run",
        )
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        open_commands = [
            [
                sys.executable,
                str(SCRIPT),
                "open-dispatch",
                str(project),
                "--run-id",
                "concurrent-open-run",
                "--dispatch-id",
                "dispatch-{}".format(index),
                "--context-id",
                "context-{}".format(index),
            ]
            for index in (1, 2)
        ]
        processes = [
            subprocess.Popen(command, cwd=str(REPO), env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for command in open_commands
        ]
        open_results = [process.communicate(timeout=20) + (process.returncode,) for process in processes]
        self.assertEqual(sorted(item[2] for item in open_results), [0, 2], msg=str(open_results))
        dispatches = list(
            (project / "creative-system/runs/concurrent-open-run/attempts/attempt-001/dispatches").iterdir()
        )
        self.assertEqual(len(dispatches), 1)

        seal_project = self.init_project("seal-project")
        started = self.command(
            "begin-run",
            seal_project,
            "--loop",
            "main-loop",
            "--task",
            "并发 seal",
            "--run-id",
            "concurrent-seal-run",
        )
        (seal_project / started["attempt_path"] / "artifacts" / "work.md").write_text(
            "并发封存内容\n", encoding="utf-8"
        )
        base = [
            sys.executable,
            str(SCRIPT),
            "seal-attempt",
            str(seal_project),
            "--run-id",
            "concurrent-seal-run",
        ]
        feedback_args = self.human_feedback_args(
            seal_project, "concurrent-seal-run", accepted=True
        )
        seal_commands = [
            base
            + [
                "--execution-status",
                execution,
                "--quality-status",
                quality,
                "--decision",
                decision,
                "--human-accepted",
                accepted,
                *feedback_args,
            ]
            for execution, quality, decision, accepted in (
                ("PASS", "PASS", "commit", "true"),
                ("BLOCK", "WARN", "stop", "false"),
            )
        ]
        processes = [
            subprocess.Popen(command, cwd=str(REPO), env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for command in seal_commands
        ]
        seal_results = [process.communicate(timeout=20) + (process.returncode,) for process in processes]
        self.assertEqual(sorted(item[2] for item in seal_results), [0, 2], msg=str(seal_results))
        self.assertEqual(self.command("validate", seal_project)["status"], "PASS")
        run = self.read_json(seal_project / "creative-system/runs/concurrent-seal-run/run.json")
        self.assertEqual(run["attempts"], ["attempt-001"])

    def test_project_mutation_lock_is_shared_and_crash_safe_file_is_not_replaced(self):
        project = self.init_project()
        spec = importlib.util.spec_from_file_location("loopctl_lock_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        lock_path = project / "creative-system/control/locks/project-mutation.lock"
        before = lock_path.read_bytes()
        with module.exclusive_controller_lock(module.project_root(str(project))):
            blocked = self.command(
                "begin-run",
                project,
                "--loop",
                "main-loop",
                "--task",
                "锁内不得并发写",
                "--run-id",
                "locked-run",
                expected=2,
            )
            self.assertIn("CONTROLLER_BUSY", blocked["error"])
            self.assertFalse((project / "creative-system/runs/locked-run").exists())
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "锁内不得并发写",
            "--run-id",
            "locked-run",
        )
        self.assertEqual(started["run_id"], "locked-run")
        self.assertEqual(lock_path.read_bytes(), before)

    def test_late_write_during_seal_commit_never_consumes_attempt(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "seal commit 竞态",
            "--run-id",
            "commit-race-run",
        )
        old_dispatch = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "commit-race-run",
            "--dispatch-id",
            "old-dispatch",
            "--context-id",
            "old-context",
        )
        self.command(
            "record-dispatch-stall",
            project,
            "--run-id",
            "commit-race-run",
            "--dispatch-id",
            "old-dispatch",
            "--context-stopped",
            "--reason",
            "旧上下文已停止且精确零文件",
        )
        new_dispatch = self.command(
            "open-dispatch",
            project,
            "--run-id",
            "commit-race-run",
            "--dispatch-id",
            "new-dispatch",
            "--context-id",
            "new-context",
        )
        (project / new_dispatch["allowed_writes_root"] / "work.md").write_text(
            "可封存内容\n", encoding="utf-8"
        )

        spec = importlib.util.spec_from_file_location("loopctl_commit_race_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        self.assertIsNotNone(spec.loader)
        spec.loader.exec_module(module)
        original_create = module.atomic_create_json
        injected = {"done": False}
        old_root = project / old_dispatch["allowed_writes_root"]

        def inject_late_write(path, value):
            if (
                not injected["done"]
                and Path(path).name == "manifest.json"
                and Path(path).parent.name == "attempt-001"
            ):
                injected["done"] = True
                (old_root / "late.md").write_text("迟到写入\n", encoding="utf-8")
            return original_create(path, value)

        module.atomic_create_json = inject_late_write
        args = module.build_parser().parse_args(
            [
                "seal-attempt",
                str(project),
                "--run-id",
                "commit-race-run",
                "--dispatch-id",
                "new-dispatch",
                "--execution-status",
                "PASS",
                "--quality-status",
                "PASS",
                "--decision",
                "commit",
            ]
        )
        with self.assertRaises(module.LoopCtlError) as raised:
            args.handler(args)
        self.assertIn("LATE_WRITE_CONTAMINATION", str(raised.exception))
        run = self.read_json(project / "creative-system/runs/commit-race-run/run.json")
        self.assertEqual(run["attempts"], [])
        self.assertEqual(run["current_attempt"], "attempt-001")
        self.assertTrue(
            (
                project
                / "creative-system/runs/commit-race-run/control/terminal-invalid/attempt-001.json"
            ).is_file()
        )
    def test_release_pass_requires_human_and_statuses_stay_separate(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "状态任务",
            "--run-id",
            "run-state",
        )
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "run-state",
            "--execution-status",
            "PASS",
            "--quality-status",
            "WARN",
            "--release-status",
            "PASS",
            "--decision",
            "commit",
            expected=2,
        )
        self.assertIn("人工认可", blocked["error"])
        system = self.read_json(project / "creative-system" / "system.json")
        self.assertEqual(system["statuses"]["execution_status"], "RUNNING")
        self.assertEqual(system["statuses"]["quality_status"], "NOT_EVALUATED")

    def test_local_recovery_records_parent_without_overwriting(self):
        project = self.init_project()
        self.seal_run(project, 1)
        result = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "局部恢复任务",
            "--run-id",
            "run-recovery",
            "--recovery-of",
            "run-1",
        )
        run = self.read_json(project / "creative-system" / "runs" / result["run_id"] / "run.json")
        self.assertEqual(run["recovery_of"], "run-1")
        self.assertTrue((project / "creative-system" / "runs" / "run-1" / "run.json").is_file())

    def test_audit_advances_l1_and_l2_only_with_evidence(self):
        project = self.init_project()
        for number in range(1, 4):
            self.seal_run(project, number, accepted=number <= 2, recovery=number == 1)
        self.assertEqual(self.command("audit", project)["provable_maturity"], "L1")
        for number in range(4, 6):
            self.seal_run(project, number, accepted=True)
        audit = self.command("audit", project)
        self.assertEqual(audit["provable_maturity"], "L2")
        self.assertGreaterEqual(audit["evidence"]["human_machine_direction_agreement"], 0.8)

    def test_synthetic_runs_do_not_count_as_maturity_or_learning_evidence(self):
        project = self.init_project()
        finding = self.finding_file()
        for number in range(1, 4):
            run_id = "synthetic-{}".format(number)
            begin = self.command(
                "begin-run",
                project,
                "--loop",
                "main-loop",
                "--task",
                "演示任务 {}".format(number),
                "--run-id",
                run_id,
                "--synthetic",
            )
            attempt = project / begin["attempt_path"]
            (attempt / "artifacts" / "work.md").write_text("演示成品\n", encoding="utf-8")
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
                "--human-accepted",
                "true",
                "--machine-direction",
                "PASS",
                "--human-direction",
                "PASS",
                "--improved",
                "true",
                "--finding",
                finding,
                *self.human_feedback_args(project, run_id, machine_direction="PASS"),
            )

        audit = self.command("audit", project)
        self.assertEqual(audit["provable_maturity"], "L0")
        self.assertEqual(audit["evidence"]["sealed_runs"], 0)
        blocked = self.command(
            "create-candidate",
            project,
            "--candidate-id",
            "synthetic-only",
            "--finding-code",
            "PACE-MIDDLE-STALL",
            "--root-cause",
            "假设",
            "--target-component",
            "prompts",
            "--change-summary",
            "修改",
            "--changed-path",
            "skills/paper-lantern-story/references/production-guidance.md",
            "--builder-role-id",
            "candidate-builder",
            "--builder-context-id",
            "synthetic-builder-context",
            "--builder-task-id",
            "synthetic-builder-task",
            "--builder-attested-by",
            "test-orchestrator",
            *BUILDER_INPUT_ARGS,
            expected=2,
        )
        self.assertIn("至少 3 次", blocked["error"])

    def test_candidate_requires_three_independent_real_runs(self):
        project = self.init_project()
        finding = self.finding_file()
        for number in range(1, 3):
            self.seal_run(project, number, finding=finding, recovery=number == 1)
        blocked = self.command(
            "create-candidate",
            project,
            "--candidate-id",
            "too-early",
            "--finding-code",
            "PACE-MIDDLE-STALL",
            "--root-cause",
            "假设",
            "--target-component",
            "prompts",
            "--change-summary",
            "修改",
            "--changed-path",
            "prompts/main.md",
            "--builder-role-id",
            "candidate-builder",
            "--builder-context-id",
            "early-builder-context",
            "--builder-task-id",
            "early-builder-task",
            "--builder-attested-by",
            "test-orchestrator",
            *BUILDER_INPUT_ARGS,
            expected=2,
        )
        self.assertIn("至少 3 次", blocked["error"])

    def test_candidate_builder_attester_cannot_be_known_producer(self):
        project = self.make_l3_project()
        blocked = self.command(
            "create-candidate",
            project,
            "--candidate-id",
            "producer-attested-builder",
            "--finding-code",
            "PACE-MIDDLE-STALL",
            "--root-cause",
            "候选上下文需要更明确的中点约束",
            "--target-component",
            "prompts",
            "--change-summary",
            "增加中点选择约束",
            "--changed-path",
            "skills/paper-lantern-story/references/production-guidance.md",
            "--builder-role-id",
            "candidate-builder",
            "--builder-context-id",
            "producer-attested-builder-context",
            "--builder-task-id",
            "producer-attested-builder-task",
            "--builder-attested-by",
            "creative-producer",
            *BUILDER_INPUT_ARGS,
            "--budget",
            "3",
            expected=2,
        )
        self.assertIn("Builder attester 不得是已知 Producer role", blocked["error"])

    def test_candidate_builder_input_boundary_is_explicit_and_excludes_heldout(self):
        project = self.make_l3_project()
        base_arguments = (
            "create-candidate",
            project,
            "--finding-code",
            "PACE-MIDDLE-STALL",
            "--root-cause",
            "中点约束不足",
            "--target-component",
            "prompts",
            "--change-summary",
            "增加中点选择约束",
            "--changed-path",
            "skills/paper-lantern-story/references/production-guidance.md",
            "--builder-role-id",
            "candidate-builder",
            "--builder-context-id",
            "builder-input-context",
            "--builder-task-id",
            "builder-input-task",
            "--builder-attested-by",
            "test-orchestrator",
            "--budget",
            "3",
        )
        missing = self.command(
            *base_arguments,
            "--candidate-id",
            "missing-builder-boundary",
            expected=2,
        )
        self.assertIn("Builder input_boundary 缺少", missing["error"])

        forbidden = self.command(
            *base_arguments,
            "--candidate-id",
            "heldout-exposed-builder",
            *BUILDER_INPUT_ARGS,
            "--builder-input-boundary",
            "heldout-answer",
            expected=2,
        )
        self.assertIn("Builder input_boundary 含禁止项", forbidden["error"])

    def test_candidate_block_seal_is_irreversible_and_blocks_promotion(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evidence = project / "creative-system/evals/development/final-block.md"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text("候选评价证据边界失效，必须建立后继候选。\n", encoding="utf-8")
        sealed = self.command(
            "block-candidate",
            project,
            "--candidate-id",
            "pace-fix",
            "--reason",
            "最终评价证据失效",
            "--evidence",
            "creative-system/evals/development/final-block.md",
        )
        self.assertEqual(sealed["candidate_status"], "BLOCKED")
        self.assertFalse(sealed["promotion_eligible"])
        blocked_again = self.command(
            "block-candidate",
            project,
            "--candidate-id",
            "pace-fix",
            "--reason",
            "试图覆盖",
            "--evidence",
            "creative-system/evals/development/final-block.md",
            expected=2,
        )
        self.assertIn("只有 CANDIDATE", blocked_again["error"])

        evaluation = evidence
        promotion = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("只有 CANDIDATE", promotion["error"])

        status_path = project / "creative-system/candidates/pace-fix/status.json"
        status = self.read_json(status_path)
        status["status"] = "CANDIDATE"
        self.write_json(status_path, status)
        tampered = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("只有 CANDIDATE", tampered["error"])

    def test_candidate_rejects_protected_surface(self):
        project = self.make_l3_project()
        protected = [
            "creative-system/creative-charter.md",
            "creative-system/evals/heldout/answers.json",
            "inputs/source.md",
            "LICENSE",
            "promotion-policy",
            "human-approval-boundary",
        ]
        for number, changed_path in enumerate(protected, start=1):
            blocked = self.command(
                "create-candidate",
                project,
                "--candidate-id",
                "unsafe-change-{}".format(number),
                "--finding-code",
                "PACE-MIDDLE-STALL",
                "--root-cause",
                "假设",
                "--target-component",
                "prompts",
                "--change-summary",
                "试图修改受保护表面",
                "--changed-path",
                changed_path,
                "--builder-role-id",
                "candidate-builder",
                "--builder-context-id",
                "unsafe-builder-context-{}".format(number),
                "--builder-task-id",
                "unsafe-builder-task-{}".format(number),
                "--builder-attested-by",
                "test-orchestrator",
                *BUILDER_INPUT_ARGS,
                expected=2,
            )
            self.assertIn("受保护表面", blocked["error"])

    def test_l5_candidate_can_never_promote(self):
        project = self.make_l3_project()
        created = self.command(
            "create-candidate",
            project,
            "--candidate-id",
            "judge-experiment",
            "--finding-code",
            "PACE-MIDDLE-STALL",
            "--root-cause",
            "评价机制可能漏掉中段停滞",
            "--target-component",
            "judge",
            "--change-summary",
            "建立隔离的新 Judge 候选",
            "--changed-path",
            "creative-system/judges/experimental-pace.json",
            "--builder-role-id",
            "candidate-builder",
            "--builder-context-id",
            "judge-builder-context",
            "--builder-task-id",
            "judge-builder-task",
            "--builder-attested-by",
            "test-orchestrator",
            *BUILDER_INPUT_ARGS,
        )
        self.assertEqual(created["level"], "L5")
        l5_change = (
            project
            / "creative-system/candidates/judge-experiment/changes/creative-system/judges/experimental-pace.json"
        )
        l5_change.parent.mkdir(parents=True, exist_ok=True)
        self.write_json(l5_change, {"kind": "ExperimentalJudge", "status": "CANDIDATE"})
        evaluation = self.promotion_evaluation(project, "judge-experiment")
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "judge-experiment",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("永不自动晋升", blocked["error"])

    def test_l4_promotion_requires_four_gates_and_rollback_retains_history(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        promoted = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
        )
        self.assertEqual(promoted["active_version"], "pace-fix")
        self.assertEqual(self.command("audit", project)["provable_maturity"], "L4")
        rolled_back = self.command(
            "rollback",
            project,
            "--reason",
            "新版本在长期观察中出现未覆盖风险",
        )
        self.assertEqual(rolled_back["active_version"], "baseline-v1")
        self.assertTrue(rolled_back["history_retained"])
        self.assertTrue((project / rolled_back["rollback_record"]).is_file())
        self.assertEqual(self.command("audit", project)["provable_maturity"], "L3")
        registry = self.read_json(project / "creative-system" / "releases" / "registry.json")
        self.assertEqual([item["action"] for item in registry["history"]], ["promote", "rollback"])
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "回滚后仍可继续运行",
            "--run-id",
            "after-rollback-run",
        )
        self.assertEqual(self.command("validate", project)["status"], "PASS")

    def test_partial_rollback_is_blocked_then_rolls_forward_without_duplicate_history(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
        )

        spec = importlib.util.spec_from_file_location("loopctl_rollback_crash", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        original_atomic_write_json = module.atomic_write_json

        def crash_after_system(path, value):
            original_atomic_write_json(path, value)
            if str(path).endswith("/creative-system/system.json"):
                raise RuntimeError("injected crash after system target")

        module.atomic_write_json = crash_after_system
        arguments = module.argparse.Namespace(
            project=str(project),
            reason="注入崩溃后恢复",
            evidence=None,
            to_version=None,
        )
        with self.assertRaisesRegex(RuntimeError, "injected crash"):
            with module.exclusive_controller_lock(module.project_root(str(project))):
                module.command_rollback_locked(arguments, module.project_root(str(project)))
        module.atomic_write_json = original_atomic_write_json

        blocked = self.command("validate", project, expected=1)
        self.assertTrue(
            any("PENDING_CONTROLLER_TRANSACTION" in item for item in blocked["errors"])
        )
        recovered = self.command(
            "rollback",
            project,
            "--reason",
            "注入崩溃后恢复",
        )
        self.assertTrue(recovered["recovered_partial_commit"])
        self.assertEqual(recovered["active_version"], "baseline-v1")
        self.assertEqual(self.command("validate", project)["status"], "PASS")
        registry = self.read_json(project / "creative-system/releases/registry.json")
        self.assertEqual(
            [item["action"] for item in registry["history"]],
            ["promote", "rollback"],
        )

    def test_promotion_blocks_stale_output_contamination(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation_path = self.promotion_evaluation(project)
        evaluation = self.read_json(evaluation_path)
        evaluation["run_integrity"]["prior_run_outputs_included"] = 1
        evaluation["run_integrity"]["stale_output_contamination"] = True
        self.write_json(evaluation_path, evaluation)
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("STALE_OUTPUT_CONTAMINATION", blocked["error"])
        status = self.read_json(project / "creative-system/candidates/pace-fix/status.json")
        self.assertEqual(status["status"], "BLOCKED")
        self.assertTrue(
            (project / "creative-system/candidates/pace-fix/block-seal.json").is_file()
        )

        evaluation["run_integrity"]["prior_run_outputs_included"] = 0
        evaluation["run_integrity"]["stale_output_contamination"] = False
        self.write_json(evaluation_path, evaluation)
        wash_attempt = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("block-seal evidence 已改变", wash_attempt["error"])
        system = self.read_json(project / "creative-system/system.json")
        self.assertEqual(system["project"]["active_version"], "baseline-v1")

    def test_explicit_failed_eval_cannot_be_rewritten_into_passing_candidate(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation_path = self.promotion_evaluation(project)
        evaluation = self.read_json(evaluation_path)
        evaluation["targeted"]["status"] = "NOT_IMPROVED"
        self.write_json(evaluation_path, evaluation)
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("TARGET_EVAL_FAILED", blocked["error"])

        evaluation["targeted"]["status"] = "IMPROVED"
        self.write_json(evaluation_path, evaluation)
        wash_attempt = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("block-seal evidence 已改变", wash_attempt["error"])

    def test_terminal_contamination_cannot_be_masked_by_other_missing_gates(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation_path = self.promotion_evaluation(project)
        evaluation = self.read_json(evaluation_path)
        evaluation["independent_evaluator"] = False
        evaluation["evaluation_runs"] = 2
        evaluation["human_approval"]["approved"] = False
        evaluation["run_integrity"]["prior_run_outputs_included"] = 1
        evaluation["run_integrity"]["stale_output_contamination"] = True
        self.write_json(evaluation_path, evaluation)
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("STALE_OUTPUT_CONTAMINATION", blocked["error"])
        status = self.read_json(project / "creative-system/candidates/pace-fix/status.json")
        self.assertEqual(status["status"], "BLOCKED")

    def test_empty_eval_run_cannot_be_sealed(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "empty-target-run",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "target-evaluator",
            "--evaluator-context-id",
            "empty-target-context",
            "--evaluator-task-id",
            "empty-target-task",
            "--attested-by",
            "test-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
        )
        blocked = self.command(
            "seal-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "empty-target-run",
            expected=2,
        )
        self.assertIn("EVAL_EMPTY_OUTPUT", blocked["error"])
        self.assertIn("successor candidate", blocked["error"])
        marker = (
            project
            / "creative-system/candidates/pace-fix/control/eval-terminal-invalid/empty-target-run.json"
        )
        self.assertTrue(marker.is_file())
        output_root = (
            project
            / "creative-system/candidates/pace-fix/evaluations/empty-target-run/output"
        )
        (output_root / "late-result.md").write_text("迟到评价\n", encoding="utf-8")
        retry = self.command(
            "seal-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "empty-target-run",
            expected=2,
        )
        self.assertIn("永久失效", retry["error"])

    def test_controller_eval_open_ledger_enforces_budget(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project, budget=3)

        def open_eval(run_id, phase, index, expected=0):
            boundaries = [
                "--input-boundary",
                "creative-charter",
                "--input-boundary",
                "rubric",
                "--input-boundary",
                "baseline-output",
                "--input-boundary",
                "candidate-output",
            ]
            if phase == "heldout":
                boundaries += ["--input-boundary", "heldout-input"]
            return self.command(
                "open-eval-run",
                project,
                "--candidate-id",
                "pace-fix",
                "--eval-run-id",
                run_id,
                "--phase",
                phase,
                "--evaluator-role-id",
                "budget-evaluator-{}".format(index),
                "--evaluator-context-id",
                "budget-context-{}".format(index),
                "--evaluator-task-id",
                "budget-task-{}".format(index),
                "--attested-by",
                "test-orchestrator",
                *boundaries,
                expected=expected,
            )

        for index, (run_id, phase) in enumerate(
            (
                ("selected-target", "targeted"),
                ("selected-regression", "regression"),
                ("selected-heldout", "heldout"),
            ),
            start=1,
        ):
            opened = open_eval(run_id, phase, index)
            (project / opened["output_root"] / "result.md").write_text(
                "评价 {}\n".format(index), encoding="utf-8"
            )
            self.command(
                "seal-eval-run",
                project,
                "--candidate-id",
                "pace-fix",
                "--eval-run-id",
                run_id,
            )
        blocked = open_eval("extra-target", "targeted", 4, expected=2)
        self.assertIn("eval budget 已耗尽", blocked["error"])
        self.assertFalse(
            (project / "creative-system/candidates/pace-fix/evaluations/extra-target").exists()
        )

    def test_sealed_eval_output_is_read_only_even_to_controller_tools(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
        )
        blocked = self.command(
            "measure-artifact",
            project,
            "--source",
            "creative-system/creative-charter.md",
            "--output",
            "creative-system/candidates/pace-fix/evaluations/heldout-run/output/late-facts.json",
            expected=2,
        )
        self.assertIn("已封存 eval run", blocked["error"])
        self.assertEqual(self.command("validate", project)["status"], "PASS")

    def test_open_eval_rejects_symlinked_evaluations_control_plane(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        candidate_root = project / "creative-system/candidates/pace-fix"
        outside = self.root / "outside-evaluations"
        outside.mkdir()
        evaluations = candidate_root / "evaluations"
        try:
            evaluations.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest("host cannot create test symlink: {}".format(exc))
        blocked = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "escaped-target",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "target-evaluator",
            "--evaluator-context-id",
            "target-context",
            "--evaluator-task-id",
            "target-task",
            "--attested-by",
            "test-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
            expected=2,
        )
        self.assertIn("不允许经过符号链接", blocked["error"])
        self.assertEqual(list(outside.iterdir()), [])

    def test_eval_open_anchor_rejects_preseal_receipt_rewrite(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        opened = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "anchored-target-run",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "target-evaluator",
            "--evaluator-context-id",
            "original-target-context",
            "--evaluator-task-id",
            "original-target-task",
            "--attested-by",
            "test-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
        )
        preflight_path = (
            project
            / "creative-system/candidates/pace-fix/evaluations/anchored-target-run/preflight.json"
        )
        preflight = self.read_json(preflight_path)
        preflight["execution_receipt"]["role_id"] = "replacement-evaluator"
        preflight["execution_receipt"]["context_id"] = "replacement-context"
        preflight["execution_receipt"]["task_id"] = "replacement-task"
        canonical = (
            json.dumps(
                preflight["execution_receipt"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        preflight["execution_receipt_sha256"] = hashlib.sha256(canonical).hexdigest()
        self.write_json(preflight_path, preflight)
        (project / opened["output_root"] / "result.md").write_text("评价结果\n", encoding="utf-8")
        blocked = self.command(
            "seal-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "anchored-target-run",
            expected=2,
        )
        self.assertIn("open anchor", blocked["error"])
        self.assertFalse(preflight_path.with_name(".sealed.json").exists())

    def test_eval_change_during_seal_is_terminal_even_after_cleanup(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        opened = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "seal-race-target",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "target-evaluator",
            "--evaluator-context-id",
            "seal-race-context",
            "--evaluator-task-id",
            "seal-race-task",
            "--attested-by",
            "test-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
        )
        output_root = project / opened["output_root"]
        (output_root / "result.md").write_text("初始评价\n", encoding="utf-8")

        spec = importlib.util.spec_from_file_location("loopctl_eval_seal_race_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        self.assertIsNotNone(spec.loader)
        spec.loader.exec_module(module)
        original_create = module.atomic_create_json
        injected = {"done": False}

        def inject_eval_write(path, value):
            if not injected["done"] and Path(path).name == "manifest.json":
                injected["done"] = True
                (output_root / "late.md").write_text("迟到评价\n", encoding="utf-8")
            return original_create(path, value)

        module.atomic_create_json = inject_eval_write
        args = module.build_parser().parse_args(
            [
                "seal-eval-run",
                str(project),
                "--candidate-id",
                "pace-fix",
                "--eval-run-id",
                "seal-race-target",
            ]
        )
        with self.assertRaises(module.LoopCtlError) as raised:
            args.handler(args)
        self.assertIn("EVAL_CHANGED_DURING_SEAL", str(raised.exception))
        marker = (
            project
            / "creative-system/candidates/pace-fix/control/eval-terminal-invalid/seal-race-target.json"
        )
        self.assertTrue(marker.is_file())
        (output_root / "late.md").unlink()
        still_blocked = self.command(
            "seal-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "seal-race-target",
            expected=2,
        )
        self.assertIn("永久失效", still_blocked["error"])
        controller_write = self.command(
            "measure-artifact",
            project,
            "--source",
            "creative-system/creative-charter.md",
            "--output",
            (
                "creative-system/candidates/pace-fix/evaluations/"
                "seal-race-target/output/late-controller-facts.json"
            ),
            expected=2,
        )
        self.assertIn("永久失效", controller_write["error"])

    def test_eval_change_after_seal_file_creation_is_terminal(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        opened = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "post-seal-race-target",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "post-seal-evaluator",
            "--evaluator-context-id",
            "post-seal-context",
            "--evaluator-task-id",
            "post-seal-task",
            "--attested-by",
            "test-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
        )
        output_root = project / opened["output_root"]
        (output_root / "result.md").write_text("初始评价\n", encoding="utf-8")

        spec = importlib.util.spec_from_file_location("loopctl_post_seal_race_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        self.assertIsNotNone(spec.loader)
        spec.loader.exec_module(module)
        original_create = module.atomic_create_json
        injected = {"done": False}

        def inject_after_seal(path, value):
            result = original_create(path, value)
            if not injected["done"] and Path(path).name == ".sealed.json":
                injected["done"] = True
                (output_root / "late-after-seal.md").write_text(
                    "seal 写入后的迟到评价\n", encoding="utf-8"
                )
            return result

        module.atomic_create_json = inject_after_seal
        args = module.build_parser().parse_args(
            [
                "seal-eval-run",
                str(project),
                "--candidate-id",
                "pace-fix",
                "--eval-run-id",
                "post-seal-race-target",
            ]
        )
        with self.assertRaises(module.LoopCtlError) as raised:
            args.handler(args)
        self.assertIn("EVAL_CHANGED_DURING_SEAL", str(raised.exception))
        self.assertIn("successor candidate", str(raised.exception))
        marker = (
            project
            / "creative-system/candidates/pace-fix/control/eval-terminal-invalid/post-seal-race-target.json"
        )
        self.assertTrue(marker.is_file())

    def test_eval_is_bound_to_candidate_change_bytes_at_open(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        change = (
            project
            / "creative-system/candidates/pace-fix/changes/skills/paper-lantern-story/references/production-guidance.md"
        )
        change.write_text(change.read_text(encoding="utf-8") + "\n封存后改写。\n", encoding="utf-8")
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("open anchor", blocked["error"])
        system = self.read_json(project / "creative-system/system.json")
        self.assertEqual(system["project"]["active_version"], "baseline-v1")

    def test_evaluator_receipt_rejects_producer_and_builder_identity(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        producer = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "producer-self-review",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "creative-producer",
            "--evaluator-context-id",
            "producer-context",
            "--evaluator-task-id",
            "producer-task",
            "--attested-by",
            "test-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
            expected=2,
        )
        self.assertIn("Producer role", producer["error"])

        builder_orchestrator_as_evaluator = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "builder-orchestrator-review",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "test-orchestrator",
            "--evaluator-context-id",
            "orchestrator-review-context",
            "--evaluator-task-id",
            "orchestrator-review-task",
            "--attested-by",
            "second-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
            expected=2,
        )
        self.assertIn(
            "evaluator identity 不得复用 candidate Builder orchestrator attester",
            builder_orchestrator_as_evaluator["error"],
        )

        builder_attester = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "builder-attested-review",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "target-evaluator",
            "--evaluator-context-id",
            "target-context",
            "--evaluator-task-id",
            "target-task",
            "--attested-by",
            "candidate-builder",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
            expected=2,
        )
        self.assertIn("attester 不得是 candidate Builder", builder_attester["error"])

        evaluation_path = self.promotion_evaluation(project)
        evaluation = self.read_json(evaluation_path)
        evaluation["evaluator"] = "creative-producer"
        self.write_json(evaluation_path, evaluation)
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("Producer role", blocked["error"])

    def test_evaluator_cannot_reuse_recorded_source_producer_context(self):
        project = self.init_project()
        self.add_second_loop(project)
        finding = self.finding_file()
        for number in range(1, 6):
            run_id = "producer-context-run-{}".format(number)
            started = self.command(
                "begin-run",
                project,
                "--loop",
                "main-loop",
                "--task",
                "Producer context 代表任务 {}".format(number),
                "--run-id",
                run_id,
            )
            opened = self.command(
                "open-dispatch",
                project,
                "--run-id",
                run_id,
                "--dispatch-id",
                "producer-dispatch-{}".format(number),
                "--context-id",
                "producer-context-{}".format(number),
            )
            (project / opened["allowed_writes_root"] / "work.md").write_text(
                "上下文证据成品 {}\n".format(number), encoding="utf-8"
            )
            arguments = [
                "seal-attempt",
                project,
                "--run-id",
                run_id,
                "--dispatch-id",
                "producer-dispatch-{}".format(number),
                "--execution-status",
                "PASS",
                "--quality-status",
                "PASS",
                "--decision",
                "commit",
                "--human-accepted",
                "true",
                "--machine-direction",
                "PASS",
                "--human-direction",
                "PASS",
                "--improved",
                "true",
                "--finding",
                finding,
                *self.human_feedback_args(project, run_id, machine_direction="PASS"),
            ]
            if number == 1:
                arguments += [
                    "--recovery-exercised",
                    "--local-recovery-preserved-upstream",
                    "--end-to-end-no-regression",
                    "--resolved-observed-problem",
                ]
            self.command(*arguments)
        self.assertEqual(self.command("audit", project)["provable_maturity"], "L3")
        self.create_l4_candidate(project)
        proposal = self.read_json(project / "creative-system/candidates/pace-fix/proposal.json")
        self.assertIn(
            "producer-context-1",
            proposal["producer_execution_boundary"]["controller_recorded_context_ids"],
        )
        blocked = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "reused-producer-context",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "target-evaluator",
            "--evaluator-context-id",
            "producer-context-1",
            "--evaluator-task-id",
            "fresh-evaluator-task",
            "--attested-by",
            "test-orchestrator",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
            expected=2,
        )
        self.assertIn("来源 Producer context", blocked["error"])

        attester_blocked = self.command(
            "open-eval-run",
            project,
            "--candidate-id",
            "pace-fix",
            "--eval-run-id",
            "producer-context-attester",
            "--phase",
            "targeted",
            "--evaluator-role-id",
            "fresh-target-evaluator",
            "--evaluator-context-id",
            "fresh-target-context",
            "--evaluator-task-id",
            "fresh-target-task",
            "--attested-by",
            "producer-context-1",
            "--input-boundary",
            "creative-charter",
            "--input-boundary",
            "rubric",
            "--input-boundary",
            "baseline-output",
            "--input-boundary",
            "candidate-output",
            expected=2,
        )
        self.assertIn("attester 不得复用 finding 来源 Producer context", attester_blocked["error"])

    def test_promotion_requires_matching_sealed_eval_evidence_and_three_runs(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation_path = self.promotion_evaluation(project)
        evaluation = self.read_json(evaluation_path)
        evaluation["evaluation_runs"] = 2
        self.write_json(evaluation_path, evaluation)
        too_few = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("selection-safe exact-three", too_few["error"])

        evaluation["evaluation_runs"] = 3
        evaluation["targeted"]["evidence"] = [
            "creative-system/evals/development/human-approval.md"
        ]
        self.write_json(evaluation_path, evaluation)
        outside = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("controller-sealed eval output root", outside["error"])

    def test_promotion_rejects_symlinked_evidence_before_commit(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation_path = self.promotion_evaluation(project)
        evidence = project / "creative-system/evals/development/human-approval.md"
        real_evidence = evidence.with_name("human-approval-real.md")
        real_evidence.write_bytes(evidence.read_bytes())
        evidence.unlink()
        try:
            evidence.symlink_to(real_evidence.name)
        except OSError as exc:
            self.skipTest("host cannot create test symlink: {}".format(exc))
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("不允许经过符号链接", blocked["error"])
        system = self.read_json(project / "creative-system/system.json")
        self.assertEqual(system["project"]["active_version"], "baseline-v1")

    @unittest.skipIf(os.name == "nt", "Windows CI 不保证允许创建符号链接")
    def test_promotion_rejects_dangling_release_symlink(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation_path = self.promotion_evaluation(project)
        release_link = project / "creative-system/releases/pace-fix"
        release_link.symlink_to(self.root / "outside-release", target_is_directory=True)
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation_path,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("release control entry 不允许是符号链接", blocked["error"])
        self.assertFalse((self.root / "outside-release").exists())
        status = self.read_json(project / "creative-system/candidates/pace-fix/status.json")
        self.assertEqual(status["status"], "CANDIDATE")

    def test_registry_ahead_partial_promotion_rolls_forward_safely(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project, "pace-fix-a")
        evaluation_a = self.promotion_evaluation(project, "pace-fix-a")
        self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix-a",
            "--evaluation",
            evaluation_a,
            "--approved-by",
            "Alice",
        )
        self.create_l4_candidate(project, "pace-fix-b")
        evaluation_b = self.promotion_evaluation(project, "pace-fix-b")
        self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix-b",
            "--evaluation",
            evaluation_b,
            "--approved-by",
            "Alice",
        )

        before_b = self.read_json(project / "creative-system/releases/pace-fix-b/system-before.json")
        self.write_json(project / "creative-system/system.json", before_b)
        self.assertEqual(self.command("validate", project, expected=1)["status"], "BLOCK")
        recovered = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix-b",
            "--evaluation",
            evaluation_b,
            "--approved-by",
            "Alice",
        )
        self.assertEqual(recovered["active_version"], "pace-fix-b")
        self.assertEqual(self.command("validate", project)["status"], "PASS")

    def test_candidate_ahead_partial_promotion_is_blocked_then_recovers(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        spec = importlib.util.spec_from_file_location("loopctl_promotion_crash", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        original_atomic_write_json = module.atomic_write_json

        def crash_after_candidate_status(path, value):
            original_atomic_write_json(path, value)
            if str(path).endswith(
                "/creative-system/candidates/pace-fix/status.json"
            ) and value.get("status") == "PROMOTED":
                raise RuntimeError("injected crash after candidate status")

        module.atomic_write_json = crash_after_candidate_status
        arguments = module.argparse.Namespace(
            project=str(project),
            candidate_id="pace-fix",
            evaluation=str(evaluation),
            approved_by="Alice",
            to_version=None,
        )
        with self.assertRaisesRegex(RuntimeError, "candidate status"):
            with module.exclusive_controller_lock(module.project_root(str(project))):
                module.command_promote_locked(arguments, module.project_root(str(project)), "pace-fix")
        module.atomic_write_json = original_atomic_write_json

        blocked = self.command("validate", project, expected=1)
        self.assertTrue(any("缺少 release registry" in item for item in blocked["errors"]))
        recovered = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
        )
        self.assertTrue(recovered["recovered_partial_commit"])
        self.assertEqual(recovered["active_version"], "pace-fix")
        self.assertEqual(self.command("validate", project)["status"], "PASS")

    def test_promote_transaction_recovers_five_crash_boundaries(self):
        phases = ("release", "candidate", "registry", "system", "commit-marker")
        for phase in phases:
            with self.subTest(phase=phase):
                project = self.make_l3_project("promotion-crash-{}".format(phase))
                self.create_l4_candidate(project)
                evaluation = self.promotion_evaluation(project)
                spec = importlib.util.spec_from_file_location(
                    "loopctl_promotion_crash_{}".format(phase.replace("-", "_")),
                    SCRIPT,
                )
                module = importlib.util.module_from_spec(spec)
                assert spec.loader is not None
                spec.loader.exec_module(module)

                if phase == "release":
                    original = module.materialize_promotion_release_bundle

                    def crash_after_release(root, transaction_dir, intent):
                        original(root, transaction_dir, intent)
                        raise RuntimeError("injected crash after release")

                    module.materialize_promotion_release_bundle = crash_after_release
                elif phase == "commit-marker":
                    def crash_before_commit_marker(transaction_dir, intent):
                        raise RuntimeError("injected crash before commit marker")

                    module.commit_controller_transaction = crash_before_commit_marker
                elif phase == "registry":
                    original = module.atomic_create_json

                    def crash_after_registry(path, value):
                        original(path, value)
                        if str(path).endswith(
                            "/creative-system/releases/registry.json"
                        ):
                            raise RuntimeError("injected crash after registry")

                    module.atomic_create_json = crash_after_registry
                else:
                    original = module.atomic_write_json
                    suffix = {
                        "candidate": "/creative-system/candidates/pace-fix/status.json",
                        "system": "/creative-system/system.json",
                    }[phase]

                    def crash_after_target(path, value, *, expected_suffix=suffix):
                        original(path, value)
                        if str(path).endswith(expected_suffix):
                            raise RuntimeError("injected crash after {}".format(phase))

                    module.atomic_write_json = crash_after_target

                arguments = module.argparse.Namespace(
                    project=str(project),
                    candidate_id="pace-fix",
                    evaluation=str(evaluation),
                    approved_by="Alice",
                    to_version=None,
                )
                with self.assertRaisesRegex(RuntimeError, "injected crash"):
                    with module.exclusive_controller_lock(
                        module.project_root(str(project))
                    ):
                        module.command_promote_locked(
                            arguments,
                            module.project_root(str(project)),
                            "pace-fix",
                        )

                transactions = [
                    path
                    for path in (
                        project / "creative-system/control/transactions"
                    ).iterdir()
                    if path.is_dir() and not path.name.startswith(".")
                ]
                self.assertEqual(len(transactions), 1)
                self.assertTrue((transactions[0] / "intent.json").is_file())
                self.assertFalse((transactions[0] / "committed.json").exists())
                blocked = self.command("validate", project, expected=1)
                self.assertTrue(
                    any(
                        "PENDING_CONTROLLER_TRANSACTION" in item
                        for item in blocked["errors"]
                    )
                )

                if phase == "release":
                    mismatch_variants = (
                        ("--candidate-id", "other-candidate"),
                        ("--to-version", "other-version"),
                        ("--approved-by", "Bob"),
                    )
                    for option, value in mismatch_variants:
                        arguments = [
                            "promote",
                            project,
                            "--candidate-id",
                            "pace-fix",
                            "--evaluation",
                            evaluation,
                            "--approved-by",
                            "Alice",
                        ]
                        if option == "--candidate-id":
                            arguments[3] = value
                        elif option == "--approved-by":
                            arguments[-1] = value
                        else:
                            arguments.extend([option, value])
                        mismatch = self.command(*arguments, expected=2)
                        self.assertIn("必须与原事务一致", mismatch["error"])

                    evaluation_bytes = evaluation.read_bytes()
                    changed_evaluation = self.read_json(evaluation)
                    changed_evaluation["transaction_mismatch_probe"] = True
                    self.write_json(evaluation, changed_evaluation)
                    evaluation_mismatch = self.command(
                        "promote",
                        project,
                        "--candidate-id",
                        "pace-fix",
                        "--evaluation",
                        evaluation,
                        "--approved-by",
                        "Alice",
                        expected=2,
                    )
                    self.assertIn("必须与原事务一致", evaluation_mismatch["error"])
                    evaluation.write_bytes(evaluation_bytes)
                    rollback = self.command(
                        "rollback",
                        project,
                        "--reason",
                        "不能跨过 pending promote",
                        expected=2,
                    )
                    self.assertIn("重跑 promote", rollback["error"])

                recovered = self.command(
                    "promote",
                    project,
                    "--candidate-id",
                    "pace-fix",
                    "--evaluation",
                    evaluation,
                    "--approved-by",
                    "Alice",
                )
                self.assertTrue(recovered["recovered_partial_commit"])
                self.assertEqual(self.command("validate", project)["status"], "PASS")
                registry = self.read_json(
                    project / "creative-system/releases/registry.json"
                )
                self.assertEqual(
                    [item["action"] for item in registry["history"]], ["promote"]
                )

    def test_pending_promote_rejects_third_hash_before_advancing_other_targets(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        system_path = project / "creative-system/system.json"
        system_before = self.read_json(system_path)
        spec = importlib.util.spec_from_file_location("loopctl_promote_third_hash", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        original = module.atomic_write_json

        def crash_after_candidate(path, value):
            original(path, value)
            if str(path).endswith(
                "/creative-system/candidates/pace-fix/status.json"
            ):
                raise RuntimeError("injected crash after candidate")

        module.atomic_write_json = crash_after_candidate
        arguments = module.argparse.Namespace(
            project=str(project),
            candidate_id="pace-fix",
            evaluation=str(evaluation),
            approved_by="Alice",
            to_version=None,
        )
        with self.assertRaisesRegex(RuntimeError, "after candidate"):
            with module.exclusive_controller_lock(module.project_root(str(project))):
                module.command_promote_locked(
                    arguments, module.project_root(str(project)), "pace-fix"
                )

        divergent_system = json.loads(json.dumps(system_before))
        divergent_system["project"]["name"] += "（事务外修改）"
        self.write_json(system_path, divergent_system)
        rejected = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("TRANSACTION_DIVERGED", rejected["error"])
        self.assertFalse((project / "creative-system/releases/registry.json").exists())

        self.write_json(system_path, system_before)
        recovered = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
        )
        self.assertTrue(recovered["recovered_partial_commit"])
        self.assertEqual(self.command("validate", project)["status"], "PASS")

    def test_orphan_release_bundle_is_blocked_without_registry_reference(self):
        project = self.init_project()
        orphan = project / "creative-system/releases/orphan-v1"
        orphan.mkdir()
        self.write_json(
            orphan / "promotion.json",
            {
                "schema_version": "0.1",
                "kind": "PromotionRecord",
                "action": "promote",
                "state": "COMMITTED",
                "new_version": "orphan-v1",
            },
        )
        blocked = self.command("validate", project, expected=1)
        self.assertTrue(
            any(
                "ORPHAN_COMMITTED_RELEASE_BUNDLE" in item
                for item in blocked["errors"]
            )
        )

    @unittest.skipIf(os.name == "nt", "Windows CI 不保证允许创建符号链接")
    def test_candidate_changes_root_symlink_blocks_validate_and_promote(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        changes = project / "creative-system/candidates/pace-fix/changes"
        outside = self.root / "outside-candidate-changes"
        outside.mkdir()
        (outside / "payload.md").write_text("不得被当作项目内候选\n", encoding="utf-8")
        shutil.rmtree(changes)
        changes.symlink_to(outside, target_is_directory=True)
        blocked = self.command("validate", project, expected=1)
        self.assertTrue(any("changes/" in item for item in blocked["errors"]))

        dummy_evaluation = project / "creative-system/evals/development/dummy.json"
        self.write_json(dummy_evaluation, {})
        refused = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            dummy_evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("changes/", refused["error"])

    @unittest.skipIf(os.name == "nt", "Windows CI 不保证允许创建符号链接")
    def test_run_json_symlink_blocks_validate_and_begin_run(self):
        project = self.init_project()
        self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "符号链接运行记录测试",
            "--run-id",
            "linked-run",
        )
        run_path = project / "creative-system/runs/linked-run/run.json"
        outside = self.root / "outside-run.json"
        outside.write_bytes(run_path.read_bytes())
        run_path.unlink()
        run_path.symlink_to(outside)
        blocked = self.command("validate", project, expected=1)
        self.assertTrue(
            any("run linked-run record" in item for item in blocked["errors"])
        )
        refused = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "符号链接运行记录测试",
            "--run-id",
            "linked-run",
            expected=2,
        )
        self.assertIn("run linked-run record", refused["error"])

    def test_active_release_evaluation_and_sealed_eval_outputs_are_tamper_evident(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
        )
        release_evaluation = project / "creative-system/releases/pace-fix/evaluation.json"
        tampered = self.read_json(release_evaluation)
        tampered["run_integrity"]["prior_run_outputs_included"] = 999
        tampered["run_integrity"]["stale_output_contamination"] = True
        self.write_json(release_evaluation, tampered)
        validation = self.command("validate", project, expected=1)
        self.assertTrue(any("evaluation.json 哈希不一致" in item for item in validation["errors"]))
        self.assertEqual(self.command("audit", project, expected=1)["status"], "BLOCK")

    def test_promotion_prevalidates_registry_before_any_state_change(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        registry_path = project / "creative-system/releases/registry.json"
        self.write_json(registry_path, {"schema_version": "0.1", "kind": "ReleaseRegistry", "history": "bad"})
        system_before = (project / "creative-system/system.json").read_bytes()
        status_before = (project / "creative-system/candidates/pace-fix/status.json").read_bytes()
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("release registry", blocked["error"])
        self.assertEqual((project / "creative-system/system.json").read_bytes(), system_before)
        self.assertEqual((project / "creative-system/candidates/pace-fix/status.json").read_bytes(), status_before)
        self.assertFalse((project / "creative-system/releases/pace-fix").exists())

    def test_run_snapshot_distinguishes_bootstrap_from_post_l4(self):
        bootstrap_project = self.init_project("bootstrap")
        bootstrap = self.command(
            "begin-run",
            bootstrap_project,
            "--loop",
            "main-loop",
            "--task",
            "立宪后的首个代表任务",
            "--run-id",
            "bootstrap-run",
        )
        self.assertEqual(bootstrap["run_phase"], "bootstrap")
        self.assertEqual(bootstrap["provable_maturity_at_start"], "L0")
        self.assertEqual(bootstrap["active_version_at_start"], "baseline-v1")
        self.assertIsNone(bootstrap["post_l4_iteration_index"])

        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
        )
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "晋升后的第一次正式改进试验",
            "--run-id",
            "post-l4-run-1",
        )
        self.assertEqual(started["run_phase"], "post-l4")
        self.assertEqual(started["provable_maturity_at_start"], "L4")
        self.assertEqual(started["active_version_at_start"], "pace-fix")
        self.assertEqual(started["post_l4_iteration_index"], 1)
        attempt = project / started["attempt_path"]
        (attempt / "artifacts" / "work.md").write_text("晋升后试验成品\n", encoding="utf-8")
        sealed = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "post-l4-run-1",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--release-status",
            "CANDIDATE",
            "--decision",
            "commit",
            "--improved",
            "true",
        )
        manifest = self.read_json(project / sealed["manifest"])
        self.assertEqual(manifest["run_phase"], "post-l4")
        self.assertEqual(manifest["post_l4_iteration_index"], 1)
        audit = self.command("audit", project)
        self.assertEqual(audit["provable_maturity"], "L4")
        self.assertEqual(audit["evidence"]["post_l4_runs"], 1)
        self.assertEqual(audit["evidence"]["post_l4_improved_runs"], 1)

    def test_bootstrap_run_cannot_be_relabelled_as_post_l4(self):
        project = self.init_project()
        started = self.command(
            "begin-run",
            project,
            "--loop",
            "main-loop",
            "--task",
            "普通 bootstrap 任务",
            "--run-id",
            "forged-phase",
        )
        run_path = project / "creative-system" / "runs" / "forged-phase" / "run.json"
        run = self.read_json(run_path)
        run["run_phase"] = "post-l4"
        run["provable_maturity_at_start"] = "L4"
        run["active_version_at_start"] = "forged-candidate"
        self.write_json(run_path, run)
        attempt = project / started["attempt_path"]
        (attempt / "artifacts" / "work.md").write_text("不能冒充晋升后运行\n", encoding="utf-8")
        blocked = self.command(
            "seal-attempt",
            project,
            "--run-id",
            "forged-phase",
            "--execution-status",
            "PASS",
            "--quality-status",
            "PASS",
            "--decision",
            "commit",
            expected=2,
        )
        self.assertIn("不再能证明 L4", blocked["error"])

    def test_candidate_proposal_tamper_blocks_promotion(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        proposal_path = project / "creative-system" / "candidates" / "pace-fix" / "proposal.json"
        proposal = self.read_json(proposal_path)
        proposal["root_cause_hypothesis"] = "事后改写"
        self.write_json(proposal_path, proposal)
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("proposal 已在创建后被改写", blocked["error"])

    def test_undeclared_or_protected_candidate_file_blocks_promotion(self):
        project = self.make_l3_project()
        self.create_l4_candidate(project)
        evaluation = self.promotion_evaluation(project)
        hidden = (
            project
            / "creative-system"
            / "candidates"
            / "pace-fix"
            / "changes"
            / "creative-system"
            / "creative-charter.md"
        )
        hidden.parent.mkdir(parents=True, exist_ok=True)
        hidden.write_text("试图替换创作宪法\n", encoding="utf-8")
        blocked = self.command(
            "promote",
            project,
            "--candidate-id",
            "pace-fix",
            "--evaluation",
            evaluation,
            "--approved-by",
            "Alice",
            expected=2,
        )
        self.assertIn("实际文件触及受保护表面", blocked["error"])


if __name__ == "__main__":
    unittest.main()
