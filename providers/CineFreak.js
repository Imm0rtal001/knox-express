"use strict";

const PROVIDER_NAME = 'CineFreak';
const BASE_URL = 'https://cinefreak.net';
const ECLIPSIA_BASE = 'https://new5.cinecloud.site';
const TMDB_API_KEY = '307b7b8ef035c6aa336900aef4e203bd';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

function encodeUri(str) {
  try { return encodeURIComponent(str); } catch (_) { return str; }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res || !res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function fetchJson(url) {
  try {
    const text = await fetchText(url);
    if (!text) return null;
    return JSON.parse(text);
  } catch { return null; }
}

function parseQuality(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.indexOf('2160') !== -1 || s.indexOf('4k') !== -1) return '2160p';
  if (s.indexOf('1080') !== -1) return '1080p';
  if (s.indexOf('720') !== -1)  return '720p';
  if (s.indexOf('480') !== -1)  return '480p';
  return 'HD';
}

function formatTitle(t, size, quality) {
  t = String(t || '');
  size = size || 'Unknown';
  const src   = /bluray|blu\-ray|bdrip/i.test(t) ? 'Blu-ray' : /hdrip|webrip/i.test(t) ? 'WEBRip' : 'WEB-DL';
  const imax  = /imax/i.test(t) ? ' • IMAX' : '';
  const range = /dolby\s*vision|dovi/i.test(t) ? 'Dolby Vision' : /hdr10/i.test(t) ? 'HDR10' : /hdr/i.test(t) ? 'HDR' : /10bit|10\-bit/i.test(t) ? '10-Bit' : /sdr/i.test(t.toLowerCase()) ? 'SDR' : '';
  const codec = /hevc|x265|h265/i.test(t) ? 'H.265' : 'H.264';
  let audio   = 'AAC';
  const am = t.match(/(TrueHD\s*7\.1|DDP\s*7\.1|DDP\s*5\.1|DD\s*5\.1|5\.1|AAC)/i);
  if (am) {
    audio = am[1].toUpperCase().replace(/\s+/g, '');
    if (audio === '5.1') audio = 'DDP5.1';
    if (audio.includes('TRUEHD')) audio = 'TrueHD 7.1';
  } else if (/dolby\s*digital|dd/i.test(t)) {
    audio = 'Dolby Digital';
  }
  if (/atmos/i.test(t)) audio += ' • Atmos';
  const line1 = `${quality || ''}${size !== 'Unknown' ? ` • ${size}` : ''}`;
  const line2 = `${src}${imax} • ${audio}${range ? ' • ' + range : ''} • ${codec}`;
  return `${line1}\n${line2}`;
}

function filterQualities(qualities) {
  if (!qualities || !qualities.length) return [];
  const filtered = qualities.filter(q => q.quality === '1080p' || q.quality === '2160p');
  const ORDER = { '2160p': 0, '1080p': 1 };
  return filtered.sort((a, b) => ORDER[a.quality] - ORDER[b.quality]);
}

function extractHash(url) {
  if (!url) return '';
  const fi = url.indexOf('/f/');
  const xi = url.indexOf('/x/');
  const start = fi >= 0 ? fi + 3 : xi >= 0 ? xi + 3 : -1;
  if (start < 0) return '';
  return url.substring(start);
}

function isFslPath(url) {
  return url && (url.indexOf('/f/') !== -1 || url.indexOf('/x/') !== -1);
}

function extractFslUrl(html) {
  const NEEDLE = 'href="https://pub-';
  const start  = html.indexOf(NEEDLE);
  if (start === -1) return null;
  const urlStart = start + 6;
  const urlEnd   = html.indexOf('"', urlStart);
  if (urlEnd === -1) return null;
  return html.substring(urlStart, urlEnd).replace(/&amp;/g, '&');
}

function decodeGenerateUrl(encodedId) {
  try {
    return atob(encodedId).replace(/newgo32$/, '');
  } catch { return null; }
}

async function resolveFslUrl(fslPath) {
  if (!fslPath) return null;
  const hash = extractHash(fslPath);
  if (!hash) return null;
  const subPath = fslPath.indexOf('/x/') !== -1 ? 'x' : 'f';
  const html = await fetchText(`${ECLIPSIA_BASE}/${subPath}/${hash}`);
  if (!html) return null;
  return extractFslUrl(html);
}

