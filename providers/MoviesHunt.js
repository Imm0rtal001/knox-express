const PROVIDER = 'MoviesHunt';
const BASE_URL = 'https://movieshunt.monster';
const TMDB_API = "https://api.themoviedb.org/3";
const ABHL_URL = 'https://abhilinks.site';
const Q_KEEP = new Set(['1080P', '2160P']);
const USER_AGENTS = [
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
];

function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function resWeight(quality) {
    const q = (quality || '').toUpperCase();
    if (q === '4K' || q === '2160P') return 5;
    if (q === '1440P') return 4;
    if (q === '1080P') return 3;
    if (q === '720P') return 2;
    if (q === '480P') return 1;
    return 0;
}

function sortTag(quality) {
    let inv = 5 - resWeight(quality);
    let bin = inv.toString(2);
    while (bin.length < 20) bin = '0' + bin;
    return bin.split('').map(b => b === '1' ? '\uFEFF' : '\u200B').join('');
}

function hdrs(ua, extra) {
    return Object.assign({
        'User-Agent': ua,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

async function getTMDBInfo(tmdbId, mediaType, ua) {
    if (!TMDB_API_KEY) return null;
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    return fetchJson(
        `${TMDB_API}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`,
        { headers: { 'User-Agent': ua } }
    );
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

async function searchSite(query, ua) {
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

    for (const q of queries.filter(x => x.length >= 3)) {
        const data = await fetchJson(
            `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10`,
            { headers: hdrs(ua) }
        );
        if (data && data.length) {
            return data.map(post => ({
                title: (post.title && post.title.rendered ? post.title.rendered : '').replace(/<[^>]+>/g, '').trim(),
                url: post.link,
            })).filter(r => r.title.length > 5 && r.url);
        }
        const lookup = await fetchJson(
            `${BASE_URL}/lookup.php?q=${encodeURIComponent(q)}&page=1&per_page=30`,
            { headers: hdrs(ua) }
        );
        if (lookup && lookup.length) {
            return lookup.map(item => ({
                title: (item.title || item.name || '').replace(/<[^>]+>/g, '').trim(),
                url: item.url || item.link || (item.slug ? `${BASE_URL}/${item.slug}/` : null),
            })).filter(r => r.title.length > 5 && r.url);
        }
    }
    return [];
}

function matchHits(results, tmdbInfo, isSeries) {
    const tmdbTitle = (isSeries ? tmdbInfo.name : tmdbInfo.title) || '';
    const tmdbYear = isSeries
        ? (tmdbInfo.first_air_date || '').split('-')[0]
        : (tmdbInfo.release_date || '').split('-')[0];

    const titleLower = tmdbTitle.toLowerCase().replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
    const stopWords = /\b(and|&|the|a|an)\b/g;
    const titleNoStops = titleLower.replace(stopWords, '').replace(/\s+/g, ' ').trim();
    const titleWords = titleLower.split(/\s+/).filter(w => w.length > 1);

    const scored = [];
    const seen = {};

    for (const result of results) {
        const resultTitle = result.title || '';
        const resultUrl = result.url || '';
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
    const options = [];
    const qualityRegex = /(2160|1080|720|480)[pP](?:\s+\w{1,15})?\s*\[([^\]]+)\]/g;
    let match;
    while ((match = qualityRegex.exec(html)) !== null) {
        const quality = match[1] + 'P';
        const size = match[2];
        if (quality === '480P') continue;
        const context = html.substring(Math.max(0, match.index - 200), match.index + 600);
        const hubcloudMatch = context.match(/href="(https:\/\/hubcloud\.ist\/(?:drive|video)\/[^"]+)"/i);
        const vcloudMatch = context.match(/href="(https:\/\/href\.li\/\?https:\/\/vcloud\.fit\/[^"]+)"/i);
        if (hubcloudMatch) options.push({ quality, size, type: 'hubcloud', url: hubcloudMatch[1] });
        else if (vcloudMatch) options.push({ quality, size, type: 'vcloud', url: vcloudMatch[1] });
    }
    return options;
}

function extractVcloudUrl(raw) {
    const match = raw.match(/href\.li\/\?https:\/\/vcloud\.fit\/([^"&?]+)/i);
    if (match) return 'https://vcloud.fit/' + match[1];
    return null;
}

function extractR2Links(html) {
    const links = [];
    const anchorMatches = html.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
    if (!anchorMatches) return links;
    for (const anchor of anchorMatches) {
        const hrefMatch = anchor.match(/href="([^"]+)"/i);
        const textMatch = anchor.match(/>([\s\S]*?)<\/a>/i);
        if (!hrefMatch) continue;
        const url = hrefMatch[1].replace(/&amp;/g, '&');
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        if (!url || url.startsWith('javascript:')) continue;
        if (/telegram/i.test(text) || /tg\//i.test(url) || /pixeldrain/i.test(url)) continue;
        if (!/r2\.cloudflarestorage/i.test(url)) continue;
        const qualityMatch = text.match(/(2160|1080|720|480)\s*[pP]/i);
        const quality = qualityMatch ? qualityMatch[1] + 'P' : '';
        links.push({ url, quality });
    }
    return links;
}

function extractEpisodes(html) {
    const episodes = [];
    const markers = [];
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
        const start = markers[i].idx;
        const end = i + 1 < markers.length ? markers[i + 1].idx : html.length;
        const segment = html.substring(start, end);
        const links = [];
        const hubcloudRegex = /href="(https:\/\/hubcloud\.ist\/(?:drive|video)\/[^"]+)"/gi;
        while ((match = hubcloudRegex.exec(segment)) !== null)
            links.push({ type: 'hubcloud', url: match[1] });
        const vcloudRegex = /href="(https:\/\/href\.li\/\?https:\/\/vcloud\.fit\/[^"]+)"/gi;
        while ((match = vcloudRegex.exec(segment)) !== null) {
            const vUrl = extractVcloudUrl(match[1]);
            if (vUrl) links.push({ type: 'vcloud', url: vUrl });
        }
        const sizeMatch = segment.match(/\[(\d+(?:\.\d+)?\s*(?:GB|MB))\]/i);
        const size = sizeMatch ? sizeMatch[1] : '';
        if (links.length) episodes.push({ number: markers[i].num, links, size });
    }
    return episodes;
}

