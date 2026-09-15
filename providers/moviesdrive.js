const PROVIDER = "MoviesDrive";
const BASE_URL = "https://new4.moviesdrive.christmas";
const TMDB_API = "https://api.themoviedb.org/3";
const MAX_RANK = 4;
const QUALITY_RANK = { "2160": 4, "4k": 4, "1080": 3, "720": 2, "480": 1 };
const REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Connection": "keep-alive",
};

function qualityRank(qNum) {
    return QUALITY_RANK[String(qNum)] || 0;
}

function getSortTag(rank) {
    let inv = Math.max(0, MAX_RANK - rank);
    let bin = inv.toString(2);
    while (bin.length < 20) bin = "0" + bin;
    return bin.split("").map(b => b === "1" ? "\uFEFF" : "\u200B").join("");
}

async function fetchHtml(url, referer) {
    try {
        const headers = referer ? { ...REQUEST_HEADERS, Referer: referer } : REQUEST_HEADERS;
        const res = await fetch(url, { headers });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: { ...REQUEST_HEADERS, Accept: "application/json" } });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

async function fetchTmdbMeta(tmdbId, mediaType) {
    const type = mediaType === "tv" ? "tv" : "movie";
    const data = await fetchJson(
        `${TMDB_API}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`,
    );
    if (!data) return null;
    return {
        title: data.title || data.name || "",
        imdbId: (data.external_ids && data.external_ids.imdb_id) || null,
    };
}

async function extractFslLink(hubUrl, referer) {
    try {
        let html = await fetchHtml(hubUrl, referer);
        if (!html) return null;

        let currentUrl = hubUrl;

        if (!hubUrl.includes("hubcloud.php")) {
            const $first = cheerio.load(html);
            let nextUrl = $first("#download").attr("href")
                || (html.match(/var url = '([^']*)'/) || [])[1]
                || "";

            if (nextUrl) {
                if (!nextUrl.startsWith("http")) {
                    const base = new URL(hubUrl);
                    nextUrl = `${base.protocol}//${base.hostname}/${nextUrl.replace(/^\//, "")}`;
                }
                html = await fetchHtml(nextUrl, hubUrl);
                if (!html) return null;
                currentUrl = nextUrl;
            }
        }

        const $ = cheerio.load(html);
        const size = $("i#size").text().trim() || null;
        const header = $("div.card-header").text().trim();
        const qMatch = header.match(/(\d{3,4})[pP]/);
        const qNum = qMatch ? parseInt(qMatch[1]) : 1080;

        const fslLink = $("a.btn").filter((_, el) => {
            const text = $(el).text().toLowerCase();
            return text.includes("fsl server") || text.includes("fslv2");
        }).first().attr("href") || null;

        if (!fslLink) return null;

        const label = fslLink.toLowerCase().includes("fslv2") ? "FSLv2" : "FSL";
        return { label, qNum, size, url: fslLink };
    } catch {
        return null;
    }
}

async function resolveHubCloudUrls(pageUrl) {
    try {
        const html = await fetchHtml(pageUrl, null);
        if (!html) return [];

        if (pageUrl.includes("search-recover.php")) {
            const qMatch = html.match(/const Q_INITIAL\s*=\s*"([^"]+)"/);
            const tokenMatch = html.match(/const FROM_AC_TOKEN\s*=\s*"([^"]+)"/);
            if (qMatch && tokenMatch) {
                const base = pageUrl.split("?")[0];
                const params = new URLSearchParams({ api: "search", q: qMatch[1], page: "1", from_ac: tokenMatch[1] });
                const data = await fetchJson(`${base}?${params}`);
                if (data && data.hits) return data.hits.map(h => h.url).filter(Boolean);
            }
        }

        const $ = cheerio.load(html);
        return $("a[href]")
            .map((_, el) => $(el).attr("href"))
            .get()
            .filter(href => /hubcloud/i.test(href));
    } catch {
        return [];
    }
}

