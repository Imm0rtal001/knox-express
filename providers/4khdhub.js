use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{NativeProvider, StreamsFuture};

const PROVIDER_NAME: &str = "4kHdHub";
const DOMAINS_JSON_URL: &str =
    "https://raw.githubusercontent.com/Imm0rtal001/knox/refs/heads/main/manifest.json";
const DEFAULT_BASE_URL: &str = "https://4khdhub.one";
const UA: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";
const DOMAIN_CACHE_TTL: Duration = Duration::from_secs(4 * 60 * 60);

fn re_quality() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(2160|1080|720|480)p|(4K|UHD)").unwrap())
}
fn re_hubcloud() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)https?://hubcloud\.[a-z0-9]+/drive/[a-z0-9]+").unwrap()
    })
}
fn re_sxex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)S0*(\d+)[.\s_\-]*E0*(\d+)").unwrap())
}
fn re_ep() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)Episode\s*0*(\d+)").unwrap())
}
fn re_year() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b(19\d{2}|20\d{2})\b").unwrap())
}
fn re_size_ctx() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(?:^|[\s>])(\d+\.?\d*)\s*(GB|MB)\b").unwrap())
}
fn re_card_header() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r#"(?i)<div[^>]*class=['"][^'"]*card-header[^'"]*['"][^>]*>([^<]+)<"#).unwrap()
    })
}
fn re_size_td() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)<td[^>]*>\s*File\s*Size\s*:\s*</td>\s*<td[^>]*>\s*([\d\.]+\s*[MGBtbi]+)\s*</td>",
        )
        .unwrap()
    })
}
fn re_size_str() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)Size\s*:\s*</strong>\s*([\d\.]+\s*[MGBtbi]+)").unwrap())
}
fn re_slug_junk() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)^(movie|series)$|^\d+$").unwrap())
}
fn re_nonalnum() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[^a-z0-9]").unwrap())
}
fn re_ext() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\.(mkv|mp4|avi|rar|zip)$").unwrap())
}
fn re_link() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"href="(https?://[^"/]+)?(/[^"]+)""#).unwrap())
}
fn re_php_url() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"(?i)href="([^"]*hubcloud\.php[^"]*)""#).unwrap())
}
fn re_a_link() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r#"(?i)<a[^>]+href="([^"]+)"[^>]*>(?:<i[^>]*></i>)?\s*([^<]+)</a>"#).unwrap()
    })
}

struct DomainState {
    base_url: String,
    updated_at: Option<Instant>,
}

struct TmdbInfo {
    title: String,
    year: String,
    imdb_id: String,
    is_tv: bool,
}

struct SearchResult {
    url: String,
    content: Option<String>,
}

struct HubcloudLink {
    url: String,
    quality: String,
    size: String,
}

pub struct HexionProvider {
    client: crate::scraper_client::ScraperClient,
    tmdb_api_key: String,
    domain_state: Arc<Mutex<DomainState>>,
}

