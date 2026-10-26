import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistContextMenuController } from '../../static/js/ui/context_menu_controller.js';

function mount_menu_dom() {
    document.body.innerHTML = `
        <div id="ctx-menu" class="hidden" aria-hidden="true">
            <div id="ctx-items"></div>
        </div>
    `;
    return {
        menu: document.getElementById('ctx-menu'),
        items: document.getElementById('ctx-items'),
    };
}

function make_hub(overrides = {}) {
    const dom = mount_menu_dom();
    return {
        hub: {
            contextMenuEl: dom.menu,
            contextMenuItemsEl: dom.items,
            tracks: [],
            playingTracks: [],
            playlistId: 'p1',
            playingPlaylistId: '',
            currentTrackId: '',
            lastPlayedTrackSnapshot: null,
            audio: null,
            ...overrides,
        },
        menu: dom.menu,
        items: dom.items,
    };
}

function button_labels(items) {
    return Array.from(items.querySelectorAll('button')).map(function (b) {
        return b.textContent;
    });
}

function find_button(items, label) {
    return Array.from(items.querySelectorAll('button')).find(function (b) {
        return b.textContent === label;
    });
}

function track_payload(overrides = {}) {
    return {
        type: 'track',
        trackId: 't1',
        playlistId: 'p1',
        status: 'done',
        playSrc: '/media/t1.webm',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        ytid: 'abcdefghijk',
        title: 'Title',
        artist: 'Artist',
        album: 'Album',
        ...overrides,
    };
}

function library_track(overrides = {}) {
    return {
        id: 't1',
        title: 'Title',
        artist: 'Artist',
        album: 'Album',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        youtube_video_id: 'abcdefghijk',
        play_src: '/media/t1.webm',
        status: 'done',
        ...overrides,
    };
}

function fake_event(target, overrides = {}) {
    return {
        target: target,
        clientX: 10,
        clientY: 20,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
    delete window.openAddToPlaylistAtPoint;
    delete window.SpolocalQualityPrefs;
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function () {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {});
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('constructor and cross refs', () => {
    it('starts with no cross-controller references', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.queue).toBeNull();
        expect(controller.editModal).toBeNull();
        expect(controller.transport).toBeNull();
        expect(controller.trackInfo).toBeNull();
        expect(controller.trackEdit).toBeNull();
        expect(controller.download).toBeNull();
        expect(controller.songMix).toBeNull();
    });

    it('stores every cross reference in order', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        const queue = { id: 'queue' };
        const editModal = { id: 'editModal' };
        const transport = { id: 'transport' };
        const trackInfo = { id: 'trackInfo' };
        const download = { id: 'download' };
        const trackEdit = { id: 'trackEdit' };
        const songMix = { id: 'songMix' };
        controller.setCrossRefs(queue, editModal, transport, trackInfo, download, trackEdit, songMix);
        expect(controller.queue).toBe(queue);
        expect(controller.editModal).toBe(editModal);
        expect(controller.transport).toBe(transport);
        expect(controller.trackInfo).toBe(trackInfo);
        expect(controller.download).toBe(download);
        expect(controller.trackEdit).toBe(trackEdit);
        expect(controller.songMix).toBe(songMix);
    });
});

