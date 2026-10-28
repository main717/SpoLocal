/**
 * Play counters: per track, per playlist and per day.
 *
 * The account is the source of truth. Counts are cached in localStorage so the
 * home view stays synchronous, then mirrored to /api/play-log. A device merges
 * its old local history into the account once (``sync``), after which the
 * server wins. Guests keep their counters in localStorage only.
 */
const TRACKS_KEY = 'spolocal_track_plays';
const PLAYLISTS_KEY = 'spolocal_playlist_plays';
const DAYS_KEY = 'spolocal_play_log';
const TRACK_DAYS_KEY = 'spolocal_track_day_plays';
const SYNCED_KEY = 'spolocal_play_log_synced';
const MAX_DAYS = 400;
const COUNTER_FIELDS = ['track_plays', 'playlist_plays', 'day_plays', 'track_day_plays'];

export class PlaylistPlayLog {
    static track_key(playlist_id, track_id) {
        return String(playlist_id || '').trim() + '|' + String(track_id || '').trim();
    }

    static read(key) {
        try {
            const raw = localStorage.getItem(key);
            const value = raw ? JSON.parse(raw) : {};
            return value && typeof value === 'object' ? value : {};
        } catch (e) {
            return {};
        }
    }

    static write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {}
    }

    static track_plays() {
        return PlaylistPlayLog.read(TRACKS_KEY);
    }

    static playlist_plays() {
        return PlaylistPlayLog.read(PLAYLISTS_KEY);
    }

    static day_plays() {
        return PlaylistPlayLog.read(DAYS_KEY);
    }

    static track_day_plays() {
        return PlaylistPlayLog.read(TRACK_DAYS_KEY);
    }

    /** Count one play of a track, its playlist and the day. */
    static count_track(playlist_id, track_id) {
        const pid = String(playlist_id || '').trim();
        const tid = String(track_id || '').trim();
        if (!pid || !tid) return;
        const tracks = PlaylistPlayLog.track_plays();
        const key = PlaylistPlayLog.track_key(pid, tid);
        tracks[key] = (Number(tracks[key]) || 0) + 1;
        PlaylistPlayLog.write(TRACKS_KEY, tracks);
        const playlists = PlaylistPlayLog.playlist_plays();
        playlists[pid] = (Number(playlists[pid]) || 0) + 1;
        PlaylistPlayLog.write(PLAYLISTS_KEY, playlists);
        PlaylistPlayLog.count_day();
        PlaylistPlayLog.count_track_day(pid, tid);
        PlaylistPlayLog.push(pid, tid);
    }

    /** Per-track counts for one day, so ranges can rank songs honestly. */
    static count_track_day(pid, tid) {
        const counts = PlaylistPlayLog.track_day_plays();
        const key = PlaylistPlayLog.day(0) + '|' + PlaylistPlayLog.track_key(pid, tid);
        counts[key] = (Number(counts[key]) || 0) + 1;
        const cutoff = PlaylistPlayLog.day(MAX_DAYS);
        Object.keys(counts).forEach((k) => {
            if (k.slice(0, 10) < cutoff) delete counts[k];
        });
        PlaylistPlayLog.write(TRACK_DAYS_KEY, counts);
    }

    /** Per-day counts, capped so the log cannot grow without bound. */
    static count_day() {
        const days = PlaylistPlayLog.day_plays();
        const today = PlaylistPlayLog.day(0);
        days[today] = (Number(days[today]) || 0) + 1;
        const keys = Object.keys(days).sort();
        while (keys.length > MAX_DAYS) delete days[keys.shift()];
        PlaylistPlayLog.write(DAYS_KEY, days);
    }

    /** YYYY-MM-DD for today minus offset_days. */
    static day(offset_days) {
        return new Date(Date.now() - (offset_days || 0) * 86400000).toISOString().slice(0, 10);
    }

    /** Calendar days covered by a range, today included. */
    static range_days(days) {
        const wanted = new Set();
        const count = Math.max(1, Number(days) || 1);
        for (let i = 0; i < count; i++) wanted.add(PlaylistPlayLog.day(i));
        return wanted;
    }

    /** Track counts inside a range, keyed ``playlist|track``. */
    static range_track_plays(days) {
        const counts = PlaylistPlayLog.track_day_plays();
        const wanted = PlaylistPlayLog.range_days(days);
        const out = {};
        Object.keys(counts).forEach((key) => {
            if (!wanted.has(key.slice(0, 10))) return;
            const track = key.slice(11);
            if (!track) return;
            out[track] = (Number(out[track]) || 0) + (Number(counts[key]) || 0);
        });
        return out;
    }

    /** Playlist counts inside a range, keyed by playlist id. */
    static range_playlist_plays(days) {
        const counts = PlaylistPlayLog.track_day_plays();
        const wanted = PlaylistPlayLog.range_days(days);
        const out = {};
        Object.keys(counts).forEach((key) => {
            if (!wanted.has(key.slice(0, 10))) return;
            const rest = key.slice(11);
            const bar = rest.indexOf('|');
            if (bar <= 0) return;
            const pid = rest.slice(0, bar);
            out[pid] = (Number(out[pid]) || 0) + (Number(counts[key]) || 0);
        });
        return out;
    }

    /** Day totals inside a range, keyed ``YYYY-MM-DD``. */
    static range_day_plays(days) {
        const counts = PlaylistPlayLog.day_plays();
        const wanted = PlaylistPlayLog.range_days(days);
        const out = {};
        wanted.forEach((stamp) => {
            if (counts[stamp]) out[stamp] = Number(counts[stamp]) || 0;
        });
        return out;
    }

    /** Plays in the last seven days, today included. */
    static week_plays() {
        const days = PlaylistPlayLog.day_plays();
        let total = 0;
        for (let i = 0; i < 7; i++) total += Number(days[PlaylistPlayLog.day(i)]) || 0;
        return total;
    }

    static local_snapshot() {
        return {
            track_plays: PlaylistPlayLog.track_plays(),
            playlist_plays: PlaylistPlayLog.playlist_plays(),
            day_plays: PlaylistPlayLog.day_plays(),
            track_day_plays: PlaylistPlayLog.track_day_plays(),
        };
    }

    static has_counts(row) {
        if (!row || typeof row !== 'object') return false;
        return COUNTER_FIELDS.some((field) => {
            const counts = row[field];
            return counts && typeof counts === 'object' && Object.keys(counts).length > 0;
        });
    }

    /** Send one play to the account. Guests are ignored by the server. */
    static push(playlist_id, track_id) {
        if (typeof fetch !== 'function') return;
        try {
            fetch('/api/play-log', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playlist_id, track_id }),
                keepalive: true,
            }).catch(() => {});
        } catch (e) {}
    }

    /**
     * Mirror the account counters into localStorage.
     *
     * The first authenticated sync on a device merges its local history into
     * the account, so plays made before this feature shipped are kept. After
     * that the server wins. Returns true when the account answered.
     */
    static async sync() {
        if (typeof fetch !== 'function') return false;
        try {
            const first = await fetch('/api/play-log', { credentials: 'same-origin' });
            if (!first.ok) return false;
            const state = await first.json();
            if (!state || !state.authenticated) return false;

            const snapshot = PlaylistPlayLog.local_snapshot();
            const seeded = PlaylistPlayLog.is_synced();
            if (!seeded && PlaylistPlayLog.has_counts(snapshot)) {
                await fetch('/api/play-log/seed', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(snapshot),
                });
            }

            const response = await fetch('/api/play-log', { credentials: 'same-origin' });
            if (!response.ok) return false;
            const server = await response.json();
            if (!server || !server.authenticated) return false;
            PlaylistPlayLog.write(TRACKS_KEY, server.track_plays || {});
            PlaylistPlayLog.write(PLAYLISTS_KEY, server.playlist_plays || {});
            PlaylistPlayLog.write(DAYS_KEY, server.day_plays || {});
            PlaylistPlayLog.write(TRACK_DAYS_KEY, server.track_day_plays || {});
            PlaylistPlayLog.mark_synced();
            return true;
        } catch (e) {
            return false;
        }
    }

    static is_synced() {
        try {
            return localStorage.getItem(SYNCED_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    static mark_synced() {
        try {
            localStorage.setItem(SYNCED_KEY, '1');
        } catch (e) {}
    }
}
