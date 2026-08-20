"use strict";

const PROVIDER_NAME   = 'MoviesHunt';
const TMDB_API_KEY    = '307b7b8ef035c6aa336900aef4e203bd';
const movieshuntBase  = 'https://movieshunt.run';
const abhilinksBase   = 'https://abhilinks.site';

const UAS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

let currentUA = UAS[0];

function hdrs(extra) {
  return Object.assign({}, {
    'User-Agent':      currentUA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }, extra || {});
}

async function fetchText(url, options) {
  try {
    const res = await fetch(url, options || {});
    if (res && res.ok) return await res.text();
  } catch { }
  return null;
}

async function fetchJson(url, options) {
  try {
    const res = await fetch(url, options || {});
    if (res && res.ok) return await res.json();
  } catch { }
  return null;
}

async function getTMDBInfo(tmdbId, type) {
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
  return fetchJson(url, { headers: { 'User-Agent': currentUA } });
}

function firstSuccess(promises, isEmpty) {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    if (!pending) return reject(null);
    for (const p of promises) {
      Promise.resolve(p).then(val => {
        if (!isEmpty(val)) resolve(val);
        else if (--pending === 0) reject(null);
      }).catch(() => { if (--pending === 0) reject(null); });
    }
  });
}

function parseSearchResults(html) {
  const results      = [];
  const headingRegex = /<h\d[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const inner     = match[1];
    const linkMatch = inner.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (linkMatch) {
      let url = linkMatch[1];
      if (!url.startsWith('http')) url = movieshuntBase + (url.startsWith('/') ? '' : '/') + url;
      const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
      if (title.length > 5) results.push({ title, url });
    }
  }
  return results;
}

async function searchSite(query) {
  const queries = [query.replace(/'/g, '').trim()];
  const cleaned = query.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned !== queries[0]) queries.push(cleaned);
  const noYear = cleaned.replace(/\s*\d{4}\s*/g, ' ').trim();
  if (noYear && !queries.includes(noYear)) queries.push(noYear);
  const words = cleaned.split(' ').filter(w => w.length > 2);
  const wordsCopy = words.slice();
  while (wordsCopy.length > 1) {
    wordsCopy.pop();
    const partial = wordsCopy.join(' ');
    if (partial.length > 3 && !queries.includes(partial)) queries.push(partial);
  }
  if (cleaned) {
    const parts = cleaned.split(' ');
    if (parts.length > 1) {
      const lastTwo = parts.slice(-Math.min(2, parts.length)).join(' ');
      if (lastTwo.length > 3 && !queries.includes(lastTwo)) queries.push(lastTwo);
      const lastWord = parts[parts.length - 1];
      if (lastWord.length > 3 && /[a-zA-Z]/.test(lastWord) && !queries.includes(lastWord))
        queries.push(lastWord);
    }
  }

  const valid = queries.filter(q => q.length >= 3);
  const BATCH = 3;
  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    try {
      const results = await firstSuccess(
        batch.map(async q => {
          const html = await fetchText(movieshuntBase + '/?s=' + encodeURIComponent(q), { headers: hdrs() });
          if (!html) return null;
          return parseSearchResults(html);
        }),
        val => !val || !val.length
      );
      if (results && results.length) return results;
    } catch { }
  }
  return [];
}

