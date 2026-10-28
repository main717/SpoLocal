/**
 * Full-screen year recap: top songs, artists, playlists and days.
 *
 * Slides are vertical scroll-snap panels so a phone swipe or a desktop scroll
 * walks through the year, the same way the streaming apps do it. The data comes
 * from the home controller, which already has the library pool and the play
 * counters, so opening Wrapped costs no requests.
 *
 * Each slide animates in when it becomes visible (IntersectionObserver) and the
 * glow palette is shuffled per open, so two Wrapped runs never look identical.
 */
import { Dom } from '../ui/dom.js?v=1';

const GLOWS = [
    'rgba(255, 255, 255, 0.22)',
    'rgba(255, 160, 220, 0.30)',
    'rgba(120, 200, 255, 0.30)',
    'rgba(255, 220, 120, 0.28)',
    'rgba(160, 255, 180, 0.26)',
    'rgba(200, 160, 255, 0.28)',
];
const SOUND_KEY = 'spolocal_wrapped_sound';

export class PlaylistWrappedView {
    constructor(state, data_provider, cover_url) {
        this.state = state;
        this.data_provider = data_provider;
        this.cover_url = cover_url || (() => '');
        this._raf = 0;
        this._keysBound = false;
        this._io = null;
        this._mood = 0;
        this._sound = true;
        this._tracks = [];
        this._track_index = 0;
        this._main_was_playing = false;
        this._durations = [];
        this._adv = null;
        this._ticker = 0;
        this._jumping = false;
    }

    static plays_label(count) {
        const n = Number(count) || 0;
        return n + (n === 1 ? ' play' : ' plays');
    }