function extractAllGenerateLinks(html) {
  if (!html) return [];
  const NEEDLE = '/generate.php?id=';
  const links  = [];
  let pos = 0;
  while (true) {
    const hrefStart = html.indexOf(NEEDLE, pos);
    if (hrefStart === -1) break;
    const aOpen = html.lastIndexOf('<a ', hrefStart);
    if (aOpen === -1 || aOpen < pos) { pos = hrefStart + 1; continue; }
    const aClose = html.indexOf('</a>', hrefStart);
    if (aClose === -1) { pos = hrefStart + 1; continue; }
    const gtIdx = html.indexOf('>', hrefStart);
    if (gtIdx === -1 || gtIdx > aClose) { pos = aClose + 4; continue; }
    const label    = html.substring(gtIdx + 1, aClose).trim();
    const quoteIdx = html.indexOf('"', hrefStart);
    if (quoteIdx === -1) { pos = aClose + 4; continue; }
    const attrSnippet = html.substring(hrefStart, quoteIdx);
    const idMatch     = attrSnippet.match(/id=([a-zA-Z0-9+/=]+)/);
    if (!idMatch) { pos = aClose + 4; continue; }
    const encodedId  = idMatch[1];
    const decodedUrl = decodeGenerateUrl(encodedId) || '';
    links.push({ encodedId, decodedUrl, label });
    pos = aClose + 4;
  }
  return links;
}

function extractMovieQualities(html) {
  if (!html) return [];
  const sections = html.split('dlbtn-container');
  const results  = [];
  for (let i = 1; i < sections.length; i++) {
    const current  = sections[i];
    const previous = sections[i - 1];
    const linkMatch = current.match(
      /href="(?:https?:\/\/[^"]*?)?\/generate\.php\?id=([a-zA-Z0-9+/=]+)"/
    );
    if (!linkMatch) continue;
    const encodedId  = linkMatch[1];
    const decodedUrl = decodeGenerateUrl(encodedId);
    if (!decodedUrl || !isFslPath(decodedUrl)) continue;
    let rawLabel = '';
    const lm1 = previous.match(/<\/span>\s*([^<]*?(?:2160|1080|720|480|4K)[^<]*?)\s*\[/i);
    if (lm1) {
      rawLabel = lm1[1].trim();
    } else {
      const lm2 = previous.match(/\b(?:4K\s*2160p|UHD|2160p|1080p|720p|480p|SD|HD)\b/i);
      if (lm2) rawLabel = lm2[0];
    }
    if (!rawLabel) rawLabel = decodedUrl;
    const quality = parseQuality(rawLabel);
    if (!results.some(r => r.decodedUrl === decodedUrl)) {
      results.push({ encodedId, decodedUrl, label: rawLabel, quality });
    }
  }
  return results;
}

function extractEpisodeQualities(html, episodeNumber) {
  if (!html) return [];
  const cards = html.split('<div class="ep-card"');
  const patterns = [
    /episode-badge[^>]*>\s*(?:Episode\s*)?(\d+)/i,
    /ep-num[^>]*>\s*(\d+)\s*</i,
    /data-episode="(\d+)"/i,
    /\bEpisode\s+(\d+)\b/i,
  ];
  let targetCard = null;
  for (let i = 1; i < cards.length; i++) {
    for (const pat of patterns) {
      const m = cards[i].match(pat);
      if (m && parseInt(m[1], 10) === episodeNumber) { targetCard = cards[i]; break; }
    }
    if (targetCard) break;
  }
  if (!targetCard) return [];
  const links   = extractAllGenerateLinks(targetCard);
  const results = [];
  for (const link of links) {
    if (!link.decodedUrl || !isFslPath(link.decodedUrl)) continue;
    const quality = parseQuality(link.label || link.decodedUrl);
    if (!results.some(r => r.decodedUrl === link.decodedUrl)) {
      results.push({ encodedId: link.encodedId, decodedUrl: link.decodedUrl, label: link.label || quality, quality });
    }
  }
  return results;
}

function wordMatchScore(query, target) {
  const words = String(query || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  let total = 0, matched = 0;
  for (const word of words) {
    if (word.length < 3) continue;
    total++;
    const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(target)) matched++;
  }
  return total === 0 ? 0 : matched / total;
}

function titleStartsWith(candidate, query) {
  const c = String(candidate || '').toLowerCase().trim();
  const q = String(query || '').toLowerCase().trim();
  return c.indexOf(q) === 0 || c.indexOf(q + ' ') === 0 || c.indexOf('(' + q + ')') === 0;
}

function urlContains(url, title) {
  const u    = String(url || '').toLowerCase();
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  const words = slug.split('-').filter(w => w.length > 2);
  if (words.length === 0) return 0;
  const hits = words.filter(w => u.indexOf(w) !== -1);
  return hits.length / words.length;
}

