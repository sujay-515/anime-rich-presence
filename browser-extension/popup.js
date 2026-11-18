const DEFAULT_ACCENT = '148, 163, 184';

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }
    return [h, s, l];
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255)
    ];
}

function normalizeAccentRgb(r, g, b) {
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.16) return null; // Skip neutral grays/blacks/whites
    // Clamp into a crisp, non-murky UI accent range
    const cleanS = Math.min(0.76, Math.max(0.46, s));
    const cleanL = Math.min(0.68, Math.max(0.56, l));
    const [nr, ng, nb] = hslToRgb(h, cleanS, cleanL);
    return `${nr}, ${ng}, ${nb}`;
}

function parseThemeColor(colorStr) {
    if (!colorStr) return null;
    const hex = colorStr.trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return normalizeAccentRgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
    const rgb = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) {
        return normalizeAccentRgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
    }
    return null;
}

class PopupController {
    constructor() {
        this.colorCache = {};
        this.activeAccentKey = null;
        this.init();
        this.loadStatus();
        this.refreshInterval = setInterval(() => this.loadStatus(), 1000);
    }

    async init() {
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadStatus();
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearPresence();
        });

        await this.initSettings();
    }

    async initSettings() {
        const keys = {
            privacyToggle: 'privacyMode',
            episodeToggle: 'showEpisode',
            progressToggle: 'showProgress',
            siteToggle: 'showSiteBadge'
        };

        const defaults = {
            privacyMode: false,
            showEpisode: true,
            showProgress: true,
            showSiteBadge: true
        };

        try {
            const settings = await chrome.storage.local.get(Object.values(keys));
            for (const [id, key] of Object.entries(keys)) {
                const el = document.getElementById(id);
                if (el) {
                    el.checked = settings[key] !== undefined ? settings[key] : defaults[key];
                    el.addEventListener('change', async () => {
                        await chrome.storage.local.set({ [key]: el.checked });
                    });
                }
            }
        } catch (e) {
            console.error('Failed to initialize settings:', e);
        }
    }

    async loadStatus() {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
            this.updateUI(response || {});
        } catch (error) {
            this.updateUI({ connected: false, discord: false, currentAnime: null });
        }
    }

    async clearPresence() {
        try {
            await chrome.runtime.sendMessage({ type: 'CLEAR_PRESENCE' });
            this.loadStatus();
        } catch (error) {
            console.error('Failed to clear presence:', error);
        }
    }

    setAccent(rgb) {
        document.documentElement.style.setProperty('--accent-rgb', rgb || DEFAULT_ACCENT);
    }

    async updateAccentColor(anime) {
        if (!anime || anime.privacyMode) {
            this.activeAccentKey = null;
            this.setAccent(DEFAULT_ACCENT);
            return;
        }

        const key = `${anime.coverArt || ''}|${anime.themeColor || ''}`;
        if (this.activeAccentKey === key) return;
        this.activeAccentKey = key;

        if (this.colorCache[key]) {
            this.setAccent(this.colorCache[key]);
            return;
        }

        let sampled = null;
        if (anime.coverArt && /^https?:\/\//i.test(anime.coverArt)) {
            sampled = await this.sampleDominantColor(anime.coverArt);
        }
        if (!sampled && anime.themeColor) {
            sampled = parseThemeColor(anime.themeColor);
        }

        const finalRgb = sampled || DEFAULT_ACCENT;
        this.colorCache[key] = finalRgb;
        if (this.activeAccentKey === key) {
            this.setAccent(finalRgb);
        }
    }

    async sampleDominantColor(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const blob = await res.blob();
            const bitmap = await createImageBitmap(blob);

            const size = 24;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0, size, size);
            bitmap.close();

            const { data } = ctx.getImageData(0, 0, size, size);
            const buckets = Array.from({ length: 18 }, () => ({ score: 0, r: 0, g: 0, b: 0 }));

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
                if (a < 180) continue;

                const [h, s, l] = rgbToHsl(r, g, b);
                if (l < 0.20 || l > 0.85 || s < 0.22) continue;

                // Favor clean vibrant hues over murky low-saturation tones
                const weight = s * s * (1 - Math.abs(l - 0.54));
                const idx = Math.floor(h / 20) % 18;
                buckets[idx].score += weight;
                buckets[idx].r += r * weight;
                buckets[idx].g += g * weight;
                buckets[idx].b += b * weight;
            }

            let best = null;
            for (const b of buckets) {
                if (b.score > 0 && (!best || b.score > best.score)) {
                    best = b;
                }
            }
            if (!best) return null;

            return normalizeAccentRgb(
                best.r / best.score,
                best.g / best.score,
                best.b / best.score
            );
        } catch (e) {
            return null;
        }
    }

    updateUI(status) {
        const statusText = document.getElementById('statusText');
        const currentAnime = document.getElementById('currentAnime');

        if (status.connected && status.discord) {
            document.body.dataset.state = 'active';
            statusText.textContent = 'Live on Discord';
        } else if (status.connected) {
            document.body.dataset.state = 'standby';
            statusText.textContent = 'Waiting for Discord';
        } else {
            document.body.dataset.state = 'dim';
            statusText.textContent = 'Desktop App Offline';
        }

        if (status.currentAnime && status.currentAnime.title) {
            const anime = status.currentAnime;
            this.updateAccentColor(anime);

            const isPlaying = anime.isPlaying && !anime.isPaused;
            const playSvg = isPlaying
                ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .79.87 1.27 1.54.84l10.67-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z"/></svg>'
                : '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

            let progressText = '';
            let progressPct = 0;
            if (anime.progress !== undefined && anime.duration) {
                const elapsed = (isPlaying && anime.timestamp)
                    ? Math.max(0, Math.floor((Date.now() - anime.timestamp) / 1000))
                    : 0;
                const displayProgress = Math.min(anime.duration, anime.progress + elapsed);
                progressText = `${this.formatTime(displayProgress)} / ${this.formatTime(anime.duration)}`;
                progressPct = Math.min(100, Math.max(0, Math.round((displayProgress / anime.duration) * 100)));
            }

            currentAnime.innerHTML = `
                <div class="glass-card current-anime">
                    <div class="eyebrow">Currently Watching</div>
                    <div class="anime-title-row">
                        <span class="play-glyph" aria-hidden="true">${playSvg}</span>
                        <div class="anime-title">${this.escapeHtml(anime.title)}</div>
                    </div>
                    <div class="anime-meta">
                        ${anime.episode ? `<span>Episode ${anime.episode}</span>` : ''}
                        ${anime.episode && progressText ? '<span>•</span>' : ''}
                        ${progressText ? `<span class="time-readout">${progressText}</span>` : ''}
                        <span class="site-badge">${this.escapeHtml(anime.site || 'Miruro')}</span>
                    </div>
                    ${progressPct > 0 ? `
                        <div class="progress-track" aria-hidden="true">
                            <div class="progress-fill" style="width: ${progressPct}%"></div>
                        </div>
                    ` : ''}
                </div>
            `;
        } else {
            this.updateAccentColor(null);
            currentAnime.innerHTML = `
                <div class="glass-card no-anime">
                    No anime detected
                    <small>Start watching on Miruro or AnimePahe</small>
                </div>
            `;
        }
    }

    formatTime(seconds) {
        if (!seconds || seconds < 0) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

new PopupController();