function matchHits(results, tmdbInfo, isSeries) {
  const tmdbTitle = (isSeries ? tmdbInfo.name : tmdbInfo.title) || '';
  const tmdbYear  = isSeries
    ? (tmdbInfo.first_air_date || '').split('-')[0]
    : (tmdbInfo.release_date  || '').split('-')[0];

  const titleLower   = tmdbTitle.toLowerCase().replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
  const stopWords    = /\b(and|&|the|a|an)\b/g;
  const titleNoStops = titleLower.replace(stopWords, '').replace(/\s+/g, ' ').trim();
  const titleWords   = titleLower.split(/\s+/).filter(w => w.length > 1);

  const scored = [];
  const seen   = {};

  for (const result of results) {
    const resultTitle = result.title || '';
    const resultUrl   = result.url   || '';
    if (seen[resultUrl]) continue;
    seen[resultUrl] = true;

    const resultLower = resultTitle.toLowerCase().replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
    let score = 0;

    if (resultLower === titleLower) {
      score += 100;
    } else if (resultLower.includes(titleLower) || titleLower.includes(resultLower)) {
      score += 50;
    } else {
      const resultNoStops = resultLower.replace(stopWords, '').replace(/\s+/g, ' ').trim();
      if (resultNoStops.includes(titleNoStops) || titleNoStops.includes(resultNoStops)) {
        score += 50;
      } else if (
        resultNoStops.replace(/[^a-z0-9\s]/g, '').trim() ===
        titleNoStops.replace(/[^a-z0-9\s]/g, '').trim()
      ) {
        score += 60;
      }
    }

    if (score === 0 && titleWords.length > 1) {
      const resultWords = resultLower.split(/\s+/).filter(w => w.length > 1);
      let matches = 0;
      for (const tw of titleWords) {
        for (const rw of resultWords) {
          if (tw === rw || rw.startsWith(tw) || tw.startsWith(rw)) { matches++; break; }
        }
      }
      if (matches >= Math.min(titleWords.length, 3)) score += 50;
    }

    if (score >= 50 && tmdbYear && resultTitle.includes(tmdbYear)) score += 10;
    if (score >= 50) scored.push({ doc: result, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(s => s.doc);
}

function extractAbhilinksUrl(html) {
  const btnMatch = html.match(/<a[^>]*href="(https:\/\/abhilinks\.(?:life|site)\/[^"]+)"[^>]*class="btn"[^>]*>/i);
  if (btnMatch) return btnMatch[1];
  const anyMatch = html.match(/<a[^>]*href="(https:\/\/abhilinks\.(?:life|site)\/[^"]+)"[^>]*>/i);
  if (anyMatch) return anyMatch[1];
  return null;
}

function extractQualityOptions(html) {
  const options       = [];
  const qualityRegex  = /(2160|1080|720|480)[pP](?:\s+\w{1,15})?\s*\[([^\]]+)\]/g;
  let match;
  while ((match = qualityRegex.exec(html)) !== null) {
    const quality = match[1] + 'P';
    const size    = match[2];
    if (quality === '480P') continue;
    const context      = html.substring(Math.max(0, match.index - 200), match.index + 600);
    const hubcloudMatch = context.match(/href="(https:\/\/hubcloud\.cx\/(?:drive|video)\/[^"]+)"/i);
    const vcloudMatch   = context.match(/href="(https:\/\/href\.li\/\?https:\/\/vcloud\.zip\/[^"]+)"/i);
    if (hubcloudMatch) options.push({ quality, size, type: 'hubcloud', url: hubcloudMatch[1] });
    else if (vcloudMatch) options.push({ quality, size, type: 'vcloud',   url: vcloudMatch[1] });
  }
  return options;
}

function extractVcloudUrl(raw) {
  const match = raw.match(/href\.li\/\?https:\/\/vcloud\.zip\/([^"&?]+)/i);
  if (match) return 'https://vcloud.zip/' + match[1];
  return null;
}

function isCloudflareUrl(url) {
  return (
    /cdn\.fsl-buckets\.life/i.test(url) ||
    /r2\.cloudflarestorage/i.test(url)  ||
    /workers\.dev/i.test(url)
  );
}

function extractFSLLinks(html) {
  const links         = [];
  const anchorMatches = html.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  if (!anchorMatches) return links;
  for (const anchor of anchorMatches) {
    const hrefMatch = anchor.match(/href="([^"]+)"/i);
    const textMatch = anchor.match(/>([\s\S]*?)<\/a>/i);
    if (!hrefMatch) continue;
    const url  = hrefMatch[1].replace(/&amp;/g, '&');
    const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    if (!url || url.startsWith('javascript:')) continue;
    if (/telegram/i.test(text) || /tg\//i.test(url) || /pixeldrain/i.test(url)) continue;
    if (/hubcloud\.cx|gpdl2/i.test(url)) continue;
    if (!isCloudflareUrl(url)) continue;
    let type = '';
    if (/cdn\.fsl-buckets\.life/i.test(url) || /r2\.cloudflarestorage/i.test(url)) type = 'FSLv2';
    else if (/workers\.dev/i.test(url)) type = 'Worker';
    const qualityMatch = text.match(/(2160|1080|720|480)\s*[pP]/i);
    const quality      = qualityMatch ? qualityMatch[1] + 'P' : '';
    links.push({ url, type, quality });
  }
  return links;
}

function dedupe(arr) {
  const seen = {};
  return (arr || []).filter(item => {
    if (!item || !item.url) return false;
    if (seen[item.url]) return false;
    seen[item.url] = true;
    return true;
  });
}

function extractEpisodes(html) {
  const episodes = [];
  const markers  = [];
  const markerRegex = /-:\s*Episodes?\s*:\s*(\d+)\s*:-/gi;
  let match;
  while ((match = markerRegex.exec(html)) !== null)
    markers.push({ num: parseInt(match[1], 10), idx: match.index });

  if (markers.length === 0) {
    const fallback = />\s*Episode\s*(\d+)\s*</gi;
    while ((match = fallback.exec(html)) !== null)
      markers.push({ num: parseInt(match[1], 10), idx: match.index });
  }

  for (let i = 0; i < markers.length; i++) {
    const start   = markers[i].idx;
    const end     = i + 1 < markers.length ? markers[i + 1].idx : html.length;
    const segment = html.substring(start, end);
    const links   = [];
    const hubcloudRegex = /href="(https:\/\/hubcloud\.cx\/(?:drive|video)\/[^"]+)"/gi;
    while ((match = hubcloudRegex.exec(segment)) !== null)
      links.push({ type: 'hubcloud', url: match[1] });
    const vcloudRegex = /href="(https:\/\/href\.li\/\?https:\/\/vcloud\.zip\/[^"]+)"/gi;
    while ((match = vcloudRegex.exec(segment)) !== null) {
      const vUrl = extractVcloudUrl(match[1]);
      if (vUrl) links.push({ type: 'vcloud', url: vUrl });
    }
    if (links.length) episodes.push({ number: markers[i].num, links });
  }
  return episodes;
}