describe('init', () => {
    it('does nothing when the hub is missing', () => {
        const controller = new PlaylistContextMenuController({});
        expect(function () {
            controller.init();
        }).not.toThrow();
    });

    it('closes the menu on an outside click', () => {
        const { hub, menu } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        menu.classList.remove('hidden');
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('keeps the menu open on a click inside it', () => {
        const { hub, menu, items } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        menu.classList.remove('hidden');
        const inside = document.createElement('button');
        items.appendChild(inside);
        inside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(menu.classList.contains('hidden')).toBe(false);
    });

    it('closes the menu on scroll', () => {
        const { hub, menu } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        menu.classList.remove('hidden');
        document.dispatchEvent(new Event('scroll'));
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('closes the menu on resize', () => {
        const { hub, menu } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        menu.classList.remove('hidden');
        window.dispatchEvent(new Event('resize'));
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('closes the menu on window blur', () => {
        const { hub, menu } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        menu.classList.remove('hidden');
        window.dispatchEvent(new Event('blur'));
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('closes the menu on Escape', () => {
        const { hub, menu } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        menu.classList.remove('hidden');
        const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        document.dispatchEvent(ev);
        expect(menu.classList.contains('hidden')).toBe(true);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('ignores Escape when the menu is already hidden', () => {
        const { hub, menu } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        document.dispatchEvent(ev);
        expect(menu.classList.contains('hidden')).toBe(true);
        expect(ev.defaultPrevented).toBe(false);
    });

    it('opens the menu through the contextmenu listener', () => {
        const { hub, menu } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.init();
        document.body.innerHTML = `
            <table><tr class="track-row" data-track-id="t1"><td id="cell">x</td></tr></table>
        `;
        const cell = document.getElementById('cell');
        cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
        expect(menu.classList.contains('hidden')).toBe(false);
        expect(button_labels(hub.contextMenuItemsEl)).toContain('Edit details');
    });
});

describe('closeContextMenu', () => {
    it('hides the menu, marks it aria-hidden and clears items', () => {
        const { hub, menu, items } = make_hub();
        menu.classList.remove('hidden');
        menu.setAttribute('aria-hidden', 'false');
        items.innerHTML = '<button>x</button>';
        const controller = new PlaylistContextMenuController({ hub });
        controller.closeContextMenu();
        expect(menu.classList.contains('hidden')).toBe(true);
        expect(menu.getAttribute('aria-hidden')).toBe('true');
        expect(items.innerHTML).toBe('');
    });

    it('tolerates a hub without menu elements', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(function () {
            controller.closeContextMenu();
        }).not.toThrow();
    });
});

describe('clampContextMenuPos', () => {
    it('keeps a position that fits', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.clampContextMenuPos(10, 20, 100, 100)).toEqual({ l: 10, t: 20 });
    });

    it('pulls the menu back inside the viewport', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.clampContextMenuPos(1000, 700, 300, 200)).toEqual({ l: 716, t: 560 });
    });

    it('clamps negative coordinates to the padding', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.clampContextMenuPos(-50, -50, 100, 100)).toEqual({ l: 8, t: 8 });
    });

    it('clamps to the padding when the menu is wider than the viewport', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.clampContextMenuPos(100, 100, 2000, 2000)).toEqual({ l: 8, t: 8 });
    });
});

describe('trackHasSourceUrl', () => {
    it('is false without a url or a video id', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackHasSourceUrl('', '')).toBe(false);
        expect(controller.trackHasSourceUrl(null, null)).toBe(false);
    });

    it('is true when a youtube video id is present', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackHasSourceUrl('', 'abc')).toBe(true);
        expect(controller.trackHasSourceUrl('', '   ')).toBe(false);
    });

    it('recognises spotify and youtube urls', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackHasSourceUrl('https://open.spotify.com/track/1', '')).toBe(true);
        expect(controller.trackHasSourceUrl('spotify:track:1', '')).toBe(true);
        expect(controller.trackHasSourceUrl('https://www.youtube.com/watch?v=x', '')).toBe(true);
        expect(controller.trackHasSourceUrl('https://youtu.be/x', '')).toBe(true);
        expect(controller.trackHasSourceUrl('  https://youtu.be/x  ', '')).toBe(true);
    });

    it('rejects local media paths', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackHasSourceUrl('/media/t1.webm', '')).toBe(false);
    });
});

describe('trackDownloadMenuSpec', () => {
    it('returns null while downloading', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackDownloadMenuSpec('downloading', '/m.webm', '', '')).toBeNull();
    });

    it('offers a re-download for a finished track with a source url', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackDownloadMenuSpec('done', '/m.webm', 'https://youtu.be/x', '')).toEqual({
            label: 'Re-download',
            redownload: true,
        });
    });

    it('returns null for a finished track without a source url', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackDownloadMenuSpec('done', '/m.webm', '', '')).toBeNull();
    });

    it('maps queued, pending and error states', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackDownloadMenuSpec('queued', '', '', '')).toEqual({ label: 'Download again', redownload: false });
        expect(controller.trackDownloadMenuSpec('pending', '', '', '')).toEqual({ label: 'Download', redownload: false });
        expect(controller.trackDownloadMenuSpec('error', '', '', '')).toEqual({ label: 'Download again', redownload: false });
    });

    it('returns null for an unknown state', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(controller.trackDownloadMenuSpec('weird', '', '', '')).toBeNull();
    });
});

