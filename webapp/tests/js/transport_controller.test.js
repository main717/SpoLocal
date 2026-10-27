import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_quality_prefs.js';
import { PlaylistTransportController } from '../../static/js/player/transport_controller.js';
import { PlaybackQualityController } from '../../static/js/player/playback_quality_controller.js';

function entry(trackId, playlistId = 'p1') {
    return {
        playlist_id: playlistId,
        track_id: trackId,
        play_src: '/media/' + trackId + '.webm',
        title: trackId,
        artist: 'A',
    };
}

function make_hub(overrides = {}) {
    return {
        audio: {
            src: '',
            currentSrc: '',
            currentTime: 12,
            pause: vi.fn(),
            play: vi.fn(() => Promise.resolve()),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        },
        titleEl: { textContent: '' },
        subEl: { textContent: '' },
        repeatMode: 'off',
        shuffleOn: false,
        currentTrackId: '',
        playingPlaylistId: '',
        playingTracks: [],
        playingPlayable: [],
        libraryPool: [],
        playable: [],
        tracks: [],
        manual_up_next_queue: [],
        playbackContext: 'playlist',
        searchStreamActive: false,
        searchStreamHit: null,
        lyricsVisible: false,
        queueVisible: false,
        lastLyricsPayload: {},
        ...overrides,
    };
}

function make_transport(hubOverrides = {}) {
    const hub = make_hub(hubOverrides);
    const transport = new PlaylistTransportController({ hub });
    transport.mediaSession = {
        updateMediaSessionMetadata: vi.fn(),
        updateMediaSessionPlaybackState: vi.fn(),
        persistPlaybackProgress: vi.fn(),
        initMediaSessionHandlers: vi.fn(),
    };
    transport.likes = {
        update_like_button_ui: vi.fn(),
        attach_like_click_handler: vi.fn(),
    };
    transport.quality = {
        fetchTrackPayload: vi.fn(async () => null),
        patchTrackInHub: vi.fn(),
        ensurePlaybackVariantReady: vi.fn(async () => true),
        apply_track_loudness: vi.fn(),
        resolveCurrentPlaySrc: vi.fn(() => ''),
    };
    transport.updatePlayingRow = vi.fn();
    transport.leave_search_stream = vi.fn();
    return { transport, hub };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
});

describe('wrap_index', () => {
    it('wraps an index past the end', () => {
        const { transport } = make_transport();
        expect(transport.wrap_index(5, 3)).toBe(2);
    });

    it('wraps a negative index', () => {
        const { transport } = make_transport();
        expect(transport.wrap_index(-1, 3)).toBe(2);
        expect(transport.wrap_index(-4, 3)).toBe(2);
    });

    it('keeps an index inside the range unchanged', () => {
        const { transport } = make_transport();
        expect(transport.wrap_index(0, 3)).toBe(0);
        expect(transport.wrap_index(2, 3)).toBe(2);
    });
});

describe('library_pool_playable', () => {
    it('uses the given list instead of the hub pool', () => {
        const { transport, hub } = make_transport();
        hub.libraryPool = [entry('t9')];
        const rows = transport.library_pool_playable([entry('t1')]);
        expect(rows.map((r) => r.track_id)).toEqual(['t1']);
    });

    it('drops empty rows and rows without a resolvable source', () => {
        const { transport, hub } = make_transport();
        hub.libraryPool = [entry('t1'), null, { playlist_id: 'p1', track_id: 't2', play_src: '' }];
        const rows = transport.library_pool_playable();
        expect(rows.map((r) => r.track_id)).toEqual(['t1']);
    });

    it('keeps a row that only has a youtube video id', () => {
        const { transport, hub } = make_transport();
        hub.libraryPool = [{ playlist_id: 'p1', track_id: 't2', youtube_video_id: 'vid1' }];
        const rows = transport.library_pool_playable();
        expect(rows.map((r) => r.track_id)).toEqual(['t2']);
    });

    it('returns an empty list when the pool is not an array', () => {
        const { transport, hub } = make_transport();
        hub.libraryPool = null;
        expect(transport.library_pool_playable()).toEqual([]);
    });
});

