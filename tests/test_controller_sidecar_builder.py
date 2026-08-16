from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path

from tools.build_controller_sidecar import (
    SIDECAR_NAME,
    inventory_sidecar_tree,
    validate_sidecar_executable,
)


class ControllerSidecarBuilderTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "symlink creation is not guaranteed on Windows CI")
    def test_symlinks_must_be_relative_strict_and_inside(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sidecar-builder-links-") as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_bytes(b"target")
            link = root / "link"
            link.symlink_to("target")
            self.assertEqual(
                inventory_sidecar_tree(root, "Darwin")["link"]["target"],
                "target",
            )

            link.unlink()
            link.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "must be relative"):
                inventory_sidecar_tree(root, "Darwin")

            link.unlink()
            link.symlink_to("missing")
            with self.assertRaisesRegex(RuntimeError, "broken"):
                inventory_sidecar_tree(root, "Darwin")

    @unittest.skipIf(os.name == "nt", "POSIX execute bits are not a Windows contract")
    def test_posix_inventory_binds_and_requires_executable_mode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sidecar-builder-mode-") as temporary:
            root = Path(temporary)
            executable = root / SIDECAR_NAME
            payload_directory = root / "payload"
            payload_directory.mkdir()
            payload = payload_directory / "data.bin"
            executable.write_bytes(b"sidecar")
            payload.write_bytes(b"payload")
            executable.chmod(0o755)
            payload_directory.chmod(0o750)
            payload.chmod(0o640)

            files = inventory_sidecar_tree(root, "Darwin")
            self.assertEqual(files["."]["type"], "directory")
            self.assertEqual(files[SIDECAR_NAME]["mode"], "0755")
            self.assertEqual(files["payload"]["mode"], "0750")
            self.assertEqual(files["payload/data.bin"]["mode"], "0640")
            validate_sidecar_executable(root, "Darwin", files)

            executable.chmod(0o644)
            changed = inventory_sidecar_tree(root, "Darwin")
            self.assertEqual(changed[SIDECAR_NAME]["mode"], "0644")
            with self.assertRaisesRegex(RuntimeError, "must be 0755"):
                validate_sidecar_executable(root, "Darwin", changed)

    def test_windows_inventory_uses_null_mode_and_exe_entry(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sidecar-builder-windows-") as temporary:
            root = Path(temporary)
            executable = root / f"{SIDECAR_NAME}.exe"
            executable.write_bytes(b"sidecar")

            files = inventory_sidecar_tree(root, "Windows")
            self.assertIsNone(files["."]["mode"])
            self.assertIsNone(files[f"{SIDECAR_NAME}.exe"]["mode"])
            validate_sidecar_executable(root, "Windows", files)

    @unittest.skipIf(os.name == "nt", "POSIX mode assertion is not available on Windows")
    def test_mode_is_only_permission_and_special_bits(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sidecar-builder-mask-") as temporary:
            path = Path(temporary) / "file"
            path.write_bytes(b"x")
            path.chmod(0o751)
            entry = inventory_sidecar_tree(path.parent, "Darwin")[path.name]
            self.assertEqual(int(str(entry["mode"]), 8), stat.S_IMODE(path.stat().st_mode))


if __name__ == "__main__":
    unittest.main()
