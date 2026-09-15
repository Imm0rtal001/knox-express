"use strict";

const TMDB_API_URL = `https://api.themoviedb.org/3`;
const TMDB_API_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const API_BASE = "https://flixcloud.cc";
const ANIZIP_API = "https://api.ani.zip/mappings";
const BASE_URLS = ["https://reanime.to", "https://reanime.cz", "https://reanime.wtf"];
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
};

let activeReanimeOrigin = BASE_URLS[0];

function toAbsoluteUrl(path, base) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    const b = base || activeReanimeOrigin;
    return b + (path.startsWith("/") ? path : "/" + path);
}

async function httpGetText(url, options) {
    options = options || {};
    const isAbsolute = url.startsWith("http");
    const targets = isAbsolute ? [url] : BASE_URLS.map(function (d) { return toAbsoluteUrl(url, d); });
    let lastErr;
    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        try {
            const res = await fetch(target, Object.assign({}, options, {
                headers: Object.assign({}, HEADERS, options.headers || {}),
            }));
            if (res.ok) {
                if (!isAbsolute) {
                    const m = target.match(/^(https?:\/\/[^/]+)/);
                    if (m) activeReanimeOrigin = m[1];
                }
                return await res.text();
            }
            lastErr = new Error("HTTP " + res.status + ": " + target);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error("Failed: " + url);
}

async function httpGetJson(url, options) {
    options = options || {};
    const text = await httpGetText(url, Object.assign({}, options, {
        headers: Object.assign({ "Accept": "application/json, text/plain, */*" }, options.headers || {}),
    }));
    return JSON.parse(text);
}

async function fetchAniZip(param, value) {
    return httpGetJson(ANIZIP_API + "?" + encodeURIComponent(param) + "=" + encodeURIComponent(value));
}

async function resolveAnilistId(tmdbId) {
    const data = await fetchAniZip("themoviedb_id", tmdbId);
    if (!data || !data.mappings) throw new Error("ani.zip: no mappings for " + tmdbId);
    const mappings = data.mappings;
    const anilistId = mappings.anilist_id ? String(mappings.anilist_id) : null;
    const titles = data.titles || {};
    const title = titles.en || titles["x-jat"] || titles.ja || "";
    return { anilistId, title };
}

async function fetchTmdbTitle(tmdbId, mediaType) {
    try {
        const endpoint = mediaType === "tv" ? "tv" : "movie";
        const res = await fetch(
            `${TMDB_API_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`,
            { headers: HEADERS }
        );
        if (!res.ok) return { title: "", year: null };
        const data = await res.json();
        const title = mediaType === "tv" ? (data.name || "") : (data.title || "");
        const year = ((data.first_air_date || data.release_date || "").slice(0, 4)) || null;
        return { title, year };
    } catch (e) {
        return { title: "", year: null };
    }
}

function slugifyTitle(val) {
    return String(val || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function computeMatchScore(title, query, year, targetAlId, candidateAlId) {
    if (targetAlId && candidateAlId && String(targetAlId) === String(candidateAlId)) return 1000;
    const a = slugifyTitle(title);
    const b = slugifyTitle(query);
    if (!a || !b) return 0;
    let score = 0;
    if (a === b) score += 100;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) score += 50;
    const words = b.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
        if (a.indexOf(words[i]) !== -1) score += 4;
    }
    if (year && String(title).indexOf(String(year)) !== -1) score += 10;
    return score;
}

function parseAnilistId(item) {
    const direct = item && (item.anilist_id || item.anilistId);
    if (direct) return String(direct);
    const urls = [
        item && item.cover_image && item.cover_image.extra_large,
        item && item.cover_image && item.cover_image.large,
        item && item.cover_image && item.cover_image.medium,
        item && item.banner_image,
    ].filter(Boolean);
    for (let i = 0; i < urls.length; i++) {
        const m = String(urls[i]).match(/\/b?x?(\d+)-|\/(\d+)[-.]/);
        if (m) return m[1] || m[2];
    }
    return null;
}

async function queryReanimeIndex(query, year, targetAlId) {
    targetAlId = targetAlId || null;
    const endpoints = [
        "/api/v1/search?q=" + encodeURIComponent(query) + "&limit=36",
        "/api/search?q=" + encodeURIComponent(query),
    ];

    const candidates = [];

    for (let ei = 0; ei < endpoints.length; ei++) {
        try {
            const text = await httpGetText(endpoints[ei]);
            const trimmed = text.trim();
            if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
            const json = JSON.parse(text);
            const list = json.results || json.data || json.anime || (Array.isArray(json) ? json : null);
            if (!Array.isArray(list)) continue;

            for (let li = 0; li < list.length; li++) {
                const item = list[li];
                const rawSlug = item.anime_id || item.slug || item.id || item.url;
                if (!rawSlug) continue;
                const cleanSlug = String(rawSlug).replace(/-[a-z0-9]{6}$/, "");
                const rawTitle = typeof item.title === "object"
                    ? ((item.title && (item.title.english || item.title.romaji || item.title.native)) || cleanSlug)
                    : (item.title || item.name || cleanSlug);
                const alId = parseAnilistId(item);
                candidates.push({
                    slug: String(rawSlug),
                    cleanSlug: cleanSlug,
                    title: rawTitle,
                    anilistId: alId,
                    score: computeMatchScore(rawTitle, query, year, targetAlId, alId),
                });
            }
        } catch (e) { }

        let hasExact = false;
        for (let ci = 0; ci < candidates.length; ci++) {
            if (candidates[ci].score >= 1000) { hasExact = true; break; }
        }
        if (hasExact) break;
        if (candidates.length > 0 && !targetAlId) break;
    }

    const seen = {};
    const unique = [];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c.slug || seen[c.slug]) continue;
        seen[c.slug] = true;
        unique.push(c);
    }
    unique.sort(function (a, b) { return b.score - a.score; });
    return unique.length > 0 ? unique[0] : null;
}