describe('library_entry_from_row', () => {
    it('reads the entry from the row data attributes', () => {
        const { transport } = make_transport();
        const row = document.createElement('tr');
        row.setAttribute('data-playlist-id', 'p1');
        row.setAttribute('data-track-id', 't1');
        row.setAttribute('data-play-src', '/media/t1.webm');
        row.setAttribute('data-title', 'Title');
        row.setAttribute('data-artist', 'Artist');
        row.setAttribute('data-album', 'Album');
        expect(transport.library_entry_from_row(row)).toEqual({
            playlist_id: 'p1',
            track_id: 't1',
            play_src: '/media/t1.webm',
            title: 'Title',
            artist: 'Artist',
            album: 'Album',
        });
    });

    it('returns null when a required attribute is missing', () => {
        const { transport } = make_transport();
        const row = document.createElement('tr');
        row.setAttribute('data-playlist-id', 'p1');
        row.setAttribute('data-track-id', 't1');
        expect(transport.library_entry_from_row(row)).toBeNull();
    });
});

describe('restart_current and stop_playback', () => {
    it('rewinds the audio and plays it again', () => {
        const { transport, hub } = make_transport();
        transport.restart_current();
        expect(hub.audio.currentTime).toBe(0);
        expect(hub.audio.play).toHaveBeenCalled();
    });

    it('reports a rejected play through handlePlayError', async () => {
        const { transport, hub } = make_transport();
        const err = new Error('nope');
        hub.audio.play = vi.fn(() => Promise.reject(err));
        transport.handlePlayError = vi.fn();
        transport.restart_current();
        await Promise.resolve();
        expect(transport.handlePlayError).toHaveBeenCalledWith(err);
    });

    it('pauses the audio when playback has to stop', () => {
        const { transport, hub } = make_transport();
        transport.stop_playback();
        expect(hub.audio.pause).toHaveBeenCalled();
    });
});

describe('pick_random_library_entry', () => {
    it('returns null for an empty pool', () => {
        const { transport } = make_transport();
        expect(transport.pick_random_library_entry()).toBeNull();
    });

    it('returns the only entry without randomising', () => {
        const { transport, hub } = make_transport();
        hub.libraryPool = [entry('t1')];
        expect(transport.pick_random_library_entry()).toEqual(entry('t1'));
    });

    it('skips the excluded track id', () => {
        const { transport, hub } = make_transport();
        hub.libraryPool = [entry('t1'), entry('t2')];
        const random = vi.spyOn(Math, 'random');
        random.mockReturnValueOnce(0).mockReturnValueOnce(0.9);
        expect(transport.pick_random_library_entry('t1')).toEqual(entry('t2'));
    });
});

describe('play_random_library_next', () => {
    it('restarts the current track when going back', () => {
        const { transport, hub } = make_transport({ currentTrackId: 't1' });
        transport.restart_current = vi.fn();
        transport.play_random_library_next(-1);
        expect(transport.restart_current).toHaveBeenCalled();
    });

    it('does nothing when going back without a current track', () => {
        const { transport } = make_transport();
        transport.restart_current = vi.fn();
        transport.play_random_library_next(-1);
        expect(transport.restart_current).not.toHaveBeenCalled();
    });

    it('plays a random library entry and excludes the current track when repeat is off', () => {
        const { transport, hub } = make_transport({ currentTrackId: 't1' });
        transport.pick_random_library_entry = vi.fn(() => entry('t2'));
        transport.playLibraryEntry = vi.fn();
        transport.play_random_library_next(1);
        expect(transport.pick_random_library_entry).toHaveBeenCalledWith('t1');
        expect(transport.playLibraryEntry).toHaveBeenCalledWith(entry('t2'), 'library');
    });

    it('does not exclude the current track when repeat is all', () => {
        const { transport, hub } = make_transport({ currentTrackId: 't1', repeatMode: 'all' });
        transport.pick_random_library_entry = vi.fn(() => entry('t2'));
        transport.playLibraryEntry = vi.fn();
        transport.play_random_library_next(1);
        expect(transport.pick_random_library_entry).toHaveBeenCalledWith(null);
    });

    it('stops playback when the library has nothing to play', () => {
        const { transport } = make_transport();
        transport.pick_random_library_entry = vi.fn(() => null);
        transport.stop_playback = vi.fn();
        transport.play_random_library_next(1);
        expect(transport.stop_playback).toHaveBeenCalled();
    });
});

describe('record_playback_start', () => {
    it('counts the track, playlist and day in localStorage', () => {
        const { transport, hub } = make_transport({ playingPlaylistId: 'p1', currentTrackId: 't1' });
        transport.record_playback_start();
        const tracks = JSON.parse(localStorage.getItem('spolocal_track_plays'));
        const playlists = JSON.parse(localStorage.getItem('spolocal_playlist_plays'));
        expect(tracks['p1|t1']).toBe(1);
        expect(playlists.p1).toBe(1);
    });

    it('counts the same track only once per load', () => {
        const { transport, hub } = make_transport({ playingPlaylistId: 'p1', currentTrackId: 't1' });
        transport.record_playback_start();
        transport.record_playback_start();
        const tracks = JSON.parse(localStorage.getItem('spolocal_track_plays'));
        expect(tracks['p1|t1']).toBe(1);
    });

    it('counts a different track separately', () => {
        const { transport, hub } = make_transport({ playingPlaylistId: 'p1', currentTrackId: 't1' });
        transport.record_playback_start();
        hub.currentTrackId = 't2';
        transport.record_playback_start();
        const tracks = JSON.parse(localStorage.getItem('spolocal_track_plays'));
        expect(tracks['p1|t1']).toBe(1);
        expect(tracks['p1|t2']).toBe(1);
    });

    it('ignores a search stream playback', () => {
        const { transport } = make_transport({
            playingPlaylistId: 'p1',
            currentTrackId: 't1',
            searchStreamActive: true,
        });
        transport.record_playback_start();
        expect(localStorage.getItem('spolocal_track_plays')).toBeNull();
    });

    it('ignores an event older than the load start', () => {
        const { transport } = make_transport({
            playingPlaylistId: 'p1',
            currentTrackId: 't1',
            _audioLoadStartTimestamp: 100,
        });
        transport.record_playback_start({ timeStamp: 50 });
        expect(localStorage.getItem('spolocal_track_plays')).toBeNull();
    });
});

describe('resolveCurrentPlaySrc', () => {
    function make_quality_transport(hubOverrides = {}) {
        const { transport, hub } = make_transport(hubOverrides);
        transport.quality = new PlaybackQualityController({ hub }, transport);
        return { transport, hub };
    }

    it('returns an empty string without a current track', () => {
        const { transport } = make_quality_transport();
        expect(transport.resolveCurrentPlaySrc()).toBe('');
    });

    it('prefers the exact quality variant', () => {
        const { transport, hub } = make_quality_transport({
            currentTrackId: 't1',
            tracks: [{ id: 't1', play_src: '/media/t1.webm', play_variants: { 192: '/media/t1-192.webm' } }],
        });
        expect(transport.resolveCurrentPlaySrc()).toBe('/media/t1-192.webm');
    });

    it('falls back to the youtube stream when there is no variant', () => {
        const { transport, hub } = make_quality_transport({
            currentTrackId: 't1',
            tracks: [{ id: 't1', youtube_video_id: 'vid1' }],
        });
        expect(transport.resolveCurrentPlaySrc()).toBe('/api/stream?vid=vid1');
    });

    it('returns an empty string for a local play_src without variants', () => {
        const { transport, hub } = make_quality_transport({
            currentTrackId: 't1',
            tracks: [{ id: 't1', play_src: '/media/t1.webm' }],
        });
        expect(transport.resolveCurrentPlaySrc()).toBe('');
    });

    it('looks in the playing tracks when the track is not in the playlist', () => {
        const { transport, hub } = make_quality_transport({
            currentTrackId: 't1',
            playingTracks: [{ id: 't1', play_variants: { 192: '/media/t1-192.webm' } }],
        });
        expect(transport.resolveCurrentPlaySrc()).toBe('/media/t1-192.webm');
    });
});

