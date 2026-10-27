import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistLyricsController } from '../../static/js/player/lyrics_controller.js';

function make_el(tag, id) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    document.body.appendChild(node);
    return node;
}

function fake_media() {
    return {
        paused: true,
        currentTime: 0,
        duration: 100,
        playbackRate: 1,
        muted: false,
        preload: '',
        src: '',
        seeking: false,
        dataset: {},
        style: {},
        classList: {
            add: vi.fn(),
            remove: vi.fn(),
            toggle: vi.fn(),
            contains: vi.fn(() => false),
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        removeAttribute: vi.fn(),
        setAttribute: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(),
        load: vi.fn(),
    };
}

function make_hub(overrides) {
    const fs_btn = make_el('button', 'lyrics-video-fs');
    const icon = document.createElement('i');
    fs_btn.appendChild(icon);
    const load_btn = make_el('button', 'lyrics-video-load');
    const load_span = document.createElement('span');
    load_btn.appendChild(load_span);

    const hub = {
        lyricsPanel: make_el('div', 'lyrics-panel'),
        lyricsBody: make_el('div', 'lyrics-body'),
        lyricsViewWrap: make_el('div', 'lyrics-view-wrap'),
        lyricsEditor: make_el('textarea', 'lyrics-editor'),
        lrcEditor: make_el('div', 'lrc-editor'),
        lrcLinesContainer: make_el('div', 'lrc-lines'),
        lyricsEmptyHint: make_el('p', 'lyrics-empty-hint'),
        lyricsNoAudioHint: make_el('p', 'lyrics-no-audio-hint'),
        lyricsTitle: make_el('div', 'lyrics-title'),
        lyricsModeSwitch: make_el('div', 'lyrics-mode-switch'),
        lyricsMode: 'read',
        lyricsVisible: false,
        lyricsBgIsDark: true,
        lyricsTabRead: make_el('button', 'lyrics-tab-read'),
        lyricsTabEdit: make_el('button', 'lyrics-tab-edit'),
        lyricsTabLyrics: make_el('button', 'lyrics-tab-lyrics'),
        lyricsTabVideo: make_el('button', 'lyrics-tab-video'),
        lyricsCancelEdit: make_el('button', 'lyrics-cancel-edit'),
        lrcShiftMinus: make_el('button', 'lrc-shift-minus'),
        lrcShiftPlus: make_el('button', 'lrc-shift-plus'),
        lyricsClose: make_el('button', 'lyrics-close'),
        lyricsSaveBtn: make_el('button', 'lyrics-save'),
        lyricsSaveStatus: make_el('div', 'lyrics-save-status'),
        lyricsEditWrap: make_el('div', 'lyrics-edit-wrap'),
        lyricsEditActions: make_el('div', 'lyrics-edit-actions'),
        lyricsEditDisabled: make_el('div', 'lyrics-edit-disabled'),
        lyricsReadRow: make_el('div', 'lyrics-read-row'),
        lyricsMobileViewSwitch: make_el('div', 'lyrics-mobile-view-switch'),
        lyricsToggleButtons: [make_el('button', 'lyrics-toggle')],
        coverWrap: make_el('div', 'cover-wrap'),
        coverImg: make_el('img', 'cover-img'),
        coverProbeImg: null,
        audio: fake_media(),
        seek: { value: '0' },
        seeking: false,
        titleEl: { textContent: '' },
        subEl: { textContent: '' },
        currentTrackId: null,
        playingPlaylistId: null,
        playlistId: 'p1',
        searchStreamActive: false,
        searchStreamHit: null,
        lastPlayedTrackSnapshot: null,
        playingTracks: [],
        tracks: [],
        libraryPool: [],
        lyricsFetchGen: 0,
        lyricsAbortController: null,
        lyricsUserScrollUntil: 0,
        lastLyricsPayload: { lyrics: '', source: 'none', has_audio: false, lrc_data: null, lrc_raw: null },
        lrcEditLines: [],
        lyricsViewMode: 'lyrics',
        lyricsVideoLoad: load_btn,
        lyricsVideoHide: make_el('button', 'lyrics-video-hide'),
        lyricsVideoFs: fs_btn,
        lyricsVideoEl: fake_media(),
        lyricsVideoPane: make_el('div', 'lyrics-video-pane'),
        lyricsVideoStack: make_el('div', 'lyrics-video-stack'),
    };
    hub.lyricsViewWrap.appendChild(hub.lyricsBody);
    return Object.assign(hub, overrides || {});
}

function make_controller(overrides) {
    const hub = make_hub(overrides);
    const state = { hub };
    const transport = { handlePlayError: vi.fn() };
    const queue = { sync_queue_button_ui: vi.fn() };
    return { controller: new PlaylistLyricsController(state, transport, queue), hub, transport, queue };
}

function stub_fetch(payload) {
    const fn = vi.fn(() => Promise.resolve({ ok: true, json: async () => payload }));
    vi.stubGlobal('fetch', fn);
    return fn;
}

function colors_payload() {
    return {
        isDark: true,
        background: '#123456',
        text: '#ffffff',
        fills: ['#111111', '#222222', '#333333', '#444444'],
        strokes: ['#aaaaaa', '#bbbbbb', '#cccccc'],
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('init', () => {
    it('binds the hub, toggle buttons and is idempotent', () => {
        const { controller, hub } = make_controller();
        stub_fetch({ lyrics: '', source: 'none', has_audio: false });
        controller.init();
        expect(hub._lyrics_controller_bound).toBe(true);
        expect(hub.lyricsController).toBe(controller);
        expect(hub.lyricsToggleButtons[0].dataset.lyricsBound).toBe('1');
        controller.init();
        expect(hub._lyrics_controller_bound).toBe(true);
    });

    it('toggles the panel from a bound toggle button', () => {
        vi.useFakeTimers();
        const { controller, hub } = make_controller();
        stub_fetch({ lyrics: '', source: 'none', has_audio: false });
        controller.init();
        hub.lyricsToggleButtons[0].click();
        expect(hub.lyricsVisible).toBe(true);
        expect(hub.lyricsPanel.classList.contains('hidden')).toBe(false);
    });

    it('does nothing without a hub', () => {
        const controller = new PlaylistLyricsController({ hub: null }, null, null);
        expect(() => controller.init()).not.toThrow();
    });
});

describe('bind_lyrics_view_tabs', () => {
    it('switches to the video view when a video id exists', () => {
        const { controller, hub } = make_controller({
            lyricsVisible: true,
            lyricsMode: 'read',
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        stub_fetch({});
        controller.bind_lyrics_view_tabs();
        hub.lyricsTabVideo.click();
        expect(hub.lyricsViewMode).toBe('video');
        hub.lyricsTabLyrics.click();
        expect(hub.lyricsViewMode).toBe('lyrics');
    });
});

describe('bind_lyrics_user_scroll', () => {
    it('pauses autoscroll on a wheel event inside the wrap', () => {
        const { controller, hub } = make_controller({ lyricsVisible: true });
        const inner = document.createElement('div');
        hub.lyricsViewWrap.appendChild(inner);
        controller.bind_lyrics_user_scroll();
        inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, bubbles: true }));
        expect(hub.lyricsUserScrollUntil).toBeGreaterThan(0);
        expect(hub._lyricsCenterGen).toBe(1);
    });

    it('ignores tiny wheel deltas', () => {
        const { controller, hub } = make_controller({ lyricsVisible: true });
        const inner = document.createElement('div');
        hub.lyricsViewWrap.appendChild(inner);
        controller.bind_lyrics_user_scroll();
        inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, bubbles: true }));
        expect(hub.lyricsUserScrollUntil).toBe(0);
    });
});

