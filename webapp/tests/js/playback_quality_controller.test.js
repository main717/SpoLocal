import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_quality_prefs.js';
import { PlaybackQualityController } from '../../static/js/player/playback_quality_controller.js';

function fakeAudio() {
    const listeners = new Map();
    return {
        paused: true,
        currentTime: 0,
        duration: 100,
        currentSrc: '',
        src: '',
        pause: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        load: vi.fn(),
        removeAttribute: vi.fn(),
        addEventListener: vi.fn((name, fn) => {
            listeners.set(name, fn);
        }),
        fire(name) {
            const fn = listeners.get(name);
            if (fn) fn();
        },
    };
}

function makeController(overrides = {}) {
    const hub = {
        tracks: [],
        playingTracks: [],
        libraryPool: [],
        audio: fakeAudio(),
        subEl: { textContent: '' },
        currentTrackId: null,
        playingPlaylistId: null,
        playlistId: 'p1',
        ...overrides.hub,
    };
    const state = { hub };
    const transport = {
        _playGeneration: 1,
        setPlayUi: vi.fn(),
        mediaSession: { updateMediaSessionPlaybackState: vi.fn() },
        ...overrides.transport,
    };
    return { controller: new PlaybackQualityController(state, transport), hub, transport };
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('spolocal_playback_kbps', '64');
});

describe('findTrackInHub', () => {
    it('finds a track in hub.tracks', () => {
        const { controller, hub } = makeController();
        hub.tracks = [{ id: 't1', title: 'A' }];
        expect(controller.findTrackInHub('t1')).toBe(hub.tracks[0]);
    });

    it('falls back to playingTracks', () => {
        const { controller, hub } = makeController();
        hub.playingTracks = [{ id: 't2', title: 'B' }];
        expect(controller.findTrackInHub('t2')).toBe(hub.playingTracks[0]);
    });

    it('returns null when missing', () => {
        const { controller } = makeController();
        expect(controller.findTrackInHub('nope')).toBeNull();
    });
});

describe('patchTrackInHub', () => {
    it('patches tracks, playingTracks, and libraryPool', () => {
        const { controller, hub } = makeController();
        hub.tracks = [{ id: 't1', title: 'Old' }];
        hub.playingTracks = [{ id: 't1', title: 'Old' }];
        hub.libraryPool = [{ track_id: 't1', title: 'Old' }];

        controller.patchTrackInHub({ id: 't1', title: 'New', play_src: '/media/x' });

        expect(hub.tracks[0].title).toBe('New');
        expect(hub.playingTracks[0].title).toBe('New');
        expect(hub.libraryPool[0].title).toBe('New');
        expect(hub.libraryPool[0].play_src).toBe('/media/x');
    });

    it('ignores payloads without an id', () => {
        const { controller, hub } = makeController();
        hub.tracks = [{ id: 't1', title: 'Old' }];
        controller.patchTrackInHub({ title: 'New' });
        expect(hub.tracks[0].title).toBe('Old');
    });
});

describe('ensurePlaybackVariantReady', () => {
    it('returns true when the variant already exists', async () => {
        const { controller } = makeController();
        const track = { play_variants: { '64': '/media/a__64k.webm' } };
        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, false)).toBe(true);
    });

    it('starts a background download and returns true when streaming is allowed', async () => {
        const { controller } = makeController();
        const download = vi.spyOn(controller, 'request_quality_download').mockResolvedValue(true);
        const track = { youtube_video_id: 'abc' };

        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, true)).toBe(true);
        expect(download).toHaveBeenCalledWith('p1', 't1', 64);
    });

    it('waits for the file when streaming is not allowed', async () => {
        const { controller, hub } = makeController();
        const download = vi.spyOn(controller, 'request_quality_download').mockResolvedValue(true);
        const wait = vi.spyOn(controller, 'waitForPlaybackVariant').mockResolvedValue(true);
        const track = { artist: 'Artist' };

        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, false)).toBe(true);
        expect(download).toHaveBeenCalledWith('p1', 't1', 64);
        expect(wait).toHaveBeenCalledWith('p1', 't1', 64, 1);
        expect(hub.subEl.textContent).toBe('Downloading Data Saver…');
    });

    it('restores the artist label when the wait fails', async () => {
        const { controller, hub } = makeController();
        vi.spyOn(controller, 'request_quality_download').mockResolvedValue(true);
        vi.spyOn(controller, 'waitForPlaybackVariant').mockResolvedValue(false);
        const track = { artist: 'Artist' };

        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, false)).toBe(false);
        expect(hub.subEl.textContent).toBe('Artist');
    });

    it('bails out when the play generation changed', async () => {
        const { controller, transport } = makeController();
        vi.spyOn(controller, 'request_quality_download').mockImplementation(async () => {
            transport._playGeneration = 2;
            return true;
        });
        const wait = vi.spyOn(controller, 'waitForPlaybackVariant');

        expect(await controller.ensurePlaybackVariantReady({}, 'p1', 't1', 64, 1, false)).toBe(false);
        expect(wait).not.toHaveBeenCalled();
    });
});