describe('setPlayUi', () => {
    function make_ui_transport() {
        document.body.innerHTML =
            '<button id="playlist-header-play"><i class="fa-play"></i></button>' +
            '<table><tr class="track-row" data-track-id="t1"><td>' +
            '<button class="track-play"><i class="fa-play"></i></button></td></tr></table>';
        const iconMainPlay = document.createElement('i');
        const streamBadgeEl = document.createElement('span');
        const { transport, hub } = make_transport({
            iconMainPlay,
            streamBadgeEl,
            currentTrackId: 't1',
            playlistId: 'p1',
            playingPlaylistId: 'p1',
            tracks: [{ id: 't1' }],
        });
        hub.audio.src = '/media/t1.webm';
        delete transport.updatePlayingRow;
        return { transport, hub, iconMainPlay, streamBadgeEl };
    }

    it('shows the pause state on the main button, header and playing row', () => {
        const { transport, iconMainPlay, streamBadgeEl } = make_ui_transport();
        transport.setPlayUi(true);
        expect(iconMainPlay.classList.contains('fa-pause')).toBe(true);
        expect(iconMainPlay.classList.contains('fa-play')).toBe(false);
        const header_icon = document.querySelector('#playlist-header-play i');
        expect(header_icon.classList.contains('fa-pause')).toBe(true);
        const row = document.querySelector('tr.track-row');
        expect(row.classList.contains('track-row-playing')).toBe(true);
        const btn = row.querySelector('.track-play');
        expect(btn.classList.contains('ring-2')).toBe(true);
        expect(btn.querySelector('i').classList.contains('fa-pause')).toBe(true);
        expect(streamBadgeEl.classList.contains('hidden')).toBe(true);
    });

    it('shows the play state when playback stops', () => {
        const { transport, iconMainPlay } = make_ui_transport();
        transport.setPlayUi(false);
        expect(iconMainPlay.classList.contains('fa-play')).toBe(true);
        expect(iconMainPlay.classList.contains('fa-pause')).toBe(false);
        const header_icon = document.querySelector('#playlist-header-play i');
        expect(header_icon.classList.contains('fa-play')).toBe(true);
    });


});

describe('isStreamingPlayback', () => {
    function with_src(src) {
        const { transport, hub } = make_transport();
        hub.audio.src = src;
        return transport;
    }

    it('is false without an audio source', () => {
        expect(with_src('').isStreamingPlayback()).toBe(false);
    });

    it('is false for a local media file', () => {
        expect(with_src('/media/t1.webm').isStreamingPlayback()).toBe(false);
    });

    it('is true for a search stream', () => {
        expect(with_src('/api/stream?vid=abc').isStreamingPlayback()).toBe(true);
    });

    it('is true for a preview', () => {
        expect(with_src('/api/preview?vid=abc').isStreamingPlayback()).toBe(true);
    });

    it('is true for an external url', () => {
        expect(with_src('https://cdn.example.com/a.webm').isStreamingPlayback()).toBe(true);
    });

    it('is false for a local file while currentSrc still holds the old stream', () => {
        const { transport, hub } = make_transport();
        hub.audio.src = '/media/t1.webm';
        hub.audio.currentSrc = '/api/stream?vid=old';
        expect(transport.isStreamingPlayback()).toBe(false);
    });

    it('is true for an active search stream even when the src is a blob', () => {
        const { transport, hub } = make_transport({ searchStreamActive: true });
        hub.audio.src = 'blob:https://localhost:8000/abc';
        expect(transport.isStreamingPlayback()).toBe(true);
    });

    it('is false for a local blob source', () => {
        const { transport, hub } = make_transport();
        hub.audio.src = 'blob:https://localhost:8000/abc';
        expect(transport.isStreamingPlayback()).toBe(false);
    });

    it('shows the stream badge while a stream plays', () => {
        const streamBadgeEl = document.createElement('span');
        streamBadgeEl.classList.add('hidden');
        const iconMainPlay = document.createElement('i');
        const { transport, hub } = make_transport({ streamBadgeEl, iconMainPlay });
        hub.audio.src = '/api/stream?vid=abc';
        transport.setPlayUi(true);
        expect(streamBadgeEl.classList.contains('hidden')).toBe(false);
        expect(streamBadgeEl.title).toBe('Stream');
    });

    it('keeps the stream badge hidden for a local track with a stale currentSrc', () => {
        const streamBadgeEl = document.createElement('span');
        streamBadgeEl.classList.add('hidden');
        const iconMainPlay = document.createElement('i');
        const { transport, hub } = make_transport({ streamBadgeEl, iconMainPlay });
        hub.audio.src = '/media/t1.webm';
        hub.audio.currentSrc = '/api/stream?vid=old';
        transport.setPlayUi(true);
        expect(streamBadgeEl.classList.contains('hidden')).toBe(true);
    });
});

