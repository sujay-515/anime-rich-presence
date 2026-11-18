// content.js - Multi-site detector for Miruro, AnimePahe, and Kwik Player

(() => {
    function cleanAnimeTitle(title) {
        if (!title) return '';
        let cleaned = title;
        // Strip common tags
        cleaned = cleaned.replace(/\[\d+p\]/gi, '');
        cleaned = cleaned.replace(/\b(Dual[- ]Audio|Uncensored|BD|Blu[- ]Ray|Multi[- ]Subs|Batch)\b/gi, '');
        cleaned = cleaned.replace(/\(\s*\)|\[\s*\]/g, '');
        cleaned = cleaned.replace(/\s+/g, ' ');
        return cleaned.trim();
    }

    function formatSlugTitle(slug) {
        if (!slug) return '';
        return slug
            .split(/[-_]+/)
            .filter(Boolean)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
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
            console.log('Anime Rich Presence: Miruro detector loaded on', window.location.href);
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.startMonitoring());
            } else {
                this.startMonitoring();
            }
        }

        startMonitoring() {
            this.updateInterval = setInterval(() => this.checkForAnime(), 2000);
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
                        console.log('MiruroDetector: Sending update:', animeData.title, animeData.isPlaying ? 'Playing' : 'Paused');
                        this.sendToBackground(animeData);
                        this.lastData = animeData;
                    }
                } else if (!animeData && this.lastData) {
                    this.sendClearMessage();
                    this.lastData = null;
                }
            } catch (error) {
                console.warn('Error in MiruroDetector:', error.message);
            }
        }

        setupEvents(video) {
            if (this.attachedVideoElement === video) return;
            console.log('Anime Rich Presence: Hooked video element events');
            const handler = () => this.checkForAnime();
            ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'timeupdate', 'ratechange'].forEach(ev => {
                video.addEventListener(ev, handler);
            });
            this.attachedVideoElement = video;
        }

        extractAnimeInfo() {
            // Find HTML5 video element
            const videoElement = document.querySelector('video');
            if (!videoElement) return null;

            this.videoElement = videoElement;

            const title = this.getAnimeTitle();
            if (!title) return null;

            const isPlaying = !videoElement.paused && !videoElement.ended;
            const episode = this.getEpisodeNumber();
            const progress = Math.floor(videoElement.currentTime || 0);
            const duration = Math.floor(videoElement.duration || 0);

            return {
                title,
                episode,
                progress,
                duration,
                isPlaying,
                isPaused: videoElement.paused,
                site: 'Miruro',
                url: window.location.href,
                coverArt: this.getCoverArtUrl(),
                timestamp: Date.now()
            };
        }

        getAnimeTitle() {
            // 1. Check JSON-LD metadata schema (Miruro's cleanest and most accurate source)
            const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLdScripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data && data.name && typeof data.name === 'string') {
                        const cleaned = cleanAnimeTitle(data.name);
                        if (cleaned && cleaned.toLowerCase() !== 'miruro') {
                            return cleaned;
                        }
                    }
                } catch (e) {
                    // Ignore JSON parsing errors
                }
            }

            // 2. Extract from URL slug: /watch/<id>/<slug>
            const urlPath = window.location.pathname;
            const slugMatch = urlPath.match(/\/watch\/[^/]+\/([^/?&#]+)/i);
            if (slugMatch && slugMatch[1]) {
                const slugTitle = formatSlugTitle(slugMatch[1]);
                if (slugTitle && slugTitle.toLowerCase() !== 'miruro') {
                    return slugTitle;
                }
            }

            // 3. OpenGraph / Twitter meta tags
            const ogTitle = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
            if (ogTitle && ogTitle.content) {
                const cleaned = cleanAnimeTitle(ogTitle.content.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*Miruro.*$/i, ''));
                if (cleaned && cleaned.toLowerCase() !== 'miruro') {
                    return cleaned;
                }
            }

            // 4. Common DOM title selectors
            const selectors = [
                'h1[class*="title"]',
                '.anime-title',
                '.series-title',
                '[data-anime-title]',
                'h1'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim()) {
                    let text = el.textContent.trim();
                    text = text.replace(/^Watch\s+/i, '');
                    text = text.replace(/\s+Episode\s+\d+.*$/i, '');
                    text = text.replace(/\s*[-|]\s*(Miruro|Episode).*$/i, '');
                    const cleaned = cleanAnimeTitle(text);
                    if (cleaned && cleaned.toLowerCase() !== 'miruro') {
                        return cleaned;
                    }
                }
            }

            // 5. Document title fallback
            const pageTitle = document.title;
            if (pageTitle && pageTitle.toLowerCase() !== 'miruro') {
                const cleaned = cleanAnimeTitle(pageTitle.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*Miruro.*$/i, ''));
                if (cleaned && cleaned.toLowerCase() !== 'miruro') {
                    return cleaned;
                }
            }

            return null;
        }

        getEpisodeNumber() {
            // 1. URL search param or path: ?ep=1, /ep-1, /episode/1
            const url = window.location.href;
            const epMatch = url.match(/(?:[?&]ep=|[/-]ep-|\/episode\/)(\d+)/i);
            if (epMatch) {
                return parseInt(epMatch[1], 10);
            }

            // 2. Look for active episode UI pill/text
            const episodeSelectors = [
                '[class*="active"] [class*="episode"]',
                '.episode-active',
                '.episode-number',
                '[class*="ep-item"][class*="active"]'
            ];
            for (const sel of episodeSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const match = el.textContent.match(/(\d+)/);
                    if (match) return parseInt(match[1], 10);
                }
            }

            // 3. Scan DOM text for "Episode X"
            const bodyText = document.body ? document.body.innerText : '';
            const match = bodyText.match(/\b(?:Episode|EP)\s*(\d+)\b/i);
            if (match) {
                return parseInt(match[1], 10);
            }

            return null;
        }

        getCoverArtUrl() {
            // 1. From JSON-LD
            const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLdScripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data && data.image) {
                        return data.image;
                    }
                } catch (e) {}
            }

            // 2. Poster / cover selectors
            const imageSelectors = [
                'img[class*="cover"]',
                'img[class*="poster"]',
                'img[class*="thumbnail"]',
                '.poster img'
            ];
            for (const selector of imageSelectors) {
                const img = document.querySelector(selector);
                if (img && img.src && !img.src.includes('default') && !img.src.includes('icon')) {
                    return img.src;
                }
            }

            return null;
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
                }, () => {
                    if (chrome.runtime.lastError) {}
                });
            } catch (err) {}
        }

        sendClearMessage() {
            try {
                chrome.runtime.sendMessage({ type: 'ANIME_CLEAR' }, () => {
                    if (chrome.runtime.lastError) {}
                });
            } catch (err) {}
        }

        stop() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
                this.updateInterval = null;
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
            console.log('Anime Rich Presence: AnimePahe detector loaded');
            this.updateInterval = setInterval(() => this.checkForMetadata(), 2000);
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

                // 1. Check .theatre-info h1 text (e.g. "Title - 01" or "Title")
                let title = null;
                let episode = null;

                const theatreH1 = document.querySelector('.theatre-info h1');
                if (theatreH1) {
                    const text = theatreH1.textContent.trim();
                    const match = text.match(/^(.+?)\s+-\s*(\d+)/i) || text.match(/^(.+?)\s+(?:Ep\.|Episode)\s*(\d+)/i);
                    if (match) {
                        title = cleanAnimeTitle(match[1]);
                        episode = parseInt(match[2], 10);
                    } else {
                        title = cleanAnimeTitle(text);
                    }
                }

                // 2. Fallback to document.title
                if (!title) {
                    const pageTitle = document.title.replace(/^Watch\s+/i, '');
                    const match = pageTitle.match(/^(.+?)\s+(?:Ep\.|Episode)\s*(\d+)/i) || pageTitle.match(/^(.+?)\s+-\s+(\d+)/i);
                    if (match) {
                        title = cleanAnimeTitle(match[1]);
                        episode = parseInt(match[2], 10);
                    }
                }

                if (!title) return;

                const metadata = {
                    title,
                    episode,
                    site: 'AnimePahe',
                    url: window.location.href,
                    timestamp: Date.now()
                };

                if (!this.lastData || this.lastData.title !== metadata.title || this.lastData.episode !== metadata.episode) {
                    console.log('AnimePaheDetector: Sending metadata update:', metadata);
                    chrome.runtime.sendMessage({
                        type: 'ANIME_METADATA_UPDATE',
                        data: metadata
                    });
                    this.lastData = metadata;
                }
            } catch (err) {
                console.warn('Error in AnimePaheDetector:', err.message);
            }
        }

        stop() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
                this.updateInterval = null;
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
            console.log('Anime Rich Presence: Kwik player detector loaded inside iframe');
            this.updateInterval = setInterval(() => this.checkForVideo(), 2000);
            this.checkForVideo();
        }

        setupEvents(video) {
            if (this.attachedVideoElement === video) return;
            const handler = () => this.checkForVideo();
            ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'timeupdate', 'ratechange'].forEach(ev => {
                video.addEventListener(ev, handler);
            });
            this.attachedVideoElement = video;
        }

        checkForVideo() {
            if (!chrome.runtime || !chrome.runtime.id) {
                this.stop();
                return;
            }

            try {
                const video = document.querySelector('video');
                if (!video) return;

                this.videoElement = video;
                this.setupEvents(video);

                const playbackData = {
                    progress: Math.floor(video.currentTime || 0),
                    duration: Math.floor(video.duration || 0),
                    isPlaying: !video.paused && !video.ended,
                    isPaused: video.paused,
                    timestamp: Date.now()
                };

                if (!this.lastData ||
                    this.lastData.isPlaying !== playbackData.isPlaying ||
                    this.lastData.isPaused !== playbackData.isPaused ||
                    Math.abs(this.lastData.progress - playbackData.progress) > 3) {
                    
                    chrome.runtime.sendMessage({
                        type: 'ANIME_PLAYBACK_UPDATE',
                        data: playbackData
                    });
                    this.lastData = playbackData;
                }
            } catch (err) {
                console.warn('Error in KwikDetector:', err.message);
            }
        }

        stop() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
                this.updateInterval = null;
            }
        }
    }

    // Determine host and run appropriate detector
    const host = window.location.host;
    let detector = null;

    if (host.includes('miruro')) {
        detector = new MiruroDetector();
    } else if (host.includes('animepahe')) {
        detector = new AnimePaheDetector();
    } else if (host.includes('kwik')) {
        detector = new KwikDetector();
    }

    window.addEventListener('beforeunload', () => {
        if (detector) {
            detector.stop();
            if (host.includes('miruro') || host.includes('animepahe')) {
                try {
                    chrome.runtime.sendMessage({ type: 'ANIME_CLEAR' });
                } catch (e) {}
            }
        }
    });
})();