describe('onPlaybackQualityChanged', () => {
    it('does not start a download when called after a finished job', async () => {
        const { controller, hub } = makeController();
        hub.currentTrackId = 't1';
        const track = { id: 't1', play_variants: {} };
        vi.spyOn(controller, 'fetchTrackPayload').mockResolvedValue(track);
        const ensure = vi.spyOn(controller, 'ensurePlaybackVariantReady');
        const replace = vi.spyOn(controller, 'replace_audio_src');

        await controller.onPlaybackQualityChanged(false);

        expect(ensure).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });

    it('starts a download when the user changes quality', async () => {
        const { controller, hub } = makeController();
        hub.currentTrackId = 't1';
        const track = { id: 't1', play_variants: {} };
        vi.spyOn(controller, 'fetchTrackPayload').mockResolvedValue(track);
        const ensure = vi.spyOn(controller, 'ensurePlaybackVariantReady').mockResolvedValue(true);
        vi.spyOn(controller, 'replace_audio_src');

        await controller.onPlaybackQualityChanged(true);

        expect(ensure).toHaveBeenCalled();
    });

    it('replaces the source when the variant is present', async () => {
        const { controller, hub } = makeController();
        hub.currentTrackId = 't1';
        const track = { id: 't1', play_variants: { '64': '/media/a__64k.webm' } };
        vi.spyOn(controller, 'fetchTrackPayload').mockResolvedValue(track);
        const replace = vi.spyOn(controller, 'replace_audio_src');

        await controller.onPlaybackQualityChanged(false);

        expect(replace).toHaveBeenCalledWith('/media/a__64k.webm?kbps=64', 0);
    });

    it('does nothing without a current track', async () => {
        const { controller } = makeController();
        const fetchPayload = vi.spyOn(controller, 'fetchTrackPayload');
        await controller.onPlaybackQualityChanged(false);
        expect(fetchPayload).not.toHaveBeenCalled();
    });

    it('leaves a search stream alone when a stale library track is current', async () => {
        // A finished download used to re-resolve hub.currentTrackId, which still
        // pointed at the library track the stream replaced, and played that file.
        const { controller, hub } = makeController();
        hub.searchStreamActive = true;
        hub.currentTrackId = 't1';
        const fetchPayload = vi.spyOn(controller, 'fetchTrackPayload');
        const replace = vi.spyOn(controller, 'replace_audio_src');

        await controller.onPlaybackQualityChanged(false);

        expect(fetchPayload).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });
});

