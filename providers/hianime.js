"use strict";

const PROVIDER = "h!anime";
const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_API_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const BASE_URL = "https://hianime.at";
const API_BASE = BASE_URL + "/api/theme/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36";
const REGEX = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:vidtube\.[a-z]+|megaplay\.[a-z]+)/i;

function getSetting(key, defaultValue) {
    const settings = typeof SCRAPER_SETTINGS !== "undefined" ? SCRAPER_SETTINGS : {};
    return key in settings ? settings[key] : defaultValue;
}

async function httpGet(url, referer, asAjax) {
    try {
        const headers = { "User-Agent": USER_AGENT, "Referer": referer || (BASE_URL + "/") };
        if (asAjax) headers["X-Requested-With"] = "XMLHttpRequest";
        const res = await fetch(url, { headers });
        return (res && res.ok) ? await res.text() : "";
    } catch {
        return "";
    }
}

async function fetchAjaxHtml(path, referer) {
    try {
        const body = await httpGet(API_BASE + path, referer, true);
        const json = JSON.parse(body || "null");
        return (json && typeof json.html === "string") ? json.html : "";
    } catch {
        return "";
    }
}

function decodeBase64(value) {
    try { return atob(String(value || "")); } catch { return ""; }
}

function decodeHtmlEntities(raw) {
    return String(raw || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/^\s+|\s+$/g, "");
}

function buildSourceUrl(embedBase, dataId, audioType) {
    const endpoint = /megaplay\.[a-z]+/i.test(String(embedBase || ""))
        ? "/stream/getSourcesNew"
        : "/stream/getSources";
    return `${embedBase}${endpoint}?id=${dataId}&type=${audioType}`;
}

function extractSlug(html) {
    const match = String(html || "").match(
        /href="[^"]*\/(?:watch\/)?([a-z0-9][a-z0-9-]*-\d+)(?:\?[^"]*)?"/i
    );
    return match ? match[1] : null;
}

function parseAnimeCards(html) {
    const results = [];
    const seen = {};
    const chunks = String(html || "").split(
        /class="(?:flw-item|deslide-item|item)[\s"]|<\/section|<footer/
    );
    for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        const img = (chunk.match(/<img\b[^>]*film-poster-img[^>]*>/i) || [])[0];
        const slug = extractSlug(chunk);
        if (!img || !slug || seen[slug]) continue;
        const title = (img.match(/alt="([^"]+?)(?:\s+Poster)?"/i) || [])[1]
            || (chunk.match(/title="([^"]+)"/) || [])[1];
        if (!title) continue;
        seen[slug] = 1;
        results.push({ slug, title: decodeHtmlEntities(title) });
    }
    return results;
}

