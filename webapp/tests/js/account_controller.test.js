import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountController } from '../../static/js/ui/account_controller.js';

function mount_account_dom() {
    document.body.innerHTML = `
        <button id="open-account"></button>
        <div id="sidebar-login-hint"></div>
        <div id="account-modal" class="hidden">
            <div id="account-modal-backdrop"></div>
            <button id="account-close"></button>
            <div id="account-guest">
                <input id="account-username">
                <input id="account-password">
                <button id="account-login"></button>
                <button id="account-register"></button>
                <form id="account-form"></form>
            </div>
            <div id="account-mfa-login" class="hidden">
                <input id="account-mfa-code">
                <button id="account-mfa-submit"></button>
                <button id="account-mfa-back"></button>
            </div>
            <div id="account-signed" class="hidden">
                <span id="account-signed-name"></span>
                <span id="account-device-label"></span>
                <button id="account-logout"></button>
                <p id="account-mfa-status"></p>
                <button id="account-mfa-enable"></button>
                <div id="account-mfa-setup" class="hidden">
                    <span id="account-mfa-secret"></span>
                    <span id="account-mfa-uri"></span>
                    <input id="account-mfa-confirm-code">
                    <button id="account-mfa-confirm"></button>
                </div>
                <div id="account-mfa-disable" class="hidden">
                    <input id="account-mfa-disable-code">
                    <button id="account-mfa-disable-btn"></button>
                </div>
            </div>
            <p id="account-error" class="hidden"></p>
        </div>
    `;
}

function json_response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function stub_fetch(routes) {
    const fetch_mock = vi.fn(async (url) => {
        const key = Object.keys(routes).find((route) => String(url).startsWith(route));
        if (!key) return json_response({});
        const value = routes[key];
        return typeof value === 'function' ? value() : value;
    });
    vi.stubGlobal('fetch', fetch_mock);
    return fetch_mock;
}

