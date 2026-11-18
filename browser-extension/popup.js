class PopupController {
    constructor() {
        this.init();
        this.loadStatus();
    }

    init() {
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadStatus();
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearPresence();
        });

        document.getElementById('downloadLink').addEventListener('click', (e) => {
            e.preventDefault();
            alert('Desktop app setup instructions completed!');
        });
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
            currentAnime.innerHTML = `
                <div class="current-anime">
                    <h3>Currently Watching</h3>
                    <div class="anime-info">
                        <div><strong>${anime.title}</strong></div>
                        ${anime.episode ? `<div>Episode ${anime.episode}</div>` : ''}
                        ${anime.progress && anime.duration ? 
                            `<div>${this.formatTime(anime.progress)} / ${this.formatTime(anime.duration)}</div>` : 
                            ''
                        }
                        <div style="margin-top: 4px; color: #72767d;">
                            ${anime.site} • ${new Date(anime.timestamp).toLocaleTimeString()}
                        </div>
                    </div>
                </div>
            `;
        } else {
            currentAnime.innerHTML = `
                <div class="no-anime">
                    No anime detected<br>
                    <small>Start watching on Miruro!</small>
                </div>
            `;
        }
    }

    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

// Initialize when popup opens
new PopupController();