async function fetchTmdbShowInfo(tmdbId, season) {
    const showUrl = `${TMDB_API_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const seasonUrl = `${TMDB_API_URL}/tv/${tmdbId}/season/${season}?api_key=${TMDB_API_KEY}`;
    const headers = { "User-Agent": USER_AGENT };

    const [showRes, seasonRes] = await Promise.all([
        fetch(showUrl, { headers }),
        (season != null && season >= 2) ? fetch(seasonUrl, { headers }) : Promise.resolve(null),
    ]);

    let showTitle = null;
    let seasonName = null;

    if (showRes && showRes.ok) {
        const data = await showRes.json();
        showTitle = (data && (data.name || data.original_name)) || null;
    }
    if (seasonRes && seasonRes.ok) {
        const data = await seasonRes.json();
        const name = data && data.name;
        if (name && !/^season\s+\d+$/i.test(name.trim())) seasonName = name;
    }

    return { showTitle, seasonName };
}

async function searchHiAnime(query) {
    const html = await httpGet(
        `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`,
        BASE_URL + "/"
    );
    const start = html.indexOf("film_list-wrap");
    if (start < 0) return [];
    const end = html.indexOf("</section", start);
    return parseAnimeCards(html.substring(start, end < 0 ? html.length : end));
}

function normalizeForComparison(str) {
    return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findBestMatch(cards, targetTitle) {
    const normalized = normalizeForComparison(targetTitle);
    let best = null, bestScore = -1;
    for (const card of cards) {
        const t = normalizeForComparison(card.title);
        if (t === normalized) return card;
        const score = (t.includes(normalized) || normalized.includes(t))
            ? Math.min(t.length, normalized.length) : 0;
        if (score > bestScore) { bestScore = score; best = card; }
    }
    return best || cards[0] || null;
}

async function searchWithFallback(queries) {
    for (const query of queries) {
        if (!query) continue;
        const cards = await searchHiAnime(query);
        if (cards.length) return cards;
    }
    return [];
}

async function fetchEpisodeList(slug) {
    const page = await httpGet(BASE_URL + "/" + encodeURIComponent(slug), BASE_URL + "/");
    const idMatch = page.match(/data-animeid="(\d+)"/);
    if (!idMatch) return [];

    const html = await fetchAjaxHtml("episode/list/" + idMatch[1], `${BASE_URL}/watch/${slug}`);
    const episodes = [];
    const pattern = /<a\b([^>]*\bep-item\b[^>]*)>/g;
    let match;

    while ((match = pattern.exec(html)) !== null) {
        const attrs = match[1];
        const epId = (attrs.match(/data-id="(\d+)"/) || [])[1];
        if (!epId) continue;
        const num = parseInt((attrs.match(/data-number="(\d+)"/) || [])[1] || (episodes.length + 1), 10);
        episodes.push({ epId, number: num });
    }
    return episodes;
}

function parseServerList(html) {
    const servers = [];
    const pattern = /data-type="(\w+)"[\s\S]{0,200}?data-server-name="([^"]+)"[\s\S]{0,200}?data-hash="([^"]+)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        const url = decodeBase64(match[3]);
        if (url) servers.push({ type: match[1], name: match[2], url });
    }
    return servers;
}

function rankServer(serverName) {
    const name = String(serverName || "").toLowerCase();
    if (name.includes("vidplay")) return 0;
    if (name.includes("vidstream")) return 1;
    if (name.includes("hd")) return 2;
    return 5;
}

function detectAudioCut(embedUrl) {
    return (String(embedUrl || "").match(/\/(sub|hsub|dub)\/?(?:[?#]|$)/i) || [])[1] || null;
}

async function extractStreamsFromEmbed(embedUrl, audioCut) {
    const origin = (embedUrl.match(/^(https?:\/\/[^/]+)/) || [])[1] || "https://vidtube.site";
    const type = detectAudioCut(embedUrl) || audioCut;
    const page = await httpGet(embedUrl, BASE_URL + "/");
    const dataId = (page.match(/data-id="(\d+)"/) || [])[1];
    if (!dataId) throw new Error("no embed id");

    const srcRes = await fetch(buildSourceUrl(origin, dataId, type), {
        headers: { "User-Agent": USER_AGENT, "Referer": embedUrl, "X-Requested-With": "XMLHttpRequest" }
    });
    const srcText = srcRes && srcRes.ok ? await srcRes.text() : "";
    let payload;
    try { payload = JSON.parse(srcText); } catch { throw new Error("invalid sources response"); }

    const sources = payload && payload.sources;
    const fileUrl = sources ? (sources.file || (sources[0] && sources[0].file)) : null;
    if (!fileUrl) throw new Error("no stream url");

    const subtitles = (payload.tracks || []).reduce((acc, track) => {
        if (!track || !track.file) return acc;
        if (track.kind && track.kind !== "captions" && track.kind !== "subtitles") return acc;
        acc.push({ url: track.file, language: track.label || "Sub", name: track.label || "Sub" });
        return acc;
    }, []);

    const playbackHeaders = { "User-Agent": USER_AGENT, "Referer": origin + "/", "Origin": origin };
    const language = audioCut === "dub" ? "English" : "Japanese";

    const buildStream = (url, quality) => ({
        name: `${PROVIDER} • ${language}`,
        title: `${PROVIDER} • ${language}`,
        quality,
        url,
        headers: playbackHeaders,
        subtitles,
    });

    if (!/\.m3u8(\?|$)/i.test(fileUrl)) return [buildStream(fileUrl, "auto")];

    try {
        const masterRes = await fetch(fileUrl, { headers: { "User-Agent": USER_AGENT, "Referer": origin + "/" } });
        const masterBody = masterRes && masterRes.ok ? await masterRes.text() : "";
        const baseDir = fileUrl.replace(/[^/]*(\?.*)?$/, "");
        const renditions = [];
        const renditionPattern = /#EXT-X-STREAM-INF:[^\n]*?RESOLUTION=\d+x(\d+)[^\n]*\r?\n([^\r\n#]+)/gi;
        let rMatch;

        while ((rMatch = renditionPattern.exec(masterBody)) !== null) {
            const uri = String(rMatch[2]).replace(/^\s+|\s+$/g, "");
            if (!uri) continue;
            renditions.push({
                height: parseInt(rMatch[1], 10),
                url: /^https?:/i.test(uri) ? uri : baseDir + uri,
            });
        }

        renditions.sort((a, b) => b.height - a.height);
        return [
            buildStream(fileUrl, "auto"),
            ...renditions.map(r => buildStream(r.url, r.height + "p")),
        ];
    } catch {
        return [buildStream(fileUrl, "auto")];
    }
}

async function resolveStreamsForAudio(servers, audioCut) {
    const eligible = servers
        .filter(s => audioCut === "dub"
            ? s.type === "dub"
            : (s.type === "sub" || s.type === "hsub"))
        .sort((a, b) => rankServer(a.name) - rankServer(b.name));

    for (const server of eligible) {
        if (!REGEX.test(server.url)) continue;
        try {
            const streams = await extractStreamsFromEmbed(server.url, audioCut);
            if (streams && streams.length > 0) return streams;
        } catch { }
    }
    return [];
}

function applyQualityAndAudioFilters(streams) {
    const wantSub = getSetting("enableSub", true) !== false;
    const wantDub = getSetting("enableDub", true) !== false;
    const wantAuto = getSetting("enableAuto", true) !== false;
    const want1080p = getSetting("enable1080p", true) !== false;
    const want720p = getSetting("enable720p", false) === true;

    return streams.filter(stream => {
        if (stream.language === "Japanese" && !wantSub) return false;
        if (stream.language === "English" && !wantDub) return false;
        const quality = String(stream.quality || "").toLowerCase();
        if (quality === "auto" && !wantAuto) return false;
        if (quality === "1080p" && !want1080p) return false;
        if (quality === "720p" && !want720p) return false;
        const height = parseInt(quality);
        if (!isNaN(height) && height <= 480) return false;
        return true;
    });
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (mediaType !== "tv" || episode == null) return [];

        const { showTitle, seasonName } = await fetchTmdbShowInfo(tmdbId, season);
        if (!showTitle) return [];

        const isBeyondSeason1 = season != null && season >= 2;
        const shortTitle = showTitle.split(/[\s:–-]+/).slice(0, 2).join(" ");
        const queries = [
            ...(isBeyondSeason1 ? [seasonName, `${showTitle} Season ${season}`] : []),
            showTitle,
            ...(shortTitle !== showTitle ? [shortTitle] : []),
        ].filter(Boolean);

        const cards = await searchWithFallback(queries);
        if (!cards.length) return [];

        const primaryQuery = isBeyondSeason1 ? (seasonName || `${showTitle} Season ${season}`) : showTitle;
        const match = findBestMatch(cards, primaryQuery);
        if (!match) return [];

        const episodeList = await fetchEpisodeList(match.slug);
        const target = episodeList.find(ep => ep.number === episode);
        if (!target) return [];

        const serverHtml = await fetchAjaxHtml(
            "episode/servers?episodeId=" + encodeURIComponent(target.epId),
            `${BASE_URL}/watch/${match.slug}`
        );
        const servers = parseServerList(serverHtml);

        const [subStreams, dubStreams] = await Promise.all([
            resolveStreamsForAudio(servers, "sub"),
            resolveStreamsForAudio(servers, "dub"),
        ]);

        const combined = [...subStreams, ...dubStreams];
        const filtered = applyQualityAndAudioFilters(combined);
        const seen = new Set();

        return filtered.filter(s => s.url && !seen.has(s.url) && seen.add(s.url));

    } catch {
        return [];
    }
}

async function onSettings() {
    return [
        { type: "header", label: "Audio" },
        {
            type: "toggle", key: "enableSub", label: "Japanese with English Subtitle (SUB)", defaultValue: true,
            description: "Include Japanese audio with subtitles."
        },
        {
            type: "toggle", key: "enableDub", label: "English Dubbed (DUB)", defaultValue: true,
            description: "Include English dubbed audio."
        },
        { type: "header", label: "Quality" },
        {
            type: "toggle", key: "enableAuto", label: "Auto (adaptive)", defaultValue: true,
            description: "Adaptive bitrate stream — adjusts quality based on connection speed."
        },
        { type: "toggle", key: "enable1080p", label: "1080p", defaultValue: true },
        { type: "toggle", key: "enable720p", label: "720p", defaultValue: false },
    ];
}

module.exports = { getStreams, onSettings };
