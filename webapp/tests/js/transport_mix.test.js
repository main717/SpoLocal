import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistTransportController } from '../../static/js/player/transport_controller.js';

function makeTransport(hubOverrides = {}) {
    const hub = {
        audio: { pause: vi.fn(), play: vi.fn(() => Promise.resolve()), currentTime: 0, src: '' },
        repeatMode: 'off',
        shuffleMode: 'mix',
        shuffleOn: false,
        randomMode: false,
        currentTrackId: 't1',
        playbackContext: 'playlist',
        playlistId: 'p1',
        playable: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
        ...hubOverrides,
    };
    const transport = new PlaylistTransportController({ hub });
    transport.playTrackById = vi.fn();
    transport.play_rec_or_mix_row = vi.fn(() => true);
    transport.stop_playback = vi.fn();
    return { transport, hub };
}

function mount_recs(vids) {
    document.body.innerHTML = '<div id="playlist-recommendations-grid"></div>';
    const grid = document.getElementById('playlist-recommendations-grid');
    const table = document.createElement('table');
    table.id = 'playlist-recommendations-table';
    const tbody = document.createElement('tbody');
    vids.forEach((vid) => {
        const tr = document.createElement('tr');
        tr.className = 'track-row';
        tr.setAttribute('data-youtube-video-id', vid);
        tr.setAttribute('data-title', 'Title ' + vid);
        tr.setAttribute('data-artist', 'Artist ' + vid);
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    grid.appendChild(table);
    return grid;
}

function mount_table(table_id, vids) {
    const table = document.createElement('table');
    table.id = table_id;
    const tbody = document.createElement('tbody');
    vids.forEach((vid) => {
        const tr = document.createElement('tr');
        tr.className = 'track-row';
        tr.setAttribute('data-youtube-video-id', vid);
        tr.setAttribute('data-title', 'Title ' + vid);
        tr.setAttribute('data-artist', 'Artist ' + vid);
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    document.body.appendChild(table);
    return table;
}

function kinds(order) {
    return order.map((e) => e.kind + ':' + (e.kind === 'track' ? e.id : e.video_id));
}

beforeEach(() => {
    document.body.innerHTML = '';
    delete window.playPreview;
    delete window.ensurePlaylistRecommendations;
    delete window.SpolocalQualityPrefs;
});

describe('mix_rec_entries', () => {
    it('reads the rendered recommendation rows', () => {
        mount_recs(['r1', 'r2']);
        const { transport } = makeTransport();
        expect(transport.mix_rec_entries()).toEqual([
            { kind: 'rec', video_id: 'r1', title: 'Title r1', artist: 'Artist r1' },
            { kind: 'rec', video_id: 'r2', title: 'Title r2', artist: 'Artist r2' },
        ]);
    });

    it('returns an empty list without a recommendations table', () => {
        const { transport } = makeTransport();
        expect(transport.mix_rec_entries()).toEqual([]);
    });
});

describe('prefetch_next_loudness', () => {
    it('prefetches the next recommendation', () => {
        mount_recs(['r1', 'r2', 'r3']);
        const { transport } = makeTransport({
            playbackContext: 'recs',
            searchStreamHit: { video_id: 'r1' },
        });
        transport.quality = { prefetch_stream_loudness: vi.fn() };

        transport.prefetch_next_loudness();

        expect(transport.quality.prefetch_stream_loudness).toHaveBeenCalledWith('r2');
    });

    it('does nothing when the current entry is not in the mix', () => {
        mount_recs(['r1', 'r2']);
        const { transport } = makeTransport({
            playbackContext: 'recs',
            searchStreamHit: { video_id: 'nope' },
        });
        transport.quality = { prefetch_stream_loudness: vi.fn() };

        transport.prefetch_next_loudness();

        expect(transport.quality.prefetch_stream_loudness).not.toHaveBeenCalled();
    });
});

describe('mix_order', () => {
    it('includes every track and every recommendation', () => {
        mount_recs(['r1', 'r2', 'r3']);
        const { transport } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order()).sort()).toEqual([
            'rec:r1', 'rec:r2', 'rec:r3', 'track:t1', 'track:t2', 'track:t3', 'track:t4',
        ]);
    });

    it('includes every track for a one track playlist', () => {
        mount_recs(['r1', 'r2', 'r3', 'r4']);
        const { transport } = makeTransport({ playable: [{ id: 't1' }] });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order()).sort()).toEqual([
            'rec:r1', 'rec:r2', 'rec:r3', 'rec:r4', 'track:t1',
        ]);
    });

    it('keeps the tracks when there are no recommendations', () => {
        const { transport } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order())).toEqual(['track:t1', 'track:t2', 'track:t3', 'track:t4']);
    });

    it('caches the order until the tracks or recommendations change', () => {
        mount_recs(['r1', 'r2']);
        const { transport, hub } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        const first = transport.mix_order();
        expect(transport.mix_order()).toBe(first);
        expect(hub.mixOrder).toBe(first);

        mount_recs(['r1', 'r2', 'r3', 'r4']);
        expect(transport.mix_order()).not.toBe(first);
    });

    it('shuffles the whole order', () => {
        mount_recs(['r1', 'r2']);
        const { transport } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn((arr) => arr.reverse()) };
        const order = transport.mix_order();
        expect(transport.shuffle.shuffleArrayInPlace).toHaveBeenCalledWith(order);
        expect(kinds(order)).toEqual([
            'rec:r2', 'rec:r1', 'track:t4', 'track:t3', 'track:t2', 'track:t1',
        ]);
    });
});