describe('stream loudness', () => {
    function makeStreamController(overrides = {}) {
        const norm = { wire: vi.fn(), set_track_gain_db: vi.fn(), set_track_offset_db: vi.fn() };
        const { controller, hub, transport } = makeController({
            hub: { audioNormalization: norm, ...overrides.hub },
            transport: {
                stream_vid_from_src: vi.fn((src) => {
                    try {
                        const u = new URL(String(src || ''), 'https://localhost/');
                        return u.pathname.startsWith('/api/stream') ? (u.searchParams.get('vid') || '') : '';
                    } catch (e) {
                        return '';
                    }
                }),
                ...overrides.transport,
            },
        });
        return { controller, hub, transport, norm };
    }

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('prefers the active search hit video id', () => {
        const { controller, hub } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        expect(controller._current_stream_vid()).toBe('abc');
    });

    it('reads the video id from a stream src', () => {
        const { controller, hub } = makeStreamController();
        hub.audio.src = '/api/stream?vid=xyz';
        expect(controller._current_stream_vid()).toBe('xyz');
    });

    it('applies a cached stream gain', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ loudness_gain_db: -7.5 }),
        })));

        await controller.apply_stream_loudness('abc');

        expect(norm.wire).toHaveBeenCalled();
        expect(norm.set_track_gain_db).toHaveBeenCalledWith(-7.5);
    });

    it('does not apply a gain for a different stream', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'other' };
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ loudness_gain_db: -7.5 }),
        })));

        await controller.apply_stream_loudness('abc');

        expect(norm.set_track_gain_db).not.toHaveBeenCalled();
    });

    it('resets to neutral while a new stream is measured', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ loudness_gain_db: null, pending: true }),
        })));
        vi.spyOn(controller, 'poll_stream_loudness').mockResolvedValue();

        await controller.apply_stream_loudness('abc');

        expect(norm.set_track_gain_db).toHaveBeenCalledWith(0);
    });

    it('reuses a measured gain without fetching again', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        const fetch_mock = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ loudness_gain_db: -4.4 }),
        }));
        vi.stubGlobal('fetch', fetch_mock);

        await controller.apply_stream_loudness('abc');
        await controller.apply_stream_loudness('abc');

        expect(fetch_mock).toHaveBeenCalledTimes(1);
        expect(norm.set_track_gain_db).toHaveBeenLastCalledWith(-4.4);
    });

    it('prefetches a stream gain into the session cache', async () => {
        const { controller } = makeStreamController();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ loudness_gain_db: -6.4 }),
        })));

        controller.prefetch_stream_loudness('abc');

        await vi.waitFor(() => expect(controller._stream_gains.abc).toBe(-6.4));
    });

    it('keeps polling a prefetch until the measured gain lands', async () => {
        const { controller } = makeStreamController();
        vi.useFakeTimers();
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(() => {
            calls += 1;
            const body = calls === 1
                ? { loudness_gain_db: null, pending: true }
                : { loudness_gain_db: 0.5 };
            return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        }));

        controller.prefetch_stream_loudness('abc');
        await vi.advanceTimersByTimeAsync(2100);

        expect(controller._stream_gains.abc).toBe(0.5);
    });

    it('applies a prefetched gain without a neutral reset', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ loudness_gain_db: 0.5 }),
        })));

        controller.prefetch_stream_loudness('abc');
        await vi.waitFor(() => expect(controller._stream_gains.abc).toBe(0.5));
        await controller.apply_stream_loudness('abc');

        expect(norm.set_track_gain_db).toHaveBeenCalledTimes(1);
        expect(norm.set_track_gain_db).toHaveBeenCalledWith(0.5);
    });

    it('routes apply_track_loudness to the stream path', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        const apply = vi.spyOn(controller, 'apply_stream_loudness').mockResolvedValue();

        await controller.apply_track_loudness({ id: 't1' }, 'p1');

        expect(apply).toHaveBeenCalledWith('abc');
        expect(norm.set_track_gain_db).not.toHaveBeenCalled();
    });

    it('applies the manual offset before routing to the stream path', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        vi.spyOn(controller, 'apply_stream_loudness').mockResolvedValue();

        await controller.apply_track_loudness({ id: 't1', loudness_offset_db: -2.5 }, 'p1');

        expect(norm.set_track_offset_db).toHaveBeenCalledWith(-2.5);
    });

    it('resets the offset to neutral when the track has none', async () => {
        const { controller, hub, norm } = makeStreamController();
        hub.searchStreamActive = true;
        hub.searchStreamHit = { video_id: 'abc' };
        vi.spyOn(controller, 'apply_stream_loudness').mockResolvedValue();

        await controller.apply_track_loudness({ id: 't1' }, 'p1');

        expect(norm.set_track_offset_db).toHaveBeenCalledWith(0);
    });
});

describe('replace_audio_src', () => {
    it('sets the source and resumes on canplay', () => {
        const { controller, hub } = makeController();
        hub.audio.currentTime = 10;
        hub.audio.duration = 100;

        controller.replace_audio_src('/media/a__64k.webm', 10);

        expect(hub.audio.src).toBe('/media/a__64k.webm');
        expect(hub.audio.pause).toHaveBeenCalled();
        hub.audio.currentSrc = '/media/a__64k.webm';
        hub.audio.fire('canplay');
        expect(hub.audio.currentTime).toBe(10);
        expect(hub.audio.play).toHaveBeenCalled();
    });

    it('ignores empty sources', () => {
        const { controller, hub } = makeController();
        controller.replace_audio_src('', 0);
        expect(hub.audio.src).toBe('');
    });
});