function extractSeasonLinks(html) {
  const seasons   = {};
  const h4Regex   = /<h4[^>]*>([\s\S]*?)<\/h4>/gi;
  const h4s       = [];
  let match;
  while ((match = h4Regex.exec(html)) !== null)
    h4s.push({ inner: match[1], start: match.index, end: match.index + match[0].length });

  for (let i = 0; i < h4s.length; i++) {
    const { inner, end: sectionStart } = h4s[i];
    const seasonMatch  = inner.match(/Season\s+(\d+)/i);
    const qualityMatch = inner.match(/(\d+p)/i);
    if (!seasonMatch || !qualityMatch) continue;
    const seasonNum  = parseInt(seasonMatch[1], 10);
    const quality    = qualityMatch[1].toUpperCase();
    const sectionEnd = i + 1 < h4s.length ? h4s[i + 1].start : html.length;
    const segment    = html.substring(sectionStart, sectionEnd);
    const abhiMatch  = segment.match(/href="(https:\/\/abhilinks\.(?:life|site)\/archives\/\d+)\/?"/i);
    if (abhiMatch) {
      if (!seasons[seasonNum]) seasons[seasonNum] = {};
      if (!seasons[seasonNum][quality]) seasons[seasonNum][quality] = abhiMatch[1];
    }
  }
  return seasons;
}

async function processHubcloud(url) {
  const html = await fetchText(url, { headers: hdrs({ 'Referer': `${abhilinksBase}/` }) });
  if (!html) return null;
  const phpMatch = html.match(/href="(https:\/\/[^"]*hubcloud\.php[^"]*)"/i);
  if (!phpMatch) return null;
  const phpUrl  = phpMatch[1].replace(/&amp;/g, '&');
  const ffUA    = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0';
  const phpHtml = await fetchText(phpUrl, {
    headers: {
      'User-Agent':      ffUA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer':         url,
      'DNT':             '1',
      'Cookie':          'xla=s4t',
    },
  });
  if (!phpHtml || phpHtml.length < 500) return null;
  return extractFSLLinks(phpHtml);
}

async function processVcloud(url) {
  const html = await fetchText(url, { headers: hdrs({ 'Referer': `${abhilinksBase}/` }) });
  if (!html) return null;
  const atobMatch = html.match(/atob\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/);
  if (!atobMatch) return null;
  let decoded;
  try { decoded = atob(atob(atobMatch[1])); } catch { return null; }
  const innerHtml = await fetchText(decoded, {
    headers: hdrs({ 'Referer': `${movieshuntBase}/`, 'Cookie': 'xla=s4t' }),
  });
  if (!innerHtml) return null;
  return extractFSLLinks(innerHtml);
}