describe('fetchLyrics', () => {
    it('asks for a song when nothing is selected', async () => {
        const { controller, hub } = make_controller();
        const fetch_fn = stub_fetch({});
        await controller.fetchLyrics(true);
        expect(fetch_fn).not.toHaveBeenCalled();
        expect(hub.lyricsBody.textContent).toBe('Select a song to play.');
    });

    it('loads playlist track lyrics and renders them', async () => {
        const { controller, hub } = make_controller({ currentTrackId: 't1', playingPlaylistId: 'p1' });
        const fetch_fn = stub_fetch({ lyrics: 'one\ntwo', source: 'plain', has_audio: true });
        await controller.fetchLyrics(true);
        expect(fetch_fn).toHaveBeenCalledTimes(1);
        expect(fetch_fn.mock.calls[0][0]).toBe('/playlists/p1/tracks/t1/lyrics');
        expect(hub.lyricsBody.querySelectorAll('.lyrics-line')).toHaveLength(2);
    });

    it('loads chapters for an active search stream', async () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        const fetch_fn = stub_fetch({
            lyrics: '',
            source: 'chapters',
            has_audio: true,
            lrc_data: [{ text: 'Intro', time_ms: 0 }],
        });
        await controller.fetchLyrics(true);
        expect(fetch_fn.mock.calls[0][0]).toBe('/api/stream/chapters?vid=abcdefghijk');
        expect(hub.lyricsBody.querySelectorAll('.lyrics-chapter')).toHaveLength(1);
    });

    it('shows an error when the request fails', async () => {
        const { controller, hub } = make_controller({ currentTrackId: 't1', playingPlaylistId: 'p1' });
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: async () => ({}) })));
        await controller.fetchLyrics(true);
        expect(hub.lyricsBody.textContent).toBe('Could not load lyrics.');
    });
});

describe('sync_search_lyrics_chrome', () => {
    it('labels the panel and hides the mode switch during search', () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
            _searchLyricsKind: 'lyrics',
            lyricsMode: 'edit',
        });
        controller.sync_search_lyrics_chrome();
        expect(hub.lyricsTitle.textContent).toBe('Lyrics');
        expect(hub.lyricsModeSwitch.classList.contains('hidden')).toBe(true);
        expect(hub.lyricsMode).toBe('read');
    });

    it('uses the chapters label when no lyrics kind is known', () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        controller.sync_search_lyrics_chrome();
        expect(hub.lyricsTitle.textContent).toBe('Chapters');
    });
});

describe('applyLyricsPayload', () => {
    it('shows the no-audio hint when the track has no audio', () => {
        const { controller, hub } = make_controller({ currentTrackId: 't1' });
        controller.applyLyricsPayload({ lyrics: 'x', source: 'plain', has_audio: false }, true);
        expect(hub.lyricsNoAudioHint.classList.contains('hidden')).toBe(false);
    });

    it('renders plain lyrics', () => {
        const { controller, hub } = make_controller({ currentTrackId: 't1' });
        controller.applyLyricsPayload({ lyrics: 'a\nb', source: 'plain', has_audio: true }, true);
        expect(hub.lyricsBody.querySelectorAll('.lyrics-line')).toHaveLength(2);
    });

    it('renders lrc lines when lrc data is present', () => {
        const { controller, hub } = make_controller({ currentTrackId: 't1' });
        controller.applyLyricsPayload({
            lyrics: 'a',
            source: 'lrc',
            has_audio: true,
            lrc_data: [{ text: 'a', time_ms: 1000 }],
        }, true);
        const line = hub.lyricsBody.querySelector('.lyrics-line');
        expect(line.dataset.timeMs).toBe('1000');
    });

    it('renders chapter rows for search chapters', () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        controller.applyLyricsPayload({
            lyrics: '',
            source: 'chapters',
            has_audio: true,
            lrc_data: [{ text: 'Intro', time_ms: 0 }],
        }, true);
        expect(hub.lyricsBody.querySelectorAll('.lyrics-chapter')).toHaveLength(1);
    });

    it('shows the empty hint with a search-specific message', () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
            _searchLyricsKind: 'lyrics',
        });
        controller.applyLyricsPayload({ lyrics: '', source: 'none', has_audio: true }, true);
        expect(hub.lyricsEmptyHint.textContent).toBe('No lyrics found for this search.');
        expect(hub.lyricsEmptyHint.classList.contains('hidden')).toBe(false);
    });
});

