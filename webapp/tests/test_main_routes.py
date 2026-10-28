"""Route-level tests for auth gates and playlist ownership."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from models import DownloadStatus, Track


def make_playlist(service, name: str, owner_id: str, *, tracks: int = 0):
    pl = service.create_playlist(name, owner_id=owner_id)
    for i in range(tracks):
        t = Track.create(f"Song {i}", "Artist")
        t.status = DownloadStatus.done
        pl.add_track(t)
    return pl


class TestGuestAccess:
    def test_me_is_guest(self, client) -> None:
        assert client.get("/api/auth/me").json() == {"user": None}

    def test_catalog_is_empty(self, client) -> None:
        assert client.get("/api/playlists/catalog").json() == []

    def test_playlist_state_requires_login(self, client, service) -> None:
        pl = make_playlist(service, "Mine", "u1")
        assert client.get(f"/api/playlist/state?playlist_id={pl.id}").status_code == 401

    def test_playlist_view_requires_login(self, client, service) -> None:
        pl = make_playlist(service, "Mine", "u1")
        assert client.get(f"/api/playlist/view?playlist_id={pl.id}").status_code == 401

    def test_media_requires_login(self, client) -> None:
        assert client.get("/media/youtube/x.webm").status_code == 401

    def test_like_requires_login(self, client) -> None:
        resp = client.post(
            "/api/track/like",
            json={"source_playlist_id": "p", "source_track_id": "t", "liked": True},
        )
        assert resp.status_code == 401

    def test_progress_is_public_but_empty(self, client) -> None:
        payload = client.get("/api/progress").json()
        assert payload["jobs"] == {}
        assert payload["remaining"] == 0
        assert payload["errors"] == []

    def test_recommendations_require_login(self, client, service) -> None:
        pl = make_playlist(service, "Mine", "u1")
        assert client.get(f"/api/playlist/recommendations?playlist_id={pl.id}").status_code == 401


class TestStreamLoudness:
    def test_cached_gain_is_returned(self, client, main_module, monkeypatch) -> None:
        monkeypatch.setattr(main_module.streaming, "stream_loudness_gain", lambda vid: -7.5)
        resp = client.get("/api/stream/loudness-gain?vid=84ZtV9qMQe0")
        assert resp.status_code == 200
        assert resp.json() == {"loudness_gain_db": -7.5}

    def test_missing_gain_starts_measurement(self, client, main_module, monkeypatch) -> None:
        monkeypatch.setattr(main_module.streaming, "stream_loudness_gain", lambda vid: None)

        async def fake_ensure(vid):
            return None

        monkeypatch.setattr(main_module.streaming, "ensure_stream_loudness_gain", fake_ensure)
        resp = client.get("/api/stream/loudness-gain?vid=84ZtV9qMQe0")
        assert resp.status_code == 200
        assert resp.json() == {"loudness_gain_db": None, "pending": True}

    def test_invalid_vid_is_400(self, client) -> None:
        assert client.get("/api/stream/loudness-gain?vid=bad!id").status_code == 400


class TestAuthRoutes:
    def test_register_sets_cookie(self, client) -> None:
        resp = client.post("/api/auth/register", json={"username": "alice", "password": "long enough"})
        assert resp.status_code == 200
        assert resp.json()["user"]["username"] == "alice"
        assert "spolocal_session" in resp.cookies

    def test_register_duplicate_is_400(self, client) -> None:
        client.post("/api/auth/register", json={"username": "alice", "password": "long enough"})
        resp = client.post("/api/auth/register", json={"username": "alice", "password": "long enough"})
        assert resp.status_code == 400

    def test_login_and_logout(self, client) -> None:
        client.post("/api/auth/register", json={"username": "alice", "password": "long enough"})
        client.post("/api/auth/logout")
        assert client.get("/api/auth/me").json() == {"user": None}

        resp = client.post("/api/auth/login", json={"username": "alice", "password": "long enough"})
        assert resp.status_code == 200
        assert client.get("/api/auth/me").json()["user"]["username"] == "alice"

        client.post("/api/auth/logout")
        assert client.get("/api/auth/me").json() == {"user": None}

    def test_login_wrong_password_is_400(self, client) -> None:
        client.post("/api/auth/register", json={"username": "alice", "password": "long enough"})
        client.post("/api/auth/logout")
        resp = client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})
        assert resp.status_code == 400

    def test_me_returns_public_user(self, client) -> None:
        client.post("/api/auth/register", json={"username": "alice", "password": "long enough"})
        user = client.get("/api/auth/me").json()["user"]
        assert user["username"] == "alice"
        assert "password_hash" not in user


class TestPlayLog:
    def test_guest_reads_empty_state(self, client) -> None:
        assert client.get("/api/play-log").json() == {
            "authenticated": False,
            "track_plays": {},
            "playlist_plays": {},
            "day_plays": {},
            "track_day_plays": {},
        }

    def test_guest_writes_are_ignored(self, client) -> None:
        assert client.post(
            "/api/play-log", json={"playlist_id": "p", "track_id": "t"}
        ).json() == {"ok": False, "stored": False}
        assert client.post(
            "/api/play-log/seed", json={"track_plays": {"p|t": 2}}
        ).json() == {"ok": False, "seeded": False}

    def test_record_counts_for_the_account(self, client, logged_in) -> None:
        client.post("/api/play-log", json={"playlist_id": "p1", "track_id": "t1"})
        client.post("/api/play-log", json={"playlist_id": "p1", "track_id": "t1"})
        body = client.get("/api/play-log").json()
        assert body["authenticated"] is True
        assert body["track_plays"] == {"p1|t1": 2}
        assert body["playlist_plays"] == {"p1": 2}
        assert sum(body["day_plays"].values()) == 2
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        assert body["track_day_plays"] == {f"{day}|p1|t1": 2}

    def test_seed_merges_the_larger_count(self, client, logged_in) -> None:
        client.post("/api/play-log", json={"playlist_id": "p1", "track_id": "t1"})
        client.post(
            "/api/play-log/seed",
            json={
                "track_plays": {"p1|t1": 5, "p1|t2": 2},
                "playlist_plays": {"p1": 7},
                "track_day_plays": {"2026-01-01|p1|t1": 4},
            },
        )
        client.post("/api/play-log/seed", json={"track_plays": {"p1|t1": 3}})
        body = client.get("/api/play-log").json()
        assert body["track_plays"] == {"p1|t1": 5, "p1|t2": 2}
        assert body["playlist_plays"] == {"p1": 7}
        assert body["track_day_plays"]["2026-01-01|p1|t1"] == 4

    def test_counts_are_per_account(self, client, accounts) -> None:
        client.post("/api/auth/register", json={"username": "first", "password": "long enough"})
        client.post("/api/play-log", json={"playlist_id": "p1", "track_id": "t1"})
        client.post("/api/auth/logout")
        client.post("/api/auth/register", json={"username": "second", "password": "long enough"})
        body = client.get("/api/play-log").json()
        assert body["authenticated"] is True
        assert body["track_plays"] == {}


class TestCreatePlaylistWithTrack:
    def test_creates_playlist_and_queues_download(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        resp = client.post(
            "/api/playlists",
            json={
                "name": "Fresh",
                "title": "Song",
                "artist": "Artist",
                "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "quality": "64",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        pl = service.get_playlist_for_user(body["playlist"]["id"], user_id)
        assert pl is not None
        assert [t.title for t in pl.tracks] == ["Song"]
        track = pl.tracks[0]
        assert track.status == DownloadStatus.queued
        assert (track.id, "64") in service._pending_job_keys
        assert body["track"]["id"] == track.id

    def test_video_id_is_used_when_url_is_missing(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        resp = client.post(
            "/api/playlists",
            json={"name": "Fresh", "title": "Song", "artist": "Artist", "video_id": "dQw4w9WgXcQ"},
        )
        assert resp.status_code == 200, resp.text
        pl = service.get_playlist_for_user(resp.json()["playlist"]["id"], user_id)
        assert pl.tracks[0].youtube_video_id == "dQw4w9WgXcQ"
        assert (pl.tracks[0].id, "192") in service._pending_job_keys

    def test_plain_create_still_works(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        resp = client.post("/api/playlists", json={"name": "Empty"})
        assert resp.status_code == 200
        assert resp.json()["track"] is None
        pl = service.get_playlist_for_user(resp.json()["playlist"]["id"], user_id)
        assert pl.tracks == []


class TestLikedSongsAdd:
    def test_requires_login(self, client) -> None:
        resp = client.post("/api/liked-songs/add", json={"title": "Song", "artist": "Artist"})
        assert resp.status_code == 401

    def test_saves_a_song_without_a_playlist(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        resp = client.post(
            "/api/liked-songs/add",
            json={
                "title": "Song",
                "artist": "Artist",
                "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "quality": "64",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        liked = service._ensure_liked_songs_playlist(user_id)
        assert liked is not None
        assert [t.title for t in liked.tracks] == ["Song"]
        assert body["playlist_id"] == liked.id
        assert body["track"]["id"] == liked.tracks[0].id
        assert (liked.tracks[0].id, "64") in service._pending_job_keys

    def test_blank_title_is_rejected(self, client, logged_in) -> None:
        resp = client.post("/api/liked-songs/add", json={"title": "   "})
        assert resp.status_code == 400


class TestCoverTier:
    def test_data_saver_catalog_uses_youtube_thumbs(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        pl.tracks[0].youtube_video_id = "dQw4w9WgXcQ"
        client.cookies.set("spolocal_playback_kbps", "64")
        rows = client.get("/api/playlists/catalog").json()
        assert rows[0]["cover_tiles"] == ["/api/thumb?vid=dQw4w9WgXcQ&q=low"]

    def test_highest_catalog_uses_local_covers(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        pl.tracks[0].youtube_video_id = "dQw4w9WgXcQ"
        client.cookies.set("spolocal_playback_kbps", "192")
        rows = client.get("/api/playlists/catalog").json()
        assert rows[0]["cover_tiles"] == [f"/playlists/{pl.id}/tracks/{pl.tracks[0].id}/cover"]

    def test_data_saver_view_html_uses_youtube_thumbs(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        pl.tracks[0].youtube_video_id = "dQw4w9WgXcQ"
        client.cookies.set("spolocal_playback_kbps", "64")
        html = client.get(f"/api/playlist/view?playlist_id={pl.id}").json()["html"]
        assert "/api/thumb?vid=dQw4w9WgXcQ&q=low" in html

    def test_index_renders_playlist_with_data_saver_cookie(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        pl.tracks[0].youtube_video_id = "dQw4w9WgXcQ"
        client.cookies.set("spolocal_playback_kbps", "64")
        resp = client.get(f"/?playlist_id={pl.id}")
        assert resp.status_code == 200
        assert "/api/thumb?vid=dQw4w9WgXcQ&q=low" in resp.text


class TestOwnership:
    def test_catalog_only_lists_own_playlists(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        make_playlist(service, "Mine", user_id)
        make_playlist(service, "Other", "someone-else")

        names = [row["name"] for row in client.get("/api/playlists/catalog").json()]
        assert names == ["Mine"]

    def test_playlist_state_owner(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=2)
        resp = client.get(f"/api/playlist/state?playlist_id={pl.id}")
        assert resp.status_code == 200
        assert len(resp.json()["tracks_payload"]) == 2

    def test_playlist_state_non_owner_is_404(self, client, service, logged_in) -> None:
        make_playlist(service, "Other", "someone-else")
        other = next(pl for pl in service.playlists.values() if pl.name == "Other")
        assert client.get(f"/api/playlist/state?playlist_id={other.id}").status_code == 404

    def test_playlist_view_owner_returns_html(self, client, service, logged_in) -> None:
        """Regression: api_playlist_view used an undefined uid and returned 500."""
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        resp = client.get(f"/api/playlist/view?playlist_id={pl.id}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["playlist_id"] == pl.id
        assert len(body["tracks_payload"]) == 1
        assert "<html" in body["html"].lower() or "playlist" in body["html"].lower()

    def test_playlist_view_non_owner_is_404(self, client, service, logged_in) -> None:
        make_playlist(service, "Other", "someone-else")
        other = next(pl for pl in service.playlists.values() if pl.name == "Other")
        assert client.get(f"/api/playlist/view?playlist_id={other.id}").status_code == 404

    def test_track_info_owner(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        tid = pl.tracks[0].id
        resp = client.get(f"/api/playlists/{pl.id}/tracks/{tid}/info")
        assert resp.status_code == 200
        assert resp.json()["title"] == "Song 0"

    def test_track_info_lists_playlists_with_the_song(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        mine = make_playlist(service, "Mine", user_id, tracks=1)
        make_playlist(service, "Also", user_id, tracks=1)
        make_playlist(service, "Other", user_id)
        tid = mine.tracks[0].id
        resp = client.get(f"/api/playlists/{mine.id}/tracks/{tid}/info")
        assert resp.status_code == 200
        playlists = resp.json()["playlists"]
        assert [p["name"] for p in playlists] == ["Also", "Mine"]
        assert [p["current"] for p in playlists] == [False, True]

    def test_track_info_non_owner_is_404(self, client, service, logged_in) -> None:
        other = make_playlist(service, "Other", "someone-else", tracks=1)
        tid = other.tracks[0].id
        assert client.get(f"/api/playlists/{other.id}/tracks/{tid}/info").status_code == 404

    def test_track_info_guest_is_401(self, client, service) -> None:
        pl = make_playlist(service, "Mine", "u1", tracks=1)
        tid = pl.tracks[0].id
        assert client.get(f"/api/playlists/{pl.id}/tracks/{tid}/info").status_code == 401

    def test_delete_track_redirects_by_default(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=2)
        tid = pl.tracks[0].id
        resp = client.post(f"/playlists/{pl.id}/tracks/{tid}/delete", follow_redirects=False)
        assert resp.status_code == 303
        assert resp.headers["location"] == f"/?playlist_id={pl.id}"
        assert len(service.playlists[pl.id].tracks) == 1

    def test_delete_track_spa_request_returns_204(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=2)
        tid = pl.tracks[0].id
        resp = client.post(
            f"/playlists/{pl.id}/tracks/{tid}/delete",
            headers={"X-Spa-Request": "1"},
        )
        assert resp.status_code == 204
        assert len(service.playlists[pl.id].tracks) == 1

    def test_cover_route_is_gated(self, client, service, logged_in) -> None:
        other = make_playlist(service, "Other", "someone-else", tracks=1)
        tid = other.tracks[0].id
        assert client.get(f"/playlists/{other.id}/tracks/{tid}/cover").status_code == 404

    def test_lyrics_route_is_gated(self, client, service, logged_in) -> None:
        other = make_playlist(service, "Other", "someone-else", tracks=1)
        tid = other.tracks[0].id
        assert client.get(f"/playlists/{other.id}/tracks/{tid}/lyrics").status_code == 404

    def test_media_serves_owned_file(self, client, service, temp_root: Path, monkeypatch, main_module) -> None:
        from media_server import MediaServer

        monkeypatch.setattr(main_module, "media_server", MediaServer(temp_root / "downloads", temp_root))
        path = temp_root / "downloads" / "youtube" / "song.webm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"0123456789")

        client.post("/api/auth/register", json={"username": "alice", "password": "long enough"})
        resp = client.get("/media/youtube/song.webm")
        assert resp.status_code == 200
        assert resp.content == b"0123456789"


class TestSearchScoping:
    def test_guest_search_has_no_library_matches(
        self, client, service, monkeypatch, main_module
    ) -> None:
        pl = make_playlist(service, "Mine", "u1", tracks=1)
        pl.tracks[0].youtube_video_id = "dQw4w9WgXcQ"

        monkeypatch.setattr(
            main_module,
            "search_youtube_tracks",
            lambda root, q, limit: [
                {"video_id": "dQw4w9WgXcQ", "title": "Song 0", "artist": "Artist", "channel": "Artist"}
            ],
        )

        async def noop(hits):
            return None

        monkeypatch.setattr(main_module.streaming, "annotate_search_stream_src", noop)
        main_module._search_cache.clear()

        resp = client.get("/api/search/songs?q=song")
        assert resp.status_code == 200
        assert resp.json()["hits"][0]["library_matches"] == []

    def test_owner_search_has_library_matches(
        self, client, service, logged_in, monkeypatch, main_module
    ) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        pl.tracks[0].youtube_video_id = "dQw4w9WgXcQ"

        monkeypatch.setattr(
            main_module,
            "search_youtube_tracks",
            lambda root, q, limit: [
                {"video_id": "dQw4w9WgXcQ", "title": "Song 0", "artist": "Artist", "channel": "Artist"}
            ],
        )

        async def noop(hits):
            return None

        monkeypatch.setattr(main_module.streaming, "annotate_search_stream_src", noop)
        main_module._search_cache.clear()

        resp = client.get("/api/search/songs?q=song")
        assert resp.status_code == 200
        matches = resp.json()["hits"][0]["library_matches"]
        assert [m["track_id"] for m in matches] == [pl.tracks[0].id]


class TestPlaylistRecommendations:
    def test_passes_playlist_artists_to_seed_picker(
        self, client, service, logged_in, monkeypatch, main_module
    ) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=3)
        for i, track in enumerate(pl.tracks):
            track.youtube_video_id = f"vid{i:08d}"
            track.artist = f"Artist {i}"

        seen: dict = {}

        class FakeMix:
            def __init__(self, root=None) -> None:
                pass

            def pick_seed_ids(self, video_ids, max_seeds=None, artists=None):
                seen["pick_artists"] = list(artists or [])
                return [v for v in video_ids if v]

            def mix_for_seeds(self, video_ids, limit=12, artists=None):
                seen["mix_artists"] = list(artists or [])
                return [{"video_id": "dQw4w9WgXcQ", "title": "T", "artist": "A", "channel": "A"}]

        async def noop(hits):
            return None

        async def noop_prefetch(ids):
            return None

        monkeypatch.setattr(main_module, "YoutubePlaylistMix", FakeMix)
        monkeypatch.setattr(main_module.streaming, "annotate_search_stream_src", noop)
        monkeypatch.setattr(main_module.streaming, "prefetch_mix_stream_payloads", noop_prefetch)
        main_module._recommendation_cache.clear()

        resp = client.get(f"/api/playlist/recommendations?playlist_id={pl.id}&limit=12")
        assert resp.status_code == 200
        assert [h["video_id"] for h in resp.json()] == ["dQw4w9WgXcQ"]
        assert seen["pick_artists"] == ["Artist 0", "Artist 1", "Artist 2"]
        assert seen["mix_artists"] == ["Artist 0", "Artist 1", "Artist 2"]


class TestStorage:
    def test_reports_media_size_and_disk_space(self, client, temp_root, monkeypatch, main_module) -> None:
        media = temp_root / "downloads" / "youtube"
        media.mkdir(parents=True, exist_ok=True)
        (media / "a__64k.webm").write_bytes(b"x" * 100)
        (media / "a__192k.opus").write_bytes(b"y" * 50)
        (media / "a__64k.lrc").write_bytes(b"z" * 10)
        main_module._storage_cache["payload"] = None
        payload = client.get("/api/storage").json()
        assert payload["media_bytes"] == 160
        assert payload["media_files"] == 3
        assert payload["by_quality"]["64"] == 110
        assert payload["by_quality"]["192"] == 50
        assert payload["free_bytes"] > 0
        assert payload["total_bytes"] >= payload["free_bytes"]

    def test_is_cached_for_a_minute(self, client, temp_root, main_module) -> None:
        main_module._storage_cache["payload"] = None
        first = client.get("/api/storage").json()
        media = temp_root / "downloads" / "youtube"
        media.mkdir(parents=True, exist_ok=True)
        (media / "b__64k.webm").write_bytes(b"x" * 999)
        second = client.get("/api/storage").json()
        assert second["media_bytes"] == first["media_bytes"]


class TestShareLink:
    def test_guest_cannot_create_a_link(self, client, service) -> None:
        pl = make_playlist(service, "Mine", "u1", tracks=1)
        assert client.post(f"/api/playlists/{pl.id}/share").status_code == 401

    def test_non_owner_cannot_create_a_link(self, client, service, logged_in) -> None:
        other = make_playlist(service, "Other", "someone-else", tracks=1)
        assert client.post(f"/api/playlists/{other.id}/share").status_code == 404

    def test_owner_gets_a_stable_token(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        first = client.post(f"/api/playlists/{pl.id}/share")
        assert first.status_code == 200, first.text
        data = first.json()
        assert data["token"]
        assert data["url"] == "/share/" + data["token"]
        second = client.post(f"/api/playlists/{pl.id}/share").json()
        assert second["token"] == data["token"]

    def test_shared_page_is_public(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=2)
        pl.tracks[0].media_relpath = "youtube/song-0__64k.webm"
        pl.tracks[1].media_relpath = "youtube/song-1__64k.webm"
        token = client.post(f"/api/playlists/{pl.id}/share").json()["token"]
        client.cookies.clear()
        resp = client.get(f"/share/{token}")
        assert resp.status_code == 200
        assert "Mine" in resp.text
        assert "Song 0" in resp.text
        assert "Song 1" in resp.text
        assert "2 songs" in resp.text
        assert f"/share/{token}/media/youtube/song-0__64k.webm" in resp.text

    def test_unknown_token_is_404(self, client) -> None:
        assert client.get("/share/nope").status_code == 404

    def test_share_media_serves_only_playlist_files(
        self, client, service, logged_in, temp_root: Path, monkeypatch, main_module
    ) -> None:
        from media_server import MediaServer

        monkeypatch.setattr(main_module, "media_server", MediaServer(temp_root / "downloads", temp_root))
        media = temp_root / "downloads" / "youtube"
        media.mkdir(parents=True, exist_ok=True)
        (media / "song__64k.webm").write_bytes(b"allowed")
        (media / "other__64k.webm").write_bytes(b"foreign")

        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        pl.tracks[0].media_relpath = "youtube/song__64k.webm"
        token = client.post(f"/api/playlists/{pl.id}/share").json()["token"]
        client.cookies.clear()

        ok = client.get(f"/share/{token}/media/youtube/song__64k.webm")
        assert ok.status_code == 200
        assert ok.content == b"allowed"
        assert client.get(f"/share/{token}/media/youtube/other__64k.webm").status_code == 404

    def test_revoked_token_is_gone(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        token = client.post(f"/api/playlists/{pl.id}/share").json()["token"]
        assert client.delete(f"/api/playlists/{pl.id}/share").status_code == 200
        assert client.get(f"/share/{token}").status_code == 404


class TestLoudnessOffset:
    def test_guest_cannot_set_an_offset(self, client, service) -> None:
        pl = make_playlist(service, "Mine", "u1", tracks=1)
        resp = client.post(
            f"/api/playlists/{pl.id}/tracks/{pl.tracks[0].id}/loudness-offset",
            json={"offset_db": 2, "scope": "track"},
        )
        assert resp.status_code == 401

    def test_track_scope_updates_only_that_song(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=2)
        pl.tracks[0].album = "Album"
        pl.tracks[1].album = "Album"
        tid = pl.tracks[0].id
        resp = client.post(
            f"/api/playlists/{pl.id}/tracks/{tid}/loudness-offset",
            json={"offset_db": 3.5, "scope": "track"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"ok": True, "offset_db": 3.5, "updated": [tid]}
        assert pl.tracks[0].loudness_offset_db == 3.5
        assert pl.tracks[1].loudness_offset_db == 0.0

    def test_album_scope_updates_every_track_of_the_album(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=2)
        pl.tracks[0].album = "Album"
        pl.tracks[1].album = "Album"
        tid = pl.tracks[0].id
        resp = client.post(
            f"/api/playlists/{pl.id}/tracks/{tid}/loudness-offset",
            json={"offset_db": -2, "scope": "album"},
        )
        assert resp.status_code == 200, resp.text
        assert sorted(resp.json()["updated"]) == sorted(t.id for t in pl.tracks)
        assert [t.loudness_offset_db for t in pl.tracks] == [-2.0, -2.0]

    def test_album_scope_without_an_album_is_400(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        resp = client.post(
            f"/api/playlists/{pl.id}/tracks/{pl.tracks[0].id}/loudness-offset",
            json={"offset_db": 1, "scope": "album"},
        )
        assert resp.status_code == 400

    def test_out_of_range_offset_is_rejected(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        resp = client.post(
            f"/api/playlists/{pl.id}/tracks/{pl.tracks[0].id}/loudness-offset",
            json={"offset_db": 40, "scope": "track"},
        )
        assert resp.status_code == 422

    def test_non_owner_gets_404(self, client, service, logged_in) -> None:
        other = make_playlist(service, "Other", "someone-else", tracks=1)
        resp = client.post(
            f"/api/playlists/{other.id}/tracks/{other.tracks[0].id}/loudness-offset",
            json={"offset_db": 1, "scope": "track"},
        )
        assert resp.status_code == 404

    def test_offset_is_exposed_in_the_track_payload(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        tid = pl.tracks[0].id
        client.post(
            f"/api/playlists/{pl.id}/tracks/{tid}/loudness-offset",
            json={"offset_db": 2.5, "scope": "track"},
        )
        rows = client.get(f"/api/playlist/state?playlist_id={pl.id}").json()["tracks_payload"]
        assert rows[0]["loudness_offset_db"] == 2.5

    def test_gain_endpoint_reports_the_offset(self, client, service, logged_in) -> None:
        _, user_id = logged_in
        pl = make_playlist(service, "Mine", user_id, tracks=1)
        tid = pl.tracks[0].id
        pl.tracks[0].loudness_gain_db = -7.0
        client.post(
            f"/api/playlists/{pl.id}/tracks/{tid}/loudness-offset",
            json={"offset_db": 1.5, "scope": "track"},
        )
        body = client.get(f"/api/playlists/{pl.id}/tracks/{tid}/loudness-gain").json()
        assert body == {"loudness_gain_db": -7.0, "loudness_offset_db": 1.5}


class TestDownloadWorkers:
    def test_requires_login(self, client) -> None:
        assert client.get("/api/settings/download-workers").status_code == 401
        assert client.post("/api/settings/download-workers", json={"workers": 3}).status_code == 401

    def test_get_reports_the_current_count(self, client, service, logged_in, monkeypatch) -> None:
        monkeypatch.setattr(service, "_spawn_workers", lambda n: None)
        service.set_worker_count(3)
        body = client.get("/api/settings/download-workers").json()
        assert body["workers"] == 3
        assert body["hardware"]["cpu_cores"] >= 1
        assert 1 <= body["hardware"]["recommended_max"] <= 8

    def test_post_updates_and_persists(self, client, service, logged_in, monkeypatch) -> None:
        monkeypatch.setattr(service, "_spawn_workers", lambda n: None)
        resp = client.post("/api/settings/download-workers", json={"workers": 6})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"workers": 6}
        assert service.worker_count() == 6
        assert client.get("/api/settings/download-workers").json()["workers"] == 6

    @pytest.mark.parametrize("workers", [0, 9])
    def test_out_of_range_is_rejected(self, client, logged_in, workers) -> None:
        resp = client.post("/api/settings/download-workers", json={"workers": workers})
        assert resp.status_code == 422


class TestDownloadHardware:
    def test_recommendation_leaves_a_core_free(self, main_module, monkeypatch) -> None:
        monkeypatch.setattr(main_module.os, "cpu_count", lambda: 4)
        monkeypatch.setattr(main_module.os, "getloadavg", lambda: (0.2, 0.2, 0.2))
        hw = main_module._download_hardware()
        assert hw["cpu_cores"] == 4
        assert hw["recommended_max"] == 3

    def test_high_load_lowers_the_recommendation(self, main_module, monkeypatch) -> None:
        monkeypatch.setattr(main_module.os, "cpu_count", lambda: 4)
        monkeypatch.setattr(main_module.os, "getloadavg", lambda: (4.0, 4.0, 4.0))
        assert main_module._download_hardware()["recommended_max"] == 2

    def test_single_core_never_recommends_zero(self, main_module, monkeypatch) -> None:
        monkeypatch.setattr(main_module.os, "cpu_count", lambda: 1)
        monkeypatch.setattr(main_module.os, "getloadavg", lambda: (5.0, 5.0, 5.0))
        assert main_module._download_hardware()["recommended_max"] == 1
