import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_quality_prefs.js';
import { PlaylistHomeViewController } from '../../static/js/playlist/home_view_controller.js';

function track(playlistId, trackId, title, artist, extra = {}) {
    return {
        playlist_id: playlistId,
        track_id: trackId,
        title,
        artist,
        album: '',
        play_src: '/media/' + trackId + '.webm',
        youtube_video_id: '',
        ...extra,
    };
}

function makeController(hubOverrides = {}) {
    const hub = {
        libraryPool: [],
        randomMode: false,
        ...hubOverrides,
    };
    const transport = {
        play_random_from_library: vi.fn(),
        likes: { bind_track_row_like_buttons: vi.fn() },
    };
    return { controller: new PlaylistHomeViewController({ hub }, transport), hub, transport };
}

function mountHomeDom() {
    document.body.innerHTML = `
        <div id="home-stats"></div>
        <div id="home-story-track"></div>
        <div id="home-story-dots"></div>
        <button id="home-story-prev"></button>
        <button id="home-story-next"></button>
        <div id="home-top-playlists"></div>
        <p id="home-playlists-empty" class="hidden"></p>
        <div id="home-top-songs"></div>
        <p id="home-songs-empty" class="hidden"></p>
        <button id="home-random-toggle"></button>
        <p id="home-random-status" class="hidden"></p>
    `;
}

function seedPlays(trackPlays, playlistPlays) {
    localStorage.setItem('spolocal_track_plays', JSON.stringify(trackPlays));
    localStorage.setItem('spolocal_playlist_plays', JSON.stringify(playlistPlays || {}));
}

beforeEach(() => {
    localStorage.clear();
    window.__playlistsCatalog = [];
    mountHomeDom();
});

describe('aggregate', () => {
    it('ranks songs and playlists and finds the top artist', () => {
        const { controller, hub } = makeController();
        hub.libraryPool = [
            track('p1', 't1', 'One', 'Alpha'),
            track('p1', 't2', 'Two', 'Alpha'),
            track('p2', 't3', 'Three', 'Beta'),
        ];
        window.__playlistsCatalog = [
            { id: 'p1', name: 'First', cover_tiles: [] },
            { id: 'p2', name: 'Second', cover_tiles: [] },
        ];
        seedPlays({ 'p1|t1': 5, 'p1|t2': 2, 'p2|t3': 4 }, { p1: 7, p2: 4 });

        const data = controller.aggregate();
        expect(data.songs.map((r) => r.track.track_id)).toEqual(['t1', 't3', 't2']);
        expect(data.playlists.map((r) => r.id)).toEqual(['p1', 'p2']);
        expect(data.totalPlays).toBe(11);
        expect(data.uniqueSongs).toBe(3);
        expect(data.playlistsPlayed).toBe(2);
        expect(data.topArtist).toEqual({ name: 'Alpha', plays: 7 });
        expect(data.librarySize).toBe(3);
    });

    it('drops plays for tracks that are no longer in the library', () => {
        const { controller, hub } = makeController();
        hub.libraryPool = [track('p1', 't1', 'One', 'Alpha')];
        seedPlays({ 'p1|t1': 1, 'p9|gone': 50 }, {});
        const data = controller.aggregate();
        expect(data.songs).toHaveLength(1);
        expect(data.totalPlays).toBe(51);
    });

    it('drops playlists that are no longer in the catalog', () => {
        const { controller } = makeController();
        window.__playlistsCatalog = [{ id: 'p1', name: 'First', cover_tiles: [] }];
        seedPlays({}, { p1: 2, gone: 9 });
        expect(controller.aggregate().playlists.map((r) => r.id)).toEqual(['p1']);
    });
});

describe('build_stories', () => {
    it('shows a placeholder when nothing was played', () => {
        const { controller } = makeController();
        const stories = controller.build_stories(controller.aggregate());
        expect(stories).toHaveLength(1);
        expect(stories[0].empty).toBe(true);
    });

    it('builds artist, song, playlist, week and library cards', () => {
        const { controller, hub } = makeController();
        hub.libraryPool = [track('p1', 't1', 'One', 'Alpha')];
        window.__playlistsCatalog = [{ id: 'p1', name: 'First', cover_tiles: ['/cover.jpg'] }];
        seedPlays({ 'p1|t1': 3 }, { p1: 3 });
        const today = new Date().toISOString().slice(0, 10);
        localStorage.setItem('spolocal_play_log', JSON.stringify({ [today]: 3 }));
        const stories = controller.build_stories(controller.aggregate());
        expect(stories.map((s) => s.kicker)).toEqual([
            'Top artist',
            'Top song',
            'Top playlist',
            'Last 7 days',
            'Library',
        ]);
        expect(stories[0].value).toBe('Alpha');
        expect(stories[1].value).toBe('One');
        expect(stories[2].art).toBe('/cover.jpg');
        expect(stories[3].value).toBe('3');
    });
});

describe('render', () => {
    it('renders four stat tiles', () => {
        const { controller, hub } = makeController();
        hub.libraryPool = [track('p1', 't1', 'One', 'Alpha')];
        seedPlays({ 'p1|t1': 2 }, { p1: 2 });
        controller.render();
        const tiles = document.querySelectorAll('#home-stats .home-stat');
        expect(tiles).toHaveLength(4);
        expect(tiles[0].querySelector('.home-stat-value').textContent).toBe('2');
        expect(tiles[3].querySelector('.home-stat-value').textContent).toBe('Alpha');
    });

    it('renders ranked song rows with counts and bars', () => {
        const { controller, hub } = makeController();
        hub.libraryPool = [
            track('p1', 't1', 'One', 'Alpha'),
            track('p1', 't2', 'Two', 'Beta'),
        ];
        seedPlays({ 'p1|t1': 4, 'p1|t2': 1 }, {});
        controller.render();
        const rows = document.querySelectorAll('#home-top-songs .home-song-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('.home-song-count').textContent).toBe('4 plays');
        expect(rows[1].querySelector('.home-song-count').textContent).toBe('1 play');
        expect(rows[0].querySelector('.home-song-bar > span').style.width).toBe('100%');
        expect(rows[1].querySelector('.home-song-bar > span').style.width).toBe('25%');
    });

    it('renders a ranked playlist rail', () => {
        const { controller } = makeController();
        window.__playlistsCatalog = [
            { id: 'p1', name: 'First', cover_tiles: [] },
            { id: 'p2', name: 'Second', cover_tiles: [] },
        ];
        seedPlays({}, { p1: 3, p2: 1 });
        controller.render();
        const cards = document.querySelectorAll('#home-top-playlists > a');
        expect(cards).toHaveLength(2);
        expect(cards[0].querySelector('.home-rank').textContent).toBe('#1');
        expect(cards[0].getAttribute('href')).toBe('/?playlist_id=p1');
    });

    it('skips rebuilding a section when nothing changed', () => {
        const { controller, hub } = makeController();
        hub.libraryPool = [track('p1', 't1', 'One', 'Alpha')];
        seedPlays({ 'p1|t1': 2 }, { p1: 2 });
        controller.render();
        const first_row = document.querySelector('#home-top-songs .home-song-row');
        const first_card = document.querySelector('#home-top-playlists > a');
        controller.render();
        expect(document.querySelector('#home-top-songs .home-song-row')).toBe(first_row);
        expect(document.querySelector('#home-top-playlists > a')).toBe(first_card);
    });

    it('rebuilds when the play count changes', () => {
        const { controller, hub } = makeController();
        hub.libraryPool = [track('p1', 't1', 'One', 'Alpha')];
        seedPlays({ 'p1|t1': 2 }, { p1: 2 });
        controller.render();
        const first_row = document.querySelector('#home-top-songs .home-song-row');
        seedPlays({ 'p1|t1': 3 }, { p1: 3 });
        controller.render();
        expect(document.querySelector('#home-top-songs .home-song-row')).not.toBe(first_row);
    });

    it('shows the empty hints without plays', () => {
        const { controller } = makeController();
        controller.render();
        expect(document.getElementById('home-songs-empty').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('home-playlists-empty').classList.contains('hidden')).toBe(false);
    });
});

describe('story carousel', () => {
    function layoutCarousel() {
        const track_el = document.getElementById('home-story-track');
        Object.defineProperty(track_el, 'clientWidth', { value: 600, configurable: true });
        Object.defineProperty(track_el, 'scrollWidth', { value: 1200, configurable: true });
        Object.defineProperty(track_el, 'scrollLeft', { value: 0, writable: true, configurable: true });
        track_el.scrollTo = vi.fn();
        return track_el;
    }

    function renderStories() {
        const { controller, hub } = makeController();
        hub.libraryPool = [track('p1', 't1', 'One', 'Alpha')];
        seedPlays({ 'p1|t1': 2 }, { p1: 2 });
        controller.render();
        return controller;
    }

    it('enables the arrows once the carousel has a width', () => {
        layoutCarousel();
        renderStories();
        expect(document.getElementById('home-story-prev').disabled).toBe(true);
        expect(document.getElementById('home-story-next').disabled).toBe(false);
    });

    it('disables the next arrow at the end of the rail', async () => {
        const track_el = layoutCarousel();
        renderStories();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        track_el.scrollLeft = 600;
        track_el.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(document.getElementById('home-story-next').disabled).toBe(true);
        expect(document.getElementById('home-story-prev').disabled).toBe(false);
    });

    it('scrolls one card per arrow click', () => {
        const track_el = layoutCarousel();
        renderStories();
        document.getElementById('home-story-next').click();
        expect(track_el.scrollTo).toHaveBeenCalledWith({ left: 600, behavior: 'smooth' });
    });

    it('scrolls to the card behind a dot', () => {
        const track_el = layoutCarousel();
        renderStories();
        const dots = document.querySelectorAll('#home-story-dots .home-story-dot');
        expect(dots.length).toBeGreaterThan(1);
        dots[1].click();
        expect(track_el.scrollTo).toHaveBeenCalledWith({ left: 600, behavior: 'smooth' });
    });
});

describe('random toggle', () => {
    it('starts random playback when switched on', () => {
        const { controller, hub, transport } = makeController();
        controller.render();
        document.getElementById('home-random-toggle').click();
        expect(hub.randomMode).toBe(true);
        expect(transport.play_random_from_library).toHaveBeenCalled();
    });
});