describe('load_stream_lyrics', () => {
    it('reuses a cached search payload', async () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
            _searchLyricsPayload: { lyrics: 'cached', source: 'plain', has_audio: true },
        });
        const fetch_fn = stub_fetch({});
        await controller.load_stream_lyrics();
        expect(fetch_fn).not.toHaveBeenCalled();
        expect(hub._searchLyricsKind).toBe('lyrics');
        expect(hub.lyricsBody.querySelectorAll('.lyrics-line')).toHaveLength(1);
    });

    it('fetches lyrics by title and artist', async () => {
        const { controller, hub } = make_controller({
            searchStreamHit: { title: 'Song', artist: 'Artist' },
        });
        const fetch_fn = stub_fetch({ lyrics: 'found', source: 'plain', has_audio: true });
        await controller.load_stream_lyrics();
        expect(fetch_fn.mock.calls[0][0]).toBe('/api/stream/lyrics?title=Song&artist=Artist');
        expect(hub._searchLyricsKind).toBe('lyrics');
    });

    it('marks the kind as none when no lyrics come back', async () => {
        const { controller, hub } = make_controller({
            searchStreamHit: { title: 'Song', artist: 'Artist' },
        });
        stub_fetch({ lyrics: '', source: 'none', has_audio: true });
        await controller.load_stream_lyrics();
        expect(hub._searchLyricsKind).toBe('none');
    });
});

describe('chapter helpers', () => {
    it('strips a leading timestamp from a chapter title', () => {
        const { controller } = make_controller();
        expect(controller.chapter_song_title({ text: '01:23 Song' })).toBe('Song');
        expect(controller.chapter_song_title(null)).toBe('');
    });

    it('derives the artist from a compilation title', () => {
        const { controller, hub } = make_controller({
            searchStreamHit: { title: 'Pink Floyd greatest hits', channel: 'Some Channel' },
        });
        expect(controller.chapter_lyrics_artist()).toBe('Pink Floyd');
        hub.searchStreamHit = { title: 'Plain', channel: 'Some Channel' };
        expect(controller.chapter_lyrics_artist()).toBe('Some Channel');
    });
});

describe('chapter rendering', () => {
    function render_chapters(controller, hub) {
        controller.render_chapter_rows([
            { text: '00:00 Intro', time_ms: 0 },
            { text: '00:10 Verse', time_ms: 10000 },
        ]);
    }

    it('creates a block, row, button and line per chapter', () => {
        const { controller, hub } = make_controller();
        render_chapters(controller, hub);
        expect(hub.lyricsBody.querySelectorAll('.lyrics-chapter')).toHaveLength(2);
        expect(hub.lyricsBody.querySelectorAll('.lyrics-chapter-load-btn')).toHaveLength(2);
        expect(hub.lyricsBody.querySelectorAll('.lyrics-line--chapter')).toHaveLength(2);
    });

    it('seeks the audio when a chapter line is clicked', () => {
        const { controller, hub } = make_controller();
        render_chapters(controller, hub);
        const line = hub.lyricsBody.querySelectorAll('.lyrics-line--chapter')[1];
        line.click();
        expect(hub.audio.currentTime).toBe(10);
        expect(hub.audio.play).toHaveBeenCalled();
    });

    it('finds chapter panels and load buttons by index', () => {
        const { controller, hub } = make_controller();
        render_chapters(controller, hub);
        expect(controller.chapter_panel_el(0)).not.toBeNull();
        expect(controller.chapter_load_btn(0)).not.toBeNull();
        expect(controller.chapter_panel_el(9)).toBeNull();
        expect(controller.chapter_load_btn(9)).toBeNull();
    });

    it('collapses the open chapter panel', () => {
        const { controller, hub } = make_controller();
        render_chapters(controller, hub);
        controller.show_chapter_lyrics_panel(0, { lyrics: 'hello' });
        expect(hub._chapterLyricsOpenIndex).toBe(0);
        controller.collapse_open_chapter_lyrics();
        expect(hub._chapterLyricsOpenIndex).toBeNull();
        expect(controller.chapter_panel_el(0).classList.contains('hidden')).toBe(true);
    });

    it('renders lrc verse lines with the chapter offset', () => {
        const { controller, hub } = make_controller();
        render_chapters(controller, hub);
        hub.lastLyricsPayload = {
            lyrics: '',
            source: 'chapters',
            has_audio: true,
            lrc_data: [{ text: '00:00 Intro', time_ms: 0 }, { text: '00:10 Verse', time_ms: 10000 }],
        };
        controller.show_chapter_lyrics_panel(1, {
            lrc_data: [{ text: 'a', time_ms: 0 }, { text: 'b', time_ms: 5000 }],
        });
        const lines = hub.lyricsBody.querySelectorAll('.lyrics-line--verse');
        expect(lines).toHaveLength(2);
        expect(lines[0].dataset.timeMs).toBe('10000');
        expect(lines[1].dataset.timeMs).toBe('15000');
    });

    it('renders plain verse lines', () => {
        const { controller, hub } = make_controller();
        render_chapters(controller, hub);
        controller.show_chapter_lyrics_panel(0, { lyrics: 'a\r\nb' });
        expect(hub.lyricsBody.querySelectorAll('.lyrics-line--verse')).toHaveLength(2);
    });

    it('shows a message when the chapter has no lyrics', () => {
        const { controller, hub } = make_controller();
        render_chapters(controller, hub);
        controller.show_chapter_lyrics_panel(0, { lyrics: '' });
        expect(controller.chapter_panel_el(0).textContent).toBe('No lyrics found.');
    });

    it('renders chapter verse lrc into a supplied body', () => {
        const { controller, hub } = make_controller();
        const body = document.createElement('div');
        controller.render_chapter_verse_lrc(body, [{ text: 'a', time_ms: 250 }], 1000);
        expect(body.children).toHaveLength(1);
        expect(body.children[0].dataset.timeMs).toBe('1250');
    });

    it('renders chapter verse plain into a supplied body', () => {
        const { controller } = make_controller();
        const body = document.createElement('div');
        controller.render_chapter_verse_plain(body, 'a\r\nb');
        expect(body.children).toHaveLength(2);
    });
});

