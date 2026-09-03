"use strict";

const MAIN_URL = "https://animesalt.cx";
const TMDB_API_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
  "Referer": "https://animesalt.cx/",
};

async function fetchHtml(url, options = {}) {
  const resolvedUrl = url.startsWith("http") ? url : `${MAIN_URL}${url}`;
  try {
    const response = await fetch(resolvedUrl, { headers: HEADERS, ...options });
    if (!response.ok) return "";
    return await response.text();
  } catch (_) {
    return "";
  }
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, { headers: HEADERS, ...options });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function fetchTmdbMetadata(tmdbId, mediaType) {
  const endpoint = mediaType === "movie" ? "movie" : "tv";
  const data = await fetchJson(
    `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`
  );
  if (!data) return null;
  const title = data.title || data.name;
  const year = parseInt((data.release_date || data.first_air_date || "").split("-")[0]) || null;
  return { title, year };
}

async function fetchEpisodeTitle(tmdbId, season, episode) {
  const data = await fetchJson(
    `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?api_key=${TMDB_API_KEY}`
  );
  const episodeNumber = parseInt(episode) || 1;
  return data?.episodes?.find((ep) => ep.episode_number === episodeNumber)?.name || "";
}

function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function extractSearchEntries(html, mediaType) {
  const containerMatch = html.match(/id="movies-a"([\s\S]*?)(?=<footer|id="footer|class="footer)/m);
  const contentHtml = containerMatch ? containerMatch[1] : html;

  const entries = [];
  const visitedSlugs = new Set();
  const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/g;

  let match;
  while ((match = articlePattern.exec(contentHtml)) !== null) {
    const articleHtml = match[1];
    const linkMatch = articleHtml.match(/href="(https:\/\/animesalt\.cx\/(series|movies)\/([^\/\"]+)\/?)"/);
    const titleMatch = articleHtml.match(/class="entry-title"[^>]*>([^<]+)</);
    const yearMatch = articleHtml.match(/class="year"[^>]*>(\d{4})</);

    if (!linkMatch || !titleMatch) continue;
    const [, url, type, slug] = linkMatch;
    if (!slug || slug === "page" || visitedSlugs.has(slug)) continue;

    visitedSlugs.add(slug);
    entries.push({ url, type, slug, title: titleMatch[1].trim(), year: yearMatch ? +yearMatch[1] : null });
  }

  const typed = entries.filter((entry) => entry.type === (mediaType === "movie" ? "movies" : "series"));
  return typed.length ? typed : entries;
}

function selectTopCandidate(entries, title, year) {
  let pool = entries;

  if (year) {
    const yearAligned = entries.filter((e) => e.year !== null && Math.abs(e.year - year) <= 1);
    const undated = entries.filter((e) => e.year === null);
    pool = yearAligned.length ? yearAligned : undated.length ? undated : entries;
  }

  const normalizedQuery = normalizeTitle(title);
  pool.sort((a, b) => {
    const na = normalizeTitle(a.title), nb = normalizeTitle(b.title);
    const exactDiff = (na === normalizedQuery ? 0 : 1) - (nb === normalizedQuery ? 0 : 1);
    if (exactDiff !== 0) return exactDiff;
    const prefixDiff = (na.startsWith(normalizedQuery) ? 0 : 1) - (nb.startsWith(normalizedQuery) ? 0 : 1);
    if (prefixDiff !== 0) return prefixDiff;
    return na.length - nb.length;
  });

  return pool[0] || null;
}

async function resolveAnimePageUrl(title, mediaType, year) {
  const html = await fetchHtml(`/?s=${encodeURIComponent(title)}`);
  if (!html) return null;
  const entries = extractSearchEntries(html, mediaType);
  if (!entries.length) return null;
  const candidate = selectTopCandidate(entries, title, year);
  return candidate ? candidate.url : null;
}

