"""Route-level tests for auth gates and playlist ownership."""
from __future__ import annotations

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

    def test_seed_merges_the_larger_count(self, client, logged_in) -> None:
        client.post("/api/play-log", json={"playlist_id": "p1", "track_id": "t1"})
        client.post(
            "/api/play-log/seed",
            json={"track_plays": {"p1|t1": 5, "p1|t2": 2}, "playlist_plays": {"p1": 7}},
        )
        client.post("/api/play-log/seed", json={"track_plays": {"p1|t1": 3}})
        body = client.get("/api/play-log").json()
        assert body["track_plays"] == {"p1|t1": 5, "p1|t2": 2}
        assert body["playlist_plays"] == {"p1": 7}

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
