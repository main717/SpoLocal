import { beforeEach, describe, expect, it, vi } from 'vitest';

function json_response(data, ok = true, content_type = 'application/json') {
    return {
        ok,
        status: ok ? 200 : 400,
        headers: { get: () => content_type },
        json: async () => data,
    };
}

function default_fetch(url) {
    if (String(url).indexOf('/api/playlists/catalog') === 0) {
        return Promise.resolve(json_response([]));
    }
    return Promise.resolve(json_response({}));
}

function mount_shell_dom() {
    document.body.innerHTML = `
        <button id="mobile-open-nav"></button>
        <button id="mobile-close-nav"></button>
        <button id="mobile-open-dl"></button>
        <button id="mobile-close-dl"></button>
        <div id="mobile-nav-backdrop"></div>
        <div id="mobile-dl-backdrop"></div>
        <form id="top-import-form">
            <input id="top-import-input">
        </form>
        <div id="global-search-panel" class="hidden"></div>
        <div id="global-search-label"></div>
        <div id="global-search-msg" class="hidden"></div>
        <div id="global-search-list"></div>
        <div id="global-search-pager" class="hidden"></div>
        <button id="global-prev-btn"></button>
        <button id="global-next-btn"></button>
        <div id="global-page-label"></div>
        <button id="global-search-close"></button>
        <div id="add-to-playlist-popover" class="hidden"></div>
        <input id="atp-filter">
        <div id="atp-list-inner"></div>
        <button id="atp-new-toggle"></button>
        <div id="atp-new-row" class="hidden"></div>
        <form id="atp-new-form">
            <input id="atp-new-name">
            <button type="submit"></button>
        </form>
        <div id="atp-download-tiers"></div>
        <div id="atp-download-kbps-value"></div>
        <div id="sidebar-playlist-list"></div>
        <div id="playlist-recommendations-grid"></div>
        <div id="playlist-recommendations-msg" class="hidden"></div>
    `;
}

async function load_shell() {
    vi.resetModules();
    await import('../../static/js/app_shell.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
    return window.AppShell;
}

function make_anchor() {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    return anchor;
}

beforeEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
    delete window.AppShell;
    delete window.SpolocalCoverUrls;
    delete window.SpolocalQualityPrefs;
    delete window.__spaPlaylistId;
    delete window.__spolocalRecsQualityBound;
    delete window.closeContextMenu;
    delete window.navigatePlaylist;
    delete window.applySpaPlaylist;
    delete window.invalidatePlaylistViewCache;
    delete window.refreshHomeView;
    delete window.loadPlaylistRecommendations;
    delete window.ensurePlaylistRecommendations;
    delete window.bustPlaylistCoverImages;
    delete window.applyQualityAwareCovers;
    delete window.spolocalStreamSrc;
    delete window.stopSearchStream;
    delete window.playPreview;
    delete window.openAddToPlaylistAtPoint;
    delete window.closeGlobalSearch;
    delete window.resetSpolocalSearchCards;
    delete window.nextSpolocalStreamLoadGen;
    delete window.renderSpolocalMixRows;
    mount_shell_dom();
    vi.stubGlobal('fetch', vi.fn(default_fetch));
});

