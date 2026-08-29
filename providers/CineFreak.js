"use strict";

const cheerio = require("cheerio");
const PROVIDER_NAME = "CineFreak";
const BASE_URL = "https://cinefreak.net";
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  "Cookie": "xla=s4t",
};

async function fetchHtml(url, extra) {
  try {
    const res = await fetch(url, { headers: Object.assign({}, HEADERS, extra) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

async function fetchJson(url, extra) {
  try {
    const res = await fetch(url, { headers: Object.assign({}, HEADERS, extra) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function originOf(url) {
  try { const u = new URL(url); return u.protocol + "//" + u.host; } catch { return ""; }
}

function decodeBase64Url(str) {
  try {
    return atob(str.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""));
  } catch { return null; }
}

function toQualityLabel(raw) {
  const m = /(\d{3,4})[pP]/.exec(raw || "");
  if (!m) return "Unknown";
  const n = parseInt(m[1], 10);
  if (n >= 2160) return "2160p";
  if (n >= 1080) return "1080p";
  if (n >= 720) return "720p";
  if (n >= 480) return "480p";
  return "Unknown";
}

function isHighQuality(quality) {
  return quality === "1080p" || quality === "2160p";
}

function formatTitle(releaseTitle, size, quality) {
  const t = String(releaseTitle || "");

  const line1Parts = [];
  if (quality) line1Parts.push(quality);
  if (size && size !== "Unknown") line1Parts.push(size);

  const line2Parts = [];

  const src = /bluray|blu\-ray|bdrip/i.test(t) ? "Blu-ray"
    : /hdrip|webrip/i.test(t) ? "WEBRip"
      : /web\-?dl/i.test(t) ? "WEB-DL"
        : "";
  if (src) line2Parts.push(src);

  if (/imax/i.test(t)) line2Parts.push("IMAX");

  let audio = "";
  const am = t.match(/(TrueHD\s*7\.1|DDP\s*7\.1|DDP\s*5\.1|DD\s*5\.1|5\.1|AAC)/i);
  if (am) {
    audio = am[1].toUpperCase().replace(/\s+/g, "");
    if (audio === "5.1") audio = "DDP5.1";
    if (audio.includes("TRUEHD")) audio = "TrueHD 7.1";
  } else if (/dolby\s*digital/i.test(t)) {
    audio = "Dolby Digital";
  }
  if (/atmos/i.test(t)) audio = audio ? `${audio} • Atmos` : "Atmos";
  if (audio) line2Parts.push(audio);

  const range = /dolby\s*vision|dovi/i.test(t) ? "Dolby Vision"
    : /hdr10/i.test(t) ? "HDR10"
      : /hdr/i.test(t) ? "HDR"
        : /10bit|10\-bit/i.test(t) ? "10-Bit"
          : /\bsdr\b/i.test(t) ? "SDR"
            : "";
  if (range) line2Parts.push(range);

  const codec = /hevc|x265|h\.?265/i.test(t) ? "H.265"
    : /x264|h\.?264/i.test(t) ? "H.264"
      : "";
  if (codec) line2Parts.push(codec);

  const line1 = line1Parts.join(" • ");
  const line2 = line2Parts.join(" • ");
  return [line1, line2].filter(Boolean).join("\n");
}

function dedupe(streams) {
  const seen = new Set();
  return streams.filter(s => s.url && !seen.has(s.url) && seen.add(s.url));
}

async function tmdbLookup(tmdbId, mediaType) {
  const ep = mediaType === "tv" ? "tv" : "movie";
  const data = await fetchJson(`${TMDB_API}/${ep}/${tmdbId}?api_key=${TMDB_KEY}`);
  if (!data) return null;
  return {
    title: (mediaType === "tv" ? data.name : data.title) || "",
    isTv: mediaType === "tv",
  };
}

async function searchCinefreak(query) {
  const data = await fetchJson(`${BASE_URL}/search-api.php?q=${encodeURIComponent(query)}&pg=1`);
  return (data && Array.isArray(data.results)) ? data.results : [];
}

function selectResult(results, title, mediaType) {
  const norm = title.toLowerCase().trim();

  function looksLikeTv(r) {
    const t = r.t.toLowerCase();
    return t.includes("season") || t.includes("series") || t.includes("episode");
  }

  for (const r of results) {
    if (mediaType === "tv" && !looksLikeTv(r)) continue;
    if (mediaType === "movie" && looksLikeTv(r)) continue;
    const rn = r.t.toLowerCase().replace(/\s*season\s*\d+/gi, "").replace(/\s*\(.*?\)/g, "").trim();
    if (rn === norm || rn.includes(norm) || norm.includes(rn)) return r;
  }

  return results[0] || null;
}

async function extractCineCloud(url, qualityHint) {
  const streams = [];
  try {
    const html = await fetchHtml(url);
    if (!html) return streams;
    const $ = cheerio.load(html);
    const quality = toQualityLabel(qualityHint);

    if (!isHighQuality(quality)) return streams;

    let releaseTitle = "";
    const titleCandidates = [
      $("h1").first().text(),
      $("h2").first().text(),
      $("title").text(),
      $(".file-name, .filename, .release-name, .movie-title").first().text(),
    ];
    for (const c of titleCandidates) {
      const clean = c.trim();
      if (clean && /\d{3,4}p|bluray|webrip|web-?dl|x26[45]|hevc|aac|ddp/i.test(clean)) {
        releaseTitle = clean;
        break;
      }
    }

    let fileSize = "";
    $("tr").each((_, row) => {
      if (fileSize) return;
      const first = $(row).find("td").first();
      if (first.text().toLowerCase().includes("file size")) {
        const right = $(row).find("td.text-right");
        if (right.length) fileSize = right.last().text().trim();
      }
    });

    const base = originOf(url);
    const resumeJobs = [];
    const sizeLabel = formatTitle(releaseTitle, fileSize, quality);

    $("a[href]").each((_, el) => {
      const text = $(el).text().trim();
      const href = ($(el).attr("href") || "").trim();
      if (!href) return;
      const fullHref = href.startsWith("http") ? href : base + href;

      if (/fast\s+cloud/i.test(text) || /\[fsl\]/i.test(text)) {
        streams.push({
          url: fullHref,
          title: `${PROVIDER_NAME} • FSL`,
          size: sizeLabel,
          headers: { Referer: url },
        });
      } else if (/cloud\s*\[resumable\]/i.test(text)) {
        resumeJobs.push(fullHref);
      }
    });

    const resumeResults = await Promise.allSettled(
      resumeJobs.map(async resumeUrl => {
        const subHtml = await fetchHtml(resumeUrl, { Referer: url });
        if (!subHtml) return [];
        const $2 = require("cheerio").load(subHtml);
        const links = [];
        $2("a.download-now[href]").each((_, el) => {
          const link = ($2(el).attr("href") || "").trim();
          if (link) links.push(link);
        });
        return links;
      })
    );

    for (const r of resumeResults) {
      if (r.status !== "fulfilled") continue;
      for (const finalUrl of r.value) {
        streams.push({
          url: finalUrl,
          title: `${PROVIDER_NAME} • Cloudflare`,
          size: sizeLabel,
          headers: { Referer: url },
        });
      }
    }
  } catch { }
  return streams;
}

async function resolveLink(href, qualityHint) {
  try {
    const m = /[?&]id=([^&]+)/.exec(href);
    if (!m) return [];

    let encoded = m[1];
    try { encoded = decodeURIComponent(encoded); } catch { }

    const decoded = decodeBase64Url(encoded);
    if (!decoded) return [];

    const target = decoded.split("newgo32")[0].trim();
    if (!target || !target.startsWith("http")) return [];

    if (target.includes("cinecloud")) return extractCineCloud(target, qualityHint);

    return [];
  } catch { return []; }
}

function parseMovieLinks(html) {
  const $ = require("cheerio").load(html);
  const links = [];
  const counts = {};

  $("h4.movie-title").each((_, el) => {
    const qm = /(2160p|1080p|720p|480p)/i.exec($(el).text());
    if (!qm) return;
    const quality = qm[1];

    $(el).next().find("a.dlbtn-download[href]").each((_, a) => {
      const href = ($(a).attr("href") || "").trim();
      if (!href) return;
      counts[quality] = (counts[quality] || 0) + 1;
      const label = counts[quality] === 1 ? quality : `${quality}_${counts[quality]}`;
      links.push({ quality: label, href });
    });
  });

  return links;
}

function collectGenerateLinks(cardHtml) {
  const NEEDLE = "/generate.php?id=";
  const links = [];
  let pos = 0;

  while (true) {
    const hrefStart = cardHtml.indexOf(NEEDLE, pos);
    if (hrefStart === -1) break;

    const aOpen = cardHtml.lastIndexOf("<a ", hrefStart);
    if (aOpen === -1 || aOpen < pos) { pos = hrefStart + 1; continue; }

    const aClose = cardHtml.indexOf("</a>", hrefStart);
    if (aClose === -1) { pos = hrefStart + 1; continue; }

    const gtIdx = cardHtml.indexOf(">", hrefStart);
    if (gtIdx === -1 || gtIdx > aClose) { pos = aClose + 4; continue; }

    const label = cardHtml.substring(gtIdx + 1, aClose).trim();
    const quoteIdx = cardHtml.indexOf('"', hrefStart);
    if (quoteIdx === -1) { pos = aClose + 4; continue; }

    const snippet = cardHtml.substring(hrefStart, quoteIdx);
    const idMatch = snippet.match(/id=([a-zA-Z0-9+/=]+)/);
    if (!idMatch) { pos = aClose + 4; continue; }

    const hrefTagStart = cardHtml.lastIndexOf('href="', hrefStart);
    const fullHref = cardHtml
      .substring(hrefTagStart + 6, cardHtml.indexOf('"', hrefTagStart + 6))
      .replace(/&amp;/g, "&");

    const qm = /(2160p|1080p|720p|480p)/i.exec(label);
    const quality = qm ? qm[1] : (label || "Unknown");

    links.push({ href: fullHref || `${NEEDLE}${idMatch[1]}`, quality });
    pos = aClose + 4;
  }

  return links;
}

function parseEpisodeLinks(html, targetEpisode) {
  if (!html) return [];

  const cards = html.split('<div class="ep-card"');

  const EP_PATTERNS = [
    /episode-badge[^>]*>\s*(?:Episode\s*)?(\d+)/i,
    /ep-num[^>]*>\s*(\d+)\s*</i,
    /data-episode="(\d+)"/i,
    /\bEpisode\s+(\d+)\b/i,
  ];

  for (let i = 1; i < cards.length; i++) {
    for (const pat of EP_PATTERNS) {
      const m = cards[i].match(pat);
      if (m && parseInt(m[1], 10) === targetEpisode) {
        return collectGenerateLinks(cards[i]);
      }
    }
  }

  return [];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (mediaType === "tv" && (season == null || episode == null)) return [];

    const tmdb = await tmdbLookup(tmdbId, mediaType);
    if (!tmdb || !tmdb.title) return [];

    const { title } = tmdb;

    const primaryQuery = (mediaType === "tv" && season != null)
      ? `${title} Season ${season}`
      : title;

    let results = await searchCinefreak(primaryQuery);
    let match = selectResult(results, title, mediaType);

    if (!match && mediaType === "tv") {
      results = await searchCinefreak(title);
      match = selectResult(results, title, mediaType);
    }

    if (!match) return [];

    const pageUrl = match.l.startsWith("http")
      ? match.l
      : `${BASE_URL}/${match.l.replace(/^\//, "")}/`;

    const html = await fetchHtml(pageUrl);
    if (!html) return [];

    const rawLinks = mediaType === "movie"
      ? parseMovieLinks(html)
      : parseEpisodeLinks(html, parseInt(episode, 10));

    if (!rawLinks.length) return [];

    const batches = await Promise.allSettled(
      rawLinks.map(({ quality, href }) => resolveLink(href, quality))
    );

    return dedupe(
      batches
        .filter(r => r.status === "fulfilled")
        .flatMap(r => r.value)
    );
  } catch { return []; }
}

module.exports = { getStreams };
