import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistSessionController } from '../../static/js/playlist/session.js';

function make_hub(overrides = {}) {
    return {
        isHomeView: false,
        playlistId: 'p1',
        songMixView: false,
        tracks: [],
        playable: [],
        currentTrackId: null,
        playingPlaylistId: null,
        playingTracks: [],
        playingPlayable: [],
        queueVisible: false,
        lyricsVisible: false,
        audio: { paused: true },
        ...overrides,
    };
}

function make_controller(hub_overrides = {}) {
    const state = { hub: make_hub(hub_overrides) };
    const controller = new PlaylistSessionController(state);

    controller.transport.updatePlayingRow = vi.fn();
    controller.transport.setPlayUi = vi.fn();
    controller.transport.scrollTrackIntoView = vi.fn();
    controller.transport.likes.bind_track_row_like_buttons = vi.fn();
    controller.transport.likes.refresh_liked_keys_from_server = vi.fn(() => Promise.resolve());
    controller.transport.likes.update_like_button_ui = vi.fn();
    controller.transport.likes.update_track_row_like_buttons = vi.fn();
    controller.transport.shuffle.syncShuffleOrderWithPlaylist = vi.fn();
    controller.transport.mediaSession.persistPlaybackProgress = vi.fn();
    controller.queue.render_queue_list = vi.fn();
    controller.queue.restore_manual_queue_from_storage = vi.fn();
    controller.queue.toggleQueue = vi.fn();
    controller.home.render = vi.fn();
    controller.settings.close = vi.fn();
    controller.lyrics.sync_lyrics_toggle_buttons = vi.fn();
    controller.lyrics.resetLyricsColors = vi.fn();

    return { controller, state, hub: state.hub };
}

function json_response(data, ok = true) {
    return {
        ok,
        json: async () => data,
    };
}

beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
    delete window.AppShell;
    delete window.closeGlobalSearch;
    delete window.loadPlaylistRecommendations;
    delete window.syncPlaylistEditModalFromFragment;
    delete window.bustPlaylistCoverImages;
    delete window.__spaPlaylistId;
    delete window.refreshPlaylistView;
});

describe('constructor', () => {
    it('wires the sub-controllers together and sets up the view cache', () => {
        const { controller } = make_controller();
        expect(controller.transport.queue).toBe(controller.queue);
        expect(controller.transport.likes).toBe(controller.likes);
        expect(controller.transport.shuffle).toBe(controller.shuffle);
        expect(controller.shuffle.queue).toBe(controller.queue);
        expect(controller.quality.lyrics).toBe(controller.lyrics);
        expect(controller.download.session).toBe(controller);
        expect(controller._viewCache instanceof Map).toBe(true);
        expect(controller.VIEW_CACHE_MS).toBe(15000);
    });
});

describe('invalidateViewCache', () => {
    it('removes a single cached playlist', () => {
        const { controller } = make_controller();
        controller._viewCache.set('p1', { data: {}, ts: 1 });
        controller._viewCache.set('p2', { data: {}, ts: 1 });
        controller.invalidateViewCache('p1');
        expect(controller._viewCache.has('p1')).toBe(false);
        expect(controller._viewCache.has('p2')).toBe(true);
    });

    it('clears the whole cache when no id is given', () => {
        const { controller } = make_controller();
        controller._viewCache.set('p1', { data: {}, ts: 1 });
        controller._viewCache.set('p2', { data: {}, ts: 1 });
        controller.invalidateViewCache();
        expect(controller._viewCache.size).toBe(0);
    });

    it('clears the whole cache for null', () => {
        const { controller } = make_controller();
        controller._viewCache.set('p1', { data: {}, ts: 1 });
        controller.invalidateViewCache(null);
        expect(controller._viewCache.size).toBe(0);
    });
});

