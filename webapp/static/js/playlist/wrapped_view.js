/**
 * Full-screen year recap: top songs, artists, playlists and days.
 *
 * Slides are vertical scroll-snap panels so a phone swipe or a desktop scroll
 * walks through the year, the same way the streaming apps do it. The data comes
 * from the home controller, which already has the library pool and the play
 * counters, so opening Wrapped costs no requests.
 */
import { Dom } from '../ui/dom.js?v=1';

export class PlaylistWrappedView {
    constructor(state, data_provider, cover_url) {
        this.state = state;
        this.data_provider = data_provider;
        this.cover_url = cover_url || (() => '');
        this._raf = 0;
        this._keysBound = false;
    }

    static plays_label(count) {
        const n = Number(count) || 0;
        return n + (n === 1 ? ' play' : ' plays');
    }

    data() {
        const data = typeof this.data_provider === 'function' ? this.data_provider() : null;
        if (!data) {
            return { songs: [], playlists: [], artists: [], total: 0, topArtist: null, topDay: null, librarySize: 0 };
        }
        return data;
    }

    /** Slide list for one year of data. Pure, so the tests can read it. */
    static slides_for(data) {
        const year = String(new Date().getFullYear());
        const songs = data.songs || [];
        const playlists = data.playlists || [];
        const artists = data.artists || [];
        const slides = [{
            theme: 'intro',
            kicker: 'SpoLocal',
            title: 'Wrapped ' + year,
            meta: data.total ? PlaylistWrappedView.plays_label(data.total) + ' this year' : 'No plays yet this year',
        }];
        if (!data.total && !songs.length) {
            slides.push({
                theme: 'empty',
                kicker: 'Nothing yet',
                title: 'Press play',
                meta: 'Your Wrapped fills in as you listen.',
            });
            return slides;
        }

        slides.push({
            theme: 'plays',
            kicker: 'You listened to',
            title: String(data.total),
            meta: data.total === 1 ? 'play' : 'plays',
        });

        if (songs[0]) {
            slides.push({
                theme: 'song',
                kicker: 'Your top song',
                title: songs[0].track.title || 'Unknown',
                meta: songs[0].track.artist || '',
                count: songs[0].count,
                art: data.cover ? data.cover(songs[0].track) : '',
            });
            slides.push({
                theme: 'songs',
                kicker: 'Your top songs',
                title: 'Top 5',
                items: songs.slice(0, 5).map((row) => ({
                    title: row.track.title || 'Unknown',
                    meta: row.track.artist || '',
                    count: row.count,
                    art: data.cover ? data.cover(row.track) : '',
                })),
            });
        }

        if (artists[0]) {
            const top_track = songs.find((row) => String(row.track.artist || '').trim() === artists[0].name);
            slides.push({
                theme: 'artist',
                kicker: 'Your top artist',
                title: artists[0].name,
                meta: '',
                count: artists[0].plays,
                art: top_track && data.cover ? data.cover(top_track.track) : '',
            });
            slides.push({
                theme: 'artists',
                kicker: 'Your top artists',
                title: 'Top 5',
                items: artists.slice(0, 5).map((artist) => {
                    const row = songs.find((s) => String(s.track.artist || '').trim() === artist.name);
                    return {
                        title: artist.name,
                        meta: '',
                        count: artist.plays,
                        art: row && data.cover ? data.cover(row.track) : '',
                    };
                }),
            });
        }

        if (playlists.length) {
            slides.push({
                theme: 'playlists',
                kicker: 'Your top playlists',
                title: 'Top 3',
                items: playlists.slice(0, 3).map((row) => {
                    const tiles = (row.playlist && row.playlist.cover_tiles) || [];
                    return {
                        title: row.playlist.name || 'Playlist',
                        meta: '',
                        count: row.count,
                        art: tiles[0] || '',
                    };
                }),
            });
        }

        if (data.topDay) {
            slides.push({
                theme: 'day',
                kicker: 'Your busiest day',
                title: data.topDay.day,
                meta: PlaylistWrappedView.plays_label(data.topDay.plays),
            });
        }

        slides.push({
            theme: 'library',
            kicker: 'Your library',
            title: String(data.librarySize || 0),
            meta: (data.librarySize || 0) === 1 ? 'song ready to play' : 'songs ready to play',
        });
        slides.push({
            theme: 'outro',
            kicker: 'That was',
            title: year,
            meta: 'See you next year.',
        });
        return slides;
    }

    slides() {
        const data = this.data();
        const cover = this.cover_url;
        return PlaylistWrappedView.slides_for({ ...data, cover });
    }

    is_open() {
        const overlay = document.getElementById('wrapped-overlay');
        return !!overlay && !overlay.classList.contains('hidden');
    }

