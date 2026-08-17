from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
AUDIT_SCRIPT = REPOSITORY_ROOT / "tools" / "audit_public_tree.py"


class PublicTreeAuditTests(unittest.TestCase):
    def run_audit(self, root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(AUDIT_SCRIPT), str(root), *arguments],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_clean_full_tree_passes_and_git_directory_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text("A synthetic public example.\n", encoding="utf-8")
            git_directory = root / ".git"
            git_directory.mkdir()
            hidden_value = "sk-" + "x" * 24
            (git_directory / "not-public").write_text(hidden_value, encoding="utf-8")

            result = self.run_audit(root, "--mode", "full")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK:", result.stdout)

    def test_full_tree_prunes_dependency_and_generated_build_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hidden_value = "sk-" + "x" * 24
            for relative in (
                Path("node_modules") / "dependency.js",
                Path("apps") / "desktop" / "dist" / "bundle.js",
                Path("dist") / "sidecar" / "binary.txt",
            ):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(hidden_value, encoding="utf-8")
            (root / "README.md").write_text("A synthetic public example.\n", encoding="utf-8")

            result = self.run_audit(root, "--mode", "full")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("audited 1 file", result.stdout)

    def test_secret_and_absolute_home_path_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            secret = "api_" + "key" + " = " + "a" * 24
            home_path = "/" + "Users" + "/writer/private/draft.md"
            (root / "unsafe.txt").write_text(f"{secret}\n{home_path}\n", encoding="utf-8")

            result = self.run_audit(root, "--mode", "full")

            self.assertEqual(result.returncode, 1)
            self.assertIn("ASSIGNED_SECRET", result.stdout)
            self.assertIn("ABSOLUTE_MAC_PATH", result.stdout)

    def test_hyphenated_environment_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".env-deepseek").write_text("placeholder\n", encoding="utf-8")

            result = self.run_audit(root, "--mode", "full")

            self.assertEqual(result.returncode, 1)
            self.assertIn("SECRET_FILE", result.stdout)

    def test_binary_large_cache_and_root_runtime_artifacts_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "asset.bin").write_bytes(b"text\0binary")
            (root / "large.txt").write_text("x" * 101, encoding="utf-8")
            cache = root / "__pycache__"
            cache.mkdir()
            (cache / "module.pyc").write_bytes(b"compiled")
            runs = root / "runs"
            runs.mkdir()
            (runs / "private.json").write_text("{}", encoding="utf-8")

            result = self.run_audit(root, "--mode", "full", "--max-bytes", "100")

            self.assertEqual(result.returncode, 1)
            self.assertIn("BINARY_FILE", result.stdout)
            self.assertIn("LARGE_FILE", result.stdout)
            self.assertIn("CACHE_ARTIFACT", result.stdout)
            self.assertIn("RUNTIME_ARTIFACT", result.stdout)

    def test_private_denylist_is_literal_case_insensitive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "repo"
            root.mkdir()
            sensitive_term = "Fictional" + "PrivateMarker"
            (root / "doc.md").write_text(sensitive_term.lower(), encoding="utf-8")
            denylist = base / "denylist.txt"
            denylist.write_text(f"# local only\n{sensitive_term}\n", encoding="utf-8")

            result = self.run_audit(
                root,
                "--mode",
                "full",
                "--denylist",
                str(denylist),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("PRIVATE_DENYLIST_MATCH", result.stdout)

    def test_private_denylist_checks_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "repo"
            root.mkdir()
            sensitive_term = "Hidden" + "ChannelName"
            (root / f"{sensitive_term}.md").write_text("synthetic", encoding="utf-8")
            denylist = base / "denylist.txt"
            denylist.write_text(sensitive_term.lower(), encoding="utf-8")

            result = self.run_audit(
                root,
                "--mode",
                "full",
                "--denylist",
                str(denylist),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("PRIVATE_DENYLIST_PATH", result.stdout)

    def test_symlink_is_rejected_without_following_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "safe.txt"
            target.write_text("safe", encoding="utf-8")
            link = root / "linked.txt"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink unavailable: {exc}")

            result = self.run_audit(root, "--mode", "full")

            self.assertEqual(result.returncode, 1)
            self.assertIn("SYMLINK", result.stdout)

    @unittest.skipUnless(shutil.which("git"), "git is required")
    def test_tracked_mode_ignores_untracked_file_but_checks_tracked_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(
                ["git", "init", "-q", str(root)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            (root / "safe.txt").write_text("safe", encoding="utf-8")
            hidden_value = "gh" + "p_" + "x" * 24
            (root / "untracked.txt").write_text(hidden_value, encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "safe.txt"], check=True)

            clean_result = self.run_audit(root, "--mode", "tracked")

            self.assertEqual(clean_result.returncode, 0, clean_result.stdout + clean_result.stderr)

            (root / "runtime.log").write_text("local output", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "runtime.log"], check=True)
            unsafe_result = self.run_audit(root, "--mode", "tracked")

            self.assertEqual(unsafe_result.returncode, 1)
            self.assertIn("LOCAL_ARTIFACT", unsafe_result.stdout)

    def test_missing_denylist_is_configuration_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = self.run_audit(
                root,
                "--mode",
                "full",
                "--denylist",
                str(root / "missing.txt"),
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("configuration error", result.stderr)


class RepositoryPolicyTests(unittest.TestCase):
    def test_ci_uses_read_only_permissions_and_expected_matrix(self) -> None:
        workflow = (REPOSITORY_ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertNotIn("pull_request_target", workflow)
        for operating_system in ("ubuntu-latest", "macos-latest", "windows-latest"):
            self.assertIn(operating_system, workflow)
        for version in ('"3.9"', '"3.11"', '"3.13"'):
            self.assertIn(version, workflow)
        self.assertIn("python -X utf8 -m unittest discover -s tests -v", workflow)
        self.assertIn("--mode tracked", workflow)
        electron_install = "run: node apps/desktop/node_modules/electron/install.js"
        self.assertIn("if: runner.os != 'Linux'", workflow)
        self.assertIn(electron_install, workflow)
        self.assertLess(
            workflow.index("run: pnpm install --frozen-lockfile"),
            workflow.index(electron_install),
        )
        self.assertLess(workflow.index(electron_install), workflow.index("run: pnpm run check"))
        for job in ("dco:", "policy:", "gitleaks-history:", "archive-audit:"):
            self.assertIn(job, workflow)
        self.assertIn("--ignore-gitleaks-allow", workflow)
        self.assertIn("--gitleaks-ignore-path", workflow)
        self.assertIn("--config \"$RUNNER_TEMP/gitleaks-8.18.4.toml\"", workflow)

    def test_ci_actions_are_pinned_and_secrets_are_not_referenced(self) -> None:
        workflow_path = REPOSITORY_ROOT / ".github" / "workflows" / "ci.yml"
        workflow = workflow_path.read_text(encoding="utf-8")
        action_references = re.findall(r"^\s*uses:\s*[^@\s]+@([^\s#]+)", workflow, re.MULTILINE)
        self.assertTrue(action_references)
        for reference in action_references:
            with self.subTest(reference=reference):
                self.assertRegex(reference, r"^[0-9a-f]{40}$")
        self.assertNotIn("secrets.", workflow)
        self.assertNotRegex(workflow, r"(?m)^\s*[a-z-]+:\s*write(?:-all)?\s*$")
        checkout_blocks = re.findall(
            r"uses:\s*actions/checkout@[0-9a-f]{40}.*?(?=\n\s*- name:|\n\s{2}[a-z-]+:|\Z)",
            workflow,
            re.DOTALL,
        )
        self.assertTrue(checkout_blocks)
        for block in checkout_blocks:
            with self.subTest(checkout=block.splitlines()[0].strip()):
                self.assertIn("persist-credentials: false", block)

    def test_open_source_policy_files_are_present(self) -> None:
        required = (
            "LICENSE",
            "CONTRIBUTING.md",
            "SECURITY.md",
            ".gitignore",
            ".gitattributes",
        )
        for relative in required:
            with self.subTest(relative=relative):
                self.assertTrue((REPOSITORY_ROOT / relative).is_file())

        license_text = (REPOSITORY_ROOT / "LICENSE").read_text(encoding="utf-8")
        contribution_text = (REPOSITORY_ROOT / "CONTRIBUTING.md").read_text(
            encoding="utf-8"
        )
        readme = (REPOSITORY_ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("Apache License", license_text)
        self.assertIn("DCO", contribution_text)
        self.assertIn("不要求签署 CLA", contribution_text)
        self.assertIn("web_commit_signoff_required", contribution_text)
        gitignore = (REPOSITORY_ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(".env-*", gitignore.splitlines())
        for status in ("IMPLEMENTED", "FORWARD-TESTED", "PROPOSED", "UNVALIDATED"):
            self.assertIn(status, readme)


if __name__ == "__main__":
    unittest.main()
