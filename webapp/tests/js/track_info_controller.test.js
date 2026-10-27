import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_quality_prefs.js';
import { TrackInfoController } from '../../static/js/ui/track_info_controller.js';

const prefs = window.SpolocalQualityPrefs;
const dash = String.fromCharCode(8212);

function mount_track_info_dom() {
    document.body.innerHTML = `
        <div id="track-info-modal" class="hidden">
            <div id="track-info-modal-backdrop"></div>
            <button id="track-info-close"></button>
            <h2 id="track-info-heading"></h2>
            <div id="track-info-body"></div>
            <p id="track-info-error" class="hidden"></p>
        </div>
    `;
}

function json_response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function make_controller(hub = {}) {
    return new TrackInfoController({ hub });
}

function body_text() {
    return document.getElementById('track-info-body').textContent;
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    mount_track_info_dom();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('init', () => {
    it('caches the modal elements on the hub', () => {
        const controller = make_controller();
        const hub = controller.state.hub;
        controller.init();
        expect(hub.trackInfoModal).toBe(document.getElementById('track-info-modal'));
        expect(hub.trackInfoBackdrop).toBe(document.getElementById('track-info-modal-backdrop'));
        expect(hub.trackInfoClose).toBe(document.getElementById('track-info-close'));
        expect(hub.trackInfoBody).toBe(document.getElementById('track-info-body'));
        expect(hub.trackInfoError).toBe(document.getElementById('track-info-error'));
    });

    it('closes from the backdrop and the close button', () => {
        const controller = make_controller();
        controller.init();
        document.getElementById('track-info-modal').classList.remove('hidden');
        document.getElementById('track-info-modal-backdrop').click();
        expect(document.getElementById('track-info-modal').classList.contains('hidden')).toBe(true);
        document.getElementById('track-info-modal').classList.remove('hidden');
        document.getElementById('track-info-close').click();
        expect(document.getElementById('track-info-modal').classList.contains('hidden')).toBe(true);
    });

    it('closes on Escape only while the modal is open', () => {
        const controller = make_controller();
        controller.init();
        const modal = document.getElementById('track-info-modal');
        modal.classList.remove('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(modal.classList.contains('hidden')).toBe(true);

        modal.classList.remove('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(modal.classList.contains('hidden')).toBe(false);
    });

    it('ignores Escape when the modal is already hidden', () => {
        const controller = make_controller();
        controller.init();
        const modal = document.getElementById('track-info-modal');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(modal.classList.contains('hidden')).toBe(true);
    });
});

describe('open', () => {
    it('does nothing without the modal or body', async () => {
        const fetch_mock = vi.fn(async () => json_response({}));
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller({});
        await controller.open('p1', 't1');
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('fetches the info and renders it', async () => {
        const fetch_mock = vi.fn(async () => json_response({
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            status: 'done',
            added_at: '2024-01-02T03:04:05Z',
            files: [],
        }));
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller();
        controller.init();
        await controller.open('p 1', 't/1');
        expect(fetch_mock).toHaveBeenCalledWith(
            '/api/playlists/p%201/tracks/t%2F1/info',
            { headers: { Accept: 'application/json' } },
        );
        expect(document.getElementById('track-info-heading').textContent).toBe('Song');
        expect(document.getElementById('track-info-modal').classList.contains('hidden')).toBe(false);
        const text = body_text();
        expect(text).toContain('Artist');
        expect(text).toContain('Album');
        expect(text).toContain('Downloaded');
        expect(text).toContain('No audio files found on disk.');
    });

    it('reports a missing track', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json_response({}, false, 404)));
        const controller = make_controller();
        controller.init();
        await controller.open('p1', 't1');
        const error = document.getElementById('track-info-error');
        expect(error.textContent).toBe('Track not found.');
        expect(error.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('track-info-body').innerHTML).toBe('');
    });

    it('reports a server error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json_response({}, false, 500)));
        const controller = make_controller();
        controller.init();
        await controller.open('p1', 't1');
        expect(document.getElementById('track-info-error').textContent).toBe('Could not load song info.');
    });

    it('reports a network error message', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        controller.init();
        await controller.open('p1', 't1');
        expect(document.getElementById('track-info-error').textContent).toBe('offline');
    });

    it('falls back to a generic message for non-Error throws', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw 'nope'; }));
        const controller = make_controller();
        controller.init();
        await controller.open('p1', 't1');
        expect(document.getElementById('track-info-error').textContent).toBe('Could not load song info.');
    });

    it('clears a previous error before loading', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json_response({ title: 'Song', status: 'queued' })));
        const controller = make_controller();
        controller.init();
        const error = document.getElementById('track-info-error');
        error.textContent = 'old';
        error.classList.remove('hidden');
        await controller.open('p1', 't1');
        expect(error.textContent).toBe('');
        expect(error.classList.contains('hidden')).toBe(true);
    });
});

