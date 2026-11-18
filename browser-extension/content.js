// content.js - Enhanced Miruro detector with pause detection and error handling

class MiruroDetector {
    constructor() {
        this.lastData = null;
        this.updateInterval = null;
        this.videoElement = null;
        this.init();
    }

    init() {
        console.log('Anime Rich Presence: Enhanced Miruro detector loaded');
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.startMonitoring());
        } else {
            this.startMonitoring();
        }
    }

    startMonitoring() {
        // Check every 3 seconds for updates (more responsive)
        this.updateInterval = setInterval(() => this.checkForAnime(), 3000);
        this.checkForAnime();
    }

    checkForAnime() {
        try {
            const animeData = this.extractAnimeInfo();
            
            if (animeData && this.hasDataChanged(animeData)) {
                console.log('Anime data detected:', animeData);
                this.sendToBackground(animeData);
                this.lastData = animeData;
            } else if (!animeData && this.lastData) {
                // Clear activity if no anime is detected
                this.sendClearMessage();
                this.lastData = null;
            }
        } catch (error) {
            console.warn('Error detecting anime:', error.message);
        }
    }

    extractAnimeInfo() {
        // Find video element
        const videoElement = document.querySelector('video');
        if (!videoElement) return null;

        this.videoElement = videoElement;

        // Check if video is actually playing
        const isPlaying = !videoElement.paused && !videoElement.ended && videoElement.readyState > 2;
        
        const title = this.getAnimeTitle();
        const episode = this.getEpisodeNumber();
        const progress = this.getProgress(videoElement);
        const duration = this.getDuration(videoElement);
        
        if (!title) return null;

        return {
            title,
            episode,
            progress,
            duration,
            isPlaying,
            isPaused: videoElement.paused,
            timestamp: Date.now(),
            site: 'Miruro',
            url: window.location.href,
            coverArt: this.getCoverArtUrl() // Try to get cover art
        };
    }

    getAnimeTitle() {
        // Try multiple selectors for anime title
        const selectors = [
            'h1[class*="title"]',
            'h1',
            '[class*="anime-title"]',
            '[class*="series-title"]',
            'title'
        ];

        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element && element.textContent.trim()) {
                let title = element.textContent.trim();
                // Clean up title
                title = title.replace(/^Watch\s+/i, '');
                title = title.replace(/\s+Episode\s+\d+.*$/i, '');
                title = title.replace(/\s+-\s+(Miruro|Episode).*$/i, '');
                return title;
            }
        }

        // Extract from page title
        const pageTitle = document.title;
        if (pageTitle && pageTitle !== 'Miruro') {
            return pageTitle.replace(/\s+-\s+Miruro.*$/i, '').trim();
        }

        return null;
    }

    getEpisodeNumber() {
        // Look for episode number in URL first
        const urlMatch = window.location.href.match(/episode[/-](\d+)/i);
        if (urlMatch) return parseInt(urlMatch[1]);

        // Look in page content
        const episodeSelectors = [
            '[class*="episode"]',
            '[class*="ep-"]',
            '.episode-number'
        ];

        for (const selector of episodeSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
                const match = el.textContent.match(/(\d+)/);
                if (match) return parseInt(match[1]);
            }
        }

        return null;
    }

    getCoverArtUrl() {
        // Try to find anime cover art on the page
        const imageSelectors = [
            'img[class*="cover"]',
            'img[class*="poster"]',
            'img[class*="thumbnail"]',
            '.anime-cover img',
            '.poster img'
        ];

        for (const selector of imageSelectors) {
            const img = document.querySelector(selector);
            if (img && img.src && !img.src.includes('default')) {
                return img.src;
            }
        }

        return null;
    }

    getProgress(video) {
        if (!video) return 0;
        return Math.floor(video.currentTime);
    }

    getDuration(video) {
        if (!video || !video.duration) return 0;
        return Math.floor(video.duration);
    }

    hasDataChanged(newData) {
        if (!this.lastData) return true;
        
        return (
            this.lastData.title !== newData.title ||
            this.lastData.episode !== newData.episode ||
            this.lastData.isPlaying !== newData.isPlaying ||
            this.lastData.isPaused !== newData.isPaused ||
            Math.abs(this.lastData.progress - newData.progress) > 5 // Update if 5+ seconds difference
        );
    }

    sendToBackground(data) {
        try {
            chrome.runtime.sendMessage({
                type: 'ANIME_UPDATE',
                data: data
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('Extension context lost, will retry on next update');
                    return;
                }
            });
        } catch (error) {
            console.warn('Cannot send message - extension context invalidated');
        }
    }

    sendClearMessage() {
        try {
            chrome.runtime.sendMessage({
                type: 'ANIME_CLEAR'
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('Extension context lost, will retry on next update');
                    return;
                }
            });
        } catch (error) {
            console.warn('Cannot send clear message - extension context invalidated');
        }
    }

    stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
    }
}

// Initialize detector
const detector = new MiruroDetector();

// Cleanup when page unloads
window.addEventListener('beforeunload', () => {
    detector.stop();
});
