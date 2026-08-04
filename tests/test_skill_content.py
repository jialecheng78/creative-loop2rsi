from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "creative-loop2rsi"
EXAMPLES = SKILL / "assets" / "examples"


class SkillContentTests(unittest.TestCase):
    def test_skill_frontmatter_is_minimal_and_body_is_compact(self) -> None:
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        match = re.match(r"\A---\n(.*?)\n---\n", text, flags=re.DOTALL)
        self.assertIsNotNone(match)
        keys = {
            line.split(":", 1)[0].strip()
            for line in match.group(1).splitlines()
            if line.strip()
        }
        self.assertEqual(keys, {"name", "description"})
        self.assertLessEqual(len(text.splitlines()), 300)
        self.assertNotIn("TODO", text)
        for reference in (
            "concepts-and-maturity.md",
            "system-contract.md",
            "nested-loops-and-recovery.md",
            "evaluation-and-promotion.md",
            "end-to-end-pilot.md",
            "rsi-lab.md",
        ):
            self.assertIn(f"references/{reference}", text)

    def test_openai_metadata_matches_public_interface(self) -> None:
        text = (SKILL / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn('display_name: "Creative Loop → RSI"', text)
        description_match = re.search(r'short_description: "([^"]+)"', text)
        self.assertIsNotNone(description_match)
        self.assertGreaterEqual(len(description_match.group(1)), 25)
        self.assertLessEqual(len(description_match.group(1)), 64)
        self.assertRegex(text, r'default_prompt: "[^\n"]*\$creative-loop2rsi[^\n"]*"')
        self.assertIn("allow_implicit_invocation: true", text)
        for forbidden in ("icon_small", "icon_large", "brand_color", "dependencies:", "mcp"):
            self.assertNotIn(forbidden, text)

    def test_required_references_cover_the_contract(self) -> None:
        expected = {
            "concepts-and-maturity.md": ("L0", "L5", "Prompt", "RSI"),
            "system-contract.md": (
                "CreativeSystem",
                "LoopSpec",
                "JudgeSpec",
                "Finding",
                "LearningProposal",
                "CharterConfirmation",
                "HumanFeedbackReceipt",
                "HumanReviewSubject",
                "HumanReviewOpenAnchor",
            ),
            "nested-loops-and-recovery.md": ("owner", "attempt", "失效", "恢复"),
            "evaluation-and-promotion.md": ("硬合同", "软质量", "人类立宪", "held-out", "回滚"),
            "end-to-end-pilot.md": ("bootstrap", "post-l4", "独立评价", "人工门"),
            "rsi-lab.md": ("experimental", "unvalidated", "CANDIDATE", "外部元评估"),
        }
        actual = {path.name for path in (SKILL / "references").glob("*.md")}
        self.assertEqual(actual, set(expected))
        for name, terms in expected.items():
            text = (SKILL / "references" / name).read_text(encoding="utf-8")
            for term in terms:
                self.assertIn(term, text, f"{name} should explain {term}")

    def test_runtime_recovery_and_evaluation_invariants_are_explicit(self) -> None:
        system_contract = (SKILL / "references" / "system-contract.md").read_text(encoding="utf-8")
        recovery = (SKILL / "references" / "nested-loops-and-recovery.md").read_text(encoding="utf-8")
        evaluation = (SKILL / "references" / "evaluation-and-promotion.md").read_text(encoding="utf-8")
        pilot = (SKILL / "references" / "end-to-end-pilot.md").read_text(encoding="utf-8")
        skill_text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        for term in (
            "ControllerArtifactFacts",
            "producer_self_report_governing",
            "DispatchStallRecord",
            "runtime_dispatch_budget",
            "execution_receipt",
            "external-attestation-not-controller-verified",
            "HumanFeedbackReceipt",
            "HumanReviewSubject",
            "HumanReviewOpenAnchor",
            "review_available_at",
            "CharterConfirmationLedger",
            "ControllerTransactionIntent",
            "PENDING_CONTROLLER_TRANSACTION",
            "CharterConfirmation",
            "EvalRunOpenAnchor",
            "OPEN_ANCHORED",
            "preflight_sha256",
            "execution_receipt_sha256",
            "candidate_change_hashes",
            "evaluation_run_index",
            "max_evaluation_runs",
            "selection-safe exact-three",
            "controller_recorded_context_ids",
            "controller_recorded_task_ids",
            "external-attestation-required",
            "EVAL_CHANGED_DURING_SEAL",
            "TerminalEvalIncident",
            "successor candidate",
        ):
            self.assertIn(term, system_contract)
        for term in (
            "ZERO_FILE_DISPATCH_STALL",
            "open-dispatch",
            "open-human-review",
            "record-dispatch-stall",
            "0-byte",
            "content_attempt_index",
            "LATE_WRITE_CONTAMINATION",
            "STALE_OUTPUT_CONTAMINATION",
            "禁止挑选复用",
            "commit 窗口",
            "永久只读",
        ):
            self.assertIn(term, recovery)
        for term in (
            "producer_self_report_governing=false",
            "open-human-review",
            "provisional-audit",
            "block-seal",
            "STALE_OUTPUT_CONTAMINATION",
            "整轮失效",
            "Builder receipt",
            "不能认证",
        ):
            self.assertIn(term, evaluation)
        for term in (
            "measure-artifact",
            "open-dispatch",
            "open-human-review",
            "open-eval-run",
            "seal-eval-run",
            "STALE_OUTPUT_CONTAMINATION",
            "attestation",
            "EvalRunOpenAnchor",
            "candidate_change_hashes",
            "evaluation_run_index",
            "selection-safe exact-three",
            "external-attestation-required",
            "EVAL_CHANGED_DURING_SEAL",
            "TerminalEvalIncident",
            "successor candidate",
            "控制器也永久只读",
            "不得洗白",
            "symlink",
            "terminal-invalid output",
            "EVAL_EMPTY_OUTPUT",
        ):
            self.assertIn(term, pilot)
        for term in (
            "ZERO_FILE_DISPATCH_STALL",
            "open-dispatch",
            "open-human-review",
            "record-dispatch-stall",
            "open-eval-run",
            "seal-eval-run",
            "block-candidate",
            "EvalRunOpenAnchor",
            "candidate_change_hashes",
            "selection-safe exact-three",
            "external-attestation-required",
            "EVAL_CHANGED_DURING_SEAL",
            "successor candidate",
        ):
            self.assertIn(term, skill_text)
        for term in (
            "--builder-input-boundary",
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
            "open-human-review",
            "PENDING_CONTROLLER_TRANSACTION",
            "EvalRunOpenAnchor",
            "candidate_change_hashes",
            "selection-safe exact-three",
            "external-attestation-required",
            "EVAL_CHANGED_DURING_SEAL",
            "TerminalEvalIncident",
            "STALE_OUTPUT_CONTAMINATION",
            "successor candidate",
        ):
            self.assertIn(term, readme)
        self.assertNotIn("完整评价 run 获准重启", pilot)
        self.assertNotIn("在执行前检查：", skill_text)

    def test_starter_templates_preserve_runtime_invariants(self) -> None:
        starter = SKILL / "assets" / "starter-project"
        agents = (starter / "AGENTS.md.tmpl").read_text(encoding="utf-8")
        domain_skill = (starter / "domain-skill" / "SKILL.md.tmpl").read_text(encoding="utf-8")
        contract = (
            starter / "domain-skill" / "references" / "project-contract.md.tmpl"
        ).read_text(encoding="utf-8")
        for text in (agents, domain_skill, contract):
            self.assertIn("ZERO_FILE_DISPATCH_STALL", text)
            self.assertIn("block-seal", text)
            self.assertIn("STALE_OUTPUT_CONTAMINATION", text)
            self.assertIn("外部", text)
            self.assertIn("HumanFeedbackReceipt", text)
            self.assertIn("HumanReviewSubject", text)
            self.assertIn("HumanReviewOpenAnchor", text)
            for term in (
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
                "EvalRunOpenAnchor",
                "candidate_change_hashes",
                "evaluation_run_index",
                "max_evaluation_runs",
                "selection-safe exact-three",
                "external-attestation-required",
                "EVAL_CHANGED_DURING_SEAL",
                "TerminalEvalIncident",
                "successor candidate",
                "永久只读",
                "symlink",
                "terminal-invalid output",
                "EVAL_EMPTY_OUTPUT",
            ):
                self.assertIn(term, text)
            self.assertTrue(
                "不得后改 JSON 洗白" in text or "不能恢复当前候选" in text
            )
        self.assertIn("open-dispatch", domain_skill)
        self.assertIn("open-human-review", domain_skill)
        self.assertIn("open-eval-run", domain_skill)
        self.assertIn("seal-eval-run", contract)
        self.assertIn("runtime_dispatch_budget", contract)
        self.assertIn("0-byte", contract)
        starter_readme = (starter / "README.md.tmpl").read_text(encoding="utf-8")
        self.assertIn("confirm-charter", starter_readme)
        self.assertIn('$HOME/.codex/skills/creative-loop2rsi/scripts/loopctl.py', starter_readme)
        self.assertNotIn("charter.confirmed` 改为 `true", starter_readme)

    def test_starter_gitignore_keeps_raw_human_messages_local(self) -> None:
        template = (
            SKILL / "assets" / "starter-project" / "gitignore.tmpl"
        ).read_text(encoding="utf-8")
        ignored = (
            "creative-system/approvals/charter-confirmations/evidence/user-message.md",
            "creative-system/approvals/attempt-feedback/run-001.md",
        )
        tracked = (
            "creative-system/approvals/charter-confirmations/confirmation-deadbeef.json",
            "creative-system/approvals/charter-confirmations/ledger.json",
            "inputs/.gitkeep",
            "outputs/.gitkeep",
            "creative-system/runs/.gitkeep",
            "creative-system/approvals/charter-confirmations/evidence/.gitkeep",
            "creative-system/approvals/attempt-feedback/.gitkeep",
        )
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            subprocess.run(
                ["git", "init", "--quiet"],
                cwd=project,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            (project / ".gitignore").write_text(template, encoding="utf-8")
            for relative in ignored + tracked:
                path = project / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture\n", encoding="utf-8")

            for relative in ignored:
                result = subprocess.run(
                    ["git", "check-ignore", "--quiet", "--", relative],
                    cwd=project,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, relative)
            for relative in tracked:
                result = subprocess.run(
                    ["git", "check-ignore", "--quiet", "--", relative],
                    cwd=project,
                    check=False,
                )
                self.assertEqual(result.returncode, 1, relative)

    def test_examples_are_parseable_fictional_and_not_evidence_claims(self) -> None:
        expected_levels = {
            "short-story": "L1",
            "brand-copy": "L2",
            "game-quest": "L3",
        }
        self.assertEqual(
            {path.name for path in EXAMPLES.iterdir() if path.is_dir()},
            set(expected_levels),
        )
        for name, level in expected_levels.items():
            case_dir = EXAMPLES / name
            example_text = (case_dir / "example.md").read_text(encoding="utf-8")
            charter_text = (
                case_dir / "creative-system" / "creative-charter.md"
            ).read_text(encoding="utf-8")
            self.assertIn("虚构", example_text)
            self.assertIn("不是", example_text)
            self.assertIn("证据", example_text)
            self.assertIn("人的最终决定权", charter_text)
            system = json.loads(
                (case_dir / "creative-system" / "system.json").read_text(encoding="utf-8")
            )
            self.assertEqual(system["maturity"]["declared"], level)
            self.assertEqual(system["kind"], "CreativeSystem")
            self.assertFalse(system["charter"]["confirmed"])
            self.assertIsNone(system["charter"]["confirmation_receipt"])

            all_text = "\n".join(
                path.read_text(encoding="utf-8", errors="strict")
                for path in case_dir.rglob("*")
                if path.is_file()
            )
            self.assertNotIn("/Users/", all_text)
            self.assertNotIn(".env", all_text)
            self.assertNotRegex(all_text, r"(?i)(api[_-]?key|access[_-]?token|private[_-]?key)")
            for path in case_dir.rglob("*.json"):
                json.loads(path.read_text(encoding="utf-8"))

    def test_public_examples_are_real_validatable_projects(self) -> None:
        controller = SKILL / "scripts" / "loopctl.py"
        for case_dir in sorted(path for path in EXAMPLES.iterdir() if path.is_dir()):
            result = subprocess.run(
                [sys.executable, str(controller), "validate", str(case_dir)],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(
                result.returncode,
                0,
                "{}\nstdout:\n{}\nstderr:\n{}".format(
                    case_dir.name, result.stdout, result.stderr
                ),
            )
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "PASS", case_dir.name)
            ledger = json.loads(
                (
                    case_dir
                    / "creative-system/approvals/charter-confirmations/ledger.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(ledger["kind"], "CharterConfirmationLedger")
            self.assertEqual(ledger["entries"], [])
            self.assertTrue(
                (
                    case_dir
                    / "creative-system/control/locks/project-mutation.lock"
                ).is_file()
            )
            self.assertTrue(
                (case_dir / "creative-system/control/transactions").is_dir()
            )

    def test_example_loop_contracts_and_owners_are_coherent(self) -> None:
        required_loop_fields = {
            "schema_version",
            "kind",
            "id",
            "goal",
            "reads",
            "writes",
            "owner",
            "trigger",
            "producer",
            "judges",
            "decision_policy",
            "memory_updates",
            "retry_budget",
            "stop_conditions",
            "human_gate",
        }
        expected_counts = {"short-story": 1, "brand-copy": 1, "game-quest": 3}
        for name, expected_count in expected_counts.items():
            case_dir = EXAMPLES / name
            system = json.loads(
                (case_dir / "creative-system" / "system.json").read_text(encoding="utf-8")
            )
            loops = [
                json.loads((case_dir / relative).read_text(encoding="utf-8"))
                for relative in system["loops"]
            ]
            self.assertEqual(len(loops), expected_count)
            artifacts = {item["id"]: item for item in system["artifacts"]}
            written: dict[str, str] = {}
            for loop in loops:
                self.assertEqual(set(loop), required_loop_fields)
                self.assertTrue(loop["producer"]["separate_from_judges"])
                self.assertLessEqual(loop["retry_budget"]["max_attempts"], 3)
                self.assertLessEqual(loop["retry_budget"]["max_no_improvement"], 2)
                self.assertTrue(loop["stop_conditions"])
                for artifact_id in loop["writes"]:
                    self.assertIn(artifact_id, artifacts)
                    self.assertNotIn(artifact_id, written)
                    written[artifact_id] = loop["id"]
                    self.assertIn(artifacts[artifact_id]["owner"], (loop["id"], loop["owner"]))

    def test_game_quest_demonstrates_forward_only_nested_dependencies(self) -> None:
        case_dir = EXAMPLES / "game-quest"
        system = json.loads(
            (case_dir / "creative-system" / "system.json").read_text(encoding="utf-8")
        )
        loops = {
            item["id"]: item
            for item in (
                json.loads((case_dir / relative).read_text(encoding="utf-8"))
                for relative in system["loops"]
            )
        }
        self.assertEqual(loops["maintain-world-rule"]["reads"], ["quest-brief"])
        self.assertIn("world-rule-patch", loops["design-quest-structure"]["reads"])
        self.assertIn("quest-outline", loops["write-quest-dialogue"]["reads"])
        self.assertNotIn("quest-dialogue", loops["maintain-world-rule"]["reads"])

    def test_forward_test_claim_remains_scoped(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        report = (ROOT / "FORWARD_TESTS.md").read_text(encoding="utf-8")
        self.assertIn("`FORWARD-TESTED`", readme)
        self.assertIn("8/8", readme)
        self.assertIn("8/8", report)
        self.assertIn("UNVALIDATED", report)
        self.assertIn("三名非程序员", report)
        self.assertIn("不表示作品质量", report)


if __name__ == "__main__":
    unittest.main()
