import { PlaylistTransportController } from '../player/transport_controller.js?v=119';
import { PlaylistLikeController } from '../player/like_controller.js?v=1';
import { PlaylistShuffleController } from '../player/shuffle_controller.js?v=5';
import { PlaylistMediaSessionController } from '../player/media_session_controller.js?v=1';
import { PlaybackQualityController } from '../player/playback_quality_controller.js?v=8';
import { PlaylistQueueController } from '../player/queue_controller.js?v=93';
import { PlaylistLyricsController } from '../player/lyrics_controller.js?v=92';
import { PlaylistEditModalController } from '../ui/edit_modal_controller.js';
import { PlaylistContextMenuController } from '../ui/context_menu_controller.js?v=96';
import { PlaylistDownloadController } from '../services/download_controller.js?v=95';
import { PlaylistColumnResizer } from '../ui/column_resizer.js';
import { PlaylistHomeViewController } from './home_view_controller.js?v=97';
import { PlaylistPlayLog } from './play_log.js?v=3';
import { SettingsController } from '../ui/settings_controller.js?v=6';
import { AccountController } from '../ui/account_controller.js?v=3';
import { TrackInfoController } from '../ui/track_info_controller.js?v=2';
import { TrackEditController } from '../ui/track_edit_controller.js';
import { AudioNormalizationController } from '../player/audio_normalization_controller.js?v=2';
import { SongMixController } from '../player/song_mix_controller.js?v=95';

/**
 * Main orchestrator for the playlist page session.
 * Responsibilities:
 * - Initialize and start all sub-controllers
 * - Handle SPA-style playlist navigation
 * - Restore last known playback state on boot
 */
export class PlaylistSessionController {
    /** @param {import('./state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./state.js').PlaylistPlayerState} */
        this.state = state;

        this.transport = new PlaylistTransportController(state);
        this.likes = new PlaylistLikeController(state);
        this.shuffle = new PlaylistShuffleController(state);
        this.mediaSession = new PlaylistMediaSessionController(state, this.transport);
        this.quality = new PlaybackQualityController(state, this.transport);
        this.queue = new PlaylistQueueController(state, this.transport);
        this.lyrics = new PlaylistLyricsController(state, this.transport, this.queue);
        this.editModal = new PlaylistEditModalController(state);
        this.contextMenu = new PlaylistContextMenuController(state);
        this.download = new PlaylistDownloadController(state);
        this.home = new PlaylistHomeViewController(state, this.transport);
        this.settings = new SettingsController(state);
        this.account = new AccountController(state);
        this.trackInfo = new TrackInfoController(state);
        this.trackEdit = new TrackEditController(state);
        this.songMix = new SongMixController(state);

        // SPA navigation: abort the previous view request and reuse a recent
        // response so clicking back and forth does not re-fetch every time.
        this._navAbort = null;
        this._viewCache = new Map();
        this.VIEW_CACHE_MS = 15000;

