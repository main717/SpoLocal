"""FastAPI app entrypoint for SpoLocal.

Registers page and API routes for search, playlists, downloads, and media serving.
Coordinates the download, metadata, and model layers to serve each request."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional
import logging
import re
import time
import json
import os
import secrets
import threading
import mimetypes
import shlex
import shutil
import tempfile
from urllib.parse import quote
from dotenv import load_dotenv
import asyncio

from fastapi import FastAPI, Request, Form, HTTPException, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.staticfiles import NotModifiedResponse, StaticFiles

from pydantic import BaseModel, Field

from models import Playlist, Track, track_play_variants
from download_service import DownloadService
from tag_metadata import extract_cover
from cover_image import DEFAULT_JPEG_QUALITY, DEFAULT_THUMB_MAX_SIDE, square_thumb_jpeg
from audio_quality import parse_quality_kbps, video_height_for_kbps
from youtube_stream import YouTubeStreamingService, YoutubeThumbQuality
from media_server import MediaServer
from lyrics_service import LyricsService
from export_service import ExportService
from auth_service import AccountService, AttemptLimiter, COOKIE_NAME


def _youtube_video_id_from_track_metadata(artist: str, title: str) -> Optional[str]:
    """Fallback for cover art: first ytsearch hit for artist + title."""
    q = f"{artist} {title}".strip()
    if len(q) < 2:
        return None
    try:
        hits = search_youtube_tracks(root, q, limit=1)
        if hits and hits[0].get("video_id"):
            return str(hits[0]["video_id"])
    except Exception:
        return None
    return None


_webapp_dir = Path(__file__).resolve().parent
load_dotenv(_webapp_dir / ".env")

app = FastAPI(title="SpoLocal")

# Public reads may be called cross-origin. Session cookies use SameSite=Lax so
# they survive top-level navigations (installed PWA launches, reloads). Never
# pair allow_origins=["*"] with credentials.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Windows often maps .js to text/plain in the registry; Starlette uses mimetypes.guess_type.
mimetypes.add_type("application/javascript", ".js", strict=False)
mimetypes.add_type("application/javascript", ".mjs", strict=False)
mimetypes.add_type("text/css", ".css", strict=False)
templates = Jinja2Templates(directory=str(_webapp_dir / "templates"))

root = _webapp_dir.parent
import sys

if str(root) not in sys.path:
    sys.path.insert(0, str(root))
from spotify_scraper import YoutubePlaylistMix, search_youtube_tracks

service = DownloadService(root)
lyrics_service = LyricsService(service)
export_service = ExportService(service)
accounts = AccountService(root)
auth_limiter = AttemptLimiter(max_n=5, window=60.0)

_SEARCH_PREVIEW_LIMIT = 6
_SEARCH_CACHE_MAX_RESULTS = 30
_SEARCH_CACHE_TTL_SECONDS = 180
_SEARCH_CACHE_MAX_ENTRIES = 20
_search_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_search_cache_lock = asyncio.Lock()
_recommendation_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_recommendation_cache_lock = asyncio.Lock()
_RECOMMENDATION_CACHE_TTL_SECONDS = 600
_RECOMMENDATION_CACHE_MAX_ENTRIES = 24

streaming = YouTubeStreamingService(root)


def _now_ts() -> float:
    return time.time()


def _normalize_query(q: str) -> str:
    return " ".join((q or "").strip().lower().split())


def _search_cache_cleanup(now: float) -> None:
    if not _search_cache:
        return
    expired = [k for k, v in _search_cache.items() if v[1] <= now]
    for k in expired:
        _search_cache.pop(k, None)
    if len(_search_cache) <= _SEARCH_CACHE_MAX_ENTRIES:
        return

    items = sorted(_search_cache.items(), key=lambda kv: kv[1][1])
    for k, _ in items[:len(_search_cache) - _SEARCH_CACHE_MAX_ENTRIES]:
        _search_cache.pop(k, None)




def _recommendation_cache_cleanup(now: float) -> None:
    if not _recommendation_cache:
        return

    expired = [k for k, v in _recommendation_cache.items() if v[1] <= now]
    for k in expired:
        _recommendation_cache.pop(k, None)

    if len(_recommendation_cache) <= _RECOMMENDATION_CACHE_MAX_ENTRIES:
        return

    items = sorted(_recommendation_cache.items(), key=lambda kv: kv[1][1])
    for k, _ in items[:len(_recommendation_cache) - _RECOMMENDATION_CACHE_MAX_ENTRIES]:
        _recommendation_cache.pop(k, None)






_cover_tile_cache_dir = _webapp_dir / "static" / "cover_tiles"
# Small on-disk / on-the-wire JPEGs so the browser does not decode huge album art for tiny UI tiles.
_COVER_THUMB_MAX_SIDE = DEFAULT_THUMB_MAX_SIDE
_COVER_JPEG_QUALITY = DEFAULT_JPEG_QUALITY


def _track_payload_row(t: Track, *, playback_quality: Optional[str] = None) -> dict[str, Any]:
    st = t.status.value if hasattr(t.status, "value") else str(t.status)
    variants = track_play_variants(t)
    play_src = streaming.resolve_track_play_src(t, playback_quality=playback_quality)
    stream_src = streaming.stream_play_src_for_track(t)
    return {
        "id": t.id,
        "title": t.title,
        "artist": t.artist,
        "album": t.album or "",
        "play_src": play_src,
        "stream_src": stream_src,
        "play_variants": variants,
        "status": st,
        "url": t.url or "",
        "youtube_video_id": t.resolved_youtube_video_id(),
        "error": t.error or "",
        "loudness_gain_db": t.loudness_gain_db,
    }


def cover_tile_cache_path(playlist_id: str, track_id: str, *, max_side: Optional[int] = None) -> Path:
    """On-disk cache: square JPEG, max edge _COVER_THUMB_MAX_SIDE (see module constants)."""
    side = int(max_side or _COVER_THUMB_MAX_SIDE)
    safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in playlist_id.strip())[:120]
    safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in track_id.strip())[:120]
    return _cover_tile_cache_dir / f"{safe_p}_{safe_t}_s{side}.jpg"


def _unlink_track_cover_caches(playlist_id: str, track_id: str) -> None:
    """Remove current and any legacy per-track cover cache files."""
    safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in playlist_id.strip())[:120]
    safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in track_id.strip())[:120]
    try:
        for p in _cover_tile_cache_dir.glob(f"{safe_p}_{safe_t}*.jpg"):
            p.unlink(missing_ok=True)
    except OSError:
        pass


def _playback_cover_tier(request: Request) -> str:
    """Data Saver rows use YouTube thumbs, so the server can render them directly."""
    raw = (request.cookies.get("spolocal_playback_kbps") or "").strip()
    try:
        return "low" if int(raw) <= 64 else "high"
    except ValueError:
        return "high"


def _cover_tiles_for_playlist(pl: Playlist, tier: str = "high") -> list[str]:
    tiles: list[str] = []
    for t in pl.tracks[:4]:
        vid = t.resolved_youtube_video_id() if tier == "low" else ""
        if vid:
            tiles.append(f"/api/thumb?vid={quote(vid, safe='')}&q=low")
        else:
            tiles.append(f"/playlists/{pl.id}/tracks/{t.id}/cover")
    return tiles


def _library_pool_payload(owner_id: Optional[str] = None) -> list[dict[str, Any]]:
    pool: list[dict[str, Any]] = []
    for pl in service.list_playlists_for_user(owner_id):
        for t in pl.tracks:
            variants = track_play_variants(t)
            src = streaming.resolve_track_play_src(t)
            if not src:
                continue
            pool.append(
                {
                    "playlist_id": pl.id,
                    "track_id": t.id,
                    "title": t.title,
                    "artist": t.artist,
                    "album": t.album or "",
                    "play_src": src,
                    "play_variants": variants,
                    "url": t.url or "",
                    "youtube_video_id": t.resolved_youtube_video_id(),
                }
            )
    return pool


def _annotate_library_matches(hits: list[dict[str, Any]], owner_id: Optional[str] = None) -> None:
    for hit in hits:
        hit["library_matches"] = service.library_matches_for_hit(
            str(hit.get("video_id") or ""),
            str(hit.get("title") or ""),
            str(hit.get("artist") or hit.get("channel") or ""),
            owner_id,
        )


@app.get("/", response_class=HTMLResponse)
async def index(request: Request, playlist_id: Optional[str] = None):
    user = _auth_user(request)
    uid = user["id"] if user else None
    pid = playlist_id.strip() if playlist_id else None
    playlists = service.list_playlists_for_user(uid)
    is_home = not pid
    current: Optional[Playlist] = None
    current_tracks_payload: list[dict[str, Any]] = []
    current_cover_tiles: list[str] = []
    home_library_pool: list[dict[str, Any]] = []

    if pid:
        current = service.get_playlist_for_user(pid, uid)
        if not current:
            is_home = True
        else:
            await asyncio.to_thread(service.hydrate_media_paths, current, fill_albums=False, persist=False)
            current_tracks_payload = [_track_payload_row(t) for t in current.tracks]
            current_cover_tiles = _cover_tiles_for_playlist(current, _playback_cover_tier(request))

    if is_home:
        for pl in playlists:
            await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
        home_library_pool = _library_pool_payload(uid)

    nav_current = None if is_home else (current.id if current else None)
    cover_tier = _playback_cover_tier(request)
    playlist_nav = service.list_playlist_nav(nav_current, uid, cover_tier)
    liked_id = service.liked_songs_id_for(uid)
    liked_nav = next((row for row in playlist_nav if row["id"] == liked_id), None)
    if liked_nav is not None:
        playlist_nav = [row for row in playlist_nav if row["id"] != liked_id]
    playlist_catalog = service.list_playlist_catalog(uid, cover_tier)
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "playlist_nav": playlist_nav,
            "liked_nav": liked_nav,
            "playlist_catalog": playlist_catalog,
            "current": current,
            "is_home": is_home,
            "current_cover_tiles": current_cover_tiles,
            "current_tracks_payload": current_tracks_payload,
            "cover_tier": cover_tier,
            "home_library_pool": home_library_pool,
            "service": service,
            "liked_playlist_id": service.liked_songs_id_for(uid),
            "user": user,
        },
    )


def _session_cookie_kwargs(request: Request) -> dict[str, Any]:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": proto == "https",
        "max_age": 30 * 24 * 3600,
        "path": "/",
    }


def _client_ip(request: Request) -> str:
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _auth_guard(request: Request) -> None:
    key = _client_ip(request)
    if auth_limiter.blocked(key):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again in a minute.")


def _auth_user(request: Request, *, required: bool = False) -> Optional[dict[str, Any]]:
    user = accounts.user_from_request(
        request.cookies.get(COOKIE_NAME),
        request.headers.get("authorization"),
    )
    if required and not user:
        raise HTTPException(status_code=401, detail="Login required")
    return user


def _owner_id(request: Request, *, required: bool = False) -> Optional[str]:
    user = _auth_user(request, required=required)
    return user["id"] if user else None


def _owned_playlist_or_404(request: Request, playlist_id: str) -> Playlist:
    """Login + ownership gate for any playlist-scoped route. 404 hides existence."""
    uid = _owner_id(request, required=True)
    pl = service.get_playlist_for_user(playlist_id, uid)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return pl


class AuthBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=1, max_length=200)


class DeviceBody(BaseModel):
    id: Optional[str] = None
    name: str = Field("Player", max_length=80)
    make_active: bool = True


class PlayerCommandBody(BaseModel):
    action: str = Field(..., min_length=1, max_length=16)
    device_id: Optional[str] = None


@app.get("/api/auth/me")
async def api_auth_me(request: Request):
    """Guest when not logged in. Search, stream, and playlist view stay public."""
    return JSONResponse({"user": _auth_user(request)})


@app.post("/api/auth/register")
async def api_auth_register(body: AuthBody, request: Request):
    _auth_guard(request)
    ip = _client_ip(request)
    try:
        result = accounts.register(body.username, body.password)
    except ValueError as exc:
        auth_limiter.hit(ip)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    auth_limiter.clear(ip)
    service.claim_ownerless_playlists(result["user"]["id"])
    resp = JSONResponse(result)
    resp.set_cookie(COOKIE_NAME, result["token"], **_session_cookie_kwargs(request))
    return resp


@app.post("/api/auth/login")
async def api_auth_login(body: AuthBody, request: Request):
    _auth_guard(request)
    ip = _client_ip(request)
    try:
        result = accounts.login(body.username, body.password)
    except ValueError as exc:
        auth_limiter.hit(ip)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result.get("mfa_required"):
        return JSONResponse({
            "mfa_required": True,
            "mfa_token": result["mfa_token"],
        })
    auth_limiter.clear(ip)
    service.claim_ownerless_playlists(result["user"]["id"])
    resp = JSONResponse(result)
    resp.set_cookie(COOKIE_NAME, result["token"], **_session_cookie_kwargs(request))
    return resp


class MfaLoginBody(BaseModel):
    mfa_token: str = Field(..., min_length=10, max_length=200)
    code: str = Field(..., min_length=6, max_length=16)


class MfaCodeBody(BaseModel):
    code: str = Field(..., min_length=6, max_length=16)


@app.post("/api/auth/login/mfa")
async def api_auth_login_mfa(body: MfaLoginBody, request: Request):
    _auth_guard(request)
    ip = _client_ip(request)
    try:
        result = accounts.complete_mfa_login(body.mfa_token, body.code)
    except ValueError as exc:
        auth_limiter.hit(ip)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    auth_limiter.clear(ip)
    service.claim_ownerless_playlists(result["user"]["id"])
    resp = JSONResponse(result)
    resp.set_cookie(COOKIE_NAME, result["token"], **_session_cookie_kwargs(request))
    return resp


@app.get("/api/auth/mfa/setup")
async def api_auth_mfa_setup(request: Request):
    user = _auth_user(request, required=True)
    try:
        return JSONResponse(accounts.begin_mfa_setup(user["id"]))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/auth/mfa/confirm")
async def api_auth_mfa_confirm(body: MfaCodeBody, request: Request):
    _auth_guard(request)
    user = _auth_user(request, required=True)
    ip = _client_ip(request)
    try:
        result = accounts.confirm_mfa(user["id"], body.code)
    except ValueError as exc:
        auth_limiter.hit(ip)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    auth_limiter.clear(ip)
    return JSONResponse(result)


@app.post("/api/auth/mfa/disable")
async def api_auth_mfa_disable(body: MfaCodeBody, request: Request):
    _auth_guard(request)
    user = _auth_user(request, required=True)
    ip = _client_ip(request)
    try:
        result = accounts.disable_mfa(user["id"], body.code)
    except ValueError as exc:
        auth_limiter.hit(ip)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    auth_limiter.clear(ip)
    return JSONResponse(result)


@app.post("/api/auth/logout")
async def api_auth_logout(request: Request):
    accounts.logout(request.cookies.get(COOKIE_NAME), request.headers.get("authorization"))
    resp = JSONResponse({"ok": True, "user": None})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.post("/api/auth/devices")
async def api_auth_devices(body: DeviceBody, request: Request):
    user = _auth_user(request, required=True)
    try:
        public = accounts.upsert_device(
            user["id"],
            body.id,
            body.name,
            make_active=body.make_active,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse({"user": public})


@app.post("/api/auth/devices/{device_id}/active")
async def api_auth_device_active(device_id: str, request: Request):
    user = _auth_user(request, required=True)
    try:
        public = accounts.set_active_device(user["id"], device_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse({"user": public})


@app.post("/api/player/commands")
async def api_player_commands(body: PlayerCommandBody, request: Request):
    """Queue play/pause/next for a logged-in user's active (or named) device."""
    user = _auth_user(request, required=True)
    try:
        return JSONResponse(accounts.enqueue_command(user["id"], body.action, body.device_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/player/commands/poll")
async def api_player_commands_poll(request: Request, device_id: str = Query(..., min_length=1)):
    user = _auth_user(request, required=True)
    return JSONResponse({"commands": accounts.poll_commands(user["id"], device_id.strip())})


@app.get("/api/playlists/catalog")
async def api_playlists_catalog(request: Request):
    return JSONResponse(service.list_playlist_catalog(_owner_id(request), _playback_cover_tier(request)))


@app.get("/api/liked-keys")
async def api_liked_keys(request: Request):
    return JSONResponse({"keys": service.list_liked_entry_keys(_owner_id(request))})


class PlayLogService:
    """Per-account play counters persisted next to the other data files.

    Counts live on the server so every device sees the same analytics. Guests
    keep their counters in localStorage only. Counts only ever go up, so the
    client can merge its local history into the account once, after which the
    server wins.
    """

    MAX_DAYS = 60
    COUNTER_FIELDS = ("track_plays", "playlist_plays", "day_plays")

    def __init__(self, data_root: Path) -> None:
        self.root = Path(data_root)
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, Any]] = {}
        self._load()

    def _data_file(self) -> Path:
        override = (os.environ.get("SPLOCAL_PLAY_LOGS_PATH") or "").strip()
        if override:
            return Path(override)
        playlists = (os.environ.get("SPLOCAL_PLAYLISTS_PATH") or "").strip()
        if playlists:
            return Path(playlists).parent / "play_logs.json"
        data_dir = self.root / "data"
        if data_dir.is_dir():
            return data_dir / "play_logs.json"
        return self.root / "play_logs.json"

    def _load(self) -> None:
        path = self._data_file()
        if not path.is_file():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(raw, dict):
            self._data = {str(k): v for k, v in raw.items() if isinstance(v, dict)}

    def _save(self) -> None:
        path = self._data_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._data, indent=2), encoding="utf-8")
        tmp.replace(path)

    @classmethod
    def _empty(cls) -> dict[str, Any]:
        return {field: {} for field in cls.COUNTER_FIELDS}

    @staticmethod
    def _clean_counts(raw: Any) -> dict[str, int]:
        clean: dict[str, int] = {}
        if not isinstance(raw, dict):
            return clean
        for key, value in raw.items():
            try:
                count = int(value)
            except (TypeError, ValueError):
                continue
            if count > 0:
                clean[str(key)] = count
        return clean

    def get(self, owner_id: Optional[str]) -> dict[str, Any]:
        if not owner_id:
            return self._empty()
        with self._lock:
            row = self._data.get(owner_id) or {}
            return {field: dict(row.get(field) or {}) for field in self.COUNTER_FIELDS}

    def record(
        self,
        owner_id: Optional[str],
        playlist_id: str,
        track_id: str,
        day: str,
    ) -> bool:
        pid = (playlist_id or "").strip()
        tid = (track_id or "").strip()
        if not owner_id or not pid or not tid:
            return False
        key = f"{pid}|{tid}"
        with self._lock:
            row = self._data.setdefault(owner_id, self._empty())
            tracks = row.setdefault("track_plays", {})
            tracks[key] = int(tracks.get(key) or 0) + 1
            playlists = row.setdefault("playlist_plays", {})
            playlists[pid] = int(playlists.get(pid) or 0) + 1
            days = row.setdefault("day_plays", {})
            stamp = (day or "").strip()[:10]
            if stamp:
                days[stamp] = int(days.get(stamp) or 0) + 1
                if len(days) > self.MAX_DAYS:
                    for old in sorted(days)[: len(days) - self.MAX_DAYS]:
                        del days[old]
            self._save()
        return True

    def seed(self, owner_id: Optional[str], payload: dict[str, Any]) -> bool:
        """Merge a device's local history into the account, keeping the larger count.

        A device seeds once, so its old localStorage plays survive the switch to
        server-side counters without double counting the plays it mirrored back.
        """
        if not owner_id or not isinstance(payload, dict):
            return False
        incoming = {field: self._clean_counts(payload.get(field)) for field in self.COUNTER_FIELDS}
        if not any(incoming.values()):
            return False
        with self._lock:
            row = self._data.setdefault(owner_id, self._empty())
            for field, counts in incoming.items():
                current = row.setdefault(field, {})
                for key, value in counts.items():
                    if value > int(current.get(key) or 0):
                        current[key] = value
            days = row.get("day_plays") or {}
            if len(days) > self.MAX_DAYS:
                for old in sorted(days)[: len(days) - self.MAX_DAYS]:
                    del days[old]
            self._save()
        return True


