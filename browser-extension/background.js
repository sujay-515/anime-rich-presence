// background.js - Universal state manager & Discord bridge

class BackgroundService {
    constructor() {
        this.serverUrl = 'http://localhost:3000';
        this.currentActivity = null;
        this.tabStates = {}; // tabId -> { metadata: null, playback: null }
        this.init();
    }

    init() {
        console.log('Anime Rich Presence: Background service worker started');

        // Listen for messages from content scripts (top frame and iframes)
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true;
        });

        // Tab removed cleanup
        chrome.tabs.onRemoved.addListener(async (tabId) => {
            if (this.tabStates[tabId]) {
                delete this.tabStates[tabId];
                if (Object.keys(this.tabStates).length === 0) {
                    await this.clearActivity();
                } else {
                    const remainingTabId = Object.keys(this.tabStates)[0];
                    await this.syncPresence(remainingTabId);
                }
            }
        });

        // Tab updated / navigated
        chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
            if (changeInfo.url) {
                const isSupported = /miruro|animepahe/i.test(changeInfo.url);
                if (!isSupported && this.tabStates[tabId]) {
                    delete this.tabStates[tabId];
                    if (Object.keys(this.tabStates).length === 0) {
                        await this.clearActivity();
                    }
                }
            }
        });

        // Re-sync presence when user changes display settings
        chrome.storage.onChanged.addListener(async (changes, areaName) => {
            if (areaName === 'local') {
                const keys = ['privacyMode', 'showEpisode', 'showProgress', 'showSiteBadge'];
                if (keys.some(k => k in changes) && this.currentActivity) {
                    await this.sendToServer(this.currentActivity);
                }
            }
        });

        // Programmatic injection on install or update for all open anime tabs
        chrome.runtime.onInstalled.addListener(async () => {
            console.log('Extension loaded/updated. Injecting into all open anime tabs...');
            try {
                const tabs = await chrome.tabs.query({});
                for (const tab of tabs) {
                    if (tab.url && (tab.url.includes('miruro') || tab.url.includes('animepahe'))) {
                        try {
                            await chrome.scripting.executeScript({
                                target: { tabId: tab.id, allFrames: true },
                                files: ['content.js']
                            });
                        } catch (e) {}
                    }
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
        const tabId = sender.tab ? sender.tab.id : 'default';

        try {
            switch (message.type) {
                case 'ANIME_UPDATE':
                    if (!this.tabStates[tabId]) this.tabStates[tabId] = {};
                    this.tabStates[tabId].metadata = {
                        title: message.data.title,
                        episode: message.data.episode,
                        site: message.data.site,
                        url: message.data.url,
                        coverArt: message.data.coverArt
                    };
                    this.tabStates[tabId].playback = {
                        progress: message.data.progress,
                        duration: message.data.duration,
                        isPlaying: message.data.isPlaying,
                        isPaused: message.data.isPaused
                    };
                    await this.syncPresence(tabId);
                    sendResponse({ success: true });
                    break;

                case 'ANIME_METADATA_UPDATE':
                    if (!this.tabStates[tabId]) this.tabStates[tabId] = {};
                    this.tabStates[tabId].metadata = message.data;
                    await this.syncPresence(tabId);
                    sendResponse({ success: true });
                    break;

                case 'ANIME_PLAYBACK_UPDATE':
                    if (!this.tabStates[tabId]) this.tabStates[tabId] = {};
                    this.tabStates[tabId].playback = message.data;
                    await this.syncPresence(tabId);
                    sendResponse({ success: true });
                    break;

                case 'ANIME_CLEAR':
                    if (this.tabStates[tabId]) {
                        delete this.tabStates[tabId];
                    }
                    if (Object.keys(this.tabStates).length === 0) {
                        await this.clearActivity();
                    }
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

    async syncPresence(tabId) {
        const state = this.tabStates[tabId];
        if (!state || !state.metadata || !state.metadata.title) return;

        const metadata = state.metadata;
        const playback = state.playback || {
            progress: 0,
            duration: 0,
            isPlaying: true,
            isPaused: false
        };

        const settings = await this.getSettings();
        const activityData = Object.assign({}, metadata, playback, settings, {
            timestamp: Date.now()
        });

        this.currentActivity = activityData;
        await this.sendToServer(activityData);
    }

    async sendToServer(activityData) {
        if (!activityData || !activityData.title) return;

        try {
            await fetch(`${this.serverUrl}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(activityData)
            });
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
