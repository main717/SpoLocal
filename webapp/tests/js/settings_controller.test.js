import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_quality_prefs.js';
import '../../static/js/audio_normalization_prefs.js';
import { SettingsController } from '../../static/js/ui/settings_controller.js';

const prefs = window.SpolocalQualityPrefs;
const norm_prefs = window.SpolocalNormalizationPrefs;

function mount_settings_dom() {
    document.body.innerHTML = `
        <button id="open-settings"></button>
        <div id="settings-modal" class="hidden">
            <div id="settings-modal-backdrop"></div>
            <button id="settings-close"></button>
            <div id="settings-playback-tiers">
                <button class="quality-tier-btn" data-kbps="64"></button>
                <button class="quality-tier-btn" data-kbps="192"></button>
            </div>
            <span id="settings-playback-kbps-value"></span>
            <div id="settings-download-tiers">
                <button class="quality-tier-btn" data-kbps="64"></button>
                <button class="quality-tier-btn" data-kbps="192"></button>
            </div>
            <span id="settings-download-kbps-value"></span>
            <div id="settings-library-download-tiers">
                <button class="quality-tier-btn" data-kbps="64"></button>
                <button class="quality-tier-btn" data-kbps="192"></button>
            </div>
            <input type="checkbox" id="settings-normalize-loudness">
            <button id="settings-reload-library"></button>
        </div>
        <div id="dl-idle-msg" class="hidden"></div>
    `;
}

function make_controller(hub_overrides = {}) {
    const hub = { ...hub_overrides };
    const controller = new SettingsController({ hub });
    return { controller, hub };
}

function json_response(body, ok = true) {
    return { ok, json: async () => body };
}

function tier_button(group_id, kbps) {
    return document.querySelector('#' + group_id + ' [data-kbps="' + kbps + '"]');
}


beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    mount_settings_dom();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('constructor and cross refs', () => {
    it('stores the state and starts without cross refs', () => {
        const state = { hub: {} };
        const controller = new SettingsController(state);
        expect(controller.state).toBe(state);
        expect(controller.transport).toBe(null);
        expect(controller.download).toBe(null);
    });

    it('setCrossRefs stores transport and download', () => {
        const { controller } = make_controller();
        const transport = { quality: {} };
        const download = { queueQualityDownloads: vi.fn() };
        controller.setCrossRefs(transport, download);
        expect(controller.transport).toBe(transport);
        expect(controller.download).toBe(download);
    });
});

describe('init', () => {
    it('caches the modal elements on the hub', () => {
        const { controller, hub } = make_controller();
        controller.init();
        expect(hub.settingsModal).toBe(document.getElementById('settings-modal'));
        expect(hub.settingsBackdrop).toBe(document.getElementById('settings-modal-backdrop'));
        expect(hub.settingsClose).toBe(document.getElementById('settings-close'));
        expect(hub.settingsOpenBtn).toBe(document.getElementById('open-settings'));
        expect(hub.settingsPlaybackTiers).toBe(document.getElementById('settings-playback-tiers'));
        expect(hub.settingsPlaybackValue).toBe(document.getElementById('settings-playback-kbps-value'));
        expect(hub.settingsDownloadTiers).toBe(document.getElementById('settings-download-tiers'));
        expect(hub.settingsDownloadValue).toBe(document.getElementById('settings-download-kbps-value'));
        expect(hub.settingsLibraryDownloadTiers).toBe(document.getElementById('settings-library-download-tiers'));
        expect(hub.settingsNormalizeLoudness).toBe(document.getElementById('settings-normalize-loudness'));
        expect(hub.settingsReloadLibrary).toBe(document.getElementById('settings-reload-library'));
    });

    it('marks the stored tiers as active and labels them', () => {
        localStorage.setItem('spolocal_playback_kbps', '64');
        localStorage.setItem('spolocal_download_kbps', '192');
        const { controller, hub } = make_controller();
        controller.init();
        expect(tier_button('settings-playback-tiers', 64).classList.contains('quality-tier-btn--active')).toBe(true);
        expect(tier_button('settings-playback-tiers', 192).classList.contains('quality-tier-btn--active')).toBe(false);
        expect(tier_button('settings-download-tiers', 192).classList.contains('quality-tier-btn--active')).toBe(true);
        expect(hub.settingsPlaybackValue.textContent).toBe('Data Saver');
        expect(hub.settingsDownloadValue.textContent).toBe('Highest');
    });

    it('opens the modal from the open button', () => {
        const { controller, hub } = make_controller();
        controller.init();
        document.getElementById('open-settings').click();
        expect(hub.settingsModal.classList.contains('hidden')).toBe(false);
    });

    it('closes the modal from the backdrop and the close button', () => {
        const { controller, hub } = make_controller();
        controller.init();
        document.getElementById('open-settings').click();
        hub.settingsBackdrop.click();
        expect(hub.settingsModal.classList.contains('hidden')).toBe(true);
        document.getElementById('open-settings').click();
        hub.settingsClose.click();
        expect(hub.settingsModal.classList.contains('hidden')).toBe(true);
    });

    it('does not throw when the modal elements are missing', () => {
        document.body.innerHTML = '';
        const { controller } = make_controller();
        expect(() => controller.init()).not.toThrow();
        expect(() => controller.open()).not.toThrow();
        expect(() => controller.close()).not.toThrow();
    });

    it('does not throw without the quality prefs global', () => {
        delete window.SpolocalQualityPrefs;
        try {
            const { controller } = make_controller();
            expect(() => controller.init()).not.toThrow();
            expect(() => controller.sync_ui()).not.toThrow();
            expect(() => controller._update_labels()).not.toThrow();
        } finally {
            window.SpolocalQualityPrefs = prefs;
        }
    });
});

