const cheerio = require("cheerio");
const BASE_URL = "https://watchanimeworld.one";
const TMDB_API = "https://api.themoviedb.org/3";
const PLAYER_BASE = "https://play.zephyrix.org";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": USER_AGENT };

async function get(url, extraHeaders = {}) {
    const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
}

async function post(url, body, extraHeaders = {}) {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            ...HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            ...extraHeaders,
        },
        body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function fetchTmdb(path) {
    try {
        const res = await fetch(`${TMDB_API}/${path}?api_key=${TMDB_API_KEY}`);
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
}

async function searchSite(title, mediaType) {
    try {
        const res = await get(`${BASE_URL}/?s=${encodeURIComponent(title)}`, { "Referer": `${BASE_URL}/` });
        const $ = cheerio.load(await res.text());
        const seen = new Set();
        const results = [];

        $("a[href]").each((_, el) => {
            const href = $(el).attr("href") || "";
            const m = href.match(/^https?:\/\/[^/]+\/(series|movies)\/([^/]+)\//);
            if (!m || m[2] === "page" || seen.has(href)) return;
            const typeMatch = mediaType === "movie" ? m[1] === "movies" : m[1] === "series";
            if (!typeMatch) return;
            seen.add(href);
            results.push(href);
        });

        return results;
    } catch {
        return [];
    }
}

function findEpisodeUrl(html, epPattern) {
    const $ = cheerio.load(html);
    let found = null;

    $("a[href]").each((_, el) => {
        const href = $(el).attr("href") || "";
        if (!href.includes("/episode/")) return;
        const slug = href.slice(href.indexOf("/episode/") + 9).replace(/\/$/, "");
        if (href.includes(epPattern) || slug.includes(epPattern)) {
            found = href;
            return false;
        }
    });

    return found;
}

async function resolveEpisode(seriesUrl, season, episode) {
    const res = await get(seriesUrl, { "Referer": `${BASE_URL}/` });
    const html = await res.text();
    const epPattern = `${season}x${episode}`;
    const postIdMatch = html.match(/postid-(\d+)/) || html.match(/data-post="(\d+)"/);

    if (postIdMatch) {
        try {
            const ajaxRes = await get(
                `${BASE_URL}/wp-admin/admin-ajax.php?action=action_select_season&season=${season}&post=${postIdMatch[1]}`,
                { "Referer": seriesUrl }
            );
            const url = findEpisodeUrl(await ajaxRes.text(), epPattern);
            if (url) return url;
        } catch { }
    }

    return findEpisodeUrl(html, epPattern);
}

async function extractStream(pageUrl) {
    const res = await get(pageUrl, { "Referer": `${BASE_URL}/` });
    const html = await res.text();

    let playerUrl, videoHash;
    const direct = html.match(/(?:src|data-src)="(https?:\/\/play\.[^"]+\/video\/([a-f0-9]+))"/i);

    if (direct) {
        playerUrl = direct[1];
        videoHash = direct[2];
    } else {
        const loose = html.match(/https?:\/\/play\.(zephyrflick|zephyrix)\.[^/\s"]+\/video\/([a-f0-9]+)/i);
        if (!loose) return null;
        videoHash = loose[2];
        playerUrl = `${PLAYER_BASE}/video/${videoHash}`;
    }

    let sessionCookie = "";
    try {
        const playerRes = await fetch(playerUrl, { headers: { ...HEADERS, "Referer": `${BASE_URL}/` } });
        sessionCookie = (playerRes.headers.get("set-cookie") || "")
            .split(/,(?=[^;]+=[^;]+)/)
            .map(c => c.trim().split(";")[0])
            .filter(Boolean)
            .join("; ");
    } catch { }

    const cookieHeader = sessionCookie ? { "Cookie": sessionCookie } : {};

    const data = await post(
        `${PLAYER_BASE}/player/index.php?data=${videoHash}&do=getVideo`,
        `hash=${videoHash}&r=${encodeURIComponent(`${BASE_URL}/`)}`,
        {
            "Referer": playerUrl,
            "Origin": PLAYER_BASE,
            "X-Requested-With": "XMLHttpRequest",
            ...cookieHeader,
        }
    );

    const m3u8 = data.securedLink || data.videoSource || data.source || data.file;
    if (!m3u8) return null;

    const hashMatch = m3u8.match(/\/cdn\/hls\/([a-f0-9]+)\//);
    const contentHash = hashMatch ? hashMatch[1] : videoHash;

    return {
        m3u8,
        streamHeaders: {
            "Referer": `${PLAYER_BASE}/`,
            "Origin": PLAYER_BASE,
            "User-Agent": USER_AGENT,
            ...cookieHeader,
        },
        subtitle: `${PLAYER_BASE}/cdn/down/${contentHash}/Subtitle/subtitle_eng.srt`,
    };
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (mediaType === "tv" && (season == null || episode == null)) return [];

        const media = await fetchTmdb(`${mediaType}/${tmdbId}`);
        if (!media) return [];

        const title = media.name || media.title;
        if (!title) return [];

        const searchResults = await searchSite(title, mediaType);
        if (!searchResults.length) return [];

        let stream = null;

        if (mediaType === "movie") {
            stream = await extractStream(searchResults[0]);
        } else {
            let epUrl = await resolveEpisode(searchResults[0], season, episode);
            if (!epUrl && season !== 1) {
                epUrl = await resolveEpisode(searchResults[0], 1, episode);
            }
            if (epUrl) stream = await extractStream(epUrl);
        }

        if (!stream) return [];

        return [{
            name: "AnimeWorld",
            title: "AnimeWorld",
            url: stream.m3u8,
            quality: "1080p",
            headers: stream.streamHeaders,
            subtitles: [{ url: stream.subtitle, language: "en", name: "English" }],
        }];
    } catch {
        return [];
    }
}

module.exports = { getStreams };
