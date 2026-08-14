"""Load the existing controller without changing its public CLI entrypoint."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Optional


_MODULE: Optional[ModuleType] = None


def repository_root() -> Path:
    bundled_root = getattr(sys, "_MEIPASS", None)
    if isinstance(bundled_root, str) and bundled_root:
        return Path(bundled_root).resolve()
    return Path(__file__).resolve().parents[2]


def controller_script() -> Path:
    return (
        repository_root()
        / "skills"
        / "creative-loop2rsi"
        / "scripts"
        / "loopctl.py"
    )


def load_controller() -> ModuleType:
    global _MODULE
    if _MODULE is not None:
        return _MODULE
    script = controller_script()
    spec = importlib.util.spec_from_file_location(
        "creative_loop2rsi._loopctl_authority", script
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 Python Controller：{script}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _MODULE = module
    return module
