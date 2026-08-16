from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from tools.build_controller_sidecar import (
    SIDECAR_NAME,
    install_runtime_notices,
    inventory_sidecar_tree,
    select_python_license,
    sha256_file,
    validate_sidecar_executable,
)


class ControllerSidecarBuilderTests(unittest.TestCase):
    def test_runtime_notices_are_copied_and_hash_bound_without_source_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sidecar-runtime-notices-") as temporary:
            root = Path(temporary)
            output = root / "sidecar"
            sources = root / "sources"
            output.mkdir()
            sources.mkdir()
            python_license = sources / "python-license.txt"
            pyinstaller_license = sources / "pyinstaller-copying.txt"
            python_license.write_bytes(b"synthetic CPython license\n")
            pyinstaller_license.write_bytes(b"synthetic PyInstaller terms\n")

            components = install_runtime_notices(
                output,
                "3.11.15",
                "6.22.0",
                python_license=python_license,
                pyinstaller_license=pyinstaller_license,
            )

            self.assertEqual([item["name"] for item in components], ["CPython", "PyInstaller"])
            encoded = json.dumps(components, sort_keys=True)
            self.assertNotIn(str(root), encoded)
            for component in components:
                notice = component["notice"]
                installed = output / str(notice["path"])
                self.assertTrue(installed.is_file())
                self.assertEqual(notice["bytes"], installed.stat().st_size)
                self.assertEqual(notice["sha256"], sha256_file(installed))
            files = inventory_sidecar_tree(output, "Darwin")
            for component in components:
                notice = component["notice"]
                self.assertEqual(files[str(notice["path"])]["sha256"], notice["sha256"])

            with self.assertRaisesRegex(RuntimeError, "already exists"):
                install_runtime_notices(
                    output,
                    "3.11.15",
                    "6.22.0",
                    python_license=python_license,
                    pyinstaller_license=pyinstaller_license,
                )

    def test_runtime_notices_reject_unpinned_builder_versions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sidecar-runtime-version-") as temporary:
            output = Path(temporary)
            notice = output / "notice.txt"
            notice.write_text("synthetic\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "unsupported CPython"):
                install_runtime_notices(
                    output,
                    "3.12.1",
                    "6.22.0",
                    python_license=notice,
                    pyinstaller_license=notice,
                )
            with self.assertRaisesRegex(RuntimeError, "unsupported PyInstaller"):
                install_runtime_notices(
                    output,
                    "3.11.15",
                    "6.21.0",
                    python_license=notice,
                    pyinstaller_license=notice,
                )

    def test_python_license_selects_windows_root_fallback_and_rejects_conflicts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sidecar-python-license-") as temporary:
            base = Path(temporary)
            windows_root_license = base / "LICENSE.txt"
            stdlib_license = base / "Lib" / "LICENSE.txt"
            windows_root_license.write_bytes(b"synthetic CPython terms\n")

            self.assertEqual(
                select_python_license([stdlib_license, windows_root_license], base),
                windows_root_license,
            )
            stdlib_license.parent.mkdir()
            stdlib_license.write_bytes(windows_root_license.read_bytes())
            self.assertIn(
                select_python_license([stdlib_license, windows_root_license], base),
                {stdlib_license, windows_root_license},
            )
            stdlib_license.write_bytes(b"conflicting terms\n")
            with self.assertRaisesRegex(RuntimeError, "conflicting"):
                select_python_license([stdlib_license, windows_root_license], base)

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