impl HexionProvider {
    pub fn new(client: crate::scraper_client::ScraperClient, tmdb_api_key: String) -> Self {
        HexionProvider {
            client,
            tmdb_api_key,
            domain_state: Arc::new(Mutex::new(DomainState {
                base_url: DEFAULT_BASE_URL.to_string(),
                updated_at: None,
            })),
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("User-Agent", UA.parse().unwrap());
        h.insert(
            "Accept",
            "text/html,application/xhtml+xml,*/*;q=0.8".parse().unwrap(),
        );
        h
    }

    async fn fetch_text(&self, url: &str, referer: Option<&str>) -> Option<String> {
        let mut req = self.client.get(url).headers(self.headers());
        if let Some(r) = referer {
            req = req.header("Referer", r);
        }
        let resp = req.send().await.ok()?;
        if resp.status().is_success() {
            resp.text().await.ok()
        } else {
            None
        }
    }

    async fn fetch_json(&self, url: &str) -> Option<Value> {
        let resp = self
            .client
            .get(url)
            .headers(self.headers())
            .send()
            .await
            .ok()?;
        if resp.status().is_success() {
            resp.json().await.ok()
        } else {
            None
        }
    }

    async fn get_base_url(&self) -> String {
        let mut state = self.domain_state.lock().await;
        let stale = state
            .updated_at
            .map(|t| t.elapsed() >= DOMAIN_CACHE_TTL)
            .unwrap_or(true);

        if stale {
            if let Some(data) = self.fetch_json(DOMAINS_JSON_URL).await {
                if let Some(url) = data["4khdhub"].as_str() {
                    state.base_url = url.to_string();
                    state.updated_at = Some(Instant::now());
                }
            }
        }
        state.base_url.clone()
    }

    async fn get_tmdb_info(&self, tmdb_id: &str, media_type: &str) -> Option<TmdbInfo> {
        let is_tv = media_type == "tv" || media_type == "series";
        let url = if is_tv {
            format!(
                "https://api.themoviedb.org/3/tv/{tmdb_id}?api_key={}&append_to_response=external_ids",
                self.tmdb_api_key
            )
        } else {
            format!(
                "https://api.themoviedb.org/3/movie/{tmdb_id}?api_key={}",
                self.tmdb_api_key
            )
        };
        let data = self.fetch_json(&url).await?;

        let title = if is_tv {
            data["name"].as_str()?.to_string()
        } else {
            data["title"].as_str()?.to_string()
        };
        let year = if is_tv {
            data["first_air_date"]
                .as_str()
                .and_then(|d| d.get(..4))
                .unwrap_or("")
                .to_string()
        } else {
            data["release_date"]
                .as_str()
                .and_then(|d| d.get(..4))
                .unwrap_or("")
                .to_string()
        };
        let imdb_id = if is_tv {
            data["external_ids"]["imdb_id"]
                .as_str()
                .unwrap_or("")
                .to_string()
        } else {
            data["imdb_id"].as_str().unwrap_or("").to_string()
        };

        Some(TmdbInfo {
            title,
            year,
            imdb_id,
            is_tv,
        })
    }

    async fn search_site(&self, info: &TmdbInfo, base_url: &str) -> Option<SearchResult> {
        if !info.imdb_id.is_empty() {
            let posts_url = format!(
                "{base_url}/wp-json/wp/v2/posts?search={}",
                info.imdb_id
            );
            if let Some(posts) = self.fetch_json(&posts_url).await {
                if let Some(arr) = posts.as_array() {
                    if !arr.is_empty() {
                        let link = arr[0]["link"].as_str()?.to_string();
                        let content = if !info.is_tv {
                            arr[0]["content"]["rendered"]
                                .as_str()
                                .map(|s| s.to_string())
                        } else {
                            None
                        };
                        return Some(SearchResult { url: link, content });
                    }
                }
            }
        }

        let encoded = urlencoding::encode(&info.title);
        let html = self
            .fetch_text(&format!("{base_url}/?s={encoded}"), None)
            .await?;

        let body = html
            .split("id=\"main\"")
            .nth(1)
            .unwrap_or(&html)
            .to_string();

        let clean_q: String = re_nonalnum()
            .replace_all(&info.title.to_lowercase(), "")
            .to_string();
        let type_str = if info.is_tv { "-series-" } else { "-movie-" };
        let anti_str = if info.is_tv { "-movie-" } else { "-series-" };

        let mut best: Option<SearchResult> = None;

        for cap in re_link().captures_iter(&body) {
            let domain = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let path = cap.get(2).map(|m| m.as_str()).unwrap_or("");

            if !domain.is_empty() && !domain.contains("4khdhub") {
                continue;
            }
            if path.contains("/category/") || path.contains('?') || path.contains(anti_str) {
                continue;
            }
            if !path.contains(type_str) {
                continue;
            }

            let slug: String = path
                .split('/')
                .filter(|s| !s.is_empty())
                .last()
                .unwrap_or("")
                .split('-')
                .filter(|w| !re_slug_junk().is_match(w))
                .collect::<Vec<_>>()
                .join("");
            let slug = re_nonalnum()
                .replace_all(&slug.to_lowercase(), "")
                .to_string();

            if !slug.contains(&clean_q) && !clean_q.contains(&slug) {
                continue;
            }

            let m_start = cap.get(0).map(|m| m.start()).unwrap_or(0);
            let ctx = &body[m_start..body.len().min(m_start + 300)];
            let year_hit = !info.year.is_empty()
                && re_year()
                    .captures(ctx)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str())
                    == Some(info.year.as_str());

            if best.is_none() || year_hit {
                best = Some(SearchResult {
                    url: format!("{base_url}{path}"),
                    content: None,
                });
                if year_hit {
                    break;
                }
            }
        }

        best
    }

