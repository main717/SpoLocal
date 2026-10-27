/**
 * Web Audio gain chain for per-track loudness normalization.
 */
export class AudioNormalizationController {
    /** @param {HTMLMediaElement} audio_el */
    constructor(audio_el) {
        this.audio_el = audio_el;
        /** @type {AudioContext|null} */
        this.ctx = null;
        /** @type {GainNode|null} */
        this.gain_node = null;
        this.user_volume = 1;
        this.track_gain_db = 0;
        this.track_offset_db = 0;
        this.enabled = true;
        this._wired = false;
        this._play_bound = false;
        this._resuming = false;
    }

    ensure_wired() {
        this.wire();
        if (!this._wired && this.audio_el && !this.audio_el.paused) {
            this._connect_graph();
        }
    }

    _ensure_ctx() {
        if (this.ctx) return true;
        try {
            this.ctx = new AudioContext();
            return true;
        } catch (e) {
            this.ctx = null;
            return false;
        }
    }

    /**
     * A context suspended by tab sleep or OS suspend stays silent and freezes
     * currentTime. Resume it, and connect the graph once it is actually running.
     */
    _resume() {
        const ctx = this.ctx;
        if (!ctx || ctx.state === 'running' || this._resuming) return;
        this._resuming = true;
        try {
            const p = ctx.resume();
            if (p && typeof p.then === 'function') {
                p.then(() => {
                    this._resuming = false;
                    if (!this._wired && this.ctx && this.ctx.state === 'running') {
                        this._connect_graph();
                    }
                }).catch(() => { this._resuming = false; });
            } else {
                this._resuming = false;
            }
        } catch (e) {
            this._resuming = false;
        }
    }

    _bind_resume() {
        if (this._play_bound || !this.audio_el) return;
        this._play_bound = true;
        this.audio_el.addEventListener('play', () => this._connect_graph());
        if (typeof document === 'undefined') return;
        const on_gesture = () => this._resume();
        document.addEventListener('pointerdown', on_gesture, true);
        document.addEventListener('keydown', on_gesture, true);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this._resume();
        });
    }

    _connect_graph() {
        if (this._wired) {
            this._resume();
            return;
        }
        if (!this._ensure_ctx()) return;
        // Never route the element through a suspended context: that freezes
        // playback at 0:00. Keep native audio until the context is running.
        if (this.ctx.state !== 'running') {
            this._resume();
            return;
        }
        try {
            const src = this.ctx.createMediaElementSource(this.audio_el);
            this.gain_node = this.ctx.createGain();
            src.connect(this.gain_node);
            this.gain_node.connect(this.ctx.destination);
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.82;
            this.gain_node.connect(this.analyser);
            this._freq = new Uint8Array(this.analyser.frequencyBinCount);
            this.audio_el.volume = 1;
            this._wired = true;
        } catch (e) {
            this._wired = false;
        }
        this._sync_gain();
    }

    wire() {
        if (this._wired) {
            this._resume();
            return;
        }
        const prefs = window.SpolocalNormalizationPrefs;
        if (prefs) this.enabled = prefs.enabled();
        // Create the context inside the click gesture when possible so it starts
        // running; the source is connected on the first play event.
        this._ensure_ctx();
        this._bind_resume();
        if (!this.audio_el.paused) this._connect_graph();
        this._sync_gain();
    }

    bands_energy() {
        if (!this.analyser || !this._freq) return { bass: 0, mid: 0, treble: 0 };
        this.analyser.getByteFrequencyData(this._freq);
        const n = this._freq.length;
        const avg = (a, b) => {
            let s = 0;
            const lo = Math.max(0, a);
            const hi = Math.min(n, b);
            const c = Math.max(1, hi - lo);
            for (let i = lo; i < hi; i += 1) s += this._freq[i];
            return s / c / 255;
        };
        return { bass: avg(0, 6), mid: avg(6, 24), treble: avg(24, 64) };
    }

    set_user_volume(v) {
        this.user_volume = Math.max(0, Math.min(1, v));
        this._sync_gain();
    }

    get_user_volume() {
        return this.user_volume;
    }

    set_track_gain_db(db) {
        const n = Number(db);
        this.track_gain_db = Number.isFinite(n) ? n : 0;
        // A measured gain arrives mid-track; ramp to it instead of jumping.
        this._sync_gain(0.4);
    }

    /** Manual per-song or per-album tweak, applied on top of the measured gain. */
    set_track_offset_db(db) {
        const n = Number(db);
        this.track_offset_db = Number.isFinite(n) ? n : 0;
        this._sync_gain(0.4);
    }

    set_enabled(on) {
        this.enabled = !!on;
        this._sync_gain();
    }

    _sync_gain(fade_seconds = 0) {
        if (!this.gain_node) {
            if (this.audio_el) this.audio_el.volume = this.user_volume;
            return;
        }
        const prefs = window.SpolocalNormalizationPrefs;
        const use_norm = this.enabled && prefs && prefs.enabled();
        const norm_lin = use_norm ? Math.pow(10, (this.track_gain_db + this.track_offset_db) / 20) : 1;
        const v = Math.max(0, Math.min(4, this.user_volume * norm_lin));
        const param = this.gain_node.gain;
        const ctx = this.ctx;
        if (fade_seconds > 0 && ctx && ctx.state === 'running'
            && typeof param.linearRampToValueAtTime === 'function') {
            const now = ctx.currentTime;
            try {
                if (typeof param.cancelAndHoldAtTime === 'function') {
                    param.cancelAndHoldAtTime(now);
                } else {
                    param.cancelScheduledValues(now);
                    param.setValueAtTime(param.value, now);
                }
                param.linearRampToValueAtTime(v, now + fade_seconds);
                return;
            } catch (e) { /* fall back to an instant set */ }
        }
        param.value = v;
    }
}
