class PopupController {
    constructor() {
        this.init();
        this.loadStatus();
        
        // Auto-refresh the popup interface every second while it is open
        this.refreshInterval = setInterval(() => this.loadStatus(), 1000);
    }

    async init() {
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadStatus();
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearPresence();
        });

        document.getElementById('downloadLink').addEventListener('click', (e) => {
            e.preventDefault();
            alert('Desktop app setup instructions: Run "python anime_rich_presence.py" inside your terminal within the virtual environment (source venv/bin/activate) and keep it running in the background!');
        });

        // Initialize toggle settings
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
                    const savedValue = settings[key];
                    el.checked = savedValue !== undefined ? savedValue : defaults[key];
                    
                    // Bind change handler
                    el.addEventListener('change', async () => {
                        await chrome.storage.local.set({ [key]: el.checked });
                    });
                }
            }
        } catch (e) {
            console.error('Failed to load display settings:', e);
        }
    }

    async loadStatus() {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
            this.updateUI(response);
        } catch (error) {
            console.error('Failed to get status:', error);
            this.updateUI({ connected: false, currentAnime: null });
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

        // Update connection status
        if (status.connected) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected to Discord';
        } else {
            statusDot.classList.remove('connected');
            statusText.textContent = 'Desktop app not running';
        }

        // Update current anime display
        if (status.currentAnime) {
            const anime = status.currentAnime;
            const progress = anime.progress || 0;
            const duration = anime.duration || 0;
            const progressPercent = duration > 0 ? minPercent(100, Math.round((progress / duration) * 100)) : 0;
            
            // Format labels
            const progressTime = this.formatTime(progress);
            const durationTime = this.formatTime(duration);
            const playStateSymbol = (anime.isPaused) ? '⏸️ Paused' : '▶️ Playing';

            currentAnime.innerHTML = `
                <div class="current-anime">
                    <h3>Currently Watching</h3>
                    <div class="anime-title">${anime.title}</div>
                    
                    <div class="anime-details">
                        <span>${anime.episode ? `Episode ${anime.episode}` : 'Watching'}</span>
                        <span class="site-badge">${anime.site || 'Miruro'}</span>
                    </div>

                    ${duration > 0 ? `
                        <div class="progress-container">
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${progressPercent}%"></div>
                            </div>
                            <div class="time-labels">
                                <span>${progressTime} / ${durationTime} (${progressPercent}%)</span>
                                <span>${playStateSymbol}</span>
                            </div>
                        </div>
                    ` : `
                        <div class="time-labels" style="justify-content: flex-end;">
                            <span>${playStateSymbol}</span>
                        </div>
                    `}
                </div>
            `;
        } else {
            currentAnime.innerHTML = `
                <div class="no-anime">
                    No anime detected<br>
                    <small>Start watching on Miruro or AnimePahe!</small>
                </div>
            `;
        }
    }

    formatTime(seconds) {
        if (!seconds || seconds < 0) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

// Helper utility to cap maximum values
function minPercent(max, val) {
    return Math.min(max, Math.max(0, val));
}

// Initialize when popup opens
new PopupController();
