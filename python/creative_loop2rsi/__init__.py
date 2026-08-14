"""Application-facing governance package for Creative RSI Studio.

The v1 package is a narrow facade over the proven ``loopctl.py`` control
plane.  Keeping the existing controller as the authority during the first app
milestone avoids a risky 7k-line rewrite while giving the desktop sidecar a
stable, JSON-only API.
"""

from .service import APP_PROTOCOL_VERSION, handle_request

__all__ = ["APP_PROTOCOL_VERSION", "handle_request"]