        // Wire cross-controller references so each controller can call its peers
        this.shuffle.setQueueRef(this.queue);
        this.quality.setLyricsRef(this.lyrics);
        this.transport.setCrossRefs(this.queue, this.lyrics, this.home, this.likes, this.shuffle, this.mediaSession, this.quality);
        this.queue.setCrossRefs(this.lyrics);
        this.editModal.setCrossRefs(this.contextMenu);
        this.settings.setCrossRefs(this.transport, this.download);
        this.account.setTransport(this.transport);
        this.contextMenu.setCrossRefs(this.queue, this.editModal, this.transport, this.trackInfo, this.download, this.trackEdit, this.songMix);
        this.trackEdit.setCrossRefs(this.transport, this.queue, this.contextMenu);
        this.download.setCrossRefs(this);
    }

    /** Finish boot after playback restore: account counters, liked keys, queue. */
    async after_restore() {
        this.queue.restore_manual_queue_from_storage();
        this.transport.shuffle.syncShuffleOrderWithPlaylist();
        // The account is the source of truth for play counts; mirror it back
        // into localStorage before the home view reads the numbers. Fetch the
        // liked keys in parallel so boot does not wait on two round trips.
        const [synced] = await Promise.all([
            PlaylistPlayLog.sync(),
            this.transport.likes.refresh_liked_keys_from_server(),
        ]);
        this.transport.likes.update_like_button_ui();
        if (this.state.hub.queueVisible) this.queue.render_queue_list();
        if (synced && this.state.hub.isHomeView) this.home.render();
    }

    /** Initialize playlist DOM state and start all controllers. */
    bootstrap() {
        this.initialize_playlist_state();
        this.attachHelpers();
        this.start();
    }

    /** Start all controllers and restore state. */
    start() {
        this.transport.init();
        this.queue.init();
        this.lyrics.init();
        this.editModal.init();
        this.contextMenu.init();
        this.settings.init();
        this.account.init();
        this.trackInfo.init();
        this.trackEdit.init();
        this.download.init();

        if (this.state.hub.isHomeView) {
            this.home.render();
        } else if (this.state.hub.playlistId) {
            this.transport.likes.bind_track_row_like_buttons();
        }

        this.restoreLastPlayback()
            .then(() => this.after_restore(), () => this.after_restore())
            .finally(() => {
                const u = new URLSearchParams(location.search);
                if (u.get('view') === 'mix' && u.get('playlist_id') && u.get('track_id')) {
                    void this.songMix.open({
                        playlist_id: u.get('playlist_id'),
                        track_id: u.get('track_id'),
                        push: false,
                    });
                }
            });

        window.addEventListener('popstate', () => {
            const u = new URLSearchParams(location.search);
            if (u.get('view') === 'mix' && u.get('playlist_id') && u.get('track_id')) {
                void this.songMix.open({
                    playlist_id: u.get('playlist_id'),
                    track_id: u.get('track_id'),
                    push: false,
                });
                return;
            }
            const pid = u.get('playlist_id');
            if (pid) this.navigatePlaylist(pid, false);
            else this.navigateHome(false);
        });

        document.addEventListener('click', (e) => {
            const homeA = e.target.closest('a.home-spa-nav');
            if (homeA) {
                e.preventDefault();
                this.navigateHome(true);
                return;
            }
            const a = e.target.closest('a.playlist-spa-nav');
            if (!a) return;
            let url;
            try { url = new URL(a.getAttribute('href'), location.origin); } catch (x) { return; }
            if (url.pathname !== '/' || !url.searchParams.get('playlist_id')) return;
            e.preventDefault();
            this.navigatePlaylist(url.searchParams.get('playlist_id'), true);
        }, true);

        window.addEventListener('beforeunload', () => this.transport.mediaSession.persistPlaybackProgress());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.transport.mediaSession.persistPlaybackProgress();
            } else {
                if (this.state.hub.currentTrackId && !this.state.hub.audio.paused) {
                    this.transport.mediaSession.updateMediaSessionPlaybackState();
                }
            }
        });

        this.attachPlayerTrackNav();
    }

    attachPlayerTrackNav() {
        const hub = this.state.hub;
        const go = (e) => {
            e.preventDefault();
            void this.goToPlayingTrack();
        };
        if (hub.titleEl) hub.titleEl.addEventListener('click', go);
        if (hub.subEl) hub.subEl.addEventListener('click', go);
        const coverWrap = document.getElementById('player-cover-wrap');
        if (coverWrap) coverWrap.addEventListener('click', go);
    }

    scrollToCurrentTrack() {
        const hub = this.state.hub;
        if (!hub.currentTrackId) return;
        this.transport.scrollTrackIntoView(hub.currentTrackId);
        this.transport.updatePlayingRow();
    }

    async goToPlayingTrack() {
        const hub = this.state.hub;
        this.hideLyricsIfOpen();
        if (hub.queueVisible && this.queue) this.queue.toggleQueue();
        if (typeof window.closeGlobalSearch === 'function') window.closeGlobalSearch();
        if (this.settings) this.settings.close();
        const track_id = hub.currentTrackId;
        if (!track_id) return;

        let playlist_id = String(hub.playingPlaylistId || '').trim();
        if (!playlist_id && hub.lastPlayedTrackSnapshot) {
            playlist_id = String(hub.lastPlayedTrackSnapshot.source_playlist_id || '').trim();
        }
        if (!playlist_id) playlist_id = String(hub.playlistId || '').trim();
        if (!playlist_id) return;

        const scroll = () => this.scrollToCurrentTrack();

        if (hub.isHomeView || String(hub.playlistId || '') !== playlist_id) {
            await this.navigatePlaylist(playlist_id, true, scroll);
            return;
        }
        scroll();
    }

    initialize_playlist_state() {
        const hub = this.state.hub || (this.state.hub = {});
        this.state.hub = hub;

        hub.playlistId = (function () {
            try {
                const el = document.getElementById('spolocal-player-boot');
                if (!el) return null;
                const o = JSON.parse(el.textContent || '{}');
                return o.playlistId != null ? o.playlistId : null;
            } catch (e) { return null; }
        })();
        try {
            const bootEl = document.getElementById('spolocal-player-boot');
            const boot = bootEl ? JSON.parse(bootEl.textContent || '{}') : {};
            hub.isHomeView = !!boot.isHome || !hub.playlistId;
            hub.libraryPool = Array.isArray(boot.libraryPool) ? boot.libraryPool : [];
            hub.randomMode = false;
            if (Array.isArray(boot.catalog) && boot.catalog.length) {
                window.__playlistsCatalog = boot.catalog;
            }
        } catch (e) {
            hub.isHomeView = !hub.playlistId;
            hub.libraryPool = [];
            hub.randomMode = false;
        }
        try { window.__spaPlaylistId = hub.playlistId || ''; } catch (e) {}
        window.__playlistsCatalog = window.__playlistsCatalog || [];

        hub.tracks = [];
        hub.playlistJsonEl = document.getElementById('playlist-json');
        if (hub.playlistJsonEl) {
            try {
                const parsed = JSON.parse(hub.playlistJsonEl.textContent || '[]');
                hub.tracks = Array.isArray(parsed) ? parsed : [];
            } catch (e) { hub.tracks = []; }
        }
        if (hub.playlistJsonEl) hub.playlistJsonEl.textContent = JSON.stringify(hub.tracks);
        hub.playable = hub.tracks.filter((t) => {
            const prefs = window.SpolocalQualityPrefs;
            const src = prefs ? prefs.resolvePlaySrc(t) : t.play_src;
            return !!src;
        });

        hub.audio = document.getElementById('player-audio');
        hub.audioNormalization = hub.audio ? new AudioNormalizationController(hub.audio) : null;
        hub.seek = document.getElementById('player-seek');
        hub.seekLoadedEl = document.getElementById('player-seek-loaded');
        hub.volumeEl = document.getElementById('player-volume');
        hub.volumeIconEl = document.getElementById('player-volume-icon');
        hub.timeEl = document.getElementById('player-time');
        hub.durEl = document.getElementById('player-duration');
        hub.titleEl = document.getElementById('player-title');
        hub.subEl = document.getElementById('player-subtitle');
        hub.coverImg = document.getElementById('player-cover');
        hub.coverWrap = document.getElementById('player-cover-wrap');
        hub.lyricsPanel = document.getElementById('lyrics-panel');
        hub.lyricsTitle = document.getElementById('lyrics-title');
        hub.lyricsVisualizerModeSelect = document.getElementById('lyrics-visualizer-mode');
        hub.lyricsModeSwitch = document.getElementById('lyrics-mode-switch');
        hub.lyricsMobileViewSwitch = document.getElementById('lyrics-mobile-view-switch');
        hub.lyricsTabLyrics = document.getElementById('lyrics-tab-lyrics');
        hub.lyricsTabVideo = document.getElementById('lyrics-tab-video');
        hub.lyricsBody = document.getElementById('lyrics-body');
        hub.lyricsEmptyHint = document.getElementById('lyrics-empty-hint');
        hub.lyricsNoAudioHint = document.getElementById('lyrics-no-audio-hint');
        hub.lyricsViewWrap = document.getElementById('lyrics-view-wrap');
        hub.lyricsReadRow = document.getElementById('lyrics-read-row');
        hub.lyricsVideoPane = document.getElementById('lyrics-video-pane');
        hub.lyricsVideoLoad = document.getElementById('lyrics-video-load');
        hub.lyricsVideoHide = document.getElementById('lyrics-video-hide');
        hub.lyricsVideoFs = document.getElementById('lyrics-video-fs');
        hub.lyricsVideoStack = document.getElementById('lyrics-video-stack');
        hub.lyricsVideoEl = document.getElementById('lyrics-video');
        hub.lyricsEditWrap = document.getElementById('lyrics-edit-wrap');
        hub.lyricsEditor = document.getElementById('lyrics-editor');
        hub.lyricsEditDisabled = document.getElementById('lyrics-edit-disabled');
        hub.lyricsEditActions = document.getElementById('lyrics-edit-actions');
        hub.lyricsSaveBtn = document.getElementById('lyrics-save-btn');
        hub.lyricsCancelEdit = document.getElementById('lyrics-cancel-edit');
        hub.lyricsSaveStatus = document.getElementById('lyrics-save-status');
        hub.lyricsTabRead = document.getElementById('lyrics-tab-read');
        hub.lyricsTabEdit = document.getElementById('lyrics-tab-edit');
        hub.btnLyricsMobile = document.getElementById('btn-lyrics-mobile');
        hub.btnLyricsDesktop = document.getElementById('btn-lyrics-desktop');
        hub.lyricsToggleButtons = [hub.btnLyricsMobile, hub.btnLyricsDesktop].filter(function (b) { return !!b; });
        hub.queuePanel = document.getElementById('sidebar-queue');
        hub.queueList = document.getElementById('queue-list');
        hub.queueClose = document.getElementById('queue-close');
        hub.queueReload = document.getElementById('queue-reload');
        hub.btnQueueMobile = document.getElementById('btn-queue-mobile');
        hub.btnQueueDesktop = document.getElementById('btn-queue-desktop');
        hub.lrcEditor = document.getElementById('lrc-editor');
        hub.lrcLinesContainer = document.getElementById('lrc-lines-container');
        hub.lrcShiftMinus = document.getElementById('lrc-shift-minus');
        hub.lrcShiftPlus = document.getElementById('lrc-shift-plus');
        hub.btnMainPlay = document.getElementById('player-main-play');
        hub.iconMainPlay = document.getElementById('player-main-play-icon');
        hub.btnPrev = document.getElementById('player-prev');
        hub.btnNext = document.getElementById('player-next');
        hub.btnSeekBack = document.getElementById('player-seek-back');
        hub.btnSeekFwd = document.getElementById('player-seek-fwd');
        hub.btnRate = document.getElementById('player-rate');
        hub.btnShuffle = document.getElementById('player-shuffle');
        hub.btnRepeat = document.getElementById('player-repeat');
        hub.repeatOneBadge = document.getElementById('player-repeat-one-badge');
        hub.shuffleSparkle = document.getElementById('player-shuffle-sparkle');
        hub.btnLike = document.getElementById('player-like');
        hub.btnLikeMobile = document.getElementById('player-like-mobile');
        hub.likeIconEl = document.getElementById('player-like-icon');
        hub.likeIconMobileEl = document.getElementById('player-like-icon-mobile');
        hub.lyricsClose = document.getElementById('lyrics-close');
        hub.playlistEditModal = document.getElementById('playlist-edit-modal');
        hub.playlistEditBackdrop = document.getElementById('playlist-edit-modal-backdrop');
        hub.playlistEditCloseX = document.getElementById('playlist-edit-close-x');
        hub.playlistEditCancel = document.getElementById('playlist-edit-cancel');
        hub.playlistEditSave = document.getElementById('playlist-edit-save');
        hub.playlistEditDelete = document.getElementById('playlist-edit-delete');
        hub.playlistEditId = document.getElementById('playlist-edit-id');
        hub.playlistEditNameInput = document.getElementById('playlist-edit-name-input');
        hub.playlistEditBioInput = document.getElementById('playlist-edit-bio-input');
        hub.playlistEditError = document.getElementById('playlist-edit-error');
        hub.contextMenuEl = document.getElementById('context-menu');
        hub.contextMenuItemsEl = document.getElementById('context-menu-items');
        hub.dlList = document.getElementById('dl-progress-list');
        hub.dlIdle = document.getElementById('dl-idle-msg');
        hub.dlCount = document.getElementById('dl-queue-count');
        hub.dlErrorList = document.getElementById('dl-error-list');
        hub.dlErrorCount = document.getElementById('dl-error-count');
        hub.dlRetryAllErrors = document.getElementById('dl-retry-all-errors');

        hub.LS_SHUFFLE = 'spolocal_shuffle';
        hub.LS_SHUFFLE_ORDER = 'spolocal_shuffle_order_v1';
        hub.LS_REPEAT = 'spolocal_repeat';
        hub.LS_VOLUME = 'spolocal_volume';
        hub.LS_RATE = 'spolocal_playback_rate';
        hub.LS_LAST_PL = 'spolocal_last_playlist_id';
        hub.LS_LAST_TR = 'spolocal_last_track_id';
        hub.LS_LAST_POS = 'spolocal_last_time_sec';
        hub.LS_MANUAL_QUEUE = 'spolocal_manual_queue_v1';

        hub.shuffleOn = false;
        hub.shuffleMode = 'off';
        hub.repeatMode = 'off';
        hub.shuffledOrder = [];
        hub.queueVisible = false;
        hub.manual_up_next_queue = [];
        hub.resume_anchor_track_id = null;
        hub.currentTrackId = null;
        hub.lastPlayedTrackSnapshot = null;
        hub.playingPlaylistId = null;
        hub._playCountedKey = '';
        hub._audioLoadStartTimestamp = 0;
        hub.playingTracks = [];
        hub.playingPlayable = [];
        hub.seeking = false;
        hub.lyricsVisible = false;
        hub.lyricsMode = 'read';
        hub.lyricsViewMode = 'lyrics';
        hub.lyricsVisualizerMode = 'solid';
        hub.lastLyricsPayload = { lyrics: '', source: 'none', has_audio: false, lrc_data: null, lrc_raw: null };
        hub.lyricsAbortController = null;
        hub.lyricsFetchGen = 0;
        hub.lrcEditLines = [];
        hub.LIKED_PLAYLIST_ID = String(typeof window !== 'undefined' && window.__likedPlaylistId ? window.__likedPlaylistId : '').trim();
        hub.likedKeysSet = new Set();
        hub.pendingRestoreOnMeta = null;
        hub.persistThrottle = null;
        hub.mediaSessionPositionThrottle = null;
        hub.lyricsActiveLineThrottle = null;
        hub.lyricsScrollDebounce = null;
        hub.progressInFlight = false;
        hub.progressTimer = null;
        hub.__dlJobsDomKey = '';
        hub.__dlErrDomKey = '';
        hub.songMixView = false;
    }

    hideLyricsIfOpen() {
        const hub = this.state.hub;
        if (!hub.lyricsVisible || !this.lyrics) return;
        hub.lyricsVisible = false;
        if (hub.lyricsPanel) {
            hub.lyricsPanel.classList.add('hidden');
            hub.lyricsPanel.style.bottom = '';
        }
        this.lyrics.sync_lyrics_toggle_buttons();
        this.lyrics.resetLyricsColors();
    }

    updateSidebarActive(pid) {
        const homeLink = document.querySelector('a.home-spa-nav');
        if (homeLink) {
            homeLink.classList.toggle('nav-active', !pid);
            homeLink.classList.toggle('hover:bg-[#282828]', !!pid);
        }
        document.querySelectorAll('.playlist-card').forEach(card => {
            const a = card.querySelector('a.playlist-spa-nav');
            if (!a) return;
            let u;
            try { u = new URL(a.getAttribute('href'), location.origin); } catch (x) { return; }
            const id = u.searchParams.get('playlist_id') || '';
            card.classList.toggle('nav-active', id === pid);
        });
    }

    applySpaPlaylist(data) {
        const hub = this.state.hub;
        const same_playlist = data.playlist_id === hub.playlistId;
        let saved_scroll_top = 0;
        if (same_playlist) {
            const scroll_root = document.getElementById('playlist-scroll-root');
            if (scroll_root) saved_scroll_top = scroll_root.scrollTop;
        }
        hub.isHomeView = false;
        hub.songMixView = false;
        // Only a real navigation invalidates in-flight variant polling; a
        // re-render after a download must not stop it.
        if (hub.playlistId !== data.playlist_id) hub._navGen = (hub._navGen || 0) + 1;
        hub.playlistId = data.playlist_id;
        try { window.__spaPlaylistId = hub.playlistId; } catch (e) {}
        hub.tracks = data.tracks_payload || [];
        hub.playable = hub.tracks.filter((t) => {
            const prefs = window.SpolocalQualityPrefs;
            const src = prefs ? prefs.resolvePlaySrc(t) : t.play_src;
            return !!src;
        });

        const shell = document.getElementById('spa-main');
        if (shell) shell.innerHTML = data.html || '';
        if (shell && typeof window.bustPlaylistCoverImages === 'function') {
            window.bustPlaylistCoverImages(shell);
        }

        if (hub.playlistJsonEl) hub.playlistJsonEl.textContent = JSON.stringify(hub.tracks);

        PlaylistColumnResizer.init();
        this.updateSidebarActive(hub.playlistId);

        this.transport.updatePlayingRow();
        this.transport.setPlayUi(!hub.audio.paused);
        this.transport.likes.bind_track_row_like_buttons();

        if (hub.queueVisible) this.queue.render_queue_list();

        if (typeof window.loadPlaylistRecommendations === 'function') {
            window.loadPlaylistRecommendations(hub.playlistId);
        }
        if (typeof window.syncPlaylistEditModalFromFragment === 'function') window.syncPlaylistEditModalFromFragment();

        if (same_playlist && saved_scroll_top > 0) {
            const restore_scroll = () => {
                const scroll_root = document.getElementById('playlist-scroll-root');
                if (scroll_root) scroll_root.scrollTop = saved_scroll_top;
            };
            requestAnimationFrame(() => requestAnimationFrame(restore_scroll));
        }

        void this.transport.likes.refresh_liked_keys_from_server().then(() => {
            this.transport.likes.update_like_button_ui();
            this.transport.likes.update_track_row_like_buttons();
            if (hub.queueVisible) this.queue.render_queue_list();
        });
    }

    applySpaHome(data) {
        const hub = this.state.hub;
        if (!hub.isHomeView) hub._navGen = (hub._navGen || 0) + 1;
        hub.isHomeView = true;
        hub.songMixView = false;
        hub.playlistId = null;
        try { window.__spaPlaylistId = ''; } catch (e) {}
        hub.tracks = [];
        hub.playable = [];
        hub.libraryPool = data.library_pool || [];
        if (Array.isArray(data.catalog)) window.__playlistsCatalog = data.catalog;

        const shell = document.getElementById('spa-main');
        if (shell) shell.innerHTML = data.html || '';
        if (hub.playlistJsonEl) hub.playlistJsonEl.textContent = '[]';

        this.updateSidebarActive(null);
        this.home.render();
        this.transport.updatePlayingRow();
        this.transport.setPlayUi(!hub.audio.paused);
    }

    async navigateHome(pushHistory) {
        const hub = this.state.hub;
        if (hub.isHomeView && !hub.playlistId && !hub.songMixView) return;
        this.hideLyricsIfOpen();
        try {
            const r = await fetch('/api/home/view');
            if (!r.ok) {
                window.location.href = '/';
                return;
            }
            const data = await r.json();
            this.applySpaHome(data);
            if (pushHistory) {
                history.pushState({ view: 'home' }, '', '/');
            }
        } catch (x) {
            window.location.href = '/';
        }
    }

    invalidateViewCache(playlistId) {
        if (playlistId == null) this._viewCache.clear();
        else this._viewCache.delete(String(playlistId));
    }

    /** Re-render a playlist in place without a page load or touching playback. */
    async reloadPlaylistView(playlistId) {
        if (!playlistId) return false;
        this.invalidateViewCache(playlistId);
        try {
            const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(playlistId));
            if (!r.ok) return false;
            const data = await r.json();
            this._viewCache.set(String(playlistId), { data: data, ts: Date.now() });
            this.applySpaPlaylist(data);
            return true;
        } catch (x) {
            return false;
        }
    }

    _applyNavigation(data, pid, pushHistory, onLoaded) {
        this.applySpaPlaylist(data);
        if (pushHistory) {
            history.pushState({ playlistId: pid }, '', '/?playlist_id=' + encodeURIComponent(pid));
        }
        if (typeof onLoaded === 'function') {
            requestAnimationFrame(() => {
                onLoaded();
            });
        }
    }

    async navigatePlaylist(pid, pushHistory, onLoaded) {
        const hub = this.state.hub;
        if (!pid) return;
        if (pid === hub.playlistId && !hub.songMixView) return;
        hub.songMixView = false;
        this.hideLyricsIfOpen();

        const cached = this._viewCache.get(String(pid));
        if (cached && Date.now() - cached.ts < this.VIEW_CACHE_MS) {
            this._applyNavigation(cached.data, pid, pushHistory, onLoaded);
            return;
        }

        if (this._navAbort) this._navAbort.abort();
        const ac = new AbortController();
        this._navAbort = ac;
        try {
            const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(pid), { signal: ac.signal });
            if (!r.ok) {
                window.location.href = '/?playlist_id=' + encodeURIComponent(pid);
                return;
            }
            const data = await r.json();
            if (ac.signal.aborted) return;
            this._viewCache.set(String(pid), { data: data, ts: Date.now() });
            this._applyNavigation(data, pid, pushHistory, onLoaded);
        } catch (x) {
            if (x && x.name === 'AbortError') return;
            window.location.href = '/?playlist_id=' + encodeURIComponent(pid);
        } finally {
            if (this._navAbort === ac) this._navAbort = null;
        }
    }

    async restoreLastPlayback() {
        const hub = this.state.hub;
        let pls, trs, posStr;
        try {
            pls = localStorage.getItem(hub.LS_LAST_PL);
            trs = localStorage.getItem(hub.LS_LAST_TR);
            posStr = localStorage.getItem(hub.LS_LAST_POS);
        } catch (e) { return; }
        if (!pls || !trs) return;
        let pos = parseFloat(posStr);
        if (!isFinite(pos) || pos < 0) pos = 0;

        if (pls !== hub.playlistId) {
            const urlPid = new URLSearchParams(location.search).get('playlist_id') || '';
            const mix_boot = new URLSearchParams(location.search).get('view') === 'mix';
            if (urlPid && !mix_boot) {
                try {
                    const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(pls));
                    if (!r.ok) return;
                    const data = await r.json();
                    this.applySpaPlaylist(data);
                } catch (e) { return; }
            } else {
                try {
                    const r = await fetch('/api/playlist/state?playlist_id=' + encodeURIComponent(pls));
                    if (!r.ok) return;
                    const data = await r.json();
                    hub.playingPlaylistId = pls;
                    hub.playingTracks = data.tracks_payload || [];
                    hub.playingPlayable = hub.playingTracks.filter((t) => t.play_src);
                } catch (e) { return; }
            }
        }

        if (pls === hub.playlistId) {
            try {
                const u = new URLSearchParams(location.search);
                const urlPid = u.get('playlist_id') || '';
                if (urlPid !== pls && u.get('view') !== 'mix') {
                    history.replaceState(null, '', '/?playlist_id=' + encodeURIComponent(pls));
                }
            } catch (e) {}
        }

        let t = (hub.playingTracks.length ? hub.playingTracks : hub.tracks).find(x => x.id === trs && x.play_src);
        if (!t) return;

        hub.playingPlaylistId = pls;
        hub.playingTracks = hub.tracks.slice();
        hub.playingPlayable = hub.playable.slice();
        hub.currentTrackId = trs;
        hub.lastPlayedTrackSnapshot = {
            id: trs,
            title: t.title || '',
            artist: t.artist || '',
            album: t.album != null ? String(t.album) : '',
            url: (t.url || '').trim(),
            youtube_video_id: (t.youtube_video_id || '').trim(),
            source_playlist_id: pls,
        };

        const prefs = window.SpolocalQualityPrefs;
        const playback_q = prefs ? String(prefs.playbackKbps()) : '192';
        let play_src = prefs ? prefs.resolvePlaybackPlaySrc(t, playback_q) : t.play_src;
        if (prefs && !prefs.hasVariant(t, playback_q)) {
            const ready = await this.transport.quality.ensurePlaybackVariantReady(t, pls, trs, playback_q, 0);
            if (ready) {
                t = this.transport.quality.findTrackInHub(trs) || t;
                play_src = prefs.resolvePlaybackPlaySrc(t, playback_q);
            }
        }
        if (!play_src) return;

        hub.audio.src = play_src;
        void this.transport.quality.apply_track_loudness(t, pls);
        hub.titleEl.textContent = t.title;
        hub.subEl.textContent = t.artist;
        if (this.lyrics) this.lyrics.loadCover(trs, pls);
        this.transport.updatePlayingRow();
        this.transport.setPlayUi(false);
        this.transport.likes.update_like_button_ui();

        const onMeta = () => {
            hub.audio.removeEventListener('loadedmetadata', onMeta);
            hub.pendingRestoreOnMeta = null;
            let tpos = pos;
            if (hub.audio.duration && isFinite(hub.audio.duration)) {
                if (tpos > hub.audio.duration - 0.35) tpos = 0;
                if (tpos > 0.25) hub.audio.currentTime = tpos;
            }
            hub.timeEl.textContent = this.transport.fmt(hub.audio.currentTime);
            hub.durEl.textContent = this.transport.fmt(hub.audio.duration);
            if (hub.audio.duration) {
                hub.seek.value = String(Math.floor((hub.audio.currentTime / hub.audio.duration) * 1000));
            }
        };
        hub.pendingRestoreOnMeta = onMeta;
        hub.audio.addEventListener('loadedmetadata', onMeta);
    }

    attachHelpers() {
        const self = this;
        try {
            if (typeof window !== 'undefined') {
                window.navigatePlaylist = (pid, push, cb) => self.navigatePlaylist(pid, push, cb);
                window.navigateHome = (push) => self.navigateHome(push);
                window.refreshHomeView = () => {
                    if (self.state.hub.isHomeView) self.home.render();
                };
                window.applySpaPlaylist = (data) => self.applySpaPlaylist(data);
                window.applySpaHome = (data) => self.applySpaHome(data);
                window.invalidatePlaylistViewCache = (pid) => self.invalidateViewCache(pid);
                window.refreshPlaylistView = (pid) => self.reloadPlaylistView(pid);
            }
        } catch (e) {}
    }
}
