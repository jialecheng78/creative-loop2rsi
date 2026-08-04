from __future__ import annotations

import json
import re
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
            "system-contract.md": ("CreativeSystem", "LoopSpec", "JudgeSpec", "Finding", "LearningProposal"),
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
            charter_text = (case_dir / "creative-charter.md").read_text(encoding="utf-8")
            self.assertIn("虚构", example_text)
            self.assertIn("不是", example_text)
            self.assertIn("证据", example_text)
            self.assertIn("人的最终决定权", charter_text)
            system = json.loads((case_dir / "system.json").read_text(encoding="utf-8"))
            self.assertEqual(system["maturity"]["declared"], level)
            self.assertEqual(system["kind"], "CreativeSystem")
            self.assertTrue(system["charter"]["confirmed"])

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

    def test_example_loop_contracts_and_owners_are_coherent(self) -> None:
        required_loop_fields = {
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
            system = json.loads((case_dir / "system.json").read_text(encoding="utf-8"))
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
        system = json.loads((case_dir / "system.json").read_text(encoding="utf-8"))
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
