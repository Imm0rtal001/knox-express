const cheerio = require("cheerio");
const PROVIDER = "4kHdHub";
const BASE_URL = "https://4khdhub.one";
const MOBILE_UAS = [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];
const sessionUA = MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];
const RE_QUALITY = /(2160|1080|720|480)p|(4K|UHD)/i;
const RE_SIZE_CTX = /(?:^|[\s>])(\d+\.?\d*)\s*(GB|MB)\b/i;
const RE_SIZE_TD = /<td[^>]*>\s*File\s*Size\s*:\s*<\/td>\s*<td[^>]*>\s*([\d\.]+\s*[MGBtbi]+)\s*<\/td>/i;
const RE_SIZE_STR = /Size\s*:\s*<\/strong>\s*([\d\.]+\s*[MGBtbi]+)/i;
const RE_EXT = /\.(mkv|mp4|avi|rar|zip)$/i;
const RE_ZIP_RAR = /\.zip|\.rar/;
const RE_PXL_VAR = /var\s+pxl\s*=\s*["']https?:\/\/pixeldrain\.[a-z0-9.-]+\/u\/([A-Za-z0-9_-]+)["']/i;
const RE_PXL_HREF = /href=["']https?:\/\/pixeldrain\.[a-z0-9.-]+\/u\/([A-Za-z0-9_-]+)["']/i;
const AUDIO_TABLE = [
    [/ddp.?51.*truehd.*71|truehd.*71.*ddp.?51/i, "DDP 5.1 + TrueHD 7.1"],
    [/ddp.?51.*ddp.?71|ddp.?71.*ddp.?51/i, "DDP 5.1 + DDP 7.1"],
    [/ddp.?51.*aac.?71|aac.?71.*ddp.?51/i, "DDP 5.1 + AAC 7.1"],
    [/ddp.?51/i, "DDP 5.1"],
    [/truehd/i, "TrueHD 7.1"],
    [/aac.*71|71.*aac/i, "AAC 7.1"],
    [/aac/i, "AAC 5.1"],
];
const COUNT_OPTIONS = [
    { value: "1", label: "1" },
    { value: "2", label: "2" },
    { value: "3", label: "3" },
    { value: "4", label: "4" },
    { value: "unlimited", label: "Unlimited" },
];

async function onSettings() {
    return [
        { type: "header", label: "Sort Order" },
        {
            type: "toggle",
            key: "sortBySize",
            label: "Sort by Size",
            defaultValue: false,
            description: "ON — Largest Size first\nOFF — Highest Resolution first, then Largest Size",
        },
        { type: "header", label: "Resolution" },
        { type: "toggle", key: "enable4K", label: "4K / 2160p", defaultValue: true },
        { type: "toggle", key: "enable1080p", label: "FHD / 1080p", defaultValue: true },
        { type: "header", label: "Limit Streams by Resolution" },
        { type: "info", label: "Max streams shown per resolution\nDefault: Unlimited" },
        { type: "select", key: "max4K", label: "4K / 2160p", defaultValue: "unlimited", options: COUNT_OPTIONS },
        { type: "select", key: "max1080p", label: "FHD / 1080p", defaultValue: "unlimited", options: COUNT_OPTIONS },
        { type: "header", label: "Limit Stream by Source" },
        { type: "info", label: "Default: Unlimited" },
        { type: "select", key: "maxFSL", label: "FSL", defaultValue: "unlimited", options: COUNT_OPTIONS },
        { type: "select", key: "maxFSLv2", label: "FSL-v2 [R2]", defaultValue: "unlimited", options: COUNT_OPTIONS },
        { type: "select", key: "maxPixelDrain", label: "PixelDrain", defaultValue: "unlimited", options: COUNT_OPTIONS },
    ];
}

function resolveSettings() {
    const s = SCRAPER_SETTINGS;
    function cap(key, def) {
        const raw = s[key];
        if (raw == null || raw === "") return def;
        if (raw === "unlimited") return Infinity;
        const n = parseInt(raw, 10);
        return (isNaN(n) || n <= 0) ? def : n;
    }
    return {
        sortBySize: s.sortBySize === true,
        enable4K: s.enable4K !== false,
        enable1080p: s.enable1080p !== false,
        max4K: cap("max4K", Infinity),
        max1080p: cap("max1080p", Infinity),
        maxFSLv2: cap("maxFSLv2", Infinity),
        maxFSL: cap("maxFSL", Infinity),
        maxPixelDrain: cap("maxPixelDrain", Infinity),
    };
}

function hostCap(host, settings) {
    if (host === "FSL-v2") return settings.maxFSLv2;
    if (host === "FSL") return settings.maxFSL;
    if (host === "PixelDrain") return settings.maxPixelDrain;
    return Infinity;
}

function getHeaders(extra) {
    return {
        "User-Agent": sessionUA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `${BASE_URL}/`,
        ...extra,
    };
}

async function fetchText(url, referer) {
    try {
        const res = await fetch(url, {
            headers: getHeaders(referer ? { Referer: referer } : {}),
        });
        return (res && res.ok) ? res.text() : null;
    } catch (_) { return null; }
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: getHeaders() });
        return (res && res.ok) ? res.json() : null;
    } catch (_) { return null; }
}

