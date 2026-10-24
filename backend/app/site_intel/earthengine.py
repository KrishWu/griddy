"""Earth Engine connection: lazy init, per-call timeouts and a circuit breaker.  OWNER: workstream E.

Live Earth Engine is used only when EE_PROJECT is set in backend/.env (setup steps in
app/site_intel/README.md). Without it, or while the breaker is open after a failure,
get_ee() returns None and every caller falls back to cached data, so a missing login
or a slow API never breaks a click on the map.

Check your setup from backend/:  .venv/bin/python -m app.site_intel.earthengine
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

from app.site_intel.config import env

log = logging.getLogger(__name__)
T = TypeVar("T")

TIMEOUT_S = 20.0  # one Earth Engine round trip (getInfo / getMapId)
RETRY_AFTER_S = 120.0  # after a failure, stay on cached data this long before retrying

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="earthengine")
_lock = threading.Lock()
_ready = False
_failed_at = -1e9
_last_error: str | None = None


class EEUnavailable(RuntimeError):
    """Earth Engine is not configured, not authenticated, slow, or erroring."""


def _trip(err: BaseException | str) -> None:
    global _failed_at, _last_error
    _failed_at = time.monotonic()
    _last_error = str(err)[:300]
    log.warning("Earth Engine unavailable, using cached data for %.0f s: %s", RETRY_AFTER_S, _last_error)


def _initialize(project: str) -> None:
    import ee

    key_file = env("EE_SERVICE_ACCOUNT_KEY")  # optional: JSON key of a service account
    if key_file:
        import json
        from pathlib import Path

        email = json.loads(Path(key_file).read_text())["client_email"]
        ee.Initialize(ee.ServiceAccountCredentials(email, key_file), project=project)
    else:
        ee.Initialize(project=project)  # credentials from `earthengine authenticate`
    ee.data.setDeadline(int(TIMEOUT_S * 1000))


def get_ee() -> Any | None:
    """The initialized `ee` module, or None if Earth Engine can't be used right now."""
    global _ready
    project = env("EE_PROJECT")
    if not project or time.monotonic() - _failed_at < RETRY_AFTER_S:
        return None
    with _lock:
        if not _ready:
            try:
                _pool.submit(_initialize, project).result(timeout=TIMEOUT_S)
                _ready = True
            except Exception as exc:  # noqa: BLE001 - any auth/network/import error means "use the cache"
                _trip(exc)
                return None
    import ee

    return ee


def run(fn: Callable[[], T], timeout: float = TIMEOUT_S) -> T:
    """Run one Earth Engine call with a hard timeout; raise EEUnavailable on any failure."""
    if get_ee() is None:
        raise EEUnavailable(_last_error or "EE_PROJECT not set")
    try:
        return _pool.submit(fn).result(timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        _trip(exc if str(exc) else f"timed out after {timeout:.0f} s")
        raise EEUnavailable(_last_error) from exc


def warm_up() -> None:
    """Log in to Earth Engine in the background (~3 s), so the first click on the map is fast."""
    if env("EE_PROJECT"):
        threading.Thread(target=get_ee, name="earthengine-warmup", daemon=True).start()


def status() -> dict[str, Any]:
    cooling = time.monotonic() - _failed_at < RETRY_AFTER_S
    return {"configured": bool(env("EE_PROJECT")), "ready": _ready and not cooling, "last_error": _last_error}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if not env("EE_PROJECT"):
        raise SystemExit("EE_PROJECT is not set in backend/.env (see app/site_intel/README.md)")
    try:
        n = run(lambda: get_ee().Number(1).add(1).getInfo())
    except EEUnavailable as exc:
        raise SystemExit(f"Earth Engine not usable: {exc}") from exc
    print(f"Earth Engine OK (project {env('EE_PROJECT')}): 1 + 1 = {n}")
