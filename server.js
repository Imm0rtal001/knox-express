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
const TIMEOUT_OPTIONS = [];
const DEFAULT_TIMEOUT_MS = 0;
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
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b/i);
  if (!m) return text;
  return `${m[1]} ${m[2].toUpperCase()}`;
}

function detectMediaMeta(s) {
  const raw = [
    s?.title, s?.name, s?.quality, s?.description, s?.filename,
    s?.fileName, s?.label, s?.release, s?.releaseTitle
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const upper = raw.toUpperCase();

  let quality = firstValue(s, ["quality", "resolution", "videoQuality", "video_quality"]);
  if (!quality) {
    if (/\b(2160P|2160|4K|UHD)\b/i.test(raw)) quality = "2160p";
    else if (/\b(1440P|1440)\b/i.test(raw)) quality = "1440p";
    else if (/\b(1080P|1080|FHD)\b/i.test(raw)) quality = "1080p";
    else if (/\b(720P|720|HD)\b/i.test(raw)) quality = "720p";
    else if (/\b(480P|480)\b/i.test(raw)) quality = "480p";
  }

  let fileSize = normalizeFileSize(firstValue(s, [
    "fileSize", "filesize", "size", "file_size", "contentLength", "content_length"
  ]));
  if (!fileSize) {
    const m = raw.match(/\b\d+(?:\.\d+)?\s*(?:TB|GB|MB|KB)\b/i);
    if (m) fileSize = normalizeFileSize(m[0]);
  }

  let language = firstValue(s, ["language", "lang", "languages", "audioLanguage", "audio_language"]);
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
  ]);
  if (!audio) {
    if (/\b(ATMOS|DOLBY\s*ATMOS)\b/i.test(raw)) audio = "Dolby Atmos";
    else if (/\b(E-?AC-?3|DDP?\s*5\.1|DD\s*5\.1|5\.1)\b/i.test(raw)) audio = "DDP 5.1";
    else if (/\b(DTS-?HD|DTS)\b/i.test(raw)) audio = "DTS";
    else if (/\b(AAC\s*2\.0|AAC)\b/i.test(raw)) audio = "AAC 2.0";
    else if (/\b(2\.0|STEREO)\b/i.test(raw)) audio = "Stereo";
  }

  const codec = firstValue(s, ["codec", "videoCodec", "video_codec"])
    || (/(HEVC|H\.265|X265)/i.test(raw) ? "HEVC" : /(AVC|H\.264|X264)/i.test(raw) ? "H.264" : "");

  let source = firstValue(s, ["source", "releaseSource", "release_source", "mediaSource", "media_source"]);
  if (!source) {
    if (/\bREMUX\b/i.test(raw)) source = "Remux";
    else if (/\bBLU[- .]?RAY\b/i.test(raw)) source = "BluRay";
    else if (/\bWEB[- .]?DL\b/i.test(raw)) source = "WEB-DL";
    else if (/\bWEB[- .]?RIP\b/i.test(raw)) source = "WEBRip";
    else if (/\bHDTV\b/i.test(raw)) source = "HDTV";
    else if (/\bDVDRIP\b/i.test(raw)) source = "DVDRip";
  }

  const bitDepth = firstValue(s, ["bitDepth", "bit_depth"]) || (/\b10[- ]?BIT\b/i.test(raw) ? "10-bit" : /\b8[- ]?BIT\b/i.test(raw) ? "8-bit" : "");
  const channels = firstValue(s, ["channels", "audioChannels", "audio_channels"]) || (/(7\.1|5\.1|2\.0|STEREO)/i.test(raw) ? (raw.match(/\b(7\.1|5\.1|2\.0)\b/i)?.[1] || (/STEREO/i.test(raw) ? "2.0" : "")) : "");
  const subtitles = firstValue(s, ["subtitles", "subtitle", "subs", "sub"]);
  const multiAudio = Boolean(s?.multiAudio || s?.multi_audio || /\b(MULTI[- ]?AUDIO|MULTI AUDIO|DUAL[- ]?AUDIO|DUAL AUDIO|MULTI)/i.test(raw));
  const bitrate = firstValue(s, ["bitrate", "videoBitrate", "video_bitrate"]);
  const hdr = firstValue(s, ["hdr", "dynamicRange", "dynamic_range"])
    || (/\bHDR10\+\b/i.test(raw) ? "HDR10+" : /\bHDR10\b/i.test(raw) ? "HDR10" : /\bDV|DOLBY\s*VISION\b/i.test(raw) ? "Dolby Vision" : "");

  return { quality, fileSize, language, audio, codec, hdr, source, bitDepth, channels, subtitles, multiAudio, bitrate };
}

function cleanStream(s, providerName) {
  if (!s || typeof s !== "object" || !s.url) return null;

  const name = String(s.name || providerName).trim();
  const rawTitle = String(s.title || s.name || providerName).replace(/\s+/g, " ").trim();
  const meta = detectMediaMeta(s);
  const titleParts = [rawTitle];

  const badges = [
    meta.quality,
    meta.source,
    meta.fileSize,
    meta.language,
    meta.audio,
    meta.channels,
    meta.codec,
    meta.hdr,
    meta.bitDepth,
    meta.multiAudio ? "Multi-Audio" : "",
    meta.subtitles ? "Subtitles" : "",
    meta.bitrate
  ].filter(Boolean);

  for (const badge of badges) {
    if (!rawTitle.toLowerCase().includes(String(badge).toLowerCase())) titleParts.push(`[${badge}]`);
  }

  const title = titleParts.join(" ").replace(/\s{2,}/g, " ").trim();
  const description = [
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
    name,
    title,
    url: s.url,
    quality: meta.quality || undefined,
    fileSize: meta.fileSize || undefined,
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
    description: s.description || description || undefined,
    headers: s.headers || undefined,
    behaviorHints: s.behaviorHints || undefined
  };
}

async function runProvider(id, type, tmdbId, season, episode, timeoutMs) {
  const state = readProviders();
  const meta = state[id];
  const mod = loadProvider(id);
  if (!mod) return { id, name: meta?.name || id, streams: [], error: "Provider unavailable" };

  const nativeType = type === "series" ? "tv" : "movie";
  const started = Date.now();

  try {
    // No application-level timeout: allow the provider to finish. Vercel/self-hosting
    // may still impose its own platform execution limit.
    const result = await Promise.resolve().then(() => mod.getStreams(tmdbId, nativeType, season, episode));
    const streams = Array.isArray(result)
      ? result.map(s => cleanStream(s, meta.name)).filter(Boolean)
      : [];
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
  res.json({ timeoutMs: 0, timeoutOptions: [] });
});

app.post("/api/settings/timeout", (req, res) => {
  try {
    const settings = writeSettings({ timeoutMs: 0 });
    log("info", "Provider timeout changed", { timeoutMs });
    return res.json(settings);
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
  const refreshed = [];
  const failed = [];
  for (const p of Object.values(state)) {
    if (p.enabled !== true) continue;
    try {
      const filename = path.basename(p.filename);
      const file = path.join(ROOT, "providers", filename);
      if (!fs.existsSync(file)) throw new Error("Provider file missing");
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      const mod = require(resolved);
      if (!mod || typeof mod.getStreams !== "function") throw new Error("Provider does not export getStreams");
      refreshed.push(p.id);
    } catch (e) {
      failed.push({ id: p.id, error: e.message });
    }
  }
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
  const timeoutMs = 0;
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
  const settled = await Promise.allSettled(enabled.map((p) =>
    runProvider(p.id, type, tmdbId, parsed.season, parsed.episode, 0)
  ));
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
    timeoutMs: 0
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