function buildStreamResult(label, qNum, size, url) {
    const qStr = `${qNum}p`;
    const rank = qualityRank(qNum);
    const tag = getSortTag(rank);
    const displayName = `${PROVIDER} • ${label} • ${qStr}`;
    return {
        name: tag + displayName,
        title: tag + displayName,
        url,
        quality: qStr,
        ...(size ? { size } : {}),
    };
}

async function resolveMovieStreams(downloadLinks, pageUrl) {
    const seen = new Set(downloadLinks);
    const hubUrls = (await Promise.all([...seen].map(link => resolveHubCloudUrls(link)))).flat();

    const results = await Promise.all(hubUrls.map(u => extractFslLink(u, pageUrl)));
    return results.filter(Boolean);
}

async function resolveEpisodeStreams(pageUrl, episode) {
    const html = await fetchHtml(pageUrl, null);
    if (!html) return [];

    const $ = cheerio.load(html);
    const epRegex = new RegExp(`Ep${String(episode).padStart(2, "0")}|Ep${episode}`, "i");

    const hubUrls = [];
    $("h5").filter((_, el) => epRegex.test($(el).text())).each((_, entry) => {
        const a1 = $(entry).next().find("a").attr("href");
        const a2 = $(entry).next().next().find("a").attr("href");
        if (a1) hubUrls.push(a1);
        if (a2) hubUrls.push(a2);
    });

    const results = await Promise.all(hubUrls.map(u => extractFslLink(u, pageUrl)));
    return results.filter(Boolean);
}

function applyLimits(rawStreams) {
    function parseSizeBytes(sizeStr) {
        const m = (sizeStr || "").match(/([\d.]+)\s*(GB|MB|KB)/i);
        if (!m) return 0;
        const val = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        if (unit === "GB") return val * 1073741824;
        if (unit === "MB") return val * 1048576;
        if (unit === "KB") return val * 1024;
        return 0;
    }

    const seen = new Set();
    const deduped = rawStreams.filter(s => s.url && s.qNum >= 1080 && !seen.has(s.url) && seen.add(s.url));

    const above1080 = deduped
        .filter(s => s.qNum > 1080)
        .sort((a, b) => parseSizeBytes(b.size) - parseSizeBytes(a.size))
        .slice(0, 3);
    const at1080 = deduped
        .filter(s => s.qNum === 1080)
        .sort((a, b) => parseSizeBytes(b.size) - parseSizeBytes(a.size))
        .slice(0, 2);

    return [...above1080, ...at1080].map(s => buildStreamResult(s.label, s.qNum, s.size, s.url));
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (mediaType === "tv" && (season == null || episode == null)) return [];

        const meta = await fetchTmdbMeta(tmdbId, mediaType);
        if (!meta || !meta.imdbId) return [];

        const { title, imdbId } = meta;

        const searchData = await fetchJson(`${BASE_URL}/search.php?q=${imdbId}`);
        if (!searchData) return [];

        const match = (searchData.hits || [])
            .map(h => h.document)
            .find(d => d.imdb_id === imdbId);
        if (!match) return [];

        const pageUrl = match.permalink.startsWith("http") ? match.permalink : `${BASE_URL}${match.permalink}`;
        const pageHtml = await fetchHtml(pageUrl, null);
        if (!pageHtml) return [];

        const $ = cheerio.load(pageHtml);
        let rawStreams = [];

        if (mediaType === "movie") {
            const downloadLinks = $("h5 > a").map((_, el) => $(el).attr("href")).get().filter(Boolean);
            rawStreams = await resolveMovieStreams(downloadLinks, pageUrl);
        } else {
            const seasonRegex = new RegExp(`Season ${season}`, "i");
            const seasonPageUrls = [];
            $("h5").filter((_, el) => seasonRegex.test($(el).text())).each((_, entry) => {
                const href = $(entry).next().find("a").attr("href");
                if (href) seasonPageUrls.push(href);
            });

            const batches = await Promise.all(seasonPageUrls.map(u => resolveEpisodeStreams(u, episode)));
            rawStreams = batches.flat();
        }

        return applyLimits(rawStreams);
    } catch {
        return [];
    }
}

module.exports = { getStreams };