play_logs = PlayLogService(root)


class PlayLogBody(BaseModel):
    playlist_id: str = Field(..., min_length=1)
    track_id: str = Field(..., min_length=1)


class PlayLogSeedBody(BaseModel):
    track_plays: dict[str, int] = Field(default_factory=dict)
    playlist_plays: dict[str, int] = Field(default_factory=dict)
    day_plays: dict[str, int] = Field(default_factory=dict)


@app.get("/api/play-log")
async def api_play_log_get(request: Request):
    uid = _owner_id(request)
    payload = {"authenticated": bool(uid)}
    payload.update(play_logs.get(uid))
    return JSONResponse(payload)


@app.post("/api/play-log")
async def api_play_log_record(body: PlayLogBody, request: Request):
    uid = _owner_id(request)
    if not uid:
        return JSONResponse({"ok": False, "stored": False})
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    stored = play_logs.record(uid, body.playlist_id, body.track_id, day)
    return JSONResponse({"ok": True, "stored": stored})


@app.post("/api/play-log/seed")
async def api_play_log_seed(body: PlayLogSeedBody, request: Request):
    uid = _owner_id(request)
    if not uid:
        return JSONResponse({"ok": False, "seeded": False})
    seeded = play_logs.seed(uid, body.model_dump())
    return JSONResponse({"ok": True, "seeded": seeded})