describe('reloadPlaylistView', () => {
    it('refetches the current playlist and re-renders it', async () => {
        const { controller, hub } = make_controller({ playlistId: 'p1' });
        const data = { playlist_id: 'p1', tracks_payload: [{ id: 't2' }], html: '<div></div>' };
        const fetch_mock = vi.fn(async () => json_response(data));
        vi.stubGlobal('fetch', fetch_mock);
        controller.applySpaPlaylist = vi.fn();
        controller._viewCache.set('p1', { data: { stale: true }, ts: Date.now() });

        const ok = await controller.reloadPlaylistView('p1');

        expect(ok).toBe(true);
        expect(fetch_mock.mock.calls[0][0]).toBe('/api/playlist/view?playlist_id=p1');
        expect(controller.applySpaPlaylist).toHaveBeenCalledWith(data);
        expect(controller._viewCache.get('p1').data).toBe(data);
        expect(hub.audio.paused).toBe(true);
    });

    it('does nothing without a playlist id', async () => {
        const { controller } = make_controller();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        expect(await controller.reloadPlaylistView('')).toBe(false);
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('keeps the current view when the request fails', async () => {
        const { controller } = make_controller({ playlistId: 'p1' });
        vi.stubGlobal('fetch', vi.fn(async () => json_response({}, false)));
        controller.applySpaPlaylist = vi.fn();
        expect(await controller.reloadPlaylistView('p1')).toBe(false);
        expect(controller.applySpaPlaylist).not.toHaveBeenCalled();
    });
});

describe('navigatePlaylist', () => {
    it('does nothing without a playlist id', async () => {
        const { controller } = make_controller();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        await controller.navigatePlaylist('', true);
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('does nothing when the playlist is already open', async () => {
        const { controller } = make_controller({ playlistId: 'p1' });
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        await controller.navigatePlaylist('p1', true);
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('reuses a cached view and pushes history', async () => {
        const { controller } = make_controller({ playlistId: 'p0' });
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        controller.applySpaPlaylist = vi.fn();
        const data = { playlist_id: 'p1', tracks_payload: [] };
        controller._viewCache.set('p1', { data, ts: Date.now() });

        await controller.navigatePlaylist('p1', true);

        expect(fetch_mock).not.toHaveBeenCalled();
        expect(controller.applySpaPlaylist).toHaveBeenCalledWith(data);
        expect(push).toHaveBeenCalledWith({ playlistId: 'p1' }, '', '/?playlist_id=p1');
    });

    it('refetches when the cached view is older than VIEW_CACHE_MS', async () => {
        const { controller } = make_controller({ playlistId: 'p0' });
        const data = { playlist_id: 'p1', tracks_payload: [] };
        const fetch_mock = vi.fn(async () => json_response(data));
        vi.stubGlobal('fetch', fetch_mock);
        vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        controller.applySpaPlaylist = vi.fn();
        controller._viewCache.set('p1', { data: { stale: true }, ts: Date.now() - controller.VIEW_CACHE_MS - 1 });

        await controller.navigatePlaylist('p1', false);

        expect(fetch_mock).toHaveBeenCalledTimes(1);
        expect(fetch_mock.mock.calls[0][0]).toBe('/api/playlist/view?playlist_id=p1');
        expect(fetch_mock.mock.calls[0][1].signal).toBeDefined();
        expect(controller.applySpaPlaylist).toHaveBeenCalledWith(data);
        expect(controller._viewCache.get('p1').data).toBe(data);
    });

    it('caches a fresh response and runs the onLoaded callback', async () => {
        const { controller } = make_controller({ playlistId: 'p0' });
        const data = { playlist_id: 'p1', tracks_payload: [] };
        vi.stubGlobal('fetch', vi.fn(async () => json_response(data)));
        vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        vi.stubGlobal('requestAnimationFrame', (cb) => {
            cb();
            return 1;
        });
        controller.applySpaPlaylist = vi.fn();
        const on_loaded = vi.fn();

        await controller.navigatePlaylist('p1', false, on_loaded);

        expect(controller._viewCache.has('p1')).toBe(true);
        expect(on_loaded).toHaveBeenCalledTimes(1);
    });

    it('ignores an aborted request', async () => {
        const { controller } = make_controller({ playlistId: 'p0' });
        const abort_error = new Error('aborted');
        abort_error.name = 'AbortError';
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw abort_error;
        }));
        controller.applySpaPlaylist = vi.fn();

        await controller.navigatePlaylist('p1', false);

        expect(controller.applySpaPlaylist).not.toHaveBeenCalled();
    });
});

describe('navigateHome', () => {
    it('returns early when already on the home view', async () => {
        const { controller } = make_controller({ isHomeView: true, playlistId: null });
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        await controller.navigateHome(true);
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('loads the home view and pushes history', async () => {
        const { controller } = make_controller({ isHomeView: false, playlistId: 'p1' });
        const data = { html: '<div>home</div>', library_pool: [] };
        const fetch_mock = vi.fn(async () => json_response(data));
        vi.stubGlobal('fetch', fetch_mock);
        const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        controller.applySpaHome = vi.fn();

        await controller.navigateHome(true);

        expect(fetch_mock).toHaveBeenCalledWith('/api/home/view');
        expect(controller.applySpaHome).toHaveBeenCalledWith(data);
        expect(push).toHaveBeenCalledWith({ view: 'home' }, '', '/');
    });

    it('does not push history when pushHistory is false', async () => {
        const { controller } = make_controller({ isHomeView: false, playlistId: 'p1' });
        vi.stubGlobal('fetch', vi.fn(async () => json_response({ html: '' })));
        const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        controller.applySpaHome = vi.fn();

        await controller.navigateHome(false);

        expect(push).not.toHaveBeenCalled();
    });
});

describe('applySpaHome', () => {
    it('resets the hub to the home view and renders the shell', () => {
        const { controller, hub } = make_controller({ isHomeView: false, playlistId: 'p1' });
        document.body.innerHTML = '<div id="spa-main"></div><script id="playlist-json">[]</script>';
        controller.updateSidebarActive = vi.fn();
        const data = {
            html: '<p>home</p>',
            library_pool: [{ id: 't1' }],
            catalog: [{ id: 'p1' }],
        };

        controller.applySpaHome(data);

        expect(hub.isHomeView).toBe(true);
        expect(hub.songMixView).toBe(false);
        expect(hub.playlistId).toBe(null);
        expect(hub.tracks).toEqual([]);
        expect(hub.playable).toEqual([]);
        expect(hub.libraryPool).toEqual([{ id: 't1' }]);
        expect(window.__playlistsCatalog).toEqual([{ id: 'p1' }]);
        expect(document.getElementById('spa-main').innerHTML).toBe('<p>home</p>');
        expect(document.getElementById('playlist-json').textContent).toBe('[]');
        expect(controller.updateSidebarActive).toHaveBeenCalledWith(null);
        expect(controller.home.render).toHaveBeenCalled();
        expect(controller.transport.updatePlayingRow).toHaveBeenCalled();
        expect(controller.transport.setPlayUi).toHaveBeenCalledWith(false);
    });

    it('bumps the navigation generation when leaving a playlist', () => {
        const { controller, hub } = make_controller({ isHomeView: false, playlistId: 'p1' });
        controller.updateSidebarActive = vi.fn();
        controller.applySpaHome({ html: '' });
        expect(hub._navGen).toBe(1);
    });
});

describe('applySpaPlaylist', () => {
    it('stores the playlist payload and updates the shell', () => {
        const { controller, hub } = make_controller({ playlistId: 'p0', isHomeView: true });
        document.body.innerHTML = '<div id="spa-main"></div><script id="playlist-json">[]</script>';
        hub.playlistJsonEl = document.getElementById('playlist-json');
        controller.updateSidebarActive = vi.fn();
        const data = {
            playlist_id: 'p1',
            html: '<p>tracks</p>',
            tracks_payload: [
                { id: 't1', play_src: '/media/t1.webm' },
                { id: 't2', play_src: '' },
            ],
        };

        controller.applySpaPlaylist(data);

        expect(hub.isHomeView).toBe(false);
        expect(hub.songMixView).toBe(false);
        expect(hub.playlistId).toBe('p1');
        expect(hub.tracks).toHaveLength(2);
        expect(hub.playable.map((t) => t.id)).toEqual(['t1']);
        expect(document.getElementById('spa-main').innerHTML).toBe('<p>tracks</p>');
        expect(document.getElementById('playlist-json').textContent).toBe(JSON.stringify(hub.tracks));
        expect(controller.updateSidebarActive).toHaveBeenCalledWith('p1');
        expect(controller.transport.updatePlayingRow).toHaveBeenCalled();
        expect(controller.transport.likes.bind_track_row_like_buttons).toHaveBeenCalled();
    });

    it('bumps the navigation generation only for a different playlist', () => {
        const { controller, hub } = make_controller({ playlistId: 'p1' });
        controller.updateSidebarActive = vi.fn();
        controller.applySpaPlaylist({ playlist_id: 'p1', tracks_payload: [] });
        expect(hub._navGen).toBeUndefined();
        controller.applySpaPlaylist({ playlist_id: 'p2', tracks_payload: [] });
        expect(hub._navGen).toBe(1);
    });
});

describe('updateSidebarActive', () => {
    function mount_sidebar() {
        document.body.innerHTML = `
            <a class="home-spa-nav" href="/">Home</a>
            <div class="playlist-card"><a class="playlist-spa-nav" href="/?playlist_id=p1">One</a></div>
            <div class="playlist-card"><a class="playlist-spa-nav" href="/?playlist_id=p2">Two</a></div>
        `;
    }

    it('marks the matching playlist card active', () => {
        mount_sidebar();
        const { controller } = make_controller();
        controller.updateSidebarActive('p1');
        const cards = document.querySelectorAll('.playlist-card');
        expect(cards[0].classList.contains('nav-active')).toBe(true);
        expect(cards[1].classList.contains('nav-active')).toBe(false);
        const home = document.querySelector('a.home-spa-nav');
        expect(home.classList.contains('nav-active')).toBe(false);
        expect(home.classList.contains('hover:bg-[#282828]')).toBe(true);
    });

    it('marks the home link active when no playlist is selected', () => {
        mount_sidebar();
        const { controller } = make_controller();
        controller.updateSidebarActive(null);
        const home = document.querySelector('a.home-spa-nav');
        expect(home.classList.contains('nav-active')).toBe(true);
        expect(home.classList.contains('hover:bg-[#282828]')).toBe(false);
        document.querySelectorAll('.playlist-card').forEach((card) => {
            expect(card.classList.contains('nav-active')).toBe(false);
        });
    });
});

describe('hideLyricsIfOpen', () => {
    it('closes the lyrics panel and resets its colors', () => {
        const { controller, hub } = make_controller({ lyricsVisible: true });
        document.body.innerHTML = '<div id="lyrics-panel"></div>';
        hub.lyricsPanel = document.getElementById('lyrics-panel');

        controller.hideLyricsIfOpen();

        expect(hub.lyricsVisible).toBe(false);
        expect(hub.lyricsPanel.classList.contains('hidden')).toBe(true);
        expect(controller.lyrics.sync_lyrics_toggle_buttons).toHaveBeenCalled();
        expect(controller.lyrics.resetLyricsColors).toHaveBeenCalled();
    });

    it('does nothing when lyrics are already closed', () => {
        const { controller } = make_controller({ lyricsVisible: false });
        controller.hideLyricsIfOpen();
        expect(controller.lyrics.sync_lyrics_toggle_buttons).not.toHaveBeenCalled();
    });
});

describe('scrollToCurrentTrack', () => {
    it('does nothing without a current track', () => {
        const { controller } = make_controller({ currentTrackId: null });
        controller.scrollToCurrentTrack();
        expect(controller.transport.scrollTrackIntoView).not.toHaveBeenCalled();
    });

    it('scrolls the playing row into view', () => {
        const { controller } = make_controller({ currentTrackId: 't1' });
        controller.scrollToCurrentTrack();
        expect(controller.transport.scrollTrackIntoView).toHaveBeenCalledWith('t1');
        expect(controller.transport.updatePlayingRow).toHaveBeenCalled();
    });
});

describe('goToPlayingTrack', () => {
    it('returns without navigating when nothing is playing', async () => {
        const { controller } = make_controller({ currentTrackId: null });
        controller.navigatePlaylist = vi.fn();
        await controller.goToPlayingTrack();
        expect(controller.navigatePlaylist).not.toHaveBeenCalled();
    });

    it('scrolls when the playing track is already in the open playlist', async () => {
        const { controller } = make_controller({
            currentTrackId: 't1',
            playingPlaylistId: 'p1',
            playlistId: 'p1',
            isHomeView: false,
        });
        controller.scrollToCurrentTrack = vi.fn();
        controller.navigatePlaylist = vi.fn();
        await controller.goToPlayingTrack();
        expect(controller.scrollToCurrentTrack).toHaveBeenCalled();
        expect(controller.navigatePlaylist).not.toHaveBeenCalled();
    });

    it('navigates to the playlist that owns the playing track', async () => {
        const { controller } = make_controller({
            currentTrackId: 't1',
            playingPlaylistId: 'p2',
            playlistId: 'p1',
            isHomeView: false,
        });
        controller.navigatePlaylist = vi.fn(() => Promise.resolve());
        await controller.goToPlayingTrack();
        expect(controller.navigatePlaylist).toHaveBeenCalledTimes(1);
        expect(controller.navigatePlaylist.mock.calls[0][0]).toBe('p2');
        expect(controller.navigatePlaylist.mock.calls[0][1]).toBe(true);
        expect(typeof controller.navigatePlaylist.mock.calls[0][2]).toBe('function');
    });
});

describe('initialize_playlist_state', () => {
    it('defaults to the home view without a boot payload', () => {
        const { controller, hub } = make_controller();
        controller.initialize_playlist_state();
        expect(hub.playlistId).toBe(null);
        expect(hub.isHomeView).toBe(true);
        expect(hub.tracks).toEqual([]);
        expect(hub.playable).toEqual([]);
        expect(hub.audio).toBe(null);
        expect(hub.LS_SHUFFLE).toBe('spolocal_shuffle');
    });

    it('reads the playlist id, library pool and catalog from the boot payload', () => {
        document.body.innerHTML = `
            <script id="spolocal-player-boot" type="application/json">{"playlistId":"p1","isHome":false,"libraryPool":[{"id":"t1"}],"catalog":[{"id":"p1"}]}</script>
            <script id="playlist-json" type="application/json">[{"id":"t1","play_src":"/media/t1.webm"}]</script>
        `;
        const { controller, hub } = make_controller();
        controller.initialize_playlist_state();
        expect(hub.playlistId).toBe('p1');
        expect(hub.isHomeView).toBe(false);
        expect(hub.libraryPool).toEqual([{ id: 't1' }]);
        expect(hub.tracks).toHaveLength(1);
        expect(hub.playable).toHaveLength(1);
        expect(window.__playlistsCatalog).toEqual([{ id: 'p1' }]);
    });
});

describe('bootstrap', () => {
    it('initializes state, exposes helpers and starts the controllers', () => {
        const { controller } = make_controller();
        controller.initialize_playlist_state = vi.fn();
        controller.attachHelpers = vi.fn();
        controller.start = vi.fn();
        controller.bootstrap();
        expect(controller.initialize_playlist_state).toHaveBeenCalledTimes(1);
        expect(controller.attachHelpers).toHaveBeenCalledTimes(1);
        expect(controller.start).toHaveBeenCalledTimes(1);
    });
});

describe('attachHelpers', () => {
    it('exposes the navigation helpers on window', () => {
        const { controller, hub } = make_controller({ isHomeView: true });
        controller.attachHelpers();
        expect(typeof window.navigatePlaylist).toBe('function');
        expect(typeof window.navigateHome).toBe('function');
        expect(typeof window.applySpaPlaylist).toBe('function');
        expect(typeof window.applySpaHome).toBe('function');
        expect(typeof window.invalidatePlaylistViewCache).toBe('function');
        expect(typeof window.refreshPlaylistView).toBe('function');
        window.refreshHomeView();
        expect(controller.home.render).toHaveBeenCalled();
        controller.invalidateViewCache = vi.fn();
        window.invalidatePlaylistViewCache('p1');
        expect(controller.invalidateViewCache).toHaveBeenCalledWith('p1');
        controller.reloadPlaylistView = vi.fn();
        window.refreshPlaylistView('p1');
        expect(controller.reloadPlaylistView).toHaveBeenCalledWith('p1');
        expect(hub.isHomeView).toBe(true);
    });
});

describe('click delegation', () => {
    it('routes home and playlist spa links through the SPA navigators', () => {
        document.body.innerHTML = `
            <a class="home-spa-nav" href="/">Home</a>
            <a class="playlist-spa-nav" href="/?playlist_id=p2">Two</a>
            <a class="playlist-spa-nav">Other</a>
            <a class="playlist-spa-nav">Empty</a>
        `;
        const { controller } = make_controller({ isHomeView: false, playlistId: 'p1' });
        controller.transport.init = vi.fn();
        controller.queue.init = vi.fn();
        controller.lyrics.init = vi.fn();
        controller.editModal.init = vi.fn();
        controller.contextMenu.init = vi.fn();
        controller.settings.init = vi.fn();
        controller.account.init = vi.fn();
        controller.trackInfo.init = vi.fn();
        controller.trackEdit.init = vi.fn();
        controller.download.init = vi.fn();
        controller.restoreLastPlayback = vi.fn(() => Promise.resolve());
        controller.attachPlayerTrackNav = vi.fn();
        controller.navigateHome = vi.fn();
        controller.navigatePlaylist = vi.fn();
        controller.start();

        const home = document.querySelector('a.home-spa-nav');
        const home_event = new MouseEvent('click', { bubbles: true, cancelable: true });
        home.dispatchEvent(home_event);
        expect(controller.navigateHome).toHaveBeenCalledWith(true);
        expect(home_event.defaultPrevented).toBe(true);

        const playlist = document.querySelectorAll('a.playlist-spa-nav')[0];
        const playlist_event = new MouseEvent('click', { bubbles: true, cancelable: true });
        playlist.dispatchEvent(playlist_event);
        expect(controller.navigatePlaylist).toHaveBeenCalledWith('p2', true);
        expect(playlist_event.defaultPrevented).toBe(true);

        const other = document.querySelectorAll('a.playlist-spa-nav')[1];
        other.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const empty = document.querySelectorAll('a.playlist-spa-nav')[2];
        empty.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(controller.navigatePlaylist).toHaveBeenCalledTimes(1);
    });
});