function scoreResult(result, title, year) {
  if (!result) return 0;
  let score = 0;
  if (titleStartsWith(result.title, title)) score += 10;
  score += urlContains(result.url, title) * 5;
  score += wordMatchScore(title, result.title);
  if (year && String(result.title).toLowerCase().indexOf(year) !== -1) score += 3;
  return score;
}

function matchByTitleYear(title, year, results, season) {
  if (!results || !results.length) return null;
  if (season) {
    const seasonRe = new RegExp('(?:season|s)\\s*0*' + season + '\\b', 'i');
    let best1 = null, bestScore1 = -1;
    for (const r of results) {
      if (!r || !r.title) continue;
      if (seasonRe.test(r.title)) {
        const s = scoreResult(r, title, year) + 10;
        if (s > bestScore1) { bestScore1 = s; best1 = r; }
      }
    }
    if (best1 && bestScore1 >= 5) return best1;
  }
  let best2 = null, bestScore2 = -1;
  for (const r of results) {
    if (!r || !r.title) continue;
    const s = scoreResult(r, title, year);
    if (s > bestScore2) { bestScore2 = s; best2 = r; }
  }
  return best2 && bestScore2 >= 3 ? best2 : null;
}

async function searchcinefreak(query) {
  if (!query) return [];
  const data = await fetchJson(`${BASE_URL}/wp-json/wp/v2/search?search=${encodeUri(query)}&per_page=10`);
  if (!data || !data.length) return [];
  return data
    .filter(item => item && item.title && item.url)
    .map(item => ({
      id: item.id,
      title: String(item.title).replace(/Download\s*/gi, '').trim(),
      url: item.url,
    }))
    .filter(item => item.title);
}

async function fetchPostPage(pathOrUrl) {
  if (!pathOrUrl) return null;
  let url = pathOrUrl;
  if (!url.startsWith('http')) {
    url = url.startsWith('/') ? BASE_URL + url : BASE_URL + '/' + url;
  }
  return fetchText(url);
}

async function getTMDBInfo(tmdbId, type) {
  const isTv  = type === 'tv';
  const url   = isTv
    ? `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`
    : `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const data  = await fetchJson(url);
  if (!data) return null;
  return {
    title: isTv ? data.name : data.title,
    year:  (isTv ? data.first_air_date : data.release_date || '').substring(0, 4),
    isTv,
  };
}

async function searchWithFallbacks(title, year, isTv, seasonNum) {
  let results = await searchcinefreak(title);
  if (results && results.length >= 3) return results;
  const fallback = await searchcinefreak(`${title} ${year}`);
  results = (fallback && fallback.length) ? fallback : (results || []);
  if (!isTv || !seasonNum || results.length >= 3) return results;
  const sf = await searchcinefreak(`${title} Season ${seasonNum}`);
  return (sf && sf.length) ? sf : results;
}

async function resolveStreamsFromQualities(qualities) {
  const settled = await Promise.all(qualities.map(async (q) => {
    try {
      const directUrl = await resolveFslUrl(q.decodedUrl);
      if (!directUrl || !directUrl.startsWith('https')) return null;
      const formatted = formatTitle(q.label, null, q.quality);
      return {
        name: PROVIDER_NAME,
        title: formatted,
        url: directUrl,
        size: formatted,
        headers: { Referer: `${ECLIPSIA_BASE}/` },
      };
    } catch { return null; }
  }));
  return settled.filter(Boolean);
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    if (isTv && (season == null || episode == null)) return [];
    const seasonNum = isTv ? (parseInt(season, 10) || 1) : null;
    const tmdbInfo = await getTMDBInfo(tmdbId, mediaType);
    if (!tmdbInfo || !tmdbInfo.title) return [];
    const searchResults = await searchWithFallbacks(tmdbInfo.title, tmdbInfo.year, isTv, seasonNum);
    if (!searchResults || !searchResults.length) return [];
    const matched = matchByTitleYear(tmdbInfo.title, tmdbInfo.year, searchResults, seasonNum);
    if (!matched) return [];
    const html = await fetchPostPage(matched.url);
    if (!html) return [];

    const rawQualities = isTv
      ? extractEpisodeQualities(html, parseInt(episode, 10) || 1)
      : extractMovieQualities(html);

    if (!rawQualities || !rawQualities.length) return [];
    const qualities = filterQualities(rawQualities);
    if (!qualities.length) return [];

    return resolveStreamsFromQualities(qualities);
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams };