/**
 * Modal showing per-song metadata (status, dates, file variants).
 */
export class TrackInfoController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        this.state = state;
    }

    init() {
        const hub = this.state.hub;
        hub.trackInfoModal = document.getElementById('track-info-modal');
        hub.trackInfoBackdrop = document.getElementById('track-info-modal-backdrop');
        hub.trackInfoClose = document.getElementById('track-info-close');
        hub.trackInfoBody = document.getElementById('track-info-body');
        hub.trackInfoError = document.getElementById('track-info-error');

        if (hub.trackInfoBackdrop) {
            hub.trackInfoBackdrop.addEventListener('click', () => this.close());
        }
        if (hub.trackInfoClose) {
            hub.trackInfoClose.addEventListener('click', () => this.close());
        }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!hub.trackInfoModal || hub.trackInfoModal.classList.contains('hidden')) return;
            e.preventDefault();
            this.close();
        });
    }

    async open(playlist_id, track_id) {
        const hub = this.state.hub;
        if (!hub.trackInfoModal || !hub.trackInfoBody) return;
        this._clear_error();
        hub.trackInfoBody.innerHTML = '<p class="text-[#727272]">Loading…</p>';
        hub.trackInfoModal.classList.remove('hidden');
        try {
            const url = '/api/playlists/' + encodeURIComponent(playlist_id) + '/tracks/' + encodeURIComponent(track_id) + '/info';
            const resp = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!resp.ok) {
                const detail = resp.status === 404 ? 'Track not found.' : 'Could not load song info.';
                throw new Error(detail);
            }
            const data = await resp.json();
            this._render(data, track_id);
        } catch (err) {
            this._show_error(err && err.message ? err.message : 'Could not load song info.');
            hub.trackInfoBody.innerHTML = '';
        }
    }

    close() {
        const hub = this.state.hub;
        if (!hub.trackInfoModal) return;
        hub.trackInfoModal.classList.add('hidden');
        if (hub.trackInfoBody) hub.trackInfoBody.innerHTML = '';
        this._clear_error();
    }

    _clear_error() {
        const hub = this.state.hub;
        if (!hub.trackInfoError) return;
        hub.trackInfoError.textContent = '';
        hub.trackInfoError.classList.add('hidden');
    }

    _show_error(msg) {
        const hub = this.state.hub;
        if (!hub.trackInfoError) return;
        hub.trackInfoError.textContent = msg;
        hub.trackInfoError.classList.remove('hidden');
    }

    _normalize_media_path(src) {
        if (!src) return '';
        try {
            const u = new URL(src, location.origin);
            let path = decodeURIComponent(u.pathname);
            if (path.startsWith('/media/')) path = path.slice('/media/'.length);
            return path;
        } catch (x) {
            return '';
        }
    }

    _active_file_for_track(track_id, files) {
        const hub = this.state.hub;
        if (!hub || String(hub.currentTrackId || '') !== String(track_id || '')) return null;
        const src = (hub.audio && (hub.audio.currentSrc || hub.audio.src) || '').trim();
        if (!src) return null;

        const playing_path = this._normalize_media_path(src);
        if (playing_path && Array.isArray(files)) {
            for (const f of files) {
                if (f.relpath && f.relpath === playing_path) return f;
            }
        }

        const prefs = window.SpolocalQualityPrefs;
        let track = hub.tracks && hub.tracks.find((t) => t.id === track_id);
        if (!track && hub.playingTracks) {
            track = hub.playingTracks.find((t) => t.id === track_id);
        }
        if (track && track.play_variants && prefs) {
            const exact_src = prefs.resolveExactPlaySrc(track, prefs.playbackKbps());
            const exact_path = this._normalize_media_path(exact_src);
            if (exact_path && Array.isArray(files)) {
                for (const f of files) {
                    if (f.relpath === exact_path) return f;
                }
            }
            for (const f of files) {
                const variant_src = track.play_variants[String(f.kbps)];
                if (variant_src && this._normalize_media_path(variant_src) === playing_path) return f;
            }
        }
        return null;
    }

    _tier_label(kbps) {
        const prefs = window.SpolocalQualityPrefs;
        if (prefs) return prefs.formatLabel(kbps);
        return String(kbps) + ' kbps';
    }

    _render(data, track_id) {
        const hub = this.state.hub;
        if (!hub.trackInfoBody) return;
        const heading = document.getElementById('track-info-heading');
        if (heading) {
            heading.textContent = data.title || 'Song info';
        }
        const rows = [
            ['Artist', data.artist || '—'],
            ['Album', data.album || '—'],
            ['Status', this._format_status(data.status)],
            ['Added', this._format_date(data.added_at)],
        ];
        if (data.error) {
            rows.push(['Error', data.error]);
        }
        const files = Array.isArray(data.files) ? data.files : [];
        const active = this._active_file_for_track(track_id, files);
        if (active) {
            rows.unshift(['Now playing', this._tier_label(active.kbps)]);
        } else if (this.state.hub.currentTrackId === track_id && this.state.hub.audio) {
            const src = (this.state.hub.audio.currentSrc || this.state.hub.audio.src || '').trim();
            if (src) {
                const prefs = window.SpolocalQualityPrefs;
                const q = prefs ? prefs.playbackKbps() : null;
                rows.unshift(['Now playing', q ? this._tier_label(q) + ' (selected)' : 'Stream']);
            }
        }
        let html = '<dl class="space-y-2">';
        for (const [label, value] of rows) {
            html += '<div class="flex gap-3"><dt class="w-24 shrink-0 text-[#727272]">' + this._esc(label) + '</dt>';
            html += '<dd class="text-white min-w-0 break-words">' + this._esc(value) + '</dd></div>';
        }
        html += '</dl>';
        const playlists = Array.isArray(data.playlists) ? data.playlists : [];
        if (playlists.length) {
            html += '<div class="pt-2 border-t border-[#3E3E3E]"><h3 class="text-xs font-semibold text-[#B3B3B3] uppercase tracking-wider mb-2">In playlists</h3>';
            html += '<ul class="space-y-1">';
            for (const pl of playlists) {
                html += '<li class="flex items-center gap-2 min-w-0">';
                html += '<a class="text-white hover:text-[#1DB954] truncate" href="/?playlist_id=' + encodeURIComponent(pl.id || '') + '">' + this._esc(pl.name || 'Untitled') + '</a>';
                if (pl.current) {
                    html += '<span class="text-[10px] font-semibold uppercase tracking-wide text-[#1DB954] shrink-0">Current</span>';
                }
                html += '</li>';
            }
            html += '</ul></div>';
        }
        if (files.length) {
            html += '<div class="pt-2 border-t border-[#3E3E3E]"><h3 class="text-xs font-semibold text-[#B3B3B3] uppercase tracking-wider mb-2">Files on disk</h3>';
            html += '<div class="space-y-3">';
            for (const f of files) {
                const is_active = !!(active && active.relpath && f.relpath === active.relpath);
                html += '<div class="rounded-lg p-3 space-y-1.5 ' + (is_active ? 'bg-[#1DB954]/15 ring-1 ring-[#1DB954]' : 'bg-[#3E3E3E]/60') + '">';
                html += '<div class="flex items-center justify-between gap-2">';
                html += '<div class="font-semibold ' + (is_active ? 'text-[#1DB954]' : 'text-white') + '">' + this._esc(this._tier_label(f.kbps)) + '</div>';
                if (is_active) {
                    html += '<span class="text-[10px] font-semibold uppercase tracking-wide text-[#1DB954]">Playing</span>';
                }
                html += '</div>';
                html += this._file_row('Downloaded', this._format_date(f.downloaded_at));
                html += this._file_row('Size', this._format_bytes(f.size_bytes));
                html += this._file_row('Duration', this._format_duration(f.duration_sec));
                html += this._file_row('Bitrate', f.bitrate_kbps != null ? f.bitrate_kbps + ' kbps' : '—');
                html += this._file_row('Format', f.format || '—');
                html += '</div>';
            }
            html += '</div></div>';
        } else if (data.status === 'done') {
            html += '<p class="text-[#727272] text-xs pt-2">No audio files found on disk.</p>';
        }
        hub.trackInfoBody.innerHTML = html;
    }

    _file_row(label, value) {
        return '<div class="flex gap-3 text-xs"><span class="w-20 shrink-0 text-[#727272]">' + this._esc(label) + '</span>'
            + '<span class="text-[#B3B3B3]">' + this._esc(value) + '</span></div>';
    }

    _esc(text) {
        const d = document.createElement('div');
        d.textContent = text == null ? '' : String(text);
        return d.innerHTML;
    }

    _format_status(status) {
        const s = (status || '').toLowerCase();
        if (s === 'done') return 'Downloaded';
        if (s === 'downloading') return 'Downloading';
        if (s === 'queued') return 'Queued';
        if (s === 'pending') return 'Pending';
        if (s === 'error') return 'Error';
        return status || '—';
    }

    _format_date(iso) {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        } catch (x) {
            return iso;
        }
    }

    _format_bytes(n) {
        if (n == null || Number.isNaN(Number(n))) return '—';
        const b = Number(n);
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        return (b / (1024 * 1024)).toFixed(2) + ' MB';
    }

    _format_duration(sec) {
        if (sec == null || Number.isNaN(Number(sec))) return '—';
        const total = Math.round(Number(sec));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return m + ':' + String(s).padStart(2, '0');
    }
}
