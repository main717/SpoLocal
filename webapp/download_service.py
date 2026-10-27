"""Core download service for SpoLocal.

Resolves tracks from Spotify links or URLs.
Coordinates yt_dlp downloads, updates state, and triggers enrichment."""
from __future__ import annotations

import json
import logging
import os
import queue
import re
import sys
import tempfile
import threading
import time
import zipfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import quote
from uuid import uuid4

import yt_dlp

from audio_quality import DEFAULT_KBPS, kbps_from_relpath, parse_quality_kbps, variant_key
from lyrics_files import delete_lyrics_sidecars, materialize_lyrics_file_if_needed
from lyrics_fetch import fetch_lrclib_sidecar_sync, on_demand_lyrics_fetch_enabled
from lyrics_service import LyricsService
from models import DownloadStatus, Playlist, Track, set_track_status_change_listener
from tag_metadata import extract_album, extract_lyrics, read_audio_file_stats, write_track_tags

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.append(str(Path(__file__).resolve().parent.parent))
from spotifydown_api import detect_spotify_url_type
from spotify_scraper import (
    SpotifyEmbedDownloader,
    YtDlpAudioDownloader,
    _sanitize_folder_name,
    search_youtube_tracks,
)

# Hydration cache settings
_HYDRATION_CACHE_TTL_SECONDS = 30  # Cache hydration results for 30 seconds
_HYDRATION_CACHE_MAX_ENTRIES = 100

# Audio file extensions SpoLocal can produce or still find on disk.
# ``.webm`` is the Data Saver container (MSE-decodable WebM/Opus).
AUDIO_EXTS = (".opus", ".mp3", ".m4a", ".flac", ".webm")


def _now_ts() -> float:
    return time.time()

_SPOTIFY_URI_TYPE_ID = re.compile(r"^spotify:(playlist|album|track):([A-Za-z0-9]+)\s*$", re.I)
_SPOTIFY_WEB_TYPE_ID = re.compile(r"open\.spotify\.com/(playlist|album|track)/([A-Za-z0-9]+)", re.I)


def spotify_catalog_key_from_import_url(raw: str) -> Optional[str]:
    """Stable id for playlist/album/track imports, e.g. playlist:37i9dQZ..., or None."""
    s = (raw or "").strip()
    if not s:
        return None
    m = _SPOTIFY_URI_TYPE_ID.match(s)
    if m:
        return f"{m.group(1).lower()}:{m.group(2)}"
    base = s.split("?", 1)[0].strip()
    m = _SPOTIFY_WEB_TYPE_ID.search(base)
    if m:
        return f"{m.group(1).lower()}:{m.group(2)}"
    return None


def spotify_track_id_from_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    u = url.strip()
    if u.lower().startswith("spotify:track:"):
        return u.split(":", 2)[2].split("?")[0]
    m = re.search(r"open\.spotify\.com/track/([A-Za-z0-9]+)", u, re.I)
    if m:
        return m.group(1)
    return None


def youtube_video_id_from_url(url: Optional[str]) -> Optional[str]:
    """Parse YouTube video id from watch, youtu.be, or embed URLs."""
    if not url:
        return None
    u = url.strip()
    m = re.search(
        r"(?:youtube\.com/watch\?[^#]*v=|youtu\.be/|youtube\.com/embed/)([A-Za-z0-9_-]{11})",
        u,
        re.I,
    )
    if m:
        return m.group(1)
    m = re.search(r"[?&]v=([A-Za-z0-9_-]{11})\b", u, re.I)
    if m:
        return m.group(1)
    return None