async function fetchFlixServerList(slug, episodeNum, language, anilistId) {
    const watchPath = "/watch/" + (slug || "anime") + "?ep=" + episodeNum;

    async function tryFlixApi(alId) {
        const json = await httpGetJson("/api/flix/" + alId + "/" + episodeNum, {
            headers: { "Referer": toAbsoluteUrl(watchPath) },
        });
        if (!json.success || !json.servers || !json.servers.length) return null;
        const filtered = json.servers.filter(function (s) {
            return !language || !s.dataType || s.dataType === language;
        });
        return filtered.length > 0 ? filtered : json.servers;
    }

    if (anilistId) {
        try {
            const servers = await tryFlixApi(anilistId);
            if (servers) return servers;
        } catch (e) { }
    }

    if (slug) {
        try {
            const html = await httpGetText("/anime/" + slug + "?_ep=" + episodeNum);
            const m = html.match(/anilist_id:\s*(\d+)/);
            if (m) {
                const servers = await tryFlixApi(m[1]);
                if (servers) return servers;
            }
        } catch (e) { }
    }

    return [];
}

async function resolveFlixDownloadUrl(embedUrl) {
    try {
        const m = embedUrl.match(/\/e\/([a-z0-9]+)/i);
        if (!m) return null;
        const aid = m[1];
        const dlHeaders = { "Accept": "*/*", "Referer": API_BASE + "/", "User-Agent": USER_AGENT };
        const res = await fetch(API_BASE + "/d/" + aid + "/__data.json", { headers: dlHeaders });
        if (!res.ok) return null;

        const body = await res.text();
        const fileIdM = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        const tokenM = body.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
        const baseM = body.match(/https:\/\/fetch\d*\.flixcloud\.cc/);

        if (!fileIdM || !tokenM) return null;
        const fileId = fileIdM[0];
        const token = tokenM[0];
        const fetchBase = baseM ? baseM[0] : API_BASE;

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const progRes = await fetch(
                    fetchBase + "/download/" + fileId + "/progress?token=" + token,
                    { headers: dlHeaders }
                );
                if (progRes.ok) {
                    const t = await progRes.text();
                    if (t.indexOf('"status":"ready"') !== -1 || t.indexOf('"ready"') !== -1) break;
                    if (t.indexOf('"status":"failed"') !== -1) return null;
                }
            } catch (e) { }
        }

        return {
            url: fetchBase + "/download/" + fileId + "?token=" + token,
            headers: dlHeaders,
        };
    } catch (e) {
        return null;
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (mediaType !== "tv" && mediaType !== "movie") return [];
        if (mediaType === "tv" && episode == null) return [];

        const isAnilist = typeof tmdbId === "string" && tmdbId.startsWith("anilist:");
        let alId = null;
        let episodeNum = mediaType === "tv" ? Number(episode) : 1;
        let searchTitle = "";
        let searchYear = null;

        if (isAnilist) {
            alId = tmdbId.split(":")[1];
        } else {
            try {
                const info = await resolveAnilistId(tmdbId);
                alId = info.anilistId;
                searchTitle = info.title || "";
            } catch (e) { }
        }

        if (!searchTitle && !isAnilist) {
            const meta = await fetchTmdbTitle(tmdbId, mediaType);
            searchTitle = meta.title;
            searchYear = meta.year;
        }

        const serversByLang = {};
        const langs = ["sub", "dub"];

        if (alId) {
            const langResults = await Promise.allSettled([
                fetchFlixServerList(null, episodeNum, "sub", alId),
                fetchFlixServerList(null, episodeNum, "dub", alId),
            ]);
            for (let i = 0; i < langResults.length; i++) {
                if (langResults[i].status === "fulfilled" && langResults[i].value.length) {
                    serversByLang[langs[i]] = langResults[i].value;
                }
            }
        }

        if (!Object.keys(serversByLang).length && searchTitle) {
            const anime = await queryReanimeIndex(searchTitle, searchYear, alId);
            if (anime) {
                const finalAlId = alId || anime.anilistId;
                const langResults = await Promise.allSettled([
                    fetchFlixServerList(anime.slug, episodeNum, "sub", finalAlId),
                    fetchFlixServerList(anime.slug, episodeNum, "dub", finalAlId),
                ]);
                for (let i = 0; i < langResults.length; i++) {
                    if (langResults[i].status === "fulfilled" && langResults[i].value.length) {
                        serversByLang[langs[i]] = langResults[i].value;
                    }
                }
            }
        }

        if (!Object.keys(serversByLang).length) return [];

        const streams = [];
        const seenUrls = {};
        const displayTitle = searchTitle || "Anime";

        for (let li = 0; li < langs.length; li++) {
            const lang = langs[li];
            const serverList = serversByLang[lang] || [];
            const streamLabel = mediaType === "movie"
                ? displayTitle + " (" + lang + ")"
                : displayTitle + " - Episode " + episodeNum + " (" + lang + ")";

            const jobs = [];
            for (let si = 0; si < serverList.length; si++) {
                const server = serverList[si];
                const dataLink = server.dataLink;
                if (!dataLink) continue;
                const serverTag = server.serverName || ("HD-" + (si + 1));
                jobs.push({ dataLink, serverTag, streamLabel });
            }

            const jobResults = await Promise.allSettled(jobs.map(async function (job) {
                const dl = await resolveFlixDownloadUrl(job.dataLink).catch(function () { return null; });
                return dl && dl.url ? { data: dl, job } : null;
            }));

            for (let ri = 0; ri < jobResults.length; ri++) {
                if (jobResults[ri].status !== "fulfilled" || !jobResults[ri].value) continue;
                const { data, job } = jobResults[ri].value;
                const dedupeKey = data.url.split("?")[0];
                if (seenUrls[dedupeKey]) continue;
                seenUrls[dedupeKey] = true;
                streams.push({
                    name: "Re:ANIME \u2022 " + job.serverTag,
                    title: "Re:ANIME \u2022 " + job.serverTag,
                    url: data.url,
                    quality: "1080p \u2022 MKV",
                    headers: data.headers || {},
                });
            }
        }

        return streams;
    } catch (e) {
        return [];
    }
}

module.exports = { getStreams };