describe('toggle_chapter_lyrics', () => {
    it('collapses when the same chapter is open', async () => {
        const { controller, hub } = make_controller();
        controller.render_chapter_rows([{ text: '00:00 Intro', time_ms: 0 }]);
        hub._chapterLyricsOpenIndex = 0;
        await controller.toggle_chapter_lyrics(0, { text: '00:00 Intro' }, null);
        expect(hub._chapterLyricsOpenIndex).toBeNull();
    });

    it('uses the cache without fetching', async () => {
        const { controller, hub } = make_controller();
        controller.render_chapter_rows([{ text: '00:00 Intro', time_ms: 0 }]);
        hub._chapterLyricsCache = { 0: { lyrics: 'cached' } };
        const fetch_fn = stub_fetch({});
        await controller.toggle_chapter_lyrics(0, { text: '00:00 Intro' }, null);
        expect(fetch_fn).not.toHaveBeenCalled();
        expect(hub._chapterLyricsOpenIndex).toBe(0);
    });

    it('fetches and caches chapter lyrics', async () => {
        const { controller, hub } = make_controller({
            searchStreamHit: { title: 'Video', channel: 'Channel' },
        });
        controller.render_chapter_rows([{ text: '00:10 Intro', time_ms: 10000 }]);
        const fetch_fn = stub_fetch({ lyrics: 'hello' });
        await controller.toggle_chapter_lyrics(0, { text: '00:10 Intro' }, null);
        expect(fetch_fn.mock.calls[0][0]).toBe('/api/stream/lyrics?title=Intro&artist=Channel');
        expect(hub._chapterLyricsCache[0]).toEqual({ lyrics: 'hello' });
        expect(hub._chapterLyricsOpenIndex).toBe(0);
    });

    it('shows an error message when the fetch fails', async () => {
        const { controller, hub } = make_controller({
            searchStreamHit: { title: 'Video', channel: 'Channel' },
        });
        controller.render_chapter_rows([{ text: '00:10 Intro', time_ms: 10000 }]);
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('nope'))));
        await controller.toggle_chapter_lyrics(0, { text: '00:10 Intro' }, null);
        expect(controller.chapter_panel_el(0).textContent).toBe('Could not load lyrics.');
    });
});

describe('plain and lrc rendering', () => {
    it('splits plain lyrics on newlines', () => {
        const { controller, hub } = make_controller();
        controller.render_plain_lyrics_lines('a\r\nb\nc');
        expect(hub.lyricsBody.children).toHaveLength(3);
        expect(hub.lyricsBody.children[0].className).toContain('lyrics-line');
    });

    it('renders lrc lines with timestamps and seeks on click', () => {
        const { controller, hub } = make_controller();
        controller.renderLrcLines([
            { text: 'a', time_ms: 1000 },
            { text: 'b', time_ms: 2000 },
        ]);
        const lines = hub.lyricsBody.querySelectorAll('.lyrics-line');
        expect(lines).toHaveLength(2);
        lines[1].click();
        expect(hub.audio.currentTime).toBe(2);
    });
});

describe('follow and active line', () => {
    it('schedules the open follow and marks the active line', () => {
        const { controller, hub } = make_controller({
            lyricsVisible: true,
            lyricsMode: 'read',
            lastLyricsPayload: {
                lyrics: 'a\nb',
                source: 'lrc',
                has_audio: true,
                lrc_data: [{ text: 'a', time_ms: 0 }, { text: 'b', time_ms: 1000 }],
            },
        });
        controller.renderLrcLines(hub.lastLyricsPayload.lrc_data);
        Object.defineProperty(hub.lyricsViewWrap, 'clientHeight', { value: 100, configurable: true });
        Object.defineProperty(hub.lyricsViewWrap, 'scrollHeight', { value: 300, configurable: true });
        hub.audio.currentTime = 1.5;
        controller.schedule_lyrics_open_follow();
        expect(hub._lyricsOpenFollowUntil).toBeGreaterThan(0);
        expect(hub.lyricsUserScrollUntil).toBe(0);
        const lines = hub.lyricsBody.querySelectorAll('.lyrics-line');
        expect(lines[1].classList.contains('active')).toBe(true);
    });

    it('does nothing without audio or lrc data', () => {
        const { controller, hub } = make_controller({ lyricsVisible: true, lyricsMode: 'read' });
        hub.audio = null;
        expect(() => controller.updateLyricsActiveLine(true)).not.toThrow();
    });

    it('marks the active verse line inside an open chapter', () => {
        const { controller, hub } = make_controller({
            lyricsVisible: true,
            lyricsMode: 'read',
            lastLyricsPayload: {
                lyrics: '',
                source: 'chapters',
                has_audio: true,
                lrc_data: [{ text: 'Intro', time_ms: 10000 }],
            },
        });
        controller.render_chapter_rows(hub.lastLyricsPayload.lrc_data);
        hub._chapterLyricsCache = {
            0: { lrc_data: [{ text: 'a', time_ms: 0 }, { text: 'b', time_ms: 5000 }] },
        };
        controller.show_chapter_lyrics_panel(0, hub._chapterLyricsCache[0]);
        controller.sync_chapter_verse_active(16000, true);
        const verses = hub.lyricsBody.querySelectorAll('.lyrics-line--verse');
        expect(verses[1].classList.contains('active')).toBe(true);
    });
});

describe('scrolling helpers', () => {
    it('increments the center generation and schedules frames', () => {
        const { controller, hub } = make_controller();
        const el = document.createElement('div');
        controller.center_lyrics_el(el);
        expect(hub._lyricsCenterGen).toBe(1);
        expect(requestAnimationFrame).toHaveBeenCalled();
    });

    it('ignores centering without a wrap', () => {
        const { controller, hub } = make_controller();
        hub.lyricsViewWrap = null;
        controller.center_lyrics_el(document.createElement('div'));
        expect(hub._lyricsCenterGen).toBeUndefined();
    });

    it('stops the scroll animation', () => {
        const { controller, hub } = make_controller();
        hub._lyricsScrollAnim = 7;
        controller.stop_lyrics_scroll_anim();
        expect(hub._lyricsScrollAnim).toBe(0);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    });

    it('skips the animation for a tiny distance', () => {
        const { controller, hub } = make_controller();
        hub.lyricsViewWrap.scrollTop = 10;
        controller.animate_lyrics_wrap_scroll(hub.lyricsViewWrap, 10.5, false);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(hub._lyricsScrollAnim).toBeUndefined();
    });

    it('animates a long distance with a frame callback', () => {
        const { controller, hub } = make_controller();
        hub.lyricsViewWrap.scrollTop = 0;
        controller.animate_lyrics_wrap_scroll(hub.lyricsViewWrap, 100, true);
        expect(hub._lyricsScrollAnim).toBe(1);
        expect(requestAnimationFrame).toHaveBeenCalled();
    });
});

