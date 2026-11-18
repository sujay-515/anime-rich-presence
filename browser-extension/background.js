// background.js - Background script managing connection to Discord and tab state merging

class BackgroundService {
    constructor() {
        this.serverUrl = 'http://localhost:3000';
        this.isServerConnected = false;
        this.isDiscordConnected = false;
        this.init();
    }

    init() {
        console.log('Anime Rich Presence: Background service started');
        
        // Clean stale tab states on startup
        this.cleanStaleTabStates();

        // Listen for messages from content scripts
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep the message channel open for async response
        });

        // Clean up tab states when tabs are closed
        chrome.tabs.onRemoved.addListener(async (tabId) => {
            const tabStates = await this.getTabStates();
            if (tabStates[tabId]) {
                console.log(`Tab ${tabId} closed, clearing state.`);
                delete tabStates[tabId];
                await this.saveTabStates(tabStates);
                await this.updatePresenceFromStorage();
            }
        });

        // Clean up tab states when pages in tabs change
        chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
            if (changeInfo.url) {
                const isSupported = /miruro|animepahe|kwik/.test(changeInfo.url);
                const tabStates = await this.getTabStates();
                if (!isSupported && tabStates[tabId]) {
                    console.log(`Tab ${tabId} navigated to unsupported site, clearing state.`);
                    delete tabStates[tabId];
                    await this.saveTabStates(tabStates);
                    await this.updatePresenceFromStorage();
                }
            }
        });

        // Query active/playing state on tab activation (focus change)
        chrome.tabs.onActivated.addListener(async (activeInfo) => {
            await this.updatePresenceFromStorage();
        });

        // Listen for settings changes to trigger instant Discord updates
        chrome.storage.onChanged.addListener(async (changes, areaName) => {
            if (areaName === 'local') {
                const keys = ['privacyMode', 'showEpisode', 'showProgress', 'showSiteBadge'];
                const keyChanged = keys.some(key => key in changes);
                if (keyChanged) {
                    console.log('Display settings changed, updating presence...');
                    await this.updatePresenceFromStorage();
                }
            }
        });

        // Programmatic injection on install or reload
        chrome.runtime.onInstalled.addListener(async () => {
            console.log('Extension installed/reloaded. Injected content scripts into existing tabs...');
            try {
                const tabs = await chrome.tabs.query({
                    url: [
                        "*://*.miruro.tv/*",
                        "*://*.miruro.to/*",
                        "*://*.miruro.cx/*",
                        "*://*.animepahe.pw/*",
                        "*://*.animepahe.com/*",
                        "*://*.animepahe.ru/*",
                        "*://*.animepahe.org/*",
                        "*://*.kwik.si/*",
                        "*://*.kwik.cx/*"
                    ]
                });

                for (const tab of tabs) {
                    console.log(`Programmatically injecting content script into: ${tab.id} - ${tab.url}`);
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id, allFrames: true },
                            files: ['content.js']
                        });
                    } catch (err) {
                        console.warn(`Failed injection into tab ${tab.id}:`, err);
                    }
                }
            } catch (e) {
                console.error('Error during programmatic injection:', e);
            }
        });

        // Poll server connection status every 5 seconds
        setInterval(() => this.checkServerConnection(), 5000);
        this.checkServerConnection();
    }

    async getTabStates() {
        const storage = await chrome.storage.local.get('tabStates');
        return storage.tabStates || {};
    }

    async saveTabStates(tabStates) {
        await chrome.storage.local.set({ tabStates });
    }

    async cleanStaleTabStates() {
        try {
            const tabStates = await this.getTabStates();
            const tabs = await chrome.tabs.query({});
            const activeTabIds = new Set(tabs.map(t => t.id));

            let changed = false;
            for (const tabId in tabStates) {
                if (!activeTabIds.has(parseInt(tabId, 10))) {
                    console.log(`Cleaning up stale tab state for tab: ${tabId}`);
                    delete tabStates[tabId];
                    changed = true;
                }
            }

            if (changed) {
                await this.saveTabStates(tabStates);
            }
        } catch (e) {
            console.error('Error cleaning up stale tab states:', e);
        }
    }

    async checkServerConnection() {
        try {
            const response = await fetch(`${this.serverUrl}/status`);
            if (response.ok) {
                const status = await response.json();
                const isDiscordConnected = status.connected && status.discord;
                
                if (isDiscordConnected && !this.isDiscordConnected) {
                    console.log('Anime Rich Presence: Discord connection established! Re-sending current activity...');
                    this.isDiscordConnected = true;
                    this.isServerConnected = true;
                    await this.updatePresenceFromStorage();
                } else if (!isDiscordConnected) {
                    this.isDiscordConnected = false;
                    this.isServerConnected = true;
                } else {
                    this.isServerConnected = true;
                }
            } else {
                this.isServerConnected = false;
                this.isDiscordConnected = false;
            }
        } catch (e) {
            this.isServerConnected = false;
            this.isDiscordConnected = false;
        }
    }

    async handleMessage(message, sender, sendResponse) {
        console.log('Background received message:', message);
        const tabId = sender.tab ? sender.tab.id : null;
        
        try {
            switch (message.type) {
                case 'ANIME_UPDATE':
                    if (tabId) {
                        const tabStates = await this.getTabStates();
                        tabStates[tabId] = message.data;
                        await this.saveTabStates(tabStates);
                        await this.checkAndSendMergedUpdate(tabId, tabStates);
                    }
                    sendResponse({ success: true });
                    break;
                    
                case 'ANIME_METADATA_UPDATE':
                    if (tabId) {
                        const tabStates = await this.getTabStates();
                        if (!tabStates[tabId]) tabStates[tabId] = {};
                        Object.assign(tabStates[tabId], message.data);
                        await this.saveTabStates(tabStates);
                        await this.checkAndSendMergedUpdate(tabId, tabStates);
                    }
                    sendResponse({ success: true });
                    break;

                case 'ANIME_PLAYBACK_UPDATE':
                    if (tabId) {
                        const tabStates = await this.getTabStates();
                        if (!tabStates[tabId]) tabStates[tabId] = {};
                        Object.assign(tabStates[tabId], message.data);
                        await this.saveTabStates(tabStates);
                        await this.checkAndSendMergedUpdate(tabId, tabStates);
                    }
                    sendResponse({ success: true });
                    break;

                case 'ANIME_CLEAR':
                    if (tabId) {
                        const tabStates = await this.getTabStates();
                        if (tabStates[tabId]) {
                            delete tabStates[tabId];
                            await this.saveTabStates(tabStates);
                        }
                    }
                    await this.updatePresenceFromStorage();
                    sendResponse({ success: true });
                    break;
                    
                case 'GET_STATUS':
                    const status = await this.getStatus();
                    sendResponse(status);
                    break;
                    
                case 'CLEAR_PRESENCE':
                    if (tabId) {
                        const tabStates = await this.getTabStates();
                        if (tabStates[tabId]) {
                            delete tabStates[tabId];
                            await this.saveTabStates(tabStates);
                        }
                    }
                    await this.clearActivity();
                    sendResponse({ success: true });
                    break;
                    
                default:
                    console.warn('Unknown message type:', message.type);
                    sendResponse({ success: false, error: 'Unknown message type' });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            sendResponse({ success: false, error: error.message });
        }
    }

    async getActiveAnimeState(tabStates) {
        let bestState = null;

        // 1. Check if any tab is playing
        for (const tabId in tabStates) {
            const state = tabStates[tabId];
            if (state.isPlaying && !state.isPaused) {
                if (!bestState || state.timestamp > bestState.timestamp) {
                    bestState = state;
                }
            }
        }

        // 2. If nothing is playing, find the active tab in current window
        if (!bestState) {
            try {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    const activeTabId = tabs[0].id;
                    if (tabStates[activeTabId]) {
                        bestState = tabStates[activeTabId];
                    }
                }
            } catch (e) {
                console.error('Error querying active tab:', e);
            }
        }

        // 3. If still nothing, find the most recently updated tab state
        if (!bestState) {
            for (const tabId in tabStates) {
                const state = tabStates[tabId];
                if (!bestState || state.timestamp > bestState.timestamp) {
                    bestState = state;
                }
            }
        }

        return bestState;
    }

    async updatePresenceFromStorage() {
        const tabStates = await this.getTabStates();
        const bestState = await this.getActiveAnimeState(tabStates);
        
        if (bestState) {
            // Load formatting settings from storage to apply on manual trigger
            const settings = await chrome.storage.local.get([
                'privacyMode', 
                'showEpisode', 
                'showProgress', 
                'showSiteBadge'
            ]);
            
            const mergedState = Object.assign({}, bestState, {
                privacyMode: settings.privacyMode !== undefined ? settings.privacyMode : false,
                showEpisode: settings.showEpisode !== undefined ? settings.showEpisode : true,
                showProgress: settings.showProgress !== undefined ? settings.showProgress : true,
                showSiteBadge: settings.showSiteBadge !== undefined ? settings.showSiteBadge : true
            });
            
            await this.updateActivity(mergedState);
        } else {
            await this.clearActivity();
        }
    }

    async checkAndSendMergedUpdate(tabId, tabStates) {
        if (!tabStates) {
            tabStates = await this.getTabStates();
        }
        const state = tabStates[tabId];
        if (!state) return;

        if (state.title && state.progress !== undefined && state.duration !== undefined) {
            // Load formatting settings from storage
            const settings = await chrome.storage.local.get([
                'privacyMode', 
                'showEpisode', 
                'showProgress', 
                'showSiteBadge'
            ]);
            
            const mergedData = {
                title: state.title,
                episode: state.episode || null,
                progress: state.progress,
                duration: state.duration,
                isPlaying: state.isPlaying !== undefined ? state.isPlaying : true,
                isPaused: state.isPaused !== undefined ? state.isPaused : false,
                site: state.site || 'AnimePahe',
                url: state.url || '',
                coverArt: state.coverArt || null,
                timestamp: Date.now(),
                
                // Sync formatting toggles
                privacyMode: settings.privacyMode !== undefined ? settings.privacyMode : false,
                showEpisode: settings.showEpisode !== undefined ? settings.showEpisode : true,
                showProgress: settings.showProgress !== undefined ? settings.showProgress : true,
                showSiteBadge: settings.showSiteBadge !== undefined ? settings.showSiteBadge : true
            };

            const bestState = await this.getActiveAnimeState(tabStates);
            if (bestState && bestState.title === mergedData.title && bestState.episode === mergedData.episode) {
                await this.updateActivity(mergedData);
            }
        }
    }

    async updateActivity(activityData) {
        console.log('Updating rich presence:', activityData);
        
        if (!activityData || !activityData.title) {
            console.warn('Invalid activity data:', activityData);
            return;
        }

        try {
            const response = await fetch(`${this.serverUrl}/update`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(activityData)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
            console.log('Rich presence updated successfully:', result);
            
        } catch (error) {
            console.error('Failed to update rich presence:', error);
            throw error;
        }
    }

    async clearActivity() {
        console.log('Clearing rich presence');
        
        try {
            const response = await fetch(`${this.serverUrl}/clear`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            console.log('Rich presence cleared successfully');
            
        } catch (error) {
            console.error('Failed to clear rich presence:', error);
            throw error;
        }
    }

    async getStatus() {
        try {
            const response = await fetch(`${this.serverUrl}/status`);
            const tabStates = await this.getTabStates();
            const activeAnime = await this.getActiveAnimeState(tabStates);
            
            if (!response.ok) {
                return {
                    connected: false,
                    currentAnime: activeAnime,
                    error: `HTTP ${response.status}`
                };
            }

            const status = await response.json();
            return {
                connected: status.connected || false,
                currentAnime: activeAnime,
                serverStatus: status
            };
            
        } catch (error) {
            console.error('Failed to get status:', error);
            return {
                connected: false,
                currentAnime: null,
                error: error.message
            };
        }
    }
}

// Initialize the background service
new BackgroundService();