function make_controller(hub = {}) {
    return new AccountController({ hub });
}

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function set_user_agent(value) {
    Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    mount_account_dom();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('constructor and device identity', () => {
    it('creates and persists a device id', () => {
        const controller = make_controller();
        const stored = localStorage.getItem('spolocal_device_id');
        expect(typeof stored).toBe('string');
        expect(stored.length).toBeGreaterThan(0);
        expect(controller._device_id).toBe(stored);
    });

    it('reuses the stored device id', () => {
        localStorage.setItem('spolocal_device_id', 'known-device');
        const controller = make_controller();
        expect(controller._device_id).toBe('known-device');
    });

    it('setTransport stores the transport', () => {
        const controller = make_controller();
        const transport = { playAtDelta: vi.fn() };
        controller.setTransport(transport);
        expect(controller.transport).toBe(transport);
    });

    it('names the browser and the operating system', () => {
        const controller = make_controller();
        set_user_agent('Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0');
        expect(controller._device_name()).toBe('Firefox on Linux');
        set_user_agent('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0');
        expect(controller._device_name()).toBe('Chrome on Windows');
        set_user_agent('Mozilla/5.0 (Macintosh) Safari/605.1');
        expect(controller._device_name()).toBe('Safari on Mac');
        set_user_agent('Mozilla/5.0 (Linux; Android 13) Edg/120.0');
        expect(controller._device_name()).toBe('Edge on Android');
        set_user_agent('Mozilla/5.0 (iPhone) Version/17 Safari/604.1');
        expect(controller._device_name()).toBe('Safari on iOS');
        set_user_agent('');
        expect(controller._device_name()).toBe('Browser on device');
    });
});

describe('init and binding', () => {
    it('binds the buttons and refreshes the session', async () => {
        const fetch_mock = stub_fetch({ '/api/auth/me': json_response({ user: null }) });
        const controller = make_controller();
        controller.init();
        await flush();
        expect(fetch_mock).toHaveBeenCalledWith('/api/auth/me', { credentials: 'same-origin' });
        expect(controller.user).toBe(null);
    });

    it('opens the modal from the account button and the sidebar hint', () => {
        stub_fetch({ '/api/auth/me': json_response({ user: null }) });
        const controller = make_controller();
        controller.init();
        document.getElementById('open-account').click();
        expect(document.getElementById('account-modal').classList.contains('hidden')).toBe(false);
        controller.close();
        document.getElementById('sidebar-login-hint').click();
        expect(document.getElementById('account-modal').classList.contains('hidden')).toBe(false);
    });

    it('closes the modal from the backdrop and the close button', () => {
        stub_fetch({ '/api/auth/me': json_response({ user: null }) });
        const controller = make_controller();
        controller.init();
        controller.open();
        document.getElementById('account-modal-backdrop').click();
        expect(document.getElementById('account-modal').classList.contains('hidden')).toBe(true);
        controller.open();
        document.getElementById('account-close').click();
        expect(document.getElementById('account-modal').classList.contains('hidden')).toBe(true);
    });

    it('submits a login from the form', () => {
        stub_fetch({ '/api/auth/me': json_response({ user: null }) });
        const controller = make_controller();
        const spy = vi.spyOn(controller, 'submit').mockResolvedValue();
        controller.init();
        document.getElementById('account-form').dispatchEvent(new Event('submit', { cancelable: true }));
        expect(spy).toHaveBeenCalledWith('login');
    });

    it('submits the MFA code from the form when a token is pending', () => {
        stub_fetch({ '/api/auth/me': json_response({ user: null }) });
        const controller = make_controller();
        const spy = vi.spyOn(controller, 'submit_mfa').mockResolvedValue();
        controller._mfa_token = 'pending';
        controller.init();
        document.getElementById('account-form').dispatchEvent(new Event('submit', { cancelable: true }));
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('wires the login, register, logout and MFA buttons', () => {
        stub_fetch({ '/api/auth/me': json_response({ user: null }) });
        const controller = make_controller();
        const submit_spy = vi.spyOn(controller, 'submit').mockResolvedValue();
        const logout_spy = vi.spyOn(controller, 'logout').mockResolvedValue();
        const mfa_spy = vi.spyOn(controller, 'submit_mfa').mockResolvedValue();
        const cancel_spy = vi.spyOn(controller, 'cancel_mfa_login').mockImplementation(() => {});
        const enable_spy = vi.spyOn(controller, 'enable_mfa').mockResolvedValue();
        const confirm_spy = vi.spyOn(controller, 'confirm_mfa').mockResolvedValue();
        const disable_spy = vi.spyOn(controller, 'disable_mfa').mockResolvedValue();
        controller.init();
        document.getElementById('account-login').click();
        document.getElementById('account-register').click();
        document.getElementById('account-logout').click();
        document.getElementById('account-mfa-submit').click();
        document.getElementById('account-mfa-back').click();
        document.getElementById('account-mfa-enable').click();
        document.getElementById('account-mfa-confirm').click();
        document.getElementById('account-mfa-disable-btn').click();
        expect(submit_spy).toHaveBeenCalledWith('login');
        expect(submit_spy).toHaveBeenCalledWith('register');
        expect(logout_spy).toHaveBeenCalledTimes(1);
        expect(mfa_spy).toHaveBeenCalledTimes(1);
        expect(cancel_spy).toHaveBeenCalledTimes(1);
        expect(enable_spy).toHaveBeenCalledTimes(1);
        expect(confirm_spy).toHaveBeenCalledTimes(1);
        expect(disable_spy).toHaveBeenCalledTimes(1);
    });
});

describe('open and close', () => {
    it('renders the guest view and focuses the username', () => {
        const controller = make_controller();
        controller.open();
        expect(document.getElementById('account-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(false);
        expect(document.activeElement).toBe(document.getElementById('account-username'));
    });

    it('does not focus the username when signed in', () => {
        const controller = make_controller();
        controller.user = { username: 'ada' };
        controller.open();
        expect(document.activeElement).not.toBe(document.getElementById('account-username'));
    });

    it('does nothing without the modal', () => {
        document.body.innerHTML = '';
        const controller = make_controller();
        expect(() => controller.open()).not.toThrow();
        expect(() => controller.close()).not.toThrow();
    });

    it('clears the MFA setup text on close', () => {
        const controller = make_controller();
        document.getElementById('account-mfa-secret').textContent = 'SECRET';
        document.getElementById('account-mfa-uri').textContent = 'otpauth://x';
        controller._mfa_setup = { secret: 'SECRET' };
        controller.close();
        expect(document.getElementById('account-mfa-secret').textContent).toBe('');
        expect(document.getElementById('account-mfa-uri').textContent).toBe('');
        expect(controller._mfa_setup).toBe(null);
    });
});

describe('refresh', () => {
    it('stores the signed in user and renders the signed view', async () => {
        stub_fetch({ '/api/auth/me': json_response({ user: { username: 'ada' } }) });
        const controller = make_controller();
        controller._start_device_loop = vi.fn();
        await controller.refresh();
        expect(controller.user).toEqual({ username: 'ada' });
        expect(document.getElementById('account-signed').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('account-signed-name').textContent).toBe('ada');
        expect(controller._start_device_loop).toHaveBeenCalledTimes(1);
    });

    it('clears the user when the request fails', async () => {
        stub_fetch({ '/api/auth/me': json_response({}, false, 401) });
        const controller = make_controller();
        controller._stop_device_loop = vi.fn();
        await controller.refresh();
        expect(controller.user).toBe(null);
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(false);
        expect(controller._stop_device_loop).toHaveBeenCalledTimes(1);
    });

    it('clears the user on a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        controller._stop_device_loop = vi.fn();
        await controller.refresh();
        expect(controller.user).toBe(null);
    });
});

describe('submit', () => {
    it('logs in and clears the password', async () => {
        const fetch_mock = stub_fetch({
            '/api/auth/login': json_response({ user: { username: 'ada' } }),
        });
        const controller = make_controller();
        controller._reload_page = vi.fn();
        document.getElementById('account-username').value = ' ada ';
        document.getElementById('account-password').value = 'secret';
        await controller.submit('login');
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/auth/login');
        expect(options.method).toBe('POST');
        expect(options.body).toBe('{"username":"ada","password":"secret"}');
        expect(controller.user).toEqual({ username: 'ada' });
        expect(document.getElementById('account-password').value).toBe('');
        expect(controller._reload_page).toHaveBeenCalledTimes(1);
    });

    it('registers through the register endpoint', async () => {
        const fetch_mock = stub_fetch({
            '/api/auth/register': json_response({ user: { username: 'ada' } }),
        });
        const controller = make_controller();
        controller._reload_page = vi.fn();
        await controller.submit('register');
        expect(fetch_mock.mock.calls[0][0]).toBe('/api/auth/register');
        expect(controller._reload_page).toHaveBeenCalledTimes(1);
    });

    it('shows a string detail from the server', async () => {
        stub_fetch({ '/api/auth/login': json_response({ detail: 'Bad password' }, false, 401) });
        const controller = make_controller();
        await controller.submit('login');
        const error = document.getElementById('account-error');
        expect(error.textContent).toBe('Bad password');
        expect(error.classList.contains('hidden')).toBe(false);
    });

    it('shows the first validation message from a detail array', async () => {
        stub_fetch({
            '/api/auth/login': json_response({ detail: [{ msg: 'Too short' }] }, false, 422),
        });
        const controller = make_controller();
        await controller.submit('login');
        expect(document.getElementById('account-error').textContent).toBe('Too short');
    });

    it('maps a 429 to the rate limit message', async () => {
        stub_fetch({ '/api/auth/login': json_response({}, false, 429) });
        const controller = make_controller();
        await controller.submit('login');
        expect(document.getElementById('account-error').textContent).toBe('Too many attempts');
    });

    it('falls back to a generic message', async () => {
        stub_fetch({ '/api/auth/register': json_response({}, false, 400) });
        const controller = make_controller();
        await controller.submit('register');
        expect(document.getElementById('account-error').textContent).toBe('Could not register');
    });

    it('switches to the MFA step when the server asks for a code', async () => {
        stub_fetch({
            '/api/auth/login': json_response({ mfa_required: true, mfa_token: 'tok' }),
        });
        const controller = make_controller();
        await controller.submit('login');
        expect(controller._mfa_token).toBe('tok');
        expect(controller.user).toBe(null);
        expect(document.getElementById('account-mfa-login').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(document.getElementById('account-mfa-code'));
    });

    it('reports a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        await controller.submit('login');
        expect(document.getElementById('account-error').textContent).toBe('Network error');
    });
});

describe('MFA login', () => {
    it('cancel_mfa_login clears the token and the code', () => {
        const controller = make_controller();
        controller._mfa_token = 'tok';
        document.getElementById('account-mfa-code').value = '123456';
        controller.cancel_mfa_login();
        expect(controller._mfa_token).toBe('');
        expect(document.getElementById('account-mfa-code').value).toBe('');
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(false);
    });

    it('submit_mfa does nothing without a token', async () => {
        const fetch_mock = stub_fetch({});
        const controller = make_controller();
        await controller.submit_mfa();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('submit_mfa signs the user in', async () => {
        const fetch_mock = stub_fetch({
            '/api/auth/login/mfa': json_response({ user: { username: 'ada' } }),
        });
        const controller = make_controller();
        controller._mfa_token = 'tok';
        controller._reload_page = vi.fn();
        document.getElementById('account-mfa-code').value = ' 123456 ';
        await controller.submit_mfa();
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/auth/login/mfa');
        expect(options.body).toBe('{"mfa_token":"tok","code":"123456"}');
        expect(controller._mfa_token).toBe('');
        expect(controller.user).toEqual({ username: 'ada' });
        expect(document.getElementById('account-mfa-code').value).toBe('');
        expect(controller._reload_page).toHaveBeenCalledTimes(1);
    });

    it('submit_mfa shows the server detail', async () => {
        stub_fetch({ '/api/auth/login/mfa': json_response({ detail: 'Expired' }, false, 401) });
        const controller = make_controller();
        controller._mfa_token = 'tok';
        await controller.submit_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Expired');
    });

    it('submit_mfa falls back to Invalid code', async () => {
        stub_fetch({ '/api/auth/login/mfa': json_response({}, false, 400) });
        const controller = make_controller();
        controller._mfa_token = 'tok';
        await controller.submit_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Invalid code');
    });

    it('submit_mfa reports a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        controller._mfa_token = 'tok';
        await controller.submit_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Network error');
    });
});

describe('MFA setup', () => {
    it('enable_mfa stores the setup and renders the secret', async () => {
        const fetch_mock = stub_fetch({
            '/api/auth/mfa/setup': json_response({ secret: 'ABC', otpauth_uri: 'otpauth://x' }),
        });
        const controller = make_controller();
        controller.user = { username: 'ada', mfa_enabled: false };
        await controller.enable_mfa();
        expect(fetch_mock.mock.calls[0][0]).toBe('/api/auth/mfa/setup');
        expect(controller._mfa_setup).toEqual({ secret: 'ABC', otpauth_uri: 'otpauth://x' });
        expect(document.getElementById('account-mfa-setup').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-mfa-secret').textContent).toBe('ABC');
        expect(document.getElementById('account-mfa-uri').textContent).toBe('otpauth://x');
        expect(document.activeElement).toBe(document.getElementById('account-mfa-confirm-code'));
    });

    it('enable_mfa shows the server detail', async () => {
        stub_fetch({ '/api/auth/mfa/setup': json_response({ detail: 'Nope' }, false, 400) });
        const controller = make_controller();
        await controller.enable_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Nope');
    });

    it('enable_mfa falls back to a generic message', async () => {
        stub_fetch({ '/api/auth/mfa/setup': json_response({}, false, 500) });
        const controller = make_controller();
        await controller.enable_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Could not start MFA');
    });

    it('enable_mfa reports a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        await controller.enable_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Network error');
    });

    it('confirm_mfa clears the setup and stores the user', async () => {
        const fetch_mock = stub_fetch({
            '/api/auth/mfa/confirm': json_response({ user: { username: 'ada', mfa_enabled: true } }),
        });
        const controller = make_controller();
        controller._mfa_setup = { secret: 'ABC' };
        document.getElementById('account-mfa-confirm-code').value = ' 123456 ';
        await controller.confirm_mfa();
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/auth/mfa/confirm');
        expect(options.body).toBe('{"code":"123456"}');
        expect(controller._mfa_setup).toBe(null);
        expect(controller.user.mfa_enabled).toBe(true);
        expect(document.getElementById('account-mfa-confirm-code').value).toBe('');
        expect(document.getElementById('account-mfa-status').textContent).toBe('MFA is on.');
    });

    it('confirm_mfa shows the server detail', async () => {
        stub_fetch({ '/api/auth/mfa/confirm': json_response({ detail: 'Wrong code' }, false, 400) });
        const controller = make_controller();
        await controller.confirm_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Wrong code');
    });

    it('confirm_mfa reports a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        await controller.confirm_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Network error');
    });

    it('disable_mfa clears the code and stores the user', async () => {
        const fetch_mock = stub_fetch({
            '/api/auth/mfa/disable': json_response({ user: { username: 'ada', mfa_enabled: false } }),
        });
        const controller = make_controller();
        document.getElementById('account-mfa-disable-code').value = ' 654321 ';
        await controller.disable_mfa();
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/auth/mfa/disable');
        expect(options.body).toBe('{"code":"654321"}');
        expect(controller.user.mfa_enabled).toBe(false);
        expect(document.getElementById('account-mfa-disable-code').value).toBe('');
    });

    it('disable_mfa shows the server detail', async () => {
        stub_fetch({ '/api/auth/mfa/disable': json_response({ detail: 'Wrong code' }, false, 400) });
        const controller = make_controller();
        await controller.disable_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Wrong code');
    });

    it('disable_mfa reports a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        await controller.disable_mfa();
        expect(document.getElementById('account-error').textContent).toBe('Network error');
    });
});

describe('logout', () => {
    it('posts the logout, clears the user and stops the loop', async () => {
        const fetch_mock = stub_fetch({ '/api/auth/logout': json_response({}) });
        const controller = make_controller();
        controller.user = { username: 'ada' };
        controller._mfa_token = 'tok';
        controller._mfa_setup = { secret: 'ABC' };
        controller._stop_device_loop = vi.fn();
        await controller.logout();
        expect(fetch_mock.mock.calls[0][0]).toBe('/api/auth/logout');
        expect(fetch_mock.mock.calls[0][1].method).toBe('POST');
        expect(controller.user).toBe(null);
        expect(controller._mfa_token).toBe('');
        expect(controller._mfa_setup).toBe(null);
        expect(controller._stop_device_loop).toHaveBeenCalledTimes(1);
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(false);
    });

    it('still clears the user when the request fails', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        controller.user = { username: 'ada' };
        controller._stop_device_loop = vi.fn();
        await controller.logout();
        expect(controller.user).toBe(null);
    });
});