describe('toggleLyrics', () => {
    it('opens the panel and fetches lyrics', () => {
        vi.useFakeTimers();
        const { controller, hub } = make_controller();
        make_el('div', 'player-bar');
        stub_fetch({ lyrics: '', source: 'none', has_audio: false });
        controller.toggleLyrics();
        expect(hub.lyricsVisible).toBe(true);
        expect(hub.lyricsPanel.classList.contains('hidden')).toBe(false);
        expect(hub.lyricsPanel.style.bottom).toBe('0px');
        expect(hub.lyricsToggleButtons[0].getAttribute('aria-pressed')).toBe('true');
    });

    it('closes the panel and resets colors', () => {
        const { controller, hub } = make_controller({ lyricsVisible: true });
        hub.lyricsPanel.classList.remove('hidden');
        controller.toggleLyrics();
        expect(hub.lyricsVisible).toBe(false);
        expect(hub.lyricsPanel.classList.contains('hidden')).toBe(true);
        expect(hub.lyricsPanel.style.backgroundColor).toBe('rgb(18, 18, 18)');
    });

    it('does nothing without a panel', () => {
        const { controller, hub } = make_controller();
        hub.lyricsPanel = null;
        expect(() => controller.toggleLyrics()).not.toThrow();
    });
});

describe('toggle buttons and views', () => {
    it('syncs aria-pressed and the active class', () => {
        const { controller, hub } = make_controller({ lyricsVisible: true });
        controller.sync_lyrics_toggle_buttons();
        expect(hub.lyricsToggleButtons[0].getAttribute('aria-pressed')).toBe('true');
        expect(hub.lyricsToggleButtons[0].classList.contains('player-control-btn--active')).toBe(true);
    });

    it('only shows the video view in read mode with a video id', () => {
        const { controller, hub } = make_controller({
            lyricsVisible: true,
            lyricsMode: 'read',
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        stub_fetch({});
        controller.set_lyrics_view('video');
        expect(hub.lyricsViewMode).toBe('video');
        hub.lyricsMode = 'edit';
        controller.set_lyrics_view('video');
        expect(hub.lyricsViewMode).toBe('lyrics');
    });

    it('marks the selected view tab', () => {
        const { controller, hub } = make_controller({
            lyricsVisible: true,
            lyricsMode: 'read',
            lyricsViewMode: 'video',
        });
        controller.sync_lyrics_view_tabs('abcdefghijk');
        expect(hub.lyricsTabVideo.getAttribute('aria-selected')).toBe('true');
        expect(hub.lyricsTabLyrics.getAttribute('aria-selected')).toBe('false');
        expect(hub.lyricsTabVideo.tabIndex).toBe(0);
    });
});

describe('setLyricsMode', () => {
    it('switches to read mode', () => {
        const { controller, hub } = make_controller();
        controller.setLyricsMode('read');
        expect(hub.lyricsMode).toBe('read');
        expect(hub.lyricsViewWrap.classList.contains('hidden')).toBe(false);
        expect(hub.lyricsEditWrap.classList.contains('hidden')).toBe(true);
    });

    it('switches to edit mode and renders the lrc editor', () => {
        const { controller, hub } = make_controller({
            lastLyricsPayload: {
                lyrics: 'a',
                source: 'lrc',
                has_audio: true,
                lrc_data: [{ text: 'a', time_ms: 0 }],
            },
        });
        controller.setLyricsMode('edit');
        expect(hub.lyricsMode).toBe('edit');
        expect(hub.lyricsViewWrap.classList.contains('hidden')).toBe(true);
        expect(hub.lyricsEditWrap.classList.contains('hidden')).toBe(false);
        expect(hub.lrcEditor.classList.contains('hidden')).toBe(false);
        expect(hub.lyricsEditor.classList.contains('hidden')).toBe(true);
        expect(hub.lrcLinesContainer.querySelectorAll('.lrc-line')).toHaveLength(1);
    });

    it('forces read mode during a search stream', () => {
        const { controller, hub } = make_controller({ searchStreamActive: true });
        controller.setLyricsMode('edit');
        expect(hub.lyricsMode).toBe('read');
    });
});

describe('colors', () => {
    it('applies cover colors to the panel', () => {
        const { controller, hub } = make_controller();
        controller.applyLyricsColors(colors_payload());
        expect(hub.lyricsBgIsDark).toBe(true);
        expect(hub.lyricsPanel.style.backgroundColor).toBe('rgb(18, 52, 86)');
        expect(hub.lyricsPanel.style.getPropertyValue('--lyrics-text-color')).toBe('#ffffff');
        expect(hub.lyricsPanel.style.getPropertyValue('--lyrics-line-dim-color')).toBe('rgba(255,255,255,0.45)');
    });

    it('uses dark text colors on a light background', () => {
        const { controller, hub } = make_controller();
        const colors = colors_payload();
        colors.isDark = false;
        controller.applyLyricsColors(colors);
        expect(hub.lyricsBgIsDark).toBe(false);
        expect(hub.lyricsPanel.style.getPropertyValue('--lyrics-line-dim-color')).toBe('rgba(0,0,0,0.4)');
    });

    it('resets colors to the default panel', () => {
        const { controller, hub } = make_controller();
        controller.resetLyricsColors();
        expect(hub.lyricsPanel.style.backgroundColor).toBe('rgb(18, 18, 18)');
        expect(hub.lyricsPanel.style.getPropertyValue('--lyrics-text-color')).toBe('#ffffff');
    });
});

describe('cover loading', () => {
    it('resets colors when there is no track id', () => {
        const { controller, hub } = make_controller();
        controller.loadCover(null);
        expect(hub.coverWrap.classList.contains('no-art')).toBe(true);
        expect(hub.coverImg.classList.contains('hidden')).toBe(true);
    });

    it('loads a playlist cover url', () => {
        const { controller, hub } = make_controller({ currentTrackId: 't1' });
        controller.loadCover('t1', 'p1');
        expect(hub.coverProbeImg).not.toBeNull();
        expect(hub.coverProbeImg.src).toContain('/playlists/p1/tracks/t1/cover');
    });

    it('falls back to a youtube thumb without a playlist', () => {
        const { controller, hub } = make_controller({
            playlistId: '',
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        controller.loadCover('t1');
        expect(hub.coverProbeImg.src).toContain('/api/thumb?vid=abcdefghijk');
    });

    it('ignores an empty youtube id', () => {
        const { controller, hub } = make_controller();
        controller.load_youtube_cover('');
        expect(hub.coverProbeImg).toBeNull();
    });

    it('loads a youtube cover url', () => {
        const { controller, hub } = make_controller();
        controller.load_youtube_cover('abcdefghijk');
        expect(hub.coverProbeImg.src).toContain('/api/thumb?vid=abcdefghijk');
    });

    it('shows the cover when the probe loads', () => {
        const { controller, hub } = make_controller();
        controller.load_cover_url('/cover.png');
        hub.coverProbeImg.onload();
        expect(hub.coverImg.src).toContain('/cover.png');
        expect(hub.coverImg.classList.contains('hidden')).toBe(false);
        expect(hub.coverWrap.classList.contains('no-art')).toBe(false);
    });

    it('hides the cover when the probe fails', () => {
        const { controller, hub } = make_controller();
        controller.load_cover_url('/cover.png');
        hub.coverProbeImg.onerror();
        expect(hub.coverImg.classList.contains('hidden')).toBe(true);
        expect(hub.coverWrap.classList.contains('no-art')).toBe(true);
    });

    it('extracts colors from a loaded player cover', () => {
        const { controller, hub } = make_controller();
        Object.defineProperty(hub.coverImg, 'complete', { value: true, configurable: true });
        Object.defineProperty(hub.coverImg, 'naturalWidth', { value: 10, configurable: true });
        const spy = vi.spyOn(controller, 'extractCoverColors').mockImplementation(() => {});
        controller.extract_from_player_cover();
        expect(spy).toHaveBeenCalledWith(hub.coverImg);
    });

    it('applies extracted colors and resets on failure', () => {
        const { controller } = make_controller();
        const apply = vi.spyOn(controller, 'applyLyricsColors').mockImplementation(() => {});
        const reset = vi.spyOn(controller, 'resetLyricsColors').mockImplementation(() => {});
        vi.spyOn(controller.colors, 'calculateLyricsColors').mockReturnValue(colors_payload());
        controller.extractCoverColors({});
        expect(apply).toHaveBeenCalled();
        vi.spyOn(controller.colors, 'calculateLyricsColors').mockReturnValue(null);
        controller.extractCoverColors({});
        expect(reset).toHaveBeenCalled();
        vi.spyOn(controller.colors, 'calculateLyricsColors').mockImplementation(() => { throw new Error('x'); });
        controller.extractCoverColors({});
        expect(reset).toHaveBeenCalledTimes(2);
    });
});

describe('youtube id helpers', () => {
    it('reads ids from watch, short, embed, query, bracket and plain text', () => {
        const { controller } = make_controller();
        expect(controller.youtube_id_from_text('https://www.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk');
        expect(controller.youtube_id_from_text('https://youtu.be/abcdefghijk')).toBe('abcdefghijk');
        expect(controller.youtube_id_from_text('https://www.youtube.com/embed/abcdefghijk')).toBe('abcdefghijk');
        expect(controller.youtube_id_from_text('x?foo=1&v=abcdefghijk')).toBe('abcdefghijk');
        expect(controller.youtube_id_from_text('[abcdefghijk]')).toBe('abcdefghijk');
        expect(controller.youtube_id_from_text('abcdefghijk')).toBe('abcdefghijk');
        expect(controller.youtube_id_from_text('nope')).toBe('');
    });

    it('reads ids from track fields and variants', () => {
        const { controller } = make_controller();
        expect(controller.youtube_id_from_track({ youtube_video_id: 'abcdefghijk' })).toBe('abcdefghijk');
        expect(controller.youtube_id_from_track({ url: 'https://youtu.be/abcdefghijk' })).toBe('abcdefghijk');
        expect(controller.youtube_id_from_track({ play_src: 'https://youtu.be/abcdefghijk' })).toBe('abcdefghijk');
        expect(controller.youtube_id_from_track({ play_variants: { a: 'https://youtu.be/abcdefghijk' } })).toBe('abcdefghijk');
        expect(controller.youtube_id_from_track(null)).toBe('');
    });

    it('prefers the search hit video id', () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        expect(controller.current_youtube_vid()).toBe('abcdefghijk');
        hub.searchStreamActive = false;
        expect(controller.current_youtube_vid()).toBe('');
    });

    it('finds the id on the last played snapshot and track list', () => {
        const { controller, hub } = make_controller({
            currentTrackId: 't1',
            lastPlayedTrackSnapshot: { youtube_video_id: 'abcdefghijk' },
        });
        expect(controller.current_youtube_vid()).toBe('abcdefghijk');
        hub.lastPlayedTrackSnapshot = null;
        hub.playingTracks = [{ id: 't1', url: 'https://youtu.be/zyxwvutsrqp' }];
        expect(controller.current_youtube_vid()).toBe('zyxwvutsrqp');
    });

    it('falls back to the track row in the dom', () => {
        const row = document.createElement('tr');
        row.className = 'track-row';
        row.setAttribute('data-track-id', 't9');
        row.setAttribute('data-youtube-video-id', 'abcdefghijk');
        document.body.appendChild(row);
        const { controller } = make_controller({ currentTrackId: 't9' });
        expect(controller.current_youtube_vid()).toBe('abcdefghijk');
    });
});

describe('stream video height', () => {
    it('maps playback kbps to a height', () => {
        const { controller } = make_controller();
        window.SpolocalQualityPrefs = { playbackKbps: () => 64 };
        expect(controller.stream_video_height()).toBe(360);
        window.SpolocalQualityPrefs = { playbackKbps: () => 120 };
        expect(controller.stream_video_height()).toBe(480);
        window.SpolocalQualityPrefs = { playbackKbps: () => 192 };
        expect(controller.stream_video_height()).toBe(720);
        delete window.SpolocalQualityPrefs;
    });
});

describe('stream video binding and playback', () => {
    it('binds the load button and hides when already loaded', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        controller.bind_stream_video();
        expect(hub.lyricsVideoLoad.dataset.bound).toBe('1');
        hub.lyricsVideoLoad.click();
        expect(hub._streamVideoLoaded).toBe(false);
    });

    it('resumes the video when the audio is playing', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        hub.audio.paused = false;
        controller.on_stream_video_paused();
        expect(hub.lyricsVideoEl.play).toHaveBeenCalled();
    });

    it('restarts the video element and keeps the audio rate', () => {
        vi.useFakeTimers();
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        hub.audio.paused = false;
        hub.audio.playbackRate = 1.5;
        controller.restart_stream_video_element();
        expect(hub.lyricsVideoEl.playbackRate).toBe(1.5);
        expect(hub.lyricsVideoEl.pause).toHaveBeenCalled();
        vi.advanceTimersByTime(50);
        expect(hub.lyricsVideoEl.play).toHaveBeenCalled();
    });

    it('restarts and clocks after leaving picture in picture', () => {
        const { controller, hub } = make_controller();
        const restart = vi.spyOn(controller, 'restart_stream_video_element').mockImplementation(() => {});
        const clock = vi.spyOn(controller, 'start_stream_video_frame_clock').mockImplementation(() => {});
        controller.on_leave_picture_in_picture();
        expect(hub._streamVideoNoSeekUntil).toBeGreaterThan(0);
        expect(restart).toHaveBeenCalled();
        expect(clock).toHaveBeenCalled();
    });

    it('reads the base playback rate', () => {
        const { controller, hub } = make_controller();
        hub.audio.playbackRate = 1.25;
        expect(controller.stream_video_base_rate()).toBe(1.25);
        hub.audio.playbackRate = 0;
        expect(controller.stream_video_base_rate()).toBe(1);
    });

    it('starts and stops the frame clock', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        controller.start_stream_video_frame_clock();
        expect(hub._streamVideoFrameClockOn).toBe(true);
        expect(requestAnimationFrame).toHaveBeenCalled();
        hub._streamVideoFrameHandle = 5;
        controller.stop_stream_video_frame_clock();
        expect(hub._streamVideoFrameClockOn).toBe(false);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(5);
    });

    it('corrects small and large drift', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        hub.audio.currentTime = 10;
        hub.lyricsVideoEl.currentTime = 10;
        controller.sync_stream_video_clock_frame(10);
        expect(hub.lyricsVideoEl.playbackRate).toBe(1);
        controller.sync_stream_video_clock_frame(9.97);
        expect(hub.lyricsVideoEl.playbackRate).toBeGreaterThan(1);
        controller.sync_stream_video_clock_frame(5);
        expect(hub.lyricsVideoEl.currentTime).toBe(10);
    });

    it('nudges the playback rate toward the target', () => {
        const { controller, hub } = make_controller();
        controller.nudge_stream_video_rate(hub.lyricsVideoEl, 0.05);
        expect(hub.lyricsVideoEl.playbackRate).toBeGreaterThan(1);
        controller.nudge_stream_video_rate(hub.lyricsVideoEl, -0.05);
        expect(hub.lyricsVideoEl.playbackRate).toBeLessThan(1);
        controller.nudge_stream_video_rate(hub.lyricsVideoEl, 0);
        expect(hub.lyricsVideoEl.playbackRate).toBe(1);
    });

    it('uses the seek bar while seeking', () => {
        const { controller, hub } = make_controller();
        hub.seeking = true;
        hub.seek.value = '500';
        hub.audio.duration = 100;
        expect(controller.stream_video_target_time()).toBe(50);
        hub.seeking = false;
        hub.audio.currentTime = 12;
        expect(controller.stream_video_target_time()).toBe(12);
    });

    it('primes the clock when the video is already at the target', () => {
        const { controller, hub } = make_controller({
            _streamVideoPrimeSeek: true,
            _streamVideoLoaded: true,
        });
        hub.audio.currentTime = 10;
        hub.lyricsVideoEl.currentTime = 10;
        const clock = vi.spyOn(controller, 'start_stream_video_frame_clock').mockImplementation(() => {});
        controller.prime_stream_video_clock();
        expect(hub._streamVideoPrimeSeek).toBe(false);
        expect(clock).toHaveBeenCalled();
    });

    it('does nothing when not priming', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        controller.prime_stream_video_clock();
        expect(hub._streamVideoPrimeSeek).toBeUndefined();
    });
});