describe('close', () => {
    it('hides the modal, clears the body and the error', () => {
        const controller = make_controller();
        controller.init();
        const modal = document.getElementById('track-info-modal');
        const body = document.getElementById('track-info-body');
        const error = document.getElementById('track-info-error');
        modal.classList.remove('hidden');
        body.innerHTML = '<p>x</p>';
        error.textContent = 'boom';
        error.classList.remove('hidden');
        controller.close();
        expect(modal.classList.contains('hidden')).toBe(true);
        expect(body.innerHTML).toBe('');
        expect(error.textContent).toBe('');
        expect(error.classList.contains('hidden')).toBe(true);
    });

    it('does nothing without the modal', () => {
        const controller = make_controller({});
        expect(() => controller.close()).not.toThrow();
    });
});

describe('_normalize_media_path', () => {
    it('strips the media prefix', () => {
        const controller = make_controller();
        expect(controller._normalize_media_path('/media/youtube/a.webm')).toBe('youtube/a.webm');
    });

    it('handles absolute URLs', () => {
        const controller = make_controller();
        expect(controller._normalize_media_path('https://example.com/media/x.webm')).toBe('x.webm');
    });

    it('returns empty for missing or invalid input', () => {
        const controller = make_controller();
        expect(controller._normalize_media_path('')).toBe('');
        expect(controller._normalize_media_path(null)).toBe('');
        expect(controller._normalize_media_path('http://[')).toBe('');
    });
});

describe('_active_file_for_track', () => {
    it('returns null when the track is not playing', () => {
        const controller = make_controller({ currentTrackId: 't2', audio: { currentSrc: '/media/a.webm' } });
        expect(controller._active_file_for_track('t1', [{ relpath: 'a.webm', kbps: 64 }])).toBe(null);
    });

    it('returns null without a source', () => {
        const controller = make_controller({ currentTrackId: 't1', audio: { currentSrc: '', src: '' } });
        expect(controller._active_file_for_track('t1', [{ relpath: 'a.webm', kbps: 64 }])).toBe(null);
    });

    it('matches the file by relpath', () => {
        const controller = make_controller({
            currentTrackId: 't1',
            audio: { currentSrc: '/media/youtube/a.webm', src: '' },
        });
        const file = { relpath: 'youtube/a.webm', kbps: 64 };
        expect(controller._active_file_for_track('t1', [file])).toBe(file);
    });

    it('matches the exact playback variant', () => {
        const controller = make_controller({
            currentTrackId: 't1',
            audio: { currentSrc: '/media/x__192k.opus', src: '' },
            tracks: [{ id: 't1', play_variants: { '192': '/media/x__192k.opus' } }],
        });
        const file = { relpath: 'x__192k.opus', kbps: 192 };
        expect(controller._active_file_for_track('t1', [file])).toBe(file);
    });

    it('matches a variant source against the playing path', () => {
        const controller = make_controller({
            currentTrackId: 't1',
            audio: { currentSrc: '/media/other.webm', src: '' },
            playingTracks: [{ id: 't1', play_variants: { '64': '/media/other.webm' } }],
        });
        const file = { relpath: 'other.webm', kbps: 64 };
        expect(controller._active_file_for_track('t1', [file])).toBe(file);
    });

    it('returns null when nothing matches', () => {
        const controller = make_controller({
            currentTrackId: 't1',
            audio: { currentSrc: '/media/other.webm', src: '' },
            tracks: [{ id: 't1', play_variants: { '64': '/media/x.webm' } }],
        });
        expect(controller._active_file_for_track('t1', [{ relpath: 'y.webm', kbps: 64 }])).toBe(null);
    });

    it('returns null without a hub', () => {
        const controller = make_controller();
        controller.state.hub = null;
        expect(controller._active_file_for_track('t1', [])).toBe(null);
    });
});