describe('heartbeat', () => {
    it('does nothing without a user', async () => {
        const fetch_mock = stub_fetch({});
        const controller = make_controller();
        await controller.heartbeat();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('posts the device and stores the returned user', async () => {
        const fetch_mock = stub_fetch({
            '/api/auth/devices': json_response({ user: { username: 'ada', active: true } }),
        });
        const controller = make_controller();
        controller.user = { username: 'ada' };
        await controller.heartbeat();
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/auth/devices');
        expect(options.method).toBe('POST');
        const body = JSON.parse(options.body);
        expect(body.id).toBe(controller._device_id);
        expect(body.make_active).toBe(true);
        expect(typeof body.name).toBe('string');
        expect(controller.user.active).toBe(true);
    });

    it('keeps the user when the response is not ok', async () => {
        stub_fetch({ '/api/auth/devices': json_response({}, false, 500) });
        const controller = make_controller();
        controller.user = { username: 'ada' };
        await controller.heartbeat();
        expect(controller.user).toEqual({ username: 'ada' });
    });

    it('swallows network errors', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        controller.user = { username: 'ada' };
        await expect(controller.heartbeat()).resolves.toBeUndefined();
        expect(controller.user).toEqual({ username: 'ada' });
    });
});

describe('poll_commands', () => {
    it('does nothing without a user', async () => {
        const fetch_mock = stub_fetch({});
        const controller = make_controller();
        await controller.poll_commands();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('applies every returned command', async () => {
        const fetch_mock = stub_fetch({
            '/api/player/commands/poll': json_response({
                commands: [{ action: 'next' }, { action: 'toggle' }],
            }),
        });
        const controller = make_controller();
        controller.user = { username: 'ada' };
        const apply_spy = vi.spyOn(controller, 'apply_command').mockImplementation(() => {});
        await controller.poll_commands();
        expect(fetch_mock.mock.calls[0][0]).toBe(
            '/api/player/commands/poll?device_id=' + encodeURIComponent(controller._device_id),
        );
        expect(apply_spy.mock.calls).toEqual([['next'], ['toggle']]);
    });

    it('ignores a failed poll', async () => {
        stub_fetch({ '/api/player/commands/poll': json_response({}, false, 500) });
        const controller = make_controller();
        controller.user = { username: 'ada' };
        const apply_spy = vi.spyOn(controller, 'apply_command').mockImplementation(() => {});
        await controller.poll_commands();
        expect(apply_spy).not.toHaveBeenCalled();
    });

    it('swallows network errors', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        controller.user = { username: 'ada' };
        await expect(controller.poll_commands()).resolves.toBeUndefined();
    });
});

describe('apply_command', () => {
    function make_transport() {
        return { playAtDelta: vi.fn(), toggle_main_play: vi.fn() };
    }

    it('does nothing without a transport', () => {
        const controller = make_controller({ audio: { paused: true } });
        expect(() => controller.apply_command('next')).not.toThrow();
    });

    it('maps next and prev to playAtDelta', () => {
        const controller = make_controller({ audio: { paused: true } });
        const transport = make_transport();
        controller.setTransport(transport);
        controller.apply_command('next');
        controller.apply_command('prev');
        expect(transport.playAtDelta.mock.calls).toEqual([[1], [-1]]);
    });

    it('toggles on toggle', () => {
        const controller = make_controller({ audio: { paused: true } });
        const transport = make_transport();
        controller.setTransport(transport);
        controller.apply_command('toggle');
        expect(transport.toggle_main_play).toHaveBeenCalledTimes(1);
    });

    it('plays only when paused', () => {
        const controller = make_controller({ audio: { paused: true } });
        const transport = make_transport();
        controller.setTransport(transport);
        controller.apply_command('play');
        expect(transport.toggle_main_play).toHaveBeenCalledTimes(1);
        controller.state.hub.audio.paused = false;
        controller.apply_command('play');
        expect(transport.toggle_main_play).toHaveBeenCalledTimes(1);
    });

    it('pauses only when playing', () => {
        const controller = make_controller({ audio: { paused: false } });
        const transport = make_transport();
        controller.setTransport(transport);
        controller.apply_command('pause');
        expect(transport.toggle_main_play).toHaveBeenCalledTimes(1);
        controller.state.hub.audio.paused = true;
        controller.apply_command('pause');
        expect(transport.toggle_main_play).toHaveBeenCalledTimes(1);
    });

    it('ignores unknown actions', () => {
        const controller = make_controller({ audio: { paused: true } });
        const transport = make_transport();
        controller.setTransport(transport);
        controller.apply_command('rewind');
        expect(transport.playAtDelta).not.toHaveBeenCalled();
        expect(transport.toggle_main_play).not.toHaveBeenCalled();
    });
});

describe('device loop', () => {
    it('heartbeats immediately, then on the heartbeat and poll intervals', async () => {
        vi.useFakeTimers();
        const fetch_mock = stub_fetch({
            '/api/auth/devices': json_response({ user: { username: 'ada' } }),
            '/api/player/commands/poll': json_response({ commands: [] }),
        });
        const controller = make_controller();
        controller.user = { username: 'ada' };
        const device_calls = () => fetch_mock.mock.calls.filter(
            (call) => String(call[0]).startsWith('/api/auth/devices'),
        ).length;
        const poll_calls = () => fetch_mock.mock.calls.filter(
            (call) => String(call[0]).startsWith('/api/player/commands/poll'),
        ).length;

        controller._start_device_loop();
        expect(device_calls()).toBe(1);
        expect(poll_calls()).toBe(0);

        await vi.advanceTimersByTimeAsync(2000);
        expect(poll_calls()).toBe(1);
        expect(device_calls()).toBe(1);

        await vi.advanceTimersByTimeAsync(18000);
        expect(device_calls()).toBe(2);
        expect(poll_calls()).toBe(10);

        controller._stop_device_loop();
        await vi.advanceTimersByTimeAsync(40000);
        expect(device_calls()).toBe(2);
        expect(poll_calls()).toBe(10);
    });

    it('restarts cleanly without duplicating timers', async () => {
        vi.useFakeTimers();
        const fetch_mock = stub_fetch({
            '/api/auth/devices': json_response({ user: { username: 'ada' } }),
            '/api/player/commands/poll': json_response({ commands: [] }),
        });
        const controller = make_controller();
        controller.user = { username: 'ada' };
        controller._start_device_loop();
        controller._start_device_loop();
        await vi.advanceTimersByTimeAsync(2000);
        const poll_calls = fetch_mock.mock.calls.filter(
            (call) => String(call[0]).startsWith('/api/player/commands/poll'),
        ).length;
        expect(poll_calls).toBe(1);
        controller._stop_device_loop();
    });
});

describe('helpers', () => {
    it('_detail reads strings, arrays and nothing', () => {
        const controller = make_controller();
        expect(controller._detail({ detail: 'x' })).toBe('x');
        expect(controller._detail({ detail: [{ msg: 'y' }] })).toBe('y');
        expect(controller._detail({ detail: [] })).toBe('');
        expect(controller._detail({})).toBe('');
        expect(controller._detail(null)).toBe('');
    });

    it('_set_error shows and hides the error', () => {
        const controller = make_controller();
        const error = document.getElementById('account-error');
        controller._set_error('boom');
        expect(error.textContent).toBe('boom');
        expect(error.classList.contains('hidden')).toBe(false);
        controller._set_error('');
        expect(error.textContent).toBe('');
        expect(error.classList.contains('hidden')).toBe(true);
    });

    it('_set_error does nothing without the element', () => {
        document.getElementById('account-error').remove();
        const controller = make_controller();
        expect(() => controller._set_error('boom')).not.toThrow();
    });
});

describe('_render', () => {
    it('shows the guest view by default', () => {
        const controller = make_controller();
        controller._render();
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-signed').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('account-mfa-login').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('account-signed-name').textContent).toBe('');
        expect(document.getElementById('account-device-label').textContent).toBe('');
        const button = document.getElementById('open-account');
        expect(button.getAttribute('aria-label')).toBe('Account');
        expect(button.classList.contains('text-[#B3B3B3]')).toBe(true);
        expect(button.classList.contains('text-[#1DB954]')).toBe(false);
    });

    it('shows the signed view with the device label', () => {
        set_user_agent('Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0');
        const controller = make_controller();
        controller.user = { username: 'ada', mfa_enabled: false };
        controller._render();
        expect(document.getElementById('account-signed').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('account-signed-name').textContent).toBe('ada');
        expect(document.getElementById('account-device-label').textContent).toBe(
            'Firefox on Linux is the active device',
        );
        const button = document.getElementById('open-account');
        expect(button.getAttribute('aria-label')).toBe('Account: ada');
        expect(button.classList.contains('text-[#1DB954]')).toBe(true);
        expect(button.classList.contains('text-[#B3B3B3]')).toBe(false);
    });

    it('shows the MFA login step while a token is pending', () => {
        const controller = make_controller();
        controller._mfa_token = 'tok';
        controller._render();
        expect(document.getElementById('account-mfa-login').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-guest').classList.contains('hidden')).toBe(true);
    });

    it('shows the MFA status and disable section when MFA is on', () => {
        const controller = make_controller();
        controller.user = { username: 'ada', mfa_enabled: true };
        controller._render();
        expect(document.getElementById('account-mfa-status').textContent).toBe('MFA is on.');
        expect(document.getElementById('account-mfa-enable').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('account-mfa-disable').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-mfa-setup').classList.contains('hidden')).toBe(true);
    });

    it('shows the setup section while MFA is being enabled', () => {
        const controller = make_controller();
        controller.user = { username: 'ada', mfa_enabled: false };
        controller._mfa_setup = { secret: 'ABC', otpauth_uri: 'otpauth://x' };
        controller._render();
        expect(document.getElementById('account-mfa-setup').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('account-mfa-enable').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('account-mfa-secret').textContent).toBe('ABC');
        expect(document.getElementById('account-mfa-uri').textContent).toBe('otpauth://x');
    });

    it('does nothing without the optional elements', () => {
        document.body.innerHTML = '';
        const controller = make_controller();
        controller.user = { username: 'ada', mfa_enabled: true };
        expect(() => controller._render()).not.toThrow();
    });
});