describe('mobile sheet drawers', () => {
    it('opens and closes the nav drawer', async () => {
        await load_shell();
        const open = document.getElementById('mobile-open-nav');
        open.click();
        expect(document.body.classList.contains('mobile-nav-open')).toBe(true);
        expect(open.getAttribute('aria-expanded')).toBe('true');
        open.click();
        expect(document.body.classList.contains('mobile-nav-open')).toBe(false);
        expect(open.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens the downloads drawer and closes the nav drawer', async () => {
        await load_shell();
        document.getElementById('mobile-open-nav').click();
        document.getElementById('mobile-open-dl').click();
        expect(document.body.classList.contains('mobile-nav-open')).toBe(false);
        expect(document.body.classList.contains('mobile-dl-open')).toBe(true);
        expect(document.getElementById('mobile-open-dl').getAttribute('aria-expanded')).toBe('true');
    });

    it('closes both drawers on Escape', async () => {
        await load_shell();
        document.getElementById('mobile-open-nav').click();
        document.getElementById('mobile-open-dl').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.body.classList.contains('mobile-nav-open')).toBe(false);
        expect(document.body.classList.contains('mobile-dl-open')).toBe(false);
    });

    it('closes the nav drawer from its backdrop and close button', async () => {
        await load_shell();
        document.getElementById('mobile-open-nav').click();
        document.getElementById('mobile-nav-backdrop').click();
        expect(document.body.classList.contains('mobile-nav-open')).toBe(false);
        document.getElementById('mobile-open-nav').click();
        document.getElementById('mobile-close-nav').click();
        expect(document.body.classList.contains('mobile-nav-open')).toBe(false);
    });

    it('closes the nav drawer when a spa link is clicked', async () => {
        await load_shell();
        document.getElementById('mobile-open-nav').click();
        const link = document.createElement('a');
        link.className = 'playlist-spa-nav';
        document.body.appendChild(link);
        link.click();
        expect(document.body.classList.contains('mobile-nav-open')).toBe(false);
    });
});

describe('global search overlay', () => {
    it('opens the panel and renders hits', async () => {
        const shell = await load_shell();
        fetch.mockResolvedValue(json_response({
            hits: [{ video_id: 'abc123', title: 'Song', artist: 'Artist', duration_sec: 65 }],
            has_more: false,
        }));

        await shell.runGlobalSearch('song');

        expect(document.getElementById('global-search-panel').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('global-search-label').textContent).toBe('Results for "song"');
        expect(document.querySelectorAll('#global-search-list .preview-btn')).toHaveLength(1);
        expect(document.getElementById('global-search-pager').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('global-search-msg').classList.contains('hidden')).toBe(true);
    });

    it('shows a message when the search returns nothing', async () => {
        const shell = await load_shell();
        fetch.mockResolvedValue(json_response({ hits: [], has_more: false }));

        await shell.runGlobalSearch('nothing');

        expect(document.getElementById('global-search-msg').textContent).toBe('No results.');
        expect(document.getElementById('global-search-msg').classList.contains('hidden')).toBe(false);
    });

    it('shows the server error detail when the search fails', async () => {
        const shell = await load_shell();
        fetch.mockResolvedValue(json_response({ detail: 'boom' }, false));

        await shell.runGlobalSearch('song');

        expect(document.getElementById('global-search-msg').textContent).toBe('boom');
    });

    it('closes the panel through closeGlobalSearch', async () => {
        const shell = await load_shell();
        fetch.mockResolvedValue(json_response({ hits: [{ video_id: 'abc123', title: 'Song' }] }));
        await shell.runGlobalSearch('song');

        shell.closeGlobalSearch();

        expect(document.getElementById('global-search-panel').classList.contains('hidden')).toBe(true);
    });

    it('closes the panel on Escape and on the close button', async () => {
        const shell = await load_shell();
        fetch.mockResolvedValue(json_response({ hits: [{ video_id: 'abc123', title: 'Song' }] }));
        await shell.runGlobalSearch('song');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.getElementById('global-search-panel').classList.contains('hidden')).toBe(true);

        await shell.runGlobalSearch('song');
        document.getElementById('global-search-close').click();
        expect(document.getElementById('global-search-panel').classList.contains('hidden')).toBe(true);
    });

    it('opens the panel with a hint when the search form is empty', async () => {
        await load_shell();
        const form = document.getElementById('top-import-form');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

        expect(document.getElementById('global-search-panel').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('global-search-label').textContent).toBe('Search');
        expect(document.getElementById('global-search-msg').textContent).toBe('Type a search term or paste a link to import.');
    });

    it('pages forward with the next button', async () => {
        const shell = await load_shell();
        shell.searchHasMore = true;
        shell.currentSearchQuery = 'song';
        const run = vi.spyOn(shell, 'runGlobalSearch').mockResolvedValue();

        document.getElementById('global-next-btn').click();

        expect(run).toHaveBeenCalledWith('song', 6);
    });
});

