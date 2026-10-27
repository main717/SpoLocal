/**
 * Settings modal: playback and download quality tiers (64 / 120 / 192 kbps).
 */
export class SettingsController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        this.state = state;
        /** @type {import('../player/transport_controller.js').PlaylistTransportController|null} */
        this.transport = null;
        /** @type {import('../services/download_controller.js').PlaylistDownloadController|null} */
        this.download = null;
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
        hub.settingsModal.classList.remove('hidden');
    }

    close() {
        const hub = this.state.hub;
        if (!hub.settingsModal) return;
        hub.settingsModal.classList.add('hidden');
    }

    sync_ui() {
        const prefs = window.SpolocalQualityPrefs;
        if (!prefs) return;
        const hub = this.state.hub;
        prefs.syncTierGroup(hub.settingsPlaybackTiers, prefs.playbackKbps());
        prefs.syncTierGroup(hub.settingsDownloadTiers, prefs.downloadKbps());
        if (this.transport && typeof this.transport.update_playback_rate_ui === 'function') {
            this.transport.update_playback_rate_ui();
        }
        this._update_labels();
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
