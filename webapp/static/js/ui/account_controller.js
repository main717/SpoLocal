/**
 * Optional account UI, device heartbeat, and remote play/pause/next poll.
 * Guest playback is unchanged. Login is never required to listen.
 * TOTP MFA is optional and only asked after a correct password.
 */
export class AccountController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        this.state = state;
        /** @type {import('../player/transport_controller.js').PlaylistTransportController|null} */
        this.transport = null;
        this.user = null;
        this._mfa_token = '';
        this._mfa_setup = null;
        this._heartbeat_timer = null;
        this._poll_timer = null;
        this._device_id = this._load_device_id();
    }

    setTransport(transport) {
        this.transport = transport;
    }

    init() {
        this._bind();
        this.refresh();
    }

    _bind() {
        const open_btn = document.getElementById('open-account');
        const modal = document.getElementById('account-modal');
        const backdrop = document.getElementById('account-modal-backdrop');
        const close_btn = document.getElementById('account-close');
        const login_btn = document.getElementById('account-login');
        const register_btn = document.getElementById('account-register');
        const logout_btn = document.getElementById('account-logout');
        const form = document.getElementById('account-form');
        const mfa_submit = document.getElementById('account-mfa-submit');
        const mfa_back = document.getElementById('account-mfa-back');
        const mfa_enable = document.getElementById('account-mfa-enable');
        const mfa_confirm = document.getElementById('account-mfa-confirm');
        const mfa_disable = document.getElementById('account-mfa-disable-btn');

        if (open_btn) open_btn.addEventListener('click', () => this.open());
        const sidebar_hint = document.getElementById('sidebar-login-hint');
        if (sidebar_hint) sidebar_hint.addEventListener('click', () => this.open());
        if (backdrop) backdrop.addEventListener('click', () => this.close());
        if (close_btn) close_btn.addEventListener('click', () => this.close());
        if (login_btn) login_btn.addEventListener('click', () => this.submit('login'));
        if (register_btn) register_btn.addEventListener('click', () => this.submit('register'));
        if (logout_btn) logout_btn.addEventListener('click', () => this.logout());
        if (mfa_submit) mfa_submit.addEventListener('click', () => this.submit_mfa());
        if (mfa_back) mfa_back.addEventListener('click', () => this.cancel_mfa_login());
        if (mfa_enable) mfa_enable.addEventListener('click', () => this.enable_mfa());
        if (mfa_confirm) mfa_confirm.addEventListener('click', () => this.confirm_mfa());
        if (mfa_disable) mfa_disable.addEventListener('click', () => this.disable_mfa());
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                if (this._mfa_token) this.submit_mfa();
                else this.submit('login');
            });
        }
    }

    open() {
        const modal = document.getElementById('account-modal');
        if (!modal) return;
        this._set_error('');
        this._render();
        modal.classList.remove('hidden');
        const user_el = document.getElementById('account-username');
        if (user_el && !this.user) user_el.focus();
    }

    close() {
        const modal = document.getElementById('account-modal');
        if (modal) modal.classList.add('hidden');
        this._mfa_setup = null;
        this._clear_mfa_setup_text();
    }

    _load_device_id() {
        try {
            let id = localStorage.getItem('spolocal_device_id');
            if (!id) {
                id = (crypto.randomUUID && crypto.randomUUID()) || ('dev-' + Math.random().toString(36).slice(2));
                localStorage.setItem('spolocal_device_id', id);
            }
            return id;
        } catch (e) {
            return 'dev-anon';
        }
    }

    _device_name() {
        const ua = (navigator.userAgent || '').toLowerCase();
        let browser = 'Browser';
        if (ua.includes('firefox')) browser = 'Firefox';
        else if (ua.includes('edg/')) browser = 'Edge';
        else if (ua.includes('chrome')) browser = 'Chrome';
        else if (ua.includes('safari')) browser = 'Safari';
        let os = 'device';
        if (ua.includes('android')) os = 'Android';
        else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
        else if (ua.includes('mac')) os = 'Mac';
        else if (ua.includes('win')) os = 'Windows';
        else if (ua.includes('linux')) os = 'Linux';
        return browser + ' on ' + os;
    }

    async refresh() {
        try {
            const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
            const data = r.ok ? await r.json() : { user: null };
            this.user = data.user || null;
        } catch (e) {
            this.user = null;
        }
        this._render();
        if (this.user) {
            this._start_device_loop();
        } else {
            this._stop_device_loop();
        }
    }

    async submit(kind) {
        const username = (document.getElementById('account-username') || {}).value || '';
        const password = (document.getElementById('account-password') || {}).value || '';
        this._set_error('');
        const path = kind === 'register' ? '/api/auth/register' : '/api/auth/login';
        try {
            const r = await fetch(path, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username.trim(), password }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                this._set_error(this._detail(data) || (r.status === 429 ? 'Too many attempts' : 'Could not ' + kind));
                return;
            }
            if (data.mfa_required && data.mfa_token) {
                this._mfa_token = data.mfa_token;
                this.user = null;
                this._render();
                const code_el = document.getElementById('account-mfa-code');
                if (code_el) code_el.focus();
                return;
            }
            this._mfa_token = '';
            this.user = data.user || null;
            const pw = document.getElementById('account-password');
            if (pw) pw.value = '';
            if (this.user) {
                // Library, sidebar and liked row are rendered for the session on
                // boot. The cookie is set now, so reload instead of leaving the
                // guest view on screen.
                this._reload_page();
                return;
            }
            this._render();
        } catch (e) {
            this._set_error('Network error');
        }
    }

    cancel_mfa_login() {
        this._mfa_token = '';
        const code_el = document.getElementById('account-mfa-code');
        if (code_el) code_el.value = '';
        this._set_error('');
        this._render();
    }

    async submit_mfa() {
        const code = (document.getElementById('account-mfa-code') || {}).value || '';
        if (!this._mfa_token) return;
        this._set_error('');
        try {
            const r = await fetch('/api/auth/login/mfa', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ mfa_token: this._mfa_token, code: code.trim() }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                this._set_error(this._detail(data) || (r.status === 429 ? 'Too many attempts' : 'Invalid code'));
                return;
            }
            this._mfa_token = '';
            const code_el = document.getElementById('account-mfa-code');
            if (code_el) code_el.value = '';
            this.user = data.user || null;
            if (this.user) {
                this._reload_page();
                return;
            }
            this._render();
        } catch (e) {
            this._set_error('Network error');
        }
    }

    async enable_mfa() {
        this._set_error('');
        try {
            const r = await fetch('/api/auth/mfa/setup', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' },
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                this._set_error(this._detail(data) || 'Could not start MFA');
                return;
            }
            this._mfa_setup = data;
            this._render();
            const code_el = document.getElementById('account-mfa-confirm-code');
            if (code_el) code_el.focus();
        } catch (e) {
            this._set_error('Network error');
        }
    }

    async confirm_mfa() {
        const code = (document.getElementById('account-mfa-confirm-code') || {}).value || '';
        this._set_error('');
        try {
            const r = await fetch('/api/auth/mfa/confirm', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code.trim() }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                this._set_error(this._detail(data) || (r.status === 429 ? 'Too many attempts' : 'Invalid code'));
                return;
            }
            this._mfa_setup = null;
            this._clear_mfa_setup_text();
            const code_el = document.getElementById('account-mfa-confirm-code');
            if (code_el) code_el.value = '';
            this.user = data.user || this.user;
            this._render();
        } catch (e) {
            this._set_error('Network error');
        }
    }

    async disable_mfa() {
        const code = (document.getElementById('account-mfa-disable-code') || {}).value || '';
        this._set_error('');
        try {
            const r = await fetch('/api/auth/mfa/disable', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code.trim() }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                this._set_error(this._detail(data) || (r.status === 429 ? 'Too many attempts' : 'Invalid code'));
                return;
            }
            const code_el = document.getElementById('account-mfa-disable-code');
            if (code_el) code_el.value = '';
            this.user = data.user || this.user;
            this._render();
        } catch (e) {
            this._set_error('Network error');
        }
    }

    async logout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (e) {}
        this.user = null;
        this._mfa_token = '';
        this._mfa_setup = null;
        this._clear_mfa_setup_text();
        this._stop_device_loop();
        this._render();
    }

    async heartbeat() {
        if (!this.user) return;
        try {
            const r = await fetch('/api/auth/devices', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: this._device_id,
                    name: this._device_name(),
                    make_active: true,
                }),
            });
            if (r.ok) {
                const data = await r.json();
                this.user = data.user || this.user;
                this._render();
            }
        } catch (e) {}
    }

    async poll_commands() {
        if (!this.user) return;
        try {
            const r = await fetch(
                '/api/player/commands/poll?device_id=' + encodeURIComponent(this._device_id),
                { credentials: 'same-origin' },
            );
            if (!r.ok) return;
            const data = await r.json();
            const cmds = data.commands || [];
            for (const cmd of cmds) this.apply_command(cmd.action);
        } catch (e) {}
    }

    apply_command(action) {
        if (!this.transport) return;
        const hub = this.state.hub;
        const paused = !!(hub && hub.audio && hub.audio.paused);
        if (action === 'next') this.transport.playAtDelta(1);
        else if (action === 'prev') this.transport.playAtDelta(-1);
        else if (action === 'toggle') this.transport.toggle_main_play();
        else if (action === 'play' && paused) this.transport.toggle_main_play();
        else if (action === 'pause' && !paused) this.transport.toggle_main_play();
    }

    _start_device_loop() {
        this._stop_device_loop();
        this.heartbeat();
        this._heartbeat_timer = setInterval(() => this.heartbeat(), 20000);
        this._poll_timer = setInterval(() => this.poll_commands(), 2000);
    }

    _stop_device_loop() {
        if (this._heartbeat_timer) {
            clearInterval(this._heartbeat_timer);
            this._heartbeat_timer = null;
        }
        if (this._poll_timer) {
            clearInterval(this._poll_timer);
            this._poll_timer = null;
        }
    }

    _reload_page() {
        window.location.reload();
    }

    _detail(data) {
        const d = data && data.detail;
        if (typeof d === 'string') return d;
        if (Array.isArray(d) && d[0] && d[0].msg) return d[0].msg;
        return '';
    }

    _set_error(msg) {
        const el = document.getElementById('account-error');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    }

    _clear_mfa_setup_text() {
        const secret_el = document.getElementById('account-mfa-secret');
        const uri_el = document.getElementById('account-mfa-uri');
        if (secret_el) secret_el.textContent = '';
        if (uri_el) uri_el.textContent = '';
    }

    _render() {
        const guest = document.getElementById('account-guest');
        const mfa_login = document.getElementById('account-mfa-login');
        const signed = document.getElementById('account-signed');
        const name_el = document.getElementById('account-signed-name');
        const device_el = document.getElementById('account-device-label');
        const btn = document.getElementById('open-account');
        const logged_in = !!this.user;
        const mfa_on = !!(logged_in && this.user.mfa_enabled);
        const showing_setup = !!(logged_in && this._mfa_setup && !mfa_on);
        if (guest) guest.classList.toggle('hidden', logged_in || !!this._mfa_token);
        if (mfa_login) mfa_login.classList.toggle('hidden', logged_in || !this._mfa_token);
        if (signed) signed.classList.toggle('hidden', !logged_in);
        const status_el = document.getElementById('account-mfa-status');
        const enable_btn = document.getElementById('account-mfa-enable');
        const setup_el = document.getElementById('account-mfa-setup');
        const disable_el = document.getElementById('account-mfa-disable');
        if (status_el) status_el.textContent = mfa_on ? 'MFA is on.' : '';
        if (enable_btn) enable_btn.classList.toggle('hidden', mfa_on || showing_setup);
        if (setup_el) setup_el.classList.toggle('hidden', !showing_setup);
        if (disable_el) disable_el.classList.toggle('hidden', !mfa_on);
        if (showing_setup) {
            const secret_el = document.getElementById('account-mfa-secret');
            const uri_el = document.getElementById('account-mfa-uri');
            if (secret_el) secret_el.textContent = this._mfa_setup.secret || '';
            if (uri_el) uri_el.textContent = this._mfa_setup.otpauth_uri || '';
        }
        if (name_el) name_el.textContent = logged_in ? this.user.username : '';
        if (device_el) {
            device_el.textContent = logged_in
                ? (this._device_name() + ' is the active device')
                : '';
        }
        if (btn) {
            btn.setAttribute('aria-label', logged_in ? ('Account: ' + this.user.username) : 'Account');
            btn.classList.toggle('text-[#1DB954]', logged_in);
            btn.classList.toggle('text-[#B3B3B3]', !logged_in);
        }
    }
}