describe('add-to-playlist popover', () => {
    it('opens, renders the catalog and positions itself', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [
            { id: 'p1', name: 'Alpha', cover_tiles: [] },
            { id: 'p2', name: 'Beta', cover_tiles: [] },
        ];
        const hit = { title: 'Song' };
        const anchor = make_anchor();

        shell.openAddToPlaylistPopover(hit, anchor);

        const pop = document.getElementById('add-to-playlist-popover');
        expect(pop.classList.contains('hidden')).toBe(false);
        expect(shell.pendingAddHit).toBe(hit);
        expect(shell.lastAtpAnchor).toBe(anchor);
        expect(document.querySelectorAll('#atp-list-inner button')).toHaveLength(2);
        expect(pop.style.left).toBe('8px');
        expect(pop.style.top).toBe('8px');
    });

    it('closes and clears the pending hit', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [{ id: 'p1', name: 'Alpha', cover_tiles: [] }];
        shell.openAddToPlaylistPopover({ title: 'Song' }, make_anchor());

        shell.closeAddToPlaylistPopover();

        expect(document.getElementById('add-to-playlist-popover').classList.contains('hidden')).toBe(true);
        expect(shell.pendingAddHit).toBe(null);
        expect(shell.lastAtpAnchor).toBe(null);
        expect(document.getElementById('atp-filter').value).toBe('');
    });

    it('filters the list and skips locked playlists', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [
            { id: 'p1', name: 'Alpha', cover_tiles: [] },
            { id: 'p2', name: 'Beta', cover_tiles: [] },
            { id: 'p3', name: 'Locked', cover_tiles: [], system_locked: true },
        ];
        shell.openAddToPlaylistPopover({ title: 'Song' }, make_anchor());
        const filter = document.getElementById('atp-filter');

        filter.value = 'be';
        filter.dispatchEvent(new Event('input', { bubbles: true }));
        const buttons = document.querySelectorAll('#atp-list-inner button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toContain('Beta');

        filter.value = 'zzz';
        filter.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.querySelector('#atp-list-inner p').textContent).toBe('No matching playlists.');
    });

    it('shows the empty catalog hint', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [];
        shell.renderAtpList();
        expect(document.querySelector('#atp-list-inner p').textContent).toContain('No playlists yet');
    });

    it('opens at a point through a ghost anchor and removes it on close', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [{ id: 'p1', name: 'Alpha', cover_tiles: [] }];

        shell.openAddToPlaylistAtPoint({ title: 'Song' }, 10, 20);

        const ghost = document.querySelector('.open-add-to-playlist');
        expect(ghost).not.toBe(null);
        expect(shell.atpGhostAnchor).toBe(ghost);
        expect(document.getElementById('add-to-playlist-popover').classList.contains('hidden')).toBe(false);

        shell.closeAddToPlaylistPopover();
        expect(document.querySelector('.open-add-to-playlist')).toBe(null);
    });

    it('closes on Escape and on an outside click', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [{ id: 'p1', name: 'Alpha', cover_tiles: [] }];
        const pop = document.getElementById('add-to-playlist-popover');

        shell.openAddToPlaylistPopover({ title: 'Song' }, make_anchor());
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(pop.classList.contains('hidden')).toBe(true);

        shell.openAddToPlaylistPopover({ title: 'Song' }, make_anchor());
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(pop.classList.contains('hidden')).toBe(true);
    });

    it('toggles the new playlist row', async () => {
        await load_shell();
        const row = document.getElementById('atp-new-row');
        const toggle = document.getElementById('atp-new-toggle');
        expect(row.classList.contains('hidden')).toBe(true);
        toggle.click();
        expect(row.classList.contains('hidden')).toBe(false);
        toggle.click();
        expect(row.classList.contains('hidden')).toBe(true);
    });

    it('adds the pending hit when a playlist is clicked', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [{ id: 'p1', name: 'Alpha', cover_tiles: [] }];
        const hit = { title: 'Song' };
        shell.openAddToPlaylistPopover(hit, make_anchor());
        const add = vi.spyOn(shell, 'addTrackToPlaylist').mockResolvedValue({});

        document.querySelector('#atp-list-inner button').click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(add).toHaveBeenCalledWith('p1', hit);
        expect(document.getElementById('add-to-playlist-popover').classList.contains('hidden')).toBe(true);
    });
});