describe('mix_current_index', () => {
    it('finds the current playlist track', () => {
        const { transport } = makeTransport({ currentTrackId: 't3' });
        const order = transport.mix_order();
        expect(transport.mix_current_index(order)).toBe(2);
    });

    it('finds the current recommendation by video id', () => {
        mount_recs(['r1', 'r2']);
        const { transport, hub } = makeTransport({ playbackContext: 'recs' });
        hub.searchStreamHit = { video_id: 'r1' };
        const order = transport.mix_order();
        expect(transport.mix_current_index(order)).toBe(4);
    });

    it('returns -1 for an unknown current item', () => {
        const { transport } = makeTransport({ currentTrackId: 'nope' });
        expect(transport.mix_current_index(transport.mix_order())).toBe(-1);
    });
});

describe('play_mix_entry', () => {
    it('plays a playlist track by id', () => {
        const { transport } = makeTransport();
        expect(transport.play_mix_entry({ kind: 'track', id: 't2' })).toBe(true);
        expect(transport.playTrackById).toHaveBeenCalledWith('t2');
    });

    it('plays a recommendation through its rendered row', () => {
        mount_recs(['r1']);
        const { transport } = makeTransport();
        const row = document.querySelector('tr[data-youtube-video-id="r1"]');
        expect(transport.play_mix_entry({ kind: 'rec', video_id: 'r1' })).toBe(true);
        expect(transport.play_rec_or_mix_row).toHaveBeenCalledWith(row);
    });

    it('falls back to playPreview when the row is gone', () => {
        const playPreview = vi.fn();
        window.playPreview = playPreview;
        const { transport } = makeTransport();
        expect(transport.play_mix_entry({ kind: 'rec', video_id: 'r9', title: 'T', artist: 'A' })).toBe(true);
        expect(playPreview).toHaveBeenCalledWith({
            video_id: 'r9',
            title: 'T',
            artist: 'A',
            channel: 'A',
        }, null);
    });

    it('returns false for an empty entry', () => {
        const { transport } = makeTransport();
        expect(transport.play_mix_entry(null)).toBe(false);
    });
});

