"use strict";

const TMDB_API_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const MAIN_URL = "https://app.cloud-mb.xyz";
const TOKEN = "jdvhhjv255vghhgdhvfch2565656jhdcghfdf";
const PACKAGE_NAME = "com.movieblast";
const CERT_SIGNATURE = "308202e4308201cc020101300d06092a864886f70d010105050030373116301406035504030c0d416e64726f69642044656275673110300e060355040a0c07416e64726f6964310b30090603550406130255533020170d3234313231393135323335335a180f32303534313231323135323335335a30373116301406035504030c0d416e64726f69642044656275673110300e060355040a0c07416e64726f6964310b300906035504061302555330820122300d06092a864886f70d01010105000382010f003082010a0282010100be59a34bdaf2d2531e252aa5e2f08489302f661514c629c0f403c736b1f8910bbac353899d8c29d93e18841dd15799907d8136999bb751a29d657e5403364e10b86c9b5eaab4c86803f7df16c4749499e00e198e8f8dbe87c17ed5997c395edafa49d37b159baefecdc8e155386044f224ba2bfa3639efc4ac4a6387583825ee513c9ea594d4496cfb689a93363e70ad1c99f8a22e0a4e19fb70bcbebec9373e41a455e2e4aa0af8d2b896e4ff5cb38cee59b2c8be86271bea10b003a3a6740fd342fd99509727f2b9a1cbfae730f51548b9c7330c52530b4cc25a8bde4c6f52a77b2c26962bcd2dcc3feb5170abe269aec62e0183d1f3d072a9b4fe86bb763f0203010001300d06092a864886f70d010105050003820101003645510973db07823e9dcb9c057da7dda183c671a38ede1b608bc7917405bbd6e3f955d31dfe6eb22038c1818b83a7335e30606ddac331b5db29063c8d3c1e7ffd23ef752d1aaba28d3ce31a16e9ebb3e0a5529d7747fef6da79fc19c24676c1d812d209d2a2da3a8fa6a43d8c9a4cc1e1f5e0309d0e69376dec7aa5e0625be248409cee8626f89d67bd477baf5937c0362eef12491bb79e791cdde210ff9c7853d5ebdb3ef6e81904bc0604896295387513c68d39c091d0fb11de9049402a3cb0e7975c328fe8d34b9f6ecae2ca45f2dab3b09075bab1360977c3af37759168225892a62fbf64f8c28ced2664a65e61b6837ba0103e484a59b9c4715d759ee3";
const HMAC_SECRET = "GJ8reydarI7Jqat9rvbAJKNQ9gY4DoEQF2H5nfuI1gi";

const CryptoJS = typeof require === "function" ? require("crypto-js") : globalThis.CryptoJS;

const SEARCH_HEADERS = {
    "hash256": "86dc03244adddb3cbedbf0ae36074a736ee293a64774b18e82a6244eafd0df30",
    "packagename": PACKAGE_NAME,
    "signature": CERT_SIGNATURE,
    "User-Agent": "MovieBlast"
};

function httpsify(url) {
    return url && !url.startsWith("http") ? `https://${url}` : url;
}

function generateSignedUrl(url) {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const timestamp = String(Math.floor(Date.now() / 1e3));
    const signature = CryptoJS.HmacSHA256(path + timestamp, HMAC_SECRET).toString(CryptoJS.enc.Base64);
    return `${url}?verify=${timestamp}-${encodeURIComponent(signature)}`;
}

function matchQualityFromString(s) {
    if (!s) return "Unknown";
    const v = s.toLowerCase();
    if (v.includes("2160") || v.includes("4k")) return "2160p";
    if (v.includes("1440")) return "1440p";
    if (v.includes("1080") || v.includes("fullhd")) return "1080p";
    if (v.includes("720") || v.includes("hd")) return "720p";
    if (v.includes("480")) return "480p";
    if (v.includes("360")) return "360p";
    return "Unknown";
}

