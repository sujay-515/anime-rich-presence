// content.js - SPA-safe anime metadata & video playback detector

(() => {
    if (window.__ARP_LOADED__) return;
    window.__ARP_LOADED__ = true;

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
            const videos = root.querySelectorAll('video');
            for (const video of videos) {
                if (video.currentSrc || video.src || video.duration > 0 || video.readyState > 0) {
                    return video;
                }
            }
            if (videos.length > 0) return videos[0];

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

    function safeSendMessage(payload) {
        if (!chrome.runtime || !chrome.runtime.id) return;
        try {
            chrome.runtime.sendMessage(payload, () => {
                if (chrome.runtime.lastError) {
                    // Ignore transient wake-up errors
                }
            });
        } catch (e) {}
    }

    // ==========================================
    // TOP FRAME: Anime Metadata & Direct Player
    // ==========================================
    if (isTopFrame) {
        const host = window.location.hostname.toLowerCase();
        const isMiruro = host.includes('miruro');
        const isAnimePahe = host.includes('animepahe');

        if (!isMiruro && !isAnimePahe) {
            return;
        }

        console.log(`Anime Rich Presence: Monitoring anime page on ${host}`);

        const initialPathname = window.location.pathname;
        let initialJsonLdName = null;
        let lastUrl = window.location.href;
        let lastMetadata = null;
        let lastPlayback = null;
        let attachedVideo = null;

        function readJsonLd() {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data && data.name && typeof data.name === 'string') {
                        const candidate = cleanAnimeTitle(data.name);
                        if (candidate && candidate.toLowerCase() !== 'miruro') {
                            return { name: candidate, image: data.image || null };
                        }
                    }
                } catch (e) {}
            }
            return null;
        }

        // Record SSR initial JSON-LD so we can detect stale JSON-LD after SPA navigation
        const initialLd = readJsonLd();
        if (initialLd) {
            initialJsonLdName = initialLd.name;
        }

        function extractMiruroMetadata() {
            if (!window.location.pathname.includes('/watch')) {
                return null;
            }

            let title = null;
            let coverArt = null;
            const navigatedInSpa = window.location.pathname !== initialPathname;

            // 1. JSON-LD metadata schema (skip if SPA navigated away and JSON-LD is still SSR initial value)
            const ld = readJsonLd();
            if (ld) {
                const isStaleLd = navigatedInSpa && initialJsonLdName && ld.name === initialJsonLdName;
                if (!isStaleLd) {
                    title = ld.name;
                    coverArt = ld.image;
                }
            }

            // 2. URL slug: /watch/<id>/<slug>
            if (!title) {
                const pathParts = window.location.pathname.split('/').filter(Boolean);
                if (pathParts.length >= 3 && pathParts[0] === 'watch') {
                    const candidate = formatSlugTitle(pathParts[2]);
                    if (candidate && candidate.toLowerCase() !== 'miruro') {
                        title = candidate;
                    }
                }
            }

            // 3. OpenGraph / Twitter meta tags (only if not navigated away from initial SSR page)
            if (!title && !navigatedInSpa) {
                const meta = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
                if (meta && meta.content) {
                    const candidate = cleanAnimeTitle(
                        meta.content.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*Miruro.*$/i, '')
                    );
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
                    const candidate = cleanAnimeTitle(
                        pageTitle.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*Miruro.*$/i, '')
                    );
                    if (candidate && candidate.toLowerCase() !== 'miruro') {
                        title = candidate;
                    }
                }
            }

            if (!title) return null;

            // Episode extraction: URL first, then active "Episode X" label (avoids sidebar "EP X" thumbnails)
            let episode = null;
            const epUrlMatch = window.location.href.match(/(?:[?&]ep=|[/-]ep-|\/episode\/)(\d+)/i);
            if (epUrlMatch) {
                episode = parseInt(epUrlMatch[1], 10);
            } else {
                const bodyText = document.body ? document.body.innerText : '';
                const epMatch = bodyText.match(/\bEpisode\s+(\d+)\b/i);
                if (epMatch) {
                    episode = parseInt(epMatch[1], 10);
                }
            }

            if (!coverArt) {
                const img = document.querySelector('img[class*="cover"], img[class*="poster"], .poster img');
                if (img && img.src && !img.src.includes('default') && !img.src.includes('icon')) {
                    coverArt = img.src;
                }
            }

            const themeMeta = document.querySelector('meta[name="theme-color"]');
            const themeColor = themeMeta && themeMeta.content ? themeMeta.content.trim() : null;

            return {
                title,
                episode,
                site: 'Miruro',
                url: window.location.href,
                coverArt,
                themeColor
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

        function checkTopPage(forceSync = false) {
            if (!chrome.runtime || !chrome.runtime.id) return;

            // Detect SPA URL navigation
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                lastPlayback = null;
                forceSync = true;
            }

            const metadata = isMiruro ? extractMiruroMetadata() : extractAnimePaheMetadata();

            if (!metadata) {
                if (lastMetadata) {
                    safeSendMessage({ type: 'ANIME_CLEAR' });
                    lastMetadata = null;
                    lastPlayback = null;
                }
                return;
            }

            const metadataChanged = forceSync ||
                !lastMetadata ||
                lastMetadata.title !== metadata.title ||
                lastMetadata.episode !== metadata.episode;

            const video = findVideoElement();

            if (video) {
                if (attachedVideo !== video) {
                    const handler = () => checkTopPage(true);
                    ['play', 'playing', 'pause', 'seeked', 'ratechange', 'ended'].forEach(ev => {
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
                    lastPlayback.duration !== playback.duration ||
                    Math.abs(lastPlayback.progress - playback.progress) >= 2;

                if (metadataChanged || playbackChanged) {
                    safeSendMessage({
                        type: 'ANIME_UPDATE',
                        data: Object.assign({}, metadata, playback)
                    });
                    lastMetadata = metadata;
                    lastPlayback = playback;
                }
            } else if (metadataChanged) {
                console.log('Top Frame: Detected anime metadata:', metadata.title, 'Ep:', metadata.episode);
                safeSendMessage({
                    type: 'ANIME_METADATA_UPDATE',
                    data: metadata
                });
                lastMetadata = metadata;
            }
        }

        setInterval(() => checkTopPage(false), 2000);
        window.addEventListener('popstate', () => checkTopPage(true));
        checkTopPage(true);

        window.addEventListener('beforeunload', () => {
            if (lastMetadata) {
                safeSendMessage({ type: 'ANIME_CLEAR' });
            }
        });

    } else {
        // ==========================================
        // SUBFRAME / IFRAME: Video Player Detector
        // ==========================================
        let lastPlayback = null;
        let attachedVideo = null;

        function checkIframePlayback(forceSync = false) {
            if (!chrome.runtime || !chrome.runtime.id) return;

            const video = findVideoElement();
            if (!video) return;

            // Ignore empty placeholder video tags until media metadata loads
            if (!video.currentSrc && !video.src && !video.duration) return;

            if (attachedVideo !== video) {
                console.log('Iframe Frame: Hooked player video element');
                const handler = () => checkIframePlayback(true);
                ['play', 'playing', 'pause', 'seeked', 'ratechange', 'ended'].forEach(ev => {
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

            const playbackChanged = forceSync ||
                !lastPlayback ||
                lastPlayback.isPlaying !== playback.isPlaying ||
                lastPlayback.isPaused !== playback.isPaused ||
                lastPlayback.duration !== playback.duration ||
                Math.abs(lastPlayback.progress - playback.progress) >= 2;

            if (playbackChanged) {
                safeSendMessage({
                    type: 'ANIME_PLAYBACK_UPDATE',
                    data: playback
                });
                lastPlayback = playback;
            }
        }

        setInterval(() => checkIframePlayback(false), 2000);
        checkIframePlayback(true);
    }
})();