async function resolveMatch(postUrl, isSeries, seasonNum, episodeNum) {
  const postHtml = await fetchText(postUrl, { headers: hdrs() });
  if (!postHtml) return [];

  const WANTED  = new Set(['1080P', '2160P']);
  let streams   = [];

  if (isSeries) {
    const qualityEntries = [];

    if (seasonNum) {
      const seasonLinks = extractSeasonLinks(postHtml);
      if (seasonLinks[seasonNum]) {
        const qualities = Object.keys(seasonLinks[seasonNum]).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
        qualities.forEach(q => qualityEntries.push({ quality: q, url: seasonLinks[seasonNum][q] }));
      }
    }

    if (!qualityEntries.length) {
      const abhiUrl = extractAbhilinksUrl(postHtml);
      if (abhiUrl) qualityEntries.push({ quality: '', url: abhiUrl });
    }
    if (!qualityEntries.length) return [];

    const abhiHtmls = await Promise.all(
      qualityEntries.map(e => fetchText(e.url, { headers: hdrs() }))
    );

    const tasks = [];
    for (let ei = 0; ei < qualityEntries.length; ei++) {
      const abhiHtml = abhiHtmls[ei];
      if (!abhiHtml) continue;
      const entry      = qualityEntries[ei];
      const allEpisodes = extractEpisodes(abhiHtml);
      if (!allEpisodes.length) continue;
      const filtered   = episodeNum ? allEpisodes.filter(ep => ep.number === episodeNum) : allEpisodes;
      if (episodeNum && !filtered.length) continue;

      for (const ep of filtered) {
        for (const link of ep.links) {
          const epNum = ep.number;
          tasks.push(async () => {
            let fslLinks = null;
            if (link.type === 'hubcloud') fslLinks = await processHubcloud(link.url);
            else if (link.type === 'vcloud') fslLinks = await processVcloud(link.url);
            if (fslLinks) fslLinks.forEach(l => {
              l.episode = epNum;
              l.quality = l.quality || entry.quality;
            });
            return fslLinks;
          });
        }
      }
    }

    if (!tasks.length) return [];
    const results = await Promise.all(tasks.map(t => t()));
    for (const group of results) {
      if (!group) continue;
      for (const item of group) {
        if (!WANTED.has(item.quality)) continue;
        const name = `${PROVIDER_NAME} • ${item.quality.toLowerCase()} • S${seasonNum || 1}E${item.episode || '?'}`;
        streams.push({
          name, title: name, url: item.url,
          quality: item.quality || '',
          headers: { 'Referer': `${movieshuntBase}/`, 'User-Agent': currentUA },
        });
      }
    }

  } else {
    const abhiUrl = extractAbhilinksUrl(postHtml);
    if (!abhiUrl) return [];

    const abhiHtml = await fetchText(abhiUrl, { headers: hdrs() });
    if (!abhiHtml) return [];

    const qualityOptions = extractQualityOptions(abhiHtml);
    if (!qualityOptions.length) return [];

    const results = await Promise.all(qualityOptions.map(opt => {
      if (opt.type === 'hubcloud') return processHubcloud(opt.url);
      if (opt.type === 'vcloud') {
        const vUrl = extractVcloudUrl(opt.url);
        return vUrl ? processVcloud(vUrl) : Promise.resolve(null);
      }
      return Promise.resolve(null);
    }));

    for (let i = 0; i < results.length; i++) {
      if (!results[i]) continue;
      const opt = qualityOptions[i];
      for (const item of results[i]) {
        const quality  = item.quality || opt.quality;
        if (!WANTED.has(quality)) continue;
        const sizePart = opt.size ? ` • ${opt.size}` : '';
        const name     = `${PROVIDER_NAME} • ${quality.toLowerCase()}${sizePart}`;
        streams.push({
          name, title: name, url: item.url,
          quality, size: opt.size || '',
          headers: { 'Referer': `${movieshuntBase}/`, 'User-Agent': currentUA },
        });
      }
    }
  }

  streams = dedupe(streams);
  streams.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
  return streams;
}

async function getStreams(tmdbId, type, season, episode) {
  try {
    currentUA = UAS[Math.floor(Math.random() * UAS.length)];

    const isSeries = type === 'tv';

    if (isSeries && (season == null || episode == null)) return [];

    const seasonNum  = isSeries && season  != null ? parseInt(season,  10) : null;
    const episodeNum = isSeries && episode != null ? parseInt(episode, 10) : null;

    const tmdbInfo = await getTMDBInfo(tmdbId, type);
    if (!tmdbInfo) return [];

    const title = isSeries ? tmdbInfo.name : tmdbInfo.title;
    if (!title) return [];

    const searchResults = await searchSite(title);
    if (!searchResults || !searchResults.length) return [];

    const matches = matchHits(searchResults, tmdbInfo, isSeries);
    if (!matches.length) return [];

    try {
      return await firstSuccess(
        matches.map(m => resolveMatch(m.url, isSeries, seasonNum, episodeNum)),
        val => !val || !val.length
      );
    } catch { return []; }
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams };