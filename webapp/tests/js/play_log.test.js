import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistPlayLog } from '../../static/js/playlist/play_log.js';

function expected_day(offset_days) {
    return new Date(Date.now() - offset_days * 86400000).toISOString().slice(0, 10);
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function json_response(body, ok) {
    return Promise.resolve({
        ok: ok !== false,
        json: () => Promise.resolve(body),
    });
}

describe('sync', () => {
    it('does nothing for a guest', async () => {
        const fetch = vi.fn(() => json_response({ authenticated: false }));
        vi.stubGlobal('fetch', fetch);
        expect(await PlaylistPlayLog.sync()).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('spolocal_play_log_synced')).toBe(null);
    });

    it('seeds local history once then mirrors the account', async () => {
        localStorage.setItem('spolocal_track_plays', JSON.stringify({ 'p1|t1': 3 }));
        localStorage.setItem('spolocal_playlist_plays', JSON.stringify({ p1: 3 }));
        localStorage.setItem('spolocal_play_log', JSON.stringify({ '2026-01-01': 3 }));
        const fetch = vi.fn()
            .mockImplementationOnce(() => json_response({ authenticated: true, track_plays: {}, playlist_plays: {}, day_plays: {} }))
            .mockImplementationOnce(() => json_response({ ok: true, seeded: true }))
            .mockImplementationOnce(() => json_response({
                authenticated: true,
                track_plays: { 'p1|t1': 9 },
                playlist_plays: { p1: 9 },
                day_plays: { '2026-01-01': 9 },
            }));
        vi.stubGlobal('fetch', fetch);

        expect(await PlaylistPlayLog.sync()).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(3);
        const seed_call = fetch.mock.calls[1];
        expect(seed_call[0]).toBe('/api/play-log/seed');
        expect(JSON.parse(seed_call[1].body)).toEqual({
            track_plays: { 'p1|t1': 3 },
            playlist_plays: { p1: 3 },
            day_plays: { '2026-01-01': 3 },
        });
        expect(PlaylistPlayLog.track_plays()).toEqual({ 'p1|t1': 9 });
        expect(PlaylistPlayLog.playlist_plays()).toEqual({ p1: 9 });
        expect(PlaylistPlayLog.day_plays()).toEqual({ '2026-01-01': 9 });
        expect(PlaylistPlayLog.is_synced()).toBe(true);
    });

    it('skips seeding after the first sync', async () => {
        localStorage.setItem('spolocal_play_log_synced', '1');
        localStorage.setItem('spolocal_track_plays', JSON.stringify({ 'p1|t1': 3 }));
        const fetch = vi.fn(() => json_response({
            authenticated: true,
            track_plays: { 'p1|t1': 4 },
            playlist_plays: {},
            day_plays: {},
        }));
        vi.stubGlobal('fetch', fetch);

        expect(await PlaylistPlayLog.sync()).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][0]).toBe('/api/play-log');
        expect(fetch.mock.calls[1][0]).toBe('/api/play-log');
        expect(PlaylistPlayLog.track_plays()).toEqual({ 'p1|t1': 4 });
    });

    it('does not seed an empty local log', async () => {
        const fetch = vi.fn()
            .mockImplementationOnce(() => json_response({ authenticated: true }))
            .mockImplementationOnce(() => json_response({ authenticated: true }));
        vi.stubGlobal('fetch', fetch);

        expect(await PlaylistPlayLog.sync()).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toBe('/api/play-log');
    });

    it('returns false when the request fails', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
        expect(await PlaylistPlayLog.sync()).toBe(false);
    });

    it('returns false when the account rejects the read', async () => {
        vi.stubGlobal('fetch', vi.fn(() => json_response({}, false)));
        expect(await PlaylistPlayLog.sync()).toBe(false);
    });
});

describe('track_key', () => {
    it('joins the playlist and track ids', () => {
        expect(PlaylistPlayLog.track_key('p1', 't1')).toBe('p1|t1');
    });

    it('trims both ids', () => {
        expect(PlaylistPlayLog.track_key('  p1 ', ' t1  ')).toBe('p1|t1');
    });

    it('stringifies numeric ids', () => {
        expect(PlaylistPlayLog.track_key(1, 2)).toBe('1|2');
    });

    it('uses empty parts for missing ids', () => {
        expect(PlaylistPlayLog.track_key(null, undefined)).toBe('|');
        expect(PlaylistPlayLog.track_key('', 't1')).toBe('|t1');
    });
});

describe('read and write', () => {
    it('reads an empty object for a missing key', () => {
        expect(PlaylistPlayLog.read('spolocal_missing')).toEqual({});
    });

    it('round-trips a written value', () => {
        PlaylistPlayLog.write('spolocal_test', { a: 1 });
        expect(PlaylistPlayLog.read('spolocal_test')).toEqual({ a: 1 });
    });

    it('reads an empty object for invalid JSON', () => {
        localStorage.setItem('spolocal_test', 'not json');
        expect(PlaylistPlayLog.read('spolocal_test')).toEqual({});
    });

    it('reads an empty object for non-object JSON', () => {
        localStorage.setItem('spolocal_test', '5');
        expect(PlaylistPlayLog.read('spolocal_test')).toEqual({});
        localStorage.setItem('spolocal_test', 'null');
        expect(PlaylistPlayLog.read('spolocal_test')).toEqual({});
    });

    it('reads an empty object when storage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        expect(PlaylistPlayLog.read('spolocal_test')).toEqual({});
    });

    it('does not throw when writing fails', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        expect(() => PlaylistPlayLog.write('spolocal_test', { a: 1 })).not.toThrow();
    });
});

describe('stored collections', () => {
    it('track_plays reads the track key', () => {
        localStorage.setItem('spolocal_track_plays', JSON.stringify({ 'p1|t1': 3 }));
        expect(PlaylistPlayLog.track_plays()).toEqual({ 'p1|t1': 3 });
    });

    it('playlist_plays reads the playlist key', () => {
        localStorage.setItem('spolocal_playlist_plays', JSON.stringify({ p1: 3 }));
        expect(PlaylistPlayLog.playlist_plays()).toEqual({ p1: 3 });
    });

    it('day_plays reads the day key', () => {
        localStorage.setItem('spolocal_play_log', JSON.stringify({ '2026-01-01': 3 }));
        expect(PlaylistPlayLog.day_plays()).toEqual({ '2026-01-01': 3 });
    });

    it('all three default to an empty object', () => {
        expect(PlaylistPlayLog.track_plays()).toEqual({});
        expect(PlaylistPlayLog.playlist_plays()).toEqual({});
        expect(PlaylistPlayLog.day_plays()).toEqual({});
    });
});

describe('count_track', () => {
    it('counts the track, the playlist and the day', () => {
        PlaylistPlayLog.count_track('p1', 't1');
        PlaylistPlayLog.count_track('p1', 't1');
        expect(PlaylistPlayLog.track_plays()).toEqual({ 'p1|t1': 2 });
        expect(PlaylistPlayLog.playlist_plays()).toEqual({ p1: 2 });
        expect(PlaylistPlayLog.day_plays()[PlaylistPlayLog.day(0)]).toBe(2);
    });

    it('ignores rows without ids', () => {
        PlaylistPlayLog.count_track('', 't1');
        PlaylistPlayLog.count_track('p1', '');
        expect(PlaylistPlayLog.track_plays()).toEqual({});
    });

    it('trims ids before counting', () => {
        PlaylistPlayLog.count_track(' p1 ', ' t1 ');
        expect(PlaylistPlayLog.track_plays()).toEqual({ 'p1|t1': 1 });
        expect(PlaylistPlayLog.playlist_plays()).toEqual({ p1: 1 });
    });

    it('keeps separate counters per track and playlist', () => {
        PlaylistPlayLog.count_track('p1', 't1');
        PlaylistPlayLog.count_track('p1', 't2');
        PlaylistPlayLog.count_track('p2', 't1');
        expect(PlaylistPlayLog.track_plays()).toEqual({ 'p1|t1': 1, 'p1|t2': 1, 'p2|t1': 1 });
        expect(PlaylistPlayLog.playlist_plays()).toEqual({ p1: 2, p2: 1 });
    });

    it('caps the play log at 60 days', () => {
        const log = {};
        for (let i = 0; i < 80; i++) log[PlaylistPlayLog.day(i)] = 1;
        localStorage.setItem('spolocal_play_log', JSON.stringify(log));
        PlaylistPlayLog.count_track('p1', 't1');
        expect(Object.keys(PlaylistPlayLog.day_plays()).length).toBe(60);
    });
});

describe('count_day', () => {
    it('increments today', () => {
        PlaylistPlayLog.count_day();
        PlaylistPlayLog.count_day();
        expect(PlaylistPlayLog.day_plays()[PlaylistPlayLog.day(0)]).toBe(2);
    });

    it('keeps older days untouched', () => {
        const yesterday = PlaylistPlayLog.day(1);
        localStorage.setItem('spolocal_play_log', JSON.stringify({ [yesterday]: 4 }));
        PlaylistPlayLog.count_day();
        const days = PlaylistPlayLog.day_plays();
        expect(days[yesterday]).toBe(4);
        expect(days[PlaylistPlayLog.day(0)]).toBe(1);
    });

    it('drops the oldest days beyond the cap', () => {
        const log = {};
        for (let i = 1; i <= 60; i++) log[PlaylistPlayLog.day(i)] = 1;
        localStorage.setItem('spolocal_play_log', JSON.stringify(log));
        PlaylistPlayLog.count_day();
        const days = PlaylistPlayLog.day_plays();
        expect(Object.keys(days).length).toBe(60);
        expect(days[PlaylistPlayLog.day(60)]).toBe(undefined);
        expect(days[PlaylistPlayLog.day(59)]).toBe(1);
        expect(days[PlaylistPlayLog.day(0)]).toBe(1);
    });
});

describe('day', () => {
    it('returns today for no offset', () => {
        expect(PlaylistPlayLog.day()).toBe(expected_day(0));
        expect(PlaylistPlayLog.day(0)).toBe(expected_day(0));
    });

    it('returns a YYYY-MM-DD string', () => {
        const value = PlaylistPlayLog.day(0);
        expect(value.length).toBe(10);
        expect(value.charAt(4)).toBe('-');
        expect(value.charAt(7)).toBe('-');
    });

    it('walks back one day per offset', () => {
        expect(PlaylistPlayLog.day(1)).toBe(expected_day(1));
        expect(PlaylistPlayLog.day(7)).toBe(expected_day(7));
    });
});

describe('week_plays', () => {
    it('sums the last seven days only', () => {
        const log = { [PlaylistPlayLog.day(0)]: 2, [PlaylistPlayLog.day(6)]: 3, [PlaylistPlayLog.day(7)]: 100 };
        localStorage.setItem('spolocal_play_log', JSON.stringify(log));
        expect(PlaylistPlayLog.week_plays()).toBe(5);
    });

    it('returns zero without a log', () => {
        expect(PlaylistPlayLog.week_plays()).toBe(0);
    });

    it('ignores non-numeric values', () => {
        const log = { [PlaylistPlayLog.day(0)]: 'nope', [PlaylistPlayLog.day(1)]: 2 };
        localStorage.setItem('spolocal_play_log', JSON.stringify(log));
        expect(PlaylistPlayLog.week_plays()).toBe(2);
    });
});