describe('buildHitFromLibraryTrack', () => {
    it('returns null for an empty track id', () => {
        const { hub } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildHitFromLibraryTrack('')).toBeNull();
        expect(controller.buildHitFromLibraryTrack('   ')).toBeNull();
    });

    it('uses the last played snapshot and synthesises a youtube url', () => {
        const { hub } = make_hub({
            lastPlayedTrackSnapshot: {
                id: 't1',
                title: 'Snap',
                artist: 'Snap Artist',
                album: 'Snap Album',
                url: '',
                youtube_video_id: 'vid1',
            },
        });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildHitFromLibraryTrack('t1')).toEqual({
            title: 'Snap',
            artist: 'Snap Artist',
            channel: 'Snap Artist',
            url: 'https://www.youtube.com/watch?v=vid1',
            album: 'Snap Album',
        });
    });

    it('reads a track from hub.tracks', () => {
        const { hub } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildHitFromLibraryTrack('t1')).toEqual({
            title: 'Title',
            artist: 'Artist',
            channel: 'Artist',
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
            album: 'Album',
        });
    });

    it('falls back to hub.playingTracks', () => {
        const { hub } = make_hub({ playingTracks: [library_track({ title: 'Playing' })] });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildHitFromLibraryTrack('t1').title).toBe('Playing');
    });

    it('falls back to a transport row', () => {
        const { hub } = make_hub();
        const row = document.createElement('tr');
        row.setAttribute('data-title', 'Row Title');
        row.setAttribute('data-artist', 'Row Artist');
        row.setAttribute('data-track-url', 'https://youtu.be/row');
        row.setAttribute('data-youtube-video-id', 'rowvid');
        const controller = new PlaylistContextMenuController({ hub });
        controller.transport = { rowForTrack: vi.fn(() => row) };
        expect(controller.buildHitFromLibraryTrack('t9')).toEqual({
            title: 'Row Title',
            artist: 'Row Artist',
            channel: 'Row Artist',
            url: 'https://youtu.be/row',
            album: '',
        });
    });

    it('returns null when nothing matches', () => {
        const { hub } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildHitFromLibraryTrack('missing')).toBeNull();
    });

    it('returns null when a matched track has no identifying data', () => {
        const { hub } = make_hub({ tracks: [{ id: 't1' }] });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildHitFromLibraryTrack('t1')).toBeNull();
    });
});

