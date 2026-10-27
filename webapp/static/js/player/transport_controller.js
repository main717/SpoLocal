/**
 * Controller owning all transport concerns for the playlist page.
 */
import { PlaylistPlayLog } from '../playlist/play_log.js?v=2';

/** Maximum number of songs the mix queue keeps ahead of the current one. */
const MIX_WINDOW_SIZE = 50;

function mix_entry_key(entry) {
    return entry.kind === 'track' ? 'track:' + String(entry.id) : 'rec:' + String(entry.video_id);
}

export class PlaylistTransportController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./queue_controller.js').PlaylistQueueController|null} */
        this.queue = null;
        /** @type {import('./lyrics_controller.js').PlaylistLyricsController|null} */
        this.lyrics = null;
        /** @type {import('../playlist/home_view_controller.js').PlaylistHomeViewController|null} */
        this.home = null;
        /** @type {import('./like_controller.js').PlaylistLikeController|null} */
        this.likes = null;
        /** @type {import('./shuffle_controller.js').PlaylistShuffleController|null} */
        this.shuffle = null;
        /** @type {import('./media_session_controller.js').PlaylistMediaSessionController|null} */
        this.mediaSession = null;
        /** @type {import('./playback_quality_controller.js').PlaybackQualityController|null} */
        this.quality = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this.stallRecoveryTimer = null;
    }

    /** Set cross-controller references after all controllers are created. */
    setCrossRefs(queue, lyrics, home, likes, shuffle, mediaSession, quality) {
        this.queue = queue;
        this.lyrics = lyrics;
        this.home = home;
        this.likes = likes;
        this.shuffle = shuffle;
        this.mediaSession = mediaSession;
        this.quality = quality;
    }

    /** Wire up transport-related event listeners and load preferences. */
    init() {
        const hub = this.state.hub;
        if (!hub) return;

        // Avoid double-binding
        if (hub._transport_controller_bound) return;
        hub._transport_controller_bound = true;

        this.loadTransportPrefs();
        if (typeof this.load_volume_pref === 'function') this.load_volume_pref();
        // Which list the current playback belongs to: 'playlist', 'library'
        // (home / most played) or 'recs' (recommendations / radio mix).
        hub.playbackContext = 'playlist';

        document.addEventListener('keydown', (e) => this.on_space_play_pause(e));

        // Seek wiring
        if (hub.seek) {
            hub.seek.addEventListener('pointerdown', () => {
                hub.seeking = true;
            });
            hub.seek.addEventListener('input', () => {
                hub.seeking = true;
                if (hub.audio.duration) {
                    hub.timeEl.textContent = this.fmt(Math.floor((parseFloat(hub.seek.value) / 1000) * hub.audio.duration));
                }
                this.sync_seek_buffer_ui();
                if (this.lyrics) this.lyrics.sync_stream_video_clock(true);
            });
            hub.seek.addEventListener('change', () => {
                this.seek_to_time_from_slider();
                if (this.lyrics) this.lyrics.sync_stream_video_clock(true);
            });
        }

        // Volume wiring
        if (hub.volumeEl) {
            hub.volumeEl.addEventListener('input', () => {
                const v = parseFloat(hub.volumeEl.value) / 100;
                const norm = hub.audioNormalization;
                if (norm) norm.set_user_volume(v);
                else hub.audio.volume = v;
                this.update_volume_icon();
                this.persist_volume();
            });
        }

        // Play/Pause controls
        if (hub.btnMainPlay) hub.btnMainPlay.addEventListener('click', () => this.toggle_main_play());
        if (hub.btnPrev) hub.btnPrev.addEventListener('click', () => {
            try { console.debug('[PlaylistTransport] Prev clicked'); } catch (e) {}
            this.playAtDelta(-1);
        });
        if (hub.btnNext) hub.btnNext.addEventListener('click', () => {
            try { console.debug('[PlaylistTransport] Next clicked'); } catch (e) {}
            this.playAtDelta(1);
        });

        // Shuffle/Repeat
        if (hub.btnShuffle) hub.btnShuffle.addEventListener('click', () => {
            const mode = hub.shuffleMode || (hub.shuffleOn ? 'shuffle' : 'off');
            if (mode === 'off') hub.shuffleMode = 'shuffle';
            else if (mode === 'shuffle') hub.shuffleMode = 'mix';
            else hub.shuffleMode = 'off';
            hub.shuffleOn = hub.shuffleMode !== 'off';
            this.shuffle.persistShuffle();
            if (hub.shuffleOn && hub.playable.length) this.shuffle.rebuildShuffledOrder();
            this.shuffle.updateShuffleRepeatUi();
            if (hub.shuffleMode === 'mix') this.ensure_mix_recommendations();
        });
        if (hub.btnRepeat) hub.btnRepeat.addEventListener('click', () => {
            if (hub.repeatMode === 'off') hub.repeatMode = 'all';
            else if (hub.repeatMode === 'all') hub.repeatMode = 'one';
            else hub.repeatMode = 'off';
            this.shuffle.persistRepeat();
            this.shuffle.updateShuffleRepeatUi();
        });

        // Like wiring
        this.likes.attach_like_click_handler(hub.btnLike);
        this.likes.attach_like_click_handler(hub.btnLikeMobile);

        // Audio element events
        hub.audio.addEventListener('play', () => {
            this.setPlayUi(true);
            this.mediaSession.updateMediaSessionPlaybackState();
        });
        hub.audio.addEventListener('playing', (event) => {
            hub._mediaDecodeRetries = 0;
            this.record_playback_start(event);
        });
        hub.audio.addEventListener('pause', () => {
            if (this.stallRecoveryTimer) {
                clearTimeout(this.stallRecoveryTimer);
                this.stallRecoveryTimer = null;
            }
            this.setPlayUi(false);
            this.mediaSession.persistPlaybackProgress();
            this.mediaSession.updateMediaSessionPlaybackState();
        });
        hub.audio.addEventListener('ended', () => {
            if (window.SpolocalMse && window.SpolocalMse.is_active()) return;
            if (this.isSearchStreamPlayback()) {
                this.advance_search_stream();
                return;
            }
            this.playAtDelta(1);
        });
        hub.audio.addEventListener('seeked', () => {
            hub.seeking = false;
            this.mediaSession.persistPlaybackProgress();
            if (hub.lastLyricsPayload.lrc_data && hub.lyricsVisible && hub.lyricsMode === 'read' && this.lyrics) {
                this.lyrics.updateLyricsActiveLine();
            }
        });
        hub.audio.addEventListener('error', (event) => this.handleAudioElementError(event));

        hub.audio.addEventListener('loadstart', (event) => {
            hub._audioLoadStartTimestamp = event.timeStamp;
            this.release_stream_cache_for_src();
        });

        hub.audio.addEventListener('stalled', () => this.scheduleStallRecoveryIfStillHung());
        hub.audio.addEventListener('waiting', () => this.scheduleStallRecoveryIfStillHung());

        // A download re-render rebuilds the recs table; snapshot the fresh list
        // and keep the playing rec marked.
        window.addEventListener('spolocal:mix-recommendations-rendered', () => {
            this.mix_rec_entries();
            this.updatePlayingRow();
        });

        document.addEventListener('visibilitychange', () => this.handleVisibilityForBackgroundPlayback());
        window.addEventListener('pageshow', (ev) => {
            if (!ev.persisted) return;
            const h = this.state.hub;
            if (h && h.audio && h.audio.src && !h.audio.ended) {
                h.audio.play().catch(() => {});
            }
            this.mediaSession.updateMediaSessionPlaybackState();
        });

        hub.audio.addEventListener('timeupdate', () => {
            const isUserInteracting = hub.seeking;
            if (!isUserInteracting && hub.audio.duration) {
                hub.seek.value = String(Math.floor((hub.audio.currentTime / hub.audio.duration) * 1000));
            }
            hub.timeEl.textContent = this.fmt(hub.audio.currentTime);
            if (!hub.persistThrottle) {
                hub.persistThrottle = setTimeout(() => {
                    hub.persistThrottle = null;
                    this.mediaSession.persistPlaybackProgress();
                }, 2000);
            }
            if (!hub.mediaSessionPositionThrottle && navigator.mediaSession && navigator.mediaSession.setPositionState && hub.audio.duration) {
                hub.mediaSessionPositionThrottle = setTimeout(() => {
                    hub.mediaSessionPositionThrottle = null;
                    try {
                        navigator.mediaSession.setPositionState({
                            duration: hub.audio.duration,
                            playbackRate: hub.audio.playbackRate || 1,
                            position: hub.audio.currentTime || 0
                        });
                    } catch (e) {}
                }, 1000);
            }
            if (!hub.lyricsActiveLineThrottle && hub.lastLyricsPayload.lrc_data && hub.lastLyricsPayload.lrc_data.length && hub.lyricsVisible && hub.lyricsMode === 'read' && this.lyrics) {
                hub.lyricsActiveLineThrottle = setTimeout(() => {
                    hub.lyricsActiveLineThrottle = null;
                    this.lyrics.updateLyricsActiveLine();
                }, 100);
            }
            this.sync_seek_buffer_ui();
            if (this.lyrics) this.lyrics.sync_stream_video_clock();
        });

        hub.audio.addEventListener('progress', () => this.sync_seek_buffer_ui());
        hub.audio.addEventListener('loadedmetadata', () => this.sync_seek_buffer_ui());
        hub.audio.addEventListener('emptied', () => this.sync_seek_buffer_ui());

        hub.audio.addEventListener('durationchange', () => {
            hub.durEl.textContent = this.fmt(hub.audio.duration);
        });
        hub.audio.addEventListener('loadedmetadata', () => {
            hub.durEl.textContent = this.fmt(hub.audio.duration);
        });

        // Media Session
        this.mediaSession.initMediaSessionHandlers();

        hub._mediaDecodeRetries = 0;

        // Global row clicks
        document.body.addEventListener('click', (e) => {
            const homeRow = e.target.closest('.home-song-row');
            if (homeRow && !e.target.closest('.track-row-like')) {
                const entry = this.library_entry_from_row(homeRow);
                if (entry) void this.playLibraryEntry(entry);
                return;
            }
            const playBtn = e.target.closest('.track-play');
            if (playBtn && !playBtn.disabled) {
                const row = playBtn.closest('tr.track-row');
                if (!row) return;
                const id = row.getAttribute('data-track-id');
                const src = row.getAttribute('data-play-src');
                if (!id || !src) return;
                this.playTrackById(id);
                return;
            }
            const row = e.target.closest('tr.track-row.track-row--playable');
            if (!row) return;
            if (e.target.closest('a, button, input, select, textarea, label')) return;
            const id = row.getAttribute('data-track-id');
            const src = row.getAttribute('data-play-src');
            if (!id || !src) return;
            this.playTrackById(id);
        });

        // Header play
        document.body.addEventListener('click', (e) => {
            const headerPlayBtn = e.target.closest('#playlist-header-play');
            if (headerPlayBtn) {
                e.preventDefault();
                this.handle_playlist_header_play();
            }
        });
    }

    loadTransportPrefs() {
        const hub = this.state.hub;
        try {
            const s = localStorage.getItem(hub.LS_SHUFFLE);
            hub.shuffleMode = (s === 'mix' || s === 'shuffle') ? s : (s === 'true' ? 'shuffle' : 'off');
            hub.shuffleOn = hub.shuffleMode !== 'off';
            const r = localStorage.getItem(hub.LS_REPEAT);
            hub.repeatMode = (r === 'all' || r === 'one') ? r : 'off';
            if (hub.shuffleOn) this.shuffle.restore_shuffle_order_from_storage();
            this.shuffle.updateShuffleRepeatUi();
            if (hub.shuffleMode === 'mix') this.ensure_mix_recommendations();
        } catch (e) {}
    }

    load_volume_pref() {
        const hub = this.state.hub;
        const norm = hub.audioNormalization;
        try {
            const s = localStorage.getItem(hub.LS_VOLUME);
            if (s != null && hub.volumeEl) {
                const n = Math.max(0, Math.min(1, parseFloat(s)));
                if (Number.isFinite(n)) {
                    if (norm) norm.set_user_volume(n);
                    else hub.audio.volume = n;
                    hub.volumeEl.value = String(Math.round(n * 100));
                }
            }
        } catch (e) {}
        this.update_volume_icon();
    }

    persist_volume() {
        const hub = this.state.hub;
        const norm = hub.audioNormalization;
        const v = norm ? norm.get_user_volume() : hub.audio.volume;
        try { localStorage.setItem(hub.LS_VOLUME, String(v)); } catch (e) {}
    }

    update_volume_icon() {
        const hub = this.state.hub;
        if (!hub.volumeIconEl) return;
        const norm = hub.audioNormalization;
        const v = norm ? norm.get_user_volume() : hub.audio.volume;
        hub.volumeIconEl.className =
            'fa-solid text-xs shrink-0 w-4 text-center ' +
            (v === 0 ? 'fa-volume-xmark' : v < 0.45 ? 'fa-volume-low' : 'fa-volume-high');
    }

    /** Library entries that can actually be played, from the pool or a given list. */
    library_pool_playable(list) {
        const prefs = window.SpolocalQualityPrefs;
        const pool = Array.isArray(list) ? list : this.state.hub.libraryPool;
        return (Array.isArray(pool) ? pool : []).filter((t) => {
            if (!t) return false;
            const src = prefs ? prefs.resolvePlaySrc(t) : t.play_src;
            return !!src;
        });
    }

    /** Entry described by a home song row. */
    library_entry_from_row(row) {
        const entry = {
            playlist_id: row.getAttribute('data-playlist-id') || '',
            track_id: row.getAttribute('data-track-id') || '',
            play_src: row.getAttribute('data-play-src') || '',
            title: row.getAttribute('data-title') || '',
            artist: row.getAttribute('data-artist') || '',
            album: row.getAttribute('data-album') || '',
        };
        return entry.playlist_id && entry.track_id && entry.play_src ? entry : null;
    }

    /** Restart the current track (repeat one, or prev at the start of a list). */
    restart_current() {
        const hub = this.state.hub;
        if (!hub.audio) return;
        hub.audio.currentTime = 0;
        hub.audio.play().catch((err) => this.handlePlayError(err));
    }

    /** Stop at the end of a list when repeat is off. */
    stop_playback() {
        const hub = this.state.hub;
        if (hub.audio) hub.audio.pause();
    }

    /** Wrap an index into [0, length) for repeat all. */
    wrap_index(index, length) {
        return ((index % length) + length) % length;
    }

    pick_random_library_entry(exclude_track_id) {
        const pool = this.library_pool_playable();
        if (!pool.length) return null;
        if (pool.length === 1) return pool[0];
        let tries = 0;
        while (tries < 8) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (!exclude_track_id || String(pick.track_id) !== String(exclude_track_id)) return pick;
            tries++;
        }
        return pool[Math.floor(Math.random() * pool.length)];
    }

    play_random_from_library() {
        const entry = this.pick_random_library_entry(null);
        if (entry) void this.playLibraryEntry(entry);
    }

    /** Random next track from the library; prev restarts the current one. */
    play_random_library_next(delta) {
        const hub = this.state.hub;
        if (delta <= 0) {
            if (hub.currentTrackId) this.restart_current();
            return;
        }
        const next = this.pick_random_library_entry(hub.repeatMode === 'off' ? hub.currentTrackId : null);
        if (next) void this.playLibraryEntry(next, 'library');
        else this.stop_playback();
    }

    async playLibraryEntry(entry, context) {
        const hub = this.state.hub;
        if (!hub.audio || !entry) return;
        const trackId = String(entry.track_id || '');
        const playlistId = String(entry.playlist_id || '');
        if (!trackId || !playlistId) return;
        hub.playbackContext = context === 'recs' ? 'recs' : 'library';
        const prefs = window.SpolocalQualityPrefs;

        if (hub.currentTrackId === trackId && hub.playingPlaylistId === playlistId && hub.audio.src) {
            if (hub.audio.paused) hub.audio.play().catch((err) => this.handlePlayError(err));
            else hub.audio.pause();
            this.likes.update_like_button_ui();
            return;
        }

        let packed = Object.assign({}, entry);
        let preliminarySrc = prefs ? prefs.resolvePlaySrc(packed) : (packed.play_src || '');
        if (!preliminarySrc || (prefs && !prefs.normalizeMediaPath(preliminarySrc))) {
            const row = await this.quality.fetchTrackPayload(playlistId, trackId);
            if (row) {
                this.quality.patchTrackInHub(row);
                packed = Object.assign({}, packed, row, { playlist_id: playlistId, track_id: trackId });
                preliminarySrc = prefs ? prefs.resolvePlaySrc(packed) : (packed.play_src || '');
            }
        }
        if (!preliminarySrc) {
            if (hub.subEl) hub.subEl.textContent = 'Track unavailable.';
            this.setPlayUi(false);
            return;
        }

        this.leave_search_stream();

        this._playGeneration = (this._playGeneration || 0) + 1;
        const playGen = this._playGeneration;
        const playback_q = prefs ? String(prefs.playbackKbps()) : '192';

        let t = {
            id: trackId,
            title: packed.title || '',
            artist: packed.artist || '',
            album: packed.album || '',
            play_src: packed.play_src,
            play_variants: packed.play_variants || {},
            url: packed.url || '',
            youtube_video_id: packed.youtube_video_id || '',
        };

        hub.titleEl.textContent = t.title || '—';
        hub.subEl.textContent = t.artist || '—';

        if (prefs && !prefs.hasVariant(t, playback_q)) {
            const ready = await this.quality.ensurePlaybackVariantReady(t, playlistId, trackId, playback_q, playGen, prefs.streamFitsTier(playback_q));
            if (playGen !== this._playGeneration) return;
            const row = await this.quality.fetchTrackPayload(playlistId, trackId);
            if (row) {
                this.quality.patchTrackInHub(row);
                t = Object.assign({}, t, row, { id: trackId });
            }
            // Not ready and nothing to play at this tier: stop rather than quietly
            // falling back to the stream, which is best-quality audio.
            if (!ready && !prefs.hasVariant(t, playback_q) && !prefs.streamFitsTier(playback_q)) {
                if (hub.subEl) {
                    hub.subEl.textContent = 'Not downloaded at ' + prefs.formatLabel(playback_q) + '.';
                }
                this.setPlayUi(false);
                return;
            }
        }

        const playSrc = prefs
            ? (prefs.resolveExactPlaySrc(t, playback_q) || prefs.resolvePlaybackPlaySrc(t, playback_q))
            : (t.play_src || preliminarySrc);
        if (!playSrc) return;

        if (hub.pendingRestoreOnMeta) {
            hub.audio.removeEventListener('loadedmetadata', hub.pendingRestoreOnMeta);
            hub.pendingRestoreOnMeta = null;
        }

        hub.playingPlaylistId = playlistId;
        hub.playingTracks = [{
            id: trackId,
            title: t.title || entry.title || '',
            artist: t.artist || entry.artist || '',
            album: t.album || entry.album || '',
            play_src: playSrc,
            play_variants: t.play_variants || entry.play_variants || {},
            url: t.url || entry.url || '',
            youtube_video_id: t.youtube_video_id || entry.youtube_video_id || '',
        }];
        hub.playingPlayable = hub.playingTracks.slice();
        hub.currentTrackId = trackId;
        hub.lastPlayedTrackSnapshot = {
            id: trackId,
            title: t.title || entry.title || '',
            artist: t.artist || entry.artist || '',
            album: (t.album != null ? String(t.album) : entry.album) || '',
            url: (t.url || entry.url || '').trim(),
            youtube_video_id: (t.youtube_video_id || entry.youtube_video_id || '').trim(),
            source_playlist_id: playlistId,
        };
        const mse_handled = this._attach_playback_source(playSrc, () => this.playAtDelta(1));
        hub.titleEl.textContent = t.title || entry.title || '—';
        hub.subEl.textContent = t.artist || entry.artist || '—';
        void this.quality.apply_track_loudness(t, playlistId);
        if (this.lyrics) this.lyrics.loadCover(trackId, playlistId);
        this.updatePlayingRow();
        if (!mse_handled) hub.audio.play().catch((err) => this.handlePlayError(err));
        if (hub.lyricsVisible && this.lyrics) this.lyrics.fetchLyrics(true);
        this.mediaSession.updateMediaSessionMetadata(hub.playingTracks[0], playlistId);
        this.likes.update_like_button_ui();
        if (hub.queueVisible && this.queue) this.queue.render_queue_list();
    }

    playAtDeltaRandomMode(delta) {
        const hub = this.state.hub;
        if (hub.repeatMode === 'one' && delta > 0 && hub.currentTrackId) this.restart_current();
        else this.play_random_library_next(delta);
        return true;
    }

    sync_seek_buffer_ui() {
        const hub = this.state.hub;
        const host = hub.seekLoadedEl;
        const audio = hub.audio;
        if (!host || !audio) return;
        const duration = audio.duration;
        let played_pct = 0;
        if (duration && isFinite(duration) && duration > 0) {
            played_pct = Math.min(100, Math.max(0, (audio.currentTime / duration) * 100));
        } else if (hub.seek) {
            played_pct = Math.min(100, Math.max(0, parseFloat(hub.seek.value) / 10));
        }
        let n = 0;
        if (duration && isFinite(duration) && duration > 0) {
            try {
                n = audio.buffered.length;
            } catch (e) {
                n = 0;
            }
        }
        while (host.children.length > n + 1) {
            host.removeChild(host.lastChild);
        }
        while (host.children.length < n + 1) {
            host.appendChild(document.createElement('div'));
        }
        for (let i = 0; i < n; i++) {
            const el = host.children[i];
            el.className = 'player-seek-buf';
            const start = (audio.buffered.start(i) / duration) * 100;
            const end = (audio.buffered.end(i) / duration) * 100;
            el.style.left = start + '%';
            el.style.width = Math.max(0, end - start) + '%';
        }
        const played = host.children[n];
        played.className = 'player-seek-played';
        played.style.left = '0';
        played.style.width = played_pct + '%';
    }

    seek_audio_to(t) {
        const hub = this.state.hub;
        if (window.SpolocalMse && window.SpolocalMse.is_active()) {
            window.SpolocalMse.seek_to(t);
            return;
        }
        if (hub.audio) hub.audio.currentTime = t;
    }

    seek_to_time_from_slider() {
        const hub = this.state.hub;
        const dur = hub.audio && hub.audio.duration;
        if (!dur) return;
        const t = (parseFloat(hub.seek.value) / 1000) * dur;
        if (window.SpolocalMse && window.SpolocalMse.is_active()) {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                hub.seeking = false;
            };
            window.SpolocalMse.seek_to(t, finish);
            setTimeout(finish, 2500);
        } else {
            hub.audio.currentTime = t;
        }
        if (this.lyrics) this.lyrics.sync_stream_video_clock(true);
    }

    space_is_typing_target(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (el.isContentEditable) return true;
        if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) return true;
        return false;
    }

    on_space_play_pause(e) {
        if (e.key !== ' ' && e.key !== 'Spacebar' && e.code !== 'Space') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.repeat) return;
        if (this.space_is_typing_target(e.target)) return;
        e.preventDefault();
        this.toggle_main_play();
    }

    toggle_main_play() {
        const hub = this.state.hub;
        if (this.isSearchStreamPlayback() && hub.searchStreamHit) {
            if (window.SpolocalMse && window.SpolocalMse.is_active()) {
                if (hub.audio.paused) hub.audio.play().catch(err => this.handlePlayError(err));
                else hub.audio.pause();
                return;
            }
            const vid = String(hub.searchStreamHit.video_id || '').trim();
            const want = typeof window.spolocalStreamSrc === 'function'
                ? window.spolocalStreamSrc(vid)
                : '/api/stream?vid=' + encodeURIComponent(vid);
            const cur = String(hub.audio.currentSrc || hub.audio.src || '');
            if (vid && want && cur.indexOf('vid=' + vid) === -1) {
                hub.audio.src = want;
            }
            if (hub.audio.paused) {
                hub.audio.play().catch(err => this.handlePlayError(err));
            } else {
                hub.audio.pause();
            }
            return;
        }
        if (!hub.audio.src) {
            if (hub.randomMode && this.library_pool_playable().length) {
                this.play_random_from_library();
                return;
            }
            if (hub.playable.length) {
                this.playTrackById(hub.playable[0].id);
            }
            return;
        }
        if (hub.audio.paused) {
            hub.audio.play().catch(err => this.handlePlayError(err));
        } else {
            hub.audio.pause();
        }
    }

    playAtDelta(delta) {
        const hub = this.state.hub;
        try { console.debug('[Playlist] playAtDelta', { delta: delta, current: hub.currentTrackId }); } catch (e) {}
        if (hub.shuffleMode === 'mix' && !hub.randomMode && hub.playbackContext !== 'library') {
            this.playAtDeltaMix(delta);
            return;
        }
        if (this.isSearchStreamPlayback() || hub.playbackContext === 'recs') {
            this.skip_rec_or_mix_row(delta);
            return;
        }
        if (hub.randomMode && this.library_pool_playable().length) {
            this.playAtDeltaRandomMode(delta);
            return;
        }
        if (hub.playbackContext === 'library') {
            this.playAtDeltaLibrary(delta);
            return;
        }
        if (hub.repeatMode === 'one' && delta > 0 && hub.currentTrackId) {
            this.restart_current();
            return;
        }

        if (delta > 0 && hub.manual_up_next_queue.length > 0 && this.queue) {
            const nextEnt = hub.manual_up_next_queue.shift();
            this.queue.persist_manual_queue_state();
            this.queue.play_track_from_queue_entry(nextEnt);
            return;
        }

        if (!hub.playable.length) return;

        const curInPl = hub.playable.some(function (t) { return t.id === hub.currentTrackId; });
        if (!curInPl) {
            if (delta > 0) {
                if (this.queue) {
                    this.queue.play_next_from_resume_anchor();
                }
                return;
            }
            if (delta < 0) {
                if (hub.resume_anchor_track_id && hub.playable.some(function (t) { return t.id === hub.resume_anchor_track_id; })) {
                    this.playTrackById(hub.resume_anchor_track_id);
                } else {
                    this.playAtDeltaPlaylistBody(delta);
                }
                return;
            }
        }

        this.playAtDeltaPlaylistBody(delta);
    }

    /** Playback order for library context: the visible ranking, else the whole pool. */
    library_playback_entries() {
        const visible = this.library_pool_playable(this.state.hub.libraryOrder);
        return visible.length ? visible : this.library_pool_playable();
    }

    /** Index of the playing track inside the library pool, or -1. */
    library_entry_index(pool) {
        const hub = this.state.hub;
        const tid = String(hub.currentTrackId || '');
        if (!tid) return -1;
        const pid = String(hub.playingPlaylistId || '');
        const exact = pool.findIndex((t) => String(t.track_id) === tid && String(t.playlist_id) === pid);
        if (exact >= 0) return exact;
        return pool.findIndex((t) => String(t.track_id) === tid);
    }

    /** Advance inside the library pool (home / most played), honouring repeat and shuffle. */
    playAtDeltaLibrary(delta) {
        const hub = this.state.hub;
        if (hub.shuffleOn) {
            this.play_random_library_next(delta);
            return;
        }
        const pool = this.library_playback_entries();
        if (!pool.length) return this.stop_playback();
        if (hub.repeatMode === 'one' && delta > 0) return this.restart_current();
        let idx = this.library_entry_index(pool);
        if (idx < 0) idx = delta > 0 ? -1 : 0;
        const next_idx = idx + delta;
        const next = hub.repeatMode === 'all'
            ? pool[this.wrap_index(next_idx, pool.length)]
            : (next_idx >= 0 && next_idx < pool.length ? pool[next_idx] : null);
        if (!next) return this.stop_playback();
        void this.playLibraryEntry(next, 'library');
    }

    playAtDeltaPlaylistBody(delta) {
        const hub = this.state.hub;
        if (!hub.playable.length) return;

        if (hub.shuffleOn) {
            this.shuffle.syncShuffleOrderWithPlaylist();
            if (!hub.shuffledOrder.length) this.shuffle.rebuildShuffledOrder();
            const n = hub.shuffledOrder.length;
            if (!n) return;
            let idx = hub.currentTrackId ? hub.shuffledOrder.indexOf(hub.currentTrackId) : -1;
            if (idx < 0) idx = delta > 0 ? -1 : 0;
            const next_idx = idx + delta;
            if (hub.repeatMode === 'all') {
                this.playTrackById(hub.shuffledOrder[this.wrap_index(next_idx, n)]);
                return;
            }
            if (delta > 0 && idx === n - 1) return this.stop_playback();
            const target = next_idx >= 0 && next_idx < n ? next_idx : n - 1;
            this.playTrackById(hub.shuffledOrder[target]);
            return;
        }

        const n = hub.playable.length;
        let idx = hub.playable.findIndex((t) => t.id === hub.currentTrackId);
        if (idx < 0) idx = delta > 0 ? -1 : 0;
        if (delta > 0 && hub.repeatMode === 'off' && idx === n - 1) return this.stop_playback();
        const next_idx = idx + delta;
        const target = hub.repeatMode === 'all'
            ? this.wrap_index(next_idx, n)
            : (next_idx >= 0 && next_idx < n ? next_idx : n - 1);
        this.playTrackById(hub.playable[target].id);
    }

    /** Recommendation rows currently rendered for the viewed playlist. */
    read_rec_rows(table_id) {
        const rows = [];
        const table = document.getElementById(table_id || 'playlist-recommendations-table');
        if (!table) return rows;
        table.querySelectorAll('tr.track-row[data-youtube-video-id]').forEach((r) => {
            const vid = String(r.getAttribute('data-youtube-video-id') || '').trim();
            if (!vid) return;
            rows.push({
                kind: 'rec',
                video_id: vid,
                title: r.getAttribute('data-title') || '',
                artist: r.getAttribute('data-artist') || '',
            });
        });
        return rows;
    }

    /** Rows currently rendered on the Song Mix page. */
    song_mix_entries() {
        return this.read_rec_rows('song-mix-table');
    }

    /**
     * Recommendations for the mix. A download re-render wipes the table, so fall
     * back to the last list seen for this playlist and keep the playing rec in
     * the pool even when a fresh list no longer offers it.
     */
    mix_rec_entries() {
        const hub = this.state.hub;
        const pid = String(hub.playlistId || '');
        const live = this.read_rec_rows();
        const snapshot = (hub.mixRecsPid === pid && Array.isArray(hub.mixRecs)) ? hub.mixRecs : [];
        const base = live.length ? live : snapshot;
        const merged = this.with_playing_rec(base, snapshot);
        if (live.length) {
            hub.mixRecs = merged;
            hub.mixRecsPid = pid;
        }
        return merged;
    }

    /** Append the playing recommendation when the list no longer contains it. */
    with_playing_rec(entries, snapshot) {
        const hub = this.state.hub;
        if (hub.playbackContext !== 'recs') return entries;
        const vid = this.current_stream_vid();
        if (!vid || entries.some((e) => e.video_id === vid)) return entries;
        const playing = snapshot.find((e) => e.video_id === vid);
        return playing ? entries.concat([playing]) : entries;
    }

    /** Every playlist track plus every recommendation, with a cache signature. */
    mix_pool() {
        const hub = this.state.hub;
        if (hub.songMixView) {
            // The Song Mix page is its own pool: its rows only, never the
            // playlist tracks or the playlist's recommendation snapshot.
            const recs = this.song_mix_entries();
            const sig = 'song-mix::' + recs.map((r) => r.video_id).join('|');
            return { pool: recs, sig };
        }
        const tracks = hub.playable || [];
        const recs = this.mix_rec_entries();
        const sig = tracks.map((t) => String(t.id)).join('|')
            + '::' + recs.map((r) => r.video_id).join('|');
        const pool = tracks.map((t) => ({ kind: 'track', id: t.id })).concat(recs);
        return { pool, sig };
    }

    /**
     * The live mix window: the current entry plus up to 49 upcoming ones.
     * Rebuilt when the playlist or the recommendations change.
     */
    mix_order() {
        const hub = this.state.hub;
        const { pool, sig } = this.mix_pool();
        if (hub.mixOrder && hub.mixOrderSig === sig) return hub.mixOrder;

        const cycle = pool.slice();
        if (this.shuffle) this.shuffle.shuffleArrayInPlace(cycle);

        hub.mixCycle = cycle;
        hub.mixCycleIdx = Math.min(MIX_WINDOW_SIZE, cycle.length);
        hub.mixOrder = cycle.slice(0, MIX_WINDOW_SIZE);
        hub.mixOrderSig = sig;
        return hub.mixOrder;
    }

    /** Index of the playing item inside the mix order, or -1. */
    mix_current_index(order) {
        const hub = this.state.hub;
        if (hub.playbackContext === 'recs') {
            const vid = this.current_stream_vid();
            if (vid) {
                const i = order.findIndex((e) => e.kind === 'rec' && e.video_id === vid);
                if (i >= 0) return i;
            }
        }
        const tid = String(hub.currentTrackId || '');
        if (!tid) return -1;
        return order.findIndex((e) => e.kind === 'track' && String(e.id) === tid);
    }

    current_stream_vid() {
        const hub = this.state.hub;
        const from_hit = hub.searchStreamHit ? String(hub.searchStreamHit.video_id || '').trim() : '';
        if (from_hit) return from_hit;
        return this.stream_vid_from_src(hub.audio && (hub.audio.currentSrc || hub.audio.src));
    }

    rec_row_for_video(vid) {
        if (!vid) return null;
        const rows = this.rec_or_mix_rows();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-youtube-video-id') === vid) return rows[i];
        }
        return null;
    }

    play_mix_entry(entry) {
        if (!entry) return false;
        if (entry.kind === 'track') {
            void this.playTrackById(entry.id);
            return true;
        }
        const row = this.rec_row_for_video(entry.video_id);
        if (row) return this.play_rec_or_mix_row(row);
        if (typeof window.playPreview === 'function') {
            window.playPreview({
                video_id: entry.video_id,
                title: entry.title || '',
                artist: entry.artist || '',
                channel: entry.artist || '',
            }, null);
            return true;
        }
        return false;
    }

    /** Advance through the playlist + recommendations mix, one rolling window. */
    playAtDeltaMix(delta) {
        const hub = this.state.hub;
        let order = this.mix_order();
        if (!order.length) {
            this.stop_playback();
            return;
        }
        if (!hub.songMixView && !order.some((e) => e.kind === 'rec')) this.ensure_mix_recommendations();
        let idx = this.mix_current_index(order);
        if (delta > 0 && idx >= 0) {
            this.advance_mix_window(order[idx]);
            order = this.mix_order();
            idx = -1;
        }
        if (idx < 0) idx = delta > 0 ? -1 : 0;
        const target = order[this.wrap_index(idx + delta, order.length)];
        if (!this.play_mix_entry(target)) this.stop_playback();
        this.prefetch_next_loudness();
    }

    /** Measure the upcoming stream while the current track plays. */
    prefetch_next_loudness() {
        if (!this.quality) return;
        const order = this.mix_order();
        const idx = this.mix_current_index(order);
        if (idx < 0) return;
        const next = order[this.wrap_index(idx + 1, order.length)];
        if (!next || next.kind !== 'rec') return;
        this.quality.prefetch_stream_loudness(next.video_id);
    }

    /**
     * Drop the finished entry (and anything skipped before it), then top the
     * window back up to MIX_WINDOW_SIZE. Small pools play through and refill.
     */
    advance_mix_window(finished_entry) {
        const hub = this.state.hub;
        const window = hub.mixOrder || [];
        const idx = window.indexOf(finished_entry);
        if (idx >= 0) window.splice(0, idx + 1);

        const pool = this.mix_pool().pool;
        if (pool.length <= MIX_WINDOW_SIZE) {
            if (!window.length) {
                const cycle = pool.slice();
                if (this.shuffle) this.shuffle.shuffleArrayInPlace(cycle);
                // A fresh cycle must not open with the song that just ended.
                if (finished_entry && cycle.length > 1
                    && mix_entry_key(cycle[0]) === mix_entry_key(finished_entry)) {
                    cycle.push(cycle.shift());
                }
                window.push(...cycle);
            }
            return window;
        }
        while (window.length < MIX_WINDOW_SIZE) {
            const entry = this.next_mix_cycle_entry(window);
            if (!entry) break;
            window.push(entry);
        }
        return window;
    }

    /** Next unseen entry from the shuffled pool, or null when the pool is spent. */
    next_mix_cycle_entry(window) {
        const hub = this.state.hub;
        let cycle = hub.mixCycle;
        if (!cycle || hub.mixCycleIdx >= cycle.length) {
            const in_window = new Set(window.map(mix_entry_key));
            const candidates = this.mix_pool().pool.filter((e) => !in_window.has(mix_entry_key(e)));
            if (!candidates.length) return null;
            if (this.shuffle) this.shuffle.shuffleArrayInPlace(candidates);
            cycle = candidates;
            hub.mixCycle = cycle;
            hub.mixCycleIdx = 0;
        }
        return cycle[hub.mixCycleIdx++] || null;
    }

    /** Load the playlist recommendations once so mix mode has something to add. */
    ensure_mix_recommendations() {
        const hub = this.state.hub;
        // The Song Mix page already has its own list; never fetch playlist recs for it.
        if (hub.songMixView) return;
        const pid = String(hub.playlistId || '');
        if (!pid || hub._mixRecsRequestedFor === pid) return;
        if (typeof window.ensurePlaylistRecommendations !== 'function') return;
        hub._mixRecsRequestedFor = pid;
        hub.mixOrder = null;
        hub.mixOrderSig = '';
        hub.mixCycle = null;
        hub.mixCycleIdx = 0;
        window.ensurePlaylistRecommendations(pid);
    }

    fmt(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    get_header_play_icon() {
        const headerPlayButton = document.getElementById('playlist-header-play');
        return headerPlayButton ? headerPlayButton.querySelector('i') : null;
    }

    is_header_playlist_active() {
        const hub = this.state.hub;
        const currentPlaylistTracks = Array.isArray(hub.tracks) ? hub.tracks : [];
        return !!(
            hub.playingPlaylistId &&
            hub.playlistId &&
            String(hub.playingPlaylistId) === String(hub.playlistId) &&
            hub.currentTrackId &&
            currentPlaylistTracks.some((t) => t.id === hub.currentTrackId)
        );
    }

    /** Pick a random playable track id from the currently viewed playlist. */
    random_playable_track_id() {
        const hub = this.state.hub;
        if (!hub.playable.length) return null;
        const i = Math.floor(Math.random() * hub.playable.length);
        return hub.playable[i].id;
    }

    handle_playlist_header_play() {
        const hub = this.state.hub;
        if (!hub.playable || !hub.playable.length) return;
        if (this.is_header_playlist_active()) {
            if (hub.audio.paused) {
                this.playTrackById(hub.currentTrackId);
            } else {
                hub.audio.pause();
            }
            return;
        }
        const trackId = hub.shuffleOn ? this.random_playable_track_id() : (hub.playable[0] && hub.playable[0].id);
        if (!trackId) return;
        this.playTrackById(trackId);
    }

    rowForTrack(id) {
        return document.querySelector('tr.track-row[data-track-id="' + CSS.escape(id) + '"]');
    }

    scrollTrackIntoView(trackId) {
        if (!trackId) return false;
        const row = this.rowForTrack(trackId);
        if (!row) return false;

        const getScrollContainer = (el) => {
            let n = el.parentElement;
            while (n) {
                const style = window.getComputedStyle(n);
                const overY = style.overflowY;
                if ((overY === 'auto' || overY === 'scroll') && n.scrollHeight > n.clientHeight) {
                    return n;
                }
                n = n.parentElement;
            }
            return null;
        };

        const container = getScrollContainer(row);
        if (container) {
            const rowRect = row.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const desiredTopGap = 48;
            const targetTop = container.scrollTop + rowRect.top - containerRect.top - desiredTopGap;
            const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
            container.scrollTop = Math.min(maxTop, Math.max(0, targetTop));
            return true;
        }

        row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        return true;
    }

    updatePlayingRow() {
        document.querySelectorAll('tr.track-row-playing').forEach(r => r.classList.remove('track-row-playing'));
        const hub = this.state.hub;
        let row = null;
        // A live search stream is what is actually playing, so it wins over a
        // stale hub.currentTrackId left over from a previously played library track.
        if (hub.searchStreamActive) {
            const vid = String(
                (hub.searchStreamHit && hub.searchStreamHit.video_id)
                || this.stream_vid_from_src(hub.audio && (hub.audio.currentSrc || hub.audio.src))
                || ''
            ).trim();
            if (vid) {
                row = document.querySelector(
                    '#playlist-recommendations-table tr.track-row[data-youtube-video-id="' + CSS.escape(vid) + '"], #song-mix-table tr.track-row[data-youtube-video-id="' + CSS.escape(vid) + '"]'
                );
            }
        }
        if (!row && hub.currentTrackId) row = this.rowForTrack(hub.currentTrackId);
        if (row) row.classList.add('track-row-playing');
    }

    stream_vid_from_src(src) {
        try {
            const u = new URL(String(src || ''), window.location.href);
            if (!u.pathname.startsWith('/api/stream')) return '';
            return String(u.searchParams.get('vid') || '').trim();
        } catch (e) {
            return '';
        }
    }

    release_stream_cache_for_src() {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return;
        const next = this.stream_vid_from_src(hub.audio.src || hub.audio.currentSrc || '');
        const prev = String(hub._active_stream_vid || '').trim();
        if (prev && prev !== next) {
            fetch('/api/stream/release?vid=' + encodeURIComponent(prev), {
                method: 'POST',
                credentials: 'same-origin',
                keepalive: true,
            }).catch(() => {});
        }
        hub._active_stream_vid = next;
    }

    isSearchStreamPlayback() {
        const hub = this.state.hub;
        return !!(hub && hub.searchStreamActive);
    }

    _data_saver_audio_src(src) {
        const prefs = window.SpolocalQualityPrefs;
        const is_local = prefs ? !!prefs.normalizeMediaPath(src) : false;
        const data_saver = prefs ? prefs.playbackKbps() <= 64 : false;
        // Data Saver: route local files through the sliced /media endpoint so the
        // browser fetches byte-range slices as the playhead advances.
        if (data_saver && is_local && src) {
            return src + (src.indexOf('?') >= 0 ? '&' : '?') + 'sliced=1';
        }
        return src;
    }

    /**
     * Attach the resolved source for playback. Data Saver local WebM files go
     * through MSE (true byte slicing); everything else plays natively.
     * Returns true when MSE took over, so the caller skips the native play().
     */
    _attach_playback_source(src, on_complete) {
        const hub = this.state.hub;
        const prefs = window.SpolocalQualityPrefs;
        const mse = window.SpolocalMse;
        const local_path = prefs ? prefs.normalizeMediaPath(src) : '';
        const data_saver = prefs ? prefs.playbackKbps() <= 64 : false;
        if (mse && mse.is_supported() && data_saver && local_path && /\.webm$/i.test(local_path)) {
            mse.play_media(src, hub.audio, () => this._play_native_source(src), on_complete);
            return true;
        }
        this._play_native_source(src);
        return false;
    }

    _play_native_source(src) {
        const hub = this.state.hub;
        if (window.SpolocalMse) window.SpolocalMse.stop();
        const audioSrc = this._data_saver_audio_src(src);
        hub.audio.src = audioSrc;
        this._apply_preload_for_src(audioSrc);
    }

    _apply_preload_for_src(src) {
        const hub = this.state.hub;
        if (!hub.audio) return;
        const prefs = window.SpolocalQualityPrefs;
        const is_local = prefs ? !!prefs.normalizeMediaPath(src) : false;
        const data_saver = prefs ? prefs.playbackKbps() <= 64 : false;
        // Data Saver: don't prefetch the whole local file - let the browser fetch
        // byte-range slices as the playhead advances (saves data/battery).
        hub.audio.preload = (data_saver && is_local) ? 'metadata' : 'auto';
    }

    rec_or_mix_rows() {
        const rows = [];
        const collect = (table) => {
            if (!table) return;
            table.querySelectorAll('tr.track-row[data-youtube-video-id]').forEach((r) => rows.push(r));
        };
        collect(document.getElementById('song-mix-table'));
        collect(document.getElementById('playlist-recommendations-table'));
        return rows;
    }

    rec_or_mix_row_index(rows) {
        const hub = this.state.hub;
        const current_vid = String(
            (hub.searchStreamHit && hub.searchStreamHit.video_id)
            || this.stream_vid_from_src(hub.audio && (hub.audio.currentSrc || hub.audio.src))
            || ''
        ).trim();
        const current_tid = String((hub && hub.currentTrackId) || '').trim();
        return rows.findIndex((r) => {
            if (current_vid && r.getAttribute('data-youtube-video-id') === current_vid) return true;
            if (current_tid && r.getAttribute('data-track-id') === current_tid) return true;
            return false;
        });
    }


    play_rec_or_mix_row(row) {
        if (!row) return false;
        const vid = String(row.getAttribute('data-youtube-video-id') || '').trim();
        const hit = {
            video_id: vid,
            title: row.getAttribute('data-title') || '',
            artist: row.getAttribute('data-artist') || '',
            channel: row.getAttribute('data-artist') || '',
        };
        const btn = row.querySelector('.track-play');
        if (typeof window.playPreview === 'function') {
            window.playPreview(hit, btn);
            return true;
        }
        this.setPlayUi(false);
        return false;
    }

    skip_rec_or_mix_row(delta) {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return false;
        const rows = this.rec_or_mix_rows();
        if (!rows.length) {
            this.setPlayUi(false);
            return false;
        }
        const idx = this.rec_or_mix_row_index(rows);
        if (hub.repeatMode === 'one' && idx >= 0) {
            this.restart_current();
            return true;
        }
        const n = rows.length;
        let next_row = null;
        if (hub.shuffleOn) {
            next_row = rows[Math.floor(Math.random() * n)];
        } else if (idx < 0) {
            next_row = delta > 0 ? rows[0] : rows[n - 1];
        } else {
            const next_idx = idx + delta;
            if (hub.repeatMode === 'all') next_row = rows[this.wrap_index(next_idx, n)];
            else if (next_idx >= 0 && next_idx < n) next_row = rows[next_idx];
            else if (delta < 0 && idx === 0) {
                this.restart_current();
                return true;
            }
        }
        if (!next_row) {
            this.setPlayUi(false);
            return false;
        }
        return this.play_rec_or_mix_row(next_row);
    }

    advance_search_stream() {
        const hub = this.state.hub;
        if (hub && hub.shuffleMode === 'mix' && hub.playbackContext === 'recs') {
            this.playAtDeltaMix(1);
            return;
        }
        this.skip_rec_or_mix_row(1);
    }

    isStreamingPlayback() {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return false;
        if (hub.searchStreamActive) return true;
        // Prefer the src attribute: currentSrc keeps the previous resource until
        // the browser selects the new one, so it reports a stale stream URL right
        // after a local track replaces a stream.
        const raw_src = String(hub.audio.src || hub.audio.currentSrc || '').trim();
        if (!raw_src || raw_src.startsWith('blob:')) return false;
        try {
            const u = new URL(raw_src, window.location.href);
            if (u.pathname.startsWith('/media/')) return false;
            if (u.pathname.startsWith('/api/preview')) return true;
            if (u.pathname.startsWith('/api/stream')) return true;
            return u.origin !== window.location.origin;
        } catch (e) {
            return false;
        }
    }

    setPlayUi(playing) {
        const hub = this.state.hub;
        document.querySelectorAll('.track-play:not([data-loading]) i').forEach(icon => {
            icon.classList.remove('fa-pause');
            icon.classList.remove('pl-0.5');
            icon.classList.add('fa-play', 'pl-0.5');
        });
        // Clear the now-playing ring from every row button; it is re-applied
        // below to the single row that is actually playing.
        document.querySelectorAll('.track-play--row').forEach(btn => {
            btn.classList.remove('ring-2', 'ring-white', 'scale-105');
        });

        const headerPlayIcon = this.get_header_play_icon();
        const isActivePlaylistPlaying = !!(playing && this.is_header_playlist_active());
        if (headerPlayIcon) {
            headerPlayIcon.classList.remove('fa-play', 'fa-pause', 'pl-0.5');
            if (isActivePlaylistPlaying) {
                headerPlayIcon.classList.add('fa-pause', 'pl-1');
            } else {
                headerPlayIcon.classList.add('fa-play', 'pl-1');
            }
        }

        if (playing) {
            hub.iconMainPlay.classList.remove('fa-play', 'pl-0.5', 'sm:pl-1', 'pl-1');
            hub.iconMainPlay.classList.add('fa-pause');
        } else {
            hub.iconMainPlay.classList.remove('fa-pause');
            hub.iconMainPlay.classList.add('fa-play', 'pl-0.5', 'sm:pl-1');
        }
        this.updatePlayingRow();
        const playing_row = document.querySelector('tr.track-row-playing');
        const playing_btn = playing_row && playing_row.querySelector('.track-play');
        if (playing_btn) {
            playing_btn.classList.add('ring-2', 'ring-white', 'scale-105');
            if (playing) {
                const icon = playing_btn.querySelector('i');
                if (icon && !playing_btn.dataset.loading) {
                    icon.classList.remove('fa-play', 'fa-stop', 'pl-0.5');
                    icon.classList.add('fa-pause', 'pl-0.5');
                }
            }
        }
        const streamBadge = hub.streamBadgeEl;
        if (streamBadge) {
            const isStream = playing && this.isStreamingPlayback();
            if (isStream) {
                streamBadge.classList.remove('hidden');
                streamBadge.style.opacity = '1';
                streamBadge.title = 'Stream';
            } else {
                streamBadge.classList.add('hidden');
                streamBadge.style.opacity = '0';
            }
        }
        this.mediaSession.updateMediaSessionPlaybackState();
    }

    handlePlayError(err) {
        if (err && err.name === 'AbortError') return;
        this.setPlayUi(false);
    }

    record_playback_start(event) {
        const hub = this.state.hub;
        if (!hub || this.isSearchStreamPlayback()) return;
        if (
            event &&
            Number.isFinite(event.timeStamp) &&
            Number.isFinite(hub._audioLoadStartTimestamp) &&
            event.timeStamp < hub._audioLoadStartTimestamp
        ) {
            return;
        }
        const playlist_id = String(hub.playingPlaylistId || hub.playlistId || '').trim();
        const track_id = String(hub.currentTrackId || '').trim();
        if (!playlist_id || !track_id) return;

        const key = PlaylistPlayLog.track_key(playlist_id, track_id);
        if (hub._playCountedKey === key) return;
        hub._playCountedKey = key;
        PlaylistPlayLog.count_track(playlist_id, track_id);
        if (hub.isHomeView && this.home) this.home.render();
    }

    leave_search_stream() {
        const hub = this.state.hub;
        if (!hub.searchStreamActive && !hub.searchStreamHit) return;
        if (typeof window.nextSpolocalStreamLoadGen === 'function') {
            window.nextSpolocalStreamLoadGen();
        } else {
            hub._streamLoadGen = (hub._streamLoadGen || 0) + 1;
        }
        hub.searchStreamActive = false;
        hub.searchStreamHit = null;
        if (typeof window.resetSpolocalSearchCards === 'function') {
            window.resetSpolocalSearchCards();
        }
    }

    async playTrackById(trackId) {
        const hub = this.state.hub;
        if (!hub.audio) return;
        this.leave_search_stream();

        let t = hub.tracks.find(x => x.id === trackId);
        const fromViewed = !!t;
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find(x => x.id === trackId);
        }
        if (!t) return;

        const prefs = window.SpolocalQualityPrefs;
        const playback_q = prefs ? String(prefs.playbackKbps()) : '192';
        const desired_src = prefs ? prefs.resolvePlaybackPlaySrc(t, playback_q) : (t.play_src || '');
        const current_path = prefs ? prefs.normalizeMediaPath(hub.audio.currentSrc || hub.audio.src) : '';
        const desired_path = prefs ? prefs.normalizeMediaPath(desired_src) : '';

        if (hub.currentTrackId === trackId && hub.audio.src) {
            if (!desired_src || (current_path && desired_path && current_path === desired_path)) {
                if (!hub.playingPlaylistId) hub.playingPlaylistId = hub.playlistId;
                if (hub.audio.paused) {
                    hub.audio.play().catch(err => this.handlePlayError(err));
                } else {
                    hub.audio.pause();
                }
                this.likes.update_like_button_ui();
                return;
            }
        }

        this._playGeneration = (this._playGeneration || 0) + 1;
        const playGen = this._playGeneration;

        if (fromViewed) {
            hub.playbackContext = 'playlist';
            const playingPidChanged = String(hub.playingPlaylistId || '') !== String(hub.playlistId || '');
            hub.playingPlaylistId = hub.playlistId;
            hub.playingTracks = hub.tracks.slice();
            hub.playingPlayable = hub.playable.slice();
            if (playingPidChanged && hub.shuffleOn && hub.playable.length) {
                this.shuffle.rebuildShuffledOrder();
            }
        }
        const sourcePid = fromViewed ? hub.playlistId : (hub.playingPlaylistId || hub.playlistId);
        const sourcePidFinal = sourcePid;
        hub.currentTrackId = trackId;
        hub.titleEl.textContent = t.title;
        hub.subEl.textContent = t.artist || '';
        this.updatePlayingRow();

        if (prefs && !prefs.hasVariant(t, playback_q) && sourcePid) {
            const ready = await this.quality.ensurePlaybackVariantReady(t, sourcePid, trackId, playback_q, playGen, prefs.streamFitsTier(playback_q));
            if (playGen !== this._playGeneration) return;
            if (!ready) return;
            t = this.quality.findTrackInHub(trackId) || t;
        }

        const playSrc = prefs ? prefs.resolvePlaybackPlaySrc(t, playback_q) : (t.play_src || '');
        if (!playSrc) return;

        if (hub.pendingRestoreOnMeta) {
            hub.audio.removeEventListener('loadedmetadata', hub.pendingRestoreOnMeta);
            hub.pendingRestoreOnMeta = null;
        }

        hub.lastPlayedTrackSnapshot = {
            id: trackId,
            title: t.title || '',
            artist: t.artist || '',
            album: t.album != null ? String(t.album) : '',
            url: (t.url || '').trim(),
            youtube_video_id: (t.youtube_video_id || '').trim(),
            source_playlist_id: sourcePidFinal,
        };
        const mse_handled = this._attach_playback_source(playSrc, () => this.playAtDelta(1));
        hub.titleEl.textContent = t.title;
        hub.subEl.textContent = t.artist;
        void this.quality.apply_track_loudness(t, sourcePidFinal);
        if (this.lyrics) this.lyrics.loadCover(trackId);
        this.updatePlayingRow();
        if (!mse_handled) {
            try {
                hub.audio.play().catch(err => this.handlePlayError(err));
            } catch (e) {
                this.handlePlayError(e);
            }
        }
        if (hub.lyricsVisible && this.lyrics) this.lyrics.fetchLyrics(true);
        this.mediaSession.updateMediaSessionMetadata(t);
        this.likes.update_like_button_ui();
        if (hub.queueVisible && this.queue) this.queue.render_queue_list();
    }

    resolveCurrentPlaySrc() {
        return this.quality.resolveCurrentPlaySrc();
    }

    handleAudioElementError(event) {
        const hub = this.state.hub;
        if (
            event &&
            Number.isFinite(event.timeStamp) &&
            Number.isFinite(hub._audioLoadStartTimestamp) &&
            event.timeStamp < hub._audioLoadStartTimestamp
        ) {
            return;
        }
        if (this.isSearchStreamPlayback()) {
            this.setPlayUi(false);
            return;
        }
        this.setPlayUi(false);
        if (hub.subEl && hub.currentTrackId) {
            hub.subEl.textContent = 'Playback unavailable. Check the connection or certificate.';
        }
    }

    scheduleStallRecoveryIfStillHung() {
        const hub = this.state.hub;
        if (this.stallRecoveryTimer) clearTimeout(this.stallRecoveryTimer);
        const mse = window.SpolocalMse;
        const mse_on = !!(mse && mse.is_active());
        this.stallRecoveryTimer = setTimeout(() => {
            this.stallRecoveryTimer = null;
            if (!hub.audio || hub.audio.paused || hub.audio.ended) return;
            if (hub.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
            if (mse && mse.is_active()) {
                mse.nudge();
                return;
            }
            if (this.isSearchStreamPlayback() || this.isStreamingPlayback()) return;
            if (!this.quality.resolveCurrentPlaySrc()) return;
            hub._mediaDecodeRetries = Math.max(hub._mediaDecodeRetries || 0, 1);
            this.quality.trySoftReloadCurrentAudioSource();
        }, mse_on ? 1800 : 6500);
    }

    handleVisibilityForBackgroundPlayback() {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return;
        if (document.visibilityState === 'hidden') {
            hub._spolocalWasPlayingWhileHidden = !hub.audio.paused && !!hub.audio.src && !hub.audio.ended;
            return;
        }
        if (hub._spolocalWasPlayingWhileHidden) {
            hub._spolocalWasPlayingWhileHidden = false;
            if (hub.audio.src && !hub.audio.ended) {
                hub.audio.play().catch(() => {});
            }
        }
        if (hub.currentTrackId) {
            this.mediaSession.updateMediaSessionPlaybackState();
        }
    }

}