describe('playAtDeltaMix', () => {
    it('advances to the next entry in the mix', () => {
        mount_recs(['r1', 'r2']);
        const { transport } = makeTransport({ currentTrackId: 't2' });
        transport.playAtDeltaMix(1);
        expect(transport.playTrackById).toHaveBeenCalledWith('t3');
    });

    it('wraps from the last entry to the first', () => {
        const { transport } = makeTransport({ currentTrackId: 't4' });
        transport.playAtDeltaMix(1);
        expect(transport.playTrackById).toHaveBeenCalledWith('t1');
    });

    it('wraps backwards from the first entry to the last', () => {
        const { transport } = makeTransport({ currentTrackId: 't1' });
        transport.playAtDeltaMix(-1);
        expect(transport.playTrackById).toHaveBeenCalledWith('t4');
    });

    it('starts a fresh cycle without repeating the song that just ended', () => {
        const { transport } = makeTransport({ currentTrackId: 't4' });
        transport.mix_order();
        transport.shuffle = { shuffleArrayInPlace: vi.fn((arr) => arr.reverse()) };
        transport.playAtDeltaMix(1);
        expect(transport.playTrackById).toHaveBeenCalledWith('t3');
        expect(kinds(transport.mix_order())[0]).toBe('track:t3');
    });

    it('drops the finished song from the window', () => {
        const { transport } = makeTransport({ currentTrackId: 't2' });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        transport.playAtDeltaMix(1);
        expect(kinds(transport.mix_order())).not.toContain('track:t2');
    });

    it('caps the window at 50 songs', () => {
        const playable = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i }));
        const { transport } = makeTransport({ playable, currentTrackId: 't0' });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(transport.mix_order().length).toBe(50);
    });

    it('removes the finished song and appends one new song', () => {
        const playable = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i }));
        const { transport } = makeTransport({ playable, currentTrackId: 't0' });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        transport.playAtDeltaMix(1);
        const after = kinds(transport.mix_order());
        expect(after.length).toBe(50);
        expect(after).not.toContain('track:t0');
        expect(after).toContain('track:t50');
        expect(transport.playTrackById).toHaveBeenCalledWith('t1');
    });

    it('keeps the window free of duplicates while it rolls', () => {
        const playable = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i }));
        const { transport } = makeTransport({ playable, currentTrackId: 't0' });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        for (let i = 0; i < 30; i++) transport.playAtDeltaMix(1);
        const after = kinds(transport.mix_order());
        expect(after.length).toBe(50);
        expect(new Set(after).size).toBe(after.length);
    });

    it('keeps the mix when a download re-render wipes the recs table', () => {
        mount_recs(['r1', 'r2', 'r3']);
        const { transport, hub } = makeTransport({ playbackContext: 'recs', currentTrackId: 't1' });
        hub.searchStreamHit = { video_id: 'r2' };
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        transport.mix_order();
        const preview = vi.fn();
        window.playPreview = preview;
        // A download completion rebuilds the playlist view and clears the recs grid.
        mount_recs([]);
        transport.playAtDeltaMix(1);
        expect(preview).toHaveBeenCalledWith(expect.objectContaining({ video_id: 'r3' }), null);
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });

    it('keeps the playing recommendation after it leaves the recs list', () => {
        mount_recs(['r1', 'r2', 'r3']);
        const { transport, hub } = makeTransport({ playbackContext: 'recs', currentTrackId: 't1' });
        hub.searchStreamHit = { video_id: 'r2' };
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        transport.mix_order();
        // The downloaded rec is now a playlist track, so the fresh list drops it.
        mount_recs(['r1', 'r3']);
        const order = transport.mix_order();
        expect(kinds(order)).toContain('rec:r2');
        expect(transport.mix_current_index(order)).toBeGreaterThanOrEqual(0);
    });

    it('asks for recommendations when the mix has none', () => {
        const { transport } = makeTransport();
        transport.ensure_mix_recommendations = vi.fn();
        transport.playAtDeltaMix(1);
        expect(transport.ensure_mix_recommendations).toHaveBeenCalled();
    });

    it('stops when there is nothing to play', () => {
        const { transport } = makeTransport({ playable: [] });
        transport.playAtDeltaMix(1);
        expect(transport.stop_playback).toHaveBeenCalled();
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });
});

describe('song mix view', () => {
    it('uses only the song-mix rows as the pool', () => {
        mount_table('song-mix-table', ['m1', 'm2']);
        mount_table('playlist-recommendations-table', ['r1', 'r2']);
        const { transport } = makeTransport({ songMixView: true });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order())).toEqual(['rec:m1', 'rec:m2']);
    });

    it('ignores the playlist recommendation snapshot', () => {
        mount_table('song-mix-table', ['m1']);
        const { transport } = makeTransport({
            songMixView: true,
            mixRecsPid: 'p1',
            mixRecs: [{ kind: 'rec', video_id: 'stale', title: '', artist: '' }],
        });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order())).toEqual(['rec:m1']);
    });

    it('advances inside the song mix and never into the playlist', () => {
        mount_table('song-mix-table', ['m1', 'm2', 'm3']);
        const { transport, hub } = makeTransport({
            songMixView: true,
            playbackContext: 'recs',
            currentTrackId: 't1',
            searchStreamHit: { video_id: 'm1' },
        });
        hub.searchStreamActive = true;
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };

        transport.playAtDeltaMix(1);

        expect(transport.playTrackById).not.toHaveBeenCalled();
        expect(transport.play_rec_or_mix_row).toHaveBeenCalledTimes(1);
        const row = transport.play_rec_or_mix_row.mock.calls[0][0];
        expect(row.getAttribute('data-youtube-video-id')).toBe('m2');
    });

    it('never asks for playlist recommendations', () => {
        mount_table('song-mix-table', ['m1']);
        const { transport } = makeTransport({ songMixView: true });
        transport.ensure_mix_recommendations = vi.fn();
        transport.playAtDeltaMix(1);
        expect(transport.ensure_mix_recommendations).not.toHaveBeenCalled();
    });

    it('finds a row in the song-mix table', () => {
        const table = mount_table('song-mix-table', ['m1']);
        const { transport } = makeTransport({ songMixView: true });
        expect(transport.rec_row_for_video('m1')).toBe(table.querySelector('tr'));
    });
});

