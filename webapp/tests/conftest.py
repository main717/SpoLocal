"""Shared pytest fixtures for the SpoLocal backend tests.

The app builds its services at import time, so the environment is pointed at a
throwaway data directory before ``main`` is imported. Background download
workers and the startup folder scan are disabled so tests stay deterministic.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

WEBAPP_DIR = Path(__file__).resolve().parents[1]
if str(WEBAPP_DIR) not in sys.path:
    sys.path.insert(0, str(WEBAPP_DIR))

_TMP_DATA = Path(tempfile.mkdtemp(prefix="spolocal-tests-"))
os.environ.setdefault("SPLOCAL_PLAYLISTS_PATH", str(_TMP_DATA / "playlists.json"))
os.environ.setdefault("SPLOCAL_ACCOUNTS_PATH", str(_TMP_DATA / "accounts.json"))

import download_service as _download_service  # noqa: E402

# No worker threads and no startup scan of the real downloads folder.
_download_service._download_worker_count = lambda: 0
_ORIG_SYNC_FROM_DOWNLOAD_FOLDERS = _download_service.DownloadService._sync_from_download_folders
_ORIG_RESET_INTERRUPTED = _download_service.DownloadService._reset_interrupted_downloads
_download_service.DownloadService._sync_from_download_folders = lambda self: None
_download_service.DownloadService._reset_interrupted_downloads = lambda self: None

import pytest  # noqa: E402


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    root = tmp_path / "root"
    (root / "downloads" / "youtube").mkdir(parents=True)
    return root


@pytest.fixture
def service(temp_root: Path, monkeypatch: pytest.MonkeyPatch) -> _download_service.DownloadService:
    monkeypatch.setenv("SPLOCAL_PLAYLISTS_PATH", str(temp_root / "playlists.json"))
    monkeypatch.setenv("SPLOCAL_ACCOUNTS_PATH", str(temp_root / "accounts.json"))
    return _download_service.DownloadService(temp_root)


@pytest.fixture
def accounts(temp_root: Path, monkeypatch: pytest.MonkeyPatch):
    from auth_service import AccountService

    monkeypatch.setenv("SPLOCAL_ACCOUNTS_PATH", str(temp_root / "accounts.json"))
    return AccountService(temp_root)


@pytest.fixture(scope="session")
def main_module():
    import main

    return main


@pytest.fixture
def client(main_module, service, accounts, temp_root, monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient
    from export_service import ExportService
    from lyrics_service import LyricsService

    monkeypatch.setattr(main_module, "service", service)
    monkeypatch.setattr(main_module, "accounts", accounts)
    monkeypatch.setattr(main_module, "play_logs", main_module.PlayLogService(temp_root))
    monkeypatch.setattr(main_module, "lyrics_service", LyricsService(service))
    monkeypatch.setattr(main_module, "export_service", ExportService(service))
    return TestClient(main_module.app)


@pytest.fixture
def logged_in(client, accounts):
    """Register a user and return (client, user_id) with the session cookie set."""
    resp = client.post("/api/auth/register", json={"username": "tester", "password": "correct horse"})
    assert resp.status_code == 200, resp.text
    return client, resp.json()["user"]["id"]
