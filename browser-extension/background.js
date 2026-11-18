// background.js - Enhanced background script with proper data handling

class BackgroundService {
    constructor() {
        this.currentActivity = null;
        this.serverUrl = 'http://localhost:3000';
        this.init();
    }

    init() {
        console.log('Anime Rich Presence: Background service started');
        
        // Listen for messages from content scripts
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep the message channel open for async response
        });
    }

    async handleMessage(message, sender, sendResponse) {
        console.log('Background received message:', message);
        
        try {
            switch (message.type) {
                case 'ANIME_UPDATE':
                    await this.updateActivity(message.data);
                    sendResponse({ success: true });
                    break;
                    
                case 'ANIME_CLEAR':
                    await this.clearActivity();
                    sendResponse({ success: true });
                    break;
                    
                case 'GET_STATUS':
                    const status = await this.getStatus();
                    sendResponse(status);
                    break;
                    
                case 'CLEAR_PRESENCE':
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
            this.currentActivity = activityData;
            
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
            this.currentActivity = null;
            
        } catch (error) {
            console.error('Failed to clear rich presence:', error);
            throw error;
        }
    }

    async getStatus() {
        try {
            const response = await fetch(`${this.serverUrl}/status`);
            
            if (!response.ok) {
                return {
                    connected: false,
                    currentAnime: null,
                    error: `HTTP ${response.status}`
                };
            }

            const status = await response.json();
            return {
                connected: status.connected || false,
                currentAnime: this.currentActivity,
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