describe('stream video pane', () => {
    it('does nothing without a pane', () => {
        const { controller, hub } = make_controller();
        hub.lyricsVideoPane = null;
        expect(() => controller.sync_stream_video_pane()).not.toThrow();
    });

    it('hides and unloads the pane when not visible', () => {
        const { controller, hub } = make_controller();
        const unload = vi.spyOn(controller, 'unload_stream_video').mockImplementation(() => {});
        controller.sync_stream_video_pane();
        expect(hub.lyricsVideoPane.classList.contains('hidden')).toBe(true);
        expect(unload).toHaveBeenCalled();
    });

    it('shows the pane and prepares the stream when visible', () => {
        const { controller, hub } = make_controller({
            lyricsVisible: true,
            lyricsMode: 'read',
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        const fetch_fn = stub_fetch({});
        controller.sync_stream_video_pane();
        expect(hub.lyricsVideoPane.classList.contains('hidden')).toBe(false);
        expect(fetch_fn).toHaveBeenCalled();
    });

    it('sets the load label on a span or the button', () => {
        const { controller, hub } = make_controller();
        controller.set_video_load_label('Hello');
        expect(hub.lyricsVideoLoad.querySelector('span').textContent).toBe('Hello');
        const plain = document.createElement('button');
        hub.lyricsVideoLoad = plain;
        controller.set_video_load_label('Plain');
        expect(plain.textContent).toBe('Plain');
    });

    it('prepares the stream once per video and height', async () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        const fetch_fn = stub_fetch({});
        const first = controller.prepare_stream_video();
        const second = controller.prepare_stream_video();
        expect(first).toBe(second);
        await first;
        expect(fetch_fn).toHaveBeenCalledTimes(1);
        expect(fetch_fn.mock.calls[0][0]).toContain('/api/stream/video/prepare?vid=abcdefghijk');
        expect(hub._streamVideoPrepareKey).toBe('abcdefghijk:720');
    });

    it('resolves immediately without a video id', async () => {
        const { controller } = make_controller();
        await expect(controller.prepare_stream_video()).resolves.toBeUndefined();
    });
});

describe('fullscreen', () => {
    it('reports no fullscreen element', () => {
        const { controller } = make_controller();
        expect(controller.fullscreen_element()).toBeNull();
    });

    it('syncs the fullscreen icon', () => {
        const { controller, hub } = make_controller();
        controller.sync_stream_video_fs_icon();
        expect(hub.lyricsVideoFs.getAttribute('title')).toBe('Full screen');
        expect(hub.lyricsVideoFs.querySelector('i').className).toBe('fa-solid fa-expand');
    });

    it('requests fullscreen on the stack when loaded', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        hub.lyricsVideoStack.requestFullscreen = vi.fn(() => Promise.resolve());
        controller.toggle_stream_video_fullscreen();
        expect(hub.lyricsVideoStack.requestFullscreen).toHaveBeenCalled();
    });

    it('does nothing when the video is not loaded', () => {
        const { controller, hub } = make_controller();
        hub.lyricsVideoStack.requestFullscreen = vi.fn(() => Promise.resolve());
        controller.toggle_stream_video_fullscreen();
        expect(hub.lyricsVideoStack.requestFullscreen).not.toHaveBeenCalled();
    });
});

