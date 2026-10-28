/**
 * Settings modal: playback and download quality tiers (64 / 120 / 192 kbps).
 */
import { home_range, set_home_range } from './home_prefs.js?v=1';
export class SettingsController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        this.state = state;
        /** @type {import('../player/transport_controller.js').PlaylistTransportController|null} */
        this.transport = null;
        /** @type {import('../services/download_controller.js').PlaylistDownloadController|null} */
        this.download = null;
        this._workers_timer = null;
        this._workers_hardware = null;
    }

    setCrossRefs(transport, download) {
        this.transport = transport;
        this.download = download;
    }

    init() {
        const hub = this.state.hub;
        hub.settingsModal = document.getElementById('settings-modal');
        hub.settingsBackdrop = document.getElementById('settings-modal-backdrop');
        hub.settingsClose = document.getElementById('settings-close');
        hub.settingsOpenBtn = document.getElementById('open-settings');
        hub.settingsPlaybackTiers = document.getElementById('settings-playback-tiers');
        hub.settingsPlaybackValue = document.getElementById('settings-playback-kbps-value');
        hub.settingsDownloadTiers = document.getElementById('settings-download-tiers');
        hub.settingsDownloadValue = document.getElementById('settings-download-kbps-value');
        hub.settingsLibraryDownloadTiers = document.getElementById('settings-library-download-tiers');
        hub.settingsNormalizeLoudness = document.getElementById('settings-normalize-loudness');
        hub.settingsRate = document.getElementById('settings-rate');
        hub.settingsRateReset = document.getElementById('settings-rate-reset');
        hub.btnRate = document.getElementById('player-rate');
        hub.settingsReloadLibrary = document.getElementById('settings-reload-library');
        hub.settingsWorkers = document.getElementById('settings-workers');
        hub.settingsWorkersValue = document.getElementById('settings-workers-value');
        hub.settingsWorkersReset = document.getElementById('settings-workers-reset');
        hub.settingsWorkersWarning = document.getElementById('settings-workers-warning');
        hub.settingsHomeRange = document.getElementById('settings-home-range');

        if (hub.settingsOpenBtn) {
            hub.settingsOpenBtn.addEventListener('click', () => this.open());
        }
        if (hub.settingsBackdrop) {
            hub.settingsBackdrop.addEventListener('click', () => this.close());
        }
        if (hub.settingsClose) {
            hub.settingsClose.addEventListener('click', () => this.close());
        }

        const prefs = window.SpolocalQualityPrefs;
        const self = this;
        if (prefs && hub.settingsPlaybackTiers) {
            prefs.bindTierGroup(
                hub.settingsPlaybackTiers,
                () => prefs.playbackKbps(),
                (v) => prefs.setPlaybackKbps(v),
                () => {
                    self._update_labels();
                    if (self.transport) self.transport.quality.onPlaybackQualityChanged();
                },
            );
        }
        if (prefs && hub.settingsDownloadTiers) {
            prefs.bindTierGroup(
                hub.settingsDownloadTiers,
                () => prefs.downloadKbps(),
                (v) => prefs.setDownloadKbps(v),
                () => self._update_labels(),
            );
        }
        if (prefs && hub.settingsLibraryDownloadTiers) {
            const quality_labels = { 64: 'Data Saver', 192: 'Highest' };
            hub.settingsLibraryDownloadTiers.querySelectorAll('.quality-tier-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const kbps = prefs.clampKbps(btn.getAttribute('data-kbps'));
                    const label = quality_labels[kbps] || prefs.formatLabel(kbps);
                    if (!confirm('Queue download of all tracks in every playlist at ' + label + '?')) return;
                    if (self.download) {
                        self.download.queueQualityDownloads(null, kbps);
                    } else {
                        fetch('/api/downloads/quality-all', {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: {
                                'Accept': 'application/json',
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ quality: String(kbps) }),
                        }).catch(() => {});
                    }
                });
            });
        }

        if (hub.settingsReloadLibrary) {
            hub.settingsReloadLibrary.addEventListener('click', () => this.reload_library());
        }

        if (hub.settingsHomeRange) {
            hub.settingsHomeRange.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-range]');
                if (!btn) return;
                set_home_range(btn.dataset.range);
                this.sync_home_range();
                if (typeof window.refreshHomeView === 'function') window.refreshHomeView();
            });
        }

        if (hub.settingsWorkers) {
            hub.settingsWorkers.addEventListener('input', () => {
                this._apply_worker_count(hub.settingsWorkers.value);
                this._schedule_worker_save();
            });
            hub.settingsWorkers.addEventListener('change', () => {
                clearTimeout(this._workers_timer);
                this.save_worker_count();
            });
        }
        if (hub.settingsWorkersReset) {
            hub.settingsWorkersReset.addEventListener('click', () => {
                this._apply_worker_count(2);
                this.save_worker_count();
            });
        }

        if (hub.settingsRate) {
            hub.settingsRate.addEventListener('input', () => {
                if (self.transport) self.transport.set_playback_rate(hub.settingsRate.value);
            });
        }
        if (hub.settingsRateReset) {
            hub.settingsRateReset.addEventListener('click', () => {
                if (self.transport) self.transport.set_playback_rate(1);
            });
        }
        if (hub.btnRate) {
            hub.btnRate.addEventListener('click', () => self.open());
        }

        const norm_prefs = window.SpolocalNormalizationPrefs;
        if (norm_prefs && hub.settingsNormalizeLoudness) {
            hub.settingsNormalizeLoudness.addEventListener('change', () => {
                norm_prefs.setEnabled(hub.settingsNormalizeLoudness.checked);
                const norm = hub.audioNormalization;
                if (norm) norm.set_enabled(hub.settingsNormalizeLoudness.checked);
            });
        }

        this.sync_ui();
    }

    open() {
        const hub = this.state.hub;
        if (!hub.settingsModal) return;
        this.sync_ui();
        if (hub.settingsWorkers) this.load_worker_count();
        hub.settingsModal.classList.remove('hidden');
    }

    close() {
        const hub = this.state.hub;
        if (!hub.settingsModal) return;
        hub.settingsModal.classList.add('hidden');
    }

    sync_ui() {
        const prefs = window.SpolocalQualityPrefs;
        this.sync_home_range();
        if (!prefs) return;
        const hub = this.state.hub;
        prefs.syncTierGroup(hub.settingsPlaybackTiers, prefs.playbackKbps());
        prefs.syncTierGroup(hub.settingsDownloadTiers, prefs.downloadKbps());
        if (this.transport && typeof this.transport.update_playback_rate_ui === 'function') {
            this.transport.update_playback_rate_ui();
        }
        this._update_labels();
    }

    /** Mirror the chosen default home range into the settings tier buttons. */
    sync_home_range() {
        const group = this.state.hub.settingsHomeRange;
        if (!group) return;
        const key = home_range();
        group.querySelectorAll('[data-range]').forEach((btn) => {
            const on = btn.dataset.range === key;
            btn.classList.toggle('quality-tier-btn--active', on);
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    _update_labels() {
        const prefs = window.SpolocalQualityPrefs;
        if (!prefs) return;
        const hub = this.state.hub;
        if (hub.settingsPlaybackValue) {
            hub.settingsPlaybackValue.textContent = prefs.formatLabel(prefs.playbackKbps());
        }
        if (hub.settingsDownloadValue) {
            hub.settingsDownloadValue.textContent = prefs.formatLabel(prefs.downloadKbps());
        }
        const norm_prefs = window.SpolocalNormalizationPrefs;
        if (norm_prefs && hub.settingsNormalizeLoudness) {
            hub.settingsNormalizeLoudness.checked = norm_prefs.enabled();
        }
    }

    _clamp_workers(value) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return 2;
        return Math.min(8, Math.max(1, n));
    }

    _apply_worker_count(value) {
        const hub = this.state.hub;
        const n = this._clamp_workers(value);
        if (hub.settingsWorkers) hub.settingsWorkers.value = String(n);
        if (hub.settingsWorkersValue) hub.settingsWorkersValue.textContent = String(n);
        this._update_worker_warning();
    }

    /** Warn when the chosen count is above what the server's hardware handles well. */
    _update_worker_warning() {
        const hub = this.state.hub;
        const el = hub.settingsWorkersWarning;
        if (!el) return;
        const hw = this._workers_hardware;
        const n = this._clamp_workers(hub.settingsWorkers ? hub.settingsWorkers.value : 0);
        if (!hw || !hw.recommended_max || n <= hw.recommended_max) {
            el.textContent = '';
            el.classList.add('hidden');
            return;
        }
        const cores = hw.cpu_cores || 1;
        const gb = hw.memory_bytes ? (hw.memory_bytes / 1073741824).toFixed(1) : '';
        const spec = gb ? cores + ' cores, ' + gb + ' GB RAM' : cores + ' cores';
        el.textContent = n + ' at once will compete with playback on this box (' + spec + '). '
            + hw.recommended_max + ' or fewer is safer.';
        el.classList.remove('hidden');
    }

    _schedule_worker_save() {
        clearTimeout(this._workers_timer);
        this._workers_timer = setTimeout(() => this.save_worker_count(), 300);
    }

    /** Read the server-side concurrency cap, which is not per-device. */
    async load_worker_count() {
        const hub = this.state.hub;
        if (!hub.settingsWorkers) return;
        try {
            const r = await fetch('/api/settings/download-workers', { credentials: 'same-origin' });
            if (!r.ok) return;
            const data = await r.json();
            this._workers_hardware = data.hardware || null;
            this._apply_worker_count(data.workers);
        } catch (e) {
            /* keep the slider as-is */
        }
    }

    async save_worker_count() {
        const hub = this.state.hub;
        if (!hub.settingsWorkers) return;
        const n = this._clamp_workers(hub.settingsWorkers.value);
        this._apply_worker_count(n);
        try {
            const r = await fetch('/api/settings/download-workers', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ workers: n }),
            });
            if (!r.ok) return;
            const data = await r.json();
            this._apply_worker_count(data.workers);
        } catch (e) {
            /* the slider keeps the chosen value; the next open re-reads the server */
        }
    }

    /** Re-download every song at both tiers and delete all other formats. */
    async reload_library() {
        if (!confirm('Re-download every song in Data Saver and Highest, and delete all other formats? This can take a while.')) return;
        try {
            const r = await fetch('/api/downloads/reload', {
                method: 'POST',
                credentials: 'same-origin',
            });
            if (!r.ok) {
                alert('Could not start the reload.');
                return;
            }
            const data = await r.json();
            const queued = Number(data.queued) || 0;
            const skipped = Number(data.skipped) || 0;
            const parts = ['Queued ' + queued + ' song' + (queued === 1 ? '' : 's') + ' at both qualities.'];
            if (skipped) parts.push(skipped + ' skipped (no URL/title).');
            const idle = document.getElementById('dl-idle-msg');
            if (idle) {
                idle.textContent = parts.join(' ');
                idle.classList.remove('hidden');
            }
            if (this.download) this.download.watch_downloads();
            this.close();
        } catch (e) {
            alert('Could not start the reload.');
        }
    }
}
