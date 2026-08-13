from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Optional


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DCO_SCRIPT = REPOSITORY_ROOT / "tools" / "check_dco.py"
ARCHIVE_SCRIPT = REPOSITORY_ROOT / "tools" / "audit_release_archive.py"


@unittest.skipUnless(shutil.which("git"), "git is required")
class GitGateTestCase(unittest.TestCase):
    def initialize_repo(self, root: Path) -> None:
        subprocess.run(
            ["git", "init", "-q", str(root)],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        subprocess.run(
            ["git", "-C", str(root), "config", "user.name", "Test Author"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(root), "config", "user.email", "author@example.invalid"],
            check=True,
        )

    def commit_all(
        self,
        root: Path,
        message: str,
        *,
        signoff: Optional[str] = None,
    ) -> None:
        subprocess.run(["git", "-C", str(root), "add", "--all"], check=True)
        command = ["git", "-C", str(root), "commit", "-q", "-m", message]
        if signoff is not None:
            command.extend(["-m", f"Signed-off-by: {signoff}"])
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def run_script(
        self,
        script: Path,
        root: Path,
        *arguments: str,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(script), str(root), *arguments],
            check=False,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )


class DcoGateTests(GitGateTestCase):
    def test_author_matching_signoff_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.initialize_repo(root)
            (root / "README.md").write_text("synthetic\n", encoding="utf-8")
            self.commit_all(
                root,
                "Add synthetic file",
                signoff="Test Author <author@example.invalid>",
            )

            result = self.run_script(DCO_SCRIPT, root, "--range", "HEAD")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("OK: 1 commit", result.stdout)

    def test_unsigned_and_mismatched_commits_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.initialize_repo(root)
            (root / "README.md").write_text("first\n", encoding="utf-8")
            self.commit_all(root, "Unsigned")
            (root / "README.md").write_text("second\n", encoding="utf-8")
            self.commit_all(
                root,
                "Mismatched",
                signoff="Different Person <different@example.invalid>",
            )

            result = self.run_script(DCO_SCRIPT, root, "--range", "HEAD")

            self.assertEqual(result.returncode, 1)
            self.assertIn("missing Signed-off-by", result.stdout)
            self.assertIn("matches the commit author", result.stdout)
            self.assertIn("2 DCO failure", result.stdout)

    def test_signoff_like_body_line_is_not_a_trailer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.initialize_repo(root)
            (root / "README.md").write_text("synthetic\n", encoding="utf-8")
            self.commit_all(
                root,
                "Describe an example\n\nSigned-off-by: Test Author <author@example.invalid>\n\nThis line follows the example.",
            )

            result = self.run_script(DCO_SCRIPT, root, "--range", "HEAD")

            self.assertEqual(result.returncode, 1)
            self.assertIn("missing Signed-off-by trailer", result.stdout)


class ReleaseArchiveGateTests(GitGateTestCase):
    def test_archive_uses_committed_bytes_not_modified_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "repo"
            root.mkdir()
            self.initialize_repo(root)
            readme = root / "README.md"
            readme.write_text("safe committed content\n", encoding="utf-8")
            self.commit_all(
                root,
                "Add release file",
                signoff="Test Author <author@example.invalid>",
            )
            readme.write_text("api_" + "key = " + "x" * 24, encoding="utf-8")
            archive = base / "release.tar"
            manifest = base / "release.json"

            result = self.run_script(
                ARCHIVE_SCRIPT,
                root,
                "--treeish",
                "HEAD",
                "--output",
                str(archive),
                "--manifest",
                str(manifest),
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(archive.is_file())
            self.assertTrue(manifest.is_file())
            self.assertIn("files=1", result.stdout)

    def test_public_tree_finding_blocks_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.initialize_repo(root)
            (root / ".DS_Store").write_text("local", encoding="utf-8")
            self.commit_all(
                root,
                "Add forbidden file",
                signoff="Test Author <author@example.invalid>",
            )

            result = self.run_script(ARCHIVE_SCRIPT, root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("LOCAL_ARTIFACT", result.stdout)

    def test_output_and_manifest_must_be_distinct(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            self.initialize_repo(root)
            (root / "README.md").write_text("safe\n", encoding="utf-8")
            self.commit_all(
                root,
                "Add release file",
                signoff="Test Author <author@example.invalid>",
            )
            same_path = root.parent / "release-output"

            result = self.run_script(
                ARCHIVE_SCRIPT,
                root,
                "--output",
                str(same_path),
                "--manifest",
                str(same_path),
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("must be different", result.stderr)
            self.assertFalse(same_path.exists())

    @unittest.skipIf(os.name == "nt", "Windows may not permit creating symbolic links")
    def test_git_symlink_blocks_archive_before_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.initialize_repo(root)
            target = root / "target.txt"
            target.write_text("safe\n", encoding="utf-8")
            link = root / "linked.txt"
            try:
                link.symlink_to("target.txt")
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink unavailable: {exc}")
            self.commit_all(
                root,
                "Add symlink",
                signoff="Test Author <author@example.invalid>",
            )

            result = self.run_script(ARCHIVE_SCRIPT, root)

            self.assertEqual(result.returncode, 2)
            self.assertIn("unsupported Git entries", result.stderr)


if __name__ == "__main__":
    unittest.main()