async function searchMedia(query) {
    const safeQuery = query.trim().replace(/ /g, "%20");
    const url = `${MAIN_URL}/api/search/${safeQuery}/${TOKEN}`;
    const res = await fetch(url, { headers: SEARCH_HEADERS });
    const json = await res.json();
    const list = json && Array.isArray(json.search) ? json.search : [];
    return list.map((item) => {
        const isSeries = (item.type || "").toLowerCase().includes("serie");
        const path = isSeries ? "series/show" : "media/detail";
        return {
            name: item.name,
            isSeries,
            url: `${MAIN_URL}/api/${path}/${item.id}/${TOKEN}`
        };
    });
}

async function loadDetail(url) {
    const res = await fetch(url);
    const json = await res.json();
    const seasons = Array.isArray(json.seasons) ? json.seasons : [];
    if (seasons.length > 0) {
        return { isSeries: true, seasons };
    }
    const videos = Array.isArray(json.videos) ? json.videos : [];
    return { isSeries: false, videos };
}

function extractLoadUrls(videos) {
    return (videos || []).map((v) => ({ link: v.link, server: v.server, lang: v.lang })).filter((v) => v.link);
}

function toStream(loadUrl) {
    if (!loadUrl.link) return null;
    const signed = generateSignedUrl(httpsify(loadUrl.link));
    const quality = matchQualityFromString(loadUrl.server);
    return {
        url: signed,
        quality,
        title: `MovieBlast • ${quality}`,
        name: `MovieBlast • ${quality}`,
        headers: {
            "Connection": "Keep-Alive",
            "Icy-MetaData": "1",
            "Referer": "MovieBlast",
            "User-Agent": "MovieBlast",
            "x-request-x": PACKAGE_NAME
        }
    };
}

function normalizeTitle(title) {
    return (title || "").toLowerCase()
        .replace(/\b(the|a|an)\b/g, "")
        .replace(/[:\-_]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function findBestMatch(title, results) {
    const normTarget = normalizeTitle(title);
    let best = null;
    let bestScore = 0;
    for (const r of results) {
        const norm = normalizeTitle(r.name);
        let score = 0;
        if (norm === normTarget) score = 1;
        else if (norm.includes(normTarget) || normTarget.includes(norm)) score = 0.8;
        else {
            const w1 = new Set(normTarget.split(" ").filter((w) => w.length > 2));
            const w2 = new Set(norm.split(" ").filter((w) => w.length > 2));
            const inter = [...w1].filter((w) => w2.has(w));
            score = w1.size ? inter.length / w1.size : 0;
        }
        if (score > bestScore) {
            bestScore = score;
            best = r;
        }
    }
    return best;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        if (mediaType === "tv" && (season == null || episode == null)) return [];

        const type = mediaType === "tv" ? "tv" : "movie";
        const tmdbUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`;
        const tmdbRes = await fetch(tmdbUrl);
        const tmdbInfo = await tmdbRes.json();
        const title = tmdbInfo.title || tmdbInfo.name;
        if (!title) return [];

        const results = await searchMedia(title);
        if (results.length === 0) return [];

        const wantSeries = mediaType === "tv";
        const filtered = results.filter((r) => r.isSeries === wantSeries);
        const pool = filtered.length > 0 ? filtered : results;
        const match = findBestMatch(title, pool) || pool[0];
        if (!match) return [];

        const detail = await loadDetail(match.url);
        let videos = [];
        if (detail.isSeries) {
            if (!season || !episode) return [];
            const seasonObj = detail.seasons.find((s) => (s.season_number || 0) === Number(season));
            if (!seasonObj) return [];
            const episodes = Array.isArray(seasonObj.episodes) ? seasonObj.episodes : [];
            const episodeObj = episodes.find((e) => (e.episode_number || 0) === Number(episode));
            if (!episodeObj) return [];
            videos = Array.isArray(episodeObj.videos) ? episodeObj.videos : [];
        } else {
            videos = detail.videos;
        }

        const loadUrls = extractLoadUrls(videos);
        const streams = loadUrls.map(toStream).filter(Boolean);

        const qualityOrder = { "2160p": 5, "1440p": 4, "1080p": 3, "720p": 2, "480p": 1, "360p": 0, "Unknown": -1 };
        streams.sort((a, b) => (qualityOrder[b.quality] ?? -1) - (qualityOrder[a.quality] ?? -1));

        return streams.filter(s => (qualityOrder[s.quality] ?? -1) >= 2);
    } catch (e) {
        return [];
    }
}

module.exports = { getStreams };