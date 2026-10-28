/**
 * Home view: listening stats, highlight carousel and random-play controls.
 *
 * All numbers come from the play counters in localStorage plus the library pool
 * that the server already sends with the home payload, so the view costs no
 * extra requests. Each section keeps its own signature and skips the rebuild
 * when nothing changed, which matters because render() also runs on every play.
 */
import { Dom } from '../ui/dom.js?v=1';
import { HOME_RANGES, home_range, home_range_def, set_home_range } from '../ui/home_prefs.js?v=1';
import { PlaylistPlayLog } from './play_log.js?v=3';
import { PlaylistWrappedView } from './wrapped_view.js?v=1';

export class PlaylistHomeViewController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state, transport) {
        this.state = state;
        this.transport = transport;
        this._sig = {};
        this._storyScroll = 0;
        this._storyRaf = 0;
        this.wrapped = new PlaylistWrappedView(
            state,
            () => this.range_data('year'),
            (track) => this.track_cover_url(track),
        );
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
        Dom.bind_once(document.getElementById('home-wrapped-card'), 'wrapped', 'click', () => this.wrapped.open());
        this.sync_random_ui();
    }

    sync_random_ui() {
        const hub = this.state.hub;
        const btn = document.getElementById('home-random-toggle');
        if (btn) {
            btn.textContent = hub.randomMode ? 'Stop random' : 'Start random';
            btn.classList.toggle('bg-[#3E3E3E]', hub.randomMode);
            btn.classList.toggle('text-white', hub.randomMode);
            btn.classList.toggle('bg-[#1DB954]', !hub.randomMode);
            btn.classList.toggle('text-black', !hub.randomMode);
        }
    }

    render() {
        const data = this.aggregate();
        this.render_range_stats();
        this.render_storage();
        this.render_wrapped_card();
        this.render_stories(data);
        this.render_top_playlists(data);
        this.render_top_songs(data);
        this.bind_controls();
    }

    static format_bytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Math.max(0, Number(bytes) || 0);
        let i = 0;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i += 1;
        }
        return (i === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1)) + ' ' + units[i];
    }

    /** Disk usage of the media folder, fetched at most once a minute. */
    render_storage() {
        const el = document.getElementById('home-storage');
        if (!el) return;
        if (this._storage && Date.now() - this._storage.at < 60000) {
            this.paint_storage(this._storage.data);
            return;
        }
        if (this._storagePending) return;
        this._storagePending = true;
        fetch('/api/storage', { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                this._storagePending = false;
                if (!data) return;
                this._storage = { at: Date.now(), data };
                this.paint_storage(data);
            })
            .catch(() => { this._storagePending = false; });
    }

    paint_storage(data) {
        const box = document.getElementById('home-storage');
        if (!box) return;
        box.classList.remove('hidden');
        const total = Number(data.total_bytes) || 0;
        const free = Number(data.free_bytes) || 0;
        const used_pct = total ? Math.min(100, Math.max(0, ((total - free) / total) * 100)) : 0;
        const size = document.getElementById('home-storage-size');
        const meta = document.getElementById('home-storage-meta');
        const fill = document.getElementById('home-storage-fill');
        if (size) size.textContent = PlaylistHomeViewController.format_bytes(data.media_bytes) + ' used';
        if (meta) {
            meta.textContent = PlaylistHomeViewController.format_bytes(free) +
                ' free of ' + PlaylistHomeViewController.format_bytes(total);
        }
        if (fill) fill.style.width = used_pct.toFixed(1) + '%';
    }

    catalog_by_id() {
        const map = new Map();
        const catalog = Array.isArray(window.__playlistsCatalog) ? window.__playlistsCatalog : [];
        catalog.forEach((pl) => {
            if (pl && pl.id) map.set(String(pl.id), pl);
        });
        return map;
    }

    /** Library tracks keyed by ``playlist|track``. */
    pool_map(pool) {
        const map = new Map();
        pool.forEach((t) => {
            if (t && t.playlist_id && t.track_id) {
                map.set(PlaylistPlayLog.track_key(t.playlist_id, t.track_id), t);
            }
        });
        return map;
    }

    library_pool() {
        const hub = this.state.hub;
        return Array.isArray(hub.libraryPool) ? hub.libraryPool : [];
    }

    rank_songs(track_plays, pool_map) {
        return Object.entries(track_plays)
            .map(([key, count]) => ({ key, count: Number(count) || 0, track: pool_map.get(key) }))
            .filter((row) => row.count > 0 && row.track && row.track.play_src)
            .sort((a, b) => b.count - a.count);
    }

    rank_playlists(playlist_plays, catalog) {
        return Object.entries(playlist_plays)
            .map(([id, count]) => ({ id, count: Number(count) || 0, playlist: catalog.get(String(id)) }))
            .filter((row) => row.count > 0 && row.playlist)
            .sort((a, b) => b.count - a.count);
    }

    artist_rows(songs) {
        const map = new Map();
        songs.forEach((row) => {
            const name = String(row.track.artist || '').trim();
            if (name) map.set(name, (map.get(name) || 0) + row.count);
        });
        return Array.from(map.entries())
            .map(([name, plays]) => ({ name, plays }))
            .sort((a, b) => b.plays - a.plays);
    }

    /** Ranked songs, playlists and headline numbers for the whole view. */
    aggregate() {
        const track_plays = PlaylistPlayLog.track_plays();
        const playlist_plays = PlaylistPlayLog.playlist_plays();
        const catalog = this.catalog_by_id();
        const pool = this.library_pool();
        const songs = this.rank_songs(track_plays, this.pool_map(pool));
        const playlists = this.rank_playlists(playlist_plays, catalog);
        const artists = this.artist_rows(songs);
        return {
            songs,
            playlists,
            totalPlays: Object.values(track_plays).reduce((sum, v) => sum + (Number(v) || 0), 0),
            uniqueSongs: songs.length,
            playlistsPlayed: playlists.length,
            topArtist: artists[0] || null,
            weekPlays: PlaylistPlayLog.week_plays(),
            librarySize: pool.length,
        };
    }

    /** Everything the stats section and Wrapped need for one date range. */
    range_data(key) {
        const def = home_range_def(key);
        const catalog = this.catalog_by_id();
        const pool = this.library_pool();
        const track_plays = PlaylistPlayLog.range_track_plays(def.days);
        const playlist_plays = PlaylistPlayLog.range_playlist_plays(def.days);
        const songs = this.rank_songs(track_plays, this.pool_map(pool));
        const playlists = this.rank_playlists(playlist_plays, catalog);
        const artists = this.artist_rows(songs);
        const days = PlaylistPlayLog.range_day_plays(def.days);
        const busiest = Object.entries(days).sort((a, b) => b[1] - a[1])[0];
        return {
            def,
            songs,
            playlists,
            artists,
            topArtist: artists[0] || null,
            topDay: busiest ? { day: busiest[0], plays: busiest[1] } : null,
            total: Object.values(track_plays).reduce((sum, v) => sum + (Number(v) || 0), 0),
            librarySize: pool.length,
        };
    }

    render_range_stats() {
        const el = document.getElementById('home-stats');
        if (!el) return;
        const key = home_range();
        const data = this.range_data(key);
        this.render_range_tabs();
        this.render_range_hero(data);
        const sig = JSON.stringify([key, data.total, data.songs.length, data.playlists.length, data.topArtist]);
        if (sig === this._sig.stats) return;
        this._sig.stats = sig;
        const tiles = [
            { label: 'Plays', value: String(data.total), meta: data.def.period },
            { label: 'Songs', value: String(data.songs.length), meta: 'played at least once' },
            { label: 'Artists', value: String(data.artists.length), meta: 'played at least once' },
            {
                label: 'Top artist',
                value: data.topArtist ? data.topArtist.name : '-',
                meta: data.topArtist ? PlaylistHomeViewController.plays_label(data.topArtist.plays) : 'no plays yet',
            },
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

    render_range_tabs() {
        const tabs = document.getElementById('home-range-tabs');
        if (!tabs) return;
        if (!tabs.children.length) {
            tabs.replaceChildren(...HOME_RANGES.map((range) => {
                const btn = Dom.el('button', 'home-range-tab', range.label);
                btn.type = 'button';
                btn.dataset.range = range.key;
                btn.setAttribute('role', 'tab');
                return btn;
            }));
        }
        Dom.bind_once(tabs, 'range', 'click', (e) => {
            const btn = e.target.closest('[data-range]');
            if (btn) this.set_range(btn.dataset.range);
        });
        const key = home_range();
        tabs.querySelectorAll('[data-range]').forEach((btn) => {
            const on = btn.dataset.range === key;
            btn.classList.toggle('home-range-tab--active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }

    set_range(key) {
        set_home_range(key);
        this._sig.stats = null;
        this.render_range_stats();
        this.sync_settings_range();
    }

    sync_settings_range() {
        const group = document.getElementById('settings-home-range');
        if (!group) return;
        const key = home_range();
        group.querySelectorAll('[data-range]').forEach((btn) => {
            const on = btn.dataset.range === key;
            btn.classList.toggle('quality-tier-btn--active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    render_range_hero(data) {
        const hero = document.getElementById('home-range-hero');
        if (!hero) return;
        const top_song = data.songs[0];
        if (!data.total && !top_song) {
            hero.replaceChildren(Dom.el('div', 'home-hero home-hero--empty', 'Nothing played ' + data.def.period + ' yet.'));
            return;
        }
        const card = Dom.el('div', 'home-hero');
        const art = Dom.el('div', 'home-hero-art');
        if (top_song) art.appendChild(Dom.cover(this.track_cover_url(top_song.track)));
        const body = Dom.el('div', 'home-hero-body');
        body.append(
            Dom.el('div', 'home-hero-kicker', top_song ? 'Top song ' + data.def.period : 'Plays ' + data.def.period),
            Dom.el('div', 'home-hero-title', top_song ? (top_song.track.title || 'Unknown') : String(data.total)),
            Dom.el('div', 'home-hero-meta', top_song ? (top_song.track.artist || '') : data.def.title),
        );
        if (top_song) {
            body.appendChild(Dom.el('div', 'home-hero-plays', PlaylistHomeViewController.plays_label(top_song.count)));
        }
        card.append(art, body);
        if (data.topArtist) {
            const side = Dom.el('div', 'home-hero-side');
            side.append(
                Dom.el('div', 'home-stat-label', 'Top artist'),
                Dom.el('div', 'home-hero-artist', data.topArtist.name),
                Dom.el('div', 'home-hero-plays', PlaylistHomeViewController.plays_label(data.topArtist.plays)),
            );
            card.appendChild(side);
        }
        hero.replaceChildren(card);
    }

    render_wrapped_card() {
        const year = document.getElementById('home-wrapped-year');
        if (year) year.textContent = String(new Date().getFullYear());
        const meta = document.getElementById('home-wrapped-meta');
        if (!meta) return;
        const data = this.range_data('year');
        meta.textContent = data.total
            ? PlaylistHomeViewController.plays_label(data.total) + ' in ' + data.songs.length +
                (data.songs.length === 1 ? ' song' : ' songs')
            : 'Your year in music';
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
        const stories = this.build_stories(data);
        const sig = JSON.stringify(stories.map((s) => [s.kicker, s.value, s.meta, s.art || '', !!s.empty]));
        if (sig === this._sig.stories) {
            this.bind_story_controls();
            return;
        }
        this._sig.stories = sig;
        this._storyScroll = track_el.scrollLeft;
        track_el.replaceChildren(...stories.map((story) => this.story_card(story)));
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
        const prev = document.getElementById('home-story-prev');
        const next = document.getElementById('home-story-next');
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