describe('_tier_label', () => {
    it('uses the quality prefs label', () => {
        const controller = make_controller();
        expect(controller._tier_label(64)).toBe('Data Saver');
        expect(controller._tier_label(192)).toBe('Highest');
    });

    it('falls back to kbps without the prefs', () => {
        delete window.SpolocalQualityPrefs;
        try {
            const controller = make_controller();
            expect(controller._tier_label(64)).toBe('64 kbps');
        } finally {
            window.SpolocalQualityPrefs = prefs;
        }
    });
});

describe('_render', () => {
    it('uses a default heading and dashes for missing fields', () => {
        const controller = make_controller();
        controller.init();
        controller._render({}, 't1');
        expect(document.getElementById('track-info-heading').textContent).toBe('Song info');
        expect(body_text()).toContain('Status');
        expect(body_text()).toContain(dash);
    });

    it('renders the error row when the server reports one', () => {
        const controller = make_controller();
        controller.init();
        controller._render({ title: 'Song', status: 'error', error: 'Download failed' }, 't1');
        expect(body_text()).toContain('Error');
        expect(body_text()).toContain('Download failed');
    });

    it('renders every file row', () => {
        const controller = make_controller();
        controller.init();
        controller._render({
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            status: 'done',
            added_at: '2024-01-02T03:04:05Z',
            files: [{
                relpath: 'x.webm',
                kbps: 64,
                downloaded_at: '2024-01-02T03:04:05Z',
                size_bytes: 2048,
                duration_sec: 65,
                bitrate_kbps: 64,
                format: 'webm',
            }],
        }, 't1');
        const text = body_text();
        expect(text).toContain('Files on disk');
        expect(text).toContain('Data Saver');
        expect(text).toContain('2.0 KB');
        expect(text).toContain('1:05');
        expect(text).toContain('64 kbps');
        expect(text).toContain('webm');
        expect(text).toContain('Downloaded');
    });

    it('marks the active file and adds a now playing row', () => {
        const controller = make_controller({
            currentTrackId: 't1',
            audio: { currentSrc: '/media/x.webm', src: '' },
        });
        controller.init();
        controller._render({
            title: 'Song',
            status: 'done',
            files: [{ relpath: 'x.webm', kbps: 64, size_bytes: 10 }],
        }, 't1');
        const text = body_text();
        expect(text).toContain('Now playing');
        expect(text).toContain('Playing');
        expect(document.getElementById('track-info-body').innerHTML).toContain('ring-[#1DB954]');
    });

    it('shows the selected tier when the source does not match a file', () => {
        const controller = make_controller({
            currentTrackId: 't1',
            audio: { currentSrc: '/api/stream?vid=abc', src: '' },
        });
        controller.init();
        controller._render({ title: 'Song', status: 'done', files: [] }, 't1');
        expect(body_text()).toContain('Now playing');
        expect(body_text()).toContain('Highest (selected)');
    });

    it('omits the no-files hint when the track is not done', () => {
        const controller = make_controller();
        controller.init();
        controller._render({ title: 'Song', status: 'queued', files: [] }, 't1');
        expect(body_text()).not.toContain('No audio files found on disk.');
    });

    it('escapes markup in the values', () => {
        const controller = make_controller();
        controller.init();
        controller._render({ title: '<b>Song</b>', artist: '<i>A</i>', status: 'queued' }, 't1');
        const html = document.getElementById('track-info-body').innerHTML;
        const heading_html = document.getElementById('track-info-heading').innerHTML;
        expect(heading_html).toContain('&lt;b&gt;Song&lt;/b&gt;');
        expect(html).toContain('&lt;i&gt;A&lt;/i&gt;');
        expect(html).not.toContain('<i>A</i>');
    });

    it('lists the playlists that contain the song', () => {
        const controller = make_controller();
        controller.init();
        controller._render({
            title: 'Song',
            status: 'done',
            playlists: [
                { id: 'p1', name: 'Mine', current: true },
                { id: 'p2', name: 'Road trip', current: false },
            ],
        }, 't1');
        const links = Array.from(document.querySelectorAll('#track-info-body a'));
        expect(links.map((a) => a.textContent)).toEqual(['Mine', 'Road trip']);
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['/?playlist_id=p1', '/?playlist_id=p2']);
        expect(body_text()).toContain('In playlists');
        expect(body_text()).toContain('Current');
    });

    it('skips the playlist block without playlists', () => {
        const controller = make_controller();
        controller.init();
        controller._render({ title: 'Song', status: 'done' }, 't1');
        expect(body_text()).not.toContain('In playlists');
    });

    it('does nothing without the body element', () => {
        const controller = make_controller();
        expect(() => controller._render({ title: 'Song' }, 't1')).not.toThrow();
    });
});