describe('updatePlayingRow', () => {
    it('marks the row of the current track', () => {
        document.body.innerHTML = '<table><tr class="track-row" data-track-id="t1"></tr></table>';
        const { transport } = make_transport({ currentTrackId: 't1' });
        delete transport.updatePlayingRow;
        transport.updatePlayingRow();
        expect(document.querySelector('tr.track-row').classList.contains('track-row-playing')).toBe(true);
    });

    it('prefers the live search stream row over the current track row', () => {
        document.body.innerHTML =
            '<table><tr class="track-row" data-track-id="t1"></tr></table>' +
            '<table id="playlist-recommendations-table">' +
            '<tr class="track-row" data-youtube-video-id="vid1"></tr></table>';
        const { transport } = make_transport({
            currentTrackId: 't1',
            searchStreamActive: true,
            searchStreamHit: { video_id: 'vid1' },
        });
        delete transport.updatePlayingRow;
        transport.updatePlayingRow();
        const rows = document.querySelectorAll('tr.track-row');
        expect(rows[0].classList.contains('track-row-playing')).toBe(false);
        expect(rows[1].classList.contains('track-row-playing')).toBe(true);
    });

    it('clears the marker when nothing is playing', () => {
        document.body.innerHTML = '<table><tr class="track-row track-row-playing" data-track-id="t1"></tr></table>';
        const { transport } = make_transport();
        delete transport.updatePlayingRow;
        transport.updatePlayingRow();
        expect(document.querySelector('tr.track-row').classList.contains('track-row-playing')).toBe(false);
    });
});

describe('playLibraryEntry', () => {
    function make_entry_transport() {
        const { transport, hub } = make_transport();
        hub.audio.src = '';
        return { transport, hub };
    }

    it('sets the library context and the current track', async () => {
        const { transport, hub } = make_entry_transport();
        const row = {
            playlist_id: 'p1',
            track_id: 't1',
            play_src: '/media/t1.webm',
            play_variants: { 192: '/media/t1-192.webm' },
            title: 'Title',
            artist: 'Artist',
        };
        await transport.playLibraryEntry(row, 'library');
        expect(hub.playbackContext).toBe('library');
        expect(hub.currentTrackId).toBe('t1');
        expect(hub.playingPlaylistId).toBe('p1');
        expect(hub.playingTracks[0].play_src).toBe('/media/t1-192.webm');
        expect(hub.audio.src).toBe('/media/t1-192.webm');
        expect(hub.audio.play).toHaveBeenCalled();
        expect(transport.mediaSession.updateMediaSessionMetadata).toHaveBeenCalled();
        expect(transport.likes.update_like_button_ui).toHaveBeenCalled();
    });

    it('sets the recs context when asked for it', async () => {
        const { transport, hub } = make_entry_transport();
        const row = Object.assign(entry('t1'), { play_variants: { 192: '/media/t1-192.webm' } });
        await transport.playLibraryEntry(row, 'recs');
        expect(hub.playbackContext).toBe('recs');
        expect(hub.currentTrackId).toBe('t1');
    });

    it('ignores an entry without a track id', async () => {
        const { transport, hub } = make_entry_transport();
        await transport.playLibraryEntry({ playlist_id: 'p1', track_id: '' }, 'library');
        expect(hub.playbackContext).toBe('playlist');
        expect(hub.currentTrackId).toBe('');
        expect(hub.audio.play).not.toHaveBeenCalled();
    });

    it('ignores an entry without a playlist id', async () => {
        const { transport, hub } = make_entry_transport();
        await transport.playLibraryEntry({ playlist_id: '', track_id: 't1' }, 'library');
        expect(hub.currentTrackId).toBe('');
        expect(hub.audio.play).not.toHaveBeenCalled();
    });
});