function pad(n) {
    return String(n).padStart(2, "0");
}

function absoluteUrl(href, base) {
    if (!href) return "";
    if (/^https?:\/\//i.test(href)) return href;
    try { return new URL(href.replace(/&amp;/g, "&"), base || BASE_URL).toString(); }
    catch (_) { return ""; }
}

function parseSizeMB(sizeStr) {
    if (!sizeStr) return null;
    const m = /(\d+\.?\d*)\s*(GB|MB)/i.exec(sizeStr);
    if (!m) return null;
    const val = parseFloat(m[1]);
    return m[2].toUpperCase() === "GB" ? val * 1024 : val;
}

function calcMbps(sizeMB, runtimeMinutes) {
    if (!sizeMB || !runtimeMinutes) return null;
    return ((sizeMB * 1024 * 1024 * 8) / (runtimeMinutes * 60) / 1000000).toFixed(1) + " Mbps";
}

function getSortTag(rank, maxRank) {
    let inv = Math.max(0, maxRank - rank);
    let bin = inv.toString(2);
    while (bin.length < 20) bin = "0" + bin;
    return bin.split("").map(b => b === "1" ? "\uFEFF" : "\u200B").join("");
}

function normalizeTitle(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\b(the|a|an|directors?|cut)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function titleScore(expected, candidate) {
    const expectedWords = normalizeTitle(expected).split(" ").filter(Boolean);
    const candidateWords = new Set(normalizeTitle(candidate).split(" ").filter(Boolean));
    if (!expectedWords.length) return 0;
    return expectedWords.filter(w => candidateWords.has(w)).length / expectedWords.length;
}

async function getTMDBInfo(tmdbId, type) {
    const isTV = type === "tv";
    let title = "", year = "", imdbId = "", runtime = null;
    try {
        if (isTV) {
            const d = await fetchJson(
                `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
            );
            if (d) {
                title = d.name;
                year = (d.first_air_date || "").slice(0, 4);
                imdbId = (d.external_ids && d.external_ids.imdb_id) || "";
                runtime = (d.episode_run_time && d.episode_run_time[0]) || null;
            }
        } else {
            const d = await fetchJson(
                `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
            );
            if (d) {
                title = d.title;
                year = (d.release_date || "").slice(0, 4);
                imdbId = d.imdb_id || "";
                runtime = d.runtime != null ? d.runtime : null;
            }
        }
    } catch (_) { }
    return { title, year, imdbId, runtime };
}

async function searchSite(title, year, imdbId, isSeries, season) {
    if (imdbId) {
        try {
            const posts = await fetchJson(`${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(imdbId)}`);
            if (posts && posts.length > 0) return posts[0].link || null;
        } catch (_) { }
    }

    const query = (isSeries && season)
        ? `${title} Season ${season}`
        : `${title} ${year || ""}`.trim();

    const html = await fetchText(`${BASE_URL}/?s=${encodeURIComponent(query)}`);
    if (!html) return null;

    const $ = cheerio.load(html);
    let best = null;

    $(".movie-card").each((_, el) => {
        const card = $(el);
        const cardTitle = card.find(".movie-card-title").text().trim();
        const format = card.find(".movie-card-format").text().trim();
        const meta = card.find(".movie-card-meta").text();
        const href = card.attr("href") || card.find("a[href]").first().attr("href");

        if (!cardTitle || !href) return;
        if (isSeries && !/series/i.test(format)) return;
        if (!isSeries && !/movies?/i.test(format)) return;

        const yearMatch = meta.match(/\b(19|20)\d{2}\b/);
        const cardYear = yearMatch ? Number(yearMatch[0]) : null;

        let score = titleScore(title, cardTitle);
        if (year && cardYear === +year) score += 0.35;
        else if (year && cardYear && Math.abs(cardYear - +year) > 1) score -= 0.5;

        if (isSeries && season) {
            const foundSeason = cardTitle.match(/(?:season\s*|s)(\d+)/i);
            if (foundSeason && Number(foundSeason[1]) === Number(season)) score += 0.4;
            else if (foundSeason) score -= 0.6;
        }

        const url = absoluteUrl(href);
        if (!best || score > best.score) best = { url, score };
    });

    return (best && best.score >= 0.5) ? best.url : null;
}

function rot13(value) {
    return String(value || "").replace(/[a-zA-Z]/g, c => {
        const code = c.charCodeAt(0) + 13;
        const limit = c <= "Z" ? 90 : 122;
        return String.fromCharCode(code <= limit ? code : code - 26);
    });
}

async function decodeRedirect(url) {
    if (/hubcloud|hubdrive/i.test(url)) return url;
    try {
        const html = await fetchText(url);
        if (!html) return url;
        const encoded =
            (html.match(/['"]o['"]\s*,\s*['"]([^'"]+)['"]/) || [])[1] ||
            (html.match(/'o','([^']+)'/) || [])[1];
        if (!encoded) return url;
        const decoded = atob(rot13(atob(atob(encoded))));
        const payload = JSON.parse(decoded);
        return payload.o ? atob(payload.o).trim() : url;
    } catch (_) { return url; }
}

function getDirectVideoHost(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.endsWith(".r2.cloudflarestorage.com") || host.endsWith(".r2.dev") || host === "cdn.fsl-buckets.life" || host.endsWith(".fsl-buckets.life")) return "FSL-v2";
        return "";
    } catch (_) { return ""; }
}

function makeStream(filename, sourceName, streamUrl, quality, hostLabel, referer, size, runtime) {
    const qualityUp = (quality || "1080P").toUpperCase();
    const encodedUrl = streamUrl.replace(/ /g, "%20");
    const combined = (String(filename || "") + " " + String(sourceName || "") + " " + encodedUrl).toLowerCase();

    const langParts = [];
    if (/\b(?:english|eng)\b/.test(combined)) langParts.push("English");
    if (/\bhindi\b/.test(combined)) langParts.push("Hindi");
    if (/\btamil\b/.test(combined)) langParts.push("Tamil");
    if (/\btelugu\b/.test(combined)) langParts.push("Telugu");

    let source = "WEB-DL";
    let isRemux = false;
    if (/\bremux\b/.test(combined)) { source = "Blu-ray"; isRemux = true; }
    else if (/\bblu[-\s]?ray\b/.test(combined)) source = "Blu-ray";
    else if (/\b(?:webrip|hdrip)\b/.test(combined)) source = "WEB-Rip";

    let hdrTag = "";
    if (/\b(?:hdr10\+|hdr10p)\b/.test(combined)) hdrTag = "HDR10+";
    else if (/\bhdr10\b/.test(combined)) hdrTag = "HDR10";
    else if (/\bhdr\b/.test(combined)) hdrTag = "HDR";
    else if (/\bsdr\b/.test(combined)) hdrTag = "SDR";

    const bit10Tag = /\b10bit\b/.test(combined) ? "10Bit" : "";
    const dvTag = /\b(?:dv|dolby\s*vision)\b/.test(combined) ? "DV" : "";
    const codec = (/\b(?:hevc|x265|265)\b/.test(combined) || qualityUp === "2160P") ? "H.265" : "H.264";
    const isImax = /\bimax\b/.test(combined);

    let audio = "DDP 5.1";
    for (let i = 0; i < AUDIO_TABLE.length; i++) {
        if (AUDIO_TABLE[i][0].test(combined)) { audio = AUDIO_TABLE[i][1]; break; }
    }
    if (/\batmos\b/.test(combined)) audio += " Atmos";

    const sizeMB = parseSizeMB(size);
    const mbps = calcMbps(sizeMB, runtime);

    const mainTitle = [PROVIDER, qualityUp, size].filter(Boolean).join(" \u2022 ");
    const line1 = langParts.join(" \u2022 ");
    const line2 = [source, isRemux && "REMUX", isImax && "IMAX", hostLabel || "FSL", mbps].filter(Boolean).join(" \u2022 ");
    const line3 = [bit10Tag, dvTag, hdrTag, codec, audio].filter(Boolean).join(" \u2022 ");
    const streamTitle = [line1, line2, line3].filter(Boolean).join("\n");

    return {
        name: mainTitle,
        title: mainTitle,
        url: encodedUrl,
        quality: qualityUp + " \u2022 " + streamTitle,
        headers: { Referer: referer || `${BASE_URL}/` },
        _host: hostLabel || "FSL",
        _sizeRaw: size || "",
    };
}

async function resolveHubCloud(cloudUrl, fallbackTitle, quality, size, runtime) {
    const streams = [];
    try {
        let html = await fetchText(cloudUrl, `${BASE_URL}/`);
        if (!html) return streams;

        let pageUrl = cloudUrl;
        const varUrl = (html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/) || [])[1];
        const dlHref = (html.match(/id=["']download["'][^>]*href=["']([^'"]+)["']/i) ||
            html.match(/href=["']([^'"]+)["'][^>]*id=["']download["']/i) || [])[1];
        const redirect = varUrl || dlHref;
        if (redirect) {
            pageUrl = absoluteUrl(redirect.replace(/&amp;/g, "&"), cloudUrl);
            html = await fetchText(pageUrl, cloudUrl);
            if (!html) return streams;
        }

        const $ = cheerio.load(html);
        const headerText = $("div.card-header").text().replace(/\s+/g, " ").trim() ||
            $("title").text().trim() ||
            fallbackTitle || "";
        const filename = headerText.replace(RE_EXT, "");

        let fileSize = size || "";
        const sm = RE_SIZE_TD.exec(html) || RE_SIZE_STR.exec(html);
        if (sm) fileSize = sm[1].trim();

        $("a[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (!href || href.startsWith("javascript:")) return;
            const absHref = href.replace(/&amp;/g, "&");
            if (RE_ZIP_RAR.test(absHref)) return;

            const host = getDirectVideoHost(absHref);
            if (!host) return;

            if (!streams.some(s => s.url === absHref)) {
                streams.push(makeStream(filename, host, absHref, quality, host, pageUrl, fileSize, runtime));
            }
        });

        const pxlMatch = RE_PXL_VAR.exec(html) || RE_PXL_HREF.exec(html);
        if (pxlMatch && pxlMatch[1]) {
            const pdUrl = "https://pixeldrain.com/api/file/" + pxlMatch[1];
            if (!streams.some(s => s.url === pdUrl)) {
                streams.push(makeStream(filename, "PixelDrain", pdUrl, quality, "PixelDrain", pageUrl, fileSize, runtime));
            }
        }
    } catch (_) { }
    return streams;
}

async function findHubCloudUrl(item, pageUrl, $) {
    const links = item.find("a[href]").get();
    for (const el of links) {
        const link = $(el);
        const href = link.attr("href");
        const text = link.text();
        if (!href) continue;

        const absHref = absoluteUrl(href, pageUrl);
        if (!absHref) continue;

        if (/hubcloud/i.test(text) || /hubcloud/i.test(href)) {
            return decodeRedirect(absHref);
        }

        if (/hubdrive/i.test(text) || /hubdrive/i.test(href)) {
            const driveUrl = await decodeRedirect(absHref);
            try {
                const driveHtml = await fetchText(driveUrl, pageUrl);
                if (!driveHtml) continue;
                const $d = cheerio.load(driveHtml);
                const cloud = $d("a[href]")
                    .filter((_, a) => /hubcloud/i.test(`${$d(a).text()} ${$d(a).attr("href") || ""}`))
                    .first()
                    .attr("href");
                if (cloud) return absoluteUrl(cloud, driveUrl);
            } catch (_) { }
        }
    }
    return "";
}

async function extractStreams(pageUrl, isSeries, season, episode, runtime) {
    const html = await fetchText(pageUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const items = [];

    if (isSeries && season != null && episode != null) {
        const seasonCode = `S${pad(season)}`;
        const episodeCode = `Episode-${pad(episode)}`;
        $(".episode-item").each((_, el) => {
            const section = $(el);
            if (!section.find(".episode-title").text().includes(seasonCode)) return;
            section.find(".episode-download-item").each((__, dl) => {
                if ($(dl).text().includes(episodeCode)) items.push({ el: $(dl), context: $(dl).text() });
            });
        });
    } else {
        $(".download-item").each((_, el) => {
            items.push({ el: $(el), context: $(el).text() });
        });
    }

    const resolved = await Promise.all(
        items.map(async ({ el: item, context }) => {
            try {
                const ctx = context.replace(/\s+/g, " ").trim();
                const qm = RE_QUALITY.exec(ctx);
                let quality = "1080P";
                if (qm) {
                    const v = qm[1] || qm[2];
                    quality = (v.toUpperCase() === "4K" || v.toUpperCase() === "UHD") ? "2160P" : v.toUpperCase() + "P";
                }
                if (quality === "480P") return [];

                const sm = RE_SIZE_CTX.exec(ctx);
                const size = sm ? (sm[1] + " " + sm[2]) : "";

                const cloudUrl = await findHubCloudUrl(item, pageUrl, $);
                if (!cloudUrl) return [];

                return resolveHubCloud(cloudUrl, null, quality, size, runtime);
            } catch (_) {
                return [];
            }
        })
    );

    return resolved.flat();
}

function resWeight(quality) {
    const q = (quality || "").toUpperCase().split(" ")[0];
    if (q === "2160P" || q === "4K") return 4;
    if (q === "1080P") return 3;
    if (q === "720P") return 2;
    return 1;
}

function applySettings(streams, settings) {
    streams = streams.filter(s => {
        const q = (s.quality || "").toUpperCase().split(" ")[0];
        if ((q === "2160P" || q === "4K") && !settings.enable4K) return false;
        if (q === "1080P" && !settings.enable1080p) return false;
        return true;
    });

    if (settings.sortBySize) {
        streams.sort((a, b) => (parseSizeMB(b._sizeRaw) || 0) - (parseSizeMB(a._sizeRaw) || 0));
    } else {
        streams.sort((a, b) => {
            const rd = resWeight(b.quality) - resWeight(a.quality);
            return rd !== 0 ? rd : (parseSizeMB(b._sizeRaw) || 0) - (parseSizeMB(a._sizeRaw) || 0);
        });
    }

    const resCounts = {};
    streams = streams.filter(s => {
        const q = (s.quality || "").toUpperCase().split(" ")[0];
        const limit = (q === "2160P" || q === "4K") ? settings.max4K
            : q === "1080P" ? settings.max1080p
                : Infinity;
        if (limit === Infinity) return true;
        resCounts[q] = (resCounts[q] || 0) + 1;
        return resCounts[q] <= limit;
    });

    const provCounts = {};
    streams = streams.filter(s => {
        const host = s._host || "unknown";
        const q = (s.quality || "").toUpperCase().split(" ")[0];
        const key = host + ":" + q;
        const limit = hostCap(host, settings);
        if (limit === Infinity) return true;
        provCounts[key] = (provCounts[key] || 0) + 1;
        return provCounts[key] <= limit;
    });

    const seen = new Set();
    streams = streams.filter(s => s.url && !seen.has(s.url) && seen.add(s.url));

    const total = streams.length;
    return streams.map((s, i) => {
        const tag = getSortTag(total - i, total + 1);
        return { ...s, name: tag + s.name, title: tag + s.title };
    });
}

async function getStreams(tmdbId, mediaType, season, episode) {
    if (!tmdbId) return [];
    if (mediaType !== "movie" && mediaType !== "tv") return [];
    if (mediaType === "tv" && (season == null || episode == null)) return [];

    try {
        const info = await getTMDBInfo(tmdbId, mediaType);
        if (!info.title) return [];

        const pageUrl = await searchSite(info.title, info.year, info.imdbId, mediaType === "tv", season);
        if (!pageUrl) return [];

        const streams = await extractStreams(pageUrl, mediaType === "tv", +season, +episode, info.runtime);
        return applySettings(streams, resolveSettings());
    } catch (_) { return []; }
}

module.exports = { getStreams, onSettings };