function extractSeasonLinks(html) {
    const seasons = {};
    const h4Regex = /<h4[^>]*>([\s\S]*?)<\/h4>/gi;
    const h4s = [];
    let match;
    while ((match = h4Regex.exec(html)) !== null)
        h4s.push({ inner: match[1], start: match.index, end: match.index + match[0].length });

    for (let i = 0; i < h4s.length; i++) {
        const { inner, end: sectionStart } = h4s[i];
        const seasonMatch = inner.match(/Season\s+(\d+)/i);
        const qualityMatch = inner.match(/(\d+p)/i);
        if (!seasonMatch || !qualityMatch) continue;
        const seasonNum = parseInt(seasonMatch[1], 10);
        const quality = qualityMatch[1].toUpperCase();
        const sectionEnd = i + 1 < h4s.length ? h4s[i + 1].start : html.length;
        const segment = html.substring(sectionStart, sectionEnd);
        const abhiMatch = segment.match(/href="(https:\/\/abhilinks\.(?:life|site)\/archives\/\d+)\/?"/i);
        if (abhiMatch) {
            if (!seasons[seasonNum]) seasons[seasonNum] = {};
            if (!seasons[seasonNum][quality]) seasons[seasonNum][quality] = abhiMatch[1];
        }
    }
    return seasons;
}

async function processHubcloud(url, ua) {
    const html = await fetchText(url, { headers: hdrs(ua, { 'Referer': `${ABHL_URL}/` }) });
    if (!html) return null;

    const direct = extractR2Links(html);
    if (direct && direct.length) return direct;

    const phpMatch = html.match(/href="(https:\/\/[^"]*hubcloud\.php[^"]*)"/i);
    if (!phpMatch) return null;
    const phpUrl = phpMatch[1].replace(/&amp;/g, '&');
    const phpHtml = await fetchText(phpUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': url,
            'DNT': '1',
            'Cookie': 'xla=s4t',
        },
    });
    if (!phpHtml || phpHtml.length < 500) return null;
    return extractR2Links(phpHtml);
}

async function processVcloud(url, ua) {
    const html = await fetchText(url, { headers: hdrs(ua, { 'Referer': `${ABHL_URL}/` }) });
    if (!html) return null;
    const atobMatch = html.match(/atob\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/);
    if (!atobMatch) return null;
    let decoded;
    try { decoded = atob(atob(atobMatch[1])); } catch { return null; }
    const innerHtml = await fetchText(decoded, {
        headers: hdrs(ua, { 'Referer': `${BASE_URL}/`, 'Cookie': 'xla=s4t' }),
    });
    if (!innerHtml) return null;
    return extractR2Links(innerHtml);
}

function dedupe(arr) {
    const seen = new Set();
    return (arr || []).filter(item => {
        if (!item || !item.url) return false;
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
    });
}