class CreatePlaylistBody(BaseModel):
    name: str = Field(..., min_length=1)
    # Optional first track: creating a playlist from a search hit adds and
    # downloads it in the same request, so it can never end up empty.
    title: Optional[str] = Field(None, max_length=300)
    artist: Optional[str] = Field(None, max_length=300)
    url: Optional[str] = None
    album: Optional[str] = Field(None, max_length=300)
    video_id: Optional[str] = None
    quality: Optional[str] = None
    source_playlist_id: Optional[str] = None
    source_track_id: Optional[str] = None


class TrackLikeBody(BaseModel):
    source_playlist_id: str = Field(..., min_length=1)
    source_track_id: str = Field(..., min_length=1)
    liked: bool


class LikedAddBody(BaseModel):
    """A search hit saved straight to Liked Songs, no playlist in between."""

    title: str = Field(..., min_length=1, max_length=300)
    artist: Optional[str] = Field(None, max_length=300)
    url: Optional[str] = None
    album: Optional[str] = Field(None, max_length=300)
    video_id: Optional[str] = None
    quality: Optional[str] = None
    source_playlist_id: Optional[str] = None
    source_track_id: Optional[str] = None


class TrackDetailsBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    artist: str = Field("", max_length=300)
    album: str = Field("", max_length=300)