    open() {
        const overlay = document.getElementById('wrapped-overlay');
        if (!overlay) return;
        this.render();
        overlay.classList.remove('hidden');
        document.body.classList.add('wrapped-open');
        const track = document.getElementById('wrapped-track');
        if (track) track.scrollTop = 0;
        this.bind();
        this.sync_progress();
    }

    close() {
        const overlay = document.getElementById('wrapped-overlay');
        if (overlay) overlay.classList.add('hidden');
        document.body.classList.remove('wrapped-open');
    }

    render() {
        const track = document.getElementById('wrapped-track');
        if (!track) return;
        const slides = this.slides();
        track.replaceChildren(...slides.map((slide, index) => this.slide_el(slide, index)));
        const progress = document.getElementById('wrapped-progress');
        if (progress) {
            progress.replaceChildren(...slides.map(() => Dom.el('span', 'wrapped-progress-seg')));
        }
        const count = document.getElementById('wrapped-count');
        if (count) count.textContent = '1 / ' + slides.length;
    }

    slide_el(slide, index) {
        const el = Dom.el('section', 'wrapped-slide wrapped-slide--' + slide.theme + ' wrapped-slide--n' + (index % 10));
        const inner = Dom.el('div', 'wrapped-slide-inner');
        inner.append(
            Dom.el('div', 'wrapped-kicker', slide.kicker || ''),
            Dom.el('div', 'wrapped-title', slide.title || ''),
        );
        if (slide.meta) inner.appendChild(Dom.el('div', 'wrapped-meta', slide.meta));
        if (slide.count != null) {
            inner.appendChild(Dom.el('div', 'wrapped-count-big', PlaylistWrappedView.plays_label(slide.count)));
        }
        if (slide.art) {
            const art = Dom.el('div', 'wrapped-art');
            art.appendChild(Dom.cover(slide.art));
            inner.appendChild(art);
        }
        if (slide.items && slide.items.length) {
            const list = Dom.el('div', 'wrapped-list');
            slide.items.forEach((item, i) => {
                const row = Dom.el('div', 'wrapped-item');
                const art = Dom.el('div', 'wrapped-item-art');
                if (item.art) art.appendChild(Dom.cover(item.art));
                const body = Dom.el('div', 'wrapped-item-body');
                body.append(
                    Dom.el('div', 'wrapped-item-title', item.title),
                    Dom.el('div', 'wrapped-item-meta', item.meta || ''),
                );
                row.append(
                    Dom.el('div', 'wrapped-rank', String(i + 1)),
                    art,
                    body,
                    Dom.el('div', 'wrapped-item-count', PlaylistWrappedView.plays_label(item.count)),
                );
                list.appendChild(row);
            });
            inner.appendChild(list);
        }
        el.appendChild(inner);
        return el;
    }

    bind() {
        Dom.bind_once(document.getElementById('wrapped-close'), 'wrappedClose', 'click', () => this.close());
        const track = document.getElementById('wrapped-track');
        if (track) {
            if (Dom.bind_once(track, 'wrappedScroll', 'scroll', () => {
                if (this._raf) return;
                this._raf = requestAnimationFrame(() => {
                    this._raf = 0;
                    this.sync_progress();
                });
            }, { passive: true })) {
                track.addEventListener('click', (e) => {
                    if (e.target.closest('button, a')) return;
                    this.step(1);
                });
            }
        }
        if (!this._keysBound) {
            this._keysBound = true;
            document.addEventListener('keydown', (e) => {
                if (!this.is_open()) return;
                if (e.key === 'Escape') {
                    this.close();
                } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
                    e.preventDefault();
                    this.step(1);
                } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
                    e.preventDefault();
                    this.step(-1);
                }
            });
        }
    }

    step(direction) {
        const track = document.getElementById('wrapped-track');
        if (!track) return;
        const step = track.clientHeight || 1;
        const index = Math.round(track.scrollTop / step) + direction;
        const last = Math.max(0, track.children.length - 1);
        const target = Math.max(0, Math.min(index, last)) * step;
        if (typeof track.scrollTo === 'function') {
            track.scrollTo({ top: target, behavior: 'smooth' });
        } else {
            track.scrollTop = target;
        }
    }

    sync_progress() {
        const track = document.getElementById('wrapped-track');
        const progress = document.getElementById('wrapped-progress');
        if (!track || !progress) return;
        const step = track.clientHeight || 1;
        const index = Math.round(track.scrollTop / step);
        progress.querySelectorAll('.wrapped-progress-seg').forEach((seg, i) => {
            seg.classList.toggle('is-active', i === index);
            seg.classList.toggle('is-done', i < index);
        });
        const count = document.getElementById('wrapped-count');
        if (count) count.textContent = Math.min(index + 1, progress.children.length) + ' / ' + progress.children.length;
    }
}
