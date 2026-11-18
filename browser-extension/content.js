// content.js - Multi-site detector for Miruro, AnimePahe, and Kwik Player

(() => {
    function cleanAnimeTitle(title) {
        if (!title) return title;
        let cleaned = title;
        // Remove common release/format/subtitle tags
        cleaned = cleaned.replace(/\[\d+p\]/gi, ''); // [1080p]
        cleaned = cleaned.replace(/\b(Dual[- ]Audio|Uncensored|BD|Blu[- ]Ray|Multi[- ]Subs)\b/gi, '');
        // Clean empty brackets and parentheses
        cleaned = cleaned.replace(/\(\s*\)|\[\s*\]/g, '');
        // Normalize spaces
        cleaned = cleaned.replace(/\s+/g, ' ');
        return cleaned.trim();
    }

    class MiruroDetector {
        constructor() {
            this.lastData = null;
            this.updateInterval = null;
            this.videoElement = null;
            this.attachedVideoElement = null;
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
            this.updateInterval = setInterval(() => this.checkForAnime(), 3000);
            this.checkForAnime();
        }

        checkForAnime() {
            if (!chrome.runtime || !chrome.runtime.id) {
                this.stop();
                return;
            }
            try {
                const animeData = this.extractAnimeInfo();
                
                if (animeData) {
                    if (this.videoElement) {
                        this.setupEvents(this.videoElement);
                    }
                    if (this.hasDataChanged(animeData)) {
                        console.log('MiruroDetector: Sending anime update to background:', animeData);
                        this.sendToBackground(animeData);
                        this.lastData = animeData;
                    }
                } else if (!animeData && this.lastData) {
                    this.sendClearMessage();
                    this.lastData = null;
                }
            } catch (error) {
                console.warn('Error detecting anime:', error.message);
            }
        }

        setupEvents(video) {
            if (this.attachedVideoElement === video) return;
            
            console.log('Anime Rich Presence: Attaching video event listeners to Miruro player');
            const handler = () => this.checkForAnime();
            ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'timeupdate', 'ratechange'].forEach(event => {
                video.addEventListener(event, handler);
            });
            this.attachedVideoElement = video;
        }

        extractAnimeInfo() {
            const videoElement = document.querySelector('video');
            if (!videoElement) return null;

            this.videoElement = videoElement;

            const isPlaying = !videoElement.paused && !videoElement.ended;
            
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
                coverArt: this.getCoverArtUrl()
            };
        }

        getAnimeTitle() {
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
                    title = title.replace(/^Watch\s+/i, '');
                    title = title.replace(/\s+Episode\s+\d+.*$/i, '');
                    title = title.replace(/\s+-\s+(Miruro|Episode).*$/i, '');
                    return cleanAnimeTitle(title);
                }
            }

            const pageTitle = document.title;
            if (pageTitle && pageTitle !== 'Miruro') {
                return cleanAnimeTitle(pageTitle.replace(/\s+-\s+Miruro.*$/i, ''));
            }

            return null;
        }

        getEpisodeNumber() {
            const urlMatch = window.location.href.match(/episode[/-](\d+)/i);
            if (urlMatch) return parseInt(urlMatch[1]);

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
                Math.abs(this.lastData.progress - newData.progress) > 3
            );
        }

        sendToBackground(data) {
            try {
                chrome.runtime.sendMessage({
                    type: 'ANIME_UPDATE',
                    data: data
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        return;
                    }
                });
            } catch (error) {
                // Extension context invalidated
            }
        }

        sendClearMessage() {
            try {
                chrome.runtime.sendMessage({
                    type: 'ANIME_CLEAR'
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        return;
                    }
                });
            } catch (error) {
                // Extension context invalidated
            }
        }

        stop() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
            }
        }
    }

    class AnimePaheDetector {
        constructor() {
            this.lastData = null;
            this.updateInterval = null;
            this.init();
        }

        init() {
            console.log('Anime Rich Presence: AnimePahe metadata detector loaded');
            this.updateInterval = setInterval(() => this.checkForMetadata(), 3000);
            this.checkForMetadata();
        }

        checkForMetadata() {
            if (!chrome.runtime || !chrome.runtime.id) {
                this.stop();
                return;
            }
            try {
                if (!window.location.pathname.includes('/play/')) {
                    if (this.lastData) {
                        chrome.runtime.sendMessage({ type: 'ANIME_CLEAR' });
                        this.lastData = null;
                    }
                    return;
                }

                const pageTitle = document.title;
                const cleaned = pageTitle.replace(/^Watch\s+/i, '');
                
                let match = cleaned.match(/^(.+?)\s+(?:Ep\.|Episode)\s*(\d+)/i);
                if (!match) {
                    match = cleaned.match(/^(.+?)\s+-\s+(\d+)/i);
                }
                
                if (!match) return;

                const title = cleanAnimeTitle(match[1]);
                const episode = parseInt(match[2], 10);

                const metadata = {
                    title,
                    episode,
                    site: 'AnimePahe',
                    url: window.location.href,
                    timestamp: Date.now()
                };

                if (this.hasDataChanged(metadata)) {
                    console.log('AnimePaheDetector: Sending metadata update to background:', metadata);
                    chrome.runtime.sendMessage({
                        type: 'ANIME_METADATA_UPDATE',
                        data: metadata
                    });
                    this.lastData = metadata;
                }
            } catch (error) {
                console.warn('Error in AnimePaheDetector:', error.message);
            }
        }

        hasDataChanged(newData) {
            if (!this.lastData) return true;
            return (
                this.lastData.title !== newData.title ||
                this.lastData.episode !== newData.episode ||
                this.lastData.url !== newData.url
            );
        }

        stop() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
            }
        }
    }

    class KwikDetector {
        constructor() {
            this.videoElement = null;
            this.lastData = null;
            this.updateInterval = null;
            this.attachedVideoElement = null;
            this.init();
        }

        init() {
            console.log('Anime Rich Presence: Kwik player playback detector loaded');
            this.updateInterval = setInterval(() => this.checkForVideo(), 2000);
            this.checkForVideo();
        }

        setupEvents(video) {
            if (this.attachedVideoElement === video) return;
            
            console.log('Anime Rich Presence: Attaching video event listeners to Kwik player');
            const handler = () => this.checkForVideo();
            ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'timeupdate', 'ratechange'].forEach(event => {
                video.addEventListener(event, handler);
            });
            this.attachedVideoElement = video;
        }

        checkForVideo() {
            if (!chrome.runtime || !chrome.runtime.id) {
                this.stop();
                return;
            }
            try {
                const videoElement = document.querySelector('video');
                if (!videoElement) {
                    return;
                }

                this.videoElement = videoElement;
                this.setupEvents(videoElement);

                const isPlaying = !videoElement.paused && !videoElement.ended;
                const isPaused = videoElement.paused;
                const progress = Math.floor(videoElement.currentTime);
                const duration = Math.floor(videoElement.duration || 0);

                const playbackData = {
                    progress,
                    duration,
                    isPlaying,
                    isPaused,
                    timestamp: Date.now()
                };

                if (this.hasDataChanged(playbackData)) {
                    console.log('KwikDetector: Sending playback update to background:', playbackData);
                    chrome.runtime.sendMessage({
                        type: 'ANIME_PLAYBACK_UPDATE',
                        data: playbackData
                    });
                    this.lastData = playbackData;
                }
            } catch (error) {
                console.warn('Error in KwikDetector:', error.message);
            }
        }

        hasDataChanged(newData) {
            if (!this.lastData) return true;
            return (
                this.lastData.isPlaying !== newData.isPlaying ||
                this.lastData.isPaused !== newData.isPaused ||
                Math.abs(this.lastData.progress - newData.progress) > 3 ||
                this.lastData.duration !== newData.duration
            );
        }

        stop() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
            }
        }
    }

    // Initialize appropriate detector based on host
    const host = window.location.host;
    console.log('Anime Rich Presence: Injected content script on host:', host);
    let detector = null;

    if (host.includes('miruro')) {
        detector = new MiruroDetector();
    } else if (host.includes('animepahe')) {
        detector = new AnimePaheDetector();
    } else if (host.includes('kwik')) {
        detector = new KwikDetector();
    }

    // Cleanup when page unloads
    window.addEventListener('beforeunload', () => {
        if (detector) {
            detector.stop();
            if (host.includes('animepahe') && chrome.runtime && chrome.runtime.id) {
                try {
                    chrome.runtime.sendMessage({ type: 'ANIME_CLEAR' });
                } catch (e) {
                    // Ignore context invalidations
                }
            }
        }
    });
})();