@app.post("/api/track/like")
async def api_track_like(body: TrackLikeBody, request: Request):
    uid = _owner_id(request, required=True)
    ok = service.set_track_liked(body.source_playlist_id.strip(), body.source_track_id.strip(), body.liked, uid)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="Could not update like. The track may not be downloaded yet, or it may already be in Liked Songs.",
        )
    return JSONResponse({"ok": True, "liked": body.liked})


@app.post("/api/liked-songs/add")
async def api_liked_songs_add(body: LikedAddBody, request: Request):
    """Add a song to the signed-in user's Liked Songs directly."""
    uid = _owner_id(request, required=True)
    track = await asyncio.to_thread(
        service.add_track_to_liked_songs,
        body.title.strip(),
        (body.artist or "").strip(),
        url=(body.url or "").strip() or None,
        album=(body.album or "").strip() or None,
        owner_id=uid,
        video_id=(body.video_id or "").strip() or None,
        download_quality=(body.quality or "192").strip() or "192",
        source_playlist_id=(body.source_playlist_id or "").strip() or None,
        source_track_id=(body.source_track_id or "").strip() or None,
    )
    if track is None:
        raise HTTPException(status_code=400, detail="Could not save this song to Liked Songs.")
    return JSONResponse(
        {
            "ok": True,
            "playlist_id": service.liked_songs_id_for(uid),
            "track": _track_payload_row(track),
        }
    )


@app.get("/api/playlists/{playlist_id}/tracks/{track_id}/info")
async def api_track_info(playlist_id: str, track_id: str, request: Request):
    _owned_playlist_or_404(request, playlist_id)
    info = service.get_track_info(playlist_id, track_id)
    if not info:
        raise HTTPException(status_code=404, detail="Track not found")
    return JSONResponse(info)


