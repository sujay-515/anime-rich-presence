// content.js - Universal anime & video playback detector

(() => {
    const isTopFrame = (window.self === window.top);

    function cleanAnimeTitle(title) {
        if (!title) return '';
        let cleaned = title;
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

    function findVideoElement(root = document) {
        try {
            const video = root.querySelector('video');
            if (video) return video;

            // Search open Shadow DOM roots
            const all = root.querySelectorAll('*');
            for (const el of all) {
                if (el.shadowRoot) {
                    const v = findVideoElement(el.shadowRoot);
                    if (v) return v;
                }
            }

            // Search accessible same-origin iframes
            const iframes = root.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    if (iframe.contentDocument) {
                        const v = findVideoElement(iframe.contentDocument);
                        if (v) return v;
                    }
                } catch (e) {}
            }
        } catch (e) {}

        return null;
    }

    // ==========================================
    // TOP FRAME: Anime Metadata & Direct Player
    // ==========================================
    if (isTopFrame) {
        const host = window.location.hostname.toLowerCase();
        const isMiruro = host.includes('miruro');
        const isAnimePahe = host.includes('animepahe');

        if (!isMiruro && !isAnimePahe) {
            // Not a supported anime site at the top level
            return;
        }

        console.log(`Anime Rich Presence: Monitoring anime page on ${host}`);

        let lastMetadata = null;
        let lastPlayback = null;
        let attachedVideo = null;

        function extractMiruroMetadata() {
            // Only extract on watch pages
            if (!window.location.pathname.includes('/watch')) {
                return null;
            }

            let title = null;
            let coverArt = null;

            // 1. Check JSON-LD metadata schema (Miruro's primary structured data)
            const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLdScripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data && data.name && typeof data.name === 'string') {
                        const candidate = cleanAnimeTitle(data.name);
                        if (candidate && candidate.toLowerCase() !== 'miruro') {
                            title = candidate;
                            if (data.image) coverArt = data.image;
                            break;
                        }
                    }
                } catch (e) {}
            }

            // 2. Extract from URL slug: /watch/<id>/<slug>
            if (!title) {
                const pathParts = window.location.pathname.split('/').filter(Boolean);
                // Expected format: ['watch', '<id>', '<slug>']
                if (pathParts.length >= 3 && pathParts[0] === 'watch') {
                    const candidate = formatSlugTitle(pathParts[2]);
                    if (candidate && candidate.toLowerCase() !== 'miruro') {
                        title = candidate;
                    }
                }
            }

            // 3. OpenGraph / Twitter meta tags
            if (!title) {
                const meta = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
                if (meta && meta.content) {
                    const candidate = cleanAnimeTitle(meta.content.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*Miruro.*$/i, ''));
                    if (candidate && candidate.toLowerCase() !== 'miruro') {
                        title = candidate;
                    }
                }
            }

            // 4. Common DOM title selectors
            if (!title) {
                const selectors = ['h1[class*="title"]', '.anime-title', '.series-title', 'h1'];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.textContent.trim()) {
                        let text = el.textContent.trim();
                        text = text.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*(Miruro|Episode).*$/i, '');
                        const candidate = cleanAnimeTitle(text);
                        if (candidate && candidate.toLowerCase() !== 'miruro') {
                            title = candidate;
                            break;
                        }
                    }
                }
            }

            // 5. Document title fallback
            if (!title) {
                const pageTitle = document.title;
                if (pageTitle && pageTitle.toLowerCase() !== 'miruro') {
                    const candidate = cleanAnimeTitle(pageTitle.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*Miruro.*$/i, ''));
                    if (candidate && candidate.toLowerCase() !== 'miruro') {
                        title = candidate;
                    }
                }
            }

            if (!title) return null;

            // Episode extraction
            let episode = null;
            const epUrlMatch = window.location.href.match(/(?:[?&]ep=|[/-]ep-|\/episode\/)(\d+)/i);
            if (epUrlMatch) {
                episode = parseInt(epUrlMatch[1], 10);
            } else {
                const bodyText = document.body ? document.body.innerText : '';
                const epMatch = bodyText.match(/\b(?:Episode|EP)\s*(\d+)\b/i);
                if (epMatch) {
                    episode = parseInt(epMatch[1], 10);
                }
            }

            // Cover art fallback
            if (!coverArt) {
                const img = document.querySelector('img[class*="cover"], img[class*="poster"], .poster img');
                if (img && img.src && !img.src.includes('default') && !img.src.includes('icon')) {
                    coverArt = img.src;
                }
            }

            return {
                title,
                episode,
                site: 'Miruro',
                url: window.location.href,
                coverArt
            };
        }

        function extractAnimePaheMetadata() {
            if (!window.location.pathname.includes('/play/')) {
                return null;
            }

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

            if (!title) {
                const pageTitle = document.title.replace(/^Watch\s+/i, '');
                const match = pageTitle.match(/^(.+?)\s+(?:Ep\.|Episode)\s*(\d+)/i) || pageTitle.match(/^(.+?)\s+-\s+(\d+)/i);
                if (match) {
                    title = cleanAnimeTitle(match[1]);
                    episode = parseInt(match[2], 10);
                }
            }

            if (!title) return null;

            return {
                title,
                episode,
                site: 'AnimePahe',
                url: window.location.href,
                coverArt: null
            };
        }

        function checkTopPage() {
            if (!chrome.runtime || !chrome.runtime.id) return;

            const metadata = isMiruro ? extractMiruroMetadata() : extractAnimePaheMetadata();

            if (!metadata) {
                if (lastMetadata) {
                    chrome.runtime.sendMessage({ type: 'ANIME_CLEAR' }, () => {});
                    lastMetadata = null;
                    lastPlayback = null;
                }
                return;
            }

            // Send metadata immediately if changed
            const metadataChanged = !lastMetadata ||
                lastMetadata.title !== metadata.title ||
                lastMetadata.episode !== metadata.episode;

            if (metadataChanged) {
                console.log('Top Frame: Detected anime metadata:', metadata.title, 'Ep:', metadata.episode);
                chrome.runtime.sendMessage({
                    type: 'ANIME_METADATA_UPDATE',
                    data: metadata
                }, () => {});
                lastMetadata = metadata;
            }

            // Check if there is also an HTML5 video right inside this top frame
            const video = findVideoElement();
            if (video) {
                if (attachedVideo !== video) {
                    const handler = () => checkTopPage();
                    ['play', 'playing', 'pause', 'timeupdate', 'seeked', 'ratechange'].forEach(ev => {
                        video.addEventListener(ev, handler);
                    });
                    attachedVideo = video;
                }

                const playback = {
                    progress: Math.floor(video.currentTime || 0),
                    duration: Math.floor(video.duration || 0),
                    isPlaying: !video.paused && !video.ended,
                    isPaused: video.paused,
                    timestamp: Date.now()
                };

                const playbackChanged = !lastPlayback ||
                    lastPlayback.isPlaying !== playback.isPlaying ||
                    lastPlayback.isPaused !== playback.isPaused ||
                    Math.abs(lastPlayback.progress - playback.progress) > 3;

                if (playbackChanged || metadataChanged) {
                    chrome.runtime.sendMessage({
                        type: 'ANIME_UPDATE',
                        data: Object.assign({}, metadata, playback)
                    }, () => {});
                    lastPlayback = playback;
                }
            }
        }

        setInterval(checkTopPage, 1500);
        checkTopPage();

        window.addEventListener('beforeunload', () => {
            if (chrome.runtime && chrome.runtime.id && lastMetadata) {
                try {
                    chrome.runtime.sendMessage({ type: 'ANIME_CLEAR' });
                } catch (e) {}
            }
        });

    } else {
        // ==========================================
        // SUBFRAME / IFRAME: Video Player Detector
        // ==========================================
        let lastPlayback = null;
        let attachedVideo = null;

        function checkIframePlayback() {
            if (!chrome.runtime || !chrome.runtime.id) return;

            const video = findVideoElement();
            if (!video) return;

            if (attachedVideo !== video) {
                console.log('Iframe Frame: Hooked player video element');
                const handler = () => checkIframePlayback();
                ['play', 'playing', 'pause', 'timeupdate', 'seeked', 'ratechange'].forEach(ev => {
                    video.addEventListener(ev, handler);
                });
                attachedVideo = video;
            }

            const playback = {
                progress: Math.floor(video.currentTime || 0),
                duration: Math.floor(video.duration || 0),
                isPlaying: !video.paused && !video.ended,
                isPaused: video.paused,
                timestamp: Date.now()
            };

            const playbackChanged = !lastPlayback ||
                lastPlayback.isPlaying !== playback.isPlaying ||
                lastPlayback.isPaused !== playback.isPaused ||
                Math.abs(lastPlayback.progress - playback.progress) > 3;

            if (playbackChanged) {
                chrome.runtime.sendMessage({
                    type: 'ANIME_PLAYBACK_UPDATE',
                    data: playback
                }, () => {});
                lastPlayback = playback;
            }
        }

        setInterval(checkIframePlayback, 1500);
        checkIframePlayback();
    }
})();