describe('static helpers', () => {
    it('formats durations', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.fmtDur(0)).toBe('0:00');
        expect(Shell.fmtDur(65)).toBe('1:05');
        expect(Shell.fmtDur(59.9)).toBe('0:59');
        expect(Shell.fmtDur(null)).toBe('');
        expect(Shell.fmtDur(Infinity)).toBe('');
    });

    it('detects urls', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.isUrl('https://example.com')).toBe(true);
        expect(Shell.isUrl('http://example.com')).toBe(true);
        expect(Shell.isUrl('spotify:track:abc')).toBe(true);
        expect(Shell.isUrl('just text')).toBe(false);
    });

    it('normalizes spotify input', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.normalizeSpotifyInput('')).toBe('');
        expect(Shell.normalizeSpotifyInput('spotify:track:abc?si=1')).toBe('spotify:track:abc');
        expect(Shell.normalizeSpotifyInput('https://open.spotify.com/track/abc?si=1')).toBe('https://open.spotify.com/track/abc');
        expect(Shell.normalizeSpotifyInput('https://open.spotify.com/track/abc/')).toBe('https://open.spotify.com/track/abc');
    });

    it('classifies spotify urls', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.spotifyUrlKind('https://open.spotify.com/track/abc')).toBe('track');
        expect(Shell.spotifyUrlKind('https://open.spotify.com/playlist/abc')).toBe('playlist');
        expect(Shell.spotifyUrlKind('spotify:track:abc')).toBe('track');
        expect(Shell.spotifyUrlKind('spotify:playlist:abc')).toBe('playlist');
        expect(Shell.spotifyUrlKind('https://example.com')).toBe(null);
    });

    it('adds a cache bust only when asked', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.withCoverCacheBust('/a.jpg', null)).toBe('/a.jpg');
        expect(Shell.withCoverCacheBust('/a.jpg', 123)).toBe('/a.jpg?v=123');
        expect(Shell.withCoverCacheBust('/a.jpg?x=1', 5)).toBe('/a.jpg?x=1&v=5');
    });

    it('applies the cover quality to track covers', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        window.SpolocalCoverUrls = { qualityKey: () => 'low' };
        expect(Shell.withCoverQuality('/tracks/1/cover')).toBe('/tracks/1/cover?q=low');
        window.SpolocalCoverUrls = { qualityKey: () => 'high' };
        expect(Shell.withCoverQuality('/tracks/1/cover')).toBe('/tracks/1/cover');
        expect(Shell.withCoverQuality('/other.jpg')).toBe('/other.jpg');
    });

    it('builds the stream url', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.streamSrcForVideoId('a b')).toBe('/api/stream?vid=a%20b');
    });

    it('finds a playable local match', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        const match = { playlist_id: 'p1', track_id: 't1', play_src: '/media/t1.webm' };
        expect(Shell.library_local_match({ library_matches: [match] })).toBe(match);
        expect(Shell.library_local_match({ library_matches: [{ play_src: '' }] })).toBe(null);
        expect(Shell.library_local_match({})).toBe(null);
    });

    it('checks whether a library match is the current track', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.library_match_is_current({ library_matches: [{ track_id: 't1' }] })).toBe(false);
        window.SpolocalPlayerHub = { currentTrackId: 't1' };
        expect(Shell.library_match_is_current({ library_matches: [{ track_id: 't1' }] })).toBe(true);
        expect(Shell.library_match_is_current({ library_matches: [{ track_id: 't2' }] })).toBe(false);
    });

    it('builds a four cell playlist art grid', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        const grid = Shell.buildPlaylistArtGridEl(['/a.jpg', '/b.jpg']);
        expect(grid.children).toHaveLength(4);
        expect(grid.querySelectorAll('img')).toHaveLength(2);
        expect(grid.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
        expect(grid.className).toContain('grid-cols-2');
    });

    it('parses json api responses', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        const data = await Shell.parseJsonApiResponse(json_response({ a: 1 }), 'fallback');
        expect(data).toEqual({ a: 1 });
        await expect(Shell.parseJsonApiResponse(json_response({ detail: 'bad' }, false), 'fallback')).rejects.toThrow('bad');
        await expect(Shell.parseJsonApiResponse(json_response({}, false, 'text/html'), 'fallback')).rejects.toThrow('fallback');
        const ok = await Shell.parseJsonApiResponse(json_response({}, true, 'text/html'), 'fallback');
        expect(ok).toEqual({ ok: true });
    });

    it('resolves recommendation cover sources', async () => {
        const shell = await load_shell();
        const Shell = shell.constructor;
        expect(Shell.rec_hit_cover_src({ video_id: 'abc' })).toBe('https://i.ytimg.com/vi/abc/default.jpg');
        expect(Shell.rec_hit_cover_src({ thumbnail_url: '/thumb.jpg' })).toBe('/thumb.jpg');
        window.SpolocalCoverUrls = { youtubeThumbUrl: (vid) => '/thumb/' + vid };
        expect(Shell.rec_hit_cover_src({ video_id: 'abc' })).toBe('/thumb/abc');
    });
});