describe('buildTrackMenuPayload', () => {
    it('returns null for an empty track id', () => {
        const { hub } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildTrackMenuPayload('')).toBeNull();
    });

    it('builds a payload from hub.tracks', () => {
        const { hub } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildTrackMenuPayload('t1')).toEqual({
            type: 'track',
            trackId: 't1',
            playlistId: 'p1',
            status: 'done',
            playSrc: '/media/t1.webm',
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
            ytid: 'abcdefghijk',
            title: 'Title',
            artist: 'Artist',
            album: 'Album',
        });
    });

    it('prefers the row playlist id and row attributes', () => {
        const { hub } = make_hub();
        const row = document.createElement('tr');
        row.setAttribute('data-playlist-id', 'p2');
        row.setAttribute('data-play-src', '/media/row.webm');
        row.setAttribute('data-track-url', 'https://youtu.be/row');
        row.setAttribute('data-youtube-video-id', 'rowvid');
        row.setAttribute('data-track-status', 'pending');
        row.setAttribute('data-title', 'Row Title');
        row.setAttribute('data-artist', 'Row Artist');
        row.setAttribute('data-album', 'Row Album');
        const controller = new PlaylistContextMenuController({ hub });
        const payload = controller.buildTrackMenuPayload('t9', row);
        expect(payload.playlistId).toBe('p2');
        expect(payload.playSrc).toBe('/media/row.webm');
        expect(payload.status).toBe('pending');
        expect(payload.title).toBe('Row Title');
        expect(payload.artist).toBe('Row Artist');
        expect(payload.album).toBe('Row Album');
    });

    it('uses the playing playlist id when no row is given', () => {
        const { hub } = make_hub({
            playingPlaylistId: 'p3',
            tracks: [library_track({ play_src: '/media/t1.webm' })],
        });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildTrackMenuPayload('t1').playlistId).toBe('p3');
    });

    it('falls back to the snapshot source playlist id', () => {
        const { hub } = make_hub({
            playlistId: '',
            lastPlayedTrackSnapshot: { id: 't1', source_playlist_id: 'p4', url: 'https://youtu.be/snap' },
        });
        const controller = new PlaylistContextMenuController({ hub });
        const payload = controller.buildTrackMenuPayload('t1');
        expect(payload.playlistId).toBe('p4');
        expect(payload.url).toBe('https://youtu.be/snap');
    });

    it('asks the quality preferences for the play source', () => {
        window.SpolocalQualityPrefs = { resolvePlaySrc: vi.fn(() => '/media/hi.webm') };
        const { hub } = make_hub({ tracks: [library_track({ play_src: '/media/lo.webm' })] });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildTrackMenuPayload('t1').playSrc).toBe('/media/hi.webm');
        expect(window.SpolocalQualityPrefs.resolvePlaySrc).toHaveBeenCalled();
    });

    it('falls back to the audio source for the current track', () => {
        const { hub } = make_hub({
            currentTrackId: 't9',
            audio: { currentSrc: '/media/t9.webm', src: '' },
        });
        const controller = new PlaylistContextMenuController({ hub });
        const payload = controller.buildTrackMenuPayload('t9');
        expect(payload.playSrc).toBe('/media/t9.webm');
        expect(payload.status).toBe('done');
    });

    it('returns null when there is no source at all', () => {
        const { hub } = make_hub({ tracks: [{ id: 't1' }] });
        const controller = new PlaylistContextMenuController({ hub });
        expect(controller.buildTrackMenuPayload('t1')).toBeNull();
    });
});