    static reduced_motion() {
        try {
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (e) {
            return false;
        }
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
        this._mood = Math.floor(Math.random() * GLOWS.length);
        this.render();
        overlay.classList.remove('hidden');
        document.body.classList.add('wrapped-open');
        const track = document.getElementById('wrapped-track');
        if (track) track.scrollTop = 0;
        this.bind();
        this.activate_slide(track && track.children.length ? track.children[0] : null);
        this.sync_progress();
        this.start_audio();
        this.start_ticker();
    }

    close() {
        const overlay = document.getElementById('wrapped-overlay');
        if (overlay) overlay.classList.add('hidden');
        document.body.classList.remove('wrapped-open');
        this.stop_ticker();
        this._adv = null;
        this._jumping = false;
        this.stop_audio();
        this.resume_main();
    }

    render() {
        const track = document.getElementById('wrapped-track');
        if (!track) return;
        const slides = this.slides();
        track.replaceChildren(...slides.map((slide, index) => this.slide_el(slide, index)));
        const progress = document.getElementById('wrapped-progress');
        if (progress) {
            progress.replaceChildren(...slides.map(() => {
                const seg = Dom.el('span', 'wrapped-progress-seg');
                seg.appendChild(Dom.el('span', 'wrapped-progress-fill'));
                return seg;
            }));
        }
        const count = document.getElementById('wrapped-count');
        if (count) count.textContent = '1 / ' + slides.length;
        this._durations = slides.map((slide) => this.slide_duration(slide));
        this.observe_slides();
    }

    slide_el(slide, index) {
        const el = Dom.el('section', 'wrapped-slide wrapped-slide--' + slide.theme + ' wrapped-slide--n' + (index % 10));
        // Per-open palette and drift, so each run of Wrapped looks a little different.
        const from_x = ['0', '1.75rem', '-1.75rem'][index % 3];
        el.style.setProperty('--wrapped-from-x', from_x);
        el.style.setProperty('--wrapped-glow', GLOWS[(this._mood + index) % GLOWS.length]);
        el.style.setProperty('--wrapped-dx', index % 2 ? '9%' : '-9%');
        el.style.setProperty('--wrapped-dy', index % 3 ? '7%' : '-7%');
        el.style.setProperty('--wrapped-drift-dur', (14 + (index % 5) * 2) + 's');
        const inner = Dom.el('div', 'wrapped-slide-inner');
        const title_text = String(slide.title || '');
        const title = Dom.el('div', 'wrapped-title');
        if (/^\d+$/.test(title_text)) {
            title.textContent = title_text;
            title.dataset.countTo = title_text;
        } else {
            title.classList.add('wrapped-title--words');
            // Split the headline so each word can arrive on its own beat.
            title_text.split(/\s+/).filter(Boolean).forEach((word, w) => {
                if (w) title.appendChild(document.createTextNode(' '));
                const span = Dom.el('span', 'wrapped-word', word);
                span.style.setProperty('--wrapped-w', String(w));
                title.appendChild(span);
            });
        }
        inner.append(
            Dom.el('div', 'wrapped-kicker', slide.kicker || ''),
            title,
        );
        if (slide.meta) inner.appendChild(Dom.el('div', 'wrapped-meta', slide.meta));
        if (slide.count != null) {
            const count = Number(slide.count) || 0;
            const big = Dom.el('div', 'wrapped-count-big');
            big.dataset.countTo = String(count);
            big.dataset.countSuffix = ' ' + (count === 1 ? 'play' : 'plays');
            big.textContent = PlaylistWrappedView.plays_label(count);
            inner.appendChild(big);
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
                row.style.setProperty('--wrapped-i', String(i));
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
        Array.from(inner.children).forEach((child, i) => child.style.setProperty('--wrapped-i', String(i)));
        el.appendChild(inner);
        return el;
    }

    /** Fade and rise the slide contents once it is mostly on screen. */
    observe_slides() {
        const track = document.getElementById('wrapped-track');
        if (!track) return;
        if (this._io) {
            this._io.disconnect();
            this._io = null;
        }
        if (typeof IntersectionObserver !== 'function') {
            Array.from(track.children).forEach((el) => this.activate_slide(el));
            return;
        }
        this._io = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                    this.activate_slide(entry.target);
                }
            });
        }, { root: track, threshold: [0.5] });
        Array.from(track.children).forEach((el) => this._io.observe(el));
    }

    activate_slide(el) {
        if (!el || el.classList.contains('is-active')) return;
        el.classList.add('is-active');
        el.querySelectorAll('[data-count-to]').forEach((node) => this.count_up(node));
    }

    count_up(node) {
        const target = Number(node.dataset.countTo) || 0;
        const suffix = node.dataset.countSuffix || '';
        if (PlaylistWrappedView.reduced_motion()) {
            node.textContent = String(target) + suffix;
            return;
        }
        const duration = 750;
        const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const tick = (now) => {
            const t = Math.min(1, (now - started) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            node.textContent = String(Math.round(target * eased)) + suffix;
            if (t < 1) requestAnimationFrame(tick);
            else node.classList.add('is-done');
        };
        requestAnimationFrame(tick);
    }

    /** Soundtrack: the year's top five songs, in order, on an audio element of its own. */
    sound_pref() {
        try {
            return localStorage.getItem(SOUND_KEY) !== '0';
        } catch (e) {
            return true;
        }
    }

    audio_el() {
        return document.getElementById('wrapped-audio');
    }

    start_audio() {
        const data = this.data();
        this._tracks = (data.songs || [])
            .slice(0, 5)
            .filter((row) => row && row.track && row.track.play_src);
        this._track_index = 0;
        this._sound = this.sound_pref();
        this.sync_sound_ui();
        const audio = this.audio_el();
        if (audio) Dom.bind_once(audio, 'wrappedEnded', 'ended', () => this.next_track());
        this.pause_main();
        if (!this._sound || !this._tracks.length) return;
        this.play_current();
    }

    play_current() {
        const audio = this.audio_el();
        const row = this._tracks[this._track_index];
        if (!audio || !row || !row.track.play_src) return;
        const src = String(row.track.play_src);
        if (audio.getAttribute('src') !== src) audio.setAttribute('src', src);
        try { audio.currentTime = 0; } catch (e) {}
        try {
            const result = typeof audio.play === 'function' ? audio.play() : null;
            if (result && typeof result.catch === 'function') {
                result.catch(() => {
                    this._sound = false;
                    this.sync_sound_ui();
                });
            }
        } catch (e) {
            this._sound = false;
            this.sync_sound_ui();
        }
    }

    next_track() {
        if (!this._tracks.length || this._sound === false) return;
        this._track_index = (this._track_index + 1) % this._tracks.length;
        this.play_current();
    }

    toggle_sound() {
        this.set_sound(!(this._sound !== false));
    }

    set_sound(on) {
        this._sound = !!on;
        try {
            localStorage.setItem(SOUND_KEY, on ? '1' : '0');
        } catch (e) {}
        this.sync_sound_ui();
        if (on) this.play_current();
        else this.pause_audio();
    }

    sync_sound_ui() {
        const btn = document.getElementById('wrapped-sound');
        if (!btn) return;
        const on = this._sound !== false;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? 'Mute soundtrack' : 'Play soundtrack');
        const icon = btn.querySelector('i');
        if (icon) icon.className = 'fa-solid ' + (on ? 'fa-volume-high' : 'fa-volume-xmark');
    }

    pause_audio() {
        const audio = this.audio_el();
        if (!audio) return;
        try { audio.pause(); } catch (e) {}
    }

    stop_audio() {
        const audio = this.audio_el();
        if (!audio) return;
        this.pause_audio();
        try { audio.currentTime = 0; } catch (e) {}
        audio.removeAttribute('src');
        try {
            if (typeof audio.load === 'function') audio.load();
        } catch (e) {}
    }

    /** Hold the main player while Wrapped has the sound. */
    main_audio() {
        const hub = this.state && this.state.hub;
        return (hub && hub.audio) || null;
    }

    pause_main() {
        const audio = this.main_audio();
        if (!audio) return;
        this._main_was_playing = !audio.paused;
        if (this._main_was_playing) {
            try { audio.pause(); } catch (e) {}
        }
    }

    resume_main() {
        if (!this._main_was_playing) return;
        this._main_was_playing = false;
        const audio = this.main_audio();
        if (!audio) return;
        try {
            const result = audio.play();
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (e) {}
    }

    /** Dwell time per slide; lists get longer because there is more to read. */
    slide_duration(slide) {
        const items = (slide.items || []).length;
        if (items) return Math.min(11000, 5500 + items * 900);
        if (slide.theme === 'intro') return 5500;
        if (slide.theme === 'outro') return 7500;
        return 6500;
    }

    reset_advance(index) {
        const dur = this._durations[index] || 6500;
        this._adv = { index, elapsed: 0, last: 0, dur, paused: false };
    }

    start_ticker() {
        if (this._ticker) return;
        this._ticker = requestAnimationFrame((now) => this.tick(now));
    }

    stop_ticker() {
        if (this._ticker) cancelAnimationFrame(this._ticker);
        this._ticker = 0;
    }

    /** One frame of the dwell timer, which also paints the progress bar. */
    tick(now) {
        if (!this.is_open()) {
            this._ticker = 0;
            return;
        }
        const adv = this._adv;
        if (adv) {
            if (!adv.last) adv.last = now;
            const delta = Math.max(0, now - adv.last);
            adv.last = now;
            const frozen = adv.paused || this._jumping;
            if (!frozen) adv.elapsed += delta;
            this.paint_fill(adv.index, Math.min(1, adv.elapsed / adv.dur));
            if (!frozen && adv.elapsed >= adv.dur) this.advance_next();
        }
        this._ticker = requestAnimationFrame((t) => this.tick(t));
    }

    paint_fill(index, frac) {
        const progress = document.getElementById('wrapped-progress');
        if (!progress) return;
        const seg = progress.children[index];
        const fill = seg && seg.querySelector('.wrapped-progress-fill');
        if (fill) fill.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
    }

    advance_next() {
        const track = document.getElementById('wrapped-track');
        if (!track) return;
        const step = track.clientHeight || 1;
        const index = Math.round(track.scrollTop / step);
        const next = index + 1;
        if (next > track.children.length - 1) {
            this._adv = null;
            this.paint_fill(index, 1);
            return;
        }
        this.go_to(next);
    }

    go_to(index) {
        const track = document.getElementById('wrapped-track');
        if (!track) return;
        const step = track.clientHeight || 1;
        const last = Math.max(0, track.children.length - 1);
        const target = Math.max(0, Math.min(index, last));
        this._jumping = true;
        this.reset_advance(target);
        const behavior = PlaylistWrappedView.reduced_motion() ? 'auto' : 'smooth';
        if (typeof track.scrollTo === 'function') {
            track.scrollTo({ top: target * step, behavior });
        } else {
            track.scrollTop = target * step;
        }
        setTimeout(() => { this._jumping = false; }, 800);
    }

    set_advance_paused(on) {
        if (!this._adv) return;
        this._adv.paused = !!on;
        this._adv.last = 0;
    }

    bind() {
        Dom.bind_once(document.getElementById('wrapped-close'), 'wrappedClose', 'click', () => this.close());
        Dom.bind_once(document.getElementById('wrapped-sound'), 'wrappedSound', 'click', () => this.toggle_sound());
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
            Dom.bind_once(track, 'wrappedHold', 'pointerdown', () => this.set_advance_paused(true));
            Dom.bind_once(track, 'wrappedHoldEnd', 'pointerup', () => this.set_advance_paused(false));
            Dom.bind_once(track, 'wrappedHoldCancel', 'pointercancel', () => this.set_advance_paused(false));
        }
        if (!this._keysBound) {
            this._keysBound = true;
            document.addEventListener('visibilitychange', () => {
                this.set_advance_paused(document.hidden);
            });
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
        const pos = track.scrollTop / step;
        const index = Math.round(pos);
        const last = Math.max(0, progress.children.length - 1);
        const clamped = Math.max(0, Math.min(pos, last));
        if (!this._jumping) {
            if (index >= last) {
                this._adv = null;
                this.paint_fill(index, 1);
            } else if (!this._adv || this._adv.index !== index) {
                this.reset_advance(index);
            }
        }
        Array.from(track.children).forEach((el, i) => {
            el.classList.toggle('is-current', i === index);
        });
        progress.querySelectorAll('.wrapped-progress-seg').forEach((seg, i) => {
            seg.classList.toggle('is-active', i === index);
            seg.classList.toggle('is-done', i < index);
            const fill = seg.querySelector('.wrapped-progress-fill');
            if (fill) {
                const part = i === index && index === last ? 1 : Math.max(0, Math.min(1, clamped - i));
                fill.style.width = (part * 100).toFixed(1) + '%';
            }
        });
        const count = document.getElementById('wrapped-count');
        if (count) count.textContent = Math.min(index + 1, progress.children.length) + ' / ' + progress.children.length;
    }
}
