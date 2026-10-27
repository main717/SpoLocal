import { LyricsColorExtractor } from './lyrics_colors.js?v=1';
import { LyricsVisualizerController } from './lyrics_visualizer.js?v=1';
import { LyricsEditorController } from './lyrics_editor.js?v=2';

/**
 * Controller for lyrics display, fetching, and editing.
 * Responsibilities:
 * - Fetch lyrics from the server and render them (plain text or LRC)
 * - Synchronize LRC highlighting with audio playback
 * - Manage LRC editor state and persistence
 * - Dynamically calculate and apply lyrics panel colors based on cover art
 */
export class PlaylistLyricsController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state, transport, queue) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./transport_controller.js').PlaylistTransportController|null} */
        this.transport = transport;
        /** @type {import('./queue_controller.js').PlaylistQueueController|null} */
        this.queue = queue;
        this.colors = new LyricsColorExtractor();
        this.visualizer = new LyricsVisualizerController(state);
        this.editor = new LyricsEditorController(state, this);
    }

    /** Initialize lyrics-related event wiring (toggle buttons, editor actions). */
    init() {
        const hub = this.state.hub;
        if (!hub) return;
        // Avoid double-binding when init runs multiple times
        if (hub._lyrics_controller_bound) return;
        hub._lyrics_controller_bound = true;
        hub.lyricsController = this;
        hub.lyricsUserScrollUntil = 0;
        hub._lyricsCenterGen = 0;
        this.visualizer.init();
        this.bind_lyrics_user_scroll();
        this.bind_stream_video();

        // Toggle lyrics panel
        if (Array.isArray(hub.lyricsToggleButtons)) {
            hub.lyricsToggleButtons.forEach(btn => {
                if (!btn) return;
                if (btn.dataset.lyricsBound) return;
                btn.dataset.lyricsBound = '1';
                btn.addEventListener('click', () => {
                    this.toggleLyrics();
                });
            });
        }

        // Tabs and editor controls
        if (hub.lyricsTabRead && !hub.lyricsTabRead.dataset.bound) {
            hub.lyricsTabRead.dataset.bound = '1';
            hub.lyricsTabRead.addEventListener('click', () => { this.setLyricsMode('read'); });
        }
        if (hub.lyricsTabEdit && !hub.lyricsTabEdit.dataset.bound) {
            hub.lyricsTabEdit.dataset.bound = '1';
            hub.lyricsTabEdit.addEventListener('click', () => { this.setLyricsMode('edit'); });
        }
        this.bind_lyrics_view_tabs();
        if (hub.lyricsCancelEdit && !hub.lyricsCancelEdit.dataset.bound) {
            hub.lyricsCancelEdit.dataset.bound = '1';
            hub.lyricsCancelEdit.addEventListener('click', () => { this.setLyricsMode('read'); });
        }

        // Global shift buttons
        if (hub.lrcShiftMinus && !hub.lrcShiftMinus.dataset.bound) {
            hub.lrcShiftMinus.dataset.bound = '1';
            hub.lrcShiftMinus.addEventListener('click', () => { this.editor.shiftAllTimestamps(-1000); });
        }
        if (hub.lrcShiftPlus && !hub.lrcShiftPlus.dataset.bound) {
            hub.lrcShiftPlus.dataset.bound = '1';
            hub.lrcShiftPlus.addEventListener('click', () => { this.editor.shiftAllTimestamps(1000); });
        }

        // Lyrics close button
        if (hub.lyricsClose && !hub.lyricsClose.dataset.bound) {
            hub.lyricsClose.dataset.bound = '1';
            hub.lyricsClose.addEventListener('click', () => {
                if (hub.lyricsVisible) {
                    this.toggleLyrics();
                }
            });
        }

        // Save / editor actions (wire if save button exists)
        if (hub.lyricsSaveBtn && !hub.lyricsSaveBtn.dataset.bound) {
            hub.lyricsSaveBtn.dataset.bound = '1';
            hub.lyricsSaveBtn.addEventListener('click', async () => {
                try { await this.editor.saveLyrics(); } catch (e) {}
            });
        }
    }

    bind_lyrics_view_tabs() {
        const hub = this.state.hub;
        const tabs = [
            [hub.lyricsTabLyrics, 'lyrics'],
            [hub.lyricsTabVideo, 'video'],
        ];
        tabs.forEach(([tab, view]) => {
            if (!tab || tab.dataset.bound) return;
            tab.dataset.bound = '1';
            tab.addEventListener('click', () => this.set_lyrics_view(view));
        });
    }

    bind_lyrics_user_scroll() {
        const hub = this.state.hub;
        if (hub._lyricsUserScrollBound) return;
        hub._lyricsUserScrollBound = true;
        const pause_autoscroll = (e) => {
            if (!hub.lyricsVisible) return;
            if (Date.now() < (hub._lyricsOpenFollowUntil || 0)) return;
            const wrap = hub.lyricsViewWrap;
            const t = e.target;
            if (!wrap || !t || !wrap.contains(t)) return;
            if (e.type === 'wheel' && Math.abs(e.deltaY || 0) < 2 && Math.abs(e.deltaX || 0) < 2) return;
            hub.lyricsUserScrollUntil = Date.now() + 2000;
            hub._lyricsCenterGen = (hub._lyricsCenterGen || 0) + 1;
            this.stop_lyrics_scroll_anim();
        };
        document.addEventListener('wheel', pause_autoscroll, { capture: true, passive: true });
        document.addEventListener('touchmove', pause_autoscroll, { capture: true, passive: true });
        document.addEventListener('pointerdown', (e) => {
            if (!hub.lyricsVisible || e.pointerType === 'mouse' && e.button !== 0) return;
            if (Date.now() < (hub._lyricsOpenFollowUntil || 0)) return;
            const wrap = hub.lyricsViewWrap;
            if (e.target && e.target.closest && e.target.closest('.lyrics-line')) return;
            if (wrap && wrap.contains(e.target)) {
                hub.lyricsUserScrollUntil = Date.now() + 2000;
                hub._lyricsCenterGen = (hub._lyricsCenterGen || 0) + 1;
                this.stop_lyrics_scroll_anim();
            }
        }, { capture: true });
    }

    async fetchLyrics(showEmptyMessage) {
        const hub = this.state.hub;
        // Cancel any in-flight request
        if (hub.lyricsAbortController) {
            hub.lyricsAbortController.abort();
            hub.lyricsAbortController = null;
        }

        // Bump generation — any older in-flight response will see a mismatch and discard itself
        const myGen = ++hub.lyricsFetchGen;

        // Clear display immediately
        hub.lastLyricsPayload = { lyrics: '', source: 'none', has_audio: false, lrc_data: null, lrc_raw: null };
        hub.lyricsBody.textContent = '';
        hub.lyricsEditor.value = '';
        hub.lrcEditLines = [];
        if (hub.lrcLinesContainer) hub.lrcLinesContainer.innerHTML = '';
        hub.lyricsEmptyHint.classList.add('hidden');
        hub.lyricsNoAudioHint.classList.add('hidden');
        this.sync_search_lyrics_chrome();
        this.sync_stream_video_pane();
        const searchVid = hub.searchStreamActive && hub.searchStreamHit
            ? String(hub.searchStreamHit.video_id || '').trim()
            : '';
        hub._searchChaptersPayload = null;
        hub._searchLyricsPayload = null;
        hub._searchLyricsKind = '';
        hub._chapterLyricsCache = {};
        hub._chapterLyricsOpenIndex = null;
        hub._lyricsChapterActiveIndex = null;
        hub._lyricsFollowIndex = null;
        hub._verseFollowIndex = null;
        hub.lyricsUserScrollUntil = 0;
        if (!hub.currentTrackId && !searchVid) {
            hub.lastLyricsPayload = { lyrics: '', source: 'none', has_audio: false, lrc_data: null, lrc_raw: null };
            hub.lyricsBody.textContent = 'Select a song to play.';
            return;
        }

        hub.lyricsBody.textContent = 'Loading…';

        const cacheKey = searchVid ? '' : this.lyrics_cache_key();
        const cached = cacheKey ? (hub._lyricsPrefetch && hub._lyricsPrefetch.get(cacheKey)) : null;
        if (cached) {
            hub._lyricsPrefetch.delete(cacheKey);
            this.applyLyricsPayload(cached, showEmptyMessage);
            return;
        }

        const ctrl = new AbortController();
        hub.lyricsAbortController = ctrl;

        try {
            let r;
            if (searchVid) {
                r = await fetch('/api/stream/chapters?vid=' + encodeURIComponent(searchVid), { signal: ctrl.signal });
            } else {
                const lyricsPid = String(hub.playingPlaylistId || hub.playlistId || '').trim();
                r = await fetch(
                    '/playlists/' + encodeURIComponent(lyricsPid) + '/tracks/' + encodeURIComponent(hub.currentTrackId) + '/lyrics',
                    { signal: ctrl.signal }
                );
            }
            if (myGen !== hub.lyricsFetchGen) return;
            if (!r.ok) throw new Error('bad status');
            const j = await r.json();
            if (myGen !== hub.lyricsFetchGen) return;
            if (searchVid) {
                hub._searchChaptersPayload = j;
                hub._searchLyricsKind = (j.source === 'chapters') ? 'chapters' : 'none';
            }
            this.applyLyricsPayload(j, showEmptyMessage);
            if (!searchVid) this.prefetch_next_lyrics();
            if (searchVid && hub._searchLyricsKind !== 'chapters') {
                await this.load_stream_lyrics(myGen);
            }
        } catch (e) {
            if (myGen !== hub.lyricsFetchGen) return;
            if (e.name === 'AbortError') return;
            hub.lyricsBody.textContent = 'Could not load lyrics.';
        }
    }

    lyrics_cache_key() {
        const hub = this.state.hub;
        if (!hub.currentTrackId) return '';
        const pid = String(hub.playingPlaylistId || hub.playlistId || '').trim();
        return pid + ':' + hub.currentTrackId;
    }

    /** Warm the lyrics endpoint for the next few tracks so switching is instant. */
    prefetch_next_lyrics() {
        const hub = this.state.hub;
        if (hub.searchStreamActive) return;
        const prefs = window.SpolocalQualityPrefs;
        if (prefs && prefs.playbackKbps() <= 64) return;
        const pid = String(hub.playingPlaylistId || hub.playlistId || '').trim();
        const list = Array.isArray(hub.playable) ? hub.playable : [];
        if (!pid || !list.length) return;
        const idx = list.findIndex((e) => String(e.id) === String(hub.currentTrackId));
        if (idx < 0) return;
        const cache = hub._lyricsPrefetch || (hub._lyricsPrefetch = new Map());
        const seen = new Set();
        for (let step = 1; step <= 3 && step < list.length; step++) {
            const entry = list[(idx + step) % list.length];
            if (!entry || !entry.id || seen.has(entry.id)) continue;
            seen.add(entry.id);
            const key = pid + ':' + entry.id;
            if (cache.has(key)) continue;
            cache.set(key, null);
            fetch('/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(entry.id) + '/lyrics')
                .then((r) => (r.ok ? r.json() : null))
                .then((j) => { if (j) cache.set(key, j); else cache.delete(key); })
                .catch(() => cache.delete(key));
        }
        while (cache.size > 12) cache.delete(cache.keys().next().value);
    }

    sync_search_lyrics_chrome() {
        const hub = this.state.hub;
        const searchOn = !!(hub.searchStreamActive && hub.searchStreamHit);
        if (hub.lyricsTitle) {
            const kind = hub._searchLyricsKind || '';
            hub.lyricsTitle.textContent = searchOn
                ? (kind === 'lyrics' ? 'Lyrics' : 'Chapters')
                : 'Lyrics';
        }
        if (hub.lyricsModeSwitch) {
            hub.lyricsModeSwitch.classList.toggle('hidden', searchOn);
        }
        if (searchOn && hub.lyricsMode !== 'read') {
            this.setLyricsMode('read');
        }
        if (hub.lyricsEmptyHint && hub._lyricsEmptyHintDefault == null) {
            hub._lyricsEmptyHintDefault = hub.lyricsEmptyHint.innerHTML;
        }
        if (hub.lyricsEmptyHint && hub._lyricsEmptyHintDefault != null && !searchOn) {
            hub.lyricsEmptyHint.innerHTML = hub._lyricsEmptyHintDefault;
        }
    }

    applyLyricsPayload(j, showHints) {
        const hub = this.state.hub;
        hub.lastLyricsPayload = {
            lyrics: j.lyrics || '',
            source: j.source || 'none',
            has_audio: !!j.has_audio,
            lrc_data: j.lrc_data || null,
            lrc_raw: j.lrc_raw || null
        };
        hub.lyricsBody.textContent = '';
        hub.lyricsEmptyHint.classList.add('hidden');
        hub.lyricsNoAudioHint.classList.add('hidden');
        const searchOn = !!(hub.searchStreamActive && hub.searchStreamHit);
        if (!hub.currentTrackId && !searchOn) {
            return;
        }
        if (!searchOn && !hub.lastLyricsPayload.has_audio) {
            hub.lyricsNoAudioHint.classList.remove('hidden');
            return;
        }

        const text = (hub.lastLyricsPayload.lyrics || '').trim();
        const is_chapters = searchOn && hub.lastLyricsPayload.source === 'chapters'
            && hub.lastLyricsPayload.lrc_data && hub.lastLyricsPayload.lrc_data.length > 0;
        if (is_chapters) {
            this.render_chapter_rows(hub.lastLyricsPayload.lrc_data);
            if (hub.lyricsMode === 'read') this.schedule_lyrics_open_follow();
        } else if (text) {
            if (hub.lastLyricsPayload.lrc_data && Array.isArray(hub.lastLyricsPayload.lrc_data) && hub.lastLyricsPayload.lrc_data.length > 0) {
                this.renderLrcLines(hub.lastLyricsPayload.lrc_data);
                if (hub.lyricsMode === 'read') {
                    this.schedule_lyrics_open_follow();
                }
            } else {
                this.render_plain_lyrics_lines(hub.lastLyricsPayload.lyrics);
            }
        } else if (showHints) {
            if (searchOn && hub.lyricsEmptyHint) {
                const kind = hub._searchLyricsKind || '';
                if (kind === 'lyrics') {
                    hub.lyricsEmptyHint.textContent = 'No lyrics found for this search.';
                } else {
                    hub.lyricsEmptyHint.textContent = 'No chapter timestamps on this video.';
                }
                hub.lyricsEmptyHint.classList.remove('hidden');
            } else {
                hub.lyricsEmptyHint.classList.remove('hidden');
            }
        }
        if (!searchOn && hub.lyricsMode === 'edit') {
            this.setLyricsMode('edit');
        }
    }

    async load_stream_lyrics(myGen) {
        const hub = this.state.hub;
        if (myGen != null && myGen !== hub.lyricsFetchGen) return;
        if (hub._searchLyricsPayload) {
            hub._searchLyricsKind = 'lyrics';
            this.applyLyricsPayload(hub._searchLyricsPayload, true);
            this.sync_search_lyrics_chrome();
            return;
        }
        const hit = hub.searchStreamHit || {};
        const title = String(hit.title || (hub.titleEl && hub.titleEl.textContent) || '').trim();
        const artist = String(
            hit.artist || hit.channel || (hub.subEl && hub.subEl.textContent) || ''
        ).trim();
        if (!title) return;
        hub.lyricsBody.textContent = 'Loading lyrics…';
        try {
            const r = await fetch(
                '/api/stream/lyrics?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist),
                { credentials: 'same-origin' },
            );
            if (myGen != null && myGen !== hub.lyricsFetchGen) return;
            if (!r.ok) throw new Error('bad status');
            const j = await r.json();
            if (myGen != null && myGen !== hub.lyricsFetchGen) return;
            hub._searchLyricsPayload = j;
            hub._searchLyricsKind = (j.lyrics || '').trim() ? 'lyrics' : 'none';
            this.applyLyricsPayload(j, true);
            this.sync_search_lyrics_chrome();
        } catch (e) {
            if (myGen != null && myGen !== hub.lyricsFetchGen) return;
            if (hub.lyricsEmptyHint) hub.lyricsEmptyHint.classList.add('hidden');
            hub.lyricsBody.textContent = 'Could not load lyrics.';
        }
    }

    chapter_song_title(item) {
        return String((item && item.text) || '').replace(/^\d+:\d+(?::\d+)?\s+/, '').trim();
    }

    chapter_lyrics_artist() {
        const hub = this.state.hub;
        const hit = hub.searchStreamHit || {};
        const vtitle = String(hit.title || (hub.titleEl && hub.titleEl.textContent) || '').trim();
        const m = vtitle.match(/^(.+?)\s+(greatest|best of|compilation|full album)\b/i);
        if (m) return m[1].trim();
        return String(hit.artist || hit.channel || (hub.subEl && hub.subEl.textContent) || '').trim();
    }

    render_chapter_rows(lrcData) {
        const hub = this.state.hub;
        hub.lyricsBody.textContent = '';
        if (!hub._chapterLyricsCache) hub._chapterLyricsCache = {};
        const open_idx = hub._chapterLyricsOpenIndex;
        lrcData.forEach((item, index) => {
            const block = document.createElement('div');
            block.className = 'lyrics-chapter';
            block.dataset.chapterIndex = String(index);

            const row = document.createElement('div');
            row.className = 'lyrics-chapter-row';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lyrics-chapter-load-btn';
            btn.textContent = hub._chapterLyricsCache[index] ? 'Lyrics' : 'Load lyrics';
            const on_lyrics_btn = (e) => {
                e.preventDefault();
                e.stopPropagation();
                void this.toggle_chapter_lyrics(index, item, btn);
            };
            btn.addEventListener('pointerdown', on_lyrics_btn, true);

            const line = document.createElement('div');
            line.className = 'lyrics-line lyrics-line--chapter nowrap';
            line.textContent = item.text;
            line.dataset.timeMs = item.time_ms;
            line.addEventListener('click', () => {
                const timeMs = parseInt(line.dataset.timeMs, 10);
                if (!isNaN(timeMs) && hub.audio) {
                    hub.audio.currentTime = timeMs / 1000;
                    if (hub.audio.paused) {
                        hub.audio.play().catch((err) => {
                            if (this.transport) this.transport.handlePlayError(err);
                        });
                    }
                }
                this.collapse_open_chapter_lyrics();
                hub.lyricsUserScrollUntil = 0;
                this.center_lyrics_el(line);
            });

            row.appendChild(btn);
            row.appendChild(line);

            const panel = document.createElement('div');
            panel.className = 'lyrics-chapter-panel hidden';

            block.appendChild(row);
            block.appendChild(panel);
            hub.lyricsBody.appendChild(block);
        });
        if (open_idx != null && hub._chapterLyricsCache[open_idx]) {
            this.show_chapter_lyrics_panel(open_idx, hub._chapterLyricsCache[open_idx]);
        } else {
            hub._chapterLyricsOpenIndex = null;
        }
    }

    chapter_panel_el(index) {
        const hub = this.state.hub;
        const block = hub.lyricsBody.querySelector('.lyrics-chapter[data-chapter-index="' + index + '"]');
        return block ? block.querySelector('.lyrics-chapter-panel') : null;
    }

    chapter_load_btn(index) {
        const hub = this.state.hub;
        const block = hub.lyricsBody.querySelector('.lyrics-chapter[data-chapter-index="' + index + '"]');
        return block ? block.querySelector('.lyrics-chapter-load-btn') : null;
    }

    collapse_open_chapter_lyrics() {
        const hub = this.state.hub;
        const idx = hub._chapterLyricsOpenIndex;
        if (idx == null) return;
        const panel = this.chapter_panel_el(idx);
        if (panel) panel.classList.add('hidden');
        const btn = this.chapter_load_btn(idx);
        if (btn) btn.textContent = hub._chapterLyricsCache && hub._chapterLyricsCache[idx] ? 'Lyrics' : 'Load lyrics';
        hub._chapterLyricsOpenIndex = null;
        hub._verseFollowIndex = null;
    }

    show_chapter_lyrics_panel(index, payload) {
        const hub = this.state.hub;
        this.collapse_open_chapter_lyrics();
        const panel = this.chapter_panel_el(index);
        if (!panel) return;
        panel.classList.remove('hidden');
        panel.textContent = '';
        const chapters = hub.lastLyricsPayload && hub.lastLyricsPayload.lrc_data;
        const chapter_start_ms = (chapters && chapters[index] && chapters[index].time_ms) || 0;
        const body = document.createElement('div');
        body.className = 'lyrics-chapter-verse';
        const lrc = payload && Array.isArray(payload.lrc_data) ? payload.lrc_data : null;
        const text = (payload && payload.lyrics) ? String(payload.lyrics).trim() : '';
        if (lrc && lrc.length) {
            this.render_chapter_verse_lrc(body, lrc, chapter_start_ms);
        } else if (text) {
            this.render_chapter_verse_plain(body, text);
        } else {
            body.textContent = 'No lyrics found.';
        }
        panel.appendChild(body);
        hub._chapterLyricsOpenIndex = index;
        hub._verseFollowIndex = null;
        const btn = this.chapter_load_btn(index);
        if (btn) btn.textContent = 'Hide';
    }

    render_chapter_verse_lrc(body, lrcData, chapter_start_ms) {
        const hub = this.state.hub;
        const containerWidth = body.clientWidth || hub.lyricsBody.clientWidth;
        const lineElements = lrcData.map((item) => {
            const line = document.createElement('div');
            line.textContent = item.text;
            line.className = 'lyrics-line lyrics-line--verse nowrap';
            line.dataset.timeMs = String(chapter_start_ms + (item.time_ms || 0));
            line.style.fontWeight = '700';
            line.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const timeMs = parseInt(line.dataset.timeMs, 10);
                if (!isNaN(timeMs) && hub.audio) {
                    hub.audio.currentTime = timeMs / 1000;
                    if (hub.audio.paused) {
                        hub.audio.play().catch((err) => {
                            if (this.transport) this.transport.handlePlayError(err);
                        });
                    }
                }
                hub.lyricsUserScrollUntil = 0;
                this.center_lyrics_el(line);
            });
            body.appendChild(line);
            return line;
        });
        body.offsetHeight;
        lineElements.forEach((line) => {
            const scaledWidth = line.scrollWidth * 1.08;
            if (scaledWidth > containerWidth - 8) {
                line.classList.remove('nowrap');
                line.classList.add('wrap');
            }
            line.style.fontWeight = '';
        });
    }

    render_chapter_verse_plain(body, raw) {
        const parts = String(raw || '').replace(/\r\n/g, '\n').split('\n');
        parts.forEach((chunk) => {
            const line = document.createElement('div');
            line.textContent = chunk;
            line.className = 'lyrics-line lyrics-line--verse lyrics-line--static nowrap';
            body.appendChild(line);
        });
    }

    async toggle_chapter_lyrics(index, item, btn) {
        const hub = this.state.hub;
        if (hub._chapterLyricsOpenIndex === index) {
            this.collapse_open_chapter_lyrics();
            return;
        }
        if (hub._chapterLyricsCache && hub._chapterLyricsCache[index]) {
            this.show_chapter_lyrics_panel(index, hub._chapterLyricsCache[index]);
            return;
        }
        const title = this.chapter_song_title(item);
        const artist = this.chapter_lyrics_artist();
        if (!title) return;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Loading…';
        }
        try {
            const r = await fetch(
                '/api/stream/lyrics?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist),
                { credentials: 'same-origin' },
            );
            if (!r.ok) throw new Error('bad status');
            const j = await r.json();
            if (!hub._chapterLyricsCache) hub._chapterLyricsCache = {};
            hub._chapterLyricsCache[index] = j;
            this.show_chapter_lyrics_panel(index, j);
        } catch (e) {
            const panel = this.chapter_panel_el(index);
            if (panel) {
                panel.classList.remove('hidden');
                panel.textContent = 'Could not load lyrics.';
                hub._chapterLyricsOpenIndex = index;
            }
        } finally {
            if (btn) btn.disabled = false;
            const b = this.chapter_load_btn(index);
            if (b && hub._chapterLyricsOpenIndex !== index) {
                b.textContent = hub._chapterLyricsCache && hub._chapterLyricsCache[index] ? 'Lyrics' : 'Load lyrics';
            }
        }
    }

    render_plain_lyrics_lines(raw) {
        const hub = this.state.hub;
        hub.lyricsBody.textContent = '';
        const body = (raw || '').replace(/\r\n/g, '\n');
        const parts = body.split('\n');
        const containerWidth = hub.lyricsBody.clientWidth;

        const lineElements = parts.map(function(chunk) {
            const line = document.createElement('div');
            line.textContent = chunk;
            line.className = 'lyrics-line lyrics-line--static nowrap';
            line.style.fontWeight = '700';
            hub.lyricsBody.appendChild(line);
            return line;
        });

        hub.lyricsBody.offsetHeight;
        lineElements.forEach(function(line) {
            const boldWidth = line.scrollWidth;
            const scaledWidth = boldWidth * 1.15;
            if (scaledWidth > containerWidth - 8) {
                line.classList.remove('nowrap');
                line.classList.add('wrap');
            }
            line.style.fontWeight = '';
        });
    }

    renderLrcLines(lrcData) {
        const hub = this.state.hub;
        hub.lyricsBody.textContent = '';

        // We measure each line in its WORST-CASE state (active: bold + scaled 1.15x).
        // If the bold version still fits within container, the line stays single-line.
        // Otherwise we let it wrap. CSS max-width: 86% caps wrapped lines to fit when scaled.
        const containerWidth = hub.lyricsBody.clientWidth;

        const createLine = (item) => {
            const line = document.createElement('div');
            line.textContent = item.text;
            line.dataset.timeMs = item.time_ms;
            line.addEventListener('click', () => {
                const timeMs = parseInt(line.dataset.timeMs, 10);
                if (!isNaN(timeMs) && hub.audio) {
                    hub.audio.currentTime = timeMs / 1000;
                    if (hub.audio.paused) {
                        hub.audio.play().catch(err => { if (this.transport) this.transport.handlePlayError(err); });
                    }
                }
                hub.lyricsUserScrollUntil = 0;
                this.center_lyrics_el(line);
            });
            return line;
        };

        // Render all lines as nowrap + BOLD (active-state weight) to measure worst-case width.
        const lineElements = lrcData.map((item) => {
            const line = createLine(item);
            line.className = 'lyrics-line nowrap';
            line.style.fontWeight = '700'; // measure as if active
            hub.lyricsBody.appendChild(line);
            return line;
        });

        // Force layout, then check each line's BOLD rendered width.
        // Account for the 1.15x scale by requiring boldWidth * 1.15 <= containerWidth.
        hub.lyricsBody.offsetHeight;
        lineElements.forEach(function(line) {
            const boldWidth = line.scrollWidth;
            const scaledWidth = boldWidth * 1.15;
            if (scaledWidth > containerWidth - 8) {
                line.classList.remove('nowrap');
                line.classList.add('wrap');
            }
            line.style.fontWeight = ''; // remove inline override; CSS controls active state
        });
    }

    schedule_lyrics_open_follow() {
        const hub = this.state.hub;
        hub._lyricsOpenFollowUntil = Date.now() + 2500;
        hub.lyricsUserScrollUntil = 0;
        hub._lyricsFollowIndex = null;
        hub._verseFollowIndex = null;
        let n = 0;
        const go = () => {
            if (!hub.lyricsVisible || hub.lyricsMode !== 'read') return;
            const wrap = hub.lyricsViewWrap;
            if (!wrap) return;
            const ok = wrap.clientHeight > 24
                && wrap.scrollHeight > wrap.clientHeight + 8
                && wrap.querySelector('.lyrics-line, .lyrics-chapter');
            if (!ok) {
                if (n < 40) {
                    n += 1;
                    setTimeout(go, 100);
                }
                return;
            }
            this.updateLyricsActiveLine(true);
        };
        go();
    }

    updateLyricsActiveLine(force) {
        const hub = this.state.hub;
        if (!hub.audio || !hub.lastLyricsPayload.lrc_data || !hub.lyricsVisible || hub.lyricsMode !== 'read') return;

        const currentTimeMs = Math.floor(hub.audio.currentTime * 1000);
        const lines = hub.lyricsBody.querySelectorAll('.lyrics-chapter-row .lyrics-line, :scope > .lyrics-line');
        if (!lines.length) return;

        // Find the active line (exactly at current time)
        let activeIndex = -1;
        for (let i = 0; i < hub.lastLyricsPayload.lrc_data.length; i++) {
            if (hub.lastLyricsPayload.lrc_data[i].time_ms <= currentTimeMs) {
                activeIndex = i;
            } else {
                break;
            }
        }

        const prev_chapter = hub._lyricsChapterActiveIndex;
        hub._lyricsChapterActiveIndex = activeIndex;
        if (
            hub.lastLyricsPayload.source === 'chapters'
            && prev_chapter != null
            && prev_chapter !== activeIndex
        ) {
            this.collapse_open_chapter_lyrics();
        }

        // Update classes
        lines.forEach(function(line, idx) {
            if (idx === activeIndex) {
                line.classList.add('active');
            } else {
                line.classList.remove('active');
            }
        });

        this.sync_chapter_verse_active(currentTimeMs, force);

        // Auto-scroll to keep active chapter centered
        const wrap = hub.lyricsViewWrap;
        if (!wrap || activeIndex < 0 || !lines[activeIndex]) return;
        const same = hub._lyricsFollowIndex === activeIndex;
        hub._lyricsFollowIndex = activeIndex;
        if (!force && same) return;
        if (!force && hub.lyricsUserScrollUntil && Date.now() < hub.lyricsUserScrollUntil) return;
        this.center_lyrics_el(lines[activeIndex], force);
    }

    sync_chapter_verse_active(currentTimeMs, force) {
        const hub = this.state.hub;
        const idx = hub._chapterLyricsOpenIndex;
        if (idx == null) return;
        const payload = hub._chapterLyricsCache && hub._chapterLyricsCache[idx];
        const lrc = payload && Array.isArray(payload.lrc_data) ? payload.lrc_data : null;
        const verse_lines = hub.lyricsBody.querySelectorAll('.lyrics-chapter-verse .lyrics-line--verse');
        if (!lrc || !verse_lines.length) return;
        const chapters = hub.lastLyricsPayload && hub.lastLyricsPayload.lrc_data;
        const start = (chapters && chapters[idx] && chapters[idx].time_ms) || 0;
        const rel = currentTimeMs - start;
        let active = -1;
        for (let i = 0; i < lrc.length; i++) {
            if (lrc[i].time_ms <= rel) active = i;
            else break;
        }
        verse_lines.forEach((line, i) => {
            line.classList.toggle('active', i === active);
        });
        if (active < 0) return;
        const same = hub._verseFollowIndex === active;
        hub._verseFollowIndex = active;
        if (!force && same) return;
        if (!force && hub.lyricsUserScrollUntil && Date.now() < hub.lyricsUserScrollUntil) return;
        this.center_lyrics_el(verse_lines[active], force);
    }

    center_lyrics_el(el, force, retryCount) {
        const hub = this.state.hub;
        const wrap = hub.lyricsViewWrap;
        if (!wrap || !el) return;
        const gen = (hub._lyricsCenterGen = (hub._lyricsCenterGen || 0) + 1);
        const run = () => {
            if (gen !== hub._lyricsCenterGen) return;
            if (!force && hub.lyricsUserScrollUntil && Date.now() < hub.lyricsUserScrollUntil) return;
            const wrap_rect = wrap.getBoundingClientRect();
            const view_h = wrap.clientHeight || wrap_rect.height;
            if (view_h < 8) return;
            const scrollable = wrap.scrollHeight > view_h + 1;
            // offsetTop chain: rects shift while the panel is still animating open
            let offset_in_wrap = el.offsetTop;
            let parent = el.offsetParent;
            while (parent && parent !== wrap) {
                offset_in_wrap += parent.offsetTop || 0;
                parent = parent.offsetParent;
            }
            const el_center = offset_in_wrap + (el.offsetHeight / 2);
            const target_center = wrap.scrollTop + (view_h / 2);
            const delta = el_center - target_center;
            if (!scrollable) {
                if (force && (retryCount || 0) < 5) {
                    setTimeout(() => {
                        if (gen !== hub._lyricsCenterGen) return;
                        this.center_lyrics_el(el, force, (retryCount || 0) + 1);
                    }, 120);
                }
                return;
            }
            if (force || Math.abs(delta) > 2) {
                this.animate_lyrics_wrap_scroll(wrap, wrap.scrollTop + delta, force);
            }
        };
        requestAnimationFrame(() => requestAnimationFrame(run));
    }

    stop_lyrics_scroll_anim() {
        const hub = this.state.hub;
        if (hub._lyricsScrollAnim) {
            cancelAnimationFrame(hub._lyricsScrollAnim);
            hub._lyricsScrollAnim = 0;
        }
    }

    animate_lyrics_wrap_scroll(wrap, target_top, force) {
        const hub = this.state.hub;
        this.stop_lyrics_scroll_anim();
        const start = wrap.scrollTop;
        const dist = target_top - start;
        if (!force && Math.abs(dist) < 4) return;
        if (Math.abs(dist) < 1) {
            wrap.scrollTop = target_top;
            return;
        }
        const dur = force ? 320 : 480;
        const t0 = performance.now();
        const step = (now) => {
            if (!force && hub.lyricsUserScrollUntil && Date.now() < hub.lyricsUserScrollUntil) {
                hub._lyricsScrollAnim = 0;
                return;
            }
            const p = Math.min(1, (now - t0) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            wrap.scrollTop = start + dist * eased;
            if (p < 1) hub._lyricsScrollAnim = requestAnimationFrame(step);
            else hub._lyricsScrollAnim = 0;
        };
        hub._lyricsScrollAnim = requestAnimationFrame(step);
    }

    toggleLyrics() {
        const hub = this.state.hub;
        if (!hub.lyricsPanel) return;
        hub.lyricsVisible = !hub.lyricsVisible;
        if (hub.lyricsVisible && hub.queueVisible) {
            hub.queueVisible = false;
            document.body.classList.remove('mobile-queue-open');
            if (hub.queuePanel) hub.queuePanel.setAttribute('aria-hidden', 'true');
            if (this.queue) this.queue.sync_queue_button_ui();
        }
        if (hub.lyricsVisible) {
            if (typeof window.closeGlobalSearch === 'function') window.closeGlobalSearch();
            // Sync bottom edge with the player bar's actual height
            const playerBar = document.getElementById('player-bar');
            if (playerBar) {
                hub.lyricsPanel.style.bottom = playerBar.offsetHeight + 'px';
            }
        } else {
            hub.lyricsPanel.style.bottom = '';
        }
        hub.lyricsPanel.classList.toggle('hidden', !hub.lyricsVisible);
        this.sync_lyrics_toggle_buttons();
        if (hub.lyricsVisible) {
            hub.lyricsSaveStatus.classList.add('hidden');
            hub.lyricsUserScrollUntil = 0;
            hub._lyricsOpenFollowUntil = Date.now() + 2500;
            this.set_lyrics_view('lyrics');
            this.setLyricsMode('read');
            this.fetchLyrics(true);
            this.extract_from_player_cover();
            this.visualizer.sync();
        } else {
            // Reset colors when closing to avoid flash of old colors on next open
            this.resetLyricsColors();
            this.unload_stream_video();
            this.visualizer.stop();
        }
    }

    sync_lyrics_toggle_buttons() {
        const hub = this.state.hub;
        if (!hub.lyricsToggleButtons) return;
        hub.lyricsToggleButtons.forEach(btn => {
            if (!btn) return;
            btn.setAttribute('aria-pressed', String(hub.lyricsVisible));
            btn.classList.toggle('player-control-btn--active', hub.lyricsVisible);
        });
    }

    set_lyrics_view(view) {
        const hub = this.state.hub;
        const vid = this.current_youtube_vid();
        const show_video = view === 'video' && hub.lyricsMode === 'read' && !!vid;
        hub.lyricsViewMode = show_video ? 'video' : 'lyrics';
        if (!show_video && hub._streamVideoLoaded) {
            this.hide_stream_video();
        }
        this.sync_lyrics_view_tabs(vid);
        if (show_video) this.sync_stream_video_pane();
    }

    sync_lyrics_view_tabs(vid) {
        const hub = this.state.hub;
        const has_video = !!(vid || this.current_youtube_vid());
        const can_switch = !!(hub.lyricsVisible && hub.lyricsMode === 'read' && has_video);
        if (!can_switch) hub.lyricsViewMode = 'lyrics';

        const video_selected = can_switch && hub.lyricsViewMode === 'video';
        if (hub.lyricsReadRow) {
            hub.lyricsReadRow.classList.toggle('mobile-video-active', video_selected);
        }
        if (hub.lyricsMobileViewSwitch) {
            hub.lyricsMobileViewSwitch.classList.toggle('hidden', !can_switch);
            hub.lyricsMobileViewSwitch.setAttribute('aria-hidden', String(!can_switch));
        }

        const current_text_color = hub.lyricsPanel
            ? hub.lyricsPanel.style.getPropertyValue('--lyrics-text-color') || '#ffffff'
            : '#ffffff';
        const bg_is_dark = (hub.lyricsBgIsDark === true || hub.lyricsBgIsDark === false)
            ? hub.lyricsBgIsDark
            : true;
        const active_text = bg_is_dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
        [
            [hub.lyricsTabLyrics, !video_selected],
            [hub.lyricsTabVideo, video_selected],
        ].forEach(([tab, active]) => {
            if (!tab) return;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            tab.style.backgroundColor = active
                ? (bg_is_dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)')
                : 'transparent';
            tab.style.color = active ? current_text_color : active_text;
        });
    }

    setLyricsMode(mode) {
        const hub = this.state.hub;
        if (hub.searchStreamActive) mode = 'read';
        hub.lyricsMode = mode;
        if (mode !== 'read') this.set_lyrics_view('lyrics');
        const readOn = mode === 'read';
        const currentTextColor = hub.lyricsPanel.style.getPropertyValue('--lyrics-text-color') || '#ffffff';
        // Use stored background-dark flag if available; default to dark (the app's natural state)
        const bgIsDark = (hub.lyricsBgIsDark === true || hub.lyricsBgIsDark === false)
            ? hub.lyricsBgIsDark
            : true;
        const activeText = bgIsDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';

        const tabClass = 'lyrics-tab';

        if (readOn) {
            hub.lyricsTabRead.className = tabClass;
            hub.lyricsTabRead.style.backgroundColor = bgIsDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
            hub.lyricsTabRead.style.color = currentTextColor;
            hub.lyricsTabEdit.className = tabClass;
            hub.lyricsTabEdit.style.backgroundColor = 'transparent';
            hub.lyricsTabEdit.style.color = activeText;
        } else {
            hub.lyricsTabRead.className = tabClass;
            hub.lyricsTabRead.style.backgroundColor = 'transparent';
            hub.lyricsTabRead.style.color = activeText;
            hub.lyricsTabEdit.className = tabClass;
            hub.lyricsTabEdit.style.backgroundColor = bgIsDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
            hub.lyricsTabEdit.style.color = currentTextColor;
        }
        hub.lyricsViewWrap.classList.toggle('hidden', !readOn);
        if (hub.lyricsReadRow) hub.lyricsReadRow.classList.toggle('hidden', !readOn);
        hub.lyricsEditWrap.classList.toggle('hidden', readOn);
        this.sync_stream_video_pane();
        if (readOn) {
            hub.lyricsSaveStatus.classList.add('hidden');
            // Update active lyrics line when switching to read mode
            this.schedule_lyrics_open_follow();
        } else {
            const can = hub.lastLyricsPayload.has_audio;
            hub.lyricsEditActions.classList.toggle('hidden', !can);
            hub.lyricsEditDisabled.classList.toggle('hidden', can);

            // Show appropriate editor based on lyrics source
            const isLrc = hub.lastLyricsPayload.source === 'lrc' && hub.lastLyricsPayload.lrc_data;
            if (isLrc) {
                hub.lyricsEditor.classList.add('hidden');
                hub.lrcEditor.classList.remove('hidden');
                this.editor.renderLrcEditor();
            } else {
                hub.lyricsEditor.classList.remove('hidden');
                hub.lrcEditor.classList.add('hidden');
                hub.lyricsEditor.value = hub.lastLyricsPayload.lyrics || '';
            }
        }
    }

    applyLyricsColors(colors) {
        const hub = this.state.hub;
        if (!hub.lyricsPanel) return;
        hub.lyricsBgIsDark = colors.isDark;
        hub.lyricsPanel.style.backgroundColor = colors.background;
        hub.lyricsPanel.style.backgroundImage = 'none';
        hub.lyricsPanel.style.setProperty('--lyrics-text-color', colors.text);
        hub.lyricsPanel.style.setProperty('--lyrics-bg-color', colors.background);
        hub.lyricsPanel.style.setProperty('--lyrics-bg-gradient', colors.background);
        const pal = {
            bg: colors.background,
            fills: colors.fills,
            strokes: colors.strokes,
        };
        this.visualizer.setPalette(pal);
        if (hub.lyricsVisible) this.visualizer.sync();
        // Set dim/hover colors based on actual text color so inactive lines stay readable
        const alpha = colors.isDark ? '0.45' : '0.4';
        const hoverAlpha = colors.isDark ? '0.75' : '0.65';
        const [tr, tg, tb] = colors.isDark ? [255,255,255] : [0,0,0];
        hub.lyricsPanel.style.setProperty('--lyrics-line-dim-color', `rgba(${tr},${tg},${tb},${alpha})`);
        hub.lyricsPanel.style.setProperty('--lyrics-line-hover-color', `rgba(${tr},${tg},${tb},${hoverAlpha})`);

        const hintElements = hub.lyricsPanel.querySelectorAll('p[id$="-hint"]');
        hintElements.forEach(el => {
            el.style.color = colors.isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
        });

        const editDisabled = document.getElementById('lyrics-edit-disabled');
        if (editDisabled) {
            editDisabled.style.color = colors.text;
        }

        const tabs = hub.lyricsPanel.querySelectorAll('.lyrics-tab');
        const isReadMode = hub.lyricsMode === 'read';
        tabs.forEach(tab => {
            const isActive = (isReadMode && tab.id === 'lyrics-tab-read') || (!isReadMode && tab.id === 'lyrics-tab-edit');
            if (isActive) {
                tab.style.color = colors.text;
                tab.style.backgroundColor = colors.isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
            } else {
                tab.style.color = colors.isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
                tab.style.backgroundColor = 'transparent';
            }
        });

        const editor = document.getElementById('lyrics-editor');
        if (editor) {
            editor.style.color = colors.text;
            editor.style.backgroundColor = colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
        }

        const closeBtn = document.getElementById('lyrics-close');
        if (closeBtn) {
            closeBtn.style.color = colors.isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
        }

        const lyricsTitle = document.getElementById('lyrics-title');
        if (lyricsTitle) {
            lyricsTitle.style.color = colors.text;
        }

        const modeSwitch = document.getElementById('lyrics-mode-switch');
        if (modeSwitch) {
            modeSwitch.style.backgroundColor = colors.isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
        }
        const visualizerMode = document.getElementById('lyrics-visualizer-mode');
        if (visualizerMode) {
            visualizerMode.style.color = colors.text;
            visualizerMode.style.backgroundColor = colors.isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
        }
        this.sync_lyrics_view_tabs();
    }

    resetLyricsColors() {
        const hub = this.state.hub;
        if (!hub.lyricsPanel) return;
        hub.lyricsPanel.style.backgroundColor = '#121212';
        hub.lyricsPanel.style.backgroundImage = 'none';
        hub.lyricsPanel.style.setProperty('--lyrics-text-color', '#ffffff');
        hub.lyricsPanel.style.setProperty('--lyrics-bg-color', '#121212');
        hub.lyricsPanel.style.setProperty('--lyrics-bg-gradient', '#121212');
        this.visualizer.resetPalette();
        hub.lyricsPanel.style.setProperty('--lyrics-line-dim-color', 'rgba(255,255,255,0.45)');
        hub.lyricsPanel.style.setProperty('--lyrics-line-hover-color', 'rgba(255,255,255,0.75)');

        const hints = hub.lyricsPanel.querySelectorAll('p[id$="-hint"]');
        hints.forEach(el => el.style.color = '');

        const editDisabled = document.getElementById('lyrics-edit-disabled');
        if (editDisabled) editDisabled.style.color = '';

        const tabs = hub.lyricsPanel.querySelectorAll('.lyrics-tab');
        tabs.forEach(tab => {
            tab.style.color = '';
            tab.style.backgroundColor = '';
        });

        const editor = document.getElementById('lyrics-editor');
        if (editor) {
            editor.style.color = '';
            editor.style.backgroundColor = '';
        }

        const closeBtn = document.getElementById('lyrics-close');
        if (closeBtn) closeBtn.style.color = '';

        const lyricsTitle = document.getElementById('lyrics-title');
        if (lyricsTitle) lyricsTitle.style.color = '';

        const modeSwitch = document.getElementById('lyrics-mode-switch');
        if (modeSwitch) modeSwitch.style.backgroundColor = '';

        const visualizerMode = document.getElementById('lyrics-visualizer-mode');
        if (visualizerMode) {
            visualizerMode.style.color = '';
            visualizerMode.style.backgroundColor = '';
        }
    }

    loadCover(trackId, coverPlaylistIdOpt) {
        const hub = this.state.hub;
        hub.coverWrap.classList.add('no-art');
        hub.coverImg.classList.add('hidden');
        this.resetLyricsColors();
        if (!trackId) return;
        const pid = (coverPlaylistIdOpt != null && String(coverPlaylistIdOpt).trim() !== '')
            ? String(coverPlaylistIdOpt).trim()
            : String(hub.playingPlaylistId || hub.playlistId || '').trim();
        if (!pid) {
            const vid = this.current_youtube_vid();
            if (vid) this.load_youtube_cover(vid);
            return;
        }
        const covers = window.SpolocalCoverUrls;
        const vid = this.current_youtube_vid();
        const url = covers
            ? covers.trackCoverUrl(pid, trackId, vid)
            : ('/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(trackId) + '/cover');
        this.load_cover_url(url);
        if (hub.lyricsVisible) this.visualizer.sync();
    }

    load_youtube_cover(vid) {
        const id = String(vid || '').trim();
        if (!id) return;
        const covers = window.SpolocalCoverUrls;
        this.load_cover_url(covers ? covers.youtubeThumbApiUrl(id) : ('/api/thumb?vid=' + encodeURIComponent(id)));
    }

    load_cover_url(url) {
        const hub = this.state.hub;
        if (!url || !hub.coverImg) return;
        if (!hub.coverProbeImg) hub.coverProbeImg = new Image();
        const probe = hub.coverProbeImg;
        probe.removeAttribute('crossorigin');
        probe.onload = () => {
            hub.coverImg.src = url;
            hub.coverImg.classList.remove('hidden');
            hub.coverWrap.classList.remove('no-art');
            this.extractCoverColors(probe);
        };
        probe.onerror = () => {
            hub.coverImg.removeAttribute('src');
            hub.coverImg.classList.add('hidden');
            hub.coverWrap.classList.add('no-art');
            this.resetLyricsColors();
        };
        probe.src = url;
    }

    extract_from_player_cover() {
        const hub = this.state.hub;
        const img = hub.coverImg;
        if (img && img.complete && img.naturalWidth) {
            this.extractCoverColors(img);
            return;
        }
        const vid = this.current_youtube_vid();
        if (vid && (!hub.currentTrackId || hub.searchStreamActive)) {
            this.load_youtube_cover(vid);
        }
    }

    extractCoverColors(img) {
        try {
            const colors = this.colors.calculateLyricsColors(img);
            if (colors && colors.background && colors.text) {
                this.applyLyricsColors(colors);
            } else {
                this.resetLyricsColors();
            }
        } catch (e) {
            this.resetLyricsColors();
        }
    }

    youtube_id_from_text(s) {
        const t = String(s || '');
        let m = t.match(/(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/i);
        if (m) return m[1];
        m = t.match(/[?&]v=([A-Za-z0-9_-]{11})\b/);
        if (m) return m[1];
        m = t.match(/\[([A-Za-z0-9_-]{11})\]/);
        if (m) return m[1];
        const plain = t.trim();
        if (/^[A-Za-z0-9_-]{11}$/.test(plain)) return plain;
        return '';
    }

    youtube_id_from_track(t) {
        if (!t) return '';
        let v = this.youtube_id_from_text(t.youtube_video_id);
        if (v) return v;
        v = this.youtube_id_from_text(t.url);
        if (v) return v;
        v = this.youtube_id_from_text(t.play_src);
        if (v) return v;
        const vars = t.play_variants || {};
        const keys = Object.keys(vars);
        for (let i = 0; i < keys.length; i++) {
            v = this.youtube_id_from_text(vars[keys[i]]);
            if (v) return v;
        }
        return '';
    }

    current_youtube_vid() {
        const hub = this.state.hub;
        if (hub.searchStreamActive && hub.searchStreamHit) {
            return String(hub.searchStreamHit.video_id || '').trim();
        }
        const snap = hub.lastPlayedTrackSnapshot || {};
        let v = this.youtube_id_from_track(snap);
        if (v) return v;
        const tid = String(hub.currentTrackId || '').trim();
        const tracks = hub.playingTracks || hub.tracks || [];
        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            if (t && String(t.id || t.track_id || '') === tid) {
                v = this.youtube_id_from_track(t);
                if (v) return v;
            }
        }
        if (tid && typeof document !== 'undefined') {
            const row = document.querySelector('tr.track-row[data-track-id="' + CSS.escape(tid) + '"]');
            if (row) {
                v = this.youtube_id_from_text(row.getAttribute('data-youtube-video-id'))
                    || this.youtube_id_from_text(row.getAttribute('data-track-url'))
                    || this.youtube_id_from_text(row.getAttribute('data-play-src'));
                if (v) return v;
            }
        }
        return '';
    }

    stream_video_height() {
        const prefs = window.SpolocalQualityPrefs;
        const kbps = prefs ? prefs.playbackKbps() : 192;
        if (kbps <= 64) return 360;
        if (kbps <= 120) return 480;
        return 720;
    }

    bind_stream_video() {
        const hub = this.state.hub;
        if (!hub.lyricsVideoLoad || hub.lyricsVideoLoad.dataset.bound) return;
        hub.lyricsVideoLoad.dataset.bound = '1';
        hub.lyricsVideoLoad.addEventListener('click', () => {
            if (hub._streamVideoLoaded || hub._streamVideoLoading) this.hide_stream_video();
            else this.load_stream_video();
        });
        if (hub.lyricsVideoHide && !hub.lyricsVideoHide.dataset.bound) {
            hub.lyricsVideoHide.dataset.bound = '1';
            hub.lyricsVideoHide.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.hide_stream_video();
            });
        }
        if (hub.lyricsVideoFs && !hub.lyricsVideoFs.dataset.bound) {
            hub.lyricsVideoFs.dataset.bound = '1';
            hub.lyricsVideoFs.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.toggle_stream_video_fullscreen();
            });
        }
        if (!hub._streamVideoFsEventsBound) {
            hub._streamVideoFsEventsBound = true;
            document.addEventListener('fullscreenchange', () => this.sync_stream_video_fs_icon());
            document.addEventListener('webkitfullscreenchange', () => this.sync_stream_video_fs_icon());
        }
        if (hub.audio) {
            hub.audio.addEventListener('play', () => this.sync_stream_video_play(true));
            hub.audio.addEventListener('pause', () => this.sync_stream_video_play(false));
            hub.audio.addEventListener('seeked', () => this.sync_stream_video_clock(true));
        }
        const el = hub.lyricsVideoEl;
        if (el && !el.dataset.clockBound) {
            el.dataset.clockBound = '1';
            el.addEventListener('error', () => this.on_stream_video_error());
            el.addEventListener('leavepictureinpicture', () => this.on_leave_picture_in_picture());
            el.addEventListener('pause', () => this.on_stream_video_paused());
            el.addEventListener('loadedmetadata', () => this.prime_stream_video_clock());
            el.addEventListener('canplay', () => this.prime_stream_video_clock());
        }
    }

    on_stream_video_paused() {
        const hub = this.state.hub;
        if (!hub._streamVideoLoaded || hub._streamVideoHiding || hub._streamVideoPrimeSeek) return;
        if (!hub.audio || hub.audio.paused) return;
        const el = hub.lyricsVideoEl;
        if (el) el.play().catch(() => {});
    }

    restart_stream_video_element() {
        const hub = this.state.hub;
        const el = hub.lyricsVideoEl;
        if (!hub._streamVideoLoaded || !el || hub._streamVideoPrimeSeek) return;
        const want_play = hub.audio && !hub.audio.paused;
        try { el.playbackRate = hub.audio && hub.audio.playbackRate ? hub.audio.playbackRate : 1; } catch (e) {}
        try { el.pause(); } catch (e) {}
        if (!want_play) return;
        const kick = () => { el.play().catch(() => {}); };
        setTimeout(kick, 40);
    }

    on_leave_picture_in_picture() {
        const hub = this.state.hub;
        hub._streamVideoNoSeekUntil = Date.now() + 400;
        this.restart_stream_video_element();
        this.start_stream_video_frame_clock();
    }

    stream_video_base_rate() {
        const audio = this.state.hub.audio;
        const r = audio && audio.playbackRate ? audio.playbackRate : 1;
        return r > 0 ? r : 1;
    }

    start_stream_video_frame_clock() {
        const hub = this.state.hub;
        const el = hub.lyricsVideoEl;
        if (!el || !hub._streamVideoLoaded || hub._streamVideoFrameClockOn) return;
        hub._streamVideoFrameClockOn = true;
        const tick = (_now, meta) => {
            if (!hub._streamVideoFrameClockOn || !hub._streamVideoLoaded) return;
            const presented = meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : null;
            this.sync_stream_video_clock_frame(presented);
            if (typeof el.requestVideoFrameCallback === 'function') {
                hub._streamVideoFrameHandle = el.requestVideoFrameCallback(tick);
            } else {
                hub._streamVideoFrameHandle = requestAnimationFrame((t) => tick(t, null));
            }
        };
        if (typeof el.requestVideoFrameCallback === 'function') {
            hub._streamVideoFrameHandle = el.requestVideoFrameCallback(tick);
        } else {
            hub._streamVideoFrameHandle = requestAnimationFrame((t) => tick(t, null));
        }
    }

    stop_stream_video_frame_clock() {
        const hub = this.state.hub;
        hub._streamVideoFrameClockOn = false;
        const el = hub.lyricsVideoEl;
        const h = hub._streamVideoFrameHandle;
        hub._streamVideoFrameHandle = null;
        if (h == null) return;
        if (el && typeof el.cancelVideoFrameCallback === 'function') {
            try { el.cancelVideoFrameCallback(h); } catch (e) {}
        } else {
            cancelAnimationFrame(h);
        }
    }

    sync_stream_video_clock_frame(presented) {
        const hub = this.state.hub;
        const el = hub.lyricsVideoEl;
        if (!hub._streamVideoLoaded || !el || hub._streamVideoPrimeSeek) return;
        if (el.seeking) return;
        const a = this.stream_video_target_time();
        const v = presented != null ? presented : (el.currentTime || 0);
        const drift = a - v;
        const base = this.stream_video_base_rate();
        if (Math.abs(drift) < 0.012) {
            if (Math.abs(el.playbackRate - base) > 0.001) {
                try { el.playbackRate = base; } catch (e) {}
            }
            return;
        }
        if (Math.abs(drift) < 0.08) {
            const adj = Math.max(-0.06, Math.min(0.06, drift * 1.4));
            try { el.playbackRate = base * (1 + adj); } catch (e) {}
            return;
        }
        if (Date.now() < (hub._streamVideoNoSeekUntil || 0)) {
            try { el.playbackRate = base * (drift > 0 ? 1.08 : 0.92); } catch (e) {}
            return;
        }
        hub._streamVideoNoSeekUntil = Date.now() + 250;
        try { el.playbackRate = base; } catch (e) {}
        try { el.currentTime = a; } catch (e) {}
    }

    nudge_stream_video_rate(el, drift) {
        const base = this.stream_video_base_rate();
        let adj = 0;
        if (drift > 0.012) adj = Math.min(0.06, drift * 1.4);
        else if (drift < -0.012) adj = Math.max(-0.06, drift * 1.4);
        try { el.playbackRate = base * (1 + adj); } catch (e) {}
    }

    stream_video_target_time() {
        const hub = this.state.hub;
        const audio = hub.audio;
        const dur = audio && audio.duration ? audio.duration : 0;
        if (hub.seeking && hub.seek && dur) {
            return (parseFloat(hub.seek.value) / 1000) * dur;
        }
        return audio ? (audio.currentTime || 0) : 0;
    }

    prime_stream_video_clock() {
        const hub = this.state.hub;
        const el = hub.lyricsVideoEl;
        if (!hub._streamVideoPrimeSeek || !hub._streamVideoLoaded || !el) return;
        const a = this.stream_video_target_time();
        try { el.playbackRate = 1; } catch (e) {}
        try { el.currentTime = a; } catch (e) {}
        const finish = () => {
            if (!hub._streamVideoPrimeSeek) return;
            hub._streamVideoPrimeSeek = false;
            hub._streamVideoNoSeekUntil = Date.now() + 200;
            if (hub.audio && !hub.audio.paused) el.play().catch(() => {});
            this.start_stream_video_frame_clock();
        };
        if (Math.abs((el.currentTime || 0) - a) < 0.04) {
            finish();
            return;
        }
        el.addEventListener('seeked', finish, { once: true });
        setTimeout(finish, 900);
    }

    sync_stream_video_pane() {
        const hub = this.state.hub;
        const pane = hub.lyricsVideoPane;
        if (!pane) return;
        const vid = this.current_youtube_vid();
        this.sync_lyrics_view_tabs(vid);
        const show = !!(hub.lyricsVisible && hub.lyricsMode === 'read' && vid);
        pane.classList.toggle('hidden', !show);
        if (!show) {
            this.unload_stream_video();
            return;
        }
        if (hub._streamVideoVid && hub._streamVideoVid !== vid) {
            this.unload_stream_video();
        }
        this.prepare_stream_video();
    }

    set_video_load_label(text) {
        const btn = this.state.hub.lyricsVideoLoad;
        if (!btn) return;
        const span = btn.querySelector('span');
        if (span) span.textContent = text;
        else btn.textContent = text;
    }

    prepare_stream_video() {
        const hub = this.state.hub;
        const vid = this.current_youtube_vid();
        if (!vid) return Promise.resolve();
        const height = this.stream_video_height();
        const key = vid + ':' + String(height);
        if (hub._streamVideoPrepareKey === key && hub._streamVideoPrepareP) {
            return hub._streamVideoPrepareP;
        }
        hub._streamVideoPrepareKey = key;
        const url = '/api/stream/video/prepare?vid=' + encodeURIComponent(vid) + '&height=' + encodeURIComponent(String(height));
        hub._streamVideoPrepareP = fetch(url).then((resp) => {
            if (!resp.ok) throw new Error('prepare failed');
        }).catch(() => {
            if (hub._streamVideoPrepareKey === key) {
                hub._streamVideoPrepareKey = '';
                hub._streamVideoPrepareP = null;
            }
        });
        return hub._streamVideoPrepareP;
    }

    fullscreen_element() {
        if (typeof document === 'undefined') return null;
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    sync_stream_video_fs_icon() {
        const hub = this.state.hub;
        const btn = hub.lyricsVideoFs;
        if (!btn) return;
        const icon = btn.querySelector('i');
        const on = !!this.fullscreen_element();
        btn.setAttribute('title', on ? 'Exit full screen' : 'Full screen');
        btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
        if (icon) {
            icon.className = on ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        }
    }

    toggle_stream_video_fullscreen() {
        const hub = this.state.hub;
        const stack = hub.lyricsVideoStack;
        const el = hub.lyricsVideoEl;
        if (!hub._streamVideoLoaded) return;
        const cur = this.fullscreen_element();
        if (cur) {
            const exit_fs = document.exitFullscreen || document.webkitExitFullscreen;
            if (exit_fs) {
                try {
                    const p = exit_fs.call(document);
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                } catch (e) {}
            }
            return;
        }
        if (el && typeof el.webkitEnterFullscreen === 'function' && stack && !stack.requestFullscreen && !stack.webkitRequestFullscreen) {
            el.webkitEnterFullscreen();
            return;
        }
        const target = stack || el;
        if (!target) return;
        const req = target.requestFullscreen || target.webkitRequestFullscreen;
        if (req) Promise.resolve(req.call(target)).catch(() => {});
    }

    hide_stream_video() {
        const hub = this.state.hub;
        hub._streamVideoHiding = true;
        hub._streamVideoLoadGen = (hub._streamVideoLoadGen || 0) + 1;
        hub._streamVideoLoaded = false;
        hub._streamVideoLoading = false;
        hub._streamVideoVid = '';
        hub._streamVideoPrimeSeek = false;
        hub._streamVideoNoSeekUntil = 0;
        this.stop_stream_video_frame_clock();
        const el = hub.lyricsVideoEl;
        if (this.fullscreen_element()) {
            const exit_fs = document.exitFullscreen || document.webkitExitFullscreen;
            if (exit_fs) {
                try {
                    const p = exit_fs.call(document);
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                } catch (e) {}
            }
        }
        if (el) {
            if (typeof document !== 'undefined' && document.pictureInPictureElement === el) {
                document.exitPictureInPicture().catch(() => {});
            }
            try { el.pause(); } catch (e) {}
            el.removeAttribute('src');
            try { el.src = ''; } catch (e) {}
            try { el.load(); } catch (e) {}
            el.classList.add('hidden');
        }
        if (hub.lyricsVideoPane) hub.lyricsVideoPane.classList.remove('is-loaded');
        if (hub.lyricsVideoHide) hub.lyricsVideoHide.classList.add('hidden');
        if (hub.lyricsVideoFs) hub.lyricsVideoFs.classList.add('hidden');
        if (hub.lyricsVideoLoad) hub.lyricsVideoLoad.classList.remove('hidden');
        this.set_video_load_label('Click to load video');
        hub._streamVideoHiding = false;
    }

    on_stream_video_error() {
        this.hide_stream_video();
    }

    unload_stream_video() {
        this.hide_stream_video();
    }

    load_stream_video() {
        const hub = this.state.hub;
        const vid = this.current_youtube_vid();
        const el = hub.lyricsVideoEl;
        if (!vid || !el || hub._streamVideoLoading) return;
        hub._streamVideoLoading = true;
        hub._streamVideoLoadGen = (hub._streamVideoLoadGen || 0) + 1;
        const gen = hub._streamVideoLoadGen;
        this.set_video_load_label('Click to cancel');
        const height = this.stream_video_height();
        const src = '/api/stream/video?vid=' + encodeURIComponent(vid) + '&height=' + encodeURIComponent(String(height));
        const start = () => {
            if (gen !== hub._streamVideoLoadGen) return;
            hub._streamVideoLoading = false;
            hub._streamVideoVid = vid;
            hub._streamVideoLoaded = true;
            if (hub.lyricsVideoPane) hub.lyricsVideoPane.classList.add('is-loaded');
            if (hub.lyricsVideoHide) hub.lyricsVideoHide.classList.remove('hidden');
            if (hub.lyricsVideoFs) hub.lyricsVideoFs.classList.remove('hidden');
            el.classList.remove('hidden');
            el.muted = true;
            el.preload = 'auto';
            hub._streamVideoPrimeSeek = true;
            hub._streamVideoNoSeekUntil = 0;
            el.src = src + '&r=' + String(Date.now());
        };
        const prep = this.prepare_stream_video();
        if (prep && typeof prep.then === 'function') prep.then(start, start);
        else start();
    }

    reload_stream_video_if_loaded() {
        const hub = this.state.hub;
        if (!hub._streamVideoLoaded) return;
        this.load_stream_video();
    }

    sync_stream_video_play(playing) {
        const hub = this.state.hub;
        const el = hub.lyricsVideoEl;
        if (!hub._streamVideoLoaded || !el || hub._streamVideoPrimeSeek) return;
        if (!playing) {
            el.pause();
            return;
        }
        el.play().catch(() => {});
        this.start_stream_video_frame_clock();
    }

    sync_stream_video_clock(force) {
        const hub = this.state.hub;
        const el = hub.lyricsVideoEl;
        if (!hub._streamVideoLoaded || !el) return;
        if (hub._streamVideoPrimeSeek && !force) return;
        if (!force && hub._streamVideoFrameClockOn) return;
        if (hub.audio && !hub.audio.paused && el.paused) {
            el.play().catch(() => {});
            return;
        }
        const a = this.stream_video_target_time();
        const v = el.currentTime || 0;
        const drift = a - v;
        if (force) {
            try { el.playbackRate = this.stream_video_base_rate(); } catch (e) {}
            try { el.currentTime = a; } catch (e) {}
            hub._streamVideoNoSeekUntil = Date.now() + 250;
            return;
        }
        this.sync_stream_video_clock_frame(v);
    }
}
