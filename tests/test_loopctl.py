import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "skills" / "creative-loop2rsi" / "scripts" / "loopctl.py"


class LoopCtlTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

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
        if confirmed:
            arguments.append("--charter-confirmed")
        self.command(*arguments)
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

    def make_l3_project(self):
        project = self.init_project()
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

    def create_l4_candidate(self, project, candidate_id="pace-fix"):
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

    def promotion_evaluation(self, project):
        evidence_files = {
            "creative-system/evals/development/target.md": "目标问题改善\n",
            "creative-system/evals/development/regression.md": "回归无硬退化\n",
            "creative-system/evals/heldout/result.md": "盲评不劣于基线\n",
            "creative-system/evals/development/human-approval.md": "Alice 批准候选范围\n",
        }
        for relative, content in evidence_files.items():
            path = project / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        evaluation_path = project / "creative-system" / "evals" / "development" / "promotion.json"
        self.write_json(
            evaluation_path,
            {
                "independent_evaluator": True,
                "evaluator": "frozen-external-reviewer",
                "evaluation_runs": 4,
                "targeted": {
                    "status": "IMPROVED",
                    "evidence": ["creative-system/evals/development/target.md"],
                },
                "regression": {
                    "status": "PASS",
                    "hard_contract_regressions": 0,
                    "hard_false_passes": 0,
                    "evidence": ["creative-system/evals/development/regression.md"],
                },
                "heldout": {
                    "status": "NON_INFERIOR",
                    "blind": True,
                    "baseline_comparison": "NOT_WORSE",
                    "evidence": ["creative-system/evals/heldout/result.md"],
                },
                "human_approval": {
                    "approved": True,
                    "approved_by": "Alice",
                    "scope": "只晋升 production guidance 候选",
                    "evidence": ["creative-system/evals/development/human-approval.md"],
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

        first = self.init_project("first")
        second = self.init_project("second")
        self.assertEqual(self.tree_hashes(first), self.tree_hashes(second))

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

    def test_generated_contract_and_domain_skill_shape(self):
        project = self.init_project()
        report = self.command("validate", project)
        self.assertEqual(report["status"], "PASS")
        system = self.read_json(project / "creative-system" / "system.json")
        self.assertIn("charter", system)
        self.assertEqual(system["maturity"]["declared"], "L0")
        skill = project / "skills" / "paper-lantern-story" / "SKILL.md"
        self.assertTrue(skill.is_file())
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
            expected=2,
        )
        self.assertIn("至少 3 次", blocked["error"])

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
        )
        self.assertEqual(created["level"], "L5")
        evaluation = self.promotion_evaluation(project)
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
        proposal_path = project / "creative-system" / "candidates" / "pace-fix" / "proposal.json"
        proposal = self.read_json(proposal_path)
        proposal["root_cause_hypothesis"] = "事后改写"
        self.write_json(proposal_path, proposal)
        evaluation = self.promotion_evaluation(project)
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
        evaluation = self.promotion_evaluation(project)
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
