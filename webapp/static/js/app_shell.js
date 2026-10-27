/*
 * Application shell controller.
 * Wires the global UI that surrounds playlist views: search overlay with preview
 * playback, add-to-playlist popover, playlists sidebar, and playlist
 * recommendations. No playlist-specific logic lives here.
 */
'use strict';

class SpolocalMobileSheetDrawers {
    mount() {
        const body = document.body;
        const openNavBtn = document.getElementById('mobile-open-nav');
        const closeNavBtn = document.getElementById('mobile-close-nav');
        const openDlBtn = document.getElementById('mobile-open-dl');
        const closeDlBtn = document.getElementById('mobile-close-dl');
        const bdNav = document.getElementById('mobile-nav-backdrop');
        const bdDl = document.getElementById('mobile-dl-backdrop');

        const closeNav = () => {
            body.classList.remove('mobile-nav-open');
            if (openNavBtn) openNavBtn.setAttribute('aria-expanded', 'false');
        };
        const closeDl = () => {
            body.classList.remove('mobile-dl-open');
            if (openDlBtn) openDlBtn.setAttribute('aria-expanded', 'false');
        };
        const openNav = () => {
            closeDl();
            document.body.classList.remove('mobile-queue-open');
            window.dispatchEvent(new CustomEvent('spolocal:force-close-queue'));
            body.classList.add('mobile-nav-open');
            if (openNavBtn) openNavBtn.setAttribute('aria-expanded', 'true');
        };
        const openDl = () => {
            closeNav();
            document.body.classList.remove('mobile-queue-open');
            window.dispatchEvent(new CustomEvent('spolocal:force-close-queue'));
            body.classList.add('mobile-dl-open');
            if (openDlBtn) openDlBtn.setAttribute('aria-expanded', 'true');
        };

        if (openNavBtn) {
            openNavBtn.addEventListener('click', () => {
                if (body.classList.contains('mobile-nav-open')) closeNav();
                else openNav();
            });
        }
        if (closeNavBtn) closeNavBtn.addEventListener('click', closeNav);
        if (bdNav) bdNav.addEventListener('click', closeNav);

        if (openDlBtn) {
            openDlBtn.addEventListener('click', () => {
                if (body.classList.contains('mobile-dl-open')) closeDl();
                else openDl();
            });
        }
        if (closeDlBtn) closeDlBtn.addEventListener('click', closeDl);
        if (bdDl) bdDl.addEventListener('click', closeDl);

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            closeNav();
            closeDl();
            window.dispatchEvent(new CustomEvent('spolocal:force-close-queue'));
        });

        document.addEventListener('click', (e) => {
            const a = e.target.closest && e.target.closest('a.playlist-spa-nav, a.home-spa-nav');
            if (!a) return;
            closeNav();
        }, true);
    }
}

class AppShellController {
    constructor() {
        this.PAGE_SIZE = 6;
        // Shared UI state
        this.playlistsCatalog = [];
        this.searchHits = [];
        this.searchOffset = 0;
        this.searchHasMore = false;
        this.currentSearchQuery = '';
        this.activePreviewVid = null;
        this.previewTimer = null;
        this.pendingAddHit = null;
        this.lastAtpAnchor = null;
        this.atpGhostAnchor = null;
        this.playlistRecommendationsObserver = null;
        this.recs_fetch_gen = 0;
        this.recs_cache_pid = '';
        this.recs_cache_hits = [];
        // DOM refs (filled in boot)
        this.topForm = null;
        this.topInput = null;
        this.gPanel = null;
        this.gLabel = null;
        this.gMsg = null;
        this.gList = null;
        this.gPager = null;
        this.gPrevBtn = null;
        this.gNextBtn = null;
        this.gPageLabel = null;
        this.gClose = null;
        this.previewAudio = null;
        this.atpPop = null;
        this.atpFilter = null;
        this.atpListInner = null;
        this.atpNewToggle = null;
        this.atpNewRow = null;
        this.atpNewForm = null;
        this.atpNewName = null;
        this.atpDownloadTiers = null;
        this.atpDownloadValue = null;
    }

    // ---- small helpers ---------------------------------------------------

    static fmtDur(sec) {
        if (sec == null || !isFinite(sec)) return '';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    static isUrl(s) {
        return /^https?:\/\//i.test(s) || /^spotify:/i.test(s);
    }

    static normalizeSpotifyInput(s) {
        const raw = String(s || '').trim();
        if (!raw) return '';
        if (/^spotify:/i.test(raw)) {
            return raw.split('?')[0].split('#')[0];
        }
        try {
            const u = new URL(raw);
            if (/spotify\.com$/i.test(u.hostname) || u.hostname.endsWith('.spotify.com')) {
                return (u.origin + u.pathname).replace(/\/$/, '');
            }
        } catch (e) { /* ignore */ }
        return raw.split('?')[0].split('#')[0];
    }

    /** @returns {'track'|'playlist'|null} */
    static spotifyUrlKind(s) {
        const t = AppShellController.normalizeSpotifyInput(s);
        if (!t) return null;
        if (/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track(?:\/|$)/i.test(t) || /^spotify:track:/i.test(t)) {
            return 'track';
        }
        if (/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?playlist(?:\/|$)/i.test(t) || /^spotify:playlist:/i.test(t)) {
            return 'playlist';
        }
        return null;
    }

    async resolveSpotifyTrackAndSearch(spotifyUrl) {
        const clean = AppShellController.normalizeSpotifyInput(spotifyUrl);
        const r = await fetch('/api/spotify/resolve?url=' + encodeURIComponent(clean), {
            headers: { Accept: 'application/json' },
        });
        let q = '';
        try {
            const data = await AppShellController.parseJsonApiResponse(r, 'Could not read that Spotify link.');
            q = data && data.search_query ? String(data.search_query).trim() : '';
        } catch (e) {
            const msg = e && e.message ? String(e.message) : '';
            if (r.status === 404 || msg === 'Not Found') {
                throw new Error(
                    'Spotify link lookup is not available on this server (restart SpoLocal after updating). Try searching by song name.',
                );
            }
            throw e;
        }
        if (!q) throw new Error('No search query from Spotify.');
        if (this.topInput) this.topInput.value = q;
        await this.runGlobalSearch(q);
    }

    // Covers are immutable per track id and the server sends a 7-day cache
    // header, so only bust when a caller explicitly asks for it. Defaulting to
    // Date.now() re-downloaded every tile on each render.
    static withCoverCacheBust(url, bust) {
        if (!url || bust == null) return url;
        try {
            const u = new URL(url, location.origin);
            u.searchParams.set('v', String(bust));
            const q = u.searchParams.toString();
            return u.pathname + (q ? '?' + q : '');
        } catch (e) {
            const base = String(url).split('?')[0];
            return base + '?v=' + bust;
        }
    }

    static withCoverQuality(url) {
        const covers = window.SpolocalCoverUrls;
        if (!covers || !url) return url;
        try {
            const u = new URL(url, location.origin);
            if (u.pathname.indexOf('/tracks/') >= 0 && /\/cover\/?$/.test(u.pathname)) {
                const key = covers.qualityKey();
                // "high" is the server default; rewriting it would make the
                // browser fetch the same image twice per render.
                if (key === 'high' && !u.searchParams.has('q')) return url;
                if (key === 'high') u.searchParams.delete('q');
                else u.searchParams.set('q', key);
                const q = u.searchParams.toString();
                return u.pathname + (q ? '?' + q : '');
            }
        } catch (e) {}
        return url;
    }

    static streamSrcForVideoId(vid) {
        return '/api/stream?vid=' + encodeURIComponent(vid);
    }

    static library_local_match(hit) {
        const matches = hit && Array.isArray(hit.library_matches) ? hit.library_matches : [];
        const prefs = window.SpolocalQualityPrefs;
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const src = prefs ? prefs.resolvePlaySrc(m) : (m.play_src || '');
            if (src && (!prefs || prefs.normalizeMediaPath(src))) return m;
        }
        return null;
    }

    static library_match_is_current(hit) {
        const hub = window.SpolocalPlayerHub;
        const tid = hub ? String(hub.currentTrackId || '') : '';
        if (!tid) return false;
        const matches = hit && Array.isArray(hit.library_matches) ? hit.library_matches : [];
        return matches.some(function (m) { return String(m.track_id || '') === tid; });
    }

    // ---- sidebar + playlists catalog -------------------------------------

