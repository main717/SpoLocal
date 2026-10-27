"""Unit tests for library ownership, variants, and progress reporting."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import download_service as download_service_module
from download_service import (
    DownloadService,
    _playlist_from_dict,
    _track_from_dict,
    spotify_catalog_key_from_import_url,
    spotify_track_id_from_url,
    youtube_video_id_from_url,
)
from models import DownloadStatus, Playlist, Track
from conftest import _ORIG_RESET_INTERRUPTED, _ORIG_SYNC_FROM_DOWNLOAD_FOLDERS


def make_track(
    title: str = "Song",
    artist: str = "Artist",
    *,
    status: DownloadStatus = DownloadStatus.done,
    video_id: str | None = None,
    variants: dict[str, str] | None = None,
) -> Track:
    t = Track.create(title, artist)
    t.status = status
    t.youtube_video_id = video_id
    t.media_variants = dict(variants or {})
    return t


def write_media(root: Path, relpath: str, data: bytes = b"audio") -> Path:
    path = root / "downloads" / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class TestUrlParsing:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "playlist:37i9dQZF1DXcBWIGoYBM5M"),
            ("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc", "playlist:37i9dQZF1DXcBWIGoYBM5M"),
            ("https://open.spotify.com/album/abc123", "album:abc123"),
            ("https://open.spotify.com/track/abc123", "track:abc123"),
            ("https://example.com/playlist/abc", None),
            ("", None),
        ],
    )
    def test_catalog_key(self, raw: str, expected) -> None:
        assert spotify_catalog_key_from_import_url(raw) == expected

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("spotify:track:abc123", "abc123"),
            ("https://open.spotify.com/track/abc123?si=x", "abc123"),
            ("https://open.spotify.com/album/abc123", None),
            (None, None),
        ],
    )
    def test_spotify_track_id(self, url, expected) -> None:
        assert spotify_track_id_from_url(url) == expected

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://example.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://example.com", None),
            (None, None),
        ],
    )
    def test_youtube_video_id(self, url, expected) -> None:
        assert youtube_video_id_from_url(url) == expected


class TestDeserialization:
    def test_track_from_dict_migrates_primary_relpath(self) -> None:
        t = _track_from_dict(
            {
                "id": "t1",
                "title": "Song",
                "artist": "Artist",
                "status": "done",
                "media_relpath": "youtube/Song [abc]__64k.webm",
            }
        )
        assert t.status == DownloadStatus.done
        assert t.media_variants == {"64": "youtube/Song [abc]__64k.webm"}

    def test_track_from_dict_defaults(self) -> None:
        t = _track_from_dict({"id": "t1", "title": "Song", "artist": "Artist"})
        assert t.status == DownloadStatus.queued
        assert t.media_variants == {}
        assert t.media_relpath is None
        assert t.album is None

    def test_playlist_from_dict(self) -> None:
        pl = _playlist_from_dict(
            {
                "id": "p1",
                "name": "Mix",
                "owner_id": "u1",
                "tracks": [{"id": "t1", "title": "Song", "artist": "Artist"}],
            }
        )
        assert pl.owner_id == "u1"
        assert len(pl.tracks) == 1


class TestOwnership:
    def test_get_playlist_for_user(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        assert service.get_playlist_for_user(pl.id, "u1") is pl
        assert service.get_playlist_for_user(pl.id, "u2") is None
        assert service.get_playlist_for_user(pl.id, None) is None

    def test_list_playlists_for_user(self, service: DownloadService) -> None:
        a = service.create_playlist("A", owner_id="u1")
        b = service.create_playlist("B", owner_id="u2")
        assert service.list_playlists_for_user("u1") == [a]
        assert service.list_playlists_for_user("u2") == [b]
        assert service.list_playlists_for_user(None) == []

    def test_liked_songs_id_for(self, service: DownloadService) -> None:
        assert service.liked_songs_id_for(None) is None
        assert service.liked_songs_id_for("u1") == "spolocal_liked_songs_u1"

    def test_ensure_liked_songs_playlist(self, service: DownloadService) -> None:
        pl = service._ensure_liked_songs_playlist("u1")
        assert pl is not None
        assert pl.id == "spolocal_liked_songs_u1"
        assert pl.owner_id == "u1"
        assert service._ensure_liked_songs_playlist("u1") is pl
        assert service._ensure_liked_songs_playlist(None) is None

    def test_claim_ownerless_playlists(self, service: DownloadService) -> None:
        unclaimed = service.create_playlist("Unclaimed")
        owned = service.create_playlist("Owned", owner_id="u2")
        legacy = Playlist(id=DownloadService.LIKED_SONGS_PLAYLIST_ID, name="Liked Songs")
        service.playlists[legacy.id] = legacy

        changed = service.claim_ownerless_playlists("u1")

        assert changed == 2
        assert unclaimed.owner_id == "u1"
        assert owned.owner_id == "u2"
        assert legacy.owner_id == "u1"
        assert legacy.id == "spolocal_liked_songs_u1"
        assert DownloadService.LIKED_SONGS_PLAYLIST_ID not in service.playlists
        assert service.playlists["spolocal_liked_songs_u1"] is legacy

    def test_claim_ownerless_is_noop_for_guest(self, service: DownloadService) -> None:
        pl = service.create_playlist("Unclaimed")
        assert service.claim_ownerless_playlists(None) == 0
        assert pl.owner_id is None

    def test_claim_ownerless_does_not_steal_owned(self, service: DownloadService) -> None:
        pl = service.create_playlist("Owned", owner_id="u2")
        assert service.claim_ownerless_playlists("u1") == 0
        assert pl.owner_id == "u2"

    def test_create_playlist_rejects_reserved_name(self, service: DownloadService) -> None:
        with pytest.raises(ValueError, match="reserved"):
            service.create_playlist("Liked Songs", owner_id="u1")

    def test_is_liked_songs_playlist(self, service: DownloadService) -> None:
        assert service.is_liked_songs_playlist("spolocal_liked_songs")
        assert service.is_liked_songs_playlist("spolocal_liked_songs_u1")
        assert not service.is_liked_songs_playlist("other")


class TestCatalogAndNav:
    def test_catalog_is_owner_scoped(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        pl.add_track(make_track("Song", "Artist"))
        service.create_playlist("Other", owner_id="u2")

        rows = service.list_playlist_catalog("u1")
        assert [r["name"] for r in rows] == ["Mine"]
        assert rows[0]["cover_tiles"] == [f"/playlists/{pl.id}/tracks/{pl.tracks[0].id}/cover"]
        assert rows[0]["system_locked"] is False

    def test_catalog_marks_liked_songs_locked(self, service: DownloadService) -> None:
        service._ensure_liked_songs_playlist("u1")
        rows = service.list_playlist_catalog("u1")
        assert rows[0]["system_locked"] is True

    def test_nav_marks_active(self, service: DownloadService) -> None:
        a = service.create_playlist("A", owner_id="u1")
        b = service.create_playlist("B", owner_id="u1")
        rows = service.list_playlist_nav(a.id, "u1")
        assert {r["id"]: r["active"] for r in rows} == {a.id: True, b.id: False}

    def test_guest_catalog_is_empty(self, service: DownloadService) -> None:
        service.create_playlist("Mine", owner_id="u1")
        assert service.list_playlist_catalog(None) == []
        assert service.list_playlist_nav(None, None) == []


class TestVariantResolution:
    def test_track_has_resolved_file_by_variant(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__64k.webm")
        t = make_track(variants={"64": "youtube/Song [abc]__64k.webm"})
        assert service._track_has_resolved_file(t, "64")
        assert not service._track_has_resolved_file(t, "192")

    def test_track_has_resolved_file_falls_back_to_primary_for_192(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "youtube/Song [abc]__192k.opus")
        t = make_track()
        t.media_relpath = "youtube/Song [abc]__192k.opus"
        assert service._track_has_resolved_file(t, "192")

    def test_track_has_resolved_file_any(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__64k.webm")
        t = make_track(variants={"64": "youtube/Song [abc]__64k.webm"})
        assert service._track_has_resolved_file(t)

    def test_missing_file_is_not_resolved(self, service: DownloadService) -> None:
        t = make_track(variants={"64": "youtube/missing__64k.webm"})
        assert not service._track_has_resolved_file(t, "64")

    def test_relpath_matches_quality_by_suffix(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__64k.webm")
        assert service._relpath_matches_quality("youtube/Song [abc]__64k.webm", "64")
        assert not service._relpath_matches_quality("youtube/Song [abc]__64k.webm", "192")

    def test_relpath_matches_quality_by_bitrate(
        self, service: DownloadService, temp_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        write_media(temp_root, "legacy.mp3")
        monkeypatch.setattr(
            download_service_module,
            "read_audio_file_stats",
            lambda p: {"bitrate_kbps": 50},
        )
        assert service._relpath_matches_quality("legacy.mp3", "64")
        assert not service._relpath_matches_quality("legacy.mp3", "192")

    def test_repair_stale_media_relpath_points_at_existing_variant(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "hard/Song__120k.mp3")
        t = make_track(variants={"120": "hard/Song__120k.mp3"})
        t.media_relpath = "hard/Song.mp3"
        assert service._repair_stale_media_relpath(t)
        assert t.media_relpath == "hard/Song__120k.mp3"

    def test_repair_stale_media_relpath_keeps_existing_primary(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "hard/Song.mp3")
        write_media(temp_root, "hard/Song__120k.mp3")
        t = make_track(variants={"120": "hard/Song__120k.mp3"})
        t.media_relpath = "hard/Song.mp3"
        assert not service._repair_stale_media_relpath(t)
        assert t.media_relpath == "hard/Song.mp3"

    def test_repair_stale_media_relpath_without_variant_is_noop(
        self, service: DownloadService
    ) -> None:
        t = make_track()
        t.media_relpath = "hard/Song.mp3"
        assert not service._repair_stale_media_relpath(t)
        assert t.media_relpath == "hard/Song.mp3"

    def test_hydrate_repairs_stale_primary_path(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "hard/Song__120k.mp3")
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track(variants={"120": "hard/Song__120k.mp3"})
        t.media_relpath = "hard/Song.mp3"
        pl.add_track(t)
        service.hydrate_media_paths(pl, persist=False)
        assert t.media_relpath == "hard/Song__120k.mp3"

    def test_clear_stale_variant(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__64k.webm")
        t = make_track(variants={"64": "youtube/Song [abc]__64k.webm", "192": "youtube/missing__192k.opus"})
        service._clear_stale_variant(t, "192")
        assert t.media_variants == {"64": "youtube/Song [abc]__64k.webm"}

    def test_clear_stale_variant_keeps_existing(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__64k.webm")
        t = make_track(variants={"64": "youtube/Song [abc]__64k.webm"})
        service._clear_stale_variant(t, "64")
        assert t.media_variants == {"64": "youtube/Song [abc]__64k.webm"}

    def test_prune_missing_variants(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__64k.webm")
        t = make_track(
            variants={
                "64": "youtube/Song [abc]__64k.webm",
                "192": "flow/Song.mp3",
            }
        )
        assert service._prune_missing_variants(t)
        assert t.media_variants == {"64": "youtube/Song [abc]__64k.webm"}

    def test_prune_missing_variants_keeps_existing(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "youtube/Song [abc]__64k.webm")
        t = make_track(variants={"64": "youtube/Song [abc]__64k.webm"})
        assert not service._prune_missing_variants(t)
        assert t.media_variants == {"64": "youtube/Song [abc]__64k.webm"}

    def test_hydrate_alias_follows_source_variants(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "youtube/Song [abc]__120k.mp3")
        write_media(temp_root, "youtube/Song [abc]__192k.opus")
        source = service.create_playlist("Mine", owner_id="u1")
        src = make_track(
            variants={
                "120": "youtube/Song [abc]__120k.mp3",
                "192": "youtube/Song [abc]__192k.opus",
            }
        )
        src.media_relpath = "youtube/Song [abc]__192k.opus"
        source.add_track(src)

        liked = service._ensure_liked_songs_playlist("u1")
        alias = make_track(
            variants={
                "120": "youtube/Song [abc]__120k.mp3",
                "192": "flow/Song.mp3",
            }
        )
        alias.media_relpath = "youtube/Song [abc]__120k.mp3"
        alias.liked_source_playlist_id = source.id
        alias.liked_source_track_id = src.id
        liked.add_track(alias)

        service.hydrate_media_paths(liked, persist=False)

        assert alias.media_variants == src.media_variants
        assert alias.media_relpath == src.media_relpath

    def test_settle_marks_queued_track_with_playable_file_done(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "hard/Song__120k.mp3")
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track(status=DownloadStatus.queued, variants={"120": "hard/Song__120k.mp3"})
        t.media_relpath = "hard/Song__120k.mp3"
        pl.add_track(t)
        service._reconcile_track_statuses()
        assert t.status == DownloadStatus.done

    def test_settle_marks_downloading_track_with_playable_file_done(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "hard/Song__120k.mp3")
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track(status=DownloadStatus.downloading, variants={"120": "hard/Song__120k.mp3"})
        pl.add_track(t)
        service._reconcile_track_statuses()
        assert t.status == DownloadStatus.done

    def test_settle_leaves_queued_track_without_file(
        self, service: DownloadService
    ) -> None:
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track(status=DownloadStatus.queued)
        pl.add_track(t)
        service._reconcile_track_statuses()
        assert t.status == DownloadStatus.queued

    def test_settle_marks_error_track_with_playable_file_done(
        self, service: DownloadService, temp_root: Path
    ) -> None:
        write_media(temp_root, "youtube/Song [abc]__120k.mp3")
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track(status=DownloadStatus.error, variants={"120": "youtube/Song [abc]__120k.mp3"})
        t.error = "No audio file found under downloads/youtube after YouTube download."
        pl.add_track(t)
        service._reconcile_track_statuses()
        assert t.status == DownloadStatus.done
        assert t.error is None

    def test_settle_leaves_error_track_without_file(
        self, service: DownloadService
    ) -> None:
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track(status=DownloadStatus.error, variants={"192": "hard/missing.mp3"})
        pl.add_track(t)
        service._reconcile_track_statuses()
        assert t.status == DownloadStatus.error

    def test_reconcile_flags_done_track_with_missing_recorded_file(
        self, service: DownloadService
    ) -> None:
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track(variants={"192": "hard/missing.mp3"})
        pl.add_track(t)
        service._reconcile_track_statuses()
        assert t.status == DownloadStatus.error

    def test_reconcile_leaves_done_track_without_recorded_media(
        self, service: DownloadService
    ) -> None:
        pl = service.create_playlist("hard", owner_id="u1")
        t = make_track()
        pl.add_track(t)
        service._reconcile_track_statuses()
        assert t.status == DownloadStatus.done

    def test_resolve_variant_relpath(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [dQw4w9WgXcQ]__64k.webm")
        write_media(temp_root, "youtube/Other [aaaaaaaaaaa]__64k.webm")
        t = make_track(video_id="dQw4w9WgXcQ")
        assert service._resolve_variant_relpath(t, "64") == "youtube/Song [dQw4w9WgXcQ]__64k.webm"

    def test_resolve_variant_relpath_missing(self, service: DownloadService) -> None:
        t = make_track(video_id="dQw4w9WgXcQ")
        assert service._resolve_variant_relpath(t, "64") is None

    def test_youtube_video_id_for_track(self, service: DownloadService) -> None:
        t = make_track(video_id="dQw4w9WgXcQ")
        assert service._youtube_video_id_for_track(t) == "dQw4w9WgXcQ"

        t2 = make_track(variants={"64": "youtube/Song [abcdefghijk]__64k.webm"})
        assert service._youtube_video_id_for_track(t2) == "abcdefghijk"

        t3 = make_track()
        t3.url = "https://youtu.be/zzzzzzzzzzz"
        assert service._youtube_video_id_for_track(t3) == "zzzzzzzzzzz"


class TestLibraryMatches:
    def test_matches_by_video_id(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", video_id="dQw4w9WgXcQ")
        pl.add_track(t)
        rows = service.library_matches_for_hit("dQw4w9WgXcQ", "", "", "u1")
        assert [r["track_id"] for r in rows] == [t.id]

    def test_matches_by_title_and_artist(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("  Song  ", "Artist")
        pl.add_track(t)
        rows = service.library_matches_for_hit("", "song", "artist", "u1")
        assert [r["track_id"] for r in rows] == [t.id]

    def test_is_owner_scoped(self, service: DownloadService) -> None:
        mine = service.create_playlist("Mine", owner_id="u1")
        mine.add_track(make_track("Song", "Artist", video_id="dQw4w9WgXcQ"))
        other = service.create_playlist("Other", owner_id="u2")
        other.add_track(make_track("Song", "Artist", video_id="dQw4w9WgXcQ"))

        assert len(service.library_matches_for_hit("dQw4w9WgXcQ", "", "", "u1")) == 1
        assert len(service.library_matches_for_hit("dQw4w9WgXcQ", "", "", "u2")) == 1
        assert service.library_matches_for_hit("dQw4w9WgXcQ", "", "", None) == []

    def test_find_canonical_downloaded_source(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [dQw4w9WgXcQ]__192k.opus")
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", video_id="dQw4w9WgXcQ")
        t.media_relpath = "youtube/Song [dQw4w9WgXcQ]__192k.opus"
        pl.add_track(t)

        assert service.find_canonical_downloaded_source("u1", "dQw4w9WgXcQ", "", "") == (pl.id, t.id)
        assert service.find_canonical_downloaded_source("u1", "dQw4w9WgXcQ", "", "", exclude_playlist_id=pl.id) is None


class TestPlaylistsForTrack:
    def test_lists_every_playlist_with_the_song(self, service: DownloadService) -> None:
        mine = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", video_id="dQw4w9WgXcQ")
        mine.add_track(t)
        also = service.create_playlist("Also", owner_id="u1")
        also.add_track(make_track("Song", "Artist", video_id="dQw4w9WgXcQ"))
        service.create_playlist("Other", owner_id="u1")

        rows = service.playlists_for_track(mine.id, t.id, "u1")
        assert [r["name"] for r in rows] == ["Also", "Mine"]
        assert [r["current"] for r in rows] == [False, True]

    def test_matches_by_title_and_artist(self, service: DownloadService) -> None:
        mine = service.create_playlist("Mine", owner_id="u1")
        t = make_track("  Song  ", "Artist")
        mine.add_track(t)
        also = service.create_playlist("Also", owner_id="u1")
        also.add_track(make_track("song", "artist"))

        assert [r["id"] for r in service.playlists_for_track(mine.id, t.id, "u1")] == [also.id, mine.id]

    def test_matches_by_shared_audio_file(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/a.opus")
        mine = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", variants={"192": "youtube/a.opus"})
        mine.add_track(t)
        also = service.create_playlist("Also", owner_id="u1")
        alias = make_track("Renamed", "Other", variants={"192": "youtube/a.opus"})
        also.add_track(alias)

        assert [r["id"] for r in service.playlists_for_track(mine.id, t.id, "u1")] == [also.id, mine.id]

    def test_is_owner_scoped(self, service: DownloadService) -> None:
        mine = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", video_id="dQw4w9WgXcQ")
        mine.add_track(t)
        other = service.create_playlist("Other", owner_id="u2")
        other.add_track(make_track("Song", "Artist", video_id="dQw4w9WgXcQ"))

        assert [r["id"] for r in service.playlists_for_track(mine.id, t.id, "u1")] == [mine.id]
        assert service.playlists_for_track(mine.id, t.id, None) == []

    def test_unknown_playlist_or_track_returns_empty(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track()
        pl.add_track(t)
        assert service.playlists_for_track("missing", t.id, "u1") == []
        assert service.playlists_for_track(pl.id, "missing", "u1") == []

    def test_track_info_includes_playlists(self, service: DownloadService) -> None:
        mine = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", video_id="dQw4w9WgXcQ")
        mine.add_track(t)
        also = service.create_playlist("Also", owner_id="u1")
        also.add_track(make_track("Song", "Artist", video_id="dQw4w9WgXcQ"))

        info = service.get_track_info(mine.id, t.id, "u1")
        assert [p["id"] for p in info["playlists"]] == [also.id, mine.id]


class TestLikedSongs:
    def test_like_requires_downloaded_file(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", status=DownloadStatus.pending)
        pl.add_track(t)
        assert service.set_track_liked(pl.id, t.id, True, "u1") is False

    def test_like_and_unlike(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__192k.opus")
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", variants={"192": "youtube/Song [abc]__192k.opus"})
        pl.add_track(t)

        assert service.set_track_liked(pl.id, t.id, True, "u1") is True
        liked = service._ensure_liked_songs_playlist("u1")
        assert len(liked.tracks) == 1
        assert liked.tracks[0].liked_source_playlist_id == pl.id
        assert liked.tracks[0].liked_source_track_id == t.id

        # Idempotent
        assert service.set_track_liked(pl.id, t.id, True, "u1") is True
        assert len(liked.tracks) == 1

        assert service.set_track_liked(pl.id, t.id, False, "u1") is True
        assert liked.tracks == []

    def test_liked_keys(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [abc]__192k.opus")
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", variants={"192": "youtube/Song [abc]__192k.opus"})
        pl.add_track(t)
        service.set_track_liked(pl.id, t.id, True, "u1")
        assert service.list_liked_entry_keys("u1") == [f"{pl.id}|{t.id}"]
        assert service.list_liked_entry_keys(None) == []

    def test_add_song_directly_downloads_and_dedupes(self, service: DownloadService) -> None:
        first = service.add_track_to_liked_songs(
            "Fresh Song",
            "Artist",
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            owner_id="u1",
            download_quality="64",
        )
        assert first is not None
        liked = service._ensure_liked_songs_playlist("u1")
        assert [t.id for t in liked.tracks] == [first.id]
        assert first.status == DownloadStatus.queued
        assert first.liked_source_playlist_id is None
        assert (first.id, "64") in service._pending_job_keys

        again = service.add_track_to_liked_songs(
            "Fresh Song",
            "Artist",
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            owner_id="u1",
        )
        assert again is first
        assert len(liked.tracks) == 1

    def test_add_song_links_an_existing_library_copy(self, service: DownloadService, temp_root: Path) -> None:
        write_media(temp_root, "youtube/Song [dQw4w9WgXcQ]__192k.opus")
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track(
            "Song",
            "Artist",
            video_id="dQw4w9WgXcQ",
            variants={"192": "youtube/Song [dQw4w9WgXcQ]__192k.opus"},
        )
        pl.add_track(t)

        liked_track = service.add_track_to_liked_songs(
            "Song", "Artist", video_id="dQw4w9WgXcQ", owner_id="u1"
        )
        assert liked_track is not None
        assert liked_track.liked_source_playlist_id == pl.id
        assert liked_track.liked_source_track_id == t.id
        assert service.list_liked_entry_keys("u1") == [f"{pl.id}|{t.id}"]

    def test_add_song_needs_an_account(self, service: DownloadService) -> None:
        assert service.add_track_to_liked_songs("Song", "Artist") is None


class TestDelete:
    def test_delete_track_removes_file(self, service: DownloadService, temp_root: Path) -> None:
        path = write_media(temp_root, "youtube/Song [abc]__192k.opus")
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", variants={"192": "youtube/Song [abc]__192k.opus"})
        t.media_relpath = "youtube/Song [abc]__192k.opus"
        pl.add_track(t)

        assert service.delete_track(pl.id, t.id) is True
        assert pl.tracks == []
        assert not path.exists()

    def test_delete_track_keeps_file_when_asked(self, service: DownloadService, temp_root: Path) -> None:
        path = write_media(temp_root, "youtube/Song [abc]__192k.opus")
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("Song", "Artist", variants={"192": "youtube/Song [abc]__192k.opus"})
        t.media_relpath = "youtube/Song [abc]__192k.opus"
        pl.add_track(t)

        assert service.delete_track(pl.id, t.id, unlink_media=False) is True
        assert path.exists()


class TestProgress:
    def test_downloads_remaining_counts_queued(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        pl.add_track(make_track("A", "B", status=DownloadStatus.queued))
        pl.add_track(make_track("C", "D", status=DownloadStatus.downloading))
        pl.add_track(make_track("E", "F", status=DownloadStatus.done))
        assert service.downloads_remaining_count("u1") == 2
        assert service.downloads_remaining_count(None) == 0

    def test_progress_payload_filters_jobs_by_owner(self, service: DownloadService) -> None:
        mine = service.create_playlist("Mine", owner_id="u1")
        t1 = make_track("A", "B", status=DownloadStatus.downloading)
        mine.add_track(t1)
        other = service.create_playlist("Other", owner_id="u2")
        t2 = make_track("C", "D", status=DownloadStatus.downloading)
        other.add_track(t2)

        service.progress = {
            t1.id: {"title": "A", "artist": "B", "percent": 10},
            t2.id: {"title": "C", "artist": "D", "percent": 20},
        }
        payload = service.progress_api_payload("u1")
        assert list(payload["jobs"]) == [t1.id]
        assert payload["remaining"] == 1

    def test_error_rows_are_owner_scoped(self, service: DownloadService) -> None:
        mine = service.create_playlist("Mine", owner_id="u1")
        mine.add_track(make_track("A", "B", status=DownloadStatus.error))
        other = service.create_playlist("Other", owner_id="u2")
        other.add_track(make_track("C", "D", status=DownloadStatus.error))

        service._invalidate_error_rows_cache()
        assert [r["title"] for r in service.error_tracks_for_sidebar("u1")] == ["A"]
        assert [r["title"] for r in service.error_tracks_for_sidebar("u2")] == ["C"]
        assert service.error_tracks_for_sidebar(None) == []

    def test_queue_all_quality_downloads_counts(self, service: DownloadService, temp_root: Path, monkeypatch) -> None:
        write_media(temp_root, "youtube/A [aaaaaaaaaaa]__64k.webm")
        pl = service.create_playlist("Mine", owner_id="u1")
        have = make_track("A", "B", video_id="aaaaaaaaaaa", variants={"64": "youtube/A [aaaaaaaaaaa]__64k.webm"})
        need = make_track("C", "D", video_id="bbbbbbbbbbb")
        no_source = make_track("", "")
        no_source.url = None
        no_source.youtube_video_id = None
        pl.add_track(have)
        pl.add_track(need)
        pl.add_track(no_source)

        monkeypatch.setattr(service, "start_track_download", lambda *a, **k: True)
        result = service.queue_all_quality_downloads("64", "u1")
        assert result["queued"] == 1
        assert result["already_have"] == 1
        assert result["ineligible"] == 1
        assert result["quality"] == "64"


class TestStartupHelpers:
    def test_sync_from_download_folders(self, service: DownloadService, temp_root: Path) -> None:
        folder = temp_root / "downloads" / "My Folder"
        folder.mkdir()
        (folder / "Artist - Song.mp3").write_bytes(b"audio")

        _ORIG_SYNC_FROM_DOWNLOAD_FOLDERS(service)

        pl = next(p for p in service.playlists.values() if p.name == "My Folder")
        assert len(pl.tracks) == 1
        assert pl.tracks[0].artist == "Artist"
        assert pl.tracks[0].title == "Song"
        assert pl.tracks[0].status == DownloadStatus.done
        assert pl.tracks[0].media_relpath == "My Folder/Artist - Song.mp3"

    def test_sync_skips_youtube_folder(self, service: DownloadService, temp_root: Path) -> None:
        (temp_root / "downloads" / "youtube" / "x.mp3").write_bytes(b"audio")
        _ORIG_SYNC_FROM_DOWNLOAD_FOLDERS(service)
        assert all(pl.name != "youtube" for pl in service.playlists.values())

    def test_reset_interrupted_downloads(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mine", owner_id="u1")
        t = make_track("A", "B", status=DownloadStatus.downloading)
        pl.add_track(t)
        _ORIG_RESET_INTERRUPTED(service)
        assert t.status == DownloadStatus.queued


class TestShareToken:
    def test_playlist_from_dict_keeps_share_token(self) -> None:
        pl = _playlist_from_dict({"id": "p1", "name": "Mix", "share_token": "tok123"})
        assert pl.share_token == "tok123"

    def test_share_token_round_trips_through_disk(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mix", owner_id="u1")
        service.set_playlist_share_token(pl.id, "tok123")
        assert service.get_playlist_by_share_token("tok123") is pl
        reloaded = _playlist_from_dict(
            json.loads(service._data_file().read_text(encoding="utf-8"))[pl.id]
        )
        assert reloaded.share_token == "tok123"

    def test_revoked_token_is_gone(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mix", owner_id="u1")
        service.set_playlist_share_token(pl.id, "tok123")
        service.set_playlist_share_token(pl.id, None)
        assert service.get_playlist_by_share_token("tok123") is None
        assert service.get_playlist_by_share_token("") is None


class TestLoudnessOffset:
    def test_defaults_to_neutral(self) -> None:
        track = _track_from_dict({"id": "t1", "title": "Song", "artist": "Artist"})
        assert track.loudness_offset_db == 0.0

    def test_track_scope_only_touches_that_track(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mix", owner_id="u1")
        a = Track.create("A", "Artist")
        a.album = "Album"
        b = Track.create("B", "Artist")
        b.album = "Album"
        pl.add_track(a)
        pl.add_track(b)
        service.set_loudness_offset(pl.id, a.id, 3.0, "track")
        assert a.loudness_offset_db == 3.0
        assert b.loudness_offset_db == 0.0

    def test_album_scope_updates_the_whole_album(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mix", owner_id="u1")
        a = Track.create("A", "Artist")
        a.album = "Album"
        b = Track.create("B", "Artist")
        b.album = "album"
        c = Track.create("C", "Artist")
        c.album = "Other"
        for t in (a, b, c):
            pl.add_track(t)
        result = service.set_loudness_offset(pl.id, a.id, -2.5, "album")
        assert result == {"offset_db": -2.5, "updated": [a.id, b.id]}
        assert c.loudness_offset_db == 0.0

    def test_offset_round_trips_through_disk(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mix", owner_id="u1")
        track = Track.create("Song", "Artist")
        pl.add_track(track)
        service.set_loudness_offset(pl.id, track.id, 4.5, "track")
        reloaded = _playlist_from_dict(
            json.loads(service._data_file().read_text(encoding="utf-8"))[pl.id]
        )
        assert reloaded.tracks[0].loudness_offset_db == 4.5

    def test_unknown_track_returns_none(self, service: DownloadService) -> None:
        pl = service.create_playlist("Mix", owner_id="u1")
        assert service.set_loudness_offset(pl.id, "nope", 1.0) is None


class TestWorkerCount:
    def test_set_worker_count_clamps_persists_and_reports(
        self, service: DownloadService, temp_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(service, "_spawn_workers", lambda n: None)
        assert service.set_worker_count(4) == 4
        assert service.worker_count() == 4
        settings_file = temp_root / "webapp_settings.json"
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {"download_workers": 4}

        assert service.set_worker_count(99) == 8
        assert service.set_worker_count(0) == 1
        assert json.loads(settings_file.read_text(encoding="utf-8"))["download_workers"] == 1

    def test_saved_count_survives_a_restart(
        self, service: DownloadService, temp_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(service, "_spawn_workers", lambda n: None)
        service.set_worker_count(5)
        monkeypatch.setattr(DownloadService, "_spawn_workers", lambda self, n: None)
        restarted = DownloadService(temp_root)
        assert restarted.worker_count() == 5

    def test_missing_settings_file_falls_back_to_the_worker_count(self, service: DownloadService) -> None:
        # conftest pins the environment default to 0, so nothing is spawned in tests.
        assert service.worker_count() == 0
