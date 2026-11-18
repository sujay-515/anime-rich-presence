class PopupController {
    constructor() {
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

    updateUI(status) {
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const currentAnime = document.getElementById('currentAnime');

        statusDot.className = 'status-dot';

        if (status.connected && status.discord) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected to Discord';
        } else if (status.connected) {
            statusDot.classList.add('warn');
            statusText.textContent = 'Discord Not Running';
        } else {
            statusText.textContent = 'Desktop App Disconnected';
        }

        if (status.currentAnime && status.currentAnime.title) {
            const anime = status.currentAnime;
            const isPlaying = anime.isPlaying && !anime.isPaused;
            const statusIcon = isPlaying ? '▶️' : '⏸️';

            let progressText = '';
            if (anime.progress !== undefined && anime.duration) {
                progressText = `${this.formatTime(anime.progress)} / ${this.formatTime(anime.duration)}`;
            }

            currentAnime.innerHTML = `
                <div class="current-anime">
                    <h3>Currently Watching</h3>
                    <div class="anime-title">${statusIcon} ${this.escapeHtml(anime.title)}</div>
                    <div class="anime-meta">
                        ${anime.episode ? `<span>Episode ${anime.episode}</span>` : ''}
                        ${anime.episode && progressText ? '<span>•</span>' : ''}
                        ${progressText ? `<span>${progressText}</span>` : ''}
                        <span class="site-badge">${this.escapeHtml(anime.site || 'Miruro')}</span>
                    </div>
                </div>
            `;
        } else {
            currentAnime.innerHTML = `
                <div class="no-anime">
                    No anime detected
                    <small>Start watching on Miruro or AnimePahe!</small>
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