describe('openContextMenu for tracks', () => {
    it('lists the track actions', () => {
        const { hub, menu, items } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload());
        expect(menu.classList.contains('hidden')).toBe(false);
        expect(menu.getAttribute('aria-hidden')).toBe('false');
        expect(button_labels(items)).toEqual([
            'Add to queue',
            'Add to playlist',
            'Go to mix',
            'Re-download',
            'Save to computer',
            'Edit details',
            'Song info',
            'Delete',
        ]);
    });

    it('queues the track when Add to queue is clicked', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.queue = { enqueue_manual_play_next: vi.fn() };
        controller.openContextMenu(10, 20, track_payload());
        find_button(items, 'Add to queue').click();
        expect(controller.queue.enqueue_manual_play_next).toHaveBeenCalledWith({
            source_playlist_id: 'p1',
            track_id: 't1',
            play_src: '/media/t1.webm',
            title: 'Title',
            artist: 'Artist',
            album: 'Album',
            youtube_video_id: 'abcdefghijk',
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
        });
    });

    it('opens the add-to-playlist popup with the library hit', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        window.openAddToPlaylistAtPoint = vi.fn();
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(11, 22, track_payload());
        find_button(items, 'Add to playlist').click();
        expect(window.openAddToPlaylistAtPoint).toHaveBeenCalledWith(
            {
                title: 'Title',
                artist: 'Artist',
                channel: 'Artist',
                url: 'https://www.youtube.com/watch?v=abcdefghijk',
                album: 'Album',
            },
            11,
            22,
        );
    });

    it('opens the song mix', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.songMix = { open_from_payload: vi.fn() };
        const payload = track_payload();
        controller.openContextMenu(10, 20, payload);
        find_button(items, 'Go to mix').click();
        expect(controller.songMix.open_from_payload).toHaveBeenCalledWith(payload);
    });

    it('submits the re-download form with the redownload flag', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload());
        find_button(items, 'Re-download').click();
        const form = document.querySelector('form');
        expect(form.getAttribute('action')).toBe('/playlists/p1/tracks/t1/download');
        expect(form.querySelector('input[name="redownload"]').value).toBe('1');
        expect(HTMLFormElement.prototype.submit).toHaveBeenCalled();
    });

    it('submits a plain download form without the redownload flag', () => {
        const { hub, items } = make_hub({ tracks: [library_track({ status: 'pending' })] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload({ status: 'pending' }));
        find_button(items, 'Download').click();
        const form = document.querySelector('form');
        expect(form.getAttribute('action')).toBe('/playlists/p1/tracks/t1/download');
        expect(form.querySelector('input[name="redownload"]')).toBeNull();
    });

    it('downloads the track file', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload());
        find_button(items, 'Save to computer').click();
        expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
        const anchor = document.querySelector('a');
        expect(anchor).toBeNull();
    });

    it('opens the track edit modal', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.trackEdit = { open: vi.fn() };
        controller.openContextMenu(10, 20, track_payload());
        find_button(items, 'Edit details').click();
        expect(controller.trackEdit.open).toHaveBeenCalledWith('p1', 't1', 'Title', 'Artist', 'Album');
    });

    it('opens the song info panel', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        const controller = new PlaylistContextMenuController({ hub });
        controller.trackInfo = { open: vi.fn() };
        controller.openContextMenu(10, 20, track_payload());
        find_button(items, 'Song info').click();
        expect(controller.trackInfo.open).toHaveBeenCalledWith('p1', 't1');
    });

    it('deletes the track via fetch and refreshes in place', async () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        vi.stubGlobal('confirm', vi.fn(() => true));
        const fetch_mock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetch_mock);
        const refresh = vi.fn(() => Promise.resolve(true));
        window.refreshPlaylistView = refresh;
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload());
        find_button(items, 'Delete').click();
        await Promise.resolve();
        await Promise.resolve();
        expect(document.querySelector('form')).toBeNull();
        expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
        expect(fetch_mock).toHaveBeenCalledTimes(1);
        expect(fetch_mock.mock.calls[0][0]).toBe('/playlists/p1/tracks/t1/delete');
        expect(fetch_mock.mock.calls[0][1].method).toBe('POST');
        expect(fetch_mock.mock.calls[0][1].headers['X-Spa-Request']).toBe('1');
        expect(refresh).toHaveBeenCalledWith('p1');
        delete window.refreshPlaylistView;
    });

    it('does not delete the track when confirmation is cancelled', () => {
        const { hub, items } = make_hub({ tracks: [library_track()] });
        vi.stubGlobal('confirm', vi.fn(() => false));
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload());
        find_button(items, 'Delete').click();
        expect(document.querySelector('form')).toBeNull();
        expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('hides queue and save actions when there is no play source', () => {
        const { hub, items } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload({ playSrc: '', status: 'pending' }));
        const labels = button_labels(items);
        expect(labels).not.toContain('Add to queue');
        expect(labels).not.toContain('Save to computer');
        expect(labels).toContain('Download');
    });

    it('hides Add to playlist when no library hit can be built', () => {
        const { hub, items } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, track_payload());
        expect(button_labels(items)).not.toContain('Add to playlist');
    });

    it('positions the menu inside the viewport', () => {
        const { hub, menu } = make_hub({ tracks: [library_track()] });
        Object.defineProperty(menu, 'getBoundingClientRect', {
            configurable: true,
            value: function () {
                return { width: 300, height: 200 };
            },
        });
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(1000, 700, track_payload());
        expect(menu.style.left).toBe('716px');
        expect(menu.style.top).toBe('560px');
        expect(menu.style.visibility).toBe('');
    });

    it('does nothing without menu elements', () => {
        const controller = new PlaylistContextMenuController({ hub: {} });
        expect(function () {
            controller.openContextMenu(1, 2, track_payload());
        }).not.toThrow();
    });
});