describe('playPreview on the song mix page', () => {
    it('always streams the mix row instead of playing its library match', async () => {
        const shell = await load_shell();
        const play = vi.fn(() => Promise.resolve());
        const hub = {
            songMixView: true,
            currentTrackId: 't1',
            searchStreamActive: false,
            searchStreamHit: null,
            playbackContext: 'playlist',
            audio: {
                paused: false,
                src: '',
                play,
                pause: vi.fn(),
                removeAttribute: vi.fn(),
                load: vi.fn(),
            },
            playLibraryEntry: vi.fn(),
            setPlayUi: vi.fn(),
        };
        window.SpolocalPlayerHub = hub;
        shell.stopPreview = vi.fn();
        shell.reset_search_card_buttons = vi.fn();
        shell.next_stream_load_gen = vi.fn();
        shell.prepare_stream_url = vi.fn(() => Promise.resolve());

        shell.playPreview({
            video_id: 'abcdefghijk',
            title: 'Mix',
            artist: 'Artist',
            library_matches: [{ playlist_id: 'p1', track_id: 't1', play_src: '/media/t1.webm' }],
        }, null);

        expect(hub.playLibraryEntry).not.toHaveBeenCalled();
        expect(hub.searchStreamActive).toBe(true);
        expect(hub.searchStreamHit).toEqual(expect.objectContaining({ video_id: 'abcdefghijk' }));
        expect(hub.playbackContext).toBe('recs');
        expect(play).toHaveBeenCalled();
    });
});

