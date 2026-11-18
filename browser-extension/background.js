// background.js - Unified background service worker

class BackgroundService {
    constructor() {
        this.serverUrl = 'http://localhost:3000';
        this.currentActivity = null;
        this.tabStates = {};
        this.init();
    }

    init() {
        console.log('Anime Rich Presence: Unified background service started');

        // Message handler
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true;
        });

        // Tab closed cleanup
        chrome.tabs.onRemoved.addListener(async (tabId) => {
            if (this.tabStates[tabId]) {
                const wasCurrent = this.currentActivity && this.tabStates[tabId].title === this.currentActivity.title;
                delete this.tabStates[tabId];
                if (wasCurrent) {
                    await this.clearActivity();
                }
            }
        });

        // Settings change listener - instantly re-sync presence with new toggles
        chrome.storage.onChanged.addListener(async (changes, areaName) => {
            if (areaName === 'local' && this.currentActivity) {
                const keys = ['privacyMode', 'showEpisode', 'showProgress', 'showSiteBadge'];
                if (keys.some(k => k in changes)) {
                    await this.updateActivity(this.currentActivity);
                }
            }
        });

        // Programmatic injection on install or extension reload
        chrome.runtime.onInstalled.addListener(async () => {
            console.log('Extension installed/reloaded. Injecting into open anime tabs...');
            try {
                const tabs = await chrome.tabs.query({
                    url: [
                        "*://*.miruro.tv/*",
                        "*://*.miruro.to/*",
                        "*://*.miruro.cx/*",
                        "*://*.animepahe.pw/*",
                        "*://*.animepahe.com/*",
                        "*://*.animepahe.ru/*",
                        "*://*.animepahe.si/*",
                        "*://*.animepahe.org/*",
                        "*://*.kwik.si/*",
                        "*://*.kwik.cx/*"
                    ]
                });

                for (const tab of tabs) {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id, allFrames: true },
                            files: ['content.js']
                        });
                    } catch (err) {}
                }
            } catch (e) {}
        });
    }

    async getSettings() {
        const defaults = {
            privacyMode: false,
            showEpisode: true,
            showProgress: true,
            showSiteBadge: true
        };
        try {
            const stored = await chrome.storage.local.get(Object.keys(defaults));
            return {
                privacyMode: stored.privacyMode !== undefined ? stored.privacyMode : defaults.privacyMode,
                showEpisode: stored.showEpisode !== undefined ? stored.showEpisode : defaults.showEpisode,
                showProgress: stored.showProgress !== undefined ? stored.showProgress : defaults.showProgress,
                showSiteBadge: stored.showSiteBadge !== undefined ? stored.showSiteBadge : defaults.showSiteBadge
            };
        } catch (e) {
            return defaults;
        }
    }

    async handleMessage(message, sender, sendResponse) {
        const tabId = sender.tab ? sender.tab.id : null;

        try {
            switch (message.type) {
                case 'ANIME_UPDATE':
                    if (tabId) {
                        this.tabStates[tabId] = message.data;
                    }
                    await this.updateActivity(message.data);
                    sendResponse({ success: true });
                    break;

                case 'ANIME_METADATA_UPDATE':
                    if (tabId) {
                        this.tabStates[tabId] = Object.assign(this.tabStates[tabId] || {}, message.data);
                        await this.checkMergedTabUpdate(tabId);
                    }
                    sendResponse({ success: true });
                    break;

                case 'ANIME_PLAYBACK_UPDATE':
                    if (tabId) {
                        this.tabStates[tabId] = Object.assign(this.tabStates[tabId] || {}, message.data);
                        await this.checkMergedTabUpdate(tabId);
                    }
                    sendResponse({ success: true });
                    break;

                case 'ANIME_CLEAR':
                    if (tabId && this.tabStates[tabId]) {
                        delete this.tabStates[tabId];
                    }
                    await this.clearActivity();
                    sendResponse({ success: true });
                    break;

                case 'CLEAR_PRESENCE':
                    this.tabStates = {};
                    await this.clearActivity();
                    sendResponse({ success: true });
                    break;

                case 'GET_STATUS':
                    const status = await this.getStatus();
                    sendResponse(status);
                    break;

                default:
                    sendResponse({ success: false, error: 'Unknown message type' });
            }
        } catch (err) {
            console.error('Error handling message:', err);
            sendResponse({ success: false, error: err.message });
        }
    }

    async checkMergedTabUpdate(tabId) {
        const state = this.tabStates[tabId];
        if (!state || !state.title) return;

        // If playback info is present (progress and duration)
        if (state.progress !== undefined && state.duration !== undefined) {
            await this.updateActivity(state);
        }
    }

    async updateActivity(activityData) {
        if (!activityData || !activityData.title) return;

        const settings = await this.getSettings();
        const payload = Object.assign({}, activityData, settings, {
            timestamp: Date.now()
        });

        try {
            const res = await fetch(`${this.serverUrl}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                this.currentActivity = payload;
            }
        } catch (err) {
            console.warn('Backend server unreachable:', err.message);
        }
    }

    async clearActivity() {
        this.currentActivity = null;
        try {
            await fetch(`${this.serverUrl}/clear`, { method: 'POST' });
        } catch (err) {}
    }

    async getStatus() {
        try {
            const res = await fetch(`${this.serverUrl}/status`);
            if (res.ok) {
                const data = await res.json();
                return {
                    connected: data.connected || false,
                    discord: data.discord || false,
                    currentAnime: this.currentActivity
                };
            }
        } catch (err) {}

        return {
            connected: false,
            discord: false,
            currentAnime: null
        };
    }
}

new BackgroundService();