describe('playback tier', () => {
    it('persists the tier, updates the label and notifies the transport', () => {
        const { controller, hub } = make_controller();
        const transport = { quality: { onPlaybackQualityChanged: vi.fn() } };
        controller.setCrossRefs(transport, null);
        controller.init();
        tier_button('settings-playback-tiers', 64).click();
        expect(localStorage.getItem('spolocal_playback_kbps')).toBe('64');
        expect(hub.settingsPlaybackValue.textContent).toBe('Data Saver');
        expect(transport.quality.onPlaybackQualityChanged).toHaveBeenCalledTimes(1);
    });

    it('works without a transport', () => {
        const { controller, hub } = make_controller();
        controller.init();
        expect(() => tier_button('settings-playback-tiers', 64).click()).not.toThrow();
        expect(hub.settingsPlaybackValue.textContent).toBe('Data Saver');
    });
});

describe('download tier', () => {
    it('persists the tier and updates the label', () => {
        const { controller, hub } = make_controller();
        controller.init();
        tier_button('settings-download-tiers', 64).click();
        expect(localStorage.getItem('spolocal_download_kbps')).toBe('64');
        expect(hub.settingsDownloadValue.textContent).toBe('Data Saver');
    });
});

describe('library download tiers', () => {
    it('queues downloads through the download controller after confirmation', () => {
        const confirm_mock = vi.fn(() => true);
        vi.stubGlobal('confirm', confirm_mock);
        const { controller } = make_controller();
        const download = { queueQualityDownloads: vi.fn() };
        controller.setCrossRefs(null, download);
        controller.init();
        tier_button('settings-library-download-tiers', 64).click();
        expect(confirm_mock).toHaveBeenCalledWith(
            'Queue download of all tracks in every playlist at Data Saver?',
        );
        expect(download.queueQualityDownloads).toHaveBeenCalledWith(null, 64);
    });

    it('falls back to the API when there is no download controller', () => {
        vi.stubGlobal('confirm', vi.fn(() => true));
        const fetch_mock = vi.fn(async () => json_response({}));
        vi.stubGlobal('fetch', fetch_mock);
        const { controller } = make_controller();
        controller.init();
        tier_button('settings-library-download-tiers', 192).click();
        expect(fetch_mock).toHaveBeenCalledTimes(1);
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/downloads/quality-all');
        expect(options.method).toBe('POST');
        expect(options.body).toBe('{"quality":"192"}');
    });

    it('does nothing when the confirmation is declined', () => {
        vi.stubGlobal('confirm', vi.fn(() => false));
        const fetch_mock = vi.fn(async () => json_response({}));
        vi.stubGlobal('fetch', fetch_mock);
        const { controller } = make_controller();
        const download = { queueQualityDownloads: vi.fn() };
        controller.setCrossRefs(null, download);
        controller.init();
        tier_button('settings-library-download-tiers', 64).click();
        expect(download.queueQualityDownloads).not.toHaveBeenCalled();
        expect(fetch_mock).not.toHaveBeenCalled();
    });
});

