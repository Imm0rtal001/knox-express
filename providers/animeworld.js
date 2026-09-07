"use strict";

const cheerio = require("cheerio");
const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_API_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const BASE_URL = "https://watchanimeworld.one";
const PLAYER_BASE_URL = "https://play.zephyrix.org";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const HEADER = { "User-Agent": USER_AGENT };

async function performGetRequest(url, headers = {}) {
  const response = await fetch(url, { headers: { ...HEADER, ...headers } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function performPostRequest(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...HEADER, "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchFromTmdb(path) {
  try {
    const response = await fetch(`${TMDB_API_URL}/${path}?api_key=${TMDB_API_KEY}`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function searchAnimeSite(title, mediaType) {
  try {
    const response = await performGetRequest(`${BASE_URL}/?s=${encodeURIComponent(title)}`, { "Referer": `${BASE_URL}/` });
    const html = await response.text();
    const $ = cheerio.load(html);
    const seenUrls = new Set();
    const results = [];

    $("a[href]").each((_, element) => {
      const href = $(element).attr("href") || "";
      const match = href.match(/^https?:\/\/[^/]+\/(series|movies)\/([^/]+)\//);
      if (!match || match[2] === "page" || seenUrls.has(href)) return;
      const isCorrectType = mediaType === "movie" ? match[1] === "movies" : match[1] === "series";
      if (!isCorrectType) return;
      seenUrls.add(href);
      results.push(href);
    });

    return results;
  } catch {
    return [];
  }
}

async function resolveEpisodeUrl(seriesUrl, seasonNumber, episodeNumber) {
  const response = await performGetRequest(seriesUrl, { "Referer": `${BASE_URL}/` });
  const html = await response.text();
  const epPattern = `${seasonNumber}x${episodeNumber}`;
  const postIdMatch = html.match(/postid-(\d+)/) || html.match(/data-post="(\d+)"/);

  if (postIdMatch) {
    try {
      const ajaxResponse = await performGetRequest(
        `${BASE_URL}/wp-admin/admin-ajax.php?action=action_select_season&season=${seasonNumber}&post=${postIdMatch[1]}`,
        { "Referer": seriesUrl }
      );
      const ajaxHtml = await ajaxResponse.text();
      const url = findEpisodeInHtml(ajaxHtml, epPattern);
      if (url) return url;
    } catch {
      // fall through
    }
  }

  return findEpisodeInHtml(html, epPattern);
}

function findEpisodeInHtml(html, epPattern) {
  const re = /href="(https?:\/\/[^"]+\/episode\/([^"]+))"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].includes(epPattern) || m[2].includes(epPattern)) return m[1];
  }
  return null;
}

async function extractStreamData(pageUrl) {
  const response = await performGetRequest(pageUrl, { "Referer": `${BASE_URL}/` });
  const html = await response.text();

  let streamMatch = html.match(/(?:src|data-src)="(https?:\/\/play\.[^"]+\/video\/([a-f0-9]+))"/i);
  if (!streamMatch) {
    const loose = html.match(/https?:\/\/play\.(zephyrflick|zephyrix)\.[^/\s"]+\/video\/([a-f0-9]+)/i);
    if (loose) streamMatch = [null, `${PLAYER_BASE_URL}/video/${loose[2]}`, loose[2]];
  }
  if (!streamMatch) return null;

  const playerPageUrl = streamMatch[1];
  const videoHash = streamMatch[2];

  let sessionCookie = "";
  try {
    const playerPageRes = await fetch(playerPageUrl, {
      headers: { ...HEADER, "Referer": `${BASE_URL}/` }
    });
    const rawCookie = playerPageRes.headers.get("set-cookie") || "";
    sessionCookie = rawCookie
      .split(/,(?=[^;]+=[^;]+)/)
      .map(c => c.trim().split(";")[0])
      .filter(Boolean)
      .join("; ");
  } catch {
    // non-fatal
  }

  const postHeaders = {
    "Referer": playerPageUrl,
    "Origin": PLAYER_BASE_URL,
    "X-Requested-With": "XMLHttpRequest",
    ...(sessionCookie ? { "Cookie": sessionCookie } : {})
  };

  const postData = await performPostRequest(
    `${PLAYER_BASE_URL}/player/index.php?data=${videoHash}&do=getVideo`,
    `hash=${videoHash}&r=${encodeURIComponent(`${BASE_URL}/`)}`,
    postHeaders
  );

  const m3u8Url = postData.securedLink || postData.videoSource || postData.source || postData.file;
  if (!m3u8Url) return null;

  const hashMatch = m3u8Url.match(/\/cdn\/hls\/([a-f0-9]+)\//);
  const contentHash = hashMatch ? hashMatch[1] : videoHash;

  return {
    url: m3u8Url,
    streamHeaders: {
      "Referer": `${PLAYER_BASE_URL}/`,
      "Origin": PLAYER_BASE_URL,
      "User-Agent": USER_AGENT,
      ...(sessionCookie ? { "Cookie": sessionCookie } : {})
    },
    subtitle: `${PLAYER_BASE_URL}/cdn/down/${contentHash}/Subtitle/subtitle_eng.srt`
  };
}

async function getStreams(tmdbId, mediaType = "tv", seasonNumber = 1, episodeNumber = 1) {
  try {
    if (mediaType === "tv" && (seasonNumber == null || episodeNumber == null)) return [];

    const [mediaEntry, seasonEpisodes] = await Promise.all([
      fetchFromTmdb(`${mediaType}/${tmdbId}`),
      mediaType === "tv" ? fetchFromTmdb(`tv/${tmdbId}/season/${seasonNumber}`) : Promise.resolve(null)
    ]);

    if (!mediaEntry) return [];
    const mediaTitle = mediaEntry.name || mediaEntry.title;
    if (!mediaTitle) return [];

    if (mediaType === "tv" && seasonEpisodes?.episodes) {
      const episodeNumberInt = parseInt(episodeNumber, 10) || 1;
      seasonEpisodes.episodes.find(ep => ep.episode_number === episodeNumberInt);
    }

    const searchResults = await searchAnimeSite(mediaTitle, mediaType);
    if (!searchResults.length) return [];

    let streamData = null;

    if (mediaType === "movie") {
      streamData = await extractStreamData(searchResults[0]);
    } else {
      let episodeUrl = await resolveEpisodeUrl(searchResults[0], seasonNumber, episodeNumber);
      if (!episodeUrl && seasonNumber !== 1) {
        episodeUrl = await resolveEpisodeUrl(searchResults[0], 1, episodeNumber);
      }
      if (episodeUrl) streamData = await extractStreamData(episodeUrl);
    }

    if (!streamData) return [];

    return [{
      name: "AnimeWorld • Zephyrix",
      title: "AnimeWorld • Zephyrix",
      url: streamData.url,
      quality: "1080p",
      headers: streamData.streamHeaders,
      subtitles: streamData.subtitle
        ? [{ url: streamData.subtitle, language: "en", name: "English" }]
        : []
    }];
  } catch {
    return [];
  }
}

module.exports = { getStreams };
