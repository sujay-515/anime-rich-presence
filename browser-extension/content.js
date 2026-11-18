// content.js - SPA-safe anime metadata & video playback detector
// Supports Top 5 EverythingMoe sites: Re:Anime, KotoPlay, Miruro, Gotaku & AnimePahe

(() => {
    if (window.__ARP_LOADED__) return;
    window.__ARP_LOADED__ = true;

    const isTopFrame = (window.self === window.top);

    function cleanAnimeTitle(title) {
        if (!title) return '';
        return title
            .replace(/\[\d+p\]/gi, '')
            .replace(/\b(Dual[- ]Audio|Uncensored|BD|Blu[- ]Ray|Multi[- ]Subs|Batch)\b/gi, '')
            .replace(/\(\s*\)|\[\s*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function formatSlugTitle(slug) {
        if (!slug) return '';
        return slug
            .split(/[-_]+/)
            .filter(Boolean)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
    }

    function firstText(selectors) {
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent && el.textContent.trim()) {
                return el.textContent.trim();
            }
        }
        return null;
    }

    function firstImgSrc(selectors) {
        for (const sel of selectors) {
            const img = document.querySelector(sel);
            if (img && img.src && !img.src.includes('default') && !img.src.includes('icon')) {
                return img.src;
            }
        }
        return null;
    }

    function getThemeColor() {
        const meta = document.querySelector('meta[name="theme-color"]');
        return meta && meta.content ? meta.content.trim() : null;
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

            const all = root.querySelectorAll('*');
            for (const el of all) {
                if (el.shadowRoot) {
                    const v = findVideoElement(el.shadowRoot);
                    if (v) return v;
                }
            }

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
                if (chrome.runtime.lastError) {}
            });
        } catch (e) {}
    }

    // ==========================================
    // TOP FRAME: Anime Metadata & Direct Player
    // ==========================================
    if (isTopFrame) {
        const host = window.location.hostname.toLowerCase();

        function readJsonLd(ignoreName) {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (!data) continue;
                    const rawName = (data.partOfSeries && data.partOfSeries.name) || data.name;
                    if (rawName && typeof rawName === 'string') {
                        const candidate = cleanAnimeTitle(rawName);
                        if (candidate && candidate.toLowerCase() !== ignoreName) {
                            return {
                                name: candidate,
                                episode: data.episodeNumber ? parseInt(data.episodeNumber, 10) : null,
                                image: data.image || data.thumbnailUrl || null
                            };
                        }
                    }
                } catch (e) {}
            }
            return null;
        }

        const initialPathname = window.location.pathname;
        const initialLd = readJsonLd('miruro');
        const initialJsonLdName = initialLd ? initialLd.name : null;

        function extractReAnime() {
            if (!window.location.pathname.includes('/watch')) return null;

            const ld = readJsonLd('re:anime');
            let title = firstText([
                'nav[aria-label="Breadcrumb"] a[data-anime-title]',
                'h3.line-clamp-2'
            ]);
            if (!title && ld) title = ld.name;
            if (!title && document.title) {
                const m = document.title.match(/^(.+?)\s*-\s*Episode\s+\d+/i);
                if (m) title = m[1];
            }
            if (!title) {
                const parts = window.location.pathname.split('/').filter(Boolean);
                if (parts.length >= 2) {
                    title = formatSlugTitle(parts[1].replace(/-[a-z0-9]{6}$/i, ''));
                }
            }
            title = cleanAnimeTitle(title);
            if (!title || /re:?anime/i.test(title)) return null;

            let episode = null;
            const epParam = window.location.search.match(/[?&]ep=(\d+)/i);
            if (epParam) {
                episode = parseInt(epParam[1], 10);
            } else {
                const crumb = firstText(['nav[aria-label="Breadcrumb"] span', 'a.ep-card.is-playing']);
                const epMatch = (crumb || document.title).match(/(?:Episode\s+|^)(\d+)/i);
                if (epMatch) episode = parseInt(epMatch[1], 10);
                else if (ld && ld.episode) episode = ld.episode;
            }

            const coverArt = firstImgSrc(['img[src*="anilistcdn"]']) || (ld && ld.image) || null;
            return { title, episode, site: 'Re:Anime', url: window.location.href, coverArt, themeColor: getThemeColor() };
        }

        function extractKotoPlay() {
            if (!window.location.pathname.includes('/watch')) return null;

            let title = null;
            const h1 = document.querySelector('h1.at-wtitle');
            if (h1) {
                const clone = h1.cloneNode(true);
                const epSpan = clone.querySelector('.ep');
                if (epSpan) epSpan.remove();
                title = clone.textContent.replace(/\s*[—–-]\s*Episode\s+\d+.*$/i, '').trim();
            }
            if (!title && document.title) {
                title = document.title
                    .replace(/^Watch\s+/i, '')
                    .replace(/\s+Episode\s+\d+.*$/i, '')
                    .replace(/\s*\|\s*KotoPlay.*$/i, '');
            }
            title = cleanAnimeTitle(title);
            if (!title || title.toLowerCase() === 'kotoplay') return null;

            let episode = null;
            const urlEp = window.location.href.match(/\/watch\/[^/]+\/(\d+)|[?&]ep=(\d+)/i);
            if (urlEp) {
                episode = parseInt(urlEp[1] || urlEp[2], 10);
            } else {
                const epText = firstText(['h1.at-wtitle .ep', '.at-ep.active .et']) || document.title;
                const m = epText.match(/Episode\s*(\d+)/i);
                if (m) episode = parseInt(m[1], 10);
            }

            const coverArt = firstImgSrc(['img.d-poster', 'img[src*="anilistcdn"]']);
            return { title, episode, site: 'KotoPlay', url: window.location.href, coverArt, themeColor: getThemeColor() };
        }

        function extractMiruro() {
            if (!window.location.pathname.includes('/watch')) return null;

            let title = null;
            let coverArt = null;
            const navigatedInSpa = window.location.pathname !== initialPathname;

            const ld = readJsonLd('miruro');
            if (ld) {
                const isStaleLd = navigatedInSpa && initialJsonLdName && ld.name === initialJsonLdName;
                if (!isStaleLd) {
                    title = ld.name;
                    coverArt = ld.image;
                }
            }

            if (!title) {
                const pathParts = window.location.pathname.split('/').filter(Boolean);
                if (pathParts.length >= 3 && pathParts[0] === 'watch') {
                    const candidate = formatSlugTitle(pathParts[2]);
                    if (candidate && candidate.toLowerCase() !== 'miruro') title = candidate;
                }
            }

            if (!title && !navigatedInSpa) {
                const meta = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
                if (meta && meta.content) {
                    const candidate = cleanAnimeTitle(meta.content.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*Miruro.*$/i, ''));
                    if (candidate && candidate.toLowerCase() !== 'miruro') title = candidate;
                }
            }

            if (!title) {
                const raw = firstText(['h1[class*="title"]', '.anime-title', '.series-title', 'h1']) || document.title;
                if (raw) {
                    const candidate = cleanAnimeTitle(
                        raw.replace(/^Watch\s+/i, '').replace(/\s*[-|]\s*(Miruro|Episode).*$/i, '')
                    );
                    if (candidate && candidate.toLowerCase() !== 'miruro') title = candidate;
                }
            }

            if (!title) return null;

            let episode = null;
            const epUrlMatch = window.location.href.match(/(?:[?&]ep=|[/-]ep-|\/episode\/)(\d+)/i);
            if (epUrlMatch) {
                episode = parseInt(epUrlMatch[1], 10);
            } else {
                const bodyText = document.body ? document.body.innerText : '';
                const epMatch = bodyText.match(/\bEpisode\s+(\d+)\b/i);
                if (epMatch) episode = parseInt(epMatch[1], 10);
            }

            if (!coverArt) {
                coverArt = firstImgSrc(['img[class*="cover"]', 'img[class*="poster"]', '.poster img']);
            }

            return { title, episode, site: 'Miruro', url: window.location.href, coverArt, themeColor: getThemeColor() };
        }

        function extractGotaku() {
            const isWatch = window.location.pathname.includes('/title/') &&
                (window.location.search.includes('ep=') || document.querySelector('iframe.cc'));
            if (!isWatch) return null;

            let title = firstText([
                'nav.pn a[data-status="active"]',
                'nav a[href^="/title/"]',
                'h3.dg'
            ]);
            if (!title && document.title) {
                title = document.title
                    .replace(/\s*[–—-]\s*Episode\s+\d+.*$/i, '')
                    .replace(/\s*·\s*Gotaku.*$/i, '');
            }
            title = cleanAnimeTitle(title);
            if (!title || title.toLowerCase() === 'gotaku') return null;

            let episode = null;
            const epText = firstText(['nav.pn span.ud', 'button.f.l3 span.a_']) || document.title;
            const m = epText.match(/(?:Episode|EP)\s*(\d+)/i);
            if (m) episode = parseInt(m[1], 10);

            const coverArt = firstImgSrc(['img[src*="anilistcdn"]']);
            return { title, episode, site: 'Gotaku', url: window.location.href, coverArt, themeColor: getThemeColor() };
        }

        function extractAnimePahe() {
            if (!window.location.pathname.includes('/play/')) return null;

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
                    const link = theatreH1.querySelector('a');
                    title = cleanAnimeTitle(link ? link.textContent : text);
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

            if (!episode) {
                const epMenuText = firstText(['#episodeMenu', '.episode-menu button']) || document.title;
                const m = epMenuText.match(/(?:Episode|Ep\.?)\s*(\d+)/i);
                if (m) episode = parseInt(m[1], 10);
            }

            if (!title) return null;

            const ogImg = document.querySelector('meta[property="og:image"]');
            const coverArt = firstImgSrc(['.anime-poster img', 'img[src*="animepahe"]']) || (ogImg ? ogImg.content : null);
            return { title, episode, site: 'AnimePahe', url: window.location.href, coverArt, themeColor: getThemeColor() };
        }

        const SITE_TABLE = [
            { pattern: /(?:^|\.)reanime\./i, extract: extractReAnime },
            { pattern: /(?:^|\.)kotoplay\./i, extract: extractKotoPlay },
            { pattern: /(?:^|\.)miruro\./i, extract: extractMiruro },
            { pattern: /(?:^|\.)gotaku\./i, extract: extractGotaku },
            { pattern: /(?:^|\.)animepahe\./i, extract: extractAnimePahe },
        ];

        const matchedSite = SITE_TABLE.find(entry => entry.pattern.test(host));
        if (!matchedSite) return;

        console.log(`Anime Rich Presence: Monitoring anime page on ${host}`);

        let lastUrl = window.location.href;
        let lastMetadata = null;
        let lastPlayback = null;
        let attachedVideo = null;

        function checkTopPage(forceSync = false) {
            if (!chrome.runtime || !chrome.runtime.id) return;

            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                lastPlayback = null;
                forceSync = true;
            }

            const metadata = matchedSite.extract();

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
                console.log(`Top Frame (${metadata.site}): Detected`, metadata.title, 'Ep:', metadata.episode);
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