describe('hide and load stream video', () => {
    it('hides the video and resets state', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        controller.hide_stream_video();
        expect(hub._streamVideoLoaded).toBe(false);
        expect(hub.lyricsVideoEl.pause).toHaveBeenCalled();
        expect(hub.lyricsVideoEl.removeAttribute).toHaveBeenCalledWith('src');
        expect(hub.lyricsVideoEl.classList.add).toHaveBeenCalledWith('hidden');
        expect(hub.lyricsVideoLoad.querySelector('span').textContent).toBe('Click to load video');
    });

    it('hides on error and unload', () => {
        const { controller } = make_controller();
        const hide = vi.spyOn(controller, 'hide_stream_video').mockImplementation(() => {});
        controller.on_stream_video_error();
        controller.unload_stream_video();
        expect(hide).toHaveBeenCalledTimes(2);
    });

    it('loads the stream video after preparing', async () => {
        const { controller, hub } = make_controller({
            searchStreamActive: true,
            searchStreamHit: { video_id: 'abcdefghijk' },
        });
        stub_fetch({});
        controller.load_stream_video();
        expect(hub._streamVideoLoading).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(hub._streamVideoLoaded).toBe(true);
        expect(hub.lyricsVideoEl.src).toContain('/api/stream/video?vid=abcdefghijk');
    });

    it('ignores a load without a video id', () => {
        const { controller, hub } = make_controller();
        controller.load_stream_video();
        expect(hub._streamVideoLoading).toBeUndefined();
    });

    it('reloads only when already loaded', () => {
        const { controller, hub } = make_controller();
        const load = vi.spyOn(controller, 'load_stream_video').mockImplementation(() => {});
        controller.reload_stream_video_if_loaded();
        expect(load).not.toHaveBeenCalled();
        hub._streamVideoLoaded = true;
        controller.reload_stream_video_if_loaded();
        expect(load).toHaveBeenCalled();
    });

    it('plays and pauses with the audio', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        const clock = vi.spyOn(controller, 'start_stream_video_frame_clock').mockImplementation(() => {});
        controller.sync_stream_video_play(true);
        expect(hub.lyricsVideoEl.play).toHaveBeenCalled();
        expect(clock).toHaveBeenCalled();
        controller.sync_stream_video_play(false);
        expect(hub.lyricsVideoEl.pause).toHaveBeenCalled();
    });

    it('seeks the video when forced', () => {
        const { controller, hub } = make_controller({ _streamVideoLoaded: true });
        hub.audio.currentTime = 12;
        controller.sync_stream_video_clock(true);
        expect(hub.lyricsVideoEl.currentTime).toBe(12);
        expect(hub.lyricsVideoEl.playbackRate).toBe(1);
    });

    it('does nothing when the video is not loaded', () => {
        const { controller, hub } = make_controller();
        controller.sync_stream_video_clock(true);
        expect(hub.lyricsVideoEl.currentTime).toBe(0);
    });
});

