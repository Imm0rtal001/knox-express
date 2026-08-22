const express = require("express");
const fs = require("fs");
const path = require("path");
const dns = require("node:dns");
const net = require("node:net");
const DEFAULT_DNS_SERVERS = dns.getServers();

const app = express();
const PORT = Number(process.env.PORT || 7000);
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, "data", "providers.json");
const LOG_LIMIT = 200;
const STREAM_CACHE_TTL_MS = 45000;
const streamCache = new Map();
const STATE_KEY = "knox:provider-state";
const SETTINGS_KEY = "knox:settings";
const MANIFEST_KEY = "knox:manifest-revision";
let manifestRevision = 1;
let scraperRefreshRevision = 0;
const PERSIST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const PERSIST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const DNS_PRESETS = {
  system: [],
  cloudflare: ["1.1.1.1", "1.0.0.1"],
  google: ["8.8.8.8", "8.8.4.4"],
  quad9: ["9.9.9.9", "149.112.112.112"],
  adguard: ["94.140.14.14", "94.140.15.15"]
};
const SETTINGS_FILE = path.join(ROOT, "data", "settings.json");
const logs = [];

// Vercel deployments use a read-only filesystem. Mutable dashboard state is
// kept in memory there so toggle/timeout requests do not fail with EROFS.
const IS_VERCEL = Boolean(process.env.VERCEL);
let memoryProviders = null;
let memorySettings = null;
let providersHydrated = false;

function normalizeDnsServers(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map(v => v.trim()).filter(v => net.isIP(v)))].slice(0, 4);
}

function applyDnsServers(servers) {
  const normalized = normalizeDnsServers(servers);
  dns.setServers(normalized.length ? normalized : DEFAULT_DNS_SERVERS);
  return normalized;
}

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Control-center/API/manifest responses must never be served from a stale browser,
// CDN, or Vercel cache after provider settings change.
app.use((req, res, next) => {
  if (req.path === "/manifest.json" || req.path.startsWith("/api/") || req.path.startsWith("/configure")) {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store"
    });
  }
  next();
});
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"], etag: false, maxAge: 0 }));

function log(level, message, extra = {}) {
  const item = { time: new Date().toISOString(), level, message, ...extra };
  logs.unshift(item);
  if (logs.length > LOG_LIMIT) logs.pop();
  console.log(`[${level.toUpperCase()}] ${message}`);
}

async function kvCommand(command) {
  if (!PERSIST_URL || !PERSIST_TOKEN) return null;
  try {
    const r = await fetch(PERSIST_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${PERSIST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(command)
    });
    if (!r.ok) throw new Error(`KV ${r.status}`);
    return await r.json();
  } catch (e) {
    log("warn", "Persistent state unavailable", { error: e.message });
    return null;
  }
}

function readProviders() {
  if (memoryProviders) return memoryProviders;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    memoryProviders = parsed;
    return parsed;
  } catch (e) {
    log("error", "Could not read provider state", { error: e.message });
    memoryProviders = {};
    return memoryProviders;
  }
}

async function hydrateProviders() {
  // Load persistent state once per server instance. Do NOT overwrite a freshly
  // toggled in-memory state on every request with a stale KV snapshot.
  if (providersHydrated && memoryProviders) return memoryProviders;
  providersHydrated = true;
  if (PERSIST_URL && PERSIST_TOKEN) {
    const result = await kvCommand(["GET", STATE_KEY]);
    const value = result?.result;
    if (value) {
      try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        if (parsed && typeof parsed === "object") memoryProviders = parsed;
      } catch (_) {}
    }
  }
  return readProviders();
}

function readSettings() {
  if (memorySettings) return memorySettings;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    const result = { timeoutMs: 0, dnsServers: normalizeDnsServers(settings.dnsServers) };
    if (result.dnsServers.length) applyDnsServers(result.dnsServers);
    memorySettings = result;
    return result;
  } catch (_) {
    memorySettings = { timeoutMs: 0, dnsServers: [] };
    return memorySettings;
  }
}

function writeSettings(settings) {
  const safe = { timeoutMs: 0, dnsServers: normalizeDnsServers(settings.dnsServers) };
  if (safe.dnsServers.length) applyDnsServers(safe.dnsServers);
  memorySettings = safe;
  if (!IS_VERCEL) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
  }
  return safe;
}

function writeProviders(state) {
  memoryProviders = state;
  if (!IS_VERCEL) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }
  return state;
}

async function persistProviders(state) {
  // Update memory first so the very next stream request sees the toggle.
  writeProviders(state);
  if (PERSIST_URL && PERSIST_TOKEN) {
    const result = await kvCommand(["SET", STATE_KEY, JSON.stringify(state)]);
    // Even if persistence is temporarily unavailable, keep the current state
    // active for this instance instead of reverting to the old provider list.
    if (!result) log("warn", "Provider state kept in memory; persistent save unavailable");
  }
  return state;
}

function loadProvider(id) {
  const state = readProviders();
  const p = state[id];
  if (!p || !p.enabled) return null;
  const filename = path.basename(p.filename);
  const file = path.join(ROOT, "providers", filename);
  if (!fs.existsSync(file)) {
    log("error", "Provider file missing", { id, file });
    return null;
  }
  try {
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    if (!mod || typeof mod.getStreams !== "function") {
      log("error", "Provider does not export getStreams", { id });
      return null;
    }
    return mod;
  } catch (e) {
    log("error", "Provider failed to load", { id, error: e.message });
    return null;
  }
}