    fn extract_hubcloud_links(
        &self,
        html: &str,
        season: i32,
        episode: i32,
        is_series: bool,
    ) -> Vec<HubcloudLink> {
        let scope: &str = if is_series {
            let start = html
                .find("id=\"episodes\"")
                .or_else(|| html.find("data-tab=\"episodes\""))
                .unwrap_or(0);
            let s = &html[start..];
            let end = s.find("id=\"complete-pack\"").unwrap_or(s.len());
            let abs_start = start;
            let abs_end = start + end;
            &html[abs_start..abs_end]
        } else {
            html
        };

        let mut results = Vec::new();

        for m in re_hubcloud().find_iter(scope) {
            let url = m.as_str().to_string();
            let before_start = m.start().saturating_sub(1500);
            let ctx_before = &scope[before_start..m.start()];

            if is_series {
                let ctx_after_end = scope.len().min(m.end() + 500);
                let ctx = format!("{}{}", ctx_before, &scope[m.start()..ctx_after_end]);

                if let Some(cap) = re_sxex().captures(&ctx) {
                    let s: i32 = cap[1].parse().unwrap_or(0);
                    let e: i32 = cap[2].parse().unwrap_or(0);
                    if s != season || e != episode {
                        continue;
                    }
                } else if let Some(cap) = re_ep().captures(&ctx) {
                    let e: i32 = cap[1].parse().unwrap_or(0);
                    if e != episode {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            let quality = re_quality()
                .captures(ctx_before)
                .map(|c| {
                    let v = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str()).unwrap_or("");
                    let upper = v.to_uppercase();
                    if upper.contains("4K") || upper == "UHD" {
                        "2160P".to_string()
                    } else {
                        format!("{upper}P")
                    }
                })
                .unwrap_or_else(|| "HD".to_string());

            if quality == "480P" {
                continue;
            }

            let size = re_size_ctx()
                .captures(ctx_before)
                .map(|c| format!("{} {}", &c[1], &c[2]))
                .unwrap_or_default();

            results.push(HubcloudLink { url, quality, size });
        }

        results
    }

    async fn resolve_hubcloud(
        &self,
        link: &HubcloudLink,
        base_url: &str,
        fallback_title: &str,
    ) -> Vec<Value> {
        let mut streams = Vec::new();

        let html = match self
            .fetch_text(&link.url, Some(&format!("{base_url}/")))
            .await
        {
            Some(h) => h,
            None => return streams,
        };

        let php_url = match re_php_url()
            .captures(&html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace("&amp;", "&"))
        {
            Some(u) => u,
            None => return streams,
        };

        let html2 = match self.fetch_text(&php_url, Some(&link.url)).await {
            Some(h) => h,
            None => return streams,
        };

        let filename = re_card_header()
            .captures(&html2)
            .and_then(|c| c.get(1))
            .map(|m| re_ext().replace(m.as_str().trim(), "").to_string())
            .unwrap_or_else(|| fallback_title.to_string());

        let file_size = re_size_td()
            .captures(&html2)
            .or_else(|| re_size_str().captures(&html2))
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_else(|| link.size.clone());

        let current_minute =
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() / 60) % 60;

        for cap in re_a_link().captures_iter(&html2) {
            let mut stream_url = cap[1].replace("&amp;", "&");
            let label = cap[2].trim().to_string();

            if stream_url.is_empty() || stream_url.starts_with("javascript:") {
                continue;
            }
            if stream_url.ends_with(".zip") || stream_url.ends_with(".rar") {
                continue;
            }
            if stream_url.contains("pixel.hubcloud") {
                continue;
            }
            if label.to_lowercase().contains("telegram") || stream_url.contains("tg/") {
                continue;
            }
            let su_lower = stream_url.to_lowercase();
            if su_lower.contains("hubcloud.cx/drive/admin")
                || su_lower.contains("pixeldrain")
                || su_lower.contains("bzzhr")
            {
                continue;
            }

            let host = if su_lower.contains("cdn.fsl-buckets.life")
                || su_lower.contains("r2.cloudflarestorage")
                || su_lower.contains("r2.dev")
            {
                "FSL-v2"
            } else if su_lower.contains("hub.latent") || su_lower.contains("hub.whistle") {
                stream_url = format!("{stream_url}1{current_minute}");
                "FSL"
            } else {
                continue;
            };

            let name_parts: Vec<&str> = [PROVIDER_NAME, link.quality.as_str(), file_size.as_str()]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect();
            let title_parts: Vec<&str> = [filename.as_str(), host]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect();

            streams.push(json!({
                "name":    name_parts.join(" • "),
                "title":   title_parts.join("\n"),
                "url":     stream_url,
                "quality": link.quality,
                "behaviorHints": {
                    "notWebReady": true,
                    "proxyHeaders": {
                        "request": { "Referer": php_url }
                    }
                }
            }));
        }

        streams
    }
}

impl NativeProvider for HexionProvider {
    fn provider_id(&self) -> &str {
        "hexion"
    }