    static buildPlaylistArtGridEl(tiles, sizeClass, bust) {
        const sz = sizeClass || 'h-8 w-8';
        const wrap = document.createElement('div');
        wrap.className = 'grid ' + sz + ' shrink-0 overflow-hidden rounded bg-[#1a1a1a] grid-cols-2';
        wrap.style.gridTemplateRows = 'repeat(2, minmax(0, 1fr))';
        wrap.style.gap = '1px';
        const arr = tiles || [];
        for (let i = 0; i < 4; i++) {
            if (i < arr.length && arr[i]) {
                const cell = document.createElement('div');
                cell.className = 'playlist-art-grid__cell h-full w-full bg-[#282828]';
                const img = document.createElement('img');
                img.src = AppShellController.withCoverCacheBust(AppShellController.withCoverQuality(arr[i]), bust);
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.onerror = function () {
                    this.onerror = null;
                    this.style.opacity = '0';
                };
                cell.appendChild(img);
                wrap.appendChild(cell);
            } else {
                const ph = document.createElement('div');
                ph.className = 'h-full w-full min-h-0 min-w-0 bg-[#282828]';
                ph.setAttribute('aria-hidden', 'true');
                wrap.appendChild(ph);
            }
        }
        return wrap;
    }

    async reloadPlaylistsCatalog() {
        try {
            const cr = await fetch('/api/playlists/catalog');
            if (!cr.ok) return false;
            const data = await cr.json();
            if (Array.isArray(data)) {
                const next = JSON.stringify(data);
                const changed = next !== this._catalogJson;
                this._catalogJson = next;
                this.playlistsCatalog = data;
                window.__playlistsCatalog = data;
                return changed;
            }
        } catch (e) {}
        return false;
    }

    buildSidebarPlaylistCard(pl, activeId, bust) {
        const isActive = !!activeId && pl.id === activeId;
        const card = document.createElement('div');
        card.className = 'group playlist-card rounded-md text-sm' + (isActive ? ' nav-active' : '');
        card.dataset.playlistId = pl.id;
        card.dataset.playlistName = pl.name || '';
        const a = document.createElement('a');
        a.href = '/?playlist_id=' + encodeURIComponent(pl.id);
        a.className = 'playlist-spa-nav flex w-full min-w-0 items-center gap-x-3 px-3 py-2 rounded-md' + (isActive ? '' : ' hover:bg-[#282828]');
        const artWrap = document.createElement('div');
        artWrap.className = 'h-10 w-10 shrink-0 overflow-hidden rounded bg-[#1a1a1a]';
        artWrap.appendChild(AppShellController.buildPlaylistArtGridEl(pl.cover_tiles, 'h-full w-full', bust));
        a.appendChild(artWrap);
        const span = document.createElement('span');
        span.className = 'truncate';
        span.textContent = pl.name || '';
        a.appendChild(span);
        card.appendChild(a);
        return card;
    }

    renderSidebarPlaylistList(activePlaylistId, bust) {
        const list = document.getElementById('sidebar-playlist-list');
        if (!list) return;
        const activeId = (activePlaylistId || '').trim();
        this._sidebarActiveId = activeId;
        list.innerHTML = '';
        const likedId = String(window.__likedPlaylistId || '').trim();
        this.playlistsCatalog.forEach((pl) => {
            // The liked songs playlist lives in the BROWSE section, under Home.
            if (pl.system_locked) return;
            if (likedId && pl.id === likedId) return;
            list.appendChild(this.buildSidebarPlaylistCard(pl, activeId, bust));
        });
    }

    /**
     * Derive the liked playlist id from the catalog. A PWA launch can render the
     * document as a guest, which leaves the server-rendered id null even though
     * the catalog request is authenticated.
     */
    syncLikedPlaylistId() {
        const liked = this.playlistsCatalog.find((pl) => pl && pl.system_locked);
        const id = liked ? String(liked.id || '').trim() : '';
        if (!id) return '';
        window.__likedPlaylistId = id;
        const hub = window.SpolocalPlayerHub;
        if (hub) hub.LIKED_PLAYLIST_ID = id;
        return id;
    }

    /** Rebuild the BROWSE Liked Songs row when the document rendered as guest. */
    ensureSidebarLikedRow() {
        const slot = document.getElementById('sidebar-liked-nav');
        if (!slot || slot.querySelector('.playlist-card')) return;
        const liked = this.playlistsCatalog.find((pl) => pl && pl.system_locked);
        if (!liked) return;
        slot.innerHTML = '';
        slot.appendChild(this.buildSidebarPlaylistCard(liked, this._sidebarActiveId));
        slot.classList.remove('hidden');
    }