describe('reload library', () => {
    it('is wired to the reload button', () => {
        const { controller } = make_controller();
        const spy = vi.spyOn(controller, 'reload_library').mockResolvedValue();
        controller.init();
        document.getElementById('settings-reload-library').click();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('posts the reload and reports the queued count', async () => {
        vi.stubGlobal('confirm', vi.fn(() => true));
        const fetch_mock = vi.fn(async () => json_response({ queued: 2, skipped: 1 }));
        vi.stubGlobal('fetch', fetch_mock);
        const { controller, hub } = make_controller();
        const download = { watch_downloads: vi.fn() };
        controller.setCrossRefs(null, download);
        controller.init();
        hub.settingsModal.classList.remove('hidden');

        await controller.reload_library();

        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/downloads/reload');
        expect(options.method).toBe('POST');
        const idle = document.getElementById('dl-idle-msg');
        expect(idle.textContent).toBe('Queued 2 songs at both qualities. 1 skipped (no URL/title).');
        expect(idle.classList.contains('hidden')).toBe(false);
        expect(download.watch_downloads).toHaveBeenCalledTimes(1);
        expect(hub.settingsModal.classList.contains('hidden')).toBe(true);
    });

    it('uses the singular form for one song and omits skipped when zero', async () => {
        vi.stubGlobal('confirm', vi.fn(() => true));
        vi.stubGlobal('fetch', vi.fn(async () => json_response({ queued: 1, skipped: 0 })));
        const { controller } = make_controller();
        controller.init();
        await controller.reload_library();
        expect(document.getElementById('dl-idle-msg').textContent).toBe(
            'Queued 1 song at both qualities.',
        );
    });

    it('does nothing when the confirmation is declined', async () => {
        vi.stubGlobal('confirm', vi.fn(() => false));
        const fetch_mock = vi.fn(async () => json_response({}));
        vi.stubGlobal('fetch', fetch_mock);
        const { controller } = make_controller();
        controller.init();
        await controller.reload_library();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('alerts when the server refuses the reload', async () => {
        vi.stubGlobal('confirm', vi.fn(() => true));
        vi.stubGlobal('fetch', vi.fn(async () => json_response({}, false)));
        const alert_mock = vi.fn();
        vi.stubGlobal('alert', alert_mock);
        const { controller, hub } = make_controller();
        controller.init();
        hub.settingsModal.classList.remove('hidden');
        await controller.reload_library();
        expect(alert_mock).toHaveBeenCalledWith('Could not start the reload.');
        expect(hub.settingsModal.classList.contains('hidden')).toBe(false);
    });

    it('alerts on a network error', async () => {
        vi.stubGlobal('confirm', vi.fn(() => true));
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const alert_mock = vi.fn();
        vi.stubGlobal('alert', alert_mock);
        const { controller } = make_controller();
        controller.init();
        await controller.reload_library();
        expect(alert_mock).toHaveBeenCalledWith('Could not start the reload.');
    });

    it('works without the idle message element', async () => {
        vi.stubGlobal('confirm', vi.fn(() => true));
        vi.stubGlobal('fetch', vi.fn(async () => json_response({ queued: 1 })));
        document.getElementById('dl-idle-msg').remove();
        const { controller } = make_controller();
        controller.init();
        await expect(controller.reload_library()).resolves.toBeUndefined();
    });
});

describe('loudness normalization', () => {
    it('persists the checkbox and forwards it to the normalization controller', () => {
        const { controller, hub } = make_controller();
        const normalization = { set_enabled: vi.fn() };
        hub.audioNormalization = normalization;
        controller.init();
        const checkbox = document.getElementById('settings-normalize-loudness');
        expect(checkbox.checked).toBe(true);
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change'));
        expect(norm_prefs.enabled()).toBe(false);
        expect(localStorage.getItem('spolocal_normalize_loudness')).toBe('false');
        expect(normalization.set_enabled).toHaveBeenCalledWith(false);
    });

    it('reflects the stored preference in the checkbox', () => {
        norm_prefs.setEnabled(false);
        const { controller } = make_controller();
        controller.init();
        expect(document.getElementById('settings-normalize-loudness').checked).toBe(false);
    });

    it('works without the normalization controller', () => {
        const { controller } = make_controller();
        controller.init();
        const checkbox = document.getElementById('settings-normalize-loudness');
        checkbox.checked = false;
        expect(() => checkbox.dispatchEvent(new Event('change'))).not.toThrow();
        expect(norm_prefs.enabled()).toBe(false);
    });
});

describe('open and close', () => {
    it('syncs the UI before showing the modal', () => {
        const { controller, hub } = make_controller();
        controller.init();
        localStorage.setItem('spolocal_playback_kbps', '64');
        controller.open();
        expect(hub.settingsModal.classList.contains('hidden')).toBe(false);
        expect(hub.settingsPlaybackValue.textContent).toBe('Data Saver');
        expect(tier_button('settings-playback-tiers', 64).classList.contains('quality-tier-btn--active')).toBe(true);
    });

    it('close hides the modal', () => {
        const { controller, hub } = make_controller();
        controller.init();
        controller.open();
        controller.close();
        expect(hub.settingsModal.classList.contains('hidden')).toBe(true);
    });
});

describe('parallel downloads', () => {
    function mount_workers() {
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <input type="range" id="settings-workers" min="1" max="8" step="1" value="2">
            <span id="settings-workers-value">2</span>
            <button type="button" id="settings-workers-reset"></button>
        `;
        document.getElementById('settings-modal').appendChild(wrap);
    }

    async function flush() {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    }

    it('caches the worker elements and shows the current count', () => {
        mount_workers();
        const { controller, hub } = make_controller();
        controller.init();
        expect(hub.settingsWorkers).toBe(document.getElementById('settings-workers'));
        expect(hub.settingsWorkersValue).toBe(document.getElementById('settings-workers-value'));
        expect(hub.settingsWorkersValue.textContent).toBe('2');
    });

    it('labels the slider while dragging and posts once on release', async () => {
        mount_workers();
        const fetch_mock = vi.fn(async () => json_response({ workers: 5 }));
        vi.stubGlobal('fetch', fetch_mock);
        const { controller, hub } = make_controller();
        controller.init();

        hub.settingsWorkers.value = '5';
        hub.settingsWorkers.dispatchEvent(new Event('input'));
        expect(hub.settingsWorkersValue.textContent).toBe('5');
        expect(fetch_mock).not.toHaveBeenCalled();

        hub.settingsWorkers.dispatchEvent(new Event('change'));
        await flush();

        expect(fetch_mock).toHaveBeenCalledTimes(1);
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/settings/download-workers');
        expect(options.method).toBe('POST');
        expect(options.body).toBe('{"workers":5}');
    });

    it('reset goes back to two workers', async () => {
        mount_workers();
        const fetch_mock = vi.fn(async () => json_response({ workers: 2 }));
        vi.stubGlobal('fetch', fetch_mock);
        const { controller, hub } = make_controller();
        controller.init();
        hub.settingsWorkers.value = '7';

        document.getElementById('settings-workers-reset').click();
        await flush();

        expect(hub.settingsWorkers.value).toBe('2');
        expect(hub.settingsWorkersValue.textContent).toBe('2');
        expect(fetch_mock.mock.calls[0][1].body).toBe('{"workers":2}');
    });

    it('loads the server count when the modal opens', async () => {
        mount_workers();
        const fetch_mock = vi.fn(async () => json_response({ workers: 7 }));
        vi.stubGlobal('fetch', fetch_mock);
        const { controller, hub } = make_controller();
        controller.init();

        controller.open();
        await flush();

        expect(fetch_mock.mock.calls[0][0]).toBe('/api/settings/download-workers');
        expect(hub.settingsWorkers.value).toBe('7');
        expect(hub.settingsWorkersValue.textContent).toBe('7');
    });

    it('keeps the slider usable when the request fails', async () => {
        mount_workers();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const { controller, hub } = make_controller();
        controller.init();
        hub.settingsWorkers.value = '4';
        hub.settingsWorkers.dispatchEvent(new Event('change'));
        await expect(controller.save_worker_count()).resolves.toBeUndefined();
        expect(hub.settingsWorkersValue.textContent).toBe('4');
    });
});
