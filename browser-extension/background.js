// background.js - MV3-safe state manager & Discord bridge

const SUPPORTED_SITE_REGEX = /miruro|animepahe/i;

function isSupportedAnimeUrl(url) {
    return Boolean(url && /^https?:\/\//i.test(url) && SUPPORTED_SITE_REGEX.test(url));
}

class BackgroundService {
    constructor() {
        this.serverUrl = 'http://localhost:3000';
        this.memoryState = { tabStates: {}, currentActivity: null, lastServerOk: false, lastDiscordOk: false };
        this.lastIconKey = null;
        this.stateQueue = Promise.resolve();
        this.init();
    }

    init() {
        console.log('Anime Rich Presence: Background service worker started');

        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender)
                .then(res => sendResponse(res))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        });

        chrome.tabs.onRemoved.addListener((tabId) => {
            this.enqueue(async () => {
                const store = await this.loadState();
                if (store.tabStates[tabId]) {
                    delete store.tabStates[tabId];
                    await this.saveState(store);
                    await this.syncBestTab(store);
                }
            });
        });

        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.url) {
                if (!isSupportedAnimeUrl(changeInfo.url)) {
                    this.enqueue(async () => {
                        const store = await this.loadState();
                        if (store.tabStates[tabId]) {
                            delete store.tabStates[tabId];
                            await this.saveState(store);
                            await this.syncBestTab(store);
                        }
                    });
                }
            }
            if (changeInfo.status === 'complete' && tab && isSupportedAnimeUrl(tab.url)) {
                this.injectIfSupported(tabId);
            }
        });

        // Inject into main frame and dynamically spawned player iframes ONLY on supported anime tabs
        if (chrome.webNavigation) {
            chrome.webNavigation.onCompleted.addListener((details) => {
                if (!details || details.tabId < 0) return;
                if (details.url && (details.url === 'about:blank' || details.url.startsWith('chrome'))) return;
                this.injectIfSupported(details.tabId, details.frameId);
            });
        }

        chrome.tabs.onActivated.addListener(() => {
            this.enqueue(async () => {
                const store = await this.loadState();
                if (Object.keys(store.tabStates).length > 0) {
                    await this.syncBestTab(store);
                }
            });
        });

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local') {
                const keys = ['privacyMode', 'showEpisode', 'showProgress', 'showSiteBadge'];
                if (keys.some(k => k in changes)) {
                    this.enqueue(async () => {
                        const store = await this.loadState();
                        if (Object.keys(store.tabStates).length > 0) {
                            await this.syncBestTab(store);
                        }
                    });
                }
            }
        });

        if (chrome.alarms) {
            chrome.alarms.create('healthCheck', { periodInMinutes: 0.5 });
            chrome.alarms.onAlarm.addListener((alarm) => {
                if (alarm.name === 'healthCheck') {
                    this.enqueue(() => this.checkAndResyncIfNeeded());
                }
            });
        }

        if (chrome.runtime.onStartup) {
            chrome.runtime.onStartup.addListener(() => {
                this.enqueue(() => this.getStatus(true));
            });
        }

        // Update toolbar icon state immediately on service worker wake
        this.enqueue(() => this.getStatus(true));

        chrome.runtime.onInstalled.addListener(async () => {
            console.log('Extension loaded/updated. Injecting into open anime tabs...');
            try {
                const tabs = await chrome.tabs.query({});
                for (const tab of tabs) {
                    if (isSupportedAnimeUrl(tab.url)) {
                        await this.injectIfSupported(tab.id);
                    }
                }
            } catch (e) {}
        });
    }

    async injectIfSupported(tabId, frameId = null) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab || !isSupportedAnimeUrl(tab.url)) return;
            const target = (typeof frameId === 'number' && frameId >= 0)
                ? { tabId, frameIds: [frameId] }
                : { tabId, allFrames: true };
            await chrome.scripting.executeScript({
                target,
                files: ['content.js']
            });
        } catch (e) {
            // Ignore closed tabs or transient restricted frames
        }
    }

    // Serialize state read-modify-write operations to prevent MV3 race conditions
    enqueue(fn) {
        this.stateQueue = this.stateQueue.then(fn, fn);
        return this.stateQueue;
    }

    async loadState() {
        try {
            if (chrome.storage.session) {
                const data = await chrome.storage.session.get(['tabStates', 'currentActivity', 'lastServerOk', 'lastDiscordOk']);
                return {
                    tabStates: data.tabStates || {},
                    currentActivity: data.currentActivity || null,
                    lastServerOk: Boolean(data.lastServerOk),
                    lastDiscordOk: Boolean(data.lastDiscordOk)
                };
            }
        } catch (e) {}
        return this.memoryState;
    }

    async saveState(store) {
        this.memoryState = store;
        try {
            if (chrome.storage.session) {
                await chrome.storage.session.set(store);
            }
        } catch (e) {}
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

    async handleMessage(message, sender) {
        const tabId = sender.tab ? String(sender.tab.id) : 'default';

        switch (message.type) {
            case 'ANIME_UPDATE':
                return this.enqueue(async () => {
                    const store = await this.loadState();
                    store.tabStates[tabId] = {
                        metadata: {
                            title: message.data.title,
                            episode: message.data.episode,
                            site: message.data.site,
                            url: message.data.url,
                            coverArt: message.data.coverArt,
                            themeColor: message.data.themeColor || null
                        },
                        playback: {
                            progress: message.data.progress,
                            duration: message.data.duration,
                            isPlaying: message.data.isPlaying,
                            isPaused: message.data.isPaused
                        },
                        updatedAt: Date.now()
                    };
                    await this.saveState(store);
                    await this.syncBestTab(store, tabId);
                    return { success: true };
                });

            case 'ANIME_METADATA_UPDATE':
                return this.enqueue(async () => {
                    const store = await this.loadState();
                    const prev = store.tabStates[tabId] || {};
                    const prevTitle = prev.metadata && prev.metadata.title;
                    const prevEp = prev.metadata && prev.metadata.episode;
                    const episodeChanged = prevTitle !== message.data.title || prevEp !== message.data.episode;

                    store.tabStates[tabId] = {
                        metadata: message.data,
                        playback: episodeChanged ? null : (prev.playback || null),
                        updatedAt: Date.now()
                    };
                    await this.saveState(store);
                    await this.syncBestTab(store, tabId);
                    return { success: true };
                });

            case 'ANIME_PLAYBACK_UPDATE':
                return this.enqueue(async () => {
                    const store = await this.loadState();
                    const prev = store.tabStates[tabId] || {};
                    store.tabStates[tabId] = {
                        metadata: prev.metadata || null,
                        playback: message.data,
                        updatedAt: Date.now()
                    };
                    await this.saveState(store);
                    await this.syncBestTab(store, tabId);
                    return { success: true };
                });

            case 'ANIME_CLEAR':
                return this.enqueue(async () => {
                    const store = await this.loadState();
                    if (store.tabStates[tabId]) {
                        delete store.tabStates[tabId];
                        await this.saveState(store);
                    }
                    await this.syncBestTab(store);
                    return { success: true };
                });

            case 'CLEAR_PRESENCE':
                return this.enqueue(async () => {
                    const store = await this.loadState();
                    store.tabStates = {};
                    store.currentActivity = null;
                    await this.saveState(store);
                    await this.clearServerActivity();
                    return { success: true };
                });

            case 'GET_STATUS':
                return this.enqueue(async () => this.getStatus(true));

            default:
                return { success: false, error: 'Unknown message type' };
        }
    }

    async pruneClosedTabs(store) {
        const keys = Object.keys(store.tabStates).filter(k => k !== 'default');
        if (keys.length === 0) return;
        try {
            const tabs = await chrome.tabs.query({});
            const openIds = new Set(tabs.map(t => String(t.id)));
            let changed = false;
            for (const id of keys) {
                if (!openIds.has(id)) {
                    delete store.tabStates[id];
                    changed = true;
                }
            }
            if (changed) {
                await this.saveState(store);
            }
        } catch (e) {}
    }

    async selectBestTabId(store) {
        await this.pruneClosedTabs(store);
        const entries = Object.entries(store.tabStates).filter(([, s]) => s && s.metadata && s.metadata.title);
        if (entries.length === 0) return null;

        // 1. Prefer an actively playing tab
        const playing = entries
            .filter(([, s]) => s.playback && s.playback.isPlaying && !s.playback.isPaused)
            .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        if (playing.length > 0) return playing[0][0];

        // 2. Otherwise prefer the currently focused browser tab
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab) {
                const activeId = String(activeTab.id);
                if (store.tabStates[activeId] && store.tabStates[activeId].metadata && store.tabStates[activeId].metadata.title) {
                    return activeId;
                }
            }
        } catch (e) {}

        // 3. Fallback to most recently updated tab
        entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        return entries[0][0];
    }

    async syncBestTab(store, sourceTabId = null) {
        const bestId = await this.selectBestTabId(store);
        if (!bestId) {
            if (store.currentActivity) {
                store.currentActivity = null;
                await this.saveState(store);
                await this.clearServerActivity();
            }
            return;
        }

        // Only push if the source tab is the active/winning tab (or on tab switch/settings change)
        if (sourceTabId && sourceTabId !== bestId) {
            return;
        }

        const state = store.tabStates[bestId];
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

        store.currentActivity = activityData;
        await this.saveState(store);
        await this.sendToServer(activityData);
    }

    async updateToolbarIcon(connected, discord, currentAnime) {
        let mode = 'dim';
        let title = 'Anime Rich Presence • Desktop App Disconnected';

        if (connected && discord) {
            mode = 'active';
            title = (currentAnime && currentAnime.title)
                ? `Anime Rich Presence • ${currentAnime.title}`
                : 'Anime Rich Presence • Connected to Discord';
        } else if (connected) {
            mode = 'standby';
            title = 'Anime Rich Presence • Waiting for Discord';
        }

        const iconKey = `${mode}|${title}`;
        if (this.lastIconKey === iconKey) return;
        this.lastIconKey = iconKey;

        try {
            await chrome.action.setIcon({
                path: {
                    16: `icons/icon-${mode}-16.png`,
                    32: `icons/icon-${mode}-32.png`,
                    48: `icons/icon-${mode}-48.png`,
                    128: `icons/icon-${mode}-128.png`
                }
            });
            await chrome.action.setTitle({ title });
        } catch (e) {}
    }

    async sendToServer(activityData) {
        if (!activityData || !activityData.title) return false;
        try {
            const res = await fetch(`${this.serverUrl}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(activityData)
            });
            if (res.ok) {
                const body = await res.json().catch(() => ({}));
                await this.updateToolbarIcon(true, Boolean(body.discord), activityData);
                return true;
            }
            return false;
        } catch (err) {
            await this.updateToolbarIcon(false, false, null);
            return false;
        }
    }

    async clearServerActivity() {
        try {
            await fetch(`${this.serverUrl}/clear`, { method: 'POST' });
        } catch (err) {}
    }

    async checkAndResyncIfNeeded() {
        await this.getStatus(true);
    }

    async getStatus(resyncOnReconnect = false) {
        const store = await this.loadState();
        let connected = false;
        let discord = false;

        try {
            const res = await fetch(`${this.serverUrl}/status`);
            if (res.ok) {
                const data = await res.json();
                connected = Boolean(data.connected);
                discord = Boolean(data.discord);
            }
        } catch (err) {}

        const reconnected = (!store.lastServerOk && connected) || (!store.lastDiscordOk && discord);
        store.lastServerOk = connected;
        store.lastDiscordOk = discord;
        await this.saveState(store);

        await this.updateToolbarIcon(connected, discord, store.currentActivity);

        if (resyncOnReconnect && reconnected && connected && Object.keys(store.tabStates).length > 0) {
            await this.syncBestTab(store);
        }

        return {
            connected,
            discord,
            currentAnime: store.currentActivity
        };
    }
}

new BackgroundService();
