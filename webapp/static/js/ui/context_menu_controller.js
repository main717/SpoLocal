/**
 * Controller for the playlist context menu (right-click).
 * Responsibilities:
 * - Build and show context menu for tracks and playlists
 * - Handle context menu actions (add to queue, download, delete, etc.)
 * - Manage menu positioning and auto-close behavior
 */
export class PlaylistContextMenuController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('../player/queue_controller.js').PlaylistQueueController|null} */
        this.queue = null;
        /** @type {import('./edit_modal_controller.js').PlaylistEditModalController|null} */
        this.editModal = null;
        /** @type {import('../player/transport_controller.js').PlaylistTransportController|null} */
        this.transport = null;
        /** @type {import('./track_info_controller.js').TrackInfoController|null} */
        this.trackInfo = null;
        /** @type {import('./track_edit_controller.js').TrackEditController|null} */
        this.trackEdit = null;
        /** @type {import('../services/download_controller.js').PlaylistDownloadController|null} */
        this.download = null;
        /** @type {import('../player/song_mix_controller.js').SongMixController|null} */
        this.songMix = null;
    }

    /** Set cross-controller references after all controllers are created. */
    setCrossRefs(queue, editModal, transport, trackInfo, download, trackEdit, songMix) {
        this.queue = queue;
        this.editModal = editModal;
        this.transport = transport;
        this.trackInfo = trackInfo;
        this.download = download;
        this.trackEdit = trackEdit;
        this.songMix = songMix;
    }

    /** Wire up context menu event listeners. */
    init() {
        const hub = this.state.hub;
        if (!hub) return;

        document.addEventListener('contextmenu', (e) => this.handleContextMenu(e), true);
        document.addEventListener('click', (e) => {
            if (hub.contextMenuEl && !hub.contextMenuEl.classList.contains('hidden') && hub.contextMenuEl.contains(e.target)) return;
            this.closeContextMenu();
        });
        document.addEventListener('scroll', () => this.closeContextMenu(), true);
        window.addEventListener('resize', () => this.closeContextMenu());
        window.addEventListener('blur', () => this.closeContextMenu());

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!hub.contextMenuEl || hub.contextMenuEl.classList.contains('hidden')) return;
            e.preventDefault();
            e.stopPropagation();
            this.closeContextMenu();
        }, true);
    }

    closeContextMenu() {
        const hub = this.state.hub;
        if (hub.contextMenuEl) {
            hub.contextMenuEl.classList.add('hidden');
            hub.contextMenuEl.setAttribute('aria-hidden', 'true');
        }
        if (hub.contextMenuItemsEl) hub.contextMenuItemsEl.innerHTML = '';
    }

    clampContextMenuPos(left, top, width, height) {
        const pad = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let l = left;
        let t = top;
        if (l + width > vw - pad) l = Math.max(pad, vw - width - pad);
        if (t + height > vh - pad) t = Math.max(pad, vh - height - pad);
        if (l < pad) l = pad;
        if (t < pad) t = pad;
        return { l: l, t: t };
    }

    trackHasSourceUrl(url, ytid) {
        const u = (url || '').trim();
        if (ytid && String(ytid).trim()) return true;
        if (!u) return false;
        return /spotify\.com|youtube\.com|youtu\.be|spotify:/i.test(u);
    }

    trackDownloadMenuSpec(status, playSrc, url, ytid) {
        if (status === 'downloading') return null;
        if (status === 'done' && this.trackHasSourceUrl(url, ytid)) {
            return { label: 'Re-download', redownload: true };
        }
        if (status === 'queued') return { label: 'Download again', redownload: false };
        if (status === 'pending') return { label: 'Download', redownload: false };
        if (status === 'error') return { label: 'Download again', redownload: false };
        return null;
    }

    buildHitFromLibraryTrack(trackId) {
        const hub = this.state.hub;
        const tid = (trackId || '').trim();
        if (!tid) return null;
        if (hub.lastPlayedTrackSnapshot && hub.lastPlayedTrackSnapshot.id === tid) {
            const snap = hub.lastPlayedTrackSnapshot;
            let url = (snap.url || '').trim();
            const ytid = (snap.youtube_video_id || '').trim();
            if (!url && ytid) {
                url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(ytid);
            }
            return {
                title: snap.title || '',
                artist: snap.artist || '',
                channel: snap.artist || '',
                url: url,
                album: snap.album || '',
            };
        }
        let t = hub.tracks.find(function (x) { return x.id === tid; });
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find(function (x) { return x.id === tid; });
        }
        let title = '';
        let artist = '';
        let album = '';
        let url = '';
        let ytid = '';
        if (t) {
            title = t.title || '';
            artist = t.artist || '';
            album = t.album != null ? String(t.album) : '';
            url = (t.url || '').trim();
            ytid = (t.youtube_video_id || '').trim();
        } else {
            const row = this.transport ? this.transport.rowForTrack(tid) : null;
            if (!row) return null;
            title = row.getAttribute('data-title') || '';
            artist = row.getAttribute('data-artist') || '';
            url = (row.getAttribute('data-track-url') || '').trim();
            ytid = (row.getAttribute('data-youtube-video-id') || '').trim();
        }
        if (!url && ytid) {
            url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(ytid);
        }
        if (!title && !artist && !url) return null;
        return {
            title: title,
            artist: artist,
            channel: artist,
            url: url,
            album: album,
        };
    }

    buildTrackMenuPayload(track_id, row_el) {
        const hub = this.state.hub;
        const tid = String(track_id || '').trim();
        if (!tid) return null;

        let t = hub.tracks.find(function (x) { return x.id === tid; });
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find(function (x) { return x.id === tid; });
        }

        const row = row_el || (this.transport ? this.transport.rowForTrack(tid) : null);
        const snap = hub.lastPlayedTrackSnapshot && hub.lastPlayedTrackSnapshot.id === tid
            ? hub.lastPlayedTrackSnapshot
            : null;

        let playlist_id = String(hub.playlistId || '').trim();
        if (row_el) {
            playlist_id = String(row_el.getAttribute('data-playlist-id') || hub.playlistId || '').trim();
        } else {
            playlist_id = String(hub.playingPlaylistId || '').trim();
            if (!playlist_id && snap) {
                playlist_id = String(snap.source_playlist_id || '').trim();
            }
            if (!playlist_id) playlist_id = String(hub.playlistId || '').trim();
        }

        const prefs = window.SpolocalQualityPrefs;
        let play_src = '';
        if (t && prefs) {
            play_src = prefs.resolvePlaySrc(t) || t.play_src || '';
        } else if (t) {
            play_src = t.play_src || '';
        } else if (row) {
            play_src = row.getAttribute('data-play-src') || '';
        } else if (hub.currentTrackId === tid && hub.audio) {
            play_src = (hub.audio.currentSrc || hub.audio.src || '').trim();
        }

        const url = (t && t.url ? String(t.url).trim() : '')
            || (row ? (row.getAttribute('data-track-url') || '').trim() : '')
            || (snap && snap.url ? String(snap.url).trim() : '');
        const ytid = (t && t.youtube_video_id ? String(t.youtube_video_id).trim() : '')
            || (row ? (row.getAttribute('data-youtube-video-id') || '').trim() : '')
            || (snap && snap.youtube_video_id ? String(snap.youtube_video_id).trim() : '');

        if (!play_src && !url && !ytid) return null;

        return {
            type: 'track',
            trackId: tid,
            playlistId: playlist_id,
            status: (t && t.status) || (row ? row.getAttribute('data-track-status') : '') || 'done',
            playSrc: play_src,
            url: url,
            ytid: ytid,
            title: (t && t.title) || (row ? row.getAttribute('data-title') : '') || (snap && snap.title) || '',
            artist: (t && t.artist) || (row ? row.getAttribute('data-artist') : '') || (snap && snap.artist) || '',
            album: (t && t.album != null ? String(t.album) : '') || (row ? row.getAttribute('data-album') : '') || (snap && snap.album ? String(snap.album) : '') || '',
            loudnessOffsetDb: t && t.loudness_offset_db != null ? Number(t.loudness_offset_db) : 0,
        };
    }

    promptLoudnessOffset(payload, scope) {
        const current = Number(payload.loudnessOffsetDb || 0);
        const label = scope === 'album'
            ? 'Loudness offset for this album in dB (-12 to +12)'
            : 'Loudness offset for this song in dB (-12 to +12)';
        const raw = prompt(label, String(current));
        if (raw === null) return;
        const value = Number(String(raw).replace(',', '.').replace(/^\+/, '').trim());
        if (!Number.isFinite(value) || value < -12 || value > 12) {
            alert('Enter a number between -12 and 12.');
            return;
        }
        this.saveLoudnessOffset(String(payload.playlistId || ''), String(payload.trackId || ''), value, scope);
    }

    saveLoudnessOffset(playlist_id, track_id, offset_db, scope) {
        fetch('/api/playlists/' + encodeURIComponent(playlist_id) + '/tracks/'
            + encodeURIComponent(track_id) + '/loudness-offset', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ offset_db: offset_db, scope: scope }),
        })
            .then((r) => {
                if (!r.ok) throw new Error('offset failed');
                return r.json();
            })
            .then((data) => this.applyLoudnessOffset(data))
            .catch(() => alert('Could not save the loudness offset.'));
    }

    applyLoudnessOffset(data) {
        const hub = this.state.hub;
        const ids = Array.isArray(data && data.updated) ? data.updated.map(String) : [];
        if (!ids.length) return;
        const offset = Number(data.offset_db) || 0;
        (hub.tracks || []).forEach((t) => {
            if (ids.indexOf(String(t.id)) !== -1) t.loudness_offset_db = offset;
        });
        // The playing track keeps its measured gain; only the offset changes.
        if (hub.currentTrackId && ids.indexOf(String(hub.currentTrackId)) !== -1
            && hub.audioNormalization && typeof hub.audioNormalization.set_track_offset_db === 'function') {
            hub.audioNormalization.set_track_offset_db(offset);
        }
    }

    openContextMenu(clientX, clientY, payload) {
        const hub = this.state.hub;
        if (!hub.contextMenuEl || !hub.contextMenuItemsEl) return;
        hub.contextMenuItemsEl.innerHTML = '';

        const mkBtn = (label, onClick, danger) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'w-full px-3 py-2 text-left text-sm text-white hover:bg-[#3E3E3E] focus:bg-[#3E3E3E] focus:outline-none';
            if (danger) b.classList.add('text-red-400');
            b.setAttribute('role', 'menuitem');
            b.textContent = label;
            b.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.closeContextMenu();
                onClick();
            });
            hub.contextMenuItemsEl.appendChild(b);
        };

        if (payload.type === 'track') {
            const playSrcTrim = (payload.playSrc || '').trim();
            if (playSrcTrim) {
                mkBtn('Add to queue', () => {
                    if (this.queue) {
                        this.queue.enqueue_manual_play_next({
                            source_playlist_id: String(payload.playlistId || hub.playlistId),
                            track_id: String(payload.trackId),
                            play_src: playSrcTrim,
                            title: payload.title || '',
                            artist: payload.artist || '',
                            album: payload.album || '',
                            youtube_video_id: (payload.ytid || '').trim(),
                            url: (payload.url || '').trim(),
                        });
                    }
                }, false);
            }
            const addHit = this.buildHitFromLibraryTrack(payload.trackId);
            if (addHit) {
                mkBtn('Add to playlist', () => {
                    if (typeof window.openAddToPlaylistAtPoint === 'function') {
                        window.openAddToPlaylistAtPoint(addHit, clientX, clientY);
                    }
                }, false);
            }
            if (payload.ytid || (payload.playlistId && payload.trackId)) {
                mkBtn('Go to mix', () => {
                    if (this.songMix) this.songMix.open_from_payload(payload);
                }, false);
            }
            const spec = this.trackDownloadMenuSpec(payload.status, payload.playSrc, payload.url, payload.ytid);
            if (spec) {
                mkBtn(spec.label, () => {
                    const f = document.createElement('form');
                    f.method = 'post';
                    f.action = '/playlists/' + encodeURIComponent(payload.playlistId) + '/tracks/' + encodeURIComponent(payload.trackId) + '/download';
                    if (spec.redownload) {
                        const inp = document.createElement('input');
                        inp.type = 'hidden';
                        inp.name = 'redownload';
                        inp.value = '1';
                        f.appendChild(inp);
                    }
                    document.body.appendChild(f);
                    f.submit();
                }, false);
            }
            if (playSrcTrim) {
                mkBtn('Save to computer', () => {
                    const a = document.createElement('a');
                    a.href = '/playlists/' + encodeURIComponent(payload.playlistId) + '/tracks/' + encodeURIComponent(payload.trackId) + '/file';
                    a.setAttribute('download', '');
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }, false);
            }
            mkBtn('Edit details', () => {
                if (this.trackEdit) {
                    this.trackEdit.open(
                        String(payload.playlistId),
                        String(payload.trackId),
                        payload.title || '',
                        payload.artist || '',
                        payload.album || '',
                    );
                }
            }, false);
            mkBtn('Song info', () => {
                if (this.trackInfo) {
                    this.trackInfo.open(String(payload.playlistId), String(payload.trackId));
                }
            }, false);
            if (payload.playlistId && payload.trackId) {
                mkBtn('Loudness offset...', () => {
                    this.promptLoudnessOffset(payload, 'track');
                }, false);
                if (payload.album) {
                    mkBtn('Album loudness offset...', () => {
                        this.promptLoudnessOffset(payload, 'album');
                    }, false);
                }
            }
            mkBtn('Delete', () => {
                if (!confirm('Remove this song from the playlist? The audio file on disk will be deleted if present.')) return;
                const pid = String(payload.playlistId);
                const url = '/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(payload.trackId) + '/delete';
                fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-Spa-Request': '1' } })
                    .then((r) => {
                        if (r.ok && typeof window.refreshPlaylistView === 'function') {
                            return window.refreshPlaylistView(pid);
                        }
                        window.location.href = '/?playlist_id=' + encodeURIComponent(pid);
                    })
                    .catch(() => {
                        window.location.href = '/?playlist_id=' + encodeURIComponent(pid);
                    });
            }, true);
        } else if (payload.type === 'mix_hit') {
            const hit = {
                video_id: payload.ytid,
                title: payload.title || '',
                artist: payload.artist || '',
                channel: payload.artist || '',
                url: payload.url || '',
            };
            mkBtn('Add to playlist', () => {
                if (typeof window.openAddToPlaylistAtPoint === 'function') {
                    window.openAddToPlaylistAtPoint(hit, clientX, clientY);
                }
            }, false);
            if (payload.ytid && !hub.songMixView) {
                mkBtn('Go to mix', () => {
                    if (this.songMix) this.songMix.open_from_payload(payload);
                }, false);
            }
        } else if (payload.type === 'playlist') {
            mkBtn('Edit playlist', () => {
                const pid = payload.playlistId;
                let name = payload.playlistName || '';
                let bio = '';
                try {
                    const catalog = Array.isArray(window.__playlistsCatalog) ? window.__playlistsCatalog : [];
                    const row = Array.isArray(catalog) ? catalog.find(function (p) { return p.id === pid; }) : null;
                    if (row) {
                        name = row.name || name;
                        bio = row.bio != null ? String(row.bio) : '';
                    }
                } catch (err) {}
                if (this.editModal) {
                    this.editModal.openPlaylistEditModal({ id: pid, name: name, bio: bio });
                }
            }, false);
            const quality_labels = { '64': 'Data Saver', '192': 'Highest' };
            ['64', '192'].forEach((q) => {
                mkBtn('Download all at ' + quality_labels[q], () => {
                    const n = payload.playlistName || 'this playlist';
                    if (!confirm('Queue download of all tracks in "' + n + '" at ' + quality_labels[q] + '?')) return;
                    if (this.download) {
                        this.download.queueQualityDownloads(payload.playlistId, q);
                    } else {
                        fetch('/api/playlists/' + encodeURIComponent(payload.playlistId) + '/downloads/quality', {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: {
                                'Accept': 'application/json',
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ quality: q }),
                        }).catch(() => {});
                    }
                }, false);
            });
            mkBtn('Save to computer (ZIP)', () => {
                const a = document.createElement('a');
                a.href = '/playlists/' + encodeURIComponent(payload.playlistId) + '/export.zip';
                a.setAttribute('download', '');
                document.body.appendChild(a);
                a.click();
                a.remove();
            }, false);
            mkBtn('Create share link', () => {
                fetch('/api/playlists/' + encodeURIComponent(payload.playlistId) + '/share', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' },
                })
                    .then((r) => {
                        if (!r.ok) throw new Error('share failed');
                        return r.json();
                    })
                    .then((data) => {
                        const url = location.origin + (data.url || '/share/' + data.token);
                        const fallback = () => prompt('Share link', url);
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(url).catch(fallback);
                        } else {
                            fallback();
                        }
                    })
                    .catch(() => alert('Could not create a share link.'));
            }, false);
            mkBtn('Delete playlist', () => {
                const n = payload.playlistName || 'this playlist';
                if (!confirm('Delete playlist "' + n + '"? Files on disk are not removed.')) return;
                const f = document.createElement('form');
                f.method = 'post';
                f.action = '/playlists/' + encodeURIComponent(payload.playlistId) + '/delete';
                document.body.appendChild(f);
                f.submit();
            }, true);
        }

        hub.contextMenuEl.classList.remove('hidden');
        hub.contextMenuEl.setAttribute('aria-hidden', 'false');
        hub.contextMenuEl.style.visibility = 'hidden';
        hub.contextMenuEl.style.left = '0px';
        hub.contextMenuEl.style.top = '0px';
        const rect = hub.contextMenuEl.getBoundingClientRect();
        const w = rect.width || hub.contextMenuEl.offsetWidth;
        const h = rect.height || hub.contextMenuEl.offsetHeight;
        const pos = this.clampContextMenuPos(clientX, clientY, w, h);
        hub.contextMenuEl.style.left = pos.l + 'px';
        hub.contextMenuEl.style.top = pos.t + 'px';
        hub.contextMenuEl.style.visibility = '';
    }

    handleContextMenu(e) {
        const hub = this.state.hub;
        const player_meta = e.target.closest && e.target.closest('#player-title, #player-subtitle, #player-cover-wrap');
        if (player_meta && hub.currentTrackId) {
            const payload = this.buildTrackMenuPayload(hub.currentTrackId);
            if (payload) {
                e.preventDefault();
                e.stopPropagation();
                this.openContextMenu(e.clientX, e.clientY, payload);
                return;
            }
        }
        const trackRow = e.target.closest('tr.track-row');
        if (trackRow) {
            const tid = trackRow.getAttribute('data-track-id');
            if (tid) {
                const payload = this.buildTrackMenuPayload(tid, trackRow);
                if (!payload) return;
                e.preventDefault();
                e.stopPropagation();
                this.openContextMenu(e.clientX, e.clientY, payload);
                return;
            }
            const vid = (trackRow.getAttribute('data-youtube-video-id') || '').trim();
            if (vid.length === 11) {
                e.preventDefault();
                e.stopPropagation();
                this.openContextMenu(e.clientX, e.clientY, {
                    type: 'mix_hit',
                    ytid: vid,
                    title: trackRow.getAttribute('data-title') || '',
                    artist: trackRow.getAttribute('data-artist') || '',
                    playlistId: String(hub.playlistId || ''),
                    trackId: '',
                    playSrc: '',
                    url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(vid),
                    status: '',
                    album: '',
                });
            }
            return;
        }
        const plCard = e.target.closest('.playlist-card');
        if (plCard) {
            e.preventDefault();
            let pid = plCard.getAttribute('data-playlist-id');
            const pname = plCard.getAttribute('data-playlist-name') || '';
            if (!pid) {
                const a = plCard.querySelector('a.playlist-spa-nav');
                if (a) {
                    try {
                        const u = new URL(a.getAttribute('href'), location.origin);
                        pid = u.searchParams.get('playlist_id') || '';
                    } catch (x) {}
                }
            }
            if (!pid) return;
            this.openContextMenu(e.clientX, e.clientY, {
                type: 'playlist',
                playlistId: pid,
                playlistName: pname,
            });
        }
    }

}