def _parse_dt(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        s = value.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    return datetime.utcnow()


def _track_from_dict(raw: dict) -> Track:
    data = dict(raw)
    st = data.get("status", DownloadStatus.queued)
    if isinstance(st, str):
        data["status"] = DownloadStatus(st)
    data["added_at"] = _parse_dt(data.get("added_at", datetime.utcnow()))
    data.setdefault("media_relpath", None)
    data.setdefault("media_variants", {})
    if data.get("media_relpath") and not data.get("media_variants"):
        rel = data["media_relpath"]
        inferred = kbps_from_relpath(rel)
        key = variant_key(inferred) if inferred else "192"
        data["media_variants"] = {key: rel}
    if not isinstance(data.get("media_variants"), dict):
        data["media_variants"] = {}
    data.setdefault("cover_url", None)
    data.setdefault("youtube_video_id", None)
    data.setdefault("album", None)
    data.setdefault("loudness_gain_db", None)
    data.setdefault("liked_source_playlist_id", None)
    data.setdefault("liked_source_track_id", None)
    data.setdefault("media_source_playlist_id", None)
    data.setdefault("media_source_track_id", None)
    return Track(**data)


def _playlist_from_dict(pdata: dict) -> Playlist:
    data = dict(pdata)
    data.setdefault("bio", None)
    tracks = [_track_from_dict(t) for t in data.get("tracks", [])]
    return Playlist(
        id=data["id"],
        name=data["name"],
        tracks=tracks,
        created_at=_parse_dt(data.get("created_at", datetime.utcnow())),
        spotify_catalog_key=data.get("spotify_catalog_key"),
        spotify_snapshot_id=data.get("spotify_snapshot_id"),
        bio=data.get("bio"),
        owner_id=data.get("owner_id"),
    )


def _download_worker_count() -> int:
    try:
        n = int(
            (
                os.environ.get("SPOLOCAL_DOWNLOAD_WORKERS")
                or os.environ.get("SPRITY_DOWNLOAD_WORKERS")
                or "2"
            ).strip()
        )
    except ValueError:
        n = 2
    return max(1, min(n, 8))


class _HydrationCacheEntry:
    """Cached hydration data for a playlist."""
    __slots__ = ("playlist_id", "by_stem", "expires_at", "albums")

    def __init__(self, playlist_id: str, by_stem: Dict[str, Path], expires_at: float):
        self.playlist_id = playlist_id
        self.by_stem = by_stem
        self.expires_at = expires_at
        self.albums: Dict[str, Optional[str]] = {}  # track_id -> album name (lazy-loaded)


class DownloadService:
    """Download work is spread across N background threads (SPOLOCAL_DOWNLOAD_WORKERS, default 2)."""

    LIKED_SONGS_PLAYLIST_ID = "spolocal_liked_songs"
    LIKED_SONGS_PLAYLIST_NAME = "Liked Songs"

    def __init__(self, root: Path) -> None:
        self.root = root
        self.playlists: Dict[str, Playlist] = {}
        self.job_queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self._lock = threading.Lock()
        # Embed downloader is plain HTTP — safe to use from any thread immediately.
        self._embed = SpotifyEmbedDownloader(root)
        self.lyrics = LyricsService(self)

        self._startup_enqueue_done = False
        # track_id -> {title, artist, percent, speed, eta, phase}
        self.progress: Dict[str, dict] = {}
        # (track_id, quality) jobs already queued or running — avoid duplicate bulk enqueues
        self._pending_job_keys: set[Tuple[str, str]] = set()
        self._error_rows_cache: Optional[List[dict]] = None
        self._save_timer: Optional[threading.Timer] = None
        self._save_timer_lock = threading.Lock()
        # (playlist_id, track_id) rows currently being rebuilt at both tiers.
        # Once both variants exist, every other format for that track is deleted.
        self._rebuild_pending: set[Tuple[str, str]] = set()
        # (playlist_id, track_id) loudness analyses in flight - avoid duplicate concurrent runs.
        self._loudness_analyzing: set[Tuple[str, str]] = set()

        # Hydration cache: playlist_id -> _HydrationCacheEntry
        self._hydration_cache: Dict[str, _HydrationCacheEntry] = {}
        self._hydration_cache_lock = threading.Lock()
        # One lock per playlist so parallel /cover requests don't each glob the same folder.
        self._hydrate_pl_guard = threading.Lock()
        self._hydrate_pl_locks: Dict[str, threading.Lock] = {}

        self._load_playlists()
        self._sync_from_download_folders()
        self._reset_interrupted_downloads()
        self._reconcile_media_paths()
        self._reconcile_track_statuses()

        set_track_status_change_listener(self._invalidate_error_rows_cache)

        n = _download_worker_count()
        for i in range(n):
            threading.Thread(
                target=self._worker_main, name=f"spolocal-dl-{i}", daemon=True
            ).start()

    def _data_file(self) -> Path:
        override = (os.environ.get("SPLOCAL_PLAYLISTS_PATH") or "").strip()
        if override:
            return Path(override)
        return self.root / "webapp_playlists.json"

    def _invalidate_error_rows_cache(self) -> None:
        self._error_rows_cache = None

    def _invalidate_hydration_cache(self, playlist_id: Optional[str] = None) -> None:
        """Invalidate hydration cache for a specific playlist or all playlists."""
        with self._hydration_cache_lock:
            if playlist_id:
                self._hydration_cache.pop(playlist_id, None)
            else:
                self._hydration_cache.clear()

    def _cleanup_hydration_cache(self, now: float) -> None:
        """Remove expired entries from the hydration cache."""
        expired = [k for k, v in self._hydration_cache.items() if v.expires_at <= now]
        for k in expired:
            self._hydration_cache.pop(k, None)

        if len(self._hydration_cache) <= _HYDRATION_CACHE_MAX_ENTRIES:
            return

        # LRU eviction: remove oldest entries by expiration time
        items = sorted(self._hydration_cache.items(), key=lambda kv: kv[1].expires_at)
        for k, _ in items[:len(self._hydration_cache) - _HYDRATION_CACHE_MAX_ENTRIES]:
            self._hydration_cache.pop(k, None)

    def _get_cached_hydration(self, playlist_id: str, now: float) -> Optional[_HydrationCacheEntry]:
        """Get cached hydration data if still valid."""
        with self._hydration_cache_lock:
            self._cleanup_hydration_cache(now)
            entry = self._hydration_cache.get(playlist_id)
            if entry and entry.expires_at > now:
                return entry
            return None

    def _set_cached_hydration(self, playlist_id: str, by_stem: Dict[str, Path]) -> _HydrationCacheEntry:
        """Store hydration data in cache."""
        now = _now_ts()
        entry = _HydrationCacheEntry(playlist_id, by_stem, now + _HYDRATION_CACHE_TTL_SECONDS)
        with self._hydration_cache_lock:
            self._hydration_cache[playlist_id] = entry
            self._cleanup_hydration_cache(now)
        return entry

    def _flush_playlists_to_disk(self) -> None:
        with self._lock:
            serializable = {}
            for pid, pl in self.playlists.items():
                serializable[pid] = {
                    "id": pl.id,
                    "name": pl.name,
                    "bio": pl.bio,
                    "owner_id": pl.owner_id,
                    "created_at": pl.created_at.isoformat(),
                    "spotify_catalog_key": pl.spotify_catalog_key,
                    "spotify_snapshot_id": pl.spotify_snapshot_id,
                    "tracks": [
                        {
                            "id": t.id,
                            "title": t.title,
                            "artist": t.artist,
                            "url": t.url,
                            "status": t.status.value,
                            "error": t.error,
                            "added_at": t.added_at.isoformat(),
                            "media_relpath": t.media_relpath,
                            "media_variants": dict(t.media_variants or {}),
                            "cover_url": t.cover_url,
                            "youtube_video_id": t.youtube_video_id,
                            "album": t.album,
                            "loudness_gain_db": t.loudness_gain_db,
                            "liked_source_playlist_id": t.liked_source_playlist_id,
                            "liked_source_track_id": t.liked_source_track_id,
                            "media_source_playlist_id": t.media_source_playlist_id,
                            "media_source_track_id": t.media_source_track_id,
                        }
                        for t in pl.tracks
                    ],
                }
            path = self._data_file()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(serializable, indent=2), encoding="utf-8")

    def _save_playlists(self, *, immediate: bool = True) -> None:
        if immediate:
            with self._save_timer_lock:
                if self._save_timer is not None:
                    self._save_timer.cancel()
                    self._save_timer = None
            self._flush_playlists_to_disk()
            return

        def _fire() -> None:
            with self._save_timer_lock:
                self._save_timer = None
            self._flush_playlists_to_disk()

        with self._save_timer_lock:
            if self._save_timer is not None:
                self._save_timer.cancel()
            self._save_timer = threading.Timer(0.45, _fire)
            self._save_timer.daemon = True
            self._save_timer.start()

    def _load_playlists(self) -> None:
        data_file = self._data_file()
        if not data_file.exists():
            return
        raw = json.loads(data_file.read_text(encoding="utf-8"))
        for _pid, pdata in raw.items():
            pl = _playlist_from_dict(pdata)
            self.playlists[pl.id] = pl

    def is_liked_songs_playlist(self, playlist_id: Optional[str]) -> bool:
        if not playlist_id:
            return False
        key = str(playlist_id).strip()
        return key == self.LIKED_SONGS_PLAYLIST_ID or key.startswith(self.LIKED_SONGS_PLAYLIST_ID + "_")

    def liked_songs_id_for(self, owner_id: Optional[str]) -> Optional[str]:
        """Per-user Liked Songs playlist id, or None for guests."""
        if not owner_id:
            return None
        return f"{self.LIKED_SONGS_PLAYLIST_ID}_{owner_id}"

    def _ensure_liked_songs_playlist(self, owner_id: Optional[str]) -> Optional[Playlist]:
        pid = self.liked_songs_id_for(owner_id)
        if not pid:
            return None
        if pid in self.playlists:
            pl = self.playlists[pid]
            if pl.name != self.LIKED_SONGS_PLAYLIST_NAME:
                pl.name = self.LIKED_SONGS_PLAYLIST_NAME
                self._save_playlists()
            return pl
        pl = Playlist(
            id=pid,
            name=self.LIKED_SONGS_PLAYLIST_NAME,
            tracks=[],
            created_at=datetime.utcnow(),
            spotify_catalog_key=None,
            spotify_snapshot_id=None,
            bio=None,
            owner_id=owner_id,
        )
        self.playlists[pid] = pl
        self._save_playlists()
        return pl

    def claim_ownerless_playlists(self, owner_id: Optional[str]) -> int:
        """Give all unclaimed playlists to the first user who logs in (option A migration).
        The legacy global Liked Songs list becomes that user's Liked Songs."""
        if not owner_id:
            return 0
        changed = 0
        legacy = self.playlists.get(self.LIKED_SONGS_PLAYLIST_ID)
        if legacy is not None and not legacy.owner_id:
            new_pid = self.liked_songs_id_for(owner_id)
            self.playlists.pop(self.LIKED_SONGS_PLAYLIST_ID, None)
            legacy.id = new_pid
            self.playlists[new_pid] = legacy
            legacy.owner_id = owner_id
            changed += 1
        for pl in self.playlists.values():
            if not pl.owner_id:
                pl.owner_id = owner_id
                changed += 1
        if changed:
            self._save_playlists()
        return changed

    def list_liked_entry_keys(self, owner_id: Optional[str] = None) -> List[str]:
        """Stable keys ``source_playlist_id|source_track_id`` for tracks saved to Liked Songs."""
        liked_pl = self._ensure_liked_songs_playlist(owner_id)
        if not liked_pl:
            return []
        keys: List[str] = []
        for t in liked_pl.tracks:
            sp = (t.liked_source_playlist_id or "").strip()
            st = (t.liked_source_track_id or "").strip()
            if sp and st:
                keys.append(f"{sp}|{st}")
        return keys

    def set_track_liked(self, source_playlist_id: str, source_track_id: str, liked: bool, owner_id: Optional[str] = None) -> bool:
        """Add/remove a playable track in the Liked Songs playlist (by source list + track id)."""
        spid = source_playlist_id.strip()
        stid = source_track_id.strip()
        if not spid or not stid:
            return False
        liked_pl = self._ensure_liked_songs_playlist(owner_id)
        if not liked_pl:
            return False

        if self.is_liked_songs_playlist(spid):
            if liked:
                return True
            track = liked_pl.get_track(stid)
            if not track:
                return False
            return self.delete_track(spid, stid, unlink_media=False)

        src_pl = self.get_playlist(spid)
        if not src_pl:
            return False
        src = src_pl.get_track(stid)
        if not src:
            return False
        if src.status != DownloadStatus.done or not self._track_has_resolved_file(src):
            return False

        if liked:
            for t in liked_pl.tracks:
                if (t.liked_source_playlist_id or "").strip() == spid and (t.liked_source_track_id or "").strip() == stid:
                    return True
            new_t = replace(
                src,
                id=str(uuid4()),
                liked_source_playlist_id=spid,
                liked_source_track_id=stid,
                added_at=datetime.utcnow(),
            )
            liked_pl.add_track(new_t)
            self._invalidate_hydration_cache(liked_pl.id)
            self._save_playlists()
            return True

        for t in list(liked_pl.tracks):
            if (t.liked_source_playlist_id or "").strip() == spid and (t.liked_source_track_id or "").strip() == stid:
                return self.delete_track(liked_pl.id, t.id, unlink_media=False)
        return True

    def add_track_to_liked_songs(
        self,
        title: str,
        artist: str,
        url: Optional[str] = None,
        album: Optional[str] = None,
        *,
        owner_id: Optional[str] = None,
        video_id: Optional[str] = None,
        download_quality: str = str(DEFAULT_KBPS),
        source_playlist_id: Optional[str] = None,
        source_track_id: Optional[str] = None,
    ) -> Optional[Track]:
        """Save a song straight to Liked Songs, without a playlist in between.

        A matching library copy is linked through ``set_track_liked`` so the
        heart stays in sync with its source row. Otherwise the song is
        downloaded into the Liked Songs folder and lives there on its own.
        """
        pid = self.liked_songs_id_for(owner_id)
        liked_pl = self._ensure_liked_songs_playlist(owner_id)
        if not pid or liked_pl is None:
            return None

        title_s = (title or "").strip()
        if not title_s:
            return None
        artist_s = (artist or "").strip()
        u = (url or "").strip() or None
        yid = youtube_video_id_from_url(u) or (video_id or "").strip()

        sp = (source_playlist_id or "").strip()
        st = (source_track_id or "").strip()
        if not (sp and st) and owner_id:
            found = self.find_canonical_downloaded_source(
                owner_id, yid, title_s, artist_s, exclude_playlist_id=pid
            )
            if found:
                sp, st = found
        if sp and st and self.set_track_liked(sp, st, True, owner_id):
            for t in liked_pl.tracks:
                if (t.liked_source_playlist_id or "").strip() == sp and (
                    t.liked_source_track_id or ""
                ).strip() == st:
                    return t

        for t in liked_pl.tracks:
            if yid and self._youtube_video_id_for_track(t) == yid:
                return t
            if (
                (t.title or "").strip().lower() == title_s.lower()
                and (t.artist or "").strip().lower() == artist_s.lower()
            ):
                return t

        track = Track.create(title=title_s, artist=artist_s, url=u)
        album_s = (album or "").strip()
        if album_s:
            track.album = album_s[:500]
        if yid:
            track.youtube_video_id = yid
        liked_pl.add_track(track)
        self._enqueue_download(pid, track.id, quality=download_quality)
        self._invalidate_hydration_cache(pid)
        self._save_playlists()
        return track

    def _reset_interrupted_downloads(self) -> None:
        """
        Any track left in 'downloading' state means the server was killed mid-download.
        Reset them to 'queued' so they are re-enqueued when the worker starts.
        The worker calls _enqueue_download for these after _worker_main initialises.
        """
        changed = False
        for pl in self.playlists.values():
            for track in list(pl.tracks):
                if track.status == DownloadStatus.downloading:
                    pl.update_track_status(track.id, DownloadStatus.queued, None)
                    changed = True
        if changed:
            self._save_playlists()

    def _sync_from_download_folders(self) -> None:
        """Expose existing download folders as playlists in the UI."""
        downloads = self.root / "downloads"
        if not downloads.is_dir():
            return
        skip = {"youtube"}
        existing_names = {pl.name for pl in self.playlists.values()}
        changed = False
        for path in sorted(downloads.iterdir()):
            if not path.is_dir() or path.name.lower() in skip:
                continue
            if path.name in existing_names:
                continue
            audio_files = sorted(
                p for p in path.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS
            )
            if not audio_files:
                continue
            pl = Playlist.create(path.name)
            for f in audio_files:
                stem = f.stem
                if " - " in stem:
                    artist, title = stem.split(" - ", 1)
                else:
                    artist, title = "Unknown", stem
                tr = Track.create(title=title.strip(), artist=artist.strip())
                tr.status = DownloadStatus.done
                tr.media_relpath = f.relative_to(downloads).as_posix()
                pl.add_track(tr)
            self.playlists[pl.id] = pl
            existing_names.add(pl.name)
            changed = True
        if changed:
            self._save_playlists()

    def _playlist_by_catalog_key(self, key: Optional[str]) -> Optional[Playlist]:
        if not key:
            return None
        for pl in self.playlists.values():
            if pl.spotify_catalog_key == key:
                return pl
        return None

    def _find_track_by_spotify_id(self, pl: Playlist, spotify_track_id: Optional[str]) -> Optional[Track]:
        if not spotify_track_id:
            return None
        for t in pl.tracks:
            if spotify_track_id_from_url(t.url) == spotify_track_id:
                return t
        return None

    def _find_track_by_metadata(self, pl: Playlist, artist: str, title: str) -> Optional[Track]:
        for t in pl.tracks:
            if t.title == title and t.artist == artist:
                return t
        return None

    def _settle_supplementary_status(self, pl: Playlist, track: Track, track_id: str) -> None:
        """A failed supplementary job must not strand a track as queued/downloading."""
        if track.status not in (DownloadStatus.queued, DownloadStatus.downloading):
            return
        if self._track_has_resolved_file(track):
            pl.update_track_status(track_id, DownloadStatus.done)
        else:
            pl.update_track_status(track_id, DownloadStatus.error, "Download did not produce a file.")

    def _best_existing_variant_relpath(self, track: Track) -> Optional[str]:
        """Highest-quality variant whose file is actually on disk."""
        variants = track.media_variants or {}
        keys = sorted(variants.keys(), key=lambda k: int(k) if str(k).isdigit() else 0, reverse=True)
        for key in keys:
            rel = variants.get(key)
            if not rel:
                continue
            try:
                if (self.root / "downloads" / rel).resolve().is_file():
                    return rel
            except OSError:
                continue
        return None

    def _repair_stale_media_relpath(self, track: Track) -> bool:
        """Point a missing primary path at an existing variant.

        Legacy rows kept the deleted source file as ``media_relpath`` after a
        transcode. ``track_play_variants`` then advertises that missing file as
        the 192k variant, so the client requests it and gets a 404.
        """
        rel = (track.media_relpath or "").strip()
        if not rel:
            return False
        try:
            if (self.root / "downloads" / rel).resolve().is_file():
                return False
        except OSError:
            pass
        best = self._best_existing_variant_relpath(track)
        if not best:
            return False
        track.media_relpath = best
        return True

    def _reconcile_media_paths(self) -> None:
        """Repair stale paths once at startup and persist the result."""
        changed = False
        for pl in self.playlists.values():
            for track in pl.tracks:
                if self._prune_missing_variants(track):
                    changed = True
                if self._repair_stale_media_relpath(track):
                    changed = True
                if self._media_source_ids(track)[0] and self._sync_track_media_from_source(track):
                    changed = True
        if changed:
            self._save_playlists()

    def _reconcile_track_statuses(self) -> None:
        """Make status match disk in both directions.

        A playable row is done, whatever it claimed: the in-memory job queue is
        lost on restart and ``_worker_main`` only re-enqueues queued rows
        *without* a file, so an interrupted row would otherwise report
        ``queued`` forever. Rows left at ``error`` after a later job produced
        the file are settled the same way.

        A done row whose recorded files are all gone is flipped to ``error`` so
        it stops advertising audio that 404s. Rows with no recorded path at all
        are left alone; hydration may still resolve those.
        """
        changed = False
        for pl in self.playlists.values():
            for track in pl.tracks:
                if track.status == DownloadStatus.done:
                    if self._track_has_recorded_media(track) and not self._track_has_resolved_file(track):
                        pl.update_track_status(
                            track.id, DownloadStatus.error, "Audio file is missing on disk."
                        )
                        changed = True
                    continue
                if not self._track_has_resolved_file(track):
                    continue
                pl.update_track_status(track.id, DownloadStatus.done)
                changed = True
        if changed:
            self._save_playlists()

    @staticmethod
    def _track_has_recorded_media(track: Track) -> bool:
        """True when the row points at a file (primary path or any variant)."""
        if (track.media_relpath or "").strip():
            return True
        return any((rel or "").strip() for rel in (track.media_variants or {}).values())

    def _prune_missing_variants(self, track: Track) -> bool:
        """Drop variant entries whose file is gone so the client never requests a 404."""
        variants = track.media_variants or {}
        changed = False
        for key, rel in list(variants.items()):
            if rel:
                try:
                    exists = (self.root / "downloads" / rel).resolve().is_file()
                except OSError:
                    exists = False
                if exists:
                    continue
            variants.pop(key, None)
            changed = True
        return changed

    def _clear_stale_variant(self, track: Track, quality: str) -> None:
        """Drop a variant entry when its file is missing on disk."""
        qk = variant_key(parse_quality_kbps(quality))
        rel = (track.media_variants or {}).get(qk)
        if not rel:
            return
        try:
            exists = (self.root / "downloads" / rel).resolve().is_file()
        except OSError:
            exists = False
        if not exists and track.media_variants:
            track.media_variants.pop(qk, None)

    def _download_query_for_track(self, track: Track) -> str:
        """Best download target: Spotify/YouTube URL, known video id, or title search."""
        url = (track.url or "").strip()
        if url:
            return url
        vid = (track.youtube_video_id or "").strip()
        if vid:
            return f"https://www.youtube.com/watch?v={vid}"
        return f"{track.title} {track.artist}".strip()

    def _youtube_video_id_for_track(self, track: Track) -> str:
        vid = (track.youtube_video_id or "").strip()
        if vid:
            return vid
        for rel in (track.media_variants or {}).values():
            if not rel:
                continue
            m = re.search(r"\[([^\]]+)\]", Path(rel).name)
            if m:
                return m.group(1)
        if track.media_relpath:
            m = re.search(r"\[([^\]]+)\]", Path(track.media_relpath).name)
            if m:
                return m.group(1)
        return youtube_video_id_from_url(track.url) or ""

    def _relpath_matches_quality(self, relpath: str, qk: str) -> bool:
        """True when ``relpath`` exists on disk and matches quality key ``qk`` (e.g. ``64``, ``192``)."""
        try:
            path = (self.root / "downloads" / relpath).resolve()
            if not path.is_file():
                return False
        except OSError:
            return False
        inferred = kbps_from_relpath(relpath)
        want = variant_key(parse_quality_kbps(qk))
        if inferred is not None:
            return variant_key(inferred) == want
        stats = read_audio_file_stats(path)
        br = stats.get("bitrate_kbps")
        if br:
            return variant_key(int(br)) == want
        return False

    def _track_can_queue_quality_download(self, track: Track) -> bool:
        if (track.url or "").strip() or (track.youtube_video_id or "").strip():
            return True
        if self._youtube_video_id_for_track(track):
            return True
        return bool((track.title or "").strip() and (track.artist or "").strip())

    def _track_has_resolved_file(self, track: Track, quality: Optional[str] = None) -> bool:
        variants = track.media_variants or {}
        if quality:
            qk = variant_key(parse_quality_kbps(quality))
            rel = variants.get(qk)
            if rel and self._relpath_matches_quality(rel, qk):
                return True
            if qk == variant_key(DEFAULT_KBPS) and track.media_relpath:
                return self._relpath_matches_quality(track.media_relpath, qk)
            return False
        for rel in variants.values():
            if not rel:
                continue
            try:
                if (self.root / "downloads" / rel).resolve().is_file():
                    return True
            except OSError:
                continue
        if track.media_relpath:
            try:
                return (self.root / "downloads" / track.media_relpath).resolve().is_file()
            except OSError:
                return False
        return False

    def create_playlist(self, name: str, owner_id: Optional[str] = None) -> Playlist:
        n = (name or "").strip()
        if n == self.LIKED_SONGS_PLAYLIST_NAME:
            raise ValueError("That name is reserved for the built-in Liked Songs playlist.")
        pl = Playlist.create(name)
        pl.owner_id = owner_id or None
        self.playlists[pl.id] = pl
        self._save_playlists()
        return pl

    def get_playlist(self, playlist_id: str) -> Optional[Playlist]:
        if playlist_id is None:
            return None
        key = str(playlist_id).strip()
        if not key:
            return None
        pl = self.playlists.get(key)
        if pl is not None:
            return pl
        key_lower = key.lower()
        for k, pl in self.playlists.items():
            if k.lower() == key_lower:
                return pl
        return None

    def get_playlist_for_user(self, playlist_id: str, owner_id: Optional[str]) -> Optional[Playlist]:
        """Ownership-scoped lookup. Guests (owner_id None) see nothing."""
        if not owner_id:
            return None
        pl = self.get_playlist(playlist_id)
        if pl is None or pl.owner_id != owner_id:
            return None
        return pl

    def _media_source_ids(self, track: Track) -> tuple[str, str]:
        spid = (track.media_source_playlist_id or track.liked_source_playlist_id or "").strip()
        stid = (track.media_source_track_id or track.liked_source_track_id or "").strip()
        return spid, stid

    def _media_source_track(self, track: Track) -> Optional[Track]:
        spid, stid = self._media_source_ids(track)
        if not spid or not stid:
            return None
        src_pl = self.get_playlist(spid)
        if not src_pl:
            return None
        return src_pl.get_track(stid)

    def _canonical_media_track(
        self, playlist_id: str, track_id: str
    ) -> tuple[Optional[Playlist], Optional[Track]]:
        pl = self.get_playlist(playlist_id.strip())
        track = pl.get_track(track_id.strip()) if pl else None
        seen: set[tuple[str, str]] = set()
        while pl and track:
            key = (pl.id, track.id)
            if key in seen:
                return None, None
            seen.add(key)
            spid, stid = self._media_source_ids(track)
            if not spid or not stid:
                return pl, track
            pl = self.get_playlist(spid)
            track = pl.get_track(stid) if pl else None
        return None, None

    def _sync_track_media_from_source(self, track: Track) -> bool:
        """Copy media paths from the source track when this row is an alias."""
        src = self._media_source_track(track)
        if not src:
            return False
        spid, _stid = self._media_source_ids(track)
        sp_pl = self.get_playlist(spid) if spid else None
        if sp_pl:
            self.hydrate_media_paths(sp_pl, persist=False)
        changed = False
        if src.media_relpath and track.media_relpath != src.media_relpath:
            track.media_relpath = src.media_relpath
            changed = True
        # An alias points at the source audio, so its variants must follow the
        # source too. Keeping the first copy forever advertises files that a
        # later re-download replaced (the client then requests a 404).
        if src.media_variants and track.media_variants != src.media_variants:
            track.media_variants = dict(src.media_variants)
            changed = True
        if src.youtube_video_id and not track.youtube_video_id:
            track.youtube_video_id = src.youtube_video_id
            changed = True
        if src.loudness_gain_db is not None and track.loudness_gain_db is None:
            track.loudness_gain_db = src.loudness_gain_db
            changed = True
        if src.status == DownloadStatus.done and track.status != DownloadStatus.done:
            track.status = DownloadStatus.done
            track.error = None
            changed = True
        return changed

    def _sync_liked_track_media_from_source(self, track: Track) -> bool:
        return self._sync_track_media_from_source(track)

    def get_track_audio_path(self, playlist_id: str, track_id: str) -> Optional[Path]:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        self.hydrate_media_paths(pl, persist=False)
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        media_track = track
        if self._media_source_ids(track)[0]:
            src = self._media_source_track(track)
            if src:
                sp_pl = self.get_playlist(self._media_source_ids(track)[0])
                if sp_pl:
                    self.hydrate_media_paths(sp_pl, persist=False)
                media_track = src
            elif self._sync_track_media_from_source(track):
                media_track = track
        if not media_track.media_relpath:
            return None
        audio_path = (self.root / "downloads" / media_track.media_relpath).resolve()
        downloads_root = (self.root / "downloads").resolve()
        try:
            if audio_path.is_file() and audio_path.is_relative_to(downloads_root):
                return audio_path
        except (OSError, ValueError):
            pass
        return None

    def _analyze_track_loudness(self, playlist_id: str, track: Track) -> None:
        if track.loudness_gain_db is not None:
            return
        key = (playlist_id, track.id)
        if key in self._loudness_analyzing:
            return
        self._loudness_analyzing.add(key)
        try:
            path = self.get_track_audio_path(playlist_id, track.id)
            if not path:
                return
            try:
                from loudness_analysis import analyze_loudness_gain_db
                gain = analyze_loudness_gain_db(path, self.root)
            except Exception:
                gain = None
            if gain is not None:
                track.loudness_gain_db = gain
        finally:
            self._loudness_analyzing.discard(key)

    def ensure_track_loudness_gain(self, playlist_id: str, track_id: str) -> Optional[float]:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        if track.loudness_gain_db is not None:
            return track.loudness_gain_db
        self.hydrate_media_paths(pl, persist=False)
        self._analyze_track_loudness(pl.id, track)
        if track.loudness_gain_db is not None:
            self._save_playlists(immediate=False)
        return track.loudness_gain_db

    def get_track_info(self, playlist_id: str, track_id: str) -> Optional[dict]:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        self.hydrate_media_paths(pl, persist=False)
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        downloads_root = (self.root / "downloads").resolve()
        variants: Dict[str, str] = dict(track.media_variants or {})
        if track.media_relpath:
            variants.setdefault("192", track.media_relpath)
        files: List[dict] = []
        seen_relpaths: set[str] = set()
        for key, rel in sorted(variants.items(), key=lambda kv: parse_quality_kbps(kv[0])):
            if not rel or rel in seen_relpaths:
                continue
            seen_relpaths.add(rel)
            audio_path = (self.root / "downloads" / rel).resolve()
            try:
                if not audio_path.is_file() or not audio_path.is_relative_to(downloads_root):
                    continue
            except (OSError, ValueError):
                continue
            stats = read_audio_file_stats(audio_path)
            files.append({"kbps": parse_quality_kbps(key), "relpath": rel, **stats})
        st = track.status.value if hasattr(track.status, "value") else str(track.status)
        return {
            "title": track.title,
            "artist": track.artist,
            "album": track.album or "",
            "status": st,
            "added_at": track.added_at.isoformat(),
            "url": track.url or "",
            "youtube_video_id": track.youtube_video_id or "",
            "error": track.error or "",
            "files": files,
        }

    def _track_audio_files(self, track: Track) -> List[Path]:
        downloads_root = (self.root / "downloads").resolve()
        rels: List[str] = []
        if track.media_relpath:
            rels.append(track.media_relpath)
        for rel in (track.media_variants or {}).values():
            if rel:
                rels.append(rel)
        out: List[Path] = []
        seen: set[str] = set()
        for rel in rels:
            if rel in seen:
                continue
            seen.add(rel)
            audio_path = (self.root / "downloads" / rel).resolve()
            try:
                if audio_path.is_file() and audio_path.is_relative_to(downloads_root):
                    out.append(audio_path)
            except (OSError, ValueError):
                continue
        return out

    def update_track_details(
        self,
        playlist_id: str,
        track_id: str,
        title: str,
        artist: str,
        album: str,
    ) -> Optional[dict]:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        self.hydrate_media_paths(pl, persist=False)
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        title_s = (title or "").strip()
        if not title_s:
            return None
        artist_s = (artist or "").strip()
        album_s = (album or "").strip()
        album_val: Optional[str] = album_s or None

        to_patch: List[Track] = [track]
        if self.is_liked_songs_playlist(pl.id):
            self._sync_track_media_from_source(track)
            src = self._media_source_track(track)
            if src:
                to_patch.append(src)
        else:
            liked_pl = self.playlists.get(self.LIKED_SONGS_PLAYLIST_ID)
            if liked_pl:
                for liked in liked_pl.tracks:
                    if (liked.liked_source_playlist_id or "").strip() == pl.id and (
                        liked.liked_source_track_id or ""
                    ).strip() == track.id:
                        to_patch.append(liked)

        seen_ids: set[str] = set()
        unique_tracks: List[Track] = []
        for t in to_patch:
            if t.id in seen_ids:
                continue
            seen_ids.add(t.id)
            t.title = title_s
            t.artist = artist_s
            t.album = album_val
            unique_tracks.append(t)

        seen_paths: set[Path] = set()
        for t in unique_tracks:
            for p in self._track_audio_files(t):
                if p in seen_paths:
                    continue
                seen_paths.add(p)
                write_track_tags(p, title_s, artist_s, album_s)

        self._save_playlists()
        return {
            "id": track.id,
            "title": title_s,
            "artist": artist_s,
            "album": album_s,
        }

    def _resolve_variant_relpath(self, track: Track, quality: str) -> Optional[str]:
        """Find on-disk file for a quality variant (``__64k.mp3`` suffix + video id)."""
        qk = variant_key(parse_quality_kbps(quality))
        ytdir = (self.root / "downloads" / "youtube").resolve()
        if not ytdir.is_dir():
            return None
        vid = self._youtube_video_id_for_track(track)
        if not vid:
            return None
        suffix = f"__{qk}k"
        candidates: List[Path] = []
        for path in ytdir.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in AUDIO_EXTS:
                continue
            if suffix not in path.stem:
                continue
            if f"[{vid}]" not in path.name:
                continue
            candidates.append(path)
        if not candidates:
            return None
        newest = max(candidates, key=lambda p: p.stat().st_mtime)
        root_dl = (self.root / "downloads").resolve()
        return newest.resolve().relative_to(root_dl).as_posix()

    @staticmethod
    def _cover_tiles(pl: Playlist, cover_tier: str = "high") -> List[str]:
        """Data Saver tiles use YouTube thumbs so the server never renders a
        local cover that the client immediately replaces."""
        tiles: List[str] = []
        for t in pl.tracks[:4]:
            vid = t.resolved_youtube_video_id() if cover_tier == "low" else ""
            if vid:
                tiles.append(f"/api/thumb?vid={quote(vid, safe='')}&q=low")
            else:
                tiles.append(f"/playlists/{pl.id}/tracks/{t.id}/cover")
        return tiles

    def list_playlist_catalog(self, owner_id: Optional[str] = None, cover_tier: str = "high") -> List[dict]:
        """Lightweight list for /api/playlists/catalog (Add to playlist, etc.)."""
        rows: List[dict] = []
        for pl in self.list_playlists_for_user(owner_id):
            tiles = self._cover_tiles(pl, cover_tier)
            rows.append(
                {
                    "id": pl.id,
                    "name": pl.name,
                    "bio": pl.bio or "",
                    "cover_tiles": tiles,
                    "system_locked": self.is_liked_songs_playlist(pl.id),
                }
            )
        return rows

    def list_playlist_nav(self, current_id: Optional[str], owner_id: Optional[str] = None, cover_tier: str = "high") -> List[dict]:
        """Sidebar rows: id, name, cover_tiles, active (avoids passing full playlist objects to the template)."""
        cur = (current_id or "").strip()
        rows: List[dict] = []
        for pl in self.list_playlists_for_user(owner_id):
            tiles = self._cover_tiles(pl, cover_tier)
            rows.append(
                {
                    "id": pl.id,
                    "name": pl.name,
                    "cover_tiles": tiles,
                    "active": bool(cur and pl.id == cur),
                    "system_locked": self.is_liked_songs_playlist(pl.id),
                }
            )
        return rows

    def _preemptive_cover_tile_generation(self, pl_id: str, track_id: str) -> None:
        """Generate cover tile preemptively after download to avoid slow first request."""
        try:
            from cover_image import DEFAULT_THUMB_MAX_SIDE, square_thumb_jpeg
            from tag_metadata import extract_cover

            pid = pl_id.strip()
            tid = track_id.strip()
            cpath = self.root / "webapp" / "static" / "cover_tiles"
            cpath.mkdir(parents=True, exist_ok=True)

            safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in pid)[:120]
            safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in tid)[:120]
            tile_path = cpath / f"{safe_p}_{safe_t}_s{DEFAULT_THUMB_MAX_SIDE}.jpg"

            # Skip if already exists
            if tile_path.is_file():
                return

            # Get audio path
            audio_path = self.get_track_audio_path(pid, tid)
            if not audio_path:
                return

            # Extract cover and generate thumbnail
            blob = extract_cover(audio_path)
            if not blob:
                return

            raw, _ = blob
            processed = square_thumb_jpeg(raw)
            if processed:
                tile_path.write_bytes(processed)
        except Exception:
            # Non-critical - don't fail downloads if cover generation fails
            pass

    def delete_playlist(self, playlist_id: str) -> bool:
        key = playlist_id.strip()
        if self.is_liked_songs_playlist(key):
            return False
        with self._lock:
            if key in self.playlists:
                del self.playlists[key]
            else:
                alt = next((k for k, pl in self.playlists.items() if pl.id == key), None)
                if alt is None:
                    return False
                del self.playlists[alt]
        self._invalidate_error_rows_cache()
        self._save_playlists()
        return True

    def update_playlist_meta(
        self,
        playlist_id: str,
        *,
        name: Optional[str] = None,
        bio: Optional[str] = None,
    ) -> bool:
        """Update playlist name and/or bio. ``name`` must be non-empty when provided."""
        key = playlist_id.strip()
        if self.is_liked_songs_playlist(key):
            return False
        if name is None and bio is None:
            return False
        with self._lock:
            pl = self.playlists.get(key)
            if pl is None:
                pl = next((p for p in self.playlists.values() if p.id == key), None)
            if pl is None:
                return False
            if name is not None:
                n = name.strip()
                if not n:
                    return False
                pl.name = n
            if bio is not None:
                b = bio.strip()
                pl.bio = b if b else None
        self._save_playlists()
        return True

    def list_playlists(self) -> List[Playlist]:
        return sorted(
            list(self.playlists.values()),
            key=lambda p: (0 if p.id == self.LIKED_SONGS_PLAYLIST_ID else 1, (p.name or "").lower()),
        )

    def list_playlists_for_user(self, owner_id: Optional[str]) -> List[Playlist]:
        """Only the user's own playlists; guests get an empty library."""
        if not owner_id:
            return []
        return [pl for pl in self.list_playlists() if pl.owner_id == owner_id]

    @staticmethod
    def _norm_meta(text: str) -> str:
        return " ".join((text or "").casefold().split())

    def library_matches_for_hit(self, video_id: str, title: str, artist: str, owner_id: Optional[str] = None) -> List[dict]:
        """Playlists/tracks that are the same YouTube id or the same title+artist (owner-scoped)."""
        vid = (video_id or "").strip()
        want_title = self._norm_meta(title)
        want_artist = self._norm_meta(artist)
        rows: List[dict] = []
        seen: set[tuple[str, str]] = set()
        for pl in self.list_playlists_for_user(owner_id):
            self.hydrate_media_paths(pl, persist=False)
            for t in pl.tracks:
                tvid = self._youtube_video_id_for_track(t)
                same_vid = bool(vid and tvid and vid == tvid)
                same_meta = bool(
                    want_title
                    and want_artist
                    and self._norm_meta(t.title) == want_title
                    and self._norm_meta(t.artist) == want_artist
                )
                if not same_vid and not same_meta:
                    continue
                key = (pl.id, t.id)
                if key in seen:
                    continue
                seen.add(key)
                rows.append(
                    {
                        "playlist_id": pl.id,
                        "playlist_name": pl.name or "",
                        "track_id": t.id,
                        "title": t.title or "",
                        "artist": t.artist or "",
                        "album": t.album or "",
                        "url": t.url or "",
                        "youtube_video_id": tvid or "",
                        "play_src": t.play_src() or "",
                        "play_variants": dict(t.play_variants() or {}),
                    }
                )
        return rows

    def find_canonical_downloaded_source(
        self,
        owner_id: Optional[str],
        video_id: str,
        title: str,
        artist: str,
        *,
        exclude_playlist_id: Optional[str] = None,
    ) -> Optional[tuple[str, str]]:
        """First library row with on-disk audio for this song (follows alias chain)."""
        exclude = (exclude_playlist_id or "").strip()
        for m in self.library_matches_for_hit(video_id, title, artist, owner_id):
            pid = (m.get("playlist_id") or "").strip()
            tid = (m.get("track_id") or "").strip()
            if not pid or not tid or pid == exclude:
                continue
            canon_pl, canon_t = self._canonical_media_track(pid, tid)
            if not canon_pl or not canon_t:
                continue
            self.hydrate_media_paths(canon_pl, persist=False)
            if canon_t.status == DownloadStatus.done and self._track_has_resolved_file(canon_t):
                return canon_pl.id, canon_t.id
        return None

    def _playlist_already_has_song(
        self,
        pl: Playlist,
        canon_playlist_id: str,
        canon_track_id: str,
        video_id: str,
    ) -> Optional[Track]:
        vid = (video_id or "").strip()
        for t in pl.tracks:
            sp, st = self._media_source_ids(t)
            if sp == canon_playlist_id and st == canon_track_id:
                return t
            if vid and self._youtube_video_id_for_track(t) == vid:
                return t
        return None

    def reload_library_all_qualities(self, owner_id: Optional[str] = None) -> dict:
        """Re-download every track at both quality tiers and drop every other format.

        Non-destructive per track: the old files are only deleted once both new
        qualities are on disk, so a failed re-download never loses audio.
        Returns a summary of what was queued and skipped.
        """
        queued_tracks = 0
        skipped = 0
        for pl in self.list_playlists_for_user(owner_id):
            if self.is_liked_songs_playlist(pl.id):
                continue
            for t in list(pl.tracks):
                if not self._track_can_queue_quality_download(t):
                    skipped += 1
                    continue
                with self._lock:
                    self._rebuild_pending.add((pl.id, t.id))
                for q in ("64", "192"):
                    self.start_track_download(pl.id, t.id, force_redownload=True, quality=q)
                queued_tracks += 1
        return {"queued": queued_tracks, "skipped": skipped, "qualities": ["64", "192"]}

    def _rebuild_cleanup(self, playlist_id: str, track_id: str) -> None:
        """Delete every non-canonical audio file for one rebuilt track."""
        key = (playlist_id, track_id)
        with self._lock:
            if key not in self._rebuild_pending:
                return
        pl = self.get_playlist(playlist_id)
        track = pl.get_track(track_id) if pl else None
        if not track:
            with self._lock:
                self._rebuild_pending.discard(key)
            return
        # Wait until both tiers are really on disk.
        if not self._track_has_resolved_file(track, "64") or not self._track_has_resolved_file(track, "192"):
            return

        with self._lock:
            if key not in self._rebuild_pending:
                return
            self._rebuild_pending.discard(key)

        variants = dict(track.media_variants or {})
        keep: set[Path] = set()
        for q in ("64", "192"):
            rel = variants.get(q)
            if not rel:
                continue
            try:
                keep.add((self.root / "downloads" / rel).resolve())
            except OSError:
                continue
        legacy = self._legacy_files_for_track(track, keep)
        all_media = list(variants.values()) + [track.media_relpath] + legacy
        canonical: Dict[str, str] = {}
        seen: set[Path] = set()
        for rel in all_media:
            if not rel:
                continue
            try:
                path = (self.root / "downloads" / rel).resolve()
            except OSError:
                continue
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            if path in keep:
                continue
            try:
                delete_lyrics_sidecars(path)
                path.unlink()
            except OSError:
                continue

        # Prune JSON references to files that no longer exist.
        for q, rel in list((track.media_variants or {}).items()):
            try:
                p = (self.root / "downloads" / rel).resolve() if rel else None
            except OSError:
                p = None
            if (not p) or (not p.is_file()):
                track.media_variants.pop(q, None)
            elif variant_key(q) in ("64", "192"):
                canonical[variant_key(q)] = rel
        track.media_variants = canonical
        track.media_relpath = canonical.get(variant_key(DEFAULT_KBPS)) or next(iter(canonical.values()), None)

        self._drop_cover_tiles(pl.id, track.id)
        self._save_playlists(immediate=False)

    def _legacy_files_for_track(self, track: Track, keep: set[Path]) -> List[str]:
        """Relative paths of same-video files whose suffix is not 64/192."""
        vid = self._youtube_video_id_for_track(track)
        if not vid:
            return []
        downloads_root = (self.root / "downloads").resolve()
        found: List[str] = []
        for path in (self.root / "downloads").rglob("*"):
            if not path.is_file():
                continue
            if f"[{vid}]" not in path.name:
                continue
            try:
                rp = path.resolve()
            except OSError:
                continue
            if rp in keep:
                continue
            if rp.suffix.lower() not in AUDIO_EXTS:
                continue
            try:
                found.append(rp.relative_to(downloads_root).as_posix())
            except ValueError:
                continue
        return found

    def _drop_cover_tiles(self, playlist_id: str, track_id: str) -> None:
        cpath = self.root / "webapp" / "static" / "cover_tiles"
        if not cpath.is_dir():
            return
        safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in playlist_id.strip())[:120]
        safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in track_id.strip())[:120]
        for tile in cpath.glob(f"{safe_p}_{safe_t}_s*.jpg"):
            try:
                tile.unlink()
            except OSError:
                continue

    def downloads_remaining_count(self, owner_id: Optional[str] = None) -> int:
        """How many downloads are still in the pipeline (queued, running, or supplementary)."""
        if not owner_id:
            return 0
        owned_tids: set[str] = set()
        status_n = 0
        for pl in self.list_playlists_for_user(owner_id):
            for t in pl.tracks:
                owned_tids.add(t.id)
                if t.status in (DownloadStatus.queued, DownloadStatus.downloading):
                    status_n += 1
        # The job queue is global, so count only this owner's active jobs.
        active = sum(1 for tid in self.progress if tid in owned_tids)
        return max(active, status_n)

    def error_tracks_for_sidebar(self, owner_id: Optional[str] = None) -> List[dict]:
        """Tracks in error state, for the downloads sidebar (scoped to the owner)."""
        if self._error_rows_cache is None:
            rows: List[dict] = []
            for pl in self.playlists.values():
                for t in pl.tracks:
                    if t.status != DownloadStatus.error:
                        continue
                    rows.append(
                        {
                            "playlist_id": pl.id,
                            "playlist_name": pl.name,
                            "track_id": t.id,
                            "title": t.title,
                            "artist": t.artist,
                            "error": t.error or "",
                        }
                    )
            self._error_rows_cache = rows
        if not owner_id:
            return []
        owned = {pid for pid, pl in self.playlists.items() if pl.owner_id == owner_id}
        return [r for r in self._error_rows_cache if r["playlist_id"] in owned]

    def retry_all_error_tracks(self, owner_id: Optional[str] = None) -> int:
        """Re-queue every track currently in error state (scoped to owner). Returns how many were queued."""
        n = 0
        for pl in self.list_playlists_for_user(owner_id):
            for t in list(pl.tracks):
                if t.status != DownloadStatus.error:
                    continue
                if self.start_track_download(pl.id, t.id, force_redownload=False):
                    n += 1
        return n

    def _track_content_key(self, track: Track) -> str:
        """Stable key for deduping the same song across playlists."""
        vid = self._youtube_video_id_for_track(track)
        if vid:
            return f"yt:{vid}"
        sid = spotify_track_id_from_url(track.url)
        if sid:
            return f"sp:{sid}"
        artist = (track.artist or "").strip().lower()
        title = (track.title or "").strip().lower()
        if artist and title:
            return f"meta:{artist}|{title}"
        return f"id:{track.id}"

    def _tally_playlist_quality_downloads(
        self,
        pl: Playlist,
        q: str,
        seen: Optional[set[str]] = None,
    ) -> dict[str, int]:
        """Count queue outcomes for one playlist. ``seen`` dedupes library-wide bulk runs."""
        if self.is_liked_songs_playlist(pl.id):
            return {"queued": 0, "already_have": 0, "ineligible": 0, "duplicates": 0}
        self.hydrate_media_paths(pl, fill_albums=False, persist=False)
        queued = 0
        already_have = 0
        ineligible = 0
        duplicates = 0
        for t in pl.tracks:
            key = self._track_content_key(t)
            if seen is not None:
                if key in seen:
                    duplicates += 1
                    continue
                seen.add(key)
            if not self._track_can_queue_quality_download(t):
                ineligible += 1
                continue
            if self._track_has_resolved_file(t, q):
                already_have += 1
                continue
            if self.start_track_download(pl.id, t.id, quality=q):
                queued += 1
            else:
                ineligible += 1
        return {
            "queued": queued,
            "already_have": already_have,
            "ineligible": ineligible,
            "duplicates": duplicates,
        }

    def queue_playlist_quality_downloads(self, playlist_id: str, quality: str) -> Optional[dict]:
        """Queue downloads for every track missing the given quality variant. Returns None if playlist missing."""
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        q = variant_key(parse_quality_kbps(quality))
        tallies = self._tally_playlist_quality_downloads(pl, q)
        skipped = tallies["already_have"] + tallies["ineligible"]
        return {
            "queued": tallies["queued"],
            "skipped": skipped,
            "already_have": tallies["already_have"],
            "ineligible": tallies["ineligible"],
            "duplicates": tallies["duplicates"],
            "quality": q,
        }

    def queue_all_quality_downloads(self, quality: str, owner_id: Optional[str] = None) -> dict:
        """Queue missing quality variants across the owner's playlists (excluding Liked Songs)."""
        q = variant_key(parse_quality_kbps(quality))
        seen: set[str] = set()
        queued = 0
        already_have = 0
        ineligible = 0
        duplicates = 0
        for pl in self.list_playlists_for_user(owner_id):
            tallies = self._tally_playlist_quality_downloads(pl, q, seen)
            queued += tallies["queued"]
            already_have += tallies["already_have"]
            ineligible += tallies["ineligible"]
            duplicates += tallies["duplicates"]
        skipped = already_have + ineligible
        return {
            "queued": queued,
            "skipped": skipped,
            "already_have": already_have,
            "ineligible": ineligible,
            "duplicates": duplicates,
            "quality": q,
        }

    def progress_api_payload(self, owner_id: Optional[str] = None) -> dict:
        """Shape used by GET /api/progress (active jobs + queue summary), scoped to the owner."""
        err_all = self.error_tracks_for_sidebar(owner_id)
        max_err = 120
        err_slice = err_all[:max_err]
        jobs = dict(self.progress)
        if owner_id:
            owned_tids = {
                t.id
                for pl in self.list_playlists_for_user(owner_id)
                for t in pl.tracks
            }
            jobs = {tid: row for tid, row in jobs.items() if tid in owned_tids}
        remaining = self.downloads_remaining_count(owner_id)
        queue_depth = 0
        if owner_id:
            queue_depth = sum(
                1
                for pl in self.list_playlists_for_user(owner_id)
                for t in pl.tracks
                if t.status == DownloadStatus.queued
            )
        return {
            "jobs": jobs,
            "remaining": remaining,
            "queue_depth": queue_depth,
            "errors": err_slice,
            "errors_total": len(err_all),
        }

    def _hydrate_lock_for_playlist(self, playlist_id: str) -> threading.Lock:
        with self._hydrate_pl_guard:
            lk = self._hydrate_pl_locks.get(playlist_id)
            if lk is None:
                lk = threading.Lock()
                self._hydrate_pl_locks[playlist_id] = lk
            return lk

    def hydrate_media_paths(self, pl: Optional[Playlist], *, fill_albums: bool = False, persist: bool = True) -> None:
        """If files exist on disk but JSON has no path, attach media_relpath; optionally read album tags.
        `persist` controls whether discovered media/albums are flushed to disk.
        Uses in-memory caching to avoid repeated filesystem scans.
        """
        if pl is None:
            return

        with self._hydrate_lock_for_playlist(pl.id):
            now = _now_ts()
            cache_entry = self._get_cached_hydration(pl.id, now)

            sub = _sanitize_folder_name(pl.name)
            base = self.root / "downloads" / sub
            changed = False

            if cache_entry:
                # Use cached stem-to-path mapping
                by_stem = cache_entry.by_stem
            else:
                # Build fresh mapping and cache it
                by_stem: Dict[str, Path] = {}
                if base.is_dir():
                    by_stem = {p.stem: p for p in base.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS}
                cache_entry = self._set_cached_hydration(pl.id, by_stem)

            # Match tracks to files using cached mapping
            for t in pl.tracks:
                if t.media_relpath or t.status != DownloadStatus.done:
                    continue
                key = f"{t.artist} - {t.title}"
                hit = by_stem.get(key)
                if hit is None:
                    hit = next((by_stem[s] for s in by_stem if t.title.lower() in s.lower()), None)
                if hit is not None:
                    t.media_relpath = hit.relative_to(self.root / "downloads").as_posix()
                    changed = True

            if fill_albums:
                changed = self._hydrate_albums_cached(pl, cache_entry, persist) or changed

            for t in pl.tracks:
                if self._prune_missing_variants(t):
                    changed = True
                if self._repair_stale_media_relpath(t):
                    changed = True
                if self._media_source_ids(t)[0] and self._sync_track_media_from_source(t):
                    changed = True

            if changed and persist:
                self._save_playlists()

    def _hydrate_albums_for_playlist(self, pl: Playlist) -> bool:
        """Legacy album hydration - reads all files immediately. Consider using _hydrate_albums_cached for lazy loading."""
        downloads = self.root / "downloads"
        changed = False
        for t in pl.tracks:
            if t.status != DownloadStatus.done or not t.media_relpath:
                continue
            if t.album and str(t.album).strip():
                continue
            p = downloads / t.media_relpath
            try:
                rp = p.resolve()
            except OSError:
                continue
            if not rp.is_file():
                continue
            try:
                rp.relative_to(downloads.resolve())
            except ValueError:
                continue
            alb = extract_album(p)
            if alb:
                t.album = alb
                changed = True
        return changed

    def _hydrate_albums_cached(self, pl: Playlist, cache_entry: _HydrationCacheEntry, persist: bool) -> bool:
        """Lazy album hydration using cache - only reads files without cached album data."""
        downloads = self.root / "downloads"
        changed = False

        for t in pl.tracks:
            if t.status != DownloadStatus.done or not t.media_relpath:
                continue
            if t.album and str(t.album).strip():
                continue

            # Check cached album data first
            cached_album = cache_entry.albums.get(t.id)
            if cached_album is not None:
                t.album = cached_album if cached_album else None
                if cached_album:
                    changed = True
                continue

            # Not cached - read from file and store in cache
            p = downloads / t.media_relpath
            try:
                rp = p.resolve()
            except OSError:
                cache_entry.albums[t.id] = None
                continue
            if not rp.is_file():
                cache_entry.albums[t.id] = None
                continue
            try:
                rp.relative_to(downloads.resolve())
            except ValueError:
                cache_entry.albums[t.id] = None
                continue

            alb = extract_album(p)
            cache_entry.albums[t.id] = alb
            if alb:
                t.album = alb
                changed = True

        return changed

    def _worker_main(self) -> None:
        # Each thread owns its own YtDlpAudioDownloader — yt-dlp is not thread-safe to share.
        local_ytdlp = YtDlpAudioDownloader(self.root)

        # Only the first thread to arrive re-enqueues interrupted tracks. The claim
        # happens under the lock, the enqueue outside it: _enqueue_download takes the
        # same non-reentrant lock, so calling it while holding it would deadlock.
        with self._lock:
            first = not self._startup_enqueue_done
            if first:
                self._startup_enqueue_done = True
        if first:
            for pl in list(self.playlists.values()):
                for track in list(pl.tracks):
                    if track.status == DownloadStatus.queued and not self._track_has_resolved_file(track):
                        self._enqueue_download(pl.id, track.id)

        while True:
            job = self.job_queue.get()
            try:
                job(local_ytdlp)
            except Exception:
                logging.getLogger(__name__).exception("Download worker job failed")
            finally:
                self.job_queue.task_done()

    def spotify_url_search_query(self, raw: str) -> Optional[str]:
        """Spotify track URL -> YouTube search query (artist + title). Playlists return None."""
        s = (raw or "").strip().split("?")[0].split("#")[0].strip()
        if not s:
            return None
        try:
            kind, tid = detect_spotify_url_type(s)
        except ValueError:
            return None
        if kind != "track":
            return None
        artist = ""
        title = ""
        try:
            info = self._embed.get_track_info(s)
            artist = (info.artists or "").strip()
            title = (info.title or "").strip()
        except Exception:
            pass
        if not title:
            try:
                import requests

                canon = f"https://open.spotify.com/track/{tid}"
                resp = requests.get(
                    "https://open.spotify.com/oembed",
                    params={"url": canon},
                    timeout=15,
                    headers={"User-Agent": "Mozilla/5.0"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    title = str(data.get("title") or "").strip()
                    artist = str(data.get("author_name") or "").strip()
            except Exception:
                pass
        q = f"{artist} {title}".strip() if artist and title else (title or artist)
        return q or None

    def import_from_line(self, raw: str, owner_id: Optional[str] = None) -> Playlist:
        """
        Top bar: Spotify playlist/track URL, YouTube video URL, or plain words (YouTube search).
        """
        pl = self._import_dispatch(raw)
        if owner_id and pl is not None:
            pl.owner_id = owner_id
            self._save_playlists()
        return pl

    def _import_dispatch(self, raw: str) -> Playlist:
        s = (raw or "").strip()
        if not s:
            raise ValueError("Enter a Spotify or YouTube link, or type a song / artist to search.")

        low = s.lower()

        if "open.spotify.com" in low or low.startswith("spotify:"):
            try:
                kind, _sid = detect_spotify_url_type(s)
            except ValueError:
                raise ValueError(
                    "That Spotify link doesn’t look valid. Use a playlist or track URL "
                    "(open.spotify.com/…), or type words to search YouTube."
                ) from None
            if kind == "playlist":
                return self._import_spotify_playlist(s)
            if kind == "track":
                return self._import_spotify_track(s)
            if kind == "album":
                raise ValueError(
                    "Album links aren’t supported in this box yet. Use a playlist or track link, "
                    "or search by song name."
                )

        if low.startswith("http://") or low.startswith("https://"):
            if "youtube.com" in low or "youtu.be" in low:
                return self._import_youtube_video_url(s)
            raise ValueError(
                "Only Spotify and YouTube URLs work here. For other sites, open a playlist and use Add song."
            )

        hits = search_youtube_tracks(self.root, s, 1)
        if not hits:
            raise ValueError(
                f'No YouTube results for “{s}”. Try different words or paste an open.spotify.com or YouTube link.'
            )
        h = hits[0]
        label = s[:56] + ("…" if len(s) > 57 else "")
        pl = Playlist.create(f"Search: {label}")
        self.playlists[pl.id] = pl
        track = Track.create(title=h["title"], artist=h["artist"], url=h["url"])
        vid = h.get("video_id")
        if isinstance(vid, str) and vid:
            track.youtube_video_id = vid
        alb = h.get("album")
        if isinstance(alb, str) and alb.strip():
            track.album = alb.strip()[:500]
        pl.add_track(track)
        self._enqueue_download(pl.id, track.id)
        self._invalidate_hydration_cache(pl.id)  # Invalidate cache for new playlist
        self._save_playlists()
        return pl

    def import_spotify_playlist(self, spotify_url: str, owner_id: Optional[str] = None) -> Playlist:
        """Same as the top bar importer (not playlists-only). Kept for clarity / callers."""
        return self.import_from_line(spotify_url, owner_id)

    def _import_youtube_video_url(self, url: str) -> Playlist:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "socket_timeout": 25,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        title = (info.get("title") or "Video").strip()
        uploader = (info.get("uploader") or info.get("channel") or "YouTube").strip()
        pl = Playlist.create(title[:100] or "YouTube")
        self.playlists[pl.id] = pl
        track = Track.create(title=title[:300], artist=uploader[:300], url=url.strip())
        yid = youtube_video_id_from_url(url) or (
            str(info.get("id")) if info.get("id") else None
        )
        if yid:
            track.youtube_video_id = yid
        alb = info.get("album")
        if isinstance(alb, str) and alb.strip():
            track.album = alb.strip()[:500]
        pl.add_track(track)
        self._enqueue_download(pl.id, track.id)
        self._invalidate_hydration_cache(pl.id)
        self._save_playlists()
        return pl

    def _import_spotify_track(self, spotify_url: str) -> Playlist:
        catalog_key = spotify_catalog_key_from_import_url(spotify_url)
        info = self._embed.get_track_info(spotify_url)
        existing_pl = self._playlist_by_catalog_key(catalog_key)
        name = f"{info.artists} — {info.title}"
        if len(name) > 120:
            name = name[:117] + "…"
        pl = existing_pl
        if pl is None:
            pl = Playlist.create(name or "Imported track")
            pl.spotify_catalog_key = catalog_key
            self.playlists[pl.id] = pl
        else:
            self.hydrate_media_paths(pl)

        sid = info.id
        existing = self._find_track_by_spotify_id(pl, sid) or self._find_track_by_metadata(
            pl, info.artists, info.title
        )
        if existing:
            if existing.status not in (DownloadStatus.queued, DownloadStatus.downloading):
                self.hydrate_media_paths(pl)
                if not (
                    existing.status == DownloadStatus.done and self._track_has_resolved_file(existing)
                ):
                    if info.cover_url and not existing.cover_url:
                        existing.cover_url = info.cover_url
                    if info.album and not existing.album:
                        existing.album = (info.album or "").strip()[:500] or None
                    self._enqueue_download(pl.id, existing.id)
            self._invalidate_hydration_cache(pl.id)
            self._save_playlists()
            return pl

        track = Track.create(title=info.title, artist=info.artists, url=info.spotify_url)
        track.cover_url = info.cover_url
        if info.album and str(info.album).strip():
            track.album = str(info.album).strip()[:500]
        pl.add_track(track)
        self._enqueue_download(pl.id, track.id)
        self._invalidate_hydration_cache(pl.id)
        self._save_playlists()
        return pl

    def _import_spotify_playlist(self, spotify_url: str) -> Playlist:
        catalog_key = spotify_catalog_key_from_import_url(spotify_url)
        existing_pl = self._playlist_by_catalog_key(catalog_key)

        # Fetch metadata directly — no need to queue behind pending downloads.
        meta, track_infos = self._embed.get_playlist_info(spotify_url)
        if not track_infos:
            raise ValueError("No tracks found for that Spotify URL")

        name = (meta.name or "").strip() or "Imported Playlist"
        pl = existing_pl
        if pl is None:
            pl = Playlist.create(name)
            pl.spotify_catalog_key = catalog_key
            self.playlists[pl.id] = pl
        else:
            if name and pl.name != name:
                pl.name = name
            self.hydrate_media_paths(pl)

        for info in track_infos:
            sid = info.id
            existing = (
                self._find_track_by_spotify_id(pl, sid)
                or self._find_track_by_metadata(pl, info.artists, info.title)
            )
            if existing:
                if existing.status in (DownloadStatus.queued, DownloadStatus.downloading):
                    continue
                self.hydrate_media_paths(pl)
                if existing.status == DownloadStatus.done and self._track_has_resolved_file(existing):
                    continue
                # Update cover_url in case it changed
                if info.cover_url and not existing.cover_url:
                    existing.cover_url = info.cover_url
                if info.album and not existing.album:
                    existing.album = (info.album or "").strip()[:500] or None
                self._enqueue_download(pl.id, existing.id)
                continue

            track = Track.create(
                title=info.title,
                artist=info.artists,
                url=info.spotify_url,
            )
            track.cover_url = info.cover_url
            if info.album and str(info.album).strip():
                track.album = str(info.album).strip()[:500]
            pl.add_track(track)
            self._enqueue_download(pl.id, track.id)

        self._invalidate_hydration_cache(pl.id)
        self._save_playlists()
        return pl

    def add_track_to_playlist(
        self,
        playlist_id: str,
        title: str,
        artist: str,
        url: Optional[str] = None,
        album: Optional[str] = None,
        *,
        enqueue_download: bool = True,
        download_quality: str = str(DEFAULT_KBPS),
        owner_id: Optional[str] = None,
        source_playlist_id: Optional[str] = None,
        source_track_id: Optional[str] = None,
        video_id: Optional[str] = None,
    ) -> Track:
        pl = self.get_playlist(playlist_id)
        if not pl:
            raise KeyError("Playlist not found")
        if self.is_liked_songs_playlist(playlist_id):
            raise ValueError("Add songs to Liked Songs using the heart button on the player.")
        title_s = (title or "").strip()
        artist_s = (artist or "").strip()
        u = (url or "").strip() or None
        # Search hits carry a video id even when the URL is missing; without it
        # the queued download has nothing to resolve.
        yid = youtube_video_id_from_url(u) or (video_id or "").strip()

        canon: Optional[tuple[str, str]] = None
        sp = (source_playlist_id or "").strip()
        st = (source_track_id or "").strip()
        if sp and st:
            canon_pl, canon_t = self._canonical_media_track(sp, st)
            if canon_pl and canon_t and self._track_has_resolved_file(canon_t):
                canon = (canon_pl.id, canon_t.id)
        elif enqueue_download and owner_id:
            found = self.find_canonical_downloaded_source(
                owner_id, yid, title_s, artist_s, exclude_playlist_id=playlist_id
            )
            if found:
                canon = found

        if canon:
            canon_pl, canon_t = self._canonical_media_track(canon[0], canon[1])
            if not canon_pl or not canon_t:
                canon = None
            else:
                existing = self._playlist_already_has_song(
                    pl, canon_pl.id, canon_t.id, yid or self._youtube_video_id_for_track(canon_t)
                )
                if existing:
                    return existing
                track = Track.create(
                    title=title_s or canon_t.title,
                    artist=artist_s or canon_t.artist,
                    url=u or canon_t.url,
                )
                track.media_source_playlist_id = canon_pl.id
                track.media_source_track_id = canon_t.id
                if album and isinstance(album, str) and album.strip():
                    track.album = album.strip()[:500]
                elif canon_t.album:
                    track.album = canon_t.album
                if canon_t.cover_url:
                    track.cover_url = canon_t.cover_url
                if canon_t.youtube_video_id:
                    track.youtube_video_id = canon_t.youtube_video_id
                elif yid:
                    track.youtube_video_id = yid
                track.status = DownloadStatus.done
                self._sync_track_media_from_source(track)
                pl.add_track(track)
                self._invalidate_hydration_cache(pl.id)
                self._save_playlists()
                return track

        track = Track.create(title=title_s, artist=artist_s, url=u)
        if album and isinstance(album, str) and album.strip():
            track.album = album.strip()[:500]
        if yid:
            track.youtube_video_id = yid
        if not enqueue_download:
            track.status = DownloadStatus.pending
        pl.add_track(track)
        if enqueue_download:
            self._enqueue_download(playlist_id, track.id, quality=download_quality)
        self._invalidate_hydration_cache(pl.id)  # Invalidate cache on new track
        self._save_playlists()
        return track

    def start_track_download(
        self,
        playlist_id: str,
        track_id: str,
        *,
        force_redownload: bool = False,
        quality: str = str(DEFAULT_KBPS),
    ) -> bool:
        """Queue a pending (or retry failed) track for download."""
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return False
        track = pl.get_track(track_id.strip())
        if not track:
            return False
        q = variant_key(parse_quality_kbps(quality))
        if self._track_has_resolved_file(track, q) and not force_redownload:
            if track.status != DownloadStatus.done:
                pl.update_track_status(track.id, DownloadStatus.done, None)
                self._save_playlists()
            return True
        if force_redownload:
            if not (track.url or track.youtube_video_id):
                return False
            # Never delete the current audio up front. The replacement is written
            # alongside it and only the canonical files survive once both tiers
            # exist (_rebuild_cleanup), so a failed re-download never costs audio.
            if track.status != DownloadStatus.downloading:
                pl.update_track_status(track.id, DownloadStatus.queued, None)
            self._save_playlists()
            self._enqueue_download(playlist_id.strip(), track.id, quality=q, force=True)
            return True
        if not self._track_has_resolved_file(track, q):
            supplementary = track.status == DownloadStatus.done or self._track_has_resolved_file(track)
            if supplementary:
                self._enqueue_download(playlist_id.strip(), track.id, quality=q, supplementary=True)
                return True
            st = track.status
            if st in (DownloadStatus.downloading, DownloadStatus.queued):
                self._enqueue_download(playlist_id.strip(), track.id, quality=q, supplementary=True)
                return True
            if st not in (DownloadStatus.pending, DownloadStatus.error):
                return False
            pl.update_track_status(track.id, DownloadStatus.queued, None)
            self._save_playlists()
            self._enqueue_download(playlist_id.strip(), track.id, quality=q)
            return True
        if track.status != DownloadStatus.done:
            pl.update_track_status(track.id, DownloadStatus.done, None)
            self._save_playlists()
        return True

    def delete_track(self, playlist_id: str, track_id: str, *, unlink_media: bool = True) -> bool:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return False
        tid = track_id.strip()
        track = pl.get_track(tid)
        if not track:
            return False
        if unlink_media and track.media_relpath:
            audio_path = (self.root / "downloads" / track.media_relpath).resolve()
            downloads_root = (self.root / "downloads").resolve()
            try:
                if audio_path.is_file() and audio_path.is_relative_to(downloads_root):
                    delete_lyrics_sidecars(audio_path)
                    audio_path.unlink()
            except OSError:
                pass
        pl.remove_track(tid)
        self._invalidate_hydration_cache(pl.id)  # Invalidate cache on track deletion
        self._save_playlists()
        return True

    def _make_progress_hook(self, track_id: str, title: str, artist: str):
        def hook(d: dict) -> None:
            status = d.get("status", "")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes") or 0
                pct = round((downloaded / total) * 100, 1) if total else None
                speed = d.get("speed")
                eta = d.get("eta")
                self.progress[track_id] = {
                    "title": title,
                    "artist": artist,
                    "percent": pct,
                    "speed": round(speed / 1024, 1) if speed else None,  # KB/s
                    "eta": int(eta) if eta else None,
                    "phase": "downloading",
                }
            elif status == "finished":
                self.progress[track_id] = {
                    "title": title,
                    "artist": artist,
                    "percent": 100,
                    "speed": None,
                    "eta": None,
                    "phase": "converting",
                }
        return hook

    def _enqueue_download(self, pl_id: str, track_id: str, *, quality: str = str(DEFAULT_KBPS), supplementary: bool = False, force: bool = False) -> None:
        q = variant_key(parse_quality_kbps(quality))
        job_key = (track_id, q)
        with self._lock:
            if job_key in self._pending_job_keys:
                return
            self._pending_job_keys.add(job_key)

        def job(ytdlp: YtDlpAudioDownloader) -> None:
            try:
                pl = self.get_playlist(pl_id)
                track = pl.get_track(track_id) if pl else None
                if not track:
                    return

                if self._media_source_ids(track)[0]:
                    self._sync_track_media_from_source(track)
                    if self._track_has_resolved_file(track, q):
                        if not supplementary and track.status != DownloadStatus.done:
                            pl.update_track_status(track_id, DownloadStatus.done)
                            self._save_playlists(immediate=False)
                        return

                if not force and self._track_has_resolved_file(track, q):
                    if not supplementary and track.status != DownloadStatus.done:
                        pl.update_track_status(track_id, DownloadStatus.done)
                        self._save_playlists(immediate=False)
                    return

                if not supplementary:
                    pl.update_track_status(track_id, DownloadStatus.downloading)

                hook = self._make_progress_hook(track_id, track.title, track.artist)
                self.progress[track_id] = {
                    "title": track.title,
                    "artist": track.artist,
                    "percent": None,
                    "speed": None,
                    "eta": None,
                    "phase": "searching",
                    "quality": q,
                }

                if track.url and "open.spotify.com" in track.url:
                    sub = _sanitize_folder_name(pl.name)
                    out_dir = (self.root / "downloads" / sub)
                    path, yid = self._embed.download_track(
                        artist=track.artist,
                        title=track.title,
                        out_dir=out_dir,
                        cover_url=track.cover_url,
                        progress_hook=hook,
                        quality=q,
                    )
                    if yid:
                        track.youtube_video_id = yid
                    if path is not None:
                        root_dl = (self.root / "downloads").resolve()
                        try:
                            rel = path.resolve().relative_to(root_dl).as_posix()
                            track.set_media_variant(q, rel)
                        except ValueError:
                            pass
                    if not self._track_has_resolved_file(track, q):
                        rel = self._resolve_variant_relpath(track, q)
                        if rel:
                            track.set_media_variant(q, rel)
                else:
                    query = self._download_query_for_track(track)
                    yid, out_path = ytdlp.download_from_line(query, progress_hook=hook, quality=q)
                    if yid:
                        track.youtube_video_id = yid
                    root_dl = (self.root / "downloads").resolve()
                    if out_path is not None and out_path.is_file():
                        try:
                            rel = out_path.resolve().relative_to(root_dl).as_posix()
                            track.set_media_variant(q, rel)
                        except ValueError:
                            pass
                    if not self._track_has_resolved_file(track, q):
                        rel = self._resolve_variant_relpath(track, q)
                        if rel:
                            track.set_media_variant(q, rel)

                if self._track_has_resolved_file(track, q):
                    self.lyrics.materialize_after_download(track)
                    self._analyze_track_loudness(pl_id, track)
                    self._preemptive_cover_tile_generation(pl_id, track_id)
                    self._invalidate_hydration_cache(pl_id)
                    self._rebuild_cleanup(pl_id, track_id)
                    if not supplementary or track.status != DownloadStatus.done:
                        pl.update_track_status(track_id, DownloadStatus.done)
                elif supplementary:
                    self._clear_stale_variant(track, q)
                    logging.getLogger(__name__).warning(
                        "Supplementary download for %s kbps did not produce a file for track %s",
                        q,
                        track_id,
                    )
                    self._settle_supplementary_status(pl, track, track_id)
                elif self._track_has_resolved_file(track):
                    # A forced re-download produced nothing but the previous audio is
                    # still on disk; keep the working track instead of flagging it.
                    logging.getLogger(__name__).warning(
                        "Download for %s kbps produced no file; keeping existing audio for track %s",
                        q,
                        track_id,
                    )
                    pl.update_track_status(track_id, DownloadStatus.done)
                else:
                    err = (
                        "No YouTube match found. The track may be very obscure or region-locked on YouTube."
                        if track.url and "open.spotify.com" in track.url
                        else "No audio file found under downloads/youtube after YouTube download."
                    )
                    pl.update_track_status(track_id, DownloadStatus.error, err)

            except Exception as exc:
                if supplementary:
                    if track:
                        self._clear_stale_variant(track, q)
                    logging.getLogger(__name__).exception(
                        "Supplementary download failed for track %s at %s kbps",
                        track_id,
                        q,
                    )
                    if track and pl:
                        self._settle_supplementary_status(pl, track, track_id)
                elif pl:
                    if track and self._track_has_resolved_file(track):
                        logging.getLogger(__name__).warning(
                            "Download for %s kbps failed; keeping existing audio for track %s",
                            q,
                            track_id,
                        )
                        pl.update_track_status(track_id, DownloadStatus.done)
                    else:
                        pl.update_track_status(track_id, DownloadStatus.error, str(exc))
            finally:
                with self._lock:
                    self._pending_job_keys.discard(job_key)
                self._rebuild_cleanup(pl_id, track_id)
                self.progress.pop(track_id, None)
                try:
                    delay = float(
                        (
                            os.environ.get("SPOLOCAL_DOWNLOAD_DELAY_SEC")
                            or os.environ.get("SPRITY_DOWNLOAD_DELAY_SEC")
                            or "0"
                        ).strip()
                    )
                except ValueError:
                    delay = 0.0
                if delay > 0:
                    time.sleep(delay)
                self._save_playlists(immediate=False)

        self.job_queue.put(job)