describe('lyrics prefetch', () => {
    it('warms the next three tracks after loading lyrics', async () => {
        const playable = [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }];
        const { controller } = make_controller({
            currentTrackId: 't1',
            playingPlaylistId: 'p1',
            playable,
        });
        const fetch_fn = stub_fetch({ lyrics: 'one', source: 'plain', has_audio: true });
        await controller.fetchLyrics(true);
        const urls = fetch_fn.mock.calls.map((call) => call[0]);
        expect(urls).toContain('/playlists/p1/tracks/t2/lyrics');
        expect(urls).toContain('/playlists/p1/tracks/t3/lyrics');
        expect(urls).toContain('/playlists/p1/tracks/t4/lyrics');
        expect(urls).toHaveLength(4);
    });

    it('serves a prefetched payload without fetching again', async () => {
        const { controller, hub } = make_controller({ currentTrackId: 't2', playingPlaylistId: 'p1' });
        hub._lyricsPrefetch = new Map([
            ['p1:t2', { lyrics: 'cached\nline', source: 'plain', has_audio: true }],
        ]);
        const fetch_fn = stub_fetch({});
        await controller.fetchLyrics(true);
        expect(fetch_fn).not.toHaveBeenCalled();
        expect(hub.lyricsBody.querySelectorAll('.lyrics-line')).toHaveLength(2);
        expect(hub._lyricsPrefetch.has('p1:t2')).toBe(false);
    });

    it('does not prefetch on data saver', async () => {
        const playable = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
        const { controller } = make_controller({
            currentTrackId: 't1',
            playingPlaylistId: 'p1',
            playable,
        });
        window.SpolocalQualityPrefs = { playbackKbps: () => 64 };
        try {
            const fetch_fn = stub_fetch({ lyrics: 'one', source: 'plain', has_audio: true });
            await controller.fetchLyrics(true);
            expect(fetch_fn).toHaveBeenCalledTimes(1);
        } finally {
            delete window.SpolocalQualityPrefs;
        }
    });
});
