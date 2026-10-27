"""Domain models and state events for SpoLocal.

Defines track and playlist data shapes.
Publishes status-change notifications used by UI refresh logic."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Callable, Dict, List, Optional
from urllib.parse import quote
from uuid import uuid4
import re

from audio_quality import kbps_from_relpath

_YT_ID_IN_URL = re.compile(
    r"(?:youtube\.com/watch\?[^#]*v=|youtu\.be/|youtube\.com/embed/)([A-Za-z0-9_-]{11})",
    re.I,
)
_YT_ID_IN_QUERY = re.compile(r"[?&]v=([A-Za-z0-9_-]{11})\b", re.I)
_YT_ID_IN_NAME = re.compile(r"\[([A-Za-z0-9_-]{11})\]")


class DownloadStatus(str, Enum):
    queued = "queued"
    downloading = "downloading"
    done = "done"
    error = "error"
    pending = "pending"  # saved from search / manual add; no download started yet


_on_track_status_changed: Optional[Callable[[], None]] = None


def set_track_status_change_listener(cb: Optional[Callable[[], None]]) -> None:
    global _on_track_status_changed
    _on_track_status_changed = cb


def notify_track_status_changed() -> None:
    if _on_track_status_changed is not None:
        _on_track_status_changed()


@dataclass(slots=True)
class Track:
    id: str
    title: str
    artist: str
    url: Optional[str] = None
    status: DownloadStatus = DownloadStatus.queued
    error: Optional[str] = None
    added_at: datetime = field(default_factory=datetime.utcnow)
    media_relpath: Optional[str] = None
    media_variants: Dict[str, str] = field(default_factory=dict)
    cover_url: Optional[str] = None
    youtube_video_id: Optional[str] = None
    album: Optional[str] = None
    # Playback gain in dB to normalize perceived loudness (negative = quieter).
    loudness_gain_db: Optional[float] = None
    # Manual gain tweak in dB applied on top of the measured gain (album or song level).
    loudness_offset_db: float = 0.0
    # When this row lives in the Liked Songs playlist, references the original list + track id.
    liked_source_playlist_id: Optional[str] = None
    liked_source_track_id: Optional[str] = None
    # Playlist alias: same audio file as another track row (no re-download).
    media_source_playlist_id: Optional[str] = None
    media_source_track_id: Optional[str] = None

    @classmethod
    def create(cls, title: str, artist: str, url: Optional[str] = None) -> "Track":
        return cls(id=str(uuid4()), title=title, artist=artist, url=url)

    def _media_rel_for_quality(self, quality: Optional[str] = None) -> Optional[str]:
        variants = self.media_variants or {}
        if quality:
            rel = variants.get(str(quality))
            if rel:
                return rel
            legacy = {"low": "64", "mid": "192", "medium": "192", "high": "192"}
            if quality in legacy and legacy[quality] in variants:
                return variants[legacy[quality]]
        for key in sorted(variants.keys(), key=lambda k: int(k) if str(k).isdigit() else 0, reverse=True):
            if variants.get(key):
                return variants[key]
        return self.media_relpath

    def resolved_youtube_video_id(self) -> str:
        vid = (self.youtube_video_id or "").strip()
        if len(vid) == 11:
            return vid
        u = (self.url or "").strip()
        if u:
            m = _YT_ID_IN_URL.search(u) or _YT_ID_IN_QUERY.search(u)
            if m:
                return m.group(1)
        rels = []
        if self.media_relpath:
            rels.append(self.media_relpath)
        rels.extend((self.media_variants or {}).values())
        for rel in rels:
            if not rel:
                continue
            m = _YT_ID_IN_NAME.search(Path(str(rel)).name)
            if m:
                return m.group(1)
        return ""

    def play_src(self, quality: Optional[str] = None) -> Optional[str]:
        rel = self._media_rel_for_quality(quality)
        if not rel:
            return None
        if self.status != DownloadStatus.done and not (self.media_variants or self.media_relpath):
            return None
        return "/media/" + quote(rel, safe="/")

    def stream_play_src(self) -> Optional[str]:
        vid = self.resolved_youtube_video_id()
        if not vid:
            return None
        return "/api/stream?vid=" + quote(vid, safe="")

    def playback_src(self, quality: Optional[str] = None) -> Optional[str]:
        return self.play_src(quality) or self.stream_play_src()

    def play_variants(self) -> Dict[str, str]:
        return track_play_variants(self)

    def set_media_variant(self, quality: str, relpath: Optional[str]) -> None:
        if not quality or not relpath:
            return
        if self.media_variants is None:
            self.media_variants = {}
        self.media_variants[str(quality)] = relpath
        if str(quality) == "192" or not self.media_relpath:
            self.media_relpath = relpath

    def has_media_variant(self, quality: str) -> bool:
        return bool((self.media_variants or {}).get(str(quality)) or (str(quality) == "192" and self.media_relpath))


def track_play_variants(track: Track) -> Dict[str, str]:
    """Media URLs keyed by kbps (e.g. ``192``). Module helper avoids stale class bytecode in Docker."""
    out: Dict[str, str] = {}
    for key, rel in (track.media_variants or {}).items():
        if rel:
            out[key] = "/media/" + quote(rel, safe="/")
    # Keep the primary file visible even when variants exist. Hydration fills
    # ``media_relpath`` without touching ``media_variants``; without this, adding
    # a 64k variant would hide an existing 192k file from the frontend.
    if track.media_relpath:
        inferred = kbps_from_relpath(track.media_relpath)
        key = str(inferred) if inferred else "192"
        if key not in out:
            out[key] = "/media/" + quote(track.media_relpath, safe="/")
    return out


@dataclass(slots=True)
class Playlist:
    id: str
    name: str
    tracks: List[Track] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    spotify_catalog_key: Optional[str] = None
    spotify_snapshot_id: Optional[str] = None
    bio: Optional[str] = None
    # Account that owns this playlist. None = unclaimed (visible to no one until
    # a user logs in and claims it).
    owner_id: Optional[str] = None
    # Public read-only share token. None = sharing disabled.
    share_token: Optional[str] = None

    @classmethod
    def create(cls, name: str) -> "Playlist":
        return cls(id=str(uuid4()), name=name.strip() or "Untitled", bio=None)

    def add_track(self, track: Track) -> None:
        self.tracks.append(track)

    def get_track(self, track_id: str) -> Optional[Track]:
        return next((t for t in self.tracks if t.id == track_id), None)

    def update_track_status(self, track_id: str, status: DownloadStatus, error: Optional[str] = None) -> None:
        track = self.get_track(track_id)
        if track:
            track.status = status
            track.error = error
            notify_track_status_changed()

    def remove_track(self, track_id: str) -> bool:
        n = len(self.tracks)
        self.tracks = [t for t in self.tracks if t.id != track_id]
        if len(self.tracks) < n:
            notify_track_status_changed()
            return True
        return False
