import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistWrappedView } from '../../static/js/playlist/wrapped_view.js';

const year = String(new Date().getFullYear());

function data(overrides = {}) {
    return {
        songs: [],
        playlists: [],
        artists: [],
        total: 0,
        topArtist: null,
        topDay: null,
        librarySize: 0,
        cover: () => '/cover.jpg',
        ...overrides,
    };
}

function mountDom() {
    document.body.innerHTML = `
        <div id="wrapped-overlay" class="hidden">
            <div id="wrapped-track"></div>
            <div id="wrapped-progress"></div>
            <span id="wrapped-count"></span>
            <button id="wrapped-close"></button>
        </div>
    `;
}

function makeView(payload) {
    return new PlaylistWrappedView({ hub: {} }, () => payload, () => '/cover.jpg');
}

beforeEach(() => {
    document.body.innerHTML = '';
    document.body.classList.remove('wrapped-open');
    mountDom();
});

describe('plays_label', () => {
    it('pluralizes', () => {
        expect(PlaylistWrappedView.plays_label(1)).toBe('1 play');
        expect(PlaylistWrappedView.plays_label(2)).toBe('2 plays');
        expect(PlaylistWrappedView.plays_label(0)).toBe('0 plays');
    });
});

describe('slides_for', () => {
    it('shows intro and an empty slide without plays', () => {
        const slides = PlaylistWrappedView.slides_for(data());
        expect(slides.map((s) => s.theme)).toEqual(['intro', 'empty']);
        expect(slides[0].title).toBe('Wrapped ' + year);
        expect(slides[0].meta).toBe('No plays yet this year');
    });

    it('builds the full story for a year with plays', () => {
        const slides = PlaylistWrappedView.slides_for(data({
            total: 12,
            librarySize: 40,
            songs: [
                { key: 'p1|t1', count: 5, track: { title: 'One', artist: 'Alpha' } },
                { key: 'p1|t2', count: 3, track: { title: 'Two', artist: 'Beta' } },
            ],
            artists: [{ name: 'Alpha', plays: 5 }, { name: 'Beta', plays: 3 }],
            playlists: [{ id: 'p1', count: 8, playlist: { name: 'First', cover_tiles: ['/pl.jpg'] } }],
            topDay: { day: '2026-02-01', plays: 4 },
        }));
        expect(slides.map((s) => s.theme)).toEqual([
            'intro', 'plays', 'song', 'songs', 'artist', 'artists', 'playlists', 'day', 'library', 'outro',
        ]);
        expect(slides[1].title).toBe('12');
        expect(slides[2].title).toBe('One');
        expect(slides[2].art).toBe('/cover.jpg');
        expect(slides[3].items).toHaveLength(2);
        expect(slides[4].title).toBe('Alpha');
        expect(slides[6].items[0].art).toBe('/pl.jpg');
        expect(slides[7].meta).toBe('4 plays');
        expect(slides[8].title).toBe('40');
        expect(slides[9].title).toBe(year);
    });

    it('caps lists at five songs and artists and three playlists', () => {
        const songs = Array.from({ length: 8 }, (_, i) => ({
            key: 'p1|t' + i,
            count: 8 - i,
            track: { title: 'T' + i, artist: 'A' + i },
        }));
        const artists = Array.from({ length: 8 }, (_, i) => ({ name: 'A' + i, plays: 8 - i }));
        const playlists = Array.from({ length: 6 }, (_, i) => ({
            id: 'p' + i,
            count: 6 - i,
            playlist: { name: 'P' + i, cover_tiles: [] },
        }));
        const slides = PlaylistWrappedView.slides_for(data({ total: 36, songs, artists, playlists }));
        expect(slides.find((s) => s.theme === 'songs').items).toHaveLength(5);
        expect(slides.find((s) => s.theme === 'artists').items).toHaveLength(5);
        expect(slides.find((s) => s.theme === 'playlists').items).toHaveLength(3);
    });
});

describe('overlay', () => {
    it('opens, renders the slides and closes', () => {
        const view = makeView(data({
            total: 4,
            songs: [{ key: 'p1|t1', count: 4, track: { title: 'One', artist: 'Alpha' } }],
            artists: [{ name: 'Alpha', plays: 4 }],
        }));
        view.open();
        const overlay = document.getElementById('wrapped-overlay');
        expect(overlay.classList.contains('hidden')).toBe(false);
        expect(document.body.classList.contains('wrapped-open')).toBe(true);
        expect(document.querySelectorAll('#wrapped-track .wrapped-slide').length).toBeGreaterThan(2);
        expect(document.querySelectorAll('#wrapped-progress .wrapped-progress-seg').length)
            .toBe(document.querySelectorAll('#wrapped-track .wrapped-slide').length);
        expect(document.getElementById('wrapped-count').textContent).toMatch(/^1 \/ \d+$/);

        document.getElementById('wrapped-close').click();
        expect(overlay.classList.contains('hidden')).toBe(true);
        expect(document.body.classList.contains('wrapped-open')).toBe(false);
    });

    it('does nothing without the overlay in the page', () => {
        document.body.innerHTML = '';
        const view = makeView(data());
        expect(() => view.open()).not.toThrow();
        expect(view.is_open()).toBe(false);
    });

    it('closes on Escape while open', () => {
        const view = makeView(data({ total: 1, songs: [{ key: 'p1|t1', count: 1, track: { title: 'One', artist: 'A' } }] }));
        view.open();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(view.is_open()).toBe(false);
    });

    it('renders ranked item rows with art and counts', () => {
        const view = makeView(data({
            total: 9,
            songs: [
                { key: 'p1|t1', count: 5, track: { title: 'One', artist: 'Alpha' } },
                { key: 'p1|t2', count: 4, track: { title: 'Two', artist: 'Beta' } },
            ],
            artists: [{ name: 'Alpha', plays: 5 }, { name: 'Beta', plays: 4 }],
        }));
        view.open();
        const items = document.querySelectorAll('.wrapped-slide--songs .wrapped-item');
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('.wrapped-item-title').textContent).toBe('One');
        expect(items[0].querySelector('.wrapped-item-count').textContent).toBe('5 plays');
        expect(items[0].querySelector('.wrapped-item-art img')).not.toBe(null);
    });
});

describe('step', () => {
    it('moves one slide at a time and clamps at the ends', () => {
        const view = makeView(data({
            total: 2,
            songs: [{ key: 'p1|t1', count: 2, track: { title: 'One', artist: 'Alpha' } }],
            artists: [{ name: 'Alpha', plays: 2 }],
        }));
        view.open();
        const track = document.getElementById('wrapped-track');
        Object.defineProperty(track, 'clientHeight', { value: 500, configurable: true });
        Object.defineProperty(track, 'scrollTop', { value: 0, writable: true, configurable: true });
        track.scrollTo = vi.fn();

        view.step(1);
        expect(track.scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'smooth' });

        track.scrollTop = 10000;
        view.step(1);
        const last = (track.children.length - 1) * 500;
        expect(track.scrollTo).toHaveBeenLastCalledWith({ top: last, behavior: 'smooth' });

        track.scrollTop = 0;
        view.step(-1);
        expect(track.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    });
});