describe('playlists catalog and sidebar', () => {
    it('reloads the catalog and reports whether it changed', async () => {
        const shell = await load_shell();
        fetch.mockResolvedValue(json_response([{ id: 'p1', name: 'One' }]));

        const changed = await shell.reloadPlaylistsCatalog();
        expect(changed).toBe(true);
        expect(shell.playlistsCatalog).toEqual([{ id: 'p1', name: 'One' }]);
        expect(window.__playlistsCatalog).toEqual([{ id: 'p1', name: 'One' }]);

        const again = await shell.reloadPlaylistsCatalog();
        expect(again).toBe(false);
    });

    it('renders the sidebar playlist list with the active card', async () => {
        const shell = await load_shell();
        shell.playlistsCatalog = [
            { id: 'p1', name: 'One', cover_tiles: [] },
            { id: 'p2', name: 'Two', cover_tiles: [] },
        ];

        shell.renderSidebarPlaylistList('p1');

        const cards = document.querySelectorAll('#sidebar-playlist-list .playlist-card');
        expect(cards).toHaveLength(2);
        expect(cards[0].classList.contains('nav-active')).toBe(true);
        expect(cards[1].classList.contains('nav-active')).toBe(false);
        expect(cards[0].querySelector('a').getAttribute('href')).toBe('/?playlist_id=p1');
    });

    it('creates a playlist from the popover', async () => {
        const shell = await load_shell();
        fetch.mockClear();
        fetch.mockResolvedValue(json_response({ playlist: { id: 'p9' } }));

        const result = await shell.constructor.createPlaylistFromAtp('Mix', {
            title: 'Song',
            artist: 'Artist',
            url: 'https://example.com',
            album: '',
            video_id: 'abc',
        });

        expect(result.playlist.id).toBe('p9');
        const call = fetch.mock.calls[0];
        expect(call[0]).toBe('/api/playlists');
        expect(call[1].method).toBe('POST');
        const body = JSON.parse(call[1].body);
        expect(body.name).toBe('Mix');
        expect(body.title).toBe('Song');
        expect(body.video_id).toBe('abc');
        expect(body.quality).toBe('192');
    });

    it('adds a track to a playlist and refreshes the view', async () => {
        const shell = await load_shell();
        fetch.mockClear();
        fetch.mockResolvedValue(json_response({ ok: true }));
        shell.afterTrackAddedToPlaylist = vi.fn(() => Promise.resolve());

        const result = await shell.addTrackToPlaylist('p1', {
            title: 'Song',
            artist: 'Artist',
            url: 'https://example.com',
            album: '',
            library_matches: [{ playlist_id: 'p0', track_id: 't0' }],
        });

        expect(result).toEqual({ ok: true });
        const call = fetch.mock.calls[0];
        expect(call[0]).toBe('/playlists/p1/tracks');
        expect(call[1].method).toBe('POST');
        expect(call[1].body.get('title')).toBe('Song');
        expect(call[1].body.get('source_playlist_id')).toBe('p0');
        expect(shell.afterTrackAddedToPlaylist).toHaveBeenCalledWith('p1');
    });
});

describe('ensurePlaylistRecommendations', () => {
    it('renders the cached hits without fetching', async () => {
        const shell = await load_shell();
        shell.recs_cache_pid = 'p1';
        shell.recs_cache_hits = [{ video_id: 'r1', title: 'T', artist: 'A' }];
        shell.fetchPlaylistRecommendationsWhenVisible = vi.fn();

        shell.ensurePlaylistRecommendations('p1');

        expect(shell.fetchPlaylistRecommendationsWhenVisible).not.toHaveBeenCalled();
        const table = document.getElementById('playlist-recommendations-table');
        expect(table).not.toBeNull();
        expect(table.querySelectorAll('tr[data-youtube-video-id]').length).toBe(1);
    });

    it('fetches when the cache belongs to another playlist', async () => {
        const shell = await load_shell();
        shell.recs_cache_pid = 'p2';
        shell.recs_cache_hits = [{ video_id: 'r1', title: 'T', artist: 'A' }];
        shell.disconnectPlaylistRecommendationsObserver = vi.fn();
        shell.paint_recs_cache_or_fetch = vi.fn();

        shell.ensurePlaylistRecommendations('p1');

        expect(shell.disconnectPlaylistRecommendationsObserver).toHaveBeenCalled();
        expect(shell.paint_recs_cache_or_fetch).toHaveBeenCalledWith('p1');
    });

    it('does nothing without a playlist id', async () => {
        const shell = await load_shell();
        shell.paint_recs_cache_or_fetch = vi.fn();
        shell.ensurePlaylistRecommendations('');
        expect(shell.paint_recs_cache_or_fetch).not.toHaveBeenCalled();
    });
});