    async afterTrackAddedToPlaylist(plId) {
        if (typeof window.invalidatePlaylistViewCache === 'function') {
            window.invalidatePlaylistViewCache(plId);
        }
        await this.reloadPlaylistsCatalog();
        this.renderSidebarPlaylistList(plId);
        const cur = window.__spaPlaylistId || new URL(location.href).searchParams.get('playlist_id') || '';
        if (cur === plId) {
            try {
                const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(plId));
                if (r.ok && typeof window.applySpaPlaylist === 'function') {
                    window.applySpaPlaylist(await r.json());
                }
            } catch (e) {}
            return;
        }
        if (typeof window.navigatePlaylist === 'function') {
            await window.navigatePlaylist(plId, true);
            return;
        }
        try {
            const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(plId));
            if (!r.ok) return;
            const data = await r.json();
            if (typeof window.applySpaPlaylist === 'function') {
                window.applySpaPlaylist(data);
            }
        } catch (e) {}
    }

    static async parseJsonApiResponse(r, fallbackMsg) {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('application/json')) {
            if (!r.ok) throw new Error(fallbackMsg || 'Request failed.');
            return { ok: true };
        }
        const data = await r.json();
        if (!r.ok) {
            const msg = (data && data.detail) ? String(data.detail) : (fallbackMsg || 'Request failed.');
            throw new Error(msg);
        }
        return data;
    }

    async addTrackToPlaylist(plId, hit) {
        const fd = new FormData();
        fd.append('title', hit.title || '');
        fd.append('artist', hit.artist || hit.channel || '');
        fd.append('url', hit.url || '');
        fd.append('album', hit.album || '');
        const lib = Array.isArray(hit.library_matches) ? hit.library_matches : [];
        const src = lib.length ? lib[0] : null;
        if (src && src.playlist_id && src.track_id) {
            fd.append('source_playlist_id', String(src.playlist_id));
            fd.append('source_track_id', String(src.track_id));
        }
        const q = window.SpolocalQualityPrefs ? String(window.SpolocalQualityPrefs.downloadKbps()) : '192';
        fd.append('quality', q);
        const r = await fetch('/playlists/' + encodeURIComponent(plId) + '/tracks', {
            method: 'POST',
            body: fd,
            headers: { Accept: 'application/json' },
        });
        const data = await AppShellController.parseJsonApiResponse(r, 'Could not add track.');
        await this.afterTrackAddedToPlaylist(plId);
        return data;
    }

    static async createPlaylistFromAtp(name, hit) {
        const body = { name: name };
        if (hit) {
            body.title = hit.title || '';
            body.artist = hit.artist || hit.channel || '';
            body.url = hit.url || '';
            body.album = hit.album || '';
            body.video_id = hit.video_id || '';
            body.quality = String(window.SpolocalQualityPrefs ? window.SpolocalQualityPrefs.downloadKbps() : '192');
            const lib = Array.isArray(hit.library_matches) ? hit.library_matches : [];
            if (lib.length && lib[0].playlist_id && lib[0].track_id) {
                body.source_playlist_id = String(lib[0].playlist_id);
                body.source_track_id = String(lib[0].track_id);
            }
        }
        const r = await fetch('/api/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
        return AppShellController.parseJsonApiResponse(r, 'Could not create playlist.');
    }

    async addHitToLikedSongs(hit) {
        const body = {
            title: hit.title || '',
            artist: hit.artist || hit.channel || '',
            url: hit.url || '',
            album: hit.album || '',
            video_id: hit.video_id || '',
            quality: String(window.SpolocalQualityPrefs ? window.SpolocalQualityPrefs.downloadKbps() : '192'),
        };
        const lib = Array.isArray(hit.library_matches) ? hit.library_matches : [];
        if (lib.length && lib[0].playlist_id && lib[0].track_id) {
            body.source_playlist_id = String(lib[0].playlist_id);
            body.source_track_id = String(lib[0].track_id);
        }
        const r = await fetch('/api/liked-songs/add', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
        return AppShellController.parseJsonApiResponse(r, 'Could not save to Liked Songs.');
    }

    async afterSavedToLikedSongs(plId) {
        if (!plId) return;
        if (typeof window.invalidatePlaylistViewCache === 'function') {
            window.invalidatePlaylistViewCache(plId);
        }
        await this.reloadPlaylistsCatalog();
        this.syncLikedPlaylistId();
        this.renderSidebarPlaylistList(this._sidebarActiveId);
        this.ensureSidebarLikedRow();
        const cur = window.__spaPlaylistId || new URL(location.href).searchParams.get('playlist_id') || '';
        if (cur !== plId) return;
        try {
            const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(plId));
            if (r.ok && typeof window.applySpaPlaylist === 'function') {
                window.applySpaPlaylist(await r.json());
            }
        } catch (e) {}
    }

    // ---- search cards + preview playback -----------------------------------

    reset_search_card_buttons() {
        this.activePreviewVid = null;
        document.querySelectorAll('.preview-btn').forEach((b) => {
            if (b.classList.contains('track-play--row')) return;
            b.innerHTML = '<i class="fa-solid fa-play text-black text-sm pl-0.5"></i>';
            b.classList.remove('ring-2', 'ring-white', 'scale-105');
        });
    }

    playing_stream_vid() {
        const hub = window.SpolocalPlayerHub;
        if (hub && hub.searchStreamHit) {
            const from_hit = String(hub.searchStreamHit.video_id || '').trim();
            if (from_hit && hub.searchStreamActive) return from_hit;
        }
        const src = hub && hub.audio ? String(hub.audio.currentSrc || hub.audio.src || '') : '';
        try {
            const u = new URL(src, window.location.href);
            if (u.pathname.startsWith('/api/stream')) return String(u.searchParams.get('vid') || '').trim();
        } catch (e) {}
        return '';
    }

    sync_search_card_play_buttons() {
        const playing = this.playing_stream_vid();
        const hub = window.SpolocalPlayerHub;
        const paused = !!(hub && hub.audio && hub.audio.paused);
        const cur_tid = hub ? String(hub.currentTrackId || '') : '';
        this.activePreviewVid = playing || null;
        document.querySelectorAll('.preview-btn').forEach((b) => {
            if (b.classList.contains('track-play--row')) return;
            const vid = (b.getAttribute('data-video-id') || '').trim();
            const lib_ids = (b.getAttribute('data-library-track-ids') || '').split(',').filter(Boolean);
            const on = !!(playing && vid && vid === playing) || !!(cur_tid && lib_ids.indexOf(cur_tid) >= 0);
            b.classList.toggle('ring-2', on);
            b.classList.toggle('ring-white', on);
            b.classList.toggle('scale-105', on);
            if (on && !paused) {
                b.innerHTML = '<i class="fa-solid fa-stop text-black text-[10px]"></i>';
            } else {
                b.innerHTML = '<i class="fa-solid fa-play text-black text-sm pl-0.5"></i>';
            }
        });
    }

    stopPreview(opts) {
        const restore_library = !opts || opts.restore_library !== false;
        if (window.SpolocalMse) window.SpolocalMse.stop();
        if (this.previewAudio) {
            this.previewAudio.pause();
            this.previewAudio.removeAttribute('src');
            this.previewAudio.load();
        }
        if (this.previewTimer) { clearTimeout(this.previewTimer); this.previewTimer = null; }
        this.reset_search_card_buttons();
        const hub = window.SpolocalPlayerHub;
        if (hub && hub.searchStreamActive) {
            if (!restore_library) {
                if (hub.audio) hub.audio.pause();
            } else {
                hub.searchStreamActive = false;
                hub.searchStreamHit = null;
                if (hub.audio) {
                    hub.audio.pause();
                    hub.audio.removeAttribute('src');
                    hub.audio.load();
                }
                if (hub.currentTrackId && hub.titleEl) {
                    let t = (hub.tracks || []).find((x) => x.id === hub.currentTrackId);
                    if (!t && hub.playingTracks) {
                        t = hub.playingTracks.find((x) => x.id === hub.currentTrackId);
                    }
                    if (t) {
                        hub.titleEl.textContent = t.title || '';
                        if (hub.subEl) hub.subEl.textContent = t.artist || '';
                        const prefs = window.SpolocalQualityPrefs;
                        const src = prefs ? prefs.resolvePlaySrc(t) : t.play_src;
                        if (src && hub.audio) {
                            hub.audio.src = src;
                        }
                    }
                }
            }
        }
        if (hub && typeof hub.setPlayUi === 'function') {
            hub.setPlayUi(!!(hub.audio && !hub.audio.paused));
        }
        if (restore_library && hub && hub.lyricsVisible && hub.lyricsController) {
            hub.lyricsController.fetchLyrics(true);
        }
    }

    next_stream_load_gen() {
        const hub = window.SpolocalPlayerHub;
        if (!hub) return 0;
        if (hub._streamRefreshOnMeta && hub.audio) {
            hub.audio.removeEventListener('loadedmetadata', hub._streamRefreshOnMeta);
            hub._streamRefreshOnMeta = null;
        }
        hub._streamLoadGen = (hub._streamLoadGen || 0) + 1;
        return hub._streamLoadGen;
    }

    set_row_loading(btn, loading) {
        if (!btn) return;
        if (loading) {
            btn.dataset.loading = '1';
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>';
            btn.disabled = true;
        } else {
            delete btn.dataset.loading;
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-play text-[10px] pl-0.5"></i>';
            this.sync_search_card_play_buttons();
        }
    }

    async prepare_stream_url(vid) {
        try {
            await fetch('/api/stream/prepare?vid=' + encodeURIComponent(vid));
        } catch (e) {}
    }

    playPreview(hit, btn) {
        const vid = hit && typeof hit === 'object' ? (hit.video_id || '') : String(hit || '');
        if (!vid) return;
        const hub = window.SpolocalPlayerHub;
        // Song Mix rows are YouTube mix hits, never library tracks. Always stream
        // them, so next keeps advancing inside the mix instead of the playlist.
        const mix_view = !!(hub && hub.songMixView);
        if (!mix_view && (this.playing_stream_vid() === vid || AppShellController.library_match_is_current(hit)) && hub && hub.audio) {
            if (hub.audio.paused) {
                hub.audio.play().catch((err) => {
                    if (err && err.name === 'AbortError') return;
                    if (typeof hub.setPlayUi === 'function') hub.setPlayUi(false);
                });
            } else {
                hub.audio.pause();
            }
            this.sync_search_card_play_buttons();
            return;
        }
        const local = mix_view ? null : AppShellController.library_local_match(hit);
        if (local && local.playlist_id && local.track_id && hub && typeof hub.playLibraryEntry === 'function') {
            this.stopPreview({ restore_library: false });
            hub.searchStreamActive = false;
            hub.searchStreamHit = null;
            if (typeof window.nextSpolocalStreamLoadGen === 'function') {
                window.nextSpolocalStreamLoadGen();
            }
            void Promise.resolve(hub.playLibraryEntry(local, 'recs')).then(() => {
                this.sync_search_card_play_buttons();
            });
            return;
        }
        this.stopPreview({ restore_library: false });
        this.reset_search_card_buttons();
        this.activePreviewVid = vid;
        if (btn && !btn.classList.contains('track-play--row')) {
            btn.innerHTML = '<i class="fa-solid fa-stop text-black text-[10px]"></i>';
            btn.classList.add('ring-2', 'ring-white', 'scale-105');
        }
        if (hub && hub.audio) {
            this.next_stream_load_gen();
            hub.searchStreamActive = true;
            hub.searchStreamHit = hit;
            hub.playbackContext = 'recs';
            hub._mediaDecodeRetries = 0;
            hub.audio.pause();
            if (typeof hub.applyStreamLoudness === 'function') hub.applyStreamLoudness(vid);
            const stream_src = AppShellController.streamSrcForVideoId(vid);
            const after_meta = () => {
                hub.titleEl && (hub.titleEl.textContent = hit.title || '');
                hub.subEl && (hub.subEl.textContent = (hit.artist || hit.channel || ''));
                if (typeof hub.setPlayUi === 'function') hub.setPlayUi(true);
                if (hub.lyricsController) hub.lyricsController.load_youtube_cover(vid);
                if (hub.queueVisible && hub.queue) hub.queue.render_queue_list();
                if (hub.lyricsVisible && hub.lyricsController) hub.lyricsController.fetchLyrics(true);
                if (typeof hub.prefetchNextLoudness === 'function') hub.prefetchNextLoudness();
                // Once playback actually starts, swap the loading spinner for the pause icon.
                if (btn && btn.classList.contains('track-play--row')) {
                    delete btn.dataset.loading;
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-pause text-[10px]"></i>';
                    btn.classList.add('ring-2', 'ring-white', 'scale-105');
                }
            };
            const on_mse_end = () => {
                if (typeof hub.onMseStreamEnded === 'function') hub.onMseStreamEnded();
            };
            const direct_play = () => {
                hub.audio.src = stream_src;
                hub.audio.play().catch((err) => {
                    if (err && err.name === 'AbortError') return;
                    if (typeof hub.setPlayUi === 'function') hub.setPlayUi(false);
                });
                after_meta();
            };
            const start_play = () => {
                if (window.SpolocalMse && window.SpolocalMse.is_supported()) {
                    window.SpolocalMse.play(vid, hub.audio, direct_play, hit.duration_sec, on_mse_end);
                    after_meta();
                } else {
                    hub.audio.removeAttribute('src');
                    hub.audio.load();
                    direct_play();
                }
            };
            if (btn && btn.classList.contains('track-play--row')) {
                this.set_row_loading(btn, true);
                void this.prepare_stream_url(vid).then(start_play);
            } else {
                start_play();
            }
            return;
        }
        if (this.previewAudio) {
            this.previewAudio.src = AppShellController.streamSrcForVideoId(vid);
            this.previewAudio.load();
            this.previewAudio.play().catch(() => {});
        }
    }

    // ---- add-to-playlist popover -------------------------------------------

    closeAddToPlaylistPopover() {
        this.pendingAddHit = null;
        this.lastAtpAnchor = null;
        if (this.atpGhostAnchor && this.atpGhostAnchor.parentNode) {
            this.atpGhostAnchor.parentNode.removeChild(this.atpGhostAnchor);
        }
        this.atpGhostAnchor = null;
        if (this.atpPop) this.atpPop.classList.add('hidden');
        if (this.atpNewRow) this.atpNewRow.classList.add('hidden');
        if (this.atpFilter) this.atpFilter.value = '';
    }

    closeGlobalSearch() {
        this.closeAddToPlaylistPopover();
        if (this.gPanel) this.gPanel.classList.add('hidden');
    }

    positionAddPopover(anchor) {
        if (!this.atpPop || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        const margin = 8;
        const popW = 280;
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + popW > window.innerWidth - margin) {
            left = window.innerWidth - popW - margin;
        }
        if (left < margin) left = margin;
        const estH = Math.min(420, window.innerHeight * 0.72);
        if (top + estH > window.innerHeight - margin) {
            top = rect.top - estH - 6;
        }
        if (top < margin) top = margin;
        this.atpPop.style.left = left + 'px';
        this.atpPop.style.top = top + 'px';
    }

    renderAtpList() {
        if (!this.atpListInner) return;
        this.atpListInner.innerHTML = '';
        const q = (this.atpFilter && this.atpFilter.value ? this.atpFilter.value : '').trim().toLowerCase();
        const likedId = this.syncLikedPlaylistId();
        const showLiked = !!(likedId && (!q || 'liked songs'.indexOf(q) !== -1));
        if (showLiked) {
            const likedBtn = document.createElement('button');
            likedBtn.type = 'button';
            likedBtn.className = 'flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-[#3e3e3e]';
            const heart = document.createElement('span');
            heart.className = 'flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gradient-to-br from-[#450af5] to-[#c4efd9] text-white';
            heart.innerHTML = '<i class="fa-solid fa-heart text-sm"></i>';
            likedBtn.appendChild(heart);
            const span = document.createElement('span');
            span.className = 'min-w-0 truncate';
            span.textContent = 'Liked Songs';
            likedBtn.appendChild(span);
            likedBtn.addEventListener('click', async () => {
                if (!this.pendingAddHit) return;
                const hit = this.pendingAddHit;
                likedBtn.disabled = true;
                try {
                    const data = await this.addHitToLikedSongs(hit);
                    this.closeAddToPlaylistPopover();
                    await this.afterSavedToLikedSongs(data && data.playlist_id);
                } catch (e) {
                    alert(e && e.message ? e.message : 'Could not save to Liked Songs.');
                    likedBtn.disabled = false;
                }
            });
            this.atpListInner.appendChild(likedBtn);
        }
        const filtered = this.playlistsCatalog.filter((pl) => {
            if (pl.system_locked) return false;
            return !q || (pl.name && pl.name.toLowerCase().indexOf(q) !== -1);
        });

        if (!filtered.length) {
            if (showLiked) return;
            const empty = document.createElement('p');
            empty.className = 'px-3 py-4 text-center text-xs text-[#727272]';
            empty.textContent = this.playlistsCatalog.length ? 'No matching playlists.' : 'No playlists yet — use New playlist above.';
            this.atpListInner.appendChild(empty);
            return;
        }
        filtered.forEach((pl) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-[#3e3e3e]';
            btn.appendChild(AppShellController.buildPlaylistArtGridEl(pl.cover_tiles));
            const span = document.createElement('span');
            span.className = 'min-w-0 truncate';
            span.textContent = pl.name || '';
            btn.appendChild(span);
            btn.addEventListener('click', async () => {
                if (!this.pendingAddHit) return;
                const hit = this.pendingAddHit;
                btn.disabled = true;
                try {
                    await this.addTrackToPlaylist(pl.id, hit);
                    this.closeAddToPlaylistPopover();
                } catch (e) {
                    alert(e && e.message ? e.message : 'Could not add track.');
                } finally {
                    btn.disabled = false;
                }
            });
            this.atpListInner.appendChild(btn);
        });
    }

    openAddToPlaylistPopover(hit, anchor) {
        this.pendingAddHit = hit;
        this.lastAtpAnchor = anchor;
        this.syncAtpQualityUi();
        if (this.atpNewRow) this.atpNewRow.classList.add('hidden');
        if (this.atpFilter) this.atpFilter.value = '';
        this.renderAtpList();
        if (this.atpPop) {
            this.atpPop.classList.remove('hidden');
            this.positionAddPopover(anchor);
        }
        if (this.atpFilter) {
            setTimeout(() => { this.atpFilter.focus(); }, 50);
        }
    }

    openAddToPlaylistAtPoint(hit, clientX, clientY) {
        if (typeof window.closeContextMenu === 'function') {
            window.closeContextMenu();
        }
        this.closeAddToPlaylistPopover();
        const ghost = document.createElement('button');
        ghost.type = 'button';
        ghost.className = 'open-add-to-playlist';
        ghost.setAttribute('aria-hidden', 'true');
        ghost.style.cssText = 'position:fixed;left:' + clientX + 'px;top:' + clientY + 'px;width:1px;height:1px;padding:0;margin:0;border:0;opacity:0;pointer-events:none;z-index:10000;';
        document.body.appendChild(ghost);
        this.atpGhostAnchor = ghost;
        this.openAddToPlaylistPopover(hit, ghost);
    }

    syncAtpQualityUi() {
        const prefs = window.SpolocalQualityPrefs;
        if (!prefs) return;
        const v = prefs.downloadKbps();
        prefs.syncTierGroup(this.atpDownloadTiers, v);
        if (this.atpDownloadValue) this.atpDownloadValue.textContent = prefs.formatLabel(v);
    }

    // ---- library match navigation --------------------------------------------

    open_library_match(m) {
        const pid = String((m && m.playlist_id) || '');
        const tid = String((m && m.track_id) || '');
        if (!pid) return;
        this.closeGlobalSearch();
        const scroll = () => {
            const row = document.querySelector('tr.track-row[data-track-id="' + CSS.escape(tid) + '"]');
            if (!row) return;
            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
            row.classList.add('ring-1', 'ring-[#1DB954]');
            setTimeout(() => { row.classList.remove('ring-1', 'ring-[#1DB954]'); }, 1800);
        };
        const hub = window.SpolocalPlayerHub;
        if (hub && String(hub.playlistId || '') === pid) {
            scroll();
            return;
        }
        if (typeof window.navigatePlaylist === 'function') {
            window.navigatePlaylist(pid, true, scroll);
        }
    }

    // ---- hit cards + recommendations rows ------------------------------------

    buildYoutubeHitCard(hit) {
        const matches = Array.isArray(hit.library_matches) ? hit.library_matches : [];
        const card = document.createElement('div');
        card.className = 'group w-full mx-auto rounded-md bg-[#181818] p-2 pb-2 transition-colors hover:bg-[#282828] ' + (matches.length ? 'max-w-[200px]' : 'max-w-[140px]');

        const artWrap = document.createElement('div');
        artWrap.className = 'relative aspect-square w-full overflow-hidden rounded-md shadow-lg bg-[#282828]';

        const img = document.createElement('img');
        img.alt = hit.title || '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.className = 'h-full w-full object-cover';
        const vid = hit.video_id || '';
        const covers = window.SpolocalCoverUrls;
        img.src = (covers && vid)
            ? covers.youtubeThumbUrl(vid)
            : (vid
                ? ('https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/default.jpg')
                : (hit.thumbnail_url || ''));
        img.addEventListener('error', function () {
            this.onerror = null;
            if (vid) {
                this.src = (covers && covers.youtubeThumbFallbackUrl(vid))
                    || ('https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/mqdefault.jpg');
            }
        });
        artWrap.appendChild(img);

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'preview-btn absolute bottom-2 right-2 flex h-12 w-12 items-center justify-center rounded-full bg-[#1DB954] text-black shadow-lg transition-all duration-200 hover:scale-105 max-lg:opacity-100 lg:opacity-0 lg:translate-y-1 lg:group-hover:opacity-100 lg:group-hover:translate-y-0 lg:focus:opacity-100 lg:focus:translate-y-0 focus:outline-none';
        playBtn.title = 'Stream';
        playBtn.setAttribute('data-video-id', vid);
        const lib_ids = (Array.isArray(hit.library_matches) ? hit.library_matches : [])
            .map((m) => String(m.track_id || ''))
            .filter(Boolean)
            .join(',');
        if (lib_ids) playBtn.setAttribute('data-library-track-ids', lib_ids);
        playBtn.innerHTML = '<i class="fa-solid fa-play text-black text-sm pl-0.5"></i>';
        if (!hit.video_id) {
            playBtn.classList.add('hidden');
        }
        playBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this.playPreview(hit, playBtn); });
        artWrap.appendChild(playBtn);
        card.appendChild(artWrap);

        const textWrap = document.createElement('div');
        textWrap.className = 'mt-3 min-w-0 px-0.5';
        const titleEl = document.createElement('div');
        titleEl.className = 'truncate text-sm font-semibold leading-tight text-white';
        titleEl.textContent = hit.title || '';
        textWrap.appendChild(titleEl);
        // Time in its own row
        const timeRow = document.createElement('div');
        timeRow.className = 'mt-1 flex items-center gap-2';
        const metaEl = document.createElement('div');
        metaEl.className = 'truncate text-sm text-[#B3B3B3]';
        const meta = (hit.year ? hit.year + ' • ' : '') + (hit.artist || hit.channel || '');
        metaEl.textContent = meta || '—';
        const timeEl = document.createElement('div');
        timeEl.className = 'text-xs text-[#727272] tabular-nums';
        timeEl.textContent = AppShellController.fmtDur(hit.duration_sec || 0);
        timeRow.appendChild(metaEl);
        timeRow.appendChild(timeEl);
        textWrap.appendChild(timeRow);
        card.appendChild(textWrap);

        if (matches.length) {
            const box = document.createElement('div');
            box.className = 'mt-2 px-0.5 space-y-1';
            const lab = document.createElement('div');
            lab.className = 'text-[10px] font-semibold uppercase tracking-wider text-[#1DB954]';
            lab.textContent = matches.length === 1 ? 'In library' : 'In library (' + matches.length + ')';
            box.appendChild(lab);
            matches.slice(0, 4).forEach((m) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'w-full text-left rounded-md px-1 py-1 hover:bg-[#3E3E3E]';
                const pln = document.createElement('div');
                pln.className = 'truncate text-[11px] font-semibold text-white';
                pln.textContent = m.playlist_name || 'Playlist';
                const sn = document.createElement('div');
                sn.className = 'truncate text-[10px] text-[#B3B3B3]';
                sn.textContent = (m.title || '') + (m.artist ? ' · ' + m.artist : '');
                btn.appendChild(pln);
                btn.appendChild(sn);
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    this.open_library_match(m);
                });
                box.appendChild(btn);
            });
            if (matches.length > 4) {
                const more = document.createElement('div');
                more.className = 'text-[10px] text-[#727272] px-1';
                more.textContent = '+' + (matches.length - 4) + ' more';
                box.appendChild(more);
            }
            card.appendChild(box);
        }

        const addRow = document.createElement('div');
        addRow.className = 'mt-3 flex items-center justify-center gap-2 px-0.5';
        const bAdd = document.createElement('button');
        bAdd.type = 'button';
        bAdd.className = 'open-add-to-playlist flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#B3B3B3] ring-1 ring-[#3E3E3E] transition hover:bg-[#1DB954] hover:text-black hover:ring-[#1DB954] disabled:opacity-50';
        bAdd.title = 'Add to playlist';
        bAdd.setAttribute('aria-label', 'Add to playlist');
        bAdd.innerHTML = '<i class="fa-solid fa-plus text-xs"></i>';
        bAdd.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            this.openAddToPlaylistPopover(hit, bAdd);
        });
        addRow.appendChild(bAdd);

        const bLike = document.createElement('button');
        bLike.type = 'button';
        bLike.className = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#B3B3B3] ring-1 ring-[#3E3E3E] transition hover:bg-[#1DB954] hover:text-black hover:ring-[#1DB954] disabled:opacity-50';
        bLike.title = 'Save to Liked Songs';
        bLike.setAttribute('aria-label', 'Save to Liked Songs');
        bLike.innerHTML = '<i class="fa-regular fa-heart text-xs"></i>';
        bLike.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            if (!this.syncLikedPlaylistId()) {
                alert('Sign in to save songs to Liked Songs.');
                return;
            }
            bLike.disabled = true;
            try {
                const data = await this.addHitToLikedSongs(hit);
                const icon = bLike.querySelector('i');
                if (icon) {
                    icon.classList.remove('fa-regular');
                    icon.classList.add('fa-solid');
                }
                bLike.classList.add('text-[#1DB954]');
                bLike.title = 'Saved to Liked Songs';
                await this.afterSavedToLikedSongs(data && data.playlist_id);
            } catch (e) {
                alert(e && e.message ? e.message : 'Could not save to Liked Songs.');
                bLike.disabled = false;
            }
        });
        addRow.appendChild(bLike);
        card.appendChild(addRow);

        return card;
    }

    renderYoutubeHitsIntoContainer(container, hits, gridClassName) {
        if (!container) return;
        container.innerHTML = '';
        if (!hits || !hits.length) return;
        const grid = document.createElement('div');
        grid.className = gridClassName || 'grid grid-cols-3 gap-x-3 gap-y-4 w-full pb-2';
        hits.forEach((hit) => {
            grid.appendChild(this.buildYoutubeHitCard(hit));
        });
        container.appendChild(grid);
    }

    static rec_hit_cover_src(hit) {
        const vid = (hit && hit.video_id) ? String(hit.video_id) : '';
        const covers = window.SpolocalCoverUrls;
        if (vid && covers) return covers.youtubeThumbUrl(vid);
        if (vid) return 'https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/default.jpg';
        return (hit && hit.thumbnail_url) ? String(hit.thumbnail_url) : '';
    }

    build_recommendation_row(hit, index, opts) {
        opts = opts || {};
        const plus_menu = !!opts.plus_menu;
        const vid = (hit && hit.video_id) ? String(hit.video_id) : '';
        const tr = document.createElement('tr');
        tr.className = 'track-row border-b border-[#282828]' + (vid ? ' track-row--playable' : '');
        if (vid) tr.setAttribute('data-youtube-video-id', vid);
        const libMatches = Array.isArray(hit.library_matches) ? hit.library_matches : [];
        if (libMatches.length) {
            const firstTrackId = String(libMatches[0].track_id || '');
            if (firstTrackId) tr.setAttribute('data-track-id', firstTrackId);
        }
        tr.setAttribute('data-title', (hit && hit.title) ? String(hit.title) : '');
        tr.setAttribute('data-artist', (hit && (hit.artist || hit.channel)) ? String(hit.artist || hit.channel) : '');

        const td_idx = document.createElement('td');
        td_idx.className = 'py-2 pl-0 pr-0 align-middle';
        const slot = document.createElement('div');
        slot.className = 'track-index-slot relative flex h-8 w-8 items-center justify-center';
        const idx_el = document.createElement('span');
        idx_el.className = 'track-row-index pointer-events-none absolute inset-0 flex items-center justify-center text-[#727272] tabular-nums';
        idx_el.textContent = String(index);
        slot.appendChild(idx_el);
        if (vid) {
            const play_btn = document.createElement('button');
            play_btn.type = 'button';
            play_btn.className = 'preview-btn track-play track-play--row absolute inset-0 z-[1] flex h-8 w-8 items-center justify-center rounded-full bg-white text-black transition-opacity';
            play_btn.title = 'Play';
            play_btn.setAttribute('data-video-id', vid);
            const lib_ids = (Array.isArray(hit.library_matches) ? hit.library_matches : [])
                .map((m) => String(m.track_id || ''))
                .filter(Boolean)
                .join(',');
            if (lib_ids) play_btn.setAttribute('data-library-track-ids', lib_ids);
            play_btn.innerHTML = '<i class="fa-solid fa-play text-[10px] pl-0.5"></i>';
            play_btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.playPreview(hit, play_btn);
            });
            slot.appendChild(play_btn);
        }
        td_idx.appendChild(slot);
        tr.appendChild(td_idx);

        const td_art = document.createElement('td');
        td_art.className = 'py-2 pl-1 pr-3 align-middle';
        const art = document.createElement('div');
        art.className = 'h-10 w-10 overflow-hidden rounded bg-[#1a1a1a]';
        art.setAttribute('aria-hidden', 'true');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.className = 'h-full w-full object-cover';
        img.src = AppShellController.rec_hit_cover_src(hit);
        if (vid) img.setAttribute('data-video-id', vid);
        img.addEventListener('error', function () {
            this.onerror = null;
            const covers = window.SpolocalCoverUrls;
            if (vid) {
                this.src = (covers && covers.youtubeThumbFallbackUrl(vid))
                    || ('https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/mqdefault.jpg');
            } else {
                this.style.opacity = '0';
            }
        });
        art.appendChild(img);
        td_art.appendChild(art);
        tr.appendChild(td_art);

        const title = (hit && hit.title) ? String(hit.title) : '';
        const td_title = document.createElement('td');
        td_title.className = 'track-row-title py-3 px-1 font-medium truncate';
        td_title.title = title;
        td_title.textContent = title;
        tr.appendChild(td_title);

        const artist = (hit && (hit.artist || hit.channel)) ? String(hit.artist || hit.channel) : '';
        const td_artist = document.createElement('td');
        td_artist.className = 'track-row-artist py-3 px-1 text-[#B3B3B3] truncate';
        td_artist.title = artist;
        td_artist.textContent = artist;
        tr.appendChild(td_artist);

        const td_dur = document.createElement('td');
        td_dur.className = 'py-3 px-1 text-right text-[#727272] tabular-nums text-xs';
        td_dur.textContent = AppShellController.fmtDur(hit && hit.duration_sec);
        tr.appendChild(td_dur);

        const td_add = document.createElement('td');
        td_add.className = 'py-2 pr-1 align-middle text-right';
        const add_btn = document.createElement('button');
        add_btn.type = 'button';
        add_btn.className = 'inline-flex h-8 w-8 items-center justify-center rounded-full text-[#B3B3B3] hover:text-white';
        add_btn.title = plus_menu ? 'Add to playlist' : 'Add to this playlist';
        add_btn.setAttribute('aria-label', add_btn.title);
        add_btn.innerHTML = '<i class="fa-solid fa-plus text-sm"></i>';
        add_btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            if (plus_menu) {
                this.openAddToPlaylistPopover(hit, add_btn);
                return;
            }
            const pl_id = String(window.__spaPlaylistId || new URL(location.href).searchParams.get('playlist_id') || '');
            if (!pl_id) return;
            add_btn.disabled = true;
            try {
                await this.addTrackToPlaylist(pl_id, hit);
            } catch (e) {
                alert(e && e.message ? e.message : 'Could not add track.');
            } finally {
                add_btn.disabled = false;
            }
        });
        td_add.appendChild(add_btn);
        tr.appendChild(td_add);

        if (vid) {
            tr.addEventListener('click', (ev) => {
                if (ev.target.closest('button')) return;
                const btn = tr.querySelector('.preview-btn');
                this.playPreview(hit, btn);
            });
        }
        return tr;
    }

    render_playlist_recommendation_rows(container, hits, opts) {
        opts = opts || {};
        if (!container) return;
        container.innerHTML = '';
        if (!hits || !hits.length) return;
        const table = document.createElement('table');
        table.className = 'w-full text-sm table-fixed';
        table.setAttribute('id', opts.table_id || 'playlist-recommendations-table');
        const colgroup = document.createElement('colgroup');
        [
            ['0', '2rem'],
            ['1', '2.5rem'],
            ['2', '28%'],
            ['3', '22%'],
            ['4', '3.5rem'],
            ['5', '2.5rem'],
        ].forEach((pair) => {
            const col = document.createElement('col');
            col.setAttribute('data-col', pair[0]);
            col.style.width = pair[1];
            colgroup.appendChild(col);
        });
        table.appendChild(colgroup);
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr class="text-[#727272] text-left border-b border-[#282828]">'
            + '<th class="py-3 pl-0 pr-0 text-left" data-col="0">#</th>'
            + '<th class="py-3 pl-1 pr-3" data-col="1" aria-label="Art"></th>'
            + '<th class="py-3 px-3" data-col="2">TITLE</th>'
            + '<th class="py-3 px-3" data-col="3">ARTIST</th>'
            + '<th class="py-3 px-1 text-right" data-col="4" aria-label="Duration"></th>'
            + '<th class="py-3 pr-2 text-right" data-col="5" aria-label="Add"></th>'
            + '</tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        hits.forEach((hit, i) => {
            tbody.appendChild(this.build_recommendation_row(hit, i + 1, opts));
        });
        table.appendChild(tbody);
        container.appendChild(table);
        this.sync_search_card_play_buttons();
        window.dispatchEvent(new CustomEvent('spolocal:mix-recommendations-rendered'));
    }

    // ---- recommendations (IntersectionObserver-lazy) ------------------------

    disconnectPlaylistRecommendationsObserver() {
        if (this.playlistRecommendationsObserver) {
            this.playlistRecommendationsObserver.disconnect();
            this.playlistRecommendationsObserver = null;
        }
    }

    findPlaylistScrollRoot(el) {
        const byId = document.getElementById('playlist-scroll-root');
        if (byId && el && byId.contains(el)) return byId;
        let p = el.parentElement;
        while (p && p !== document.documentElement) {
            try {
                const cs = window.getComputedStyle(p);
                const oy = cs.overflowY;
                if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
                    return p;
                }
            } catch (e) { /* ignore */ }
            p = p.parentElement;
        }
        return null;
    }

    recs_playback_is_low() {
        const prefs = window.SpolocalQualityPrefs;
        return !!(prefs && prefs.playbackKbps() <= 64);
    }

    set_recs_load_button_visible(show) {
        const btn = document.getElementById('playlist-recommendations-load');
        if (!btn) return;
        btn.classList.toggle('hidden', !show);
    }

    set_recs_refresh_busy(busy) {
        const btn = document.getElementById('playlist-recommendations-refresh');
        if (!btn) return;
        btn.disabled = !!busy;
        btn.classList.toggle('opacity-50', !!busy);
        btn.classList.toggle('pointer-events-none', !!busy);
    }

    async fetchPlaylistRecommendationsWhenVisible(pid, opts) {
        const grid = document.getElementById('playlist-recommendations-grid');
        const msg = document.getElementById('playlist-recommendations-msg');
        if (!grid || !pid) return;
        const fresh = !!(opts && opts.fresh);
        const gen = ++this.recs_fetch_gen;
        grid.innerHTML = '';
        this.set_recs_refresh_busy(true);
        if (msg) {
            msg.textContent = 'Loading recommendations…';
            msg.classList.remove('hidden');
        }
        try {
            let url = '/api/playlist/recommendations?playlist_id=' + encodeURIComponent(pid) + '&limit=12';
            if (fresh) url += '&fresh=1';
            const r = await fetch(url);
            if (gen !== this.recs_fetch_gen) return;
            if (String(pid) !== String(typeof window.__spaPlaylistId === 'string' ? window.__spaPlaylistId : '')) {
                return;
            }
            if (!r.ok) {
                if (msg) {
                    msg.textContent = 'Could not load recommendations.';
                    msg.classList.remove('hidden');
                }
                if (this.recs_playback_is_low()) this.set_recs_load_button_visible(true);
                return;
            }
            const hits = await r.json();
            if (gen !== this.recs_fetch_gen) return;
            if (String(pid) !== String(typeof window.__spaPlaylistId === 'string' ? window.__spaPlaylistId : '')) {
                return;
            }
            if (!hits.length) {
                if (msg) {
                    msg.textContent = 'No recommendations right now. Try search above or add more tracks.';
                    msg.classList.remove('hidden');
                }
                if (this.recs_playback_is_low()) this.set_recs_load_button_visible(true);
                return;
            }
            if (msg) msg.classList.add('hidden');
            this.set_recs_load_button_visible(false);
            this.recs_cache_pid = String(pid);
            this.recs_cache_hits = hits;
            this.render_playlist_recommendation_rows(grid, hits);
        } catch (e) {
            if (gen !== this.recs_fetch_gen) return;
            if (String(pid) !== String(typeof window.__spaPlaylistId === 'string' ? window.__spaPlaylistId : '')) {
                return;
            }
            if (msg) {
                msg.textContent = 'Could not load recommendations (network).';
                msg.classList.remove('hidden');
            }
            if (this.recs_playback_is_low()) this.set_recs_load_button_visible(true);
        } finally {
            if (gen === this.recs_fetch_gen) this.set_recs_refresh_busy(false);
        }
    }

    paint_recs_cache_or_fetch(pid) {
        const grid = document.getElementById('playlist-recommendations-grid');
        const msg = document.getElementById('playlist-recommendations-msg');
        if (!grid) return;
        if (this.recs_cache_pid === String(pid) && this.recs_cache_hits.length) {
            if (msg) {
                msg.textContent = '';
                msg.classList.add('hidden');
            }
            this.set_recs_load_button_visible(false);
            this.render_playlist_recommendation_rows(grid, this.recs_cache_hits);
            return;
        }
        void this.fetchPlaylistRecommendationsWhenVisible(pid);
    }

    /** Fetch/render recommendations now, even if the section is off-screen. */
    ensurePlaylistRecommendations(pid) {
        const grid = document.getElementById('playlist-recommendations-grid');
        if (!grid || !pid) return;
        if (this.recs_cache_pid === String(pid) && this.recs_cache_hits.length) {
            this.render_playlist_recommendation_rows(grid, this.recs_cache_hits);
            return;
        }
        this.disconnectPlaylistRecommendationsObserver();
        this.paint_recs_cache_or_fetch(pid);
    }

    /**
     * Mix recs: mid/high only after the block is in the playlist scroll view.
     * Low quality never auto-fetches; user clicks Load Recommendations.
     */
    loadPlaylistRecommendations(pid) {
        this.disconnectPlaylistRecommendationsObserver();
        const section = document.getElementById('playlist-recommendations-section');
        const grid = document.getElementById('playlist-recommendations-grid');
        const msg = document.getElementById('playlist-recommendations-msg');
        if (!section || !grid || !pid) return;
        grid.innerHTML = '';
        if (msg) {
            msg.textContent = '';
            msg.classList.add('hidden');
        }
        const refresh_btn = document.getElementById('playlist-recommendations-refresh');
        if (refresh_btn) {
            refresh_btn.onclick = () => {
                this.recs_cache_pid = '';
                this.recs_cache_hits = [];
                this.disconnectPlaylistRecommendationsObserver();
                this.set_recs_load_button_visible(false);
                void this.fetchPlaylistRecommendationsWhenVisible(pid, { fresh: true });
            };
        }
        const load_btn = document.getElementById('playlist-recommendations-load');
        if (load_btn) {
            load_btn.onclick = () => {
                this.disconnectPlaylistRecommendationsObserver();
                this.set_recs_load_button_visible(false);
                this.paint_recs_cache_or_fetch(pid);
            };
        }
        if (this.recs_playback_is_low()) {
            this.set_recs_load_button_visible(true);
            return;
        }
        this.set_recs_load_button_visible(false);
        let layoutTries = 0;
        const attachObserver = () => {
            const scrollRoot = this.findPlaylistScrollRoot(section);
            if (!scrollRoot) {
                if (layoutTries++ < 10) {
                    requestAnimationFrame(attachObserver);
                }
                return;
            }
            const obs = new IntersectionObserver(
                (entries) => {
                    for (let i = 0; i < entries.length; i++) {
                        if (!entries[i].isIntersecting) continue;
                        this.disconnectPlaylistRecommendationsObserver();
                        this.paint_recs_cache_or_fetch(pid);
                        return;
                    }
                },
                {
                    root: scrollRoot,
                    rootMargin: '0px',
                    threshold: 0.01,
                }
            );
            this.playlistRecommendationsObserver = obs;
            obs.observe(section);
        };
        requestAnimationFrame(() => {
            requestAnimationFrame(attachObserver);
        });
    }

    // ---- global search -------------------------------------------------------

    renderPage() {
        if (!this.gList) return;
        this.gList.innerHTML = '';
        const page = Math.floor(this.searchOffset / this.PAGE_SIZE);

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-3 gap-x-3 gap-y-4 w-full pb-2';

        this.searchHits.forEach((hit) => {
            grid.appendChild(this.buildYoutubeHitCard(hit));
        });

        this.gList.appendChild(grid);
        this.sync_search_card_play_buttons();

        if (this.gPageLabel) this.gPageLabel.textContent = 'Page ' + (page + 1);
        if (this.gPrevBtn) this.gPrevBtn.disabled = this.searchOffset === 0;
        if (this.gNextBtn) this.gNextBtn.disabled = !this.searchHasMore;
        if (this.gPager) {
            if (!this.searchHasMore && this.searchOffset === 0) this.gPager.classList.add('hidden');
            else this.gPager.classList.remove('hidden');
        }
        this.gList.scrollTop = 0;
    }

    async runGlobalSearch(q, offset, opts) {
        if (!this.gPanel || !this.gList) return;
        if (AppShellController.spotifyUrlKind(q) === 'track') {
            await this.resolveSpotifyTrackAndSearch(q);
            return;
        }
        if (offset == null) offset = 0;
        const silent = !!(opts && opts.silent);
        const fresh = !!(opts && opts.fresh);
        this.closeAddToPlaylistPopover();
        this.currentSearchQuery = (q || '').trim();
        this.searchOffset = Math.max(0, Number(offset) || 0);
        if (!silent) {
            this.searchHits = [];
            this.searchHasMore = false;
            this.gPanel.classList.remove('hidden');
            if (this.gLabel) this.gLabel.textContent = 'Results for "' + q + '"';
            if (this.gMsg) { this.gMsg.textContent = 'Searching…'; this.gMsg.classList.remove('hidden'); }
            this.gList.innerHTML = '';
            if (this.gPager) this.gPager.classList.add('hidden');
        }
        try {
            let url = '/api/search/songs?q=' + encodeURIComponent(q) + '&limit=' + this.PAGE_SIZE + '&offset=' + this.searchOffset;
            if (fresh) url += '&fresh=1';
            const r = await fetch(url);
            if (!r.ok) {
                const err = await r.json().catch(function () { return {}; });
                if (!silent && this.gMsg) { this.gMsg.textContent = typeof err.detail === 'string' ? err.detail : 'Search failed'; }
                return;
            }
            const payload = await r.json();
            const hits = Array.isArray(payload) ? payload : (payload.hits || []);
            if (!Array.isArray(payload)) {
                this.searchHasMore = Boolean(payload.has_more);
            }
            if (this.gMsg) this.gMsg.classList.add('hidden');
            if (!hits.length) {
                if (!silent && this.gMsg) { this.gMsg.textContent = 'No results.'; this.gMsg.classList.remove('hidden'); }
                if (this.gPager) this.gPager.classList.add('hidden');
                return;
            }
            const prev_vids = this.searchHits.map((h) => h.video_id || '');
            this.searchHits = hits;
            const new_vids = hits.map((h) => h.video_id || '');
            const skip_render = silent
                && prev_vids.length === new_vids.length
                && prev_vids.every(function (id, i) { return id === new_vids[i]; });
            if (!skip_render && !this.gPanel.classList.contains('hidden')) this.renderPage();
        } catch (e) {
            if (!silent && this.gMsg) { this.gMsg.textContent = 'Search failed (network).'; this.gMsg.classList.remove('hidden'); }
        }
    }

    // ---- boot ----------------------------------------------------------------

    async boot() {
        new SpolocalMobileSheetDrawers().mount();

        // Cache DOM refs
        this.topForm = document.getElementById('top-import-form');
        this.topInput = document.getElementById('top-import-input');
        this.gPanel = document.getElementById('global-search-panel');
        this.gLabel = document.getElementById('global-search-label');
        this.gMsg = document.getElementById('global-search-msg');
        this.gList = document.getElementById('global-search-list');
        this.gPager = document.getElementById('global-search-pager');
        this.gPrevBtn = document.getElementById('global-prev-btn');
        this.gNextBtn = document.getElementById('global-next-btn');
        this.gPageLabel = document.getElementById('global-page-label');
        this.gClose = document.getElementById('global-search-close');
        this.previewAudio = document.getElementById('song-preview-audio');
        this.atpPop = document.getElementById('add-to-playlist-popover');
        this.atpFilter = document.getElementById('atp-filter');
        this.atpListInner = document.getElementById('atp-list-inner');
        this.atpNewToggle = document.getElementById('atp-new-toggle');
        this.atpNewRow = document.getElementById('atp-new-row');
        this.atpNewForm = document.getElementById('atp-new-form');
        this.atpNewName = document.getElementById('atp-new-name');
        this.atpDownloadTiers = document.getElementById('atp-download-tiers');
        this.atpDownloadValue = document.getElementById('atp-download-kbps-value');

        // Download quality tier group
        if (window.SpolocalQualityPrefs && this.atpDownloadTiers) {
            window.SpolocalQualityPrefs.bindTierGroup(
                this.atpDownloadTiers,
                () => window.SpolocalQualityPrefs.downloadKbps(),
                (v) => window.SpolocalQualityPrefs.setDownloadKbps(v),
                () => this.syncAtpQualityUi(),
            );
        }
        this.syncAtpQualityUi();

        // Expose controller methods on window (other modules + templates call these)
        window.resetSpolocalSearchCards = () => this.reset_search_card_buttons();
        window.spolocalStreamSrc = AppShellController.streamSrcForVideoId;
        window.nextSpolocalStreamLoadGen = () => this.next_stream_load_gen();
        window.stopSearchStream = (opts) => this.stopPreview(opts);
        try { window.playPreview = (hit, btn) => this.playPreview(hit, btn); } catch (e) {}
        try { window.openAddToPlaylistAtPoint = (hit, x, y) => this.openAddToPlaylistAtPoint(hit, x, y); } catch (e) {}
        window.closeGlobalSearch = () => this.closeGlobalSearch();
        window.loadPlaylistRecommendations = (pid) => this.loadPlaylistRecommendations(pid);
        window.ensurePlaylistRecommendations = (pid) => this.ensurePlaylistRecommendations(pid);
        window.refreshSidebarPlaylistList = async (activePlaylistId) => {
            // A finished download changes track status/variants; drop cached views.
            if (typeof window.invalidatePlaylistViewCache === 'function') {
                window.invalidatePlaylistViewCache();
            }
            const changed = await this.reloadPlaylistsCatalog();
            this.syncLikedPlaylistId();
            this.ensureSidebarLikedRow();
            const pid = activePlaylistId != null ? activePlaylistId : (window.__spaPlaylistId || '');
            // Rebuilding the list recreates every <img>; skip it when nothing changed.
            if (!changed && pid === this._sidebarActiveId) return;
            this.renderSidebarPlaylistList(pid);
        };
        window.applyQualityAwareCovers = (root) => this.applyQualityAwareCovers(root);
        window.renderSpolocalMixRows = (container, hits, opts) => {
            this.render_playlist_recommendation_rows(container, hits, opts || {});
        };
        window.bustPlaylistCoverImages = (root) => this.bustPlaylistCoverImages(root);

        await this.reloadPlaylistsCatalog();
        window.__playlistsCatalog = this.playlistsCatalog;
        // The sidebar is server-rendered; remember its active id so the first
        // refresh does not rebuild (and reload) every tile.
        this._sidebarActiveId = String(window.__spaPlaylistId || '').trim();
        this.syncLikedPlaylistId();
        this.ensureSidebarLikedRow();
        // A PWA launch can serve the document without the session cookie even
        // though API calls carry it. Rebuild the guest sidebar from the catalog.
        const hint_wrap = document.getElementById('sidebar-login-hint-wrap');
        if (hint_wrap && this.playlistsCatalog.length) {
            hint_wrap.classList.add('hidden');
            this.renderSidebarPlaylistList(this._sidebarActiveId);
        }
        if (typeof window.refreshHomeView === 'function') window.refreshHomeView();

        // Preview audio ends/errors
        if (this.previewAudio) {
            this.previewAudio.addEventListener('ended', () => this.stopPreview());
            this.previewAudio.addEventListener('error', () => this.stopPreview());
        }

        // Add-to-playlist popover bindings
        if (this.atpNewToggle && this.atpNewRow) {
            this.atpNewToggle.addEventListener('click', () => {
                this.atpNewRow.classList.toggle('hidden');
            });
        }

        if (this.atpNewForm) {
            this.atpNewForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const name = (this.atpNewName && this.atpNewName.value ? this.atpNewName.value : '').trim();
                if (!name) return;
                const submitBtn = this.atpNewForm.querySelector('button[type="submit"]');
                if (submitBtn) submitBtn.disabled = true;
                try {
                    const hit = this.pendingAddHit;
                    const created = await AppShellController.createPlaylistFromAtp(name, hit);
                    const plId = created && created.playlist && created.playlist.id;
                    if (!plId) throw new Error('Could not create playlist.');
                    if (hit) {
                        // The server already added the track and queued its download.
                        await this.afterTrackAddedToPlaylist(plId);
                        this.closeAddToPlaylistPopover();
                    } else {
                        await this.reloadPlaylistsCatalog();
                        this.renderSidebarPlaylistList(plId);
                        if (typeof window.navigatePlaylist === 'function') {
                            await window.navigatePlaylist(plId, true);
                        }
                        if (this.atpNewName) this.atpNewName.value = '';
                        if (this.atpNewRow) this.atpNewRow.classList.add('hidden');
                        this.renderAtpList();
                    }
                } catch (err) {
                    alert(err && err.message ? err.message : 'Could not create playlist.');
                } finally {
                    if (submitBtn) submitBtn.disabled = false;
                }
            });
        }

        if (this.atpFilter) {
            this.atpFilter.addEventListener('input', () => this.renderAtpList());
        }

        document.addEventListener('click', (e) => {
            if (!this.atpPop || this.atpPop.classList.contains('hidden')) return;
            if (this.atpPop.contains(e.target)) return;
            if (e.target.closest && e.target.closest('.open-add-to-playlist')) return;
            this.closeAddToPlaylistPopover();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (this.atpPop && !this.atpPop.classList.contains('hidden')) {
                this.closeAddToPlaylistPopover();
                e.preventDefault();
                return;
            }
            if (this.gPanel && !this.gPanel.classList.contains('hidden')) {
                this.closeGlobalSearch();
                e.preventDefault();
            }
        });

        window.addEventListener('resize', () => {
            if (this.atpPop && !this.atpPop.classList.contains('hidden') && this.lastAtpAnchor) {
                this.positionAddPopover(this.lastAtpAnchor);
            }
        });

        if (this.gClose) this.gClose.addEventListener('click', () => this.closeGlobalSearch());

        const player_audio = document.getElementById('player-audio');
        if (player_audio) {
            player_audio.addEventListener('play', () => this.sync_search_card_play_buttons());
            player_audio.addEventListener('pause', () => this.sync_search_card_play_buttons());
        }

        // Search panel pagination
        if (this.gPrevBtn) this.gPrevBtn.addEventListener('click', () => {
            if (this.searchOffset === 0) return;
            this.searchOffset = Math.max(0, this.searchOffset - this.PAGE_SIZE);
            this.runGlobalSearch(this.currentSearchQuery, this.searchOffset);
        });
        if (this.gNextBtn) this.gNextBtn.addEventListener('click', () => {
            if (!this.searchHasMore) return;
            this.searchOffset += this.PAGE_SIZE;
            this.runGlobalSearch(this.currentSearchQuery, this.searchOffset);
        });

        // Top import/search form
        if (this.topForm) {
            this.topForm.addEventListener('submit', (e) => {
                const val = this.topInput ? this.topInput.value.trim() : '';
                if (!val) {
                    e.preventDefault();
                    if (this.topInput) this.topInput.focus();
                    if (this.gMsg) {
                        this.gMsg.textContent = 'Type a search term or paste a link to import.';
                        this.gMsg.classList.remove('hidden');
                    }
                    if (this.gPanel) {
                        this.gPanel.classList.remove('hidden');
                    }
                    if (this.gLabel) {
                        this.gLabel.textContent = 'Search';
                    }
                    return;
                }
                if (!AppShellController.isUrl(val)) {
                    e.preventDefault();
                    this.runGlobalSearch(val);
                    return;
                }
                if (AppShellController.spotifyUrlKind(val) === 'track') {
                    e.preventDefault();
                    void this.resolveSpotifyTrackAndSearch(val).catch((err) => {
                        const msg = err && err.message ? err.message : 'Could not open Spotify track.';
                        if (this.gPanel) this.gPanel.classList.remove('hidden');
                        if (this.gLabel) this.gLabel.textContent = 'Search';
                        if (this.gMsg) {
                            this.gMsg.textContent = msg;
                            this.gMsg.classList.remove('hidden');
                        }
                    });
                }
            });
        }

        // Quality changed events (recs + covers)
        if (!window.__spolocalRecsQualityBound) {
            window.__spolocalRecsQualityBound = true;
            window.addEventListener('spolocal:playback-quality-changed', () => {
                const pid = String(typeof window.__spaPlaylistId === 'string' ? window.__spaPlaylistId : '');
                if (pid) this.loadPlaylistRecommendations(pid);
            });
        }
        window.addEventListener('spolocal:playback-quality-changed', () => {
            this.applyQualityAwareCovers(document);
        });

        // Initial load: the recs block is server-rendered, but only applySpaPlaylist()
        // wires it up. Attach the observer here too. It still fetches only once the
        // section is scrolled into view (no eager load).
        if (typeof window.__spaPlaylistId === 'string' && window.__spaPlaylistId) {
            this.loadPlaylistRecommendations(window.__spaPlaylistId);
        }
    }

    applyQualityAwareCovers(root) {
        const covers = window.SpolocalCoverUrls;
        if (!covers) return;
        const el = root || document;
        const pid = String(window.__spaPlaylistId || '').trim();
        el.querySelectorAll('img[src*="/tracks/"][src*="/cover"]').forEach((img) => {
            // Track rows are handled below with the full cover URL; rewriting
            // them here first would make the browser fetch the image twice.
            if (img.closest('tr.track-row[data-track-id]')) return;
            const src = img.getAttribute('src');
            if (!src) return;
            img.src = AppShellController.withCoverQuality(src);
            img.style.opacity = '';
        });
        el.querySelectorAll('tr.track-row[data-track-id]').forEach((tr) => {
            const img = tr.querySelector('img');
            if (!img) return;
            const tid = String(tr.getAttribute('data-track-id') || '').trim();
            const vid = String(tr.getAttribute('data-youtube-video-id') || '').trim();
            const next = covers.trackCoverUrl(pid, tid, vid);
            if (next) img.src = next;
        });
        el.querySelectorAll('#playlist-recommendations-grid img[data-video-id], #playlist-recommendations-table img[data-video-id], #song-mix-table img[data-video-id]').forEach((img) => {
            const vid = String(img.getAttribute('data-video-id') || '').trim();
            const next = covers.youtubeThumbUrl(vid);
            if (next) img.src = next;
        });
    }

    bustPlaylistCoverImages(root) {
        // Kept for callers, but no longer forces a re-download: cover URLs are
        // stable per track and cached by the browser for a week.
        const el = root || document;
        if (typeof window.applyQualityAwareCovers === 'function') {
            window.applyQualityAwareCovers(el);
        }
    }
}

window.AppShell = new AppShellController();
window.AppShell.boot().catch(function () {});