describe('playLibraryEntry', () => {
    it('shows why a track cannot play at Data Saver', async () => {
        const { transport, hub } = makeTransport({
            titleEl: { textContent: '' },
            subEl: { textContent: '' },
            playingPlaylistId: '',
        });
        transport.setPlayUi = vi.fn();
        transport.quality = {
            ensurePlaybackVariantReady: vi.fn(async () => false),
            fetchTrackPayload: vi.fn(async () => null),
            patchTrackInHub: vi.fn(),
        };
        window.SpolocalQualityPrefs = {
            resolvePlaySrc: () => '/media/t1.webm',
            normalizeMediaPath: () => 't1.webm',
            playbackKbps: () => '64',
            hasVariant: () => false,
            streamFitsTier: () => false,
            resolveExactPlaySrc: () => '',
            resolvePlaybackPlaySrc: () => '',
            formatLabel: () => 'Data Saver',
        };

        await transport.playLibraryEntry({ playlist_id: 'p1', track_id: 't1', play_src: '/media/t1.webm' }, 'recs');

        expect(hub.subEl.textContent).toBe('Not downloaded at Data Saver.');
        expect(transport.setPlayUi).toHaveBeenCalledWith(false);
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });

    it('shows a message when the entry has no source at all', async () => {
        const { transport, hub } = makeTransport({
            titleEl: { textContent: '' },
            subEl: { textContent: '' },
            playingPlaylistId: '',
        });
        transport.setPlayUi = vi.fn();
        transport.quality = {
            fetchTrackPayload: vi.fn(async () => null),
            patchTrackInHub: vi.fn(),
        };
        window.SpolocalQualityPrefs = {
            resolvePlaySrc: () => '',
            normalizeMediaPath: () => '',
            playbackKbps: () => '192',
            hasVariant: () => false,
        };

        await transport.playLibraryEntry({ playlist_id: 'p1', track_id: 't1' }, 'recs');

        expect(hub.subEl.textContent).toBe('Track unavailable.');
        expect(transport.setPlayUi).toHaveBeenCalledWith(false);
    });
});

describe('ensure_mix_recommendations', () => {
    it('requests recommendations once per playlist', () => {
        const ensure = vi.fn();
        window.ensurePlaylistRecommendations = ensure;
        const { transport, hub } = makeTransport();
        transport.ensure_mix_recommendations();
        transport.ensure_mix_recommendations();
        expect(ensure).toHaveBeenCalledTimes(1);
        expect(ensure).toHaveBeenCalledWith('p1');
        expect(hub.mixOrder).toBeNull();

        hub.playlistId = 'p2';
        transport.ensure_mix_recommendations();
        expect(ensure).toHaveBeenCalledTimes(2);
        expect(ensure).toHaveBeenLastCalledWith('p2');
    });

    it('does nothing in the song mix view', () => {
        const ensure = vi.fn();
        window.ensurePlaylistRecommendations = ensure;
        const { transport } = makeTransport({ songMixView: true });
        transport.ensure_mix_recommendations();
        expect(ensure).not.toHaveBeenCalled();
    });

    it('does nothing without a playlist id or the shell hook', () => {
        const ensure = vi.fn();
        window.ensurePlaylistRecommendations = ensure;
        const no_pid = makeTransport({ playlistId: '' });
        no_pid.transport.ensure_mix_recommendations();
        expect(ensure).not.toHaveBeenCalled();

        delete window.ensurePlaylistRecommendations;
        const no_hook = makeTransport();
        expect(() => no_hook.transport.ensure_mix_recommendations()).not.toThrow();
    });
});