describe('init', () => {
    function make_init_transport() {
        const { transport, hub } = make_transport({
            LS_SHUFFLE: 'spolocal_shuffle',
            LS_REPEAT: 'spolocal_repeat',
            LS_VOLUME: 'spolocal_volume',
        });
        transport.shuffle = {
            restore_shuffle_order_from_storage: vi.fn(),
            updateShuffleRepeatUi: vi.fn(),
            persistShuffle: vi.fn(),
            persistRepeat: vi.fn(),
            rebuildShuffledOrder: vi.fn(),
        };
        return { transport, hub };
    }

    function bound_events(hub) {
        return hub.audio.addEventListener.mock.calls.map((call) => call[0]);
    }

    it('binds the audio element events', () => {
        const { transport, hub } = make_init_transport();
        transport.init();
        const events = bound_events(hub);
        expect(events).toContain('play');
        expect(events).toContain('playing');
        expect(events).toContain('pause');
        expect(events).toContain('ended');
        expect(events).toContain('seeked');
        expect(events).toContain('error');
        expect(events).toContain('loadstart');
        expect(events).toContain('stalled');
        expect(events).toContain('waiting');
        expect(events).toContain('timeupdate');
        expect(events).toContain('progress');
        expect(events).toContain('loadedmetadata');
        expect(events).toContain('emptied');
        expect(events).toContain('durationchange');
    });

    it('sets the default playback context and the bound flag', () => {
        const { transport, hub } = make_init_transport();
        transport.init();
        expect(hub.playbackContext).toBe('playlist');
        expect(hub._transport_controller_bound).toBe(true);
    });

    it('does not bind twice', () => {
        const { transport, hub } = make_init_transport();
        transport.init();
        const count = hub.audio.addEventListener.mock.calls.length;
        transport.init();
        expect(hub.audio.addEventListener.mock.calls.length).toBe(count);
    });

    it('routes the play event to setPlayUi', () => {
        const { transport, hub } = make_init_transport();
        transport.setPlayUi = vi.fn();
        transport.init();
        const play_call = hub.audio.addEventListener.mock.calls.find((call) => call[0] === 'play');
        play_call[1]();
        expect(transport.setPlayUi).toHaveBeenCalledWith(true);
    });

    it('routes the playing event to record_playback_start', () => {
        const { transport, hub } = make_init_transport();
        transport.record_playback_start = vi.fn();
        transport.init();
        const playing_call = hub.audio.addEventListener.mock.calls.find((call) => call[0] === 'playing');
        const event = { timeStamp: 1 };
        playing_call[1](event);
        expect(transport.record_playback_start).toHaveBeenCalledWith(event);
    });

    it('snapshots the recs and re-marks the playing row when they render', () => {
        const { transport } = make_init_transport();
        transport.mix_rec_entries = vi.fn();
        transport.init();
        window.dispatchEvent(new CustomEvent('spolocal:mix-recommendations-rendered'));
        expect(transport.mix_rec_entries).toHaveBeenCalled();
        expect(transport.updatePlayingRow).toHaveBeenCalled();
    });
});

describe('seek_by_delta', () => {
    it('moves the playhead forward and clamps to the duration', () => {
        const { transport, hub } = make_transport({});
        hub.audio.duration = 20;
        hub.audio.currentTime = 12;
        transport.seek_audio_to = vi.fn();
        transport.seek_by_delta(5);
        expect(transport.seek_audio_to).toHaveBeenCalledWith(17);
        hub.audio.currentTime = 18;
        transport.seek_by_delta(5);
        expect(transport.seek_audio_to).toHaveBeenLastCalledWith(20);
    });

    it('never seeks before zero', () => {
        const { transport, hub } = make_transport({});
        hub.audio.duration = 200;
        hub.audio.currentTime = 2;
        transport.seek_audio_to = vi.fn();
        transport.seek_by_delta(-5);
        expect(transport.seek_audio_to).toHaveBeenCalledWith(0);
    });

    it('does nothing without an audio element', () => {
        const { transport } = make_transport({});
        transport.seek_audio_to = vi.fn();
        transport.state.hub.audio = null;
        transport.seek_by_delta(5);
        expect(transport.seek_audio_to).not.toHaveBeenCalled();
    });
});