async function resolveMatch(postUrl, isSeries, seasonNum, episodeNum, ua) {
    const postHtml = await fetchText(postUrl, { headers: hdrs(ua) });
    if (!postHtml) return [];

    let streams = [];

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
            qualityEntries.map(e => fetchText(e.url, { headers: hdrs(ua) }))
        );

        const tasks = [];
        for (let ei = 0; ei < qualityEntries.length; ei++) {
            const abhiHtml = abhiHtmls[ei];
            if (!abhiHtml) continue;
            const entry = qualityEntries[ei];
            const allEpisodes = extractEpisodes(abhiHtml);
            if (!allEpisodes.length) continue;
            const filtered = episodeNum ? allEpisodes.filter(ep => ep.number === episodeNum) : allEpisodes;
            if (episodeNum && !filtered.length) continue;

            for (const ep of filtered) {
                for (const link of ep.links) {
                    const epNum = ep.number;
                    const epSize = ep.size;
                    tasks.push(async () => {
                        let r2Links = null;
                        if (link.type === 'hubcloud') r2Links = await processHubcloud(link.url, ua);
                        else if (link.type === 'vcloud') r2Links = await processVcloud(link.url, ua);
                        if (r2Links) r2Links.forEach(l => {
                            l.quality = l.quality || entry.quality;
                            l.size = epSize || '';
                        });
                        return r2Links;
                    });
                }
            }
        }

        if (!tasks.length) return [];
        const results = await Promise.all(tasks.map(t => t()));
        for (const group of results) {
            if (!group) continue;
            for (const item of group) {
                if (!Q_KEEP.has(item.quality)) continue;
                const sizePart = item.size ? ` \u2022 ${item.size}` : '';
                const name = `${PROVIDER} \u2022 ${item.quality.toLowerCase()}${sizePart}`;
                streams.push({
                    name,
                    title: name,
                    url: item.url,
                    quality: item.quality || '',
                    size: item.size || '',
                    headers: { 'Referer': `${BASE_URL}/`, 'User-Agent': ua },
                });
            }
        }
    } else {
        const abhiUrl = extractAbhilinksUrl(postHtml);
        if (!abhiUrl) return [];

        const abhiHtml = await fetchText(abhiUrl, { headers: hdrs(ua) });
        if (!abhiHtml) return [];

        const qualityOptions = extractQualityOptions(abhiHtml);
        if (!qualityOptions.length) return [];

        const results = await Promise.all(qualityOptions.map(opt => {
            if (opt.type === 'hubcloud') return processHubcloud(opt.url, ua);
            if (opt.type === 'vcloud') {
                const vUrl = extractVcloudUrl(opt.url);
                return vUrl ? processVcloud(vUrl, ua) : Promise.resolve(null);
            }
            return Promise.resolve(null);
        }));

        for (let i = 0; i < results.length; i++) {
            if (!results[i]) continue;
            const opt = qualityOptions[i];
            for (const item of results[i]) {
                const quality = item.quality || opt.quality;
                if (!Q_KEEP.has(quality)) continue;
                const sizePart = opt.size ? ` \u2022 ${opt.size}` : '';
                const name = `${PROVIDER} \u2022 ${quality.toLowerCase()}${sizePart}`;
                streams.push({
                    name,
                    title: name,
                    url: item.url,
                    quality,
                    size: opt.size || '',
                    headers: { 'Referer': `${BASE_URL}/`, 'User-Agent': ua },
                });
            }
        }
    }

    streams = dedupe(streams);
    streams.sort((a, b) => resWeight(b.quality) - resWeight(a.quality));
    streams = streams.map(s => {
        const tag = sortTag(s.quality);
        return Object.assign({}, s, { name: tag + s.name, title: tag + s.title });
    });

    return streams;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        const ua = randomUA();
        const isSeries = mediaType === 'tv';

        if (isSeries && (season == null || episode == null)) return [];

        const seasonNum = isSeries && season != null ? parseInt(season, 10) : null;
        const episodeNum = isSeries && episode != null ? parseInt(episode, 10) : null;

        const tmdbInfo = await getTMDBInfo(tmdbId, mediaType, ua);
        if (!tmdbInfo) return [];

        const title = isSeries ? tmdbInfo.name : tmdbInfo.title;
        if (!title) return [];

        const searchResults = await searchSite(title, ua);
        if (!searchResults || !searchResults.length) return [];

        const matches = matchHits(searchResults, tmdbInfo, isSeries);
        if (!matches.length) return [];

        try {
            return await firstSuccess(
                matches.map(m => resolveMatch(m.url, isSeries, seasonNum, episodeNum, ua)),
                val => !val || !val.length
            );
        } catch { return []; }
    } catch {
        return [];
    }
}

module.exports = { getStreams };
