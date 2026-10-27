/**
 * Home view: listening stats, highlight carousel and random-play controls.
 *
 * All numbers come from the play counters in localStorage plus the library pool
 * that the server already sends with the home payload, so the view costs no
 * extra requests. Each section keeps its own signature and skips the rebuild
 * when nothing changed, which matters because render() also runs on every play.
 */
import { Dom } from '../ui/dom.js?v=1';
import { PlaylistPlayLog } from './play_log.js?v=2';

export class PlaylistHomeViewController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state, transport) {
        this.state = state;
        this.transport = transport;
        this._sig = {};
        this._storyScroll = 0;
        this._storyRaf = 0;
    }

    static plays_label(count) {
        return count + (count === 1 ? ' play' : ' plays');
    }

    bind_controls() {
        Dom.bind_once(document.getElementById('home-random-toggle'), 'random', 'click', () => {
            const hub = this.state.hub;
            hub.randomMode = !hub.randomMode;
            this.sync_random_ui();
            if (hub.randomMode && this.transport) this.transport.play_random_from_library();
        });
        this.sync_random_ui();
    }

    sync_random_ui() {
        const hub = this.state.hub;
        const btn = document.getElementById('home-random-toggle');
        const status = document.getElementById('home-random-status');
        if (btn) {
            btn.textContent = hub.randomMode ? 'Stop random' : 'Start random';
            btn.classList.toggle('bg-[#3E3E3E]', hub.randomMode);
            btn.classList.toggle('text-white', hub.randomMode);
            btn.classList.toggle('bg-[#1DB954]', !hub.randomMode);
            btn.classList.toggle('text-black', !hub.randomMode);
        }
        if (status) status.classList.toggle('hidden', !hub.randomMode);
    }

    render() {
        const data = this.aggregate();
        this.render_stats(data);
        this.render_stories(data);
        this.render_top_playlists(data);
        this.render_top_songs(data);
        this.bind_controls();
    }

    catalog_by_id() {
        const map = new Map();
        const catalog = Array.isArray(window.__playlistsCatalog) ? window.__playlistsCatalog : [];
        catalog.forEach((pl) => {
            if (pl && pl.id) map.set(String(pl.id), pl);
        });
        return map;
    }

    /** Ranked songs, playlists and headline numbers for the whole view. */
    aggregate() {
        const hub = this.state.hub;
        const track_plays = PlaylistPlayLog.track_plays();
        const playlist_plays = PlaylistPlayLog.playlist_plays();
        const catalog = this.catalog_by_id();
        const pool = Array.isArray(hub.libraryPool) ? hub.libraryPool : [];
        const pool_map = new Map();
        pool.forEach((t) => {
            if (t && t.playlist_id && t.track_id) {
                pool_map.set(PlaylistPlayLog.track_key(t.playlist_id, t.track_id), t);
            }
        });

        const songs = Object.entries(track_plays)
            .map(([key, count]) => ({ key, count: Number(count) || 0, track: pool_map.get(key) }))
            .filter((row) => row.count > 0 && row.track && row.track.play_src)
            .sort((a, b) => b.count - a.count);

        const playlists = Object.entries(playlist_plays)
            .map(([id, count]) => ({ id, count: Number(count) || 0, playlist: catalog.get(String(id)) }))
            .filter((row) => row.count > 0 && row.playlist)
            .sort((a, b) => b.count - a.count);

        const artists = new Map();
        songs.forEach((row) => {
            const name = String(row.track.artist || '').trim();
            if (name) artists.set(name, (artists.get(name) || 0) + row.count);
        });
        const top_artist = Array.from(artists.entries()).sort((a, b) => b[1] - a[1])[0];

        return {
            songs,
            playlists,
            totalPlays: Object.values(track_plays).reduce((sum, v) => sum + (Number(v) || 0), 0),
            uniqueSongs: songs.length,
            playlistsPlayed: playlists.length,
            topArtist: top_artist ? { name: top_artist[0], plays: top_artist[1] } : null,
            weekPlays: PlaylistPlayLog.week_plays(),
            librarySize: pool.length,
        };
    }

    render_stats(data) {
        const el = document.getElementById('home-stats');
        if (!el) return;
        const sig = JSON.stringify([data.totalPlays, data.uniqueSongs, data.playlistsPlayed, data.topArtist, data.weekPlays]);
        if (sig === this._sig.stats) return;
        this._sig.stats = sig;
        const tiles = [
            { label: 'Total plays', value: String(data.totalPlays), meta: data.weekPlays ? data.weekPlays + ' in the last 7 days' : 'all time' },
            { label: 'Songs', value: String(data.uniqueSongs), meta: 'played at least once' },
            { label: 'Playlists', value: String(data.playlistsPlayed), meta: 'played at least once' },
            { label: 'Top artist', value: data.topArtist ? data.topArtist.name : '-', meta: data.topArtist ? PlaylistHomeViewController.plays_label(data.topArtist.plays) : 'no plays yet' },
        ];
        el.replaceChildren(...tiles.map((tile) => {
            const value = Dom.el('div', 'home-stat-value', tile.value);
            value.title = tile.value;
            const card = Dom.el('div', 'home-stat');
            card.append(
                Dom.el('div', 'home-stat-label', tile.label),
                value,
                Dom.el('div', 'home-stat-meta', tile.meta),
            );
            return card;
        }));
    }

    build_stories(data) {
        if (!data.totalPlays) {
            return [{ kicker: 'Nothing yet', value: 'Press play', meta: 'Your stats fill in as you listen.', empty: true }];
        }
        const stories = [];
        if (data.topArtist) {
            stories.push({
                kicker: 'Top artist',
                value: data.topArtist.name,
                meta: PlaylistHomeViewController.plays_label(data.topArtist.plays),
            });
        }
        const top_song = data.songs[0];
        if (top_song) {
            const artist = String(top_song.track.artist || '').trim();
            stories.push({
                kicker: 'Top song',
                value: top_song.track.title || 'Unknown',
                meta: (artist ? artist + ' - ' : '') + PlaylistHomeViewController.plays_label(top_song.count),
                art: this.track_cover_url(top_song.track),
            });
        }
        const top_playlist = data.playlists[0];
        if (top_playlist) {
            const tiles = (top_playlist.playlist && top_playlist.playlist.cover_tiles) || [];
            stories.push({
                kicker: 'Top playlist',
                value: top_playlist.playlist.name || 'Playlist',
                meta: PlaylistHomeViewController.plays_label(top_playlist.count),
                art: tiles[0] || '',
            });
        }
        stories.push({
            kicker: 'Last 7 days',
            value: String(data.weekPlays),
            meta: data.weekPlays === 1 ? 'play this week' : 'plays this week',
        });
        stories.push({
            kicker: 'Library',
            value: String(data.librarySize),
            meta: data.librarySize === 1 ? 'song ready to play' : 'songs ready to play',
        });
        return stories;
    }

    track_cover_url(track) {
        if (!track) return '';
        const covers = window.SpolocalCoverUrls;
        if (covers) return covers.trackCoverUrl(track.playlist_id, track.track_id, track.youtube_video_id) || '';
        return '/playlists/' + encodeURIComponent(track.playlist_id) + '/tracks/'
            + encodeURIComponent(track.track_id) + '/cover';
    }

    render_stories(data) {
        const track_el = document.getElementById('home-story-track');
        if (!track_el) return;
        const dots = document.getElementById('home-story-dots');
        const stories = this.build_stories(data);
        const sig = JSON.stringify(stories.map((s) => [s.kicker, s.value, s.meta, s.art || '', !!s.empty]));
        if (sig === this._sig.stories) {
            this.bind_story_controls();
            return;
        }
        this._sig.stories = sig;
        this._storyScroll = track_el.scrollLeft;
        track_el.replaceChildren(...stories.map((story) => this.story_card(story)));
        if (dots) {
            dots.replaceChildren(...stories.map((story, index) => {
                const dot = Dom.el('button', 'home-story-dot');
                dot.type = 'button';
                dot.setAttribute('aria-label', 'Highlight ' + (index + 1));
                dot.addEventListener('click', () => this.scroll_to_story(index));
                return dot;
            }));
        }
        this.bind_story_controls();
        requestAnimationFrame(() => {
            track_el.scrollLeft = this._storyScroll;
            this.sync_story_ui();
        });
    }

    story_card(story) {
        const card = Dom.el('article', 'home-story-card' + (story.empty ? ' home-story-card--empty' : ''));
        if (story.art) {
            const art = Dom.el('div', 'home-story-art');
            art.appendChild(Dom.cover(story.art));
            card.appendChild(art);
        }
        card.append(
            Dom.el('div', 'home-story-kicker', story.kicker),
            Dom.el('div', 'home-story-value', story.value),
            Dom.el('div', 'home-story-meta', story.meta),
        );
        return card;
    }

    /** Distance between two cards, gap included. */
    story_step() {
        const track_el = document.getElementById('home-story-track');
        if (!track_el) return 0;
        const cards = track_el.children;
        if (cards.length > 1) {
            const step = cards[1].offsetLeft - cards[0].offsetLeft;
            if (step > 0) return step;
        }
        const card = cards[0];
        if (!card) return 0;
        return card.getBoundingClientRect().width || track_el.clientWidth;
    }

    scroll_story(direction) {
        const track_el = document.getElementById('home-story-track');
        const step = this.story_step();
        if (!track_el || !step) return;
        this.scroll_to_story(Math.round(track_el.scrollLeft / step) + direction);
    }

    /** Absolute scroll, so scroll-snap cannot cancel a relative step. */
    scroll_to_story(index) {
        const track_el = document.getElementById('home-story-track');
        if (!track_el) return;
        const last = Math.max(0, track_el.children.length - 1);
        const target = Math.min(Math.max(index, 0), last);
        track_el.scrollTo({ left: this.story_step() * target, behavior: 'smooth' });
    }

    bind_story_controls() {
        const track_el = document.getElementById('home-story-track');
        if (!track_el) return;
        if (Dom.bind_once(track_el, 'scroll', 'scroll', () => {
            if (this._storyRaf) return;
            this._storyRaf = requestAnimationFrame(() => {
                this._storyRaf = 0;
                this.sync_story_ui();
            });
        }, { passive: true })) {
            track_el.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                this.scroll_story(e.key === 'ArrowRight' ? 1 : -1);
            });
            // The first sync can run before the carousel has a width, which
            // would leave both arrows disabled with no scroll event to fix it.
            if (typeof ResizeObserver === 'function') {
                new ResizeObserver(() => this.sync_story_ui()).observe(track_el);
            }
        }
        Dom.bind_once(document.getElementById('home-story-prev'), 'prev', 'click', () => this.scroll_story(-1));
        Dom.bind_once(document.getElementById('home-story-next'), 'next', 'click', () => this.scroll_story(1));
        this.sync_story_ui();
    }

    sync_story_ui() {
        const track_el = document.getElementById('home-story-track');
        if (!track_el || !track_el.clientWidth) return;
        const dots = document.getElementById('home-story-dots');
        const prev = document.getElementById('home-story-prev');
        const next = document.getElementById('home-story-next');
        const step = this.story_step();
        const index = step ? Math.round(track_el.scrollLeft / step) : 0;
        if (dots) {
            Array.from(dots.children).forEach((dot, i) => {
                dot.classList.toggle('home-story-dot--active', i === index);
            });
        }
        if (prev) prev.disabled = track_el.scrollLeft <= 2;
        if (next) next.disabled = track_el.scrollLeft + track_el.clientWidth >= track_el.scrollWidth - 2;
    }

    render_top_playlists(data) {
        const container = document.getElementById('home-top-playlists');
        if (!container) return;
        const ranked = data.playlists.slice(0, 12);
        const sig = JSON.stringify(ranked.map((row) => [row.id, row.count]));
        if (sig === this._sig.playlists) return;
        this._sig.playlists = sig;
        container.replaceChildren(...ranked.map((row, index) => this.playlist_card(row, index)));
        this.toggle_empty('home-playlists-empty', !ranked.length);
    }

    playlist_card(row, index) {
        const pl = row.playlist;
        const card = Dom.el('a', 'playlist-spa-nav group rounded-md bg-[#181818] p-2 hover:bg-[#282828] transition-colors');
        card.href = '/?playlist_id=' + encodeURIComponent(row.id);
        card.append(
            Dom.el('span', 'home-rank', '#' + (index + 1)),
            this.art_grid(pl && pl.cover_tiles),
            Dom.el('div', 'truncate text-xs font-semibold text-white leading-tight', (pl && pl.name) || 'Playlist'),
            Dom.el('div', 'text-[10px] text-[#727272] mt-0.5 leading-tight', PlaylistHomeViewController.plays_label(row.count)),
        );
        return card;
    }

    /** 2x2 cover mosaic used by the playlist rail. */
    art_grid(tiles) {
        const grid = Dom.el('div', 'playlist-art-grid grid aspect-square w-full min-h-0 min-w-0 grid-cols-2 overflow-hidden rounded-sm bg-[#1a1a1a] mb-1');
        grid.style.gridTemplateRows = 'repeat(2, minmax(0, 1fr))';
        grid.style.gap = '1px';
        const covers = tiles || [];
        for (let i = 0; i < 4; i++) {
            const cell = Dom.el('div', 'playlist-art-grid__cell h-full w-full bg-[#282828]');
            if (covers[i]) cell.appendChild(Dom.cover(covers[i]));
            grid.appendChild(cell);
        }
        return grid;
    }

    render_top_songs(data) {
        const container = document.getElementById('home-top-songs');
        if (!container) return;
        const ranked = data.songs.slice(0, 12);
        // The visible ranking is also the playback order for next/prev.
        this.state.hub.libraryOrder = ranked.map((row) => row.track);
        const sig = JSON.stringify(ranked.map((row) => [row.key, row.count]));
        if (sig === this._sig.songs) return;
        this._sig.songs = sig;
        const max_count = (ranked[0] && ranked[0].count) || 1;
        container.replaceChildren(...ranked.map((row, index) => this.song_row(row, index, max_count)));
        this.toggle_empty('home-songs-empty', !ranked.length);
        if (this.transport && this.transport.likes) this.transport.likes.bind_track_row_like_buttons();
    }

    song_row(row, index, max_count) {
        const t = row.track;
        const el = Dom.el('div', 'track-row home-song-row track-row--playable flex items-center gap-3 rounded-md px-1 py-1.5 hover:bg-[#282828]');
        el.dataset.playlistId = t.playlist_id;
        el.dataset.trackId = t.track_id;
        el.dataset.playSrc = t.play_src;
        el.dataset.title = t.title || '';
        el.dataset.artist = t.artist || '';
        el.dataset.album = t.album != null ? String(t.album) : '';

        const art = Dom.el('div', 'h-10 w-10 shrink-0 overflow-hidden rounded bg-[#1a1a1a]');
        art.appendChild(Dom.cover(this.track_cover_url(t), 'h-full w-full object-cover'));

        const bar = Dom.el('div', 'home-song-bar');
        const fill = Dom.el('span');
        fill.style.width = Math.max(4, Math.round((row.count / max_count) * 100)) + '%';
        bar.appendChild(fill);
        const text = Dom.el('div', 'min-w-0 flex-1');
        text.append(
            Dom.el('div', 'track-row-title truncate text-sm font-medium text-white', t.title || ''),
            Dom.el('div', 'track-row-artist truncate text-xs text-[#B3B3B3]', t.artist || ''),
            bar,
        );

        const like_btn = Dom.el('button', 'track-row-like shrink-0 h-8 w-8 flex items-center justify-center rounded-full text-[#B3B3B3] hover:text-white');
        like_btn.type = 'button';
        like_btn.dataset.playlistId = t.playlist_id;
        like_btn.dataset.trackId = t.track_id;
        like_btn.setAttribute('aria-label', 'Like');
        like_btn.innerHTML = '<i class="fa-regular fa-heart text-sm"></i>';

        el.append(
            Dom.el('span', 'w-6 text-center text-sm text-[#727272] tabular-nums shrink-0', String(index + 1)),
            art,
            text,
            Dom.el('span', 'home-song-count shrink-0', PlaylistHomeViewController.plays_label(row.count)),
            like_btn,
        );
        return el;
    }

    toggle_empty(id, empty) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !empty);
    }
}