describe('openContextMenu for mix hits', () => {
    it('lists add-to-playlist and go-to-mix', () => {
        const { hub, items } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, {
            type: 'mix_hit',
            ytid: 'abcdefghijk',
            title: 'Mix',
            artist: 'Artist',
            url: 'https://youtu.be/abcdefghijk',
        });
        expect(button_labels(items)).toEqual(['Add to playlist', 'Go to mix']);
    });

    it('passes the hit to the add-to-playlist popup', () => {
        const { hub, items } = make_hub();
        window.openAddToPlaylistAtPoint = vi.fn();
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(3, 4, {
            type: 'mix_hit',
            ytid: 'abcdefghijk',
            title: 'Mix',
            artist: 'Artist',
            url: 'https://youtu.be/abcdefghijk',
        });
        find_button(items, 'Add to playlist').click();
        expect(window.openAddToPlaylistAtPoint).toHaveBeenCalledWith(
            {
                video_id: 'abcdefghijk',
                title: 'Mix',
                artist: 'Artist',
                channel: 'Artist',
                url: 'https://youtu.be/abcdefghijk',
            },
            3,
            4,
        );
    });

    it('hides Go to mix when already in the mix view', () => {
        const { hub, items } = make_hub({ songMixView: true });
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, {
            type: 'mix_hit',
            ytid: 'abcdefghijk',
            title: 'Mix',
            artist: 'Artist',
            url: '',
        });
        expect(button_labels(items)).toEqual(['Add to playlist']);
    });
});

describe('openContextMenu for playlists', () => {
    it('lists the playlist actions', () => {
        const { hub, items } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        expect(button_labels(items)).toEqual([
            'Edit playlist',
            'Download all at Data Saver',
            'Download all at Highest',
            'Save to computer (ZIP)',
            'Delete playlist',
        ]);
    });

    it('opens the edit modal with catalog name and bio', () => {
        const { hub, items } = make_hub();
        window.__playlistsCatalog = [{ id: 'p1', name: 'Catalog Name', bio: 'Catalog Bio' }];
        const controller = new PlaylistContextMenuController({ hub });
        controller.editModal = { openPlaylistEditModal: vi.fn() };
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Edit playlist').click();
        expect(controller.editModal.openPlaylistEditModal).toHaveBeenCalledWith({
            id: 'p1',
            name: 'Catalog Name',
            bio: 'Catalog Bio',
        });
    });

    it('falls back to the payload name when the catalog has no row', () => {
        const { hub, items } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.editModal = { openPlaylistEditModal: vi.fn() };
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Edit playlist').click();
        expect(controller.editModal.openPlaylistEditModal).toHaveBeenCalledWith({
            id: 'p1',
            name: 'List',
            bio: '',
        });
    });

    it('queues quality downloads through the download controller', () => {
        const { hub, items } = make_hub();
        vi.stubGlobal('confirm', vi.fn(() => true));
        const controller = new PlaylistContextMenuController({ hub });
        controller.download = { queueQualityDownloads: vi.fn() };
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Download all at Highest').click();
        expect(controller.download.queueQualityDownloads).toHaveBeenCalledWith('p1', '192');
    });

    it('posts to the quality endpoint without a download controller', () => {
        const { hub, items } = make_hub();
        vi.stubGlobal('confirm', vi.fn(() => true));
        const fetch_mock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
        vi.stubGlobal('fetch', fetch_mock);
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Download all at Data Saver').click();
        expect(fetch_mock).toHaveBeenCalledWith('/api/playlists/p1/downloads/quality', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ quality: '64' }),
        });
    });

    it('does not queue downloads when confirmation is cancelled', () => {
        const { hub, items } = make_hub();
        vi.stubGlobal('confirm', vi.fn(() => false));
        const controller = new PlaylistContextMenuController({ hub });
        controller.download = { queueQualityDownloads: vi.fn() };
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Download all at Highest').click();
        expect(controller.download.queueQualityDownloads).not.toHaveBeenCalled();
    });

    it('downloads the playlist zip', () => {
        const { hub, items } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Save to computer (ZIP)').click();
        expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
        expect(document.querySelector('a')).toBeNull();
    });

    it('deletes the playlist after confirmation', () => {
        const { hub, items } = make_hub();
        vi.stubGlobal('confirm', vi.fn(() => true));
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Delete playlist').click();
        const form = document.querySelector('form');
        expect(form.getAttribute('action')).toBe('/playlists/p1/delete');
        expect(HTMLFormElement.prototype.submit).toHaveBeenCalled();
    });

    it('does not delete the playlist when confirmation is cancelled', () => {
        const { hub, items } = make_hub();
        vi.stubGlobal('confirm', vi.fn(() => false));
        const controller = new PlaylistContextMenuController({ hub });
        controller.openContextMenu(10, 20, { type: 'playlist', playlistId: 'p1', playlistName: 'List' });
        find_button(items, 'Delete playlist').click();
        expect(document.querySelector('form')).toBeNull();
    });
});