async function resolveTmdbId(id) {
  if (/^\d+$/.test(id)) return id;
  if (id.startsWith("tmdb:")) return id.slice(5).split(":")[0];
  if (id.startsWith("tt")) {
    // Uses an already-present provider key when available; users can override it.
    const key = process.env.TMDB_API_KEY || "307b7b8ef035c6aa336900aef4e203bd";
    const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}&external_source=imdb_id`;
    const r = await fetch(url, { headers: { "User-Agent": "Knox-Express/4.0" } });
    if (!r.ok) throw new Error(`TMDB lookup failed: ${r.status}`);
    const data = await r.json();
    const found = data.movie_results?.[0]?.id || data.tv_results?.[0]?.id;
    if (!found) throw new Error("No TMDB match for IMDb id");
    return String(found);
  }
  return id.split(":")[0];
}

function parseStreamId(type, rawId) {
  const parts = String(rawId).split(":");
  if (type === "series") {
    return {
      id: parts[0],
      season: parts[1] ? Number(parts[1]) : null,
      episode: parts[2] ? Number(parts[2]) : null
    };
  }
  return { id: parts[0], season: null, episode: null };
}

function firstValue(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function normalizeFileSize(value) {
  if (!value) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (/^(unknown|n\/?a|na|null|undefined|-)$/i.test(text)) return "";
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b/i);
  if (!m) return text;
  return `${m[1]} ${m[2].toUpperCase()}`;
}

function detectMediaMeta(s) {
  const raw = [
    s?.title, s?.name, s?.quality, s?.description, s?.filename,
    s?.fileName, s?.label, s?.release, s?.releaseTitle, s?.displayName,
    s?.server, s?.serverName, s?.provider, s?.sourceProvider,
    s?.mediaInfo?.quality, s?.mediaInfo?.resolution, s?.mediaInfo?.source,
    s?.mediaInfo?.size, s?.mediaInfo?.language, s?.mediaInfo?.audio,
    s?.mediaInfo?.codec, s?.mediaInfo?.hdr, s?.mediaInfo?.bitDepth,
    s?.mediaInfo?.subtitles, s?.mediaInfo?.bitrate
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const upper = raw.toUpperCase();

  let quality = firstValue(s, ["quality", "resolution", "videoQuality", "video_quality"])
    || firstValue(s?.mediaInfo, ["quality", "resolution", "videoQuality", "video_quality"]);
  if (/^(unknown|n\/?a|na|auto|hd)$/i.test(String(quality || ""))) quality = "";
  if (quality) {
    const q = String(quality).toLowerCase();
    if (/^(4k|uhd|2160)$/.test(q)) quality = "2160p";
    else if (/^(fhd|full\s*hd|1080)$/.test(q)) quality = "1080p";
    else if (/^(hd|720)$/.test(q)) quality = "720p";
  }
  if (!quality) {
    if (/\b(2160P|2160|4K|UHD)\b/i.test(raw)) quality = "2160p";
    else if (/\b(1440P|1440)\b/i.test(raw)) quality = "1440p";
    else if (/\b(1080P|1080|FHD)\b/i.test(raw)) quality = "1080p";
    else if (/\b(720P|720|HD)\b/i.test(raw)) quality = "720p";
    else if (/\b(480P|480)\b/i.test(raw)) quality = "480p";
  }

  let fileSize = normalizeFileSize(firstValue(s, [
    "fileSize", "filesize", "size", "file_size", "contentLength", "content_length"
  ]) || firstValue(s?.mediaInfo, ["fileSize", "filesize", "size", "file_size", "contentLength", "content_length"]));
  if (!fileSize) {
    const m = raw.match(/\b\d+(?:\.\d+)?\s*(?:TB|GB|MB|KB)\b/i);
    if (m) fileSize = normalizeFileSize(m[0]);
  }

  let language = firstValue(s, ["language", "lang", "languages", "audioLanguage", "audio_language"])
    || firstValue(s?.mediaInfo, ["language", "lang", "languages", "audioLanguage", "audio_language"]);
  if (!language) {
    const langs = [];
    const checks = [
      ["English", /\b(ENG|ENGLISH)\b/i],
      ["Hindi", /\b(HIN|HINDI)\b/i],
      ["Tamil", /\b(TAM|TAMIL)\b/i],
      ["Telugu", /\b(TEL|TELUGU)\b/i],
      ["Malayalam", /\b(MAL|MALAYALAM)\b/i],
      ["Kannada", /\b(KAN|KANNADA)\b/i],
      ["Bengali", /\b(BEN|BENGALI)\b/i],
      ["Punjabi", /\b(PAN|PUNJABI)\b/i],
      ["Spanish", /\b(SPA|SPANISH)\b/i],
      ["French", /\b(FRE|FRA|FRENCH)\b/i],
      ["German", /\b(GER|GERMAN)\b/i],
      ["Japanese", /\b(JPN|JAPANESE)\b/i],
      ["Korean", /\b(KOR|KOREAN)\b/i]
    ];
    for (const [label, re] of checks) if (re.test(upper)) langs.push(label);
    language = [...new Set(langs)].join(" + ");
  }

  let audio = firstValue(s, [
    "audio", "sound", "audioCodec", "audio_codec", "audioFormat", "audio_format",
    "audioChannels", "audio_channels"
  ]) || firstValue(s?.mediaInfo, [
    "audio", "sound", "audioCodec", "audio_codec", "audioFormat", "audio_format",
    "audioChannels", "audio_channels"
  ]);
  if (!audio) {
    if (/\b(ATMOS|DOLBY\s*ATMOS)\b/i.test(raw)) audio = "Dolby Atmos";
    else if (/\b(E-?AC-?3|DDP?\s*5\.1|DD\s*5\.1|5\.1)\b/i.test(raw)) audio = "DDP 5.1";
    else if (/\b(DTS-?HD|DTS)\b/i.test(raw)) audio = "DTS";
    else if (/\b(AAC\s*2\.0|AAC)\b/i.test(raw)) audio = "AAC 2.0";
    else if (/\b(2\.0|STEREO)\b/i.test(raw)) audio = "Stereo";
  }

  const codec = firstValue(s, ["codec", "videoCodec", "video_codec"])
    || firstValue(s?.mediaInfo, ["codec", "videoCodec", "video_codec"])
    || (/(HEVC|H\.265|X265)/i.test(raw) ? "HEVC"
      : /(AVC|H\.264|X264)/i.test(raw) ? "H.264"
      : /\bAV1\b/i.test(raw) ? "AV1"
      : /\bVP9\b/i.test(raw) ? "VP9" : "");

  let source = firstValue(s, ["source", "releaseSource", "release_source", "mediaSource", "media_source"]);
  if (!source) {
    if (/\bREMUX\b/i.test(raw)) source = "Remux";
    else if (/\bBLU[- .]?RAY\b/i.test(raw)) source = "BluRay";
    else if (/\bWEB[- .]?DL\b/i.test(raw)) source = "WEB-DL";
    else if (/\bWEB[- .]?RIP\b/i.test(raw)) source = "WEBRip";
    else if (/\bHDTV\b/i.test(raw)) source = "HDTV";
    else if (/\bDVDRIP\b/i.test(raw)) source = "DVDRip";
  }

  const bitDepth = firstValue(s, ["bitDepth", "bit_depth"]) || firstValue(s?.mediaInfo, ["bitDepth", "bit_depth"]) || (/\b10[- ]?BIT\b/i.test(raw) ? "10-bit" : /\b8[- ]?BIT\b/i.test(raw) ? "8-bit" : "");
  const channels = firstValue(s, ["channels", "audioChannels", "audio_channels"])
    || firstValue(s?.mediaInfo, ["channels", "audioChannels", "audio_channels"])
    || (raw.match(/(?:AAC|DDP|DD|DTS|TRUEHD)[^0-9]*(7\.1|5\.1|2\.0)/i)?.[1] || "")
    || (raw.match(/\b(7\.1|5\.1|2\.0)\b/i)?.[1] || (/STEREO/i.test(raw) ? "2.0" : ""));
  const subtitles = firstValue(s, ["subtitles", "subtitle", "subs", "sub"])
    || firstValue(s?.mediaInfo, ["subtitles", "subtitle", "subs", "sub"])
    || (/(\bESUB\b|\bESUBS\b|\bSUBBED\b|\bSUBS\b|\bHC\b|\bHARDCODED\b)/i.test(raw) ? "Embedded" : "");
  const multiAudio = Boolean(s?.multiAudio || s?.multi_audio || /\b(MULTI[- ]?AUDIO|MULTI AUDIO|DUAL[- ]?AUDIO|DUAL AUDIO|MULTI)/i.test(raw));
  const bitrate = firstValue(s, ["bitrate", "videoBitrate", "video_bitrate"])
    || firstValue(s?.mediaInfo, ["bitrate", "videoBitrate", "video_bitrate"]);
  const hdr = firstValue(s, ["hdr", "dynamicRange", "dynamic_range"])
    || firstValue(s?.mediaInfo, ["hdr", "dynamicRange", "dynamic_range"])
    || (/\bHDR10\+\b/i.test(raw) ? "HDR10+" : /\bHDR10\b/i.test(raw) ? "HDR10" : /\bDV|DOLBY\s*VISION\b/i.test(raw) ? "Dolby Vision" : "");

  return { quality, fileSize, language, audio, codec, hdr, source, bitDepth, channels, subtitles, multiAudio, bitrate };
}

function normalizeReleaseFilename(value) {
  if (!value) return "";
  return String(value)
    .replace(/\\/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectProviderSource(s, providerName) {
  const raw = [
    s?.provider, s?.sourceProvider, s?.server, s?.serverName, s?.host,
    s?.extractor, s?.service, s?.name, s?.title, s?.filename, s?.releaseFilename,
    s?.url
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  const known = [
    ["FSLv2", /\bFSLv2\b/i],
    ["FSL", /\bFSL\b/i],
    ["PixelDrain", /\bPixelDrain\b/i],
    ["HubCloud", /\bHubCloud\b/i],
    ["HubDrive", /\bHubDrive\b/i],
    ["VCloud", /\bVCloud\b/i],
    ["StreamWish", /\bStreamWish\b/i],
    ["StreamTape", /\bStreamTape\b/i],
    ["DoodStream", /\bDoodStream\b/i],
    ["Mega", /\bMega(?:\.nz)?\b/i],
    ["DriveSeed", /\bDriveSeed\b/i],
    ["ResumeCloud", /\bResumeCloud\b/i],
    ["ResumeBot", /\bResumeBot\b/i],
    ["Direct", /\bDirect(?:\s+Download)?\b/i],
    ["Worker", /\bWorker\b/i],
    ["Telegram", /\bTelegram\b/i],
    ["GDrive", /\b(?:GDrive|Google\s*Drive)\b/i],
    ["MediaFire", /\bMediaFire\b/i],
    ["OneDrive", /\bOneDrive\b/i],
    ["GoFile", /\bGoFile\b/i],
    ["FilePress", /\bFilePress\b/i],
    ["Vimeo", /\bVimeo\b/i],
    ["YouTube", /\bYouTube\b/i]
  ];

  for (const [label, re] of known) {
    if (re.test(raw)) return label;
  }

  // A number of scrapers only return the resolved URL. Infer the delivery
  // service from that URL so clients can show the same provider/server line
  // even when the individual scraper did not expose a separate field.
  const url = String(s?.url || "").toLowerCase();
  if (/pixeldrain\.com/.test(url)) return "PixelDrain";
  if (/fsl-buckets\.life|\.r2\.dev/.test(url)) return "FSLv2";
  if (/\b(?:hub\.(?:latent|whistle)|fsl)\b/.test(url)) return "FSL";
  if (/hubcloud/.test(url)) return "HubCloud";
  if (/hubdrive/.test(url)) return "HubDrive";
  if (/vcloud/.test(url)) return "VCloud";
  if (/streamwish/.test(url)) return "StreamWish";
  if (/streamtape/.test(url)) return "StreamTape";
  if (/doodstream|dood\./.test(url)) return "DoodStream";
  return firstValue(s, ["server", "serverName", "extractor", "service", "sourceProvider"]) || "";
}

function looksLikeReleaseFilename(value) {
  const text = normalizeReleaseFilename(value);
  if (!text || /[\u{1F300}-\u{1FAFF}]/u.test(text) || /[|•]/.test(text)) return false;
  if (/\.(mkv|mp4|avi|mov|webm|ts|m2ts)$/i.test(text)) return true;
  const hasYear = /\b(?:19|20)\d{2}\b/.test(text);
  const hasQuality = /\b(?:2160p|1440p|1080p|720p|576p|480p|4k|uhd|fhd|hd)\b/i.test(text);
  const hasSource = /\b(?:WEB[- .]?DL|WEB[- .]?Rip|Blu[- .]?Ray|BRRip|BDRip|HDTV|DVDRip|Remux)\b/i.test(text);
  const hasCodec = /\b(?:x264|x265|h\.?264|h\.?265|hevc|avc|av1|vp9)\b/i.test(text);
  return (hasYear && hasQuality && (hasSource || hasCodec));
}

function extractReleaseFilename(s, rawTitle) {
  // A filename is only considered trustworthy when the provider explicitly
  // supplied one, Content-Disposition supplied one, or the title itself has
  // the unmistakable shape of a release filename. Never turn a UI label such
  // as "Provider 1080p" into a fake filename.
  const explicit = firstValue(s, [
    "filename", "fileName", "file_name", "releaseFilename", "releaseFileName",
    "fileTitle", "file_title"
  ]);
  if (explicit && looksLikeReleaseFilename(explicit)) return normalizeReleaseFilename(explicit);

  const candidates = [
    firstValue(s, ["contentDispositionFilename", "content_disposition_filename"]),
    firstValue(s?.metadata, ["filename", "releaseFilename"]),
    firstValue(s?.mediaInfo, ["filename", "releaseFilename"]),
    rawTitle
  ].filter(Boolean);

  for (const candidate of candidates) {
    const clean = normalizeReleaseFilename(candidate);
    if (looksLikeReleaseFilename(clean)) return clean;
  }
  return "";
}

function buildStreamDisplay(s, providerName, meta, rawTitle, releaseFilename, providerSource) {
  const quality = meta.quality || "";
  const displayName = `${providerName}${quality ? ` ${quality}` : ""}`.trim();
  const size = meta.fileSize || "";
  const sourceLabel = [providerSource, providerName]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(" | ");
  const detailLine = [
    providerSource ? `[${providerSource}]` : "",
    size ? `[💾 ${size}]` : ""
  ].filter(Boolean).join(" ");

  const lines = [];
  if (detailLine) lines.push(detailLine);
  if (releaseFilename) lines.push(releaseFilename);
  if (sourceLabel) lines.push(sourceLabel);

  const displayCodec = meta.codec === "H.264" ? "AVC" : meta.codec === "H.265" ? "HEVC" : meta.codec;
  const displaySize = meta.fileSize ? (() => {
    const m = String(meta.fileSize).match(/^(\d+(?:\.\d+)?)\s*(GB|MB|KB)$/i);
    if (!m) return meta.fileSize;
    const value = Number(m[1]);
    const unit = m[2].toUpperCase();
    return unit === "GB" ? `SIZE ${value.toFixed(1)} GB` : `SIZE ${m[1]} ${unit}`;
  })() : "";
  const badges = [
    meta.source,
    meta.quality,
    displayCodec,
    displaySize,
    meta.hdr,
    meta.bitDepth,
    meta.multiAudio ? "Multi-Audio" : "",
    meta.subtitles ? "Subtitles" : ""
  ].filter(Boolean);

  return {
    displayName,
    detailLine,
    sourceLabel,
    description: lines.join("\n"),
    badges: [...new Set(badges)]
  };
}


const REMOTE_META_TIMEOUT_MS = Math.max(800, Number(process.env.KNOX_METADATA_TIMEOUT_MS || 1800));
let remoteMetaActive = 0;
const REMOTE_META_MAX_CONCURRENCY = 8;
const remoteMetaQueue = [];

function runRemoteMetaTask(task) {
  return new Promise(resolve => {
    remoteMetaQueue.push({ task, resolve });
    drainRemoteMetaQueue();
  });
}

function drainRemoteMetaQueue() {
  while (remoteMetaActive < REMOTE_META_MAX_CONCURRENCY && remoteMetaQueue.length) {
    const item = remoteMetaQueue.shift();
    remoteMetaActive += 1;
    Promise.resolve().then(item.task).catch(() => null).then(result => {
      remoteMetaActive -= 1;
      item.resolve(result);
      drainRemoteMetaQueue();
    });
  }
}

function headerValue(headers, names) {
  if (!headers || typeof headers !== "object") return "";
  const entries = Object.entries(headers);
  for (const name of names) {
    const hit = entries.find(([k]) => String(k).toLowerCase() === name.toLowerCase());
    if (hit && hit[1] != null) return String(hit[1]);
  }
  return "";
}

function parseContentDispositionFilename(value) {
  if (!value) return "";
  const utf = String(value).match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  const normal = String(value).match(/filename\s*=\s*"([^"]+)"/i) || String(value).match(/filename\s*=\s*([^;]+)/i);
  const raw = (utf?.[1] || normal?.[1] || "").trim();
  if (!raw) return "";
  try { return normalizeReleaseFilename(decodeURIComponent(raw.replace(/^"|"$/g, ""))); } catch (_) {
    return normalizeReleaseFilename(raw.replace(/^"|"$/g, ""));
  }
}

function bytesToFileSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const digits = i >= 3 ? 2 : i >= 2 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

async function fetchRemoteMetadata(s) {
  if (!s?.url || !/^https?:\/\//i.test(String(s.url))) return {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_META_TIMEOUT_MS);
  try {
    const headers = {
      "User-Agent": "Knox-Express/4.0",
      "Accept": "*/*"
    };
    if (s.headers && typeof s.headers === "object") {
      for (const [k, v] of Object.entries(s.headers)) {
        if (v != null && typeof v !== "object") headers[k] = String(v);
      }
    }
    const response = await fetch(String(s.url), { method: "HEAD", redirect: "follow", headers, signal: controller.signal });
    const contentLength = response.headers.get("content-length") || "";
    const disposition = response.headers.get("content-disposition") || "";
    const contentType = response.headers.get("content-type") || "";
    const isPlaylist = /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(contentType) || /\.(?:m3u8)(?:$|[?#])/i.test(String(response.url || s.url));
    return {
      fileSize: isPlaylist ? "" : bytesToFileSize(contentLength),
      filename: parseContentDispositionFilename(disposition),
      contentType
    };
  } catch (_) {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function mergeRemoteMetadata(stream, remote) {
  if (!remote || typeof remote !== "object") return stream;
  if (!stream.fileSize && remote.fileSize) stream.fileSize = remote.fileSize;
  if (!stream.size && remote.fileSize) stream.size = remote.fileSize;
  if (!stream.filename && remote.filename) stream.filename = remote.filename;
  if (!stream.releaseFilename && remote.filename) stream.releaseFilename = remote.filename;
  if (!stream.releaseTitle && remote.filename) stream.releaseTitle = remote.filename;
  if (remote.contentType) stream.contentType = remote.contentType;
  return stream;
}

function cleanStream(s, providerName, providerId) {
  if (!s || typeof s !== "object" || !s.url) return null;

  const name = String(s.name || providerName).trim();
  const rawTitle = String(
    s.filename || s.fileName || s.releaseFilename || s.releaseFileName || s.releaseTitle || s.title || s.name || s.description || providerName
  ).replace(/\s+/g, " ").trim();
  const meta = detectMediaMeta(s);
  const releaseFilename = extractReleaseFilename(s, rawTitle);
  const providerSource = detectProviderSource(s, providerName);
  const display = buildStreamDisplay(s, providerName, meta, rawTitle, releaseFilename, providerSource);

  // Keep the original title available for clients that already use it, while
  // exposing a clean, Nuvio-friendly display title and structured scraper data.
  const titleParts = [rawTitle];
  const badges = display.badges;
  for (const badge of badges) {
    if (!rawTitle.toLowerCase().includes(String(badge).toLowerCase())) titleParts.push(`[${badge}]`);
  }

  const title = display.description || rawTitle || display.displayName;
  const generatedDescription = [
    meta.quality && `Quality: ${meta.quality}`,
    meta.source && `Source: ${meta.source}`,
    meta.fileSize && `Size: ${meta.fileSize}`,
    meta.language && `Language: ${meta.language}`,
    meta.audio && `Audio: ${meta.audio}`,
    meta.channels && `Channels: ${meta.channels}`,
    meta.codec && `Codec: ${meta.codec}`,
    meta.hdr && `HDR: ${meta.hdr}`,
    meta.bitDepth,
    meta.multiAudio && "Multi-Audio",
    meta.subtitles && `Subtitles: ${meta.subtitles}`,
    meta.bitrate && `Bitrate: ${meta.bitrate}`
  ].filter(Boolean).join(" • ");

  return {
    name: display.displayName || name,
    title,
    url: s.url,
    quality: meta.quality || undefined,
    resolution: meta.quality || undefined,
    fileSize: meta.fileSize || undefined,
    size: meta.fileSize || undefined,
    filename: releaseFilename || undefined,
    releaseFilename: releaseFilename || undefined,
    releaseTitle: rawTitle || undefined,
    provider: providerName,
    providerName,
    providerId: providerId || s.providerId || undefined,
    sourceProvider: providerSource || undefined,
    scraper: providerSource || providerName,
    server: providerSource || undefined,
    serverName: providerSource || undefined,
    release: releaseFilename || undefined,
    language: meta.language || undefined,
    audio: meta.audio || undefined,
    sound: meta.audio || undefined,
    codec: meta.codec || undefined,
    hdr: meta.hdr || undefined,
    source: meta.source || undefined,
    bitDepth: meta.bitDepth || undefined,
    channels: meta.channels || undefined,
    subtitles: meta.subtitles || undefined,
    multiAudio: meta.multiAudio || undefined,
    bitrate: meta.bitrate || undefined,
    badges: display.badges,
    detailLine: display.detailLine || undefined,
    sourceLabel: display.sourceLabel || undefined,
    display: {
      name: display.displayName || name,
      detailLine: display.detailLine || "",
      filename: releaseFilename || "",
      source: display.sourceLabel || "",
      badges: display.badges,
    },
    mediaInfo: {
      quality: meta.quality || "",
      source: meta.source || "",
      size: meta.fileSize || "",
      language: meta.language || "",
      audio: meta.audio || "",
      channels: meta.channels || "",
      codec: meta.codec || "",
      hdr: meta.hdr || "",
      bitDepth: meta.bitDepth || "",
      subtitles: meta.subtitles || "",
      multiAudio: Boolean(meta.multiAudio),
      bitrate: meta.bitrate || "",
      fileFormat: (() => { const m = String(releaseFilename || "").match(/\.([a-z0-9]{2,5})$/i); return m ? m[1].toUpperCase() : ""; })(),
    },
    description: display.description || generatedDescription || undefined,
    headers: s.headers || undefined,
    contentType: s.contentType || undefined,
    metadata: {
      version: 2,
      provider: providerName,
      providerId: providerId || s.providerId || "",
      scraper: providerSource || providerName,
      server: providerSource || providerName,
      filename: releaseFilename || "",
      quality: meta.quality || "",
      resolution: meta.quality || "",
      size: meta.fileSize || "",
      language: meta.language || "",
      audio: meta.audio || "",
      channels: meta.channels || "",
      codec: meta.codec || "",
      source: meta.source || "",
      hdr: meta.hdr || "",
      bitDepth: meta.bitDepth || "",
      subtitles: meta.subtitles || "",
      multiAudio: Boolean(meta.multiAudio),
      bitrate: meta.bitrate || "",
      badges: display.badges,
      fileFormat: (() => { const m = String(releaseFilename || "").match(/\.([a-z0-9]{2,5})$/i); return m ? m[1].toUpperCase() : ""; })(),
      extension: (() => { const m = String(releaseFilename || "").match(/\.([a-z0-9]{2,5})$/i); return m ? `.${m[1].toLowerCase()}` : ""; })()
    },
    behaviorHints: s.behaviorHints || undefined
  };
}

async function runProvider(id, type, tmdbId, season, episode) {
  const state = readProviders();
  const meta = state[id];
  const mod = loadProvider(id);
  if (!mod) return { id, name: meta?.name || id, streams: [], error: "Provider unavailable" };

  const nativeType = type === "series" ? "tv" : "movie";
  const started = Date.now();

  try {
    const result = await mod.getStreams(tmdbId, nativeType, season, episode);
    let streams = Array.isArray(result)
      ? result.map(s => cleanStream(s, meta.name, id)).filter(Boolean)
      : [];

    // Enrich every provider uniformly. Provider-specific scrapers remain the
    // source of truth, while a lightweight HEAD request fills missing size /
    // filename data from the resolved download endpoint when available.
    if (streams.length) {
      streams = await Promise.all(streams.map(async stream => {
        const needsRemote = !stream.fileSize || !stream.filename;
        if (!needsRemote) return stream;
        const remote = await runRemoteMetaTask(() => fetchRemoteMetadata(stream));
        if (!remote || (!remote.fileSize && !remote.filename)) return stream;
        const raw = { ...stream };
        mergeRemoteMetadata(raw, remote);
        const rebuilt = cleanStream(raw, meta.name, id);
        return rebuilt || stream;
      }));
    }
    log("info", "Provider completed", { provider: id, count: streams.length, ms: Date.now() - started });
    return { id, name: meta.name, streams };
  } catch (e) {
    log("warn", "Provider failed", { provider: id, error: e.message, ms: Date.now() - started });
    return { id, name: meta.name, streams: [], error: e.message };
  }
}

// Standard Stremio/Nuvio-style addon manifest.
app.get("/manifest.json", (_req, res) => {
  res.set("X-Knox-Manifest-Revision", String(manifestRevision));
  res.json(addonManifest());
});

function addonManifest() {
  const state = readProviders();
  const all = Object.values(state);
  const enabledProviderIds = all.filter(p => p.enabled === true).map(p => p.id);
  const manifest = {
    id: "com.knox.express",
    version: "4.0.22",
    name: "Knox Express",
    description: "Knox Express multi-provider streaming addon with provider controls.",
    logo: "/logo.svg",
    icon: "/logo.svg",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb"],
    behaviorHints: { configurable: true, configurationRequired: false },
    // Non-standard metadata is ignored by Stremio/Nuvio but lets the control
    // center and compatible clients detect a changed provider configuration.
    knox: {
      manifestRevision,
      enabledProviderIds,
      enabledProviderCount: enabledProviderIds.length,
      providerCount: all.length,
      scraperRefreshRevision,
      updatedAt: new Date().toISOString()
    }
  };
  return manifest;
}

app.get("/api/providers", async (_req, res) => {
  const state = await hydrateProviders();
  res.json(Object.values(state));
});

app.get("/api/logs", (_req, res) => {
  res.json(logs);
});

app.post("/api/providers/:id/toggle", async (req, res) => {
  const state = await hydrateProviders();
  if (!state[req.params.id]) return res.status(404).json({ error: "Provider not found" });
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    state[req.params.id].enabled = req.body.enabled;
    manifestRevision += 1;
    streamCache.clear();
    await persistProviders(state);
    log("info", "Provider setting changed", { provider: req.params.id, enabled: state[req.params.id].enabled });
    return res.json(state[req.params.id]);
  } catch (e) {
    log("error", "Provider toggle failed", { provider: req.params.id, error: e.message });
    return res.status(500).json({ error: "Could not save provider setting", detail: e.message });
  }
});

app.post("/api/providers/toggle-all", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  const enabled = req.body.enabled;
  const state = await hydrateProviders();
  try {
    for (const p of Object.values(state)) p.enabled = enabled;
    manifestRevision += 1;
    streamCache.clear();
    await persistProviders(state);
    log("info", "All providers changed", { enabled });
    return res.json(Object.values(state));
  } catch (e) {
    log("error", "Toggle-all failed", { error: e.message });
    return res.status(500).json({ error: "Could not save provider settings", detail: e.message });
  }
});

app.get("/api/settings", (_req, res) => {
  const settings = readSettings();
  res.json({ timeoutMs: 0, timeoutOptions: [] });
});

app.post("/api/settings/timeout", (_req, res) => {
  try {
    const current = readSettings();
    const settings = writeSettings({ ...current, timeoutMs: 0 });
    streamCache.clear();
    log("info", "Provider timeout disabled (unlimited)");
    return res.json({ ok: true, timeoutMs: 0, timeoutOptions: [] });
  } catch (e) {
    log("error", "Timeout setting failed", { error: e.message });
    return res.status(500).json({ error: "Could not save timeout setting", detail: e.message });
  }
});

app.get("/api/dns", (_req, res) => {
  const settings = readSettings();
  res.json({ presets: DNS_PRESETS, dnsServers: settings.dnsServers || [] });
});

app.post("/api/settings/dns", (req, res) => {
  const preset = String(req.body?.preset || "custom").toLowerCase();
  let dnsServers;
  if (preset !== "custom") {
    if (!(preset in DNS_PRESETS)) return res.status(400).json({ error: "Unknown DNS provider" });
    dnsServers = DNS_PRESETS[preset];
  } else {
    const raw = Array.isArray(req.body?.dnsServers) ? req.body.dnsServers : String(req.body?.dnsServers || "").split(/[,\s]+/);
    dnsServers = normalizeDnsServers(raw);
    if (!dnsServers.length) return res.status(400).json({ error: "Enter at least one valid IPv4 or IPv6 DNS server" });
  }

  const settings = readSettings();
  settings.dnsServers = dnsServers;
  const saved = writeSettings(settings);
  log("info", "DNS provider changed", { dnsServers });
  res.json({ dnsServers: saved.dnsServers });
});

app.post("/api/cache/clear", (_req, res) => {
  const cleared = streamCache.size;
  streamCache.clear();
  manifestRevision += 1;
  res.set("X-Knox-Manifest-Revision", String(manifestRevision));
  log("info", "Force refresh: stream cache cleared", { cleared, manifestRevision });
  res.json({ ok: true, cleared, manifestRevision, manifestUrl: `/manifest.json` });
});

// Reload provider scraper modules and clear every cached stream. This is a
// local addon refresh operation; it does not change provider enable/disable state.
app.post("/api/scrapers/refresh", async (_req, res) => {
  const state = await hydrateProviders();
  const enabledProviders = Object.values(state).filter(p => p.enabled === true);

  // Reload every enabled scraper concurrently. A broken scraper is isolated
  // and cannot prevent the other scraper modules from being refreshed.
  const refreshSettled = await Promise.allSettled(enabledProviders.map(async (p) => {
    const filename = path.basename(p.filename);
    const file = path.join(ROOT, "providers", filename);
    if (!fs.existsSync(file)) throw new Error("Provider file missing");
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    const mod = require(resolved);
    if (!mod || typeof mod.getStreams !== "function") {
      throw new Error("Provider does not export getStreams");
    }
    return p.id;
  }));

  const refreshed = [];
  const failed = [];
  refreshSettled.forEach((result, index) => {
    const provider = enabledProviders[index];
    if (result.status === "fulfilled") {
      refreshed.push(result.value);
    } else {
      failed.push({
        id: provider.id,
        error: result.reason?.message || String(result.reason)
      });
    }
  });
  const cleared = streamCache.size;
  streamCache.clear();
  scraperRefreshRevision += 1;
  manifestRevision += 1;
  log("info", "Force refresh: provider scrapers reloaded", {
    refreshed: refreshed.length,
    failed: failed.length,
    cleared,
    scraperRefreshRevision,
    manifestRevision
  });
  res.set("X-Knox-Manifest-Revision", String(manifestRevision));
  res.json({
    ok: true,
    refreshed,
    failed,
    cleared,
    scraperRefreshRevision,
    manifestRevision,
    manifestUrl: `/manifest.json`
  });
});

app.get("/api/providers/diagnostics", async (_req, res) => {
  const state = await hydrateProviders();
  const entries = Object.values(state);
  const results = await Promise.all(entries.map(async (p) => {
    const filename = path.basename(p.filename || "");
    const file = path.join(ROOT, "providers", filename);
    const base = { id: p.id, name: p.name, enabled: p.enabled === true, filename };
    if (!filename || !fs.existsSync(file)) return { ...base, loaded: false, error: "Provider file missing" };
    try {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const mod = require(resolved);
      return { ...base, loaded: Boolean(mod && typeof mod.getStreams === "function"), error: mod && typeof mod.getStreams === "function" ? null : "Missing getStreams export" };
    } catch (e) {
      return { ...base, loaded: false, error: e.message };
    }
  }));
  res.json({
    total: results.length,
    enabled: results.filter(r => r.enabled).length,
    loaded: results.filter(r => r.loaded).length,
    failed: results.filter(r => !r.loaded),
    providers: results
  });
});

app.get("/api/health", (_req, res) => {
  const state = readProviders();
  const all = Object.values(state);
  res.json({
    ok: true,
    uptime: process.uptime(),
    providers: all.length,
    enabled: all.filter(p => p.enabled).length,
    node: process.version,
    manifestRevision,
    scraperRefreshRevision,
    time: new Date().toISOString()
  });
});

async function handleStream(req, res) {
  const type = req.params.type;
  if (!["movie", "series"].includes(type)) return res.status(404).json({ streams: [] });

  const parsed = parseStreamId(type, req.params.id);
  let tmdbId;
  try {
    tmdbId = await resolveTmdbId(parsed.id);
  } catch (e) {
    log("warn", "ID resolution failed", { id: parsed.id, error: e.message });
    return res.json({ streams: [] });
  }

  const state = await hydrateProviders();
  const enabled = Object.values(state).filter(p => p.enabled === true);
  const cacheKey = `${type}:${tmdbId}:${parsed.season || ""}:${parsed.episode || ""}:${enabled.map(p => p.id).join(",")}`;
  const cached = streamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set("X-Knox-Cache", "HIT");
    return res.json({ streams: cached.streams });
  }
  if (cached) streamCache.delete(cacheKey);

  log("info", "Stream request", {
    type, requestedId: req.params.id, tmdbId, providers: enabled.length,
    season: parsed.season, episode: parsed.episode
  });

  // Start every enabled provider at once. There is no application-level timeout.
  const results = [];
  const startedAll = Date.now();
  // IMPORTANT: create every promise before awaiting any result. This means
  // all enabled scrapers start together instead of running one-by-one.
  const providerTasks = enabled.map((p) => {
    log("info", "Provider started", { provider: p.id });
    return runProvider(p.id, type, tmdbId, parsed.season, parsed.episode);
  });
  const settled = await Promise.allSettled(providerTasks);
  for (let i = 0; i < settled.length; i++) {
    const item = settled[i];
    const provider = enabled[i];
    if (item.status === "fulfilled") {
      results.push(item.value);
    } else {
      log("warn", "Provider promise rejected", { provider: provider.id, error: item.reason?.message || String(item.reason) });
      results.push({ id: provider.id, name: provider.name, streams: [], error: item.reason?.message || "Provider failed" });
    }
  }

  log("info", "All enabled providers fetched", {
    providers: enabled.length,
    successful: results.filter(r => r.streams.length > 0).length,
    streams: results.reduce((n, r) => n + r.streams.length, 0),
    ms: Date.now() - startedAll,
  });

  const streams = results.flatMap(r => r.streams);
  const seen = new Set();
  const unique = streams.filter(s => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  streamCache.set(cacheKey, { streams: unique, expiresAt: Date.now() + STREAM_CACHE_TTL_MS });
  // Keep memory bounded on long-running self-hosted instances.
  if (streamCache.size > 200) {
    const oldest = streamCache.keys().next().value;
    if (oldest) streamCache.delete(oldest);
  }
  res.set("X-Knox-Cache", "MISS");
  res.json({ streams: unique });
}

app.get("/stream/:type/:id.json", handleStream);
app.get("/stream/:type/:id", handleStream);

// UI-friendly aliases.
app.get("/api/stream/:type/:id", handleStream);

app.get("/node-version", (_req, res) => {
  res.json({ node: process.version, platform: process.platform, arch: process.arch });
});

// Nuvio/Stremio opens /configure when the addon is marked configurable.
// Keep this route explicit so Vercel never returns `Cannot GET /configure`.
app.get(["/configure", "/configure/"], (_req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  log("error", "Unhandled server error", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

// Vercel imports this module as a serverless function. Only start a listener
// when running the app directly with `node server.js`.
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    log("info", `Knox Express listening on port ${PORT}`);
    log("info", `Manifest: http://localhost:${PORT}/manifest.json`);
  });
}

module.exports = app;
