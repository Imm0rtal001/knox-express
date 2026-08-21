"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const WAELUM_API = "https://hdghartv.cc";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const BASE_HEADERS = {
    "User-Agent": UA,
    "Referer": WAELUM_API + "/"
};
const MIN_RESOLUTION = 720;
function getQualityLabel(str) {
    if (!str)
        return "Unknown";
    const match = str.match(/(\d{3,4})[pP]/);
    if (match)
        return `${match[1]}p`;
    const lower = str.toLowerCase();
    if (lower.includes("8k"))
        return "4320p";
    if (lower.includes("4k"))
        return "2160p";
    if (lower.includes("2k"))
        return "1440p";
    return "Unknown";
}
function parseResolution(label) {
    const match = label.match(/(\d{3,4})p/);
    return match ? parseInt(match[1], 10) : 0;
}
function fetchTmdbTitle(tmdbId, mediaType) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const endpoint = mediaType === "tv" ? "tv" : "movie";
            const res = yield fetch(`${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${TMDB_KEY}`);
            if (!res.ok)
                return null;
            const data = yield res.json();
            return mediaType === "tv" ? data.name : data.title;
        }
        catch (_a) {
            return null;
        }
    });
}
function getStreams(tmdbId, mediaType, season, episode) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            if (mediaType === "tv" && (season == null || episode == null))
                return [];
            const isTv = mediaType === "tv";
            const type = isTv ? "series" : "movies";
            const title = yield fetchTmdbTitle(tmdbId, mediaType);
            if (!title)
                return [];
            const searchRes = yield fetch(`${WAELUM_API}/api/search?q=${encodeURIComponent(title)}&type=all&page=1`, { headers: BASE_HEADERS });
            if (!searchRes.ok)
                return [];
            const searchData = yield searchRes.json();
            const allItems = [
                ...(searchData.movies || []),
                ...(searchData.series || [])
            ];
            const matched = allItems.find(item => item.tmdbId === Number(tmdbId));
            if (!matched || !matched._id)
                return [];
            const detailsRes = yield fetch(`${WAELUM_API}/api/${type}/public/${matched._id}`, { headers: BASE_HEADERS });
            if (!detailsRes.ok)
                return [];
            const details = yield detailsRes.json();
            let links = [];
            if (!isTv) {
                links = details.streamingLinks || [];
            }
            else {
                const targetSeason = (details.seasons || []).find(s => s.seasonNumber === season);
                if (!targetSeason)
                    return [];
                const targetEpisode = (targetSeason.episodes || []).find(e => e.episodeNumber === episode);
                if (!targetEpisode)
                    return [];
                links = targetEpisode.streamingLinks || [];
            }
            const streams = [];
            for (const link of links) {
                if (!link.url)
                    continue;
                const quality = getQualityLabel(link.quality);
                if (parseResolution(quality) < MIN_RESOLUTION)
                    continue;
                streams.push({
                    name: "HdGharTV",
                    title: `HdGharTV • ${quality}`,
                    url: link.url,
                    quality,
                    headers: BASE_HEADERS
                });
            }
            streams.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
            return streams;
        }
        catch (e) {
            return [];
        }
    });
}
module.exports = { getStreams };