describe('handleContextMenu', () => {
    it('opens the current track menu from the player metadata', () => {
        const { hub, menu } = make_hub({ currentTrackId: 't1', tracks: [library_track()] });
        document.body.innerHTML = '<div id="player-title"><span id="inner">x</span></div>';
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.getElementById('inner'));
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(ev.stopPropagation).toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(false);
    });

    it('ignores the player metadata without a current track', () => {
        const { hub, menu } = make_hub();
        document.body.innerHTML = '<div id="player-title"><span id="inner">x</span></div>';
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.getElementById('inner'));
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('opens a track menu from a track row', () => {
        const { hub, menu } = make_hub({ tracks: [library_track()] });
        document.body.innerHTML = '<table><tr class="track-row" data-track-id="t1"><td id="cell">x</td></tr></table>';
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.getElementById('cell'));
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(false);
    });

    it('opens a mix hit menu for a row with only a video id', () => {
        const { hub, menu } = make_hub();
        document.body.innerHTML = `
            <table><tr class="track-row" data-youtube-video-id="abcdefghijk" data-title="Vid" data-artist="A">
                <td id="cell">x</td>
            </tr></table>
        `;
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.getElementById('cell'));
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(false);
        expect(button_labels(hub.contextMenuItemsEl)).toEqual(['Add to playlist', 'Go to mix']);
    });

    it('ignores a row whose video id is not 11 characters', () => {
        const { hub, menu } = make_hub();
        document.body.innerHTML = `
            <table><tr class="track-row" data-youtube-video-id="short"><td id="cell">x</td></tr></table>
        `;
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.getElementById('cell'));
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('opens a playlist menu from a playlist card', () => {
        const { hub, menu } = make_hub();
        document.body.innerHTML = `
            <div class="playlist-card" data-playlist-id="p1" data-playlist-name="List">
                <span id="card-inner">x</span>
            </div>
        `;
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.getElementById('card-inner'));
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(false);
        expect(button_labels(hub.contextMenuItemsEl)).toContain('Edit playlist');
    });

    it('reads the playlist id from the card link when the attribute is missing', () => {
        const { hub, menu } = make_hub();
        document.body.innerHTML = `
            <div class="playlist-card">
                <a class="playlist-spa-nav" href="/?playlist_id=p9"><span id="card-inner">x</span></a>
            </div>
        `;
        const controller = new PlaylistContextMenuController({ hub });
        controller.editModal = { openPlaylistEditModal: vi.fn() };
        const ev = fake_event(document.getElementById('card-inner'));
        controller.handleContextMenu(ev);
        expect(menu.classList.contains('hidden')).toBe(false);
        find_button(hub.contextMenuItemsEl, 'Edit playlist').click();
        expect(controller.editModal.openPlaylistEditModal).toHaveBeenCalledWith({
            id: 'p9',
            name: '',
            bio: '',
        });
    });

    it('ignores a playlist card without an id or link', () => {
        const { hub, menu } = make_hub();
        document.body.innerHTML = '<div class="playlist-card"><span id="card-inner">x</span></div>';
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.getElementById('card-inner'));
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('ignores targets outside any known element', () => {
        const { hub, menu } = make_hub();
        const controller = new PlaylistContextMenuController({ hub });
        const ev = fake_event(document.body);
        controller.handleContextMenu(ev);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(menu.classList.contains('hidden')).toBe(true);
    });
});