    fn get_streams<'a>(
        &'a self,
        tmdb_id: &'a str,
        _imdb_id: &'a str,
        media_type: &'a str,
        season: Option<i32>,
        episode: Option<i32>,
    ) -> StreamsFuture<'a> {
        Box::pin(async move {
            let base_url = self.get_base_url().await;

            let info = match self.get_tmdb_info(tmdb_id, media_type).await {
                Some(i) => i,
                None => return vec![],
            };

            let result = match self.search_site(&info, &base_url).await {
                Some(r) => r,
                None => return vec![],
            };

            let html = match result.content {
                Some(c) => c,
                None => match self.fetch_text(&result.url, None).await {
                    Some(h) => h,
                    None => return vec![],
                },
            };

            let is_series = info.is_tv;
            let s = season.unwrap_or(0);
            let e = episode.unwrap_or(0);

            let links = self.extract_hubcloud_links(&html, s, e, is_series);
            if links.is_empty() {
                return vec![];
            }

            let tasks: Vec<_> = links
                .iter()
                .map(|link| self.resolve_hubcloud(link, &base_url, &info.title))
                .collect();
            let batches = futures::future::join_all(tasks).await;
            let mut streams: Vec<Value> = batches.into_iter().flatten().collect();

            let q_order = |q: &str| match q {
                "2160P" => 4i32,
                "1080P" => 3,
                "720P"  => 2,
                _       => 1,
            };
            streams.sort_by(|a, b| {
                let qa = a["quality"].as_str().unwrap_or("");
                let qb = b["quality"].as_str().unwrap_or("");
                let qd = q_order(qb).cmp(&q_order(qa));
                if qd != std::cmp::Ordering::Equal {
                    return qd;
                }
                let fsl_b = b["name"].as_str().unwrap_or("").contains("FSL-v2") as i32;
                let fsl_a = a["name"].as_str().unwrap_or("").contains("FSL-v2") as i32;
                fsl_b.cmp(&fsl_a)
            });

            streams
        })
    }
                   }