describe('formatting helpers', () => {
    it('_esc escapes HTML and handles null', () => {
        const controller = make_controller();
        expect(controller._esc('<a>')).toBe('&lt;a&gt;');
        expect(controller._esc(null)).toBe('');
        expect(controller._esc(0)).toBe('0');
    });

    it('_format_status maps known statuses', () => {
        const controller = make_controller();
        expect(controller._format_status('done')).toBe('Downloaded');
        expect(controller._format_status('downloading')).toBe('Downloading');
        expect(controller._format_status('queued')).toBe('Queued');
        expect(controller._format_status('pending')).toBe('Pending');
        expect(controller._format_status('error')).toBe('Error');
        expect(controller._format_status('DONE')).toBe('Downloaded');
        expect(controller._format_status('weird')).toBe('weird');
        expect(controller._format_status(null)).toBe(dash);
    });

    it('_format_date handles empty, invalid and valid dates', () => {
        const controller = make_controller();
        expect(controller._format_date('')).toBe(dash);
        expect(controller._format_date(null)).toBe(dash);
        expect(controller._format_date('not-a-date')).toBe('not-a-date');
        const iso = '2024-01-02T03:04:05Z';
        expect(controller._format_date(iso)).toBe(
            new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
        );
    });

    it('_format_bytes scales the units', () => {
        const controller = make_controller();
        expect(controller._format_bytes(null)).toBe(dash);
        expect(controller._format_bytes('abc')).toBe(dash);
        expect(controller._format_bytes(512)).toBe('512 B');
        expect(controller._format_bytes(2048)).toBe('2.0 KB');
        expect(controller._format_bytes(1048576)).toBe('1.00 MB');
    });

    it('_format_duration renders minutes and seconds', () => {
        const controller = make_controller();
        expect(controller._format_duration(null)).toBe(dash);
        expect(controller._format_duration('abc')).toBe(dash);
        expect(controller._format_duration(0)).toBe('0:00');
        expect(controller._format_duration(65)).toBe('1:05');
        expect(controller._format_duration(59.6)).toBe('1:00');
    });

    it('_file_row escapes both cells', () => {
        const controller = make_controller();
        const html = controller._file_row('<label>', '<value>');
        expect(html).toContain('&lt;label&gt;');
        expect(html).toContain('&lt;value&gt;');
    });
});