function extractEpisodeUrl(html, season, episode) {
  const pattern = new RegExp(`href="(https://animesalt\\.cx/episode/[^"]*${season}x${episode}[^"]*)"`);
  return pattern.exec(html)?.[1] ?? null;
}

async function resolveEpisodeUrl(seriesPageUrl, season, episode) {
  const html = await fetchHtml(seriesPageUrl);
  if (!html) return null;

  const seasonEntries = [];
  const seasonPattern = /data-post="(\d+)"\s+data-season="(\d+)"/g;
  let match;
  while ((match = seasonPattern.exec(html)) !== null) {
    seasonEntries.push({ post: match[1], season: +match[2] });
  }

  if (!seasonEntries.length) return extractEpisodeUrl(html, season, episode);

  const targetSeason = seasonEntries.find((s) => s.season === +season);
  if (!targetSeason) return null;

  const seasonHtml = await fetchHtml(
    `/wp-admin/admin-ajax.php?action=action_select_season&season=${season}&post=${targetSeason.post}`
  );
  return seasonHtml ? extractEpisodeUrl(seasonHtml, season, episode) : null;
}

async function resolveStreamData(pageUrl) {
  const html = await fetchHtml(pageUrl);
  if (!html) return null;

  const playerMatch = html.match(/src="(https:\/\/as-cdn\d+\.top\/video\/([a-f0-9]+))"/);
  if (!playerMatch) return null;

  const [, playerUrl, videoHash] = playerMatch;
  const cdnOrigin = playerUrl.split("/video/")[0];

  try {
    const response = await fetch(`${cdnOrigin}/player/index.php?data=${videoHash}&do=getVideo`, {
      method: "POST",
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": cdnOrigin,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: `hash=${videoHash}&r=${encodeURIComponent(MAIN_URL + "/")}`,
    });
    if (!response.ok) return null;

    const payload = await response.json();
    const m3u8Url = payload.videoSource || payload.securedLink;
    if (!m3u8Url) return null;

    const contentHash = m3u8Url.match(/\/hls\/([a-f0-9]+)\//)?.[1] ?? videoHash;
    const cdnBase = m3u8Url.split("/cdn/hls/")[0];
    const subtitleUrl = `${cdnBase}/cdn/down/${contentHash}/Subtitle/subtitle_eng.srt`;

    return { url: m3u8Url, subtitle: subtitleUrl, cdnBase };
  } catch (_) {
    return null;
  }
}

async function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType === "tv" && (season == null || episode == null)) return [];

  try {
    const metadata = await fetchTmdbMetadata(tmdbId, mediaType);
    if (!metadata?.title) return [];

    const { title, year } = metadata;

    const episodeTitle = mediaType === "tv"
      ? await fetchEpisodeTitle(tmdbId, season, episode)
      : "";

    const animePageUrl = await resolveAnimePageUrl(title, mediaType, year);
    if (!animePageUrl) return [];

    let stream = null;
    if (mediaType === "movie") {
      stream = await resolveStreamData(animePageUrl);
    } else {
      const episodeUrl = await resolveEpisodeUrl(animePageUrl, season, episode);
      if (episodeUrl) stream = await resolveStreamData(episodeUrl);
    }

    if (!stream) return [];

    const episodeLabel = mediaType === "tv" && season && episode
      ? ` • Episode ${episode}${episodeTitle ? ` - ${episodeTitle}` : ""}`
      : "";

    return [{
      name: "AnimeSalt.",
      title: "AnimeSalt",
      url: stream.url,
      quality: "1080p",
      headers: {
        "Referer": stream.cdnBase + "/",
        "Origin": stream.cdnBase,
        "User-Agent": HEADERS["User-Agent"],
      },
      subtitles: stream.subtitle
        ? [{ url: stream.subtitle, lang: "en", name: "English" }]
        : [],
    }];
  } catch (_) {
    return [];
  }
}

module.exports = { getStreams };