@app.post("/api/playlists/{playlist_id}/tracks/{track_id}/details")
async def api_track_details(playlist_id: str, track_id: str, body: TrackDetailsBody, request: Request):
    _owned_playlist_or_404(request, playlist_id)
    updated = await asyncio.to_thread(
        service.update_track_details,
        playlist_id,
        track_id,
        body.title,
        body.artist,
        body.album,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Track not found")
    return JSONResponse({"ok": True, **updated})


@app.get("/api/playlists/{playlist_id}/tracks/{track_id}/loudness-gain")
async def api_track_loudness_gain(playlist_id: str, track_id: str, request: Request):
    """Return the cached loudness gain, or kick off background analysis and return pending.

    Analysis runs ffmpeg ebur128 over the whole file (seconds), so never block playback on it.
    """
    pl = _owned_playlist_or_404(request, playlist_id)
    track = pl.get_track(track_id.strip())
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    if track.loudness_gain_db is None:
        async def _analyze_in_background():
            try:
                await asyncio.to_thread(service.ensure_track_loudness_gain, pl.id, track.id)
            except Exception:
                pass

        asyncio.get_running_loop().create_task(_analyze_in_background())
        return JSONResponse({"loudness_gain_db": None, "pending": True})
    return JSONResponse({"loudness_gain_db": track.loudness_gain_db})


@app.get("/api/playlist/state")
async def api_playlist_state(request: Request, playlist_id: str):
    pl = _owned_playlist_or_404(request, playlist_id)
    await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    return JSONResponse(
        {
            "playlist_id": pl.id,
            "tracks_payload": [_track_payload_row(t) for t in pl.tracks],
        },
    )


@app.get("/api/storage")
async def api_storage():
    """Library size on disk plus free space, cached for a minute."""
    return JSONResponse(await asyncio.to_thread(_storage_payload))


_storage_cache: dict[str, Any] = {"at": 0.0, "payload": None}


def _storage_payload() -> dict[str, Any]:
    now = time.monotonic()
    cached = _storage_cache["payload"]
    if cached is not None and now - _storage_cache["at"] < 60:
        return cached
    media_root = service.root / "downloads"
    media_bytes = 0
    media_files = 0
    by_quality: dict[str, int] = {}
    if media_root.is_dir():
        for path in media_root.rglob("*"):
            try:
                if not path.is_file():
                    continue
                size = path.stat().st_size
            except OSError:
                continue
            media_bytes += size
            media_files += 1
            match = re.search(r"__(\d+)k\.", path.name)
            bucket = match.group(1) if match else "other"
            by_quality[bucket] = by_quality.get(bucket, 0) + size
    try:
        usage = shutil.disk_usage(media_root if media_root.is_dir() else service.root)
        free_bytes, total_bytes = usage.free, usage.total
    except OSError:
        free_bytes, total_bytes = 0, 0
    payload = {
        "media_bytes": media_bytes,
        "media_files": media_files,
        "free_bytes": free_bytes,
        "total_bytes": total_bytes,
        "by_quality": by_quality,
    }
    _storage_cache["at"] = now
    _storage_cache["payload"] = payload
    return payload


@app.get("/api/home/view")
async def api_home_view(request: Request):
    """HTML fragment for in-page home switching."""
    uid = _owner_id(request)
    for pl in service.list_playlists_for_user(uid):
        await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    tpl = templates.env.get_template("partials/home_main.html")
    html = tpl.render(request=request)
    return JSONResponse(
        {
            "html": html,
            "view": "home",
            "library_pool": _library_pool_payload(uid),
            "catalog": service.list_playlist_catalog(uid, _playback_cover_tier(request)),
        }
    )


@app.post("/api/playlists")
async def api_create_playlist(body: CreatePlaylistBody, request: Request):
    uid = _owner_id(request, required=True)
    try:
        pl = service.create_playlist(body.name.strip(), uid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    track = None
    first_title = (body.title or "").strip()
    if first_title:
        try:
            track = service.add_track_to_playlist(
                pl.id,
                first_title,
                (body.artist or "").strip(),
                url=(body.url or "").strip() or None,
                album=(body.album or "").strip() or None,
                enqueue_download=True,
                download_quality=(body.quality or "192").strip() or "192",
                owner_id=uid,
                source_playlist_id=(body.source_playlist_id or "").strip() or None,
                source_track_id=(body.source_track_id or "").strip() or None,
                video_id=(body.video_id or "").strip() or None,
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    tiles = _cover_tiles_for_playlist(pl, _playback_cover_tier(request))
    return JSONResponse(
        {
            "ok": True,
            "playlist": {
                "id": pl.id,
                "name": pl.name,
                "bio": pl.bio or "",
                "cover_tiles": tiles,
                "system_locked": False,
            },
            "track": _track_payload_row(track) if track else None,
        }
    )


@app.get("/api/playlist/view")
async def api_playlist_view(request: Request, playlist_id: str):
    """HTML fragment + track payload for in-page playlist switching (query param avoids path parsing issues)."""
    pl = _owned_playlist_or_404(request, playlist_id)
    uid = _owner_id(request)
    await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    tracks_payload = [_track_payload_row(t) for t in pl.tracks]
    tpl = templates.env.get_template("partials/playlist_main.html")
    cover_tier = _playback_cover_tier(request)
    html = tpl.render(
        request=request,
        current=pl,
        current_cover_tiles=_cover_tiles_for_playlist(pl, cover_tier),
        cover_tier=cover_tier,
        liked_playlist_id=service.liked_songs_id_for(uid),
    )
    return JSONResponse(
        {"html": html, "tracks_payload": tracks_payload, "playlist_id": pl.id},
    )


@app.get("/api/playlist/recommendations")
async def api_playlist_recommendations(
    request: Request,
    playlist_id: str,
    background_tasks: BackgroundTasks,
    limit: int = 12,
    fresh: int = 0,
):
    """YouTube Mix from playlist seeds; same hit shape as `/api/search/songs`."""
    pl = _owned_playlist_or_404(request, playlist_id)
    lim = max(1, min(int(limit), 30))
    seed_ids = [t.resolved_youtube_video_id() for t in (pl.tracks or [])]
    seed_artists = [t.artist or "" for t in (pl.tracks or [])]
    seed_key = ",".join(YoutubePlaylistMix().pick_seed_ids(seed_ids, artists=seed_artists))
    cache_key = f"{pl.id}|{lim}|rdmix2|{seed_key}"

    now = _now_ts()
    cached_hits: list[dict[str, Any]] | None = None
    async with _recommendation_cache_lock:
        _recommendation_cache_cleanup(now)
        if fresh:
            _recommendation_cache.pop(cache_key, None)
        cached = _recommendation_cache.get(cache_key)
        if cached is not None:
            cached_hits = cached[0]

    if cached_hits is None:
        def _load_hits() -> list[dict[str, Any]]:
            return YoutubePlaylistMix(root).mix_for_seeds(seed_ids, lim, artists=seed_artists)[:lim]

        loop = asyncio.get_event_loop()
        cached_hits = await loop.run_in_executor(None, _load_hits)
        async with _recommendation_cache_lock:
            _recommendation_cache[cache_key] = (cached_hits, now + _RECOMMENDATION_CACHE_TTL_SECONDS)

    out = [dict(h) for h in (cached_hits or [])][:lim]
    await streaming.annotate_search_stream_src(out)
    _annotate_library_matches(out, _owner_id(request))
    prefetch_ids = [str(h.get("video_id") or "") for h in out]
    background_tasks.add_task(streaming.prefetch_mix_stream_payloads, prefetch_ids)
    return JSONResponse(out)


@app.get("/api/track/mix")
async def api_track_mix(
    request: Request,
    background_tasks: BackgroundTasks,
    vid: str = "",
    playlist_id: str = "",
    track_id: str = "",
    limit: int = 24,
):
    """YouTube Mix for one seed track. Hits are streams, same shape as search."""
    seed_title = ""
    seed_artist = ""
    video_id = (vid or "").strip()
    pid = (playlist_id or "").strip()
    tid = (track_id or "").strip()
    if pid and tid:
        pl = _owned_playlist_or_404(request, pid)
        track = next((t for t in (pl.tracks or []) if str(t.id) == tid), None)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        video_id = track.resolved_youtube_video_id() or video_id
        seed_title = (track.title or "").strip()
        seed_artist = (track.artist or "").strip()
    if len(video_id) != 11:
        raise HTTPException(status_code=400, detail="No YouTube id for this song.")
    asyncio.create_task(streaming.prefetch_preview(video_id))
    lim = max(1, min(int(limit), 30))
    cache_key = f"songmix|{video_id}|{lim}"
    now = _now_ts()
    cached_hits: list[dict[str, Any]] | None = None
    async with _recommendation_cache_lock:
        _recommendation_cache_cleanup(now)
        cached = _recommendation_cache.get(cache_key)
        if cached is not None:
            cached_hits = cached[0]

    if cached_hits is None:
        def _load_hits() -> list[dict[str, Any]]:
            related = YoutubePlaylistMix(root).mix_for_video(video_id, lim)
            seed = {
                "video_id": video_id,
                "title": seed_title or "Mix",
                "artist": seed_artist or "YouTube",
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "duration_sec": None,
                "channel": seed_artist,
                "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/default.jpg",
            }
            return [seed] + [h for h in related if h.get("video_id") != video_id]

        loop = asyncio.get_event_loop()
        cached_hits = await loop.run_in_executor(None, _load_hits)
        async with _recommendation_cache_lock:
            _recommendation_cache[cache_key] = (cached_hits, now + _RECOMMENDATION_CACHE_TTL_SECONDS)

    out = [dict(h) for h in (cached_hits or [])][: lim + 1]
    if seed_title and out:
        out[0]["title"] = seed_title
        out[0]["artist"] = seed_artist or out[0].get("artist") or ""
    await streaming.annotate_search_stream_src(out)
    _annotate_library_matches(out, _owner_id(request))
    warm_ids: list[str] = []
    for hit in out:
        hid = str(hit.get("video_id") or "").strip()
        if len(hid) == 11 and hid not in warm_ids:
            warm_ids.append(hid)
    if warm_ids:
        asyncio.create_task(streaming.prefetch_mix_stream_payloads(warm_ids))
    seed = out[0] if out else {
        "video_id": video_id,
        "title": seed_title,
        "artist": seed_artist,
    }
    return JSONResponse({"seed": seed, "hits": out})


@app.get("/api/spotify/resolve")
async def api_spotify_resolve(url: str = Query(..., min_length=8)):
    """Resolve a Spotify track link to a YouTube search query (top bar -> search UI)."""
    try:
        q = await run_in_threadpool(
            service.spotify_url_search_query,
            url.strip().split("?")[0].split("#")[0].strip(),
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not q:
        raise HTTPException(
            status_code=400,
            detail="Only Spotify track links can be opened as search. Use playlist import for playlists.",
        )
    return JSONResponse({"kind": "track", "search_query": q})


@app.get("/api/search/songs")
async def api_search_songs(request: Request, q: str = "", limit: int = 30, offset: int = 0, fresh: int = 0):
    q = (q or "").strip()
    if len(q) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters.")
    if offset < 0:
        offset = 0
    if limit < 1:
        limit = 1
    elif limit > _SEARCH_PREVIEW_LIMIT:
        limit = _SEARCH_PREVIEW_LIMIT
    normalized_q = _normalize_query(q)
    now = _now_ts()
    cache_key = normalized_q
    loop = asyncio.get_event_loop()

    hits_cache: list[dict[str, Any]] | None = None

    async with _search_cache_lock:
        _search_cache_cleanup(now)
        if fresh:
            _search_cache.pop(cache_key, None)
        cached = _search_cache.get(cache_key)
        if cached is not None:
            hits_cache = cached[0]

    if hits_cache is None:
        hits_cache = await loop.run_in_executor(None, search_youtube_tracks, root, normalized_q, _SEARCH_CACHE_MAX_RESULTS)
        async with _search_cache_lock:
            _search_cache[cache_key] = (hits_cache, now + _SEARCH_CACHE_TTL_SECONDS)

    start = min(offset, len(hits_cache))
    end = min(start + limit, len(hits_cache))
    hits = [dict(h) for h in hits_cache[start:end]]
    if hits:
        await streaming.annotate_search_stream_src(hits)
        _annotate_library_matches(hits, _owner_id(request))

    return JSONResponse(
        {
            "hits": hits,
            "offset": start,
            "limit": limit,
            "has_more": end < len(hits_cache),
        }
    )


@app.get("/api/preview")
async def api_preview(vid: str):
    """Stream the first ~30 s of a YouTube video's best audio."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")

    MAX_BYTES = 512 * 1024  # ~30 s at 128 kbps

    async def generate() -> AsyncIterator[bytes]:
        async for chunk in streaming.stream_ytdlp_audio_or_502(vid.strip(), max_bytes=MAX_BYTES, max_seconds=30):
            yield chunk

    return StreamingResponse(generate(), media_type="audio/webm")


@app.get("/api/stream/chapters")
async def api_stream_chapters(vid: str):
    """YouTube chapters for search/stream playback only (not downloaded tracks)."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    try:
        source = await streaming.get_preview_payload(vid.strip())
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    chapters = source.chapters or []
    lyrics = "\n".join(str(row.get("text") or "") for row in chapters)
    return JSONResponse(
        {
            "lyrics": lyrics,
            "source": "chapters" if chapters else "none",
            "has_audio": True,
            "lrc_data": chapters or None,
            "lrc_raw": None,
            "readonly": True,
        }
    )


@app.get("/api/stream/loudness-gain")
async def api_stream_loudness_gain(vid: str):
    """Return the cached stream loudness gain, or start measuring and return pending.

    Measuring downloads the track once and runs ffmpeg ebur128, so never block
    playback on it. The result is cached per video id on disk.
    """
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    video_id = vid.strip()
    cached = streaming.stream_loudness_gain(video_id)
    if cached is not None:
        return JSONResponse({"loudness_gain_db": cached})
    asyncio.get_running_loop().create_task(streaming.ensure_stream_loudness_gain(video_id))
    return JSONResponse({"loudness_gain_db": None, "pending": True})


@app.get("/api/stream/lyrics")
async def api_stream_lyrics(title: str = "", artist: str = ""):
    """Same LRCLIB lookup as after a download; nothing is written to disk."""
    if not (title or "").strip():
        raise HTTPException(status_code=400, detail="Title is required")
    payload = await asyncio.to_thread(lyrics_service.remote_payload, artist, title)
    return JSONResponse(payload)


@app.post("/api/stream/release")
async def api_stream_release(vid: Optional[str] = Query(None)):
    if vid:
        if not vid.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(status_code=400, detail="Invalid video id")
        streaming.release(vid.strip())
    else:
        streaming.release(None)
    return JSONResponse({"ok": True})


@app.api_route("/api/stream", methods=["GET", "HEAD"])
async def api_stream(request: Request, vid: str, fresh: int = 0):
    """Proxy YouTube audio with Range so the player buffers/seeks like YouTube."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    if fresh:
        streaming.release(vid)
    return await streaming.proxy(vid).response_for(request)


@app.get("/api/thumb")
async def api_thumb(vid: str, q: str = "high"):
    """Same-origin YouTube thumbnail so canvas color extraction is not tainted."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    fetched = await streaming.fetch_thumbnail_bytes(vid, YoutubeThumbQuality.parse(q))
    if fetched:
        raw, mime = fetched
        return Response(
            content=raw,
            media_type=mime,
            headers={"Cache-Control": "public, max-age=604800, immutable"},
        )
    raise HTTPException(status_code=404, detail="Thumbnail not found")


@app.get("/api/stream/prepare")
async def api_stream_prepare(vid: str):
    """Resolve googlevideo URL only. Returns ext for MSE codec selection."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    try:
        source = await streaming.get_preview_payload(vid.strip())
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse({
        "ok": True,
        "ext": source.ext,
        "filesize": source.filesize,
        "duration_sec": source.duration_sec,
    })


@app.get("/api/stream/video/prepare")
async def api_stream_video_prepare(vid: str, height: int = 0, kbps: int = 0):
    """Resolve the DASH URL only. No media bytes until /api/stream/video."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    h = height if height in (360, 480, 720) else video_height_for_kbps(parse_quality_kbps(kbps))
    try:
        await streaming.get_video_payload(vid, h)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse({"ok": True})


@app.api_route("/api/stream/video", methods=["GET", "HEAD"])
async def api_stream_video(request: Request, vid: str, height: int = 0, kbps: int = 0):
    """DASH/progressive video-only proxy. Loads only when the lyrics pane requests it."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    if height in (360, 480, 720):
        h = height
    else:
        h = video_height_for_kbps(parse_quality_kbps(kbps))
    return await streaming.proxy(vid, height=h).response_for(request)


@app.post("/playlists")
async def create_playlist(request: Request, name: str = Form(...)):
    uid = _owner_id(request, required=True)
    wants_json = "application/json" in (request.headers.get("accept") or "").lower()
    try:
        pl = service.create_playlist(name, uid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if wants_json:
        return JSONResponse({"ok": True, "playlist_id": pl.id, "name": pl.name})
    return RedirectResponse("/", status_code=303)


@app.post("/playlists/import")
async def import_spotify(request: Request, spotify_url: str = Form(...)):
    uid = _owner_id(request, required=True)
    try:
        pl = service.import_spotify_playlist(spotify_url, uid)
        return RedirectResponse(f"/?playlist_id={pl.id}", status_code=303)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/playlists/{playlist_id}/tracks")
async def add_track(
    request: Request,
    playlist_id: str,
    title: str = Form(...),
    artist: str = Form(...),
    url: Optional[str] = Form(None),
    album: Optional[str] = Form(None),
    skip_download: Optional[str] = Form(None),
    quality: Optional[str] = Form(None),
    source_playlist_id: Optional[str] = Form(None),
    source_track_id: Optional[str] = Form(None),
):
    pid = playlist_id.strip()
    raw = (skip_download or "").strip().lower()
    skip = raw in ("1", "true", "yes", "on")
    u = (url or "").strip() or None
    alb = (album or "").strip() or None
    dl_quality = (quality or "192").strip() or "192"
    uid = _owner_id(request, required=True)
    _owned_playlist_or_404(request, pid)
    wants_json = "application/json" in (request.headers.get("accept") or "").lower()
    try:
        track = service.add_track_to_playlist(
            pid,
            title.strip(),
            artist.strip(),
            url=u,
            album=alb,
            enqueue_download=not skip,
            download_quality=dl_quality,
            owner_id=uid,
            source_playlist_id=(source_playlist_id or "").strip() or None,
            source_track_id=(source_track_id or "").strip() or None,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Playlist not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if wants_json:
        return JSONResponse(
            {
                "ok": True,
                "playlist_id": pid,
                "track": _track_payload_row(track),
            }
        )
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/tracks/{track_id}/download")
async def start_download(
    request: Request,
    playlist_id: str,
    track_id: str,
    redownload: Optional[str] = Form(None),
    quality: Optional[str] = Form(None),
):
    _owned_playlist_or_404(request, playlist_id)
    pid = playlist_id.strip()
    tid = track_id.strip()
    force = (redownload or "").strip().lower() in ("1", "true", "yes", "on")
    dl_quality = (quality or "192").strip() or "192"
    if not service.start_track_download(pid, tid, force_redownload=force, quality=dl_quality):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/tracks/{track_id}/delete")
async def delete_track(request: Request, playlist_id: str, track_id: str):
    _owned_playlist_or_404(request, playlist_id)
    pid = playlist_id.strip()
    tid = track_id.strip()
    if not service.delete_track(pid, tid):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    _unlink_track_cover_caches(pid, tid)
    if request.headers.get("x-spa-request") == "1":
        return Response(status_code=204)
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/delete")
async def delete_playlist(request: Request, playlist_id: str):
    _owned_playlist_or_404(request, playlist_id)
    pid = playlist_id.strip()
    if service.is_liked_songs_playlist(pid):
        raise HTTPException(status_code=403, detail="The Liked Songs playlist cannot be deleted.")
    if not service.delete_playlist(pid):
        raise HTTPException(status_code=404, detail="Playlist not found")
    return RedirectResponse("/", status_code=303)


@app.post("/playlists/{playlist_id}/edit")
async def edit_playlist(
    request: Request,
    playlist_id: str,
    name: Optional[str] = Form(None),
    bio: Optional[str] = Form(None),
):
    _owned_playlist_or_404(request, playlist_id)
    pid = playlist_id.strip()
    pl = service.get_playlist(pid)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if service.is_liked_songs_playlist(pid):
        raise HTTPException(status_code=403, detail="The Liked Songs playlist cannot be edited.")

    if name is None and bio is None:
        raise HTTPException(status_code=400, detail="Provide name and/or bio.")

    name_kw: Optional[str] = None
    if name is not None:
        n = name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="Playlist name cannot be empty.")
        name_kw = n

    bio_kw: Optional[str] = None
    if bio is not None:
        bio_kw = bio

    if not service.update_playlist_meta(pid, name=name_kw, bio=bio_kw):
        raise HTTPException(status_code=404, detail="Playlist not found")

    pl2 = service.get_playlist(pl.id)
    display_name = pl2.name if pl2 else pl.name
    display_bio = (pl2.bio or "") if pl2 else ""
    return JSONResponse(
        {
            "ok": True,
            "id": pl2.id if pl2 else pl.id,
            "name": display_name,
            "bio": display_bio,
        }
    )


@app.get("/playlists/{playlist_id}/tracks/{track_id}/cover")
async def track_cover(playlist_id: str, track_id: str, request: Request, q: str = "high"):
    _owned_playlist_or_404(request, playlist_id)
    pid = playlist_id.strip()
    tid = track_id.strip()
    tier = YoutubeThumbQuality.parse(q)
    max_side = YoutubeThumbQuality.max_side(tier)
    jpeg_q = YoutubeThumbQuality.jpeg_quality(tier)
    cpath = cover_tile_cache_path(pid, tid, max_side=max_side)

    pl = service.get_playlist(pid)
    track = pl.get_track(tid) if pl else None
    yt_id = ""
    if track:
        yt_id = str(track.resolved_youtube_video_id() or "").strip()

    if tier == "low" and yt_id:
        fetched = await streaming.fetch_thumbnail_bytes(yt_id, "low")
        if fetched:
            raw, mime = fetched
            return Response(
                content=raw,
                media_type=mime,
                headers={"Cache-Control": "public, max-age=604800, immutable"},
            )

    if cpath.is_file():
        return FileResponse(
            str(cpath),
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=604800, immutable"},
        )

    path = await asyncio.to_thread(service.get_track_audio_path, pid, tid)
    if path is None:
        raise HTTPException(status_code=404, detail="Track or file not found")

    blob = await asyncio.to_thread(extract_cover, path)
    raw: Optional[bytes] = blob[0] if blob else None
    orig_mime = blob[1] if blob else "image/jpeg"

    if raw is None and not yt_id and track:
        yt_id = await asyncio.to_thread(
            _youtube_video_id_from_track_metadata,
            track.artist,
            track.title,
        ) or ""
        yt_id = str(yt_id).strip()
    if raw is None and yt_id:
        fetched = await streaming.fetch_thumbnail_bytes(yt_id, tier)
        if fetched:
            raw, orig_mime = fetched

    if not raw:
        raise HTTPException(status_code=404, detail="No embedded cover")

    processed = await asyncio.to_thread(
        square_thumb_jpeg,
        raw,
        max_side=max_side,
        quality=jpeg_q,
    )
    headers = {"Cache-Control": "public, max-age=604800, immutable"}
    if processed:
        try:
            cpath.parent.mkdir(parents=True, exist_ok=True)
            cpath.write_bytes(processed)
        except OSError:
            pass
        return Response(content=processed, media_type="image/jpeg", headers=headers)

    return Response(
        content=raw,
        media_type=orig_mime if orig_mime.startswith("image/") else "image/jpeg",
        headers={"Cache-Control": "public, max-age=604800, immutable"},
    )


class LyricsSaveBody(BaseModel):
    lyrics: str = Field(default="")


class LrcSaveBody(BaseModel):
    lines: list = Field(default_factory=list)


@app.get("/playlists/{playlist_id}/tracks/{track_id}/lyrics")
def track_lyrics(playlist_id: str, track_id: str, request: Request):
    _owned_playlist_or_404(request, playlist_id)
    if not service.get_playlist(playlist_id.strip()).get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    return JSONResponse(lyrics_service.get_lyrics_payload(playlist_id, track_id))


@app.post("/playlists/{playlist_id}/tracks/{track_id}/lyrics")
async def track_lyrics_save(request: Request, playlist_id: str, track_id: str, body: LyricsSaveBody):
    _owned_playlist_or_404(request, playlist_id)
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if not lyrics_service.save_track_lyrics_file(playlist_id, track_id, body.lyrics):
        raise HTTPException(
            status_code=400,
            detail="Lyrics are saved next to the audio file. Download or fix this track first.",
        )
    return JSONResponse({"ok": True})


@app.post("/playlists/{playlist_id}/tracks/{track_id}/lyrics/lrc")
async def track_lrc_save(request: Request, playlist_id: str, track_id: str, body: LrcSaveBody):
    """Save LRC lyrics with timestamps."""
    _owned_playlist_or_404(request, playlist_id)
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if not lyrics_service.save_track_lrc_file(playlist_id, track_id, body.lines):
        raise HTTPException(
            status_code=400,
            detail="Lyrics are saved next to the audio file. Download or fix this track first.",
        )
    return JSONResponse({"ok": True})


@app.post("/api/downloads/retry-all-errors")
async def api_retry_all_errors(request: Request):
    """Re-queue all tracks that are in error state (any playlist)."""
    uid = _owner_id(request, required=True)
    n = service.retry_all_error_tracks(uid)
    return JSONResponse({"ok": True, "queued": n})


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


@app.get("/playlists/{playlist_id}/tracks/{track_id}/file")
async def export_track_file(playlist_id: str, track_id: str, request: Request):
    """Browser download of one track's audio file."""
    _owned_playlist_or_404(request, playlist_id)
    result = await asyncio.to_thread(export_service.get_track_export, playlist_id, track_id)
    if not result:
        raise HTTPException(
            status_code=404,
            detail="Track audio not found. Download the track in the library first.",
        )
    path, filename = result
    return FileResponse(
        path,
        media_type=media_server.content_type(path),
        filename=filename,
        content_disposition_type="attachment",
    )


@app.get("/playlists/{playlist_id}/export.zip")
async def export_playlist_zip(playlist_id: str, request: Request):
    """Browser download of a ZIP of all downloaded tracks in the playlist."""
    _owned_playlist_or_404(request, playlist_id)
    pid = playlist_id.strip()

    built = await asyncio.to_thread(export_service.build_playlist_export_zip, pid)
    if not built:
        raise HTTPException(
            status_code=404,
            detail="No downloaded tracks to export. Download songs in this playlist first.",
        )
    tmp_path, zip_name, _count = built
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=zip_name,
        content_disposition_type="attachment",
        background=BackgroundTask(_unlink_quiet, tmp_path),
    )


class QualityDownloadBody(BaseModel):
    quality: str = Field(..., min_length=1)


@app.post("/api/playlists/{playlist_id}/downloads/quality")
async def api_playlist_quality_downloads(playlist_id: str, body: QualityDownloadBody, request: Request):
    """Queue downloads for every track in a playlist missing the given quality variant."""
    _owned_playlist_or_404(request, playlist_id)
    result = service.queue_playlist_quality_downloads(playlist_id, body.quality)
    if result is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return JSONResponse({"ok": True, **result})


@app.post("/api/downloads/quality-all")
async def api_quality_downloads_all(body: QualityDownloadBody, request: Request):
    """Queue missing quality variants for every track in every playlist."""
    uid = _owner_id(request, required=True)
    result = service.queue_all_quality_downloads(body.quality, uid)
    return JSONResponse({"ok": True, **result})


@app.post("/api/downloads/reload")
async def api_reload_library(request: Request):
    """Re-download every track at both tiers and delete every other format."""
    uid = _owner_id(request, required=True)
    # Enqueues per-track work with file I/O; keep it off the event loop.
    result = await run_in_threadpool(service.reload_library_all_qualities, uid)
    return JSONResponse({"ok": True, **result})


@app.get("/api/progress")
async def api_progress(request: Request):
    """Live per-track download progress plus how many downloads are left in the queue."""
    return JSONResponse(service.progress_api_payload(_owner_id(request)))


_manifest_path = _webapp_dir / "manifest.json"


@app.get("/manifest.json")
async def serve_web_app_manifest():
    """PWA manifest stored under ``webapp/manifest.json`` (linked from templates as ``manifest.json``)."""
    if not _manifest_path.is_file():
        raise HTTPException(status_code=404, detail="manifest.json missing")
    return FileResponse(
        _manifest_path,
        media_type="application/manifest+json; charset=utf-8",
    )


class JsMimeStaticFiles(StaticFiles):
    """Serve .js / .mjs / .css with correct MIME types on Windows.

    ``mimetypes`` often maps ``.js`` to ``text/plain``, which makes browsers reject
    scripts and ES module graphs. ``FileResponse`` uses ``guess_type`` unless
    ``media_type`` is set explicitly.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        request_headers = Headers(scope=scope)
        suffix = Path(full_path).suffix.lower()
        media_type = None
        if suffix in (".js", ".mjs"):
            media_type = "application/javascript; charset=utf-8"
        elif suffix == ".css":
            media_type = "text/css; charset=utf-8"
        response = FileResponse(
            full_path,
            status_code=status_code,
            stat_result=stat_result,
            media_type=media_type,
        )
        if self.is_not_modified(response.headers, request_headers):
            return NotModifiedResponse(response.headers)
        return response


_static_dir = _webapp_dir / "static"
_static_dir.mkdir(parents=True, exist_ok=True)
_pwa_sw_path = _static_dir / "pwa" / "sw.js"


@app.get("/static/pwa/sw.js", include_in_schema=False)
async def pwa_service_worker():
    """Serve generated Workbox SW with full-site scope (SW lives under ``/static/pwa/``)."""
    if not _pwa_sw_path.is_file():
        raise HTTPException(status_code=404, detail="Run: npm run build:pwa")
    return FileResponse(
        _pwa_sw_path,
        media_type="application/javascript; charset=utf-8",
        headers={"Service-Worker-Allowed": "/"},
    )


app.mount("/static", JsMimeStaticFiles(directory=str(_static_dir)), name="static")

_media_root = root / "downloads"
_media_root.mkdir(parents=True, exist_ok=True)

media_server = MediaServer(_media_root, root)


@app.get("/api/media/prepare")
async def api_media_prepare(path: str, request: Request):
    """Metadata (ext/size/duration) for sliced local playback via MSE."""
    _auth_user(request, required=True)
    return JSONResponse(await asyncio.to_thread(media_server.prepare, path))


@app.get("/media/{media_path:path}")
async def serve_media(media_path: str, request: Request):
    _auth_user(request, required=True)
    sliced = request.query_params.get("sliced") == "1"
    return media_server.serve(media_path, request, sliced=sliced)


@app.post("/api/playlists/{playlist_id}/share")
async def api_create_share_link(request: Request, playlist_id: str):
    """Create (or return) the public read-only share token for a playlist."""
    pl = _owned_playlist_or_404(request, playlist_id)
    token = pl.share_token
    if not token:
        token = secrets.token_urlsafe(18)
        service.set_playlist_share_token(pl.id, token)
    return JSONResponse({"ok": True, "token": token, "url": "/share/" + token})


@app.delete("/api/playlists/{playlist_id}/share")
async def api_revoke_share_link(request: Request, playlist_id: str):
    pl = _owned_playlist_or_404(request, playlist_id)
    service.set_playlist_share_token(pl.id, None)
    return JSONResponse({"ok": True})


def _shared_playlist_or_404(token: str) -> Playlist:
    pl = service.get_playlist_by_share_token(token)
    if not pl:
        raise HTTPException(status_code=404, detail="Share link not found")
    return pl


def _share_track_rows(pl: Playlist, token: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for t in pl.tracks:
        variants = t.media_variants or {}
        rel = variants.get("192") or variants.get("64") or t.media_relpath
        if not rel:
            continue
        rows.append(
            {
                "title": t.title,
                "artist": t.artist or "",
                "album": t.album or "",
                "src": "/share/" + token + "/media/" + quote(rel, safe="/"),
            }
        )
    return rows


@app.get("/share/{token}")
async def share_page(request: Request, token: str):
    pl = _shared_playlist_or_404(token)
    tpl = templates.env.get_template("share.html")
    html = tpl.render(request=request, playlist=pl, tracks=_share_track_rows(pl, token))
    return HTMLResponse(html)


@app.get("/share/{token}/media/{media_path:path}")
async def share_media(request: Request, token: str, media_path: str):
    """Serve only files that belong to the shared playlist."""
    pl = _shared_playlist_or_404(token)
    allowed = {t.media_relpath for t in pl.tracks if t.media_relpath}
    for t in pl.tracks:
        allowed.update((t.media_variants or {}).values())
    if media_path not in allowed:
        raise HTTPException(status_code=404, detail="Media file not found")
    return media_server.serve(media_path, request)
