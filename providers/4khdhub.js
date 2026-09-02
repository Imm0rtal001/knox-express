"use strict";

const PROVIDER_NAME = "4kHdHub";
const BASE_URL = "https://4khdhub.one";
const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_API_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const MOBILE_UAS = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

const sessionUA = MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];

const RE_QUALITY = /(2160|1080|720|480)p|(4K|UHD)/i;
const RE_YEAR = /\b(19\d{2}|20\d{2})\b/;
const RE_SIZE_CTX = /(?:^|[\s>])(\d+\.?\d*)\s*(GB|MB)\b/i;
const RE_HUBCLOUD = /https?:\/\/hubcloud\.[a-z0-9]+\/drive\/[a-z0-9]+/ig;
const RE_SXEX = /S0*(\d+)[.\s_\-]*E0*(\d+)/i;
const RE_EP = /Episode\s*0*(\d+)/i;
const RE_HEADER = /<div[^>]*class=['"][^'"]*card-header[^'"]*['"][^>]*>([^<]+)</i;
const RE_SIZE_TD = /<td[^>]*>\s*File\s*Size\s*:\s*<\/td>\s*<td[^>]*>\s*([\d\.]+\s*[MGBtbi]+)\s*<\/td>/i;
const RE_SIZE_STR = /Size\s*:\s*<\/strong>\s*([\d\.]+\s*[MGBtbi]+)/i;
const RE_SLUG_JUNK = /^(movie|series)$|^\d+$/;
const RE_NONALNUM = /[^a-z0-9]/g;
const RE_EXT = /\.(mkv|mp4|avi|rar|zip)$/i;
const RE_ZIP_RAR = /\.zip|\.rar/;
const RE_PIXEL = /pixel\.hubcloud/;
const RE_PXL_VAR = /var\s+pxl\s*=\s*["']https?:\/\/pixeldrain\.[a-z0-9.-]+\/u\/([A-Za-z0-9_-]+)["']/i;
const RE_PXL_HREF = /href=["']https?:\/\/pixeldrain\.[a-z0-9.-]+\/u\/([A-Za-z0-9_-]+)["']/i;

const AUDIO_TABLE = [
  [/ddp.?51.*truehd.*71|truehd.*71.*ddp.?51/i, "DDP 5.1 + TrueHD 7.1"],
  [/ddp.?51.*ddp.?71|ddp.?71.*ddp.?51/i, "DDP 5.1 + DDP 7.1"],
  [/ddp.?51.*aac.?71|aac.?71.*ddp.?51/i, "DDP 5.1 + AAC 7.1"],
  [/ddp.?51/i, "DDP 5.1"],
  [/truehd/i, "TrueHD 7.1"],
  [/aac.*71|71.*aac/i, "AAC 7.1"],
  [/aac/i, "AAC 5.1"],
];

const COUNT_OPTIONS = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "unlimited", label: "Unlimited" },
];

function onSettings() {
  return [
    { type: "header", label: "Sort Order" },
    {
      type: "toggle",
      key: "sortBySize",
      label: "Sort by Size",
      defaultValue: false,
      description: "ON — Largest Size first\nOFF — Highest Resolution first, then Largest Size",
    },

    { type: "header", label: "Resolution" },
    {
      type: "toggle",
      key: "enable4K",
      label: "4K / 2160p",
      defaultValue: true,
    },
    {
      type: "toggle",
      key: "enable1080p",
      label: "FHD / 1080p",
      defaultValue: true,
    },

    { type: "header", label: "Limit Streams by Resolution" },
    { type: "info", label: "Max streams shown per resolution\nDefault: Unlimited" },
    {
      type: "select",
      key: "max4K",
      label: "4K / 2160p",
      defaultValue: "unlimited",
      options: COUNT_OPTIONS,
    },
    {
      type: "select",
      key: "max1080p",
      label: "FHD / 1080p",
      defaultValue: "unlimited",
      options: COUNT_OPTIONS,
    },

    { type: "header", label: "Limit Stream by Source" },
    { type: "info", label: "Default: Unlimited" },
    {
      type: "select",
      key: "maxFSL",
      label: "FSL",
      defaultValue: "unlimited",
      options: COUNT_OPTIONS,
    },
    {
      type: "select",
      key: "maxFSLv2",
      label: "FSL-v2 [R2]",
      defaultValue: "unlimited",
      options: COUNT_OPTIONS,
    },
    {
      type: "select",
      key: "maxWorkers",
      label: "Worker",
      defaultValue: "unlimited",
      options: COUNT_OPTIONS,
    },
    {
      type: "select",
      key: "maxPixelDrain",
      label: "PixelDrain",
      defaultValue: "unlimited",
      options: COUNT_OPTIONS,
    },
  ];
}

function resolveSettings() {
  const s = (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) || {};

  function cap(key, def) {
    const raw = s[key];
    if (raw === undefined || raw === null || raw === "") return def;
    if (raw === "unlimited") return Infinity;
    const n = parseInt(raw, 10);
    return (isNaN(n) || n <= 0) ? def : n;
  }

  return {
    sortBySize: s.sortBySize === true,
    enable4K: s.enable4K !== false,
    enable1080p: s.enable1080p !== false,
    max4K: cap("max4K", Infinity),
    max1080p: cap("max1080p", Infinity),
    maxFSLv2: cap("maxFSLv2", Infinity),
    maxFSL: cap("maxFSL", Infinity),
    maxWorkers: cap("maxWorkers", Infinity),
    maxPixelDrain: cap("maxPixelDrain", Infinity),
  };
}

function hostCap(host, settings) {
  if (host === "FSL-v2") return settings.maxFSLv2;
  if (host === "FSL") return settings.maxFSL;
  if (host === "Worker") return settings.maxWorkers;
  if (host === "PixelDrain") return settings.maxPixelDrain;
  return Infinity;
}

function getHeaders(extra) {
  return Object.assign({
    "User-Agent": sessionUA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  }, extra || {});
}

async function fetchText(url, options) {
  try {
    const res = await fetch(url, Object.assign({ headers: getHeaders() }, options));
    return (res && res.ok) ? res.text() : null;
  } catch (_) { return null; }
}

async function fetchJson(url, options) {
  try {
    const res = await fetch(url, Object.assign({ headers: getHeaders() }, options));
    return (res && res.ok) ? res.json() : null;
  } catch (_) { return null; }
}

function parseSizeMB(sizeStr) {
  if (!sizeStr) return null;
  const m = /(\d+\.?\d*)\s*(GB|MB)/i.exec(sizeStr);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return m[2].toUpperCase() === "GB" ? val * 1024 : val;
}

function calcMbps(sizeMB, runtimeMinutes) {
  if (!sizeMB || !runtimeMinutes) return null;
  const bits = sizeMB * 1024 * 1024 * 8;
  const seconds = runtimeMinutes * 60;
  return (bits / seconds / 1000000).toFixed(1) + " Mbps";
}

function getInvertedSortTag(score, maxScore) {
  maxScore = maxScore || 999999;
  let val = Math.max(0, parseInt(score, 10) || 0);
  let inv = Math.max(0, maxScore - val);
  let bin = inv.toString(2);
  while (bin.length < 20) bin = "0" + bin;
  const chars = [];
  for (let i = 0; i < bin.length; i++) {
    chars.push(bin.charAt(i) === "1" ? "\uFEFF" : "\u200B");
  }
  return chars.join("");
}

async function getTMDBInfo(tmdbId, type) {
  const isTV = type === "tv";
  let title = "", year = "", imdbId = "", runtime = null;
  try {
    if (isTV) {
      const d = await fetchJson(
        `${TMDB_API_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
      );
      if (d) {
        title = d.name;
        year = (d.first_air_date || "").slice(0, 4);
        imdbId = (d.external_ids && d.external_ids.imdb_id) || "";
        runtime = (d.episode_run_time && d.episode_run_time[0]) || null;
      }
    } else {
      const d = await fetchJson(
        `${TMDB_API_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
      );
      if (d) {
        title = d.title;
        year = (d.release_date || "").slice(0, 4);
        imdbId = d.imdb_id || "";
        runtime = d.runtime != null ? d.runtime : null;
      }
    }
  } catch (_) { }
  return { title, year, imdbId, runtime };
}

async function searchSite(title, year, imdbId, isSeries) {
  if (imdbId) {
    try {
      const posts = await fetchJson(`${BASE_URL}/wp-json/wp/v2/posts?search=${imdbId}`);
      if (posts && posts.length > 0) {
        return {
          url: posts[0].link,
          title: (posts[0].title && posts[0].title.rendered) || title,
          content: isSeries ? null : ((posts[0].content && posts[0].content.rendered) || ""),
        };
      }
    } catch (_) { }
  }

  const html = await fetchText(`${BASE_URL}/?s=${encodeURIComponent(title)}`);
  if (!html) return null;

  const body = html.split('id="main"')[1] || html;
  const cleanQ = title.toLowerCase().replace(RE_NONALNUM, "");
  const typeStr = isSeries ? "-series-" : "-movie-";
  const antiStr = isSeries ? "-movie-" : "-series-";
  const linkRe = /href="(https?:\/\/[^"\/]+)?(\/[^"]+)"/g;
  let best = null, m;

  while ((m = linkRe.exec(body)) !== null) {
    const domain = m[1] || "";
    const path = m[2];
    if (domain && !domain.includes("4khdhub")) continue;
    if (path.includes("/category/") || path.includes("?") || path.includes(antiStr)) continue;
    if (!path.includes(typeStr)) continue;

    const slugWords = path.split("/").filter(Boolean).pop().split("-");
    const slugClean = slugWords.filter(w => !RE_SLUG_JUNK.test(w)).join("").toLowerCase().replace(RE_NONALNUM, "");
    if (!slugClean.includes(cleanQ) && !cleanQ.includes(slugClean)) continue;

    const ctx = body.substring(m.index, m.index + 300);
    const yearMatch = RE_YEAR.exec(ctx);
    const yearHit = year && yearMatch && yearMatch[1] === year;

    if (!best || yearHit) {
      best = { url: BASE_URL + path, title };
      if (yearHit) break;
    }
  }
  return best;
}

function extractHubcloudLinks(html, season, episode, isSeries) {
  const results = [];
  let scope = html;

  if (isSeries) {
    let start = html.indexOf('id="episodes"');
    if (start < 0) start = html.indexOf('data-tab="episodes"');
    if (start >= 0) {
      scope = html.substring(start);
      const end = scope.indexOf('id="complete-pack"');
      if (end >= 0) scope = scope.substring(0, end);
    }
  }

  RE_HUBCLOUD.lastIndex = 0;
  let m;
  while ((m = RE_HUBCLOUD.exec(scope)) !== null) {
    const url = m[0];

    if (isSeries) {
      const ctxBefore = scope.substring(Math.max(0, m.index - 3000), m.index);
      const ctxAfter = scope.substring(m.index, Math.min(scope.length, m.index + 500));
      const ctx = ctxBefore + ctxAfter;

      const epMatch = RE_SXEX.exec(ctx) || RE_EP.exec(ctx);
      if (!epMatch) continue;

      let s = season, e;
      if (epMatch[2]) { s = +epMatch[1]; e = +epMatch[2]; }
      else { e = +epMatch[1]; }
      if (s !== season || e !== episode) continue;

      const qm = RE_QUALITY.exec(ctxBefore);
      let quality = "HD";
      if (qm) {
        const v = qm[1] || qm[2];
        quality = (v.toUpperCase() === "4K" || v.toUpperCase() === "UHD") ? "2160P" : v.toUpperCase() + "P";
      }
      if (quality === "480P") continue;

      const sm = RE_SIZE_CTX.exec(ctxBefore);
      results.push({ url, quality, size: sm ? sm[1] + " " + sm[2] : "" });
    } else {
      const context = scope.substring(Math.max(0, m.index - 1500), m.index);

      const qm = RE_QUALITY.exec(context);
      let quality = "HD";
      if (qm) {
        const v = qm[1] || qm[2];
        quality = (v.toUpperCase() === "4K" || v.toUpperCase() === "UHD") ? "2160P" : v.toUpperCase() + "P";
      }
      if (quality === "480P") continue;

      const sm = RE_SIZE_CTX.exec(context);
      results.push({ url, quality, size: sm ? sm[1] + " " + sm[2] : "" });
    }
  }
  return results;
}

function makeStream(filename, sourceName, streamUrl, quality, hostLabel, referer, size, runtime) {
  const qualityUp = (quality || "1080P").toUpperCase();
  const encodedUrl = streamUrl.replace(/ /g, "%20");
  const combined = (String(filename || "") + " " + String(sourceName || "") + " " + encodedUrl).toLowerCase();

  const langParts = [];
  if (/\b(?:english|eng)\b/.test(combined)) langParts.push("English");
  if (/\bhindi\b/.test(combined)) langParts.push("Hindi");
  if (/\btamil\b/.test(combined)) langParts.push("Tamil");
  if (/\btelugu\b/.test(combined)) langParts.push("Telugu");

  let source = "WEB-DL";
  let isRemux = false;
  if (/\bremux\b/.test(combined)) { source = "Blu-ray"; isRemux = true; }
  else if (/\bblu[-\s]?ray\b/.test(combined)) source = "Blu-ray";
  else if (/\b(?:webrip|hdrip)\b/.test(combined)) source = "WEB-Rip";

  let hdrTag = "";
  if (/\b(?:hdr10\+|hdr10p)\b/.test(combined)) hdrTag = "HDR10+";
  else if (/\bhdr10\b/.test(combined)) hdrTag = "HDR10";
  else if (/\bhdr\b/.test(combined)) hdrTag = "HDR";
  else if (/\bsdr\b/.test(combined)) hdrTag = "SDR";

  const bit10Tag = /\b10bit\b/.test(combined) ? "10Bit" : "";
  const dvTag = /\b(?:dv|dolby\s*vision)\b/.test(combined) ? "DV" : "";
  const codec = (/\b(?:hevc|x265|265)\b/.test(combined) || qualityUp === "2160P") ? "H.265" : "H.264";
  const isImax = /\bimax\b/.test(combined);

  let audio = "DDP 5.1";
  for (let i = 0; i < AUDIO_TABLE.length; i++) {
    if (AUDIO_TABLE[i][0].test(combined)) { audio = AUDIO_TABLE[i][1]; break; }
  }
  if (/\batmos\b/.test(combined)) audio += " Atmos";

  const sizeMB = parseSizeMB(size);
  const mbps = calcMbps(sizeMB, runtime);

  const mainTitle = [PROVIDER_NAME, qualityUp, size].filter(Boolean).join(" • ");
  const line1 = langParts.join(" • ");
  const line2 = [source, isRemux && "REMUX", isImax && "IMAX", hostLabel || "FSL", mbps].filter(Boolean).join(" • ");
  const line3 = [bit10Tag, dvTag, hdrTag, codec, audio].filter(Boolean).join(" • ");
  const streamTitle = [line1, line2, line3].filter(Boolean).join("\n");

  return {
    name: mainTitle,
    title: mainTitle,
    size: streamTitle,
    url: encodedUrl,
    quality: qualityUp,
    headers: { Referer: referer || `${BASE_URL}/` },
    _host: hostLabel || "FSL",
    _sizeRaw: size || "",
  };
}

async function resolveHubCloud(link, fallbackTitle, runtime) {
  const { url, quality, size } = link;
  const streams = [];
  try {
    const html = await fetchText(url, { headers: getHeaders({ Referer: `${BASE_URL}/` }) });
    if (!html) return streams;

    const phpMatch = html.match(/href="([^"]*hubcloud\.php[^"]*)"/i);
    if (!phpMatch) return streams;
    const phpUrl = phpMatch[1].replace(/&amp;/g, "&");

    const html2 = await fetchText(phpUrl, { headers: getHeaders({ Referer: url }) });
    if (!html2) return streams;

    const hm = RE_HEADER.exec(html2);
    const filename = hm ? hm[1].trim().replace(RE_EXT, "") : fallbackTitle;
    let fileSize = size || "";
    const sm = RE_SIZE_TD.exec(html2) || RE_SIZE_STR.exec(html2);
    if (sm) fileSize = sm[1].trim();

    const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>(?:<i[^>]*><\/i>)?\s*([^<]+)<\/a>/gi;
    let m;
    while ((m = linkRegex.exec(html2)) !== null) {
      let streamUrl = m[1].replace(/&amp;/g, "&");
      const label = m[2].trim();
      if (!streamUrl || streamUrl.startsWith("javascript:")) continue;
      if (RE_ZIP_RAR.test(streamUrl)) continue;
      if (RE_PIXEL.test(streamUrl)) continue;
      if (/telegram/i.test(label) || /tg\//i.test(streamUrl)) continue;
      if (/hubcloud\.cx\/drive\/admin/i.test(streamUrl)) continue;
      if (/bzzhr/i.test(streamUrl)) continue;
      if (/pixeldrain\.[a-z0-9.-]+\/u\//i.test(streamUrl)) continue;

      let host = "";
      if (/cdn\.fsl-buckets\.life|r2\.cloudflarestorage|r2\.dev/i.test(streamUrl)) {
        host = "FSL-v2";
      } else if (/hub\.(latent|whistle)/i.test(streamUrl)) {
        host = "FSL";
        streamUrl = streamUrl + "1" + new Date().getMinutes();
      } else if (/workers\.dev/i.test(streamUrl)) {
        host = "Worker";
      } else {
        continue;
      }

      streams.push(makeStream(filename, host, streamUrl, quality, host, phpUrl, fileSize, runtime));
    }

    const pxlMatch = RE_PXL_VAR.exec(html2) || RE_PXL_HREF.exec(html2);
    if (pxlMatch && pxlMatch[1]) {
      const pdUrl = "https://pixeldrain.com/api/file/" + pxlMatch[1];
      if (!streams.some(s => s.url === pdUrl)) {
        streams.push(makeStream(filename, "PixelDrain", pdUrl, quality, "PixelDrain", phpUrl, fileSize, runtime));
      }
    }

  } catch (_) { }
  return streams;
}

function resWeight(quality) {
  const q = (quality || "").toUpperCase();
  if (q === "2160P" || q === "4K") return 4;
  if (q === "1080P") return 3;
  if (q === "720P") return 2;
  return 1;
}

function applySettings(streams, settings) {
  streams = streams.filter(s => {
    const q = (s.quality || "").toUpperCase();
    if ((q === "2160P" || q === "4K") && !settings.enable4K) return false;
    if (q === "1080P" && !settings.enable1080p) return false;
    return true;
  });

  if (settings.sortBySize) {
    streams.sort((a, b) => (parseSizeMB(b._sizeRaw) || 0) - (parseSizeMB(a._sizeRaw) || 0));
  } else {
    streams.sort((a, b) => {
      const rd = resWeight(b.quality) - resWeight(a.quality);
      return rd !== 0 ? rd : (parseSizeMB(b._sizeRaw) || 0) - (parseSizeMB(a._sizeRaw) || 0);
    });
  }

  const resCounts = {};
  streams = streams.filter(s => {
    const q = (s.quality || "").toUpperCase();
    const limit = (q === "2160P" || q === "4K") ? settings.max4K
      : q === "1080P" ? settings.max1080p
        : Infinity;
    if (limit === Infinity) return true;
    resCounts[q] = (resCounts[q] || 0) + 1;
    return resCounts[q] <= limit;
  });

  const provCounts = {};
  streams = streams.filter(s => {
    const host = s._host || "unknown";
    const q = (s.quality || "").toUpperCase();
    const key = host + ":" + q;
    const limit = hostCap(host, settings);
    if (limit === Infinity) return true;
    provCounts[key] = (provCounts[key] || 0) + 1;
    return provCounts[key] <= limit;
  });

  const seen = new Set();
  streams = streams.filter(s => s.url && !seen.has(s.url) && seen.add(s.url));

  const total = streams.length;
  streams = streams.map((s, i) => {
    const tag = getInvertedSortTag(total - i, total + 1);
    return Object.assign({}, s, { name: tag + s.name });
  });

  return streams;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  if (!tmdbId) return [];
  if (mediaType !== "movie" && mediaType !== "tv") return [];
  if (mediaType === "tv" && (season == null || episode == null)) return [];

  const isSeries = mediaType === "tv";
  let streams = [];

  try {
    const info = await getTMDBInfo(tmdbId, mediaType);
    if (!info.title) return streams;

    const result = await searchSite(info.title, info.year, info.imdbId, isSeries);
    if (!result) return streams;

    const html = (!isSeries && result.content) || (await fetchText(result.url));
    if (!html) return streams;

    const links = extractHubcloudLinks(html, +season, +episode, isSeries);
    const resolved = await Promise.all(links.map(l => resolveHubCloud(l, info.title, info.runtime)));
    streams = resolved.flat();

    streams = applySettings(streams, resolveSettings());
  } catch (_) { }

  return streams;
}

module.exports = { getStreams, onSettings };
