use base64::{engine::general_purpose, Engine as _};
use glob::glob;
use image::{ImageBuffer, Rgba};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static COVER_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const CLOUDFLARE_FLUX_PROMPT_LIMIT: usize = 2_048;
const CLOUDFLARE_PROMPT_TAIL_CHARS: usize = 512;
const COVER_EDIT_INSTRUCTION_LIMIT: usize = 600;
const COVER_EDIT_SOURCE_MAX_PX: u32 = 1_536;
const MAX_COVER_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024;
const CLOUDFLARE_EDIT_DEFAULT_MODEL: &str = "black-forest-labs/flux-2-pro-preview";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumInfo {
    pub artist: String,
    pub album: String,
    pub year: u16,
    pub label: String,
    pub tracks: Vec<String>,
    pub cover_art_urls: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCover {
    pub image_path: String,
    pub preview_url: String,
    pub prompt: String,
    pub palette: Vec<String>,
    /// Which backend produced this: "pollinations", "cloudflare", "codex", or
    /// "mock" (placeholder). The UI must never present a placeholder as AI art.
    #[serde(default)]
    pub adapter: String,
}

/// The REAL album cover downloaded to a full-res local file, shaped like GeneratedCover so the
/// frontend applies it to the front slot through the exact same path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealCover {
    pub image_path: String,
    pub preview_url: String,
    pub palette: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsFetch {
    pub text: String,
    pub source_url: String,
}

/// The aesthetic the app has LEARNED about an album from its real cover art:
/// the artwork itself (as a preview) plus the dominant palette extracted from
/// it. This is the theme that drives cover generation and booklet styling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverTheme {
    pub source_url: String,
    pub preview_url: String,
    pub palette: Vec<String>,
    /// 0..1 - how dark the original artwork reads overall.
    pub luminance: f32,
}

pub trait ImageGenAdapter {
    fn generate_cover(&self, prompt: &str, style_refs: &[String]) -> Result<PathBuf, String>;
}

pub struct MockImageGenAdapter {
    pub output_dir: PathBuf,
}

impl ImageGenAdapter for MockImageGenAdapter {
    fn generate_cover(&self, prompt: &str, _style_refs: &[String]) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.output_dir).map_err(|err| err.to_string())?;
        // Slugged Style-DNA prompts run long enough to blow MAX_PATH (os error 123).
        let mut name = slug(prompt);
        name.truncate(60);
        let path = unique_cover_path(&self.output_dir, &format!("mock-cover-{name}"), "png");
        write_mock_cover_png(&path, prompt)?;
        Ok(path)
    }
}

pub struct CodexImageGenAdapter {
    pub output_dir: PathBuf,
    pub timeout_secs: u64,
}

impl ImageGenAdapter for CodexImageGenAdapter {
    fn generate_cover(&self, prompt: &str, style_refs: &[String]) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.output_dir).map_err(|err| err.to_string())?;
        let explicit_path = unique_cover_path(&self.output_dir, "codex-cover", "png");
        if std::env::var("MXTP_MKR_IMAGEGEN_RECOVER_SESSIONS").as_deref() == Ok("1")
            && recover_recent_codex_session_image(
                prompt,
                &explicit_path,
                Duration::from_secs(3_600),
            )?
        {
            ensure_min_cover_size(&explicit_path, 1536)?;
            return Ok(explicit_path);
        }
        if explicit_path.is_file() {
            fs::remove_file(&explicit_path).map_err(|err| err.to_string())?;
        }
        let full_prompt = codex_image_prompt(prompt, style_refs, &explicit_path);
        let mut child = codex_command(&self.output_dir, self.timeout_secs)?;
        child
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut process = child
            .spawn()
            .map_err(|err| format!("failed to spawn codex image generation: {err}"))?;
        let mut stdin = process
            .stdin
            .take()
            .ok_or_else(|| "failed to open codex stdin".to_string())?;
        stdin
            .write_all(full_prompt.as_bytes())
            .map_err(|err| err.to_string())?;
        drop(stdin);
        wait_for_codex_image(process, self.timeout_secs, &explicit_path)?;

        let candidate = if explicit_path.is_file() {
            explicit_path
        } else {
            // codex-cli 0.141 removed the built-in image-generation tool from
            // `codex exec` (the model answers IMAGE_DONE without any image),
            // so a clean exit with no payload means no image will ever come.
            newest_codex_image().ok_or_else(|| {
                "codex finished without producing an image - the installed codex CLI (0.141+) exposes no image-generation tool in exec mode. For real covers set MXTP_MKR_IMAGEGEN=cloudflare with CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the app's environment (export them before running `pnpm tauri dev`)."
                    .to_string()
            })?
        };
        ensure_min_cover_size(&candidate, 1536)?;
        Ok(candidate)
    }
}

pub struct CloudflareFluxAdapter {
    pub output_dir: PathBuf,
    pub account_id: String,
    pub api_token: String,
}

impl ImageGenAdapter for CloudflareFluxAdapter {
    fn generate_cover(&self, prompt: &str, _style_refs: &[String]) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.output_dir).map_err(|err| err.to_string())?;
        let url = format!(
            "{}/accounts/{}/ai/run/@cf/black-forest-labs/flux-1-schnell",
            service_base_url(
                "MXTP_MKR_CLOUDFLARE_BASE_URL",
                "https://api.cloudflare.com/client/v4"
            ),
            self.account_id,
        );
        let client = http_client()?;
        let prompt = fit_cloudflare_prompt(prompt);
        let response = client
            .post(url)
            .bearer_auth(&self.api_token)
            .json(&serde_json::json!({ "prompt": prompt, "steps": 4 }))
            .send()
            .map_err(|err| err.to_string())?;
        let status = response.status();
        let bytes = response.bytes().map_err(|err| err.to_string())?;
        if !status.is_success() {
            let detail = cloudflare_error_detail(&bytes);
            return Err(if detail.is_empty() {
                format!("Cloudflare Flux failed: {status}")
            } else {
                format!("Cloudflare Flux failed: {status} - {detail}")
            });
        }
        let image_bytes = cloudflare_image_bytes(&bytes)?;
        let image = image::load_from_memory(&image_bytes)
            .map_err(|err| format!("Cloudflare Flux returned invalid image data: {err}"))?;
        let path = unique_cover_path(&self.output_dir, "cloudflare-cover", "png");
        image.save(&path).map_err(|err| err.to_string())?;
        ensure_min_cover_size(&path, 1536)?;
        Ok(path)
    }
}

fn fit_cloudflare_prompt(prompt: &str) -> String {
    let prompt_len = prompt.chars().count();
    if prompt_len <= CLOUDFLARE_FLUX_PROMPT_LIMIT {
        return prompt.to_string();
    }

    let marker = ". [middle detail compacted for Cloudflare's prompt limit]. ";
    let marker_len = marker.chars().count();
    let tail_len = CLOUDFLARE_PROMPT_TAIL_CHARS.min(
        CLOUDFLARE_FLUX_PROMPT_LIMIT
            .saturating_sub(marker_len)
            .saturating_div(2),
    );
    let head_len = CLOUDFLARE_FLUX_PROMPT_LIMIT - marker_len - tail_len;
    let head = prompt.chars().take(head_len).collect::<String>();
    let tail = prompt
        .chars()
        .skip(prompt_len - tail_len)
        .collect::<String>();
    format!("{}{marker}{}", head.trim_end(), tail.trim_start())
}

fn cloudflare_error_detail(body: &[u8]) -> String {
    let raw = String::from_utf8_lossy(body).trim().to_string();
    let detail = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|payload| {
            payload
                .get("errors")
                .and_then(Value::as_array)
                .map(|errors| {
                    errors
                        .iter()
                        .filter_map(|error| error.get("message").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("; ")
                })
        })
        .filter(|message| !message.is_empty())
        .unwrap_or(raw);
    detail.chars().take(500).collect()
}

fn cloudflare_image_bytes(body: &[u8]) -> Result<Vec<u8>, String> {
    if image::load_from_memory(body).is_ok() {
        return Ok(body.to_vec());
    }

    let payload: Value = serde_json::from_slice(body)
        .map_err(|_| "Cloudflare Flux returned neither image data nor JSON".to_string())?;
    let encoded = payload
        .pointer("/result/image")
        .or_else(|| payload.get("result"))
        .or_else(|| payload.get("image"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Cloudflare Flux response did not contain an image".to_string())?;
    let encoded = encoded
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(encoded);
    general_purpose::STANDARD
        .decode(encoded)
        .map_err(|err| format!("Cloudflare Flux returned invalid base64 image data: {err}"))
}

fn cloudflare_edit_image_bytes(body: &[u8]) -> Result<Vec<u8>, String> {
    let payload: Value = serde_json::from_slice(body)
        .map_err(|_| "Cloudflare cover edit returned neither image data nor JSON".to_string())?;
    let image = payload
        .pointer("/result/image")
        .or_else(|| payload.get("image"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Cloudflare cover edit response did not contain an image".to_string())?;

    if image.starts_with("https://") || image.starts_with("http://") {
        let output_url = cloudflare_edit_output_url(image)?;
        return http_client_without_redirect(Duration::from_secs(imagegen_timeout_secs()))?
            .get(output_url)
            .send()
            .map_err(|err| err.to_string())?
            .error_for_status()
            .map_err(|err| err.to_string())?
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|err| err.to_string());
    }

    cloudflare_image_bytes(body)
}

fn cloudflare_edit_output_url(image: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(image)
        .map_err(|_| "Cloudflare cover edit returned an invalid image URL".to_string())?;
    let allow_insecure =
        std::env::var("MXTP_MKR_CLOUDFLARE_EDIT_ALLOW_INSECURE_OUTPUT").as_deref() == Ok("1");
    if url.scheme() != "https" && !(allow_insecure && url.scheme() == "http") {
        return Err("Cloudflare cover edit returned a non-HTTPS image URL".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Cloudflare cover edit image URL had no host".to_string())?;
    if !allow_insecure && (host.eq_ignore_ascii_case("localhost") || host.ends_with(".local")) {
        return Err("Cloudflare cover edit returned an unsafe image host".to_string());
    }
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        if private_network_address(address) && !allow_insecure {
            return Err("Cloudflare cover edit returned an unsafe image host".to_string());
        }
    }
    if !allow_insecure {
        let mut addresses = (host, 443)
            .to_socket_addrs()
            .map_err(|_| "Cloudflare cover edit image host could not be resolved".to_string())?;
        if addresses.any(|address| private_network_address(address.ip())) {
            return Err("Cloudflare cover edit returned an unsafe image host".to_string());
        }
    }
    Ok(url)
}

fn private_network_address(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_broadcast()
        }
        std::net::IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unicast_link_local()
                || address.is_unique_local()
                || address.is_unspecified()
        }
    }
}

/// Keyless real-image backend: Pollinations' public image endpoint. No account or
/// API key — the prompt is a URL path segment, size/model are query params. This
/// is the app's zero-setup default now that codex-cli 0.141 dropped exec image
/// generation; Cloudflare still takes over automatically when its creds are set.
pub struct PollinationsAdapter {
    pub output_dir: PathBuf,
    pub timeout_secs: u64,
    pub model: String,
}

impl ImageGenAdapter for PollinationsAdapter {
    fn generate_cover(&self, prompt: &str, style_refs: &[String]) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.output_dir).map_err(|err| err.to_string())?;
        let references = style_refs
            .iter()
            .filter_map(|reference| secure_remote_reference(reference))
            .take(3)
            .collect::<Vec<_>>();
        let mut url = format!(
            "{}/prompt/{}?width=1024&height=1024&model={}&nologo=true&seed={}",
            service_base_url(
                "MXTP_MKR_POLLINATIONS_BASE_URL",
                "https://image.pollinations.ai"
            ),
            urlencoding::encode(prompt),
            urlencoding::encode(&self.model),
            generation_seed()
        );
        if !references.is_empty() {
            url.push_str("&image=");
            url.push_str(&urlencoding::encode(&references.join("|")));
        }
        let client = http_client_with_timeout(Duration::from_secs(self.timeout_secs))?;
        // Pollinations' legacy endpoint intermittently 500s ("Queue full") and recovers on retry;
        // without this a transient blip surfaces as a hard cover-generation failure.
        let mut decoded = None;
        let mut last_err = String::from("no attempt made");
        for attempt in 0..3 {
            if attempt > 0 {
                thread::sleep(env_duration_ms(
                    "MXTP_MKR_POLLINATIONS_RETRY_DELAY_MS",
                    if attempt == 1 { 2_000 } else { 5_000 },
                ));
            }
            match client.get(url.as_str()).send() {
                Ok(response) if response.status().is_success() => match response.bytes() {
                    // Normalize to PNG so the preview data-URI + palette match the rest of the pipeline.
                    Ok(bytes) => match image::load_from_memory(&bytes) {
                        Ok(image) => {
                            decoded = Some(crop_generated_artwork(image));
                            break;
                        }
                        Err(err) => last_err = format!("undecodable image: {err}"),
                    },
                    Err(err) => last_err = err.to_string(),
                },
                Ok(response) => last_err = format!("HTTP {}", response.status()),
                Err(err) => last_err = err.to_string(),
            }
        }
        let image = decoded.ok_or_else(|| {
            format!("Pollinations image generation failed after 3 tries: {last_err}")
        })?;
        let path = unique_cover_path(
            &self.output_dir,
            &format!("pollinations-{}-cover", slug(&self.model)),
            "png",
        );
        image.save(&path).map_err(|err| err.to_string())?;
        ensure_min_cover_size(&path, 1536)?;
        Ok(path)
    }
}

pub fn lookup_album(artist: &str, album: &str) -> Result<AlbumInfo, String> {
    let cache = cache_path("album", &cache_key(&format!("{artist}-{album}")));
    match lookup_album_online(artist, album) {
        Ok(info) => {
            write_cache(&cache, &info)?;
            Ok(info)
        }
        Err(err) => read_cache(&cache).map_err(|_| err),
    }
}

pub fn fetch_lyrics(artist: &str, title: &str) -> Result<String, String> {
    fetch_lyrics_with_source(artist, title).map(|result| result.text)
}

pub fn fetch_lyrics_with_source(artist: &str, title: &str) -> Result<LyricsFetch, String> {
    let cache = cache_path("lyrics", &cache_key(&format!("{artist}-{title}")));
    match fetch_lyrics_online(artist, title) {
        Ok(result) if !result.text.trim().is_empty() => {
            fs::create_dir_all(cache.parent().unwrap()).map_err(|err| err.to_string())?;
            fs::write(&cache, &result.text).map_err(|err| err.to_string())?;
            Ok(result)
        }
        Ok(_) => Err("lyrics response was empty".to_string()),
        Err(err) => fs::read_to_string(&cache)
            .map(|text| LyricsFetch {
                text,
                source_url: format!("cache:{}", cache.display()),
            })
            .map_err(|_| err),
    }
}

/// Learn an album's aesthetic from its real cover art: download the first
/// Cover Art Archive URL that downloads and decodes, extract the dominant palette by color
/// quantization, and return the artwork as an inline preview. Cached per first URL.
pub fn fetch_cover_theme(cover_art_urls: &[String]) -> Result<CoverTheme, String> {
    let urls = approved_album_cover_urls(cover_art_urls)?;
    let cache = cache_path("cover-theme-v2", urls[0].as_str());
    if let Ok(theme) = read_cache::<CoverTheme>(&cache) {
        return Ok(theme);
    }

    let client = http_client_without_redirect(Duration::from_secs(20))?;
    let (url, image) = first_decodable_cover(&client, urls)?;

    // Preview: bounded thumbnail as an inline data URI.
    let preview = image.thumbnail(512, 512);
    let mut png = Vec::new();
    preview
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| err.to_string())?;
    let preview_url = format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(&png)
    );

    let (palette, luminance) = dominant_palette(&image.thumbnail(64, 64).to_rgb8());

    let theme = CoverTheme {
        source_url: url.to_string(),
        preview_url,
        palette,
        luminance,
    };
    write_cache(&cache, &theme)?;
    Ok(theme)
}

/// Download the REAL album cover (first Cover Art Archive URL that downloads and decodes) as a
/// full-res local PNG so it can be applied to the front slot in one click and feed print/PDF.
/// The original upload comes first; an over-cap or undecodable original falls through to the
/// same image's thumbnails. Cached per first URL.
pub fn fetch_real_cover_file(cover_art_urls: &[String]) -> Result<RealCover, String> {
    let urls = approved_album_cover_urls(cover_art_urls)?;
    let first = urls[0].clone();
    let cache = cache_path("real-cover", first.as_str());
    if let Ok(cover) = read_cache::<RealCover>(&cache) {
        if Path::new(&cover.image_path).is_file() {
            return Ok(cover);
        }
    }
    let client = http_client_without_redirect(Duration::from_secs(30))?;
    let (_, image) = first_decodable_cover(&client, urls)?;
    let dir = env_path(
        "MXTP_MKR_COVER_OUTPUT_DIR",
        std::env::temp_dir().join("mxtp_mkr_covers"),
    );
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join(format!("{}.png", slug(first.as_str())));
    image.save(&path).map_err(|err| err.to_string())?;
    ensure_min_cover_size(&path, 1536)?;
    let cover = RealCover {
        image_path: path.to_string_lossy().to_string(),
        preview_url: cover_preview_url(&path)?,
        palette: derive_palette(&path)?,
    };
    write_cache(&cache, &cover)?;
    Ok(cover)
}

fn approved_album_cover_urls(values: &[String]) -> Result<Vec<reqwest::Url>, String> {
    if values.is_empty() {
        return Err("album has no cover art references".to_string());
    }
    values
        .iter()
        .map(|url| approved_album_cover_url(url))
        .collect()
}

/// Try each URL in order; the first one that downloads within the size cap and decodes wins.
fn first_decodable_cover(
    client: &reqwest::blocking::Client,
    urls: Vec<reqwest::Url>,
) -> Result<(reqwest::Url, image::DynamicImage), String> {
    for url in urls {
        let Ok(bytes) = download_approved_cover(client, url.clone()) else {
            continue;
        };
        if let Ok(image) = image::load_from_memory(&bytes) {
            return Ok((url, image));
        }
    }
    Err("could not download the album cover".to_string())
}

fn approved_album_cover_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| "album cover source was not a valid URL".to_string())?;
    let allow_insecure = std::env::var("MXTP_MKR_ALLOW_INSECURE_COVER_URLS").as_deref() == Ok("1");
    let host = url
        .host_str()
        .ok_or_else(|| "album cover source had no host".to_string())?;
    let trusted_archive = host.eq_ignore_ascii_case("coverartarchive.org")
        || host.ends_with(".coverartarchive.org")
        || host.eq_ignore_ascii_case("archive.org")
        || host.ends_with(".archive.org");
    let local_test_host = allow_insecure && matches!(host, "127.0.0.1" | "localhost" | "::1");
    if url.scheme() != "https" && !(local_test_host && url.scheme() == "http") {
        return Err("album cover source must use HTTPS".to_string());
    }
    if !trusted_archive && !local_test_host {
        return Err("album cover source must come from Cover Art Archive".to_string());
    }
    Ok(url)
}

fn download_approved_cover(
    client: &reqwest::blocking::Client,
    mut url: reqwest::Url,
) -> Result<Vec<u8>, String> {
    for _ in 0..5 {
        let response = client
            .get(url.clone())
            .send()
            .map_err(|err| err.to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "album cover redirect had no location".to_string())?;
            let next = url
                .join(location)
                .map_err(|_| "album cover redirect was invalid".to_string())?;
            url = approved_album_cover_url(next.as_str())?;
            continue;
        }
        return read_bounded_cover_response(
            response.error_for_status().map_err(|err| err.to_string())?,
        );
    }
    Err("album cover redirected too many times".to_string())
}

fn read_bounded_cover_response(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_COVER_DOWNLOAD_BYTES)
    {
        return Err("album cover response exceeds the 8 MiB size limit".to_string());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_COVER_DOWNLOAD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if bytes.len() as u64 > MAX_COVER_DOWNLOAD_BYTES {
        Err("album cover response exceeds the 8 MiB size limit".to_string())
    } else {
        Ok(bytes)
    }
}

fn freellmapi_base_url() -> String {
    service_base_url("FREELLMAPI_BASE_URL", "http://127.0.0.1:3001")
}

/// The router's local settings endpoint hands out the unified key at call time. The secret-firewall
/// blocks reading .secrets / the `secret` CLI, so this HTTP path is the sanctioned one. Never log it.
fn freellmapi_api_key(client: &reqwest::blocking::Client) -> Result<String, String> {
    let url = format!("{}/api/settings/api-key", freellmapi_base_url());
    let json: Value = client
        .get(url)
        .send()
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?
        .json()
        .map_err(|err| err.to_string())?;
    json["apiKey"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "FreeLLMAPI returned no api key".to_string())
}

fn encode_image_data_uri(
    url: reqwest::Url,
    client: &reqwest::blocking::Client,
) -> Result<String, String> {
    let bytes = download_approved_cover(client, url)?;
    let image = image::load_from_memory(&bytes).map_err(|err| err.to_string())?;
    // JPEG at 384px keeps a multi-image request small — PNG data-URIs blew past the router's
    // payload cap (HTTP 413) at 512px. The model only needs a legible thumbnail to art-direct.
    let thumb = image.thumbnail(384, 384).to_rgb8();
    let mut jpg = Vec::new();
    image::DynamicImage::ImageRgb8(thumb)
        .write_to(
            &mut std::io::Cursor::new(&mut jpg),
            image::ImageFormat::Jpeg,
        )
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(&jpg)
    ))
}

/// Ask a vision model (gemini-2.5-flash via the local FreeLLMAPI router) to read the real album
/// cover + a few era-contemporary covers and write an art-direction prompt for a NEW, original
/// cover grounded in them. Any error bubbles up so the caller can fall back to a plain text prompt.
pub fn art_direct_from_references(
    album_label: &str,
    cover_art_urls: &[String],
    era_ref_urls: &[String],
) -> Result<String, String> {
    let cover_art_urls = cover_art_urls
        .iter()
        .map(|url| approved_album_cover_url(url))
        .collect::<Result<Vec<_>, _>>()?;
    let era_ref_urls = era_ref_urls
        .iter()
        .map(|url| approved_album_cover_url(url))
        .collect::<Result<Vec<_>, _>>()?;
    let client = http_client_with_timeout(Duration::from_secs(45))?;
    let key = freellmapi_api_key(&client)?;

    let instruction = format!(
        "You are an exacting album-cover art director analyzing \"{album_label}\". The FIRST image is the PRIMARY REFERENCE (80% weight); the remaining images are era context only (20% total). Do not average them together and do not replace the primary cover with genre stereotypes. Analyze typography as visual structure even though the generated base must contain no glyphs. Mark typography PRIMARY whenever repeated or large letterforms occupy more than one quarter of the cover; never minimize a type-dominant design. Return exactly these eight labeled lines, concrete and image-specific:\nPRIMARY ENERGY: emotional temperature, density, rhythm\nSUBJECT MODE: typographic, abstract, figurative, object, or landscape; describe the image system\nCOMPOSITION: symmetry, focal zones, edge behavior, depth, negative-space ratio\nCOLOR LOGIC: background, dominant and accent colors, plus their proportions and relationships\nSURFACE / MEDIUM: photographed or printed materials, mark-making, grain, registration, light\nTYPOGRAPHY ROLE: PRIMARY, STRUCTURAL, OVERLAY, or ABSENT; describe scale, placement, repetition, and bands that a textless base should preserve\nNEW MOTIF: one specific physical image-making event or object transformation that carries those invariants without copying the source; never propose a generic orb, portal, mandala, nebula, smoke cloud, or isolated liquid blob\nFORBIDDEN CLICHES: at least four tempting genre or generative-AI defaults, including framed artwork and pseudo-type, that would make this album look generic\nDo not mention the artist or album in the eight lines. Do not copy logos, letterforms, symbols, or the source layout. Output only the eight labeled lines."
    );
    let mut content = vec![serde_json::json!({ "type": "text", "text": instruction })];
    for url in cover_art_urls
        .iter()
        .take(1)
        .chain(era_ref_urls.iter().take(2))
    {
        if let Ok(data_uri) = encode_image_data_uri(url.clone(), &client) {
            content
                .push(serde_json::json!({ "type": "image_url", "image_url": { "url": data_uri } }));
        }
    }

    let body = serde_json::json!({
        // Gemini 2.5 Flash burns hidden thinking tokens before output, and more so with several
        // images to analyze — give the budget headroom so the prompt isn't truncated mid-sentence.
        "model": "gemini-2.5-flash",
        "messages": [{ "role": "user", "content": content }],
        "max_tokens": 2400,
        "temperature": 0.35
    });
    let url = format!("{}/v1/chat/completions", freellmapi_base_url());
    let response = client
        .post(url)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "art-direction request failed: HTTP {}",
            response.status()
        ));
    }
    let json: Value = response.json().map_err(|err| err.to_string())?;
    let prompt = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if prompt.is_empty() {
        return Err("art-direction returned empty content".to_string());
    }
    Ok(prompt)
}

/// Fetch 3-6 REAL contemporaneous cover-image URLs: the artist's studio albums closest to `year`,
/// for use as style references in grounded generation. Cached per (artist, year, limit).
pub fn fetch_era_covers(artist: &str, year: u16, limit: usize) -> Result<Vec<String>, String> {
    let limit = limit.clamp(3, 6);
    let cache = cache_path("era-covers", &format!("{artist}-{year}-{limit}"));
    if let Ok(urls) = read_cache::<Vec<String>>(&cache) {
        if !urls.is_empty() {
            return Ok(urls);
        }
    }
    let client = http_client()?;
    let mbid = resolve_artist_mbid(&client, artist)?;
    let mut groups = era_release_groups(&client, &mbid);
    groups.sort_by_key(|(y, _)| ((year as i32) - (*y as i32)).abs());
    let mut urls = Vec::new();
    for (_, rg_mbid) in groups {
        if urls.len() >= limit {
            break;
        }
        if let Some(url) = caa_front_cover(&client, &rg_mbid) {
            urls.push(url);
            thread::sleep(env_duration_ms("MXTP_MKR_CAA_REQUEST_DELAY_MS", 300));
        }
    }
    let _ = write_cache(&cache, &urls);
    Ok(urls)
}

fn resolve_artist_mbid(client: &reqwest::blocking::Client, artist: &str) -> Result<String, String> {
    let url = format!(
        "{}/artist?query=artist:%22{}%22&fmt=json&limit=3",
        service_base_url(
            "MXTP_MKR_MUSICBRAINZ_BASE_URL",
            "https://musicbrainz.org/ws/2"
        ),
        urlencoding::encode(artist)
    );
    let json = musicbrainz_get_json(client, &url)?;
    json["artists"][0]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("no MusicBrainz artist for {artist}"))
}

/// Browse the artist's studio-album release-groups (client-side filter: primary Album, no
/// secondary types, numeric year). MusicBrainz browse can't filter these server-side.
fn era_release_groups(client: &reqwest::blocking::Client, mbid: &str) -> Vec<(u16, String)> {
    let url = format!(
        "{}/release-group?artist={mbid}&type=album&fmt=json&limit=100",
        service_base_url(
            "MXTP_MKR_MUSICBRAINZ_BASE_URL",
            "https://musicbrainz.org/ws/2"
        )
    );
    let Ok(json) = musicbrainz_get_json(client, &url) else {
        return Vec::new();
    };
    json["release-groups"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|rg| {
            let primary = rg["primary-type"].as_str().unwrap_or_default();
            let secondary_empty = rg["secondary-types"]
                .as_array()
                .map(|arr| arr.is_empty())
                .unwrap_or(true);
            let year = rg["first-release-date"]
                .as_str()
                .and_then(|date| date.get(0..4))
                .and_then(|y| y.parse::<u16>().ok());
            match (
                primary == "Album" && secondary_empty,
                year,
                rg["id"].as_str(),
            ) {
                (true, Some(y), Some(id)) => Some((y, id.to_string())),
                _ => None,
            }
        })
        .collect()
}

/// Cover Art Archive front-cover redirect; returns the final durable archive.org image URL.
/// archive.org intermittently 500s, so retry once on failure (404 = no art, give up).
fn caa_front_cover(client: &reqwest::blocking::Client, rg_mbid: &str) -> Option<String> {
    let url = format!(
        "{}/release-group/{rg_mbid}/front-500",
        service_base_url("MXTP_MKR_CAA_BASE_URL", "https://coverartarchive.org")
    );
    for attempt in 0..2 {
        if attempt > 0 {
            thread::sleep(env_duration_ms("MXTP_MKR_CAA_RETRY_DELAY_MS", 500));
        }
        if let Ok(resp) = client.get(url.as_str()).send() {
            let status = resp.status();
            if status.is_success() {
                let is_image = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|ct| ct.starts_with("image/"))
                    .unwrap_or(false);
                if is_image {
                    return Some(resp.url().as_str().to_string());
                }
            }
            if status.as_u16() == 404 {
                return None;
            }
        }
    }
    None
}

/// Dominant palette by 4-bit/channel frequency quantization over a small
/// thumbnail: top buckets by pixel count, deduped for similarity, dominant
/// first. Also reports overall luminance (0..1).
fn dominant_palette(image: &ImageBuffer<image::Rgb<u8>, Vec<u8>>) -> (Vec<String>, f32) {
    type PaletteBucket = (u64, u64, u64, u64);
    let mut buckets: HashMap<(u8, u8, u8), PaletteBucket> = HashMap::new();
    let mut luma_total = 0.0_f64;
    let mut count = 0.0_f64;
    for pixel in image.pixels() {
        let [r, g, b] = pixel.0;
        let key = (r >> 4, g >> 4, b >> 4);
        let entry = buckets.entry(key).or_insert((0, 0, 0, 0));
        entry.0 += 1;
        entry.1 += r as u64;
        entry.2 += g as u64;
        entry.3 += b as u64;
        luma_total += (0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64) / 255.0;
        count += 1.0;
    }
    let mut ranked: Vec<(u64, (u8, u8, u8))> = buckets
        .into_values()
        .map(|(n, r, g, b)| (n, ((r / n) as u8, (g / n) as u8, (b / n) as u8)))
        .collect();
    ranked.sort_by_key(|entry| std::cmp::Reverse(entry.0));

    let mut palette: Vec<(u8, u8, u8)> = Vec::new();
    for (_, color) in ranked {
        let distinct = palette.iter().all(|existing| {
            let dr = existing.0 as i32 - color.0 as i32;
            let dg = existing.1 as i32 - color.1 as i32;
            let db = existing.2 as i32 - color.2 as i32;
            dr * dr + dg * dg + db * db > 900
        });
        if distinct {
            palette.push(color);
        }
        if palette.len() == 5 {
            break;
        }
    }
    (
        palette
            .into_iter()
            .map(|(r, g, b)| format!("#{r:02x}{g:02x}{b:02x}"))
            .collect(),
        if count > 0.0 {
            (luma_total / count) as f32
        } else {
            0.0
        },
    )
}

pub fn generate_cover(prompt: &str, style_refs: &[String]) -> Result<GeneratedCover, String> {
    let output_dir = env_path(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        std::env::temp_dir().join("mxtp_mkr_imagegen"),
    );
    // Pollinations is the quality default. Cloudflare remains available only as
    // an explicit override because its current FLUX.1 adapter is prompt-only.
    let adapter_mode =
        std::env::var("MXTP_MKR_IMAGEGEN").unwrap_or_else(|_| "pollinations".to_string());
    let mut adapter_label = adapter_mode.clone();
    let path = match adapter_mode.as_str() {
        "pollinations" => {
            let model = std::env::var("MXTP_MKR_POLLINATIONS_MODEL").unwrap_or_else(|_| {
                // Nova follows asymmetric composition and no-pseudo-text rules
                // while the vision brief supplies the real cover's visual DNA.
                "nova-canvas".to_string()
            });
            adapter_label = format!("pollinations-{model}");
            PollinationsAdapter {
                output_dir,
                timeout_secs: imagegen_timeout_secs(),
                model,
            }
            .generate_cover(prompt, style_refs)
        }
        "codex" => CodexImageGenAdapter {
            output_dir,
            timeout_secs: imagegen_timeout_secs(),
        }
        .generate_cover(prompt, style_refs),
        "cloudflare" => CloudflareFluxAdapter {
            output_dir,
            account_id: std::env::var("CLOUDFLARE_ACCOUNT_ID")
                .map_err(|_| "CLOUDFLARE_ACCOUNT_ID is required".to_string())?,
            api_token: std::env::var("CLOUDFLARE_API_TOKEN")
                .map_err(|_| "CLOUDFLARE_API_TOKEN is required".to_string())?,
        }
        .generate_cover(prompt, style_refs),
        "mock" => MockImageGenAdapter { output_dir }.generate_cover(prompt, style_refs),
        other => Err(format!(
            "unsupported MXTP_MKR_IMAGEGEN mode '{other}' (expected pollinations, codex, cloudflare, or mock)"
        )),
    }?;

    let palette = derive_palette(&path)?;

    Ok(GeneratedCover {
        image_path: path.to_string_lossy().to_string(),
        preview_url: cover_preview_url(&path)?,
        prompt: prompt.to_string(),
        palette,
        adapter: adapter_label,
    })
}

/// Edit the downloaded, real album cover instead of asking a text-only model to invent a related
/// image. The source is deliberately restricted to MXTP's managed real-cover directory so an IPC
/// caller cannot turn this into an arbitrary local-file upload.
pub fn edit_cover_from_original(
    source_image_path: &str,
    instruction: &str,
) -> Result<GeneratedCover, String> {
    let instruction = instruction.trim();
    let instruction_len = instruction.chars().count();
    if instruction_len == 0 || instruction_len > COVER_EDIT_INSTRUCTION_LIMIT {
        return Err(format!(
            "cover edit instruction must be 1-{COVER_EDIT_INSTRUCTION_LIMIT} characters"
        ));
    }

    let source = managed_real_cover_path(source_image_path)?;
    let account_id = std::env::var("CLOUDFLARE_ACCOUNT_ID").map_err(|_| {
        "Original-cover edits require CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Relaunch MXTP with your Cloudflare Workers AI credentials."
            .to_string()
    })?;
    let api_token = std::env::var("CLOUDFLARE_API_TOKEN").map_err(|_| {
        "Original-cover edits require CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Relaunch MXTP with your Cloudflare Workers AI credentials."
            .to_string()
    })?;
    let output_dir = env_path(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        std::env::temp_dir().join("mxtp_mkr_imagegen"),
    );
    fs::create_dir_all(&output_dir).map_err(|err| err.to_string())?;

    let client = http_client_with_timeout(Duration::from_secs(imagegen_timeout_secs()))?;
    let model = cloudflare_edit_model()?;
    let size = std::env::var("MXTP_MKR_CLOUDFLARE_EDIT_SIZE")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (64..=2048).contains(value))
        .unwrap_or(1536);
    let prompt = cover_edit_prompt(instruction);
    let body = serde_json::json!({
        "model": model,
        "input": {
            "prompt": prompt,
            "input_images": [cover_edit_data_uri(&source)?],
            "width": size,
            "height": size,
            "output_format": "png",
            "safety_tolerance": 2
        }
    });
    let url = format!(
        "{}/accounts/{account_id}/ai/run",
        service_base_url(
            "MXTP_MKR_CLOUDFLARE_BASE_URL",
            "https://api.cloudflare.com/client/v4"
        )
    );
    let response = client
        .post(url)
        .bearer_auth(api_token)
        .json(&body)
        .send()
        .map_err(|err| format!("Cloudflare cover edit request failed: {err}"))?;
    let status = response.status();
    let response_body = response.bytes().map_err(|err| err.to_string())?;
    if !status.is_success() {
        let detail = cloudflare_error_detail(&response_body);
        return Err(if detail.is_empty() {
            format!("Cloudflare cover edit failed: {status}")
        } else {
            format!("Cloudflare cover edit failed: {status} - {detail}")
        });
    }
    let image_bytes = cloudflare_edit_image_bytes(&response_body)?;
    let image = image::load_from_memory(&image_bytes)
        .map_err(|err| format!("Cloudflare cover edit returned invalid image data: {err}"))?;
    let path = unique_cover_path(&output_dir, "cloudflare-flux2-edit-cover", "png");
    image.save(&path).map_err(|err| err.to_string())?;
    ensure_min_cover_size(&path, 1536)?;

    Ok(GeneratedCover {
        image_path: path.to_string_lossy().to_string(),
        preview_url: cover_preview_url(&path)?,
        prompt: instruction.to_string(),
        palette: derive_palette(&path)?,
        adapter: match model.as_str() {
            "black-forest-labs/flux-2-max" => "cloudflare-flux2-max-edit",
            _ => "cloudflare-flux2-pro-preview-edit",
        }
        .to_string(),
    })
}

fn managed_real_cover_path(source_image_path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(source_image_path)
        .canonicalize()
        .map_err(|_| "original cover file is unavailable; reload the album first".to_string())?;
    let managed_dir = env_path(
        "MXTP_MKR_COVER_OUTPUT_DIR",
        std::env::temp_dir().join("mxtp_mkr_covers"),
    )
    .canonicalize()
    .map_err(|_| "original cover storage is unavailable; reload the album first".to_string())?;
    if !source.starts_with(&managed_dir) {
        return Err("original cover must come from MXTP's album lookup".to_string());
    }
    Ok(source)
}

fn cover_edit_data_uri(source: &Path) -> Result<String, String> {
    let image = image::open(source).map_err(|err| err.to_string())?;
    let image =
        if image.width() > COVER_EDIT_SOURCE_MAX_PX || image.height() > COVER_EDIT_SOURCE_MAX_PX {
            image.thumbnail(COVER_EDIT_SOURCE_MAX_PX, COVER_EDIT_SOURCE_MAX_PX)
        } else {
            image
        };
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 92)
        .encode_image(&image)
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(jpeg)
    ))
}

fn cloudflare_edit_model() -> Result<String, String> {
    let model = std::env::var("MXTP_MKR_CLOUDFLARE_EDIT_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| CLOUDFLARE_EDIT_DEFAULT_MODEL.to_string());
    match model.as_str() {
        "black-forest-labs/flux-2-pro-preview" | "black-forest-labs/flux-2-max" => Ok(model),
        _ => Err(
            "MXTP_MKR_CLOUDFLARE_EDIT_MODEL must be black-forest-labs/flux-2-pro-preview or black-forest-labs/flux-2-max"
                .to_string(),
        ),
    }
}

fn cover_edit_prompt(instruction: &str) -> String {
    format!(
        "Edit image 0 into a revised version of the same album cover. Preserve its recognizable subject, composition, crop, color relationships, and existing text placement unless the request explicitly changes them. Apply only this change: {instruction}. Keep the result as edge-to-edge square artwork. Do not make a mockup, border, watermark, unrelated subject, or newly invented readable text."
    )
}

fn secure_remote_reference(reference: &str) -> Option<String> {
    if let Some(rest) = reference.strip_prefix("http://") {
        Some(format!("https://{rest}"))
    } else if reference.starts_with("https://") {
        Some(reference.to_string())
    } else {
        None
    }
}

fn unique_cover_path(output_dir: &Path, prefix: &str, extension: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = COVER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    output_dir.join(format!("{prefix}-{millis}-{sequence}.{extension}"))
}

fn generation_seed() -> u32 {
    (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        % 2_147_483_647) as u32
}

fn crop_generated_artwork(image: image::DynamicImage) -> image::DynamicImage {
    let shortest = image.width().min(image.height());
    if shortest < 512 {
        return image;
    }
    let inset = ((shortest as f32) * 0.08).round() as u32;
    image.crop_imm(
        inset,
        inset,
        image.width().saturating_sub(inset * 2),
        image.height().saturating_sub(inset * 2),
    )
}

pub fn codex_child_env(parent: &HashMap<String, String>) -> HashMap<String, String> {
    parent
        .iter()
        .filter(|(key, _)| key.as_str() != "OPENAI_API_KEY")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn lookup_album_online(artist: &str, album: &str) -> Result<AlbumInfo, String> {
    let client = http_client()?;
    let query = format!(
        "artist:\"{}\" AND release:\"{}\"",
        lucene_phrase(artist),
        lucene_phrase(album)
    );
    let url = format!(
        "{}/release?query={}&fmt=json&limit=10",
        service_base_url(
            "MXTP_MKR_MUSICBRAINZ_BASE_URL",
            "https://musicbrainz.org/ws/2"
        ),
        urlencoding::encode(&query)
    );
    let search = musicbrainz_get_json(&client, &url)?;
    let search_release = search["releases"]
        .as_array()
        .and_then(|releases| {
            releases.iter().find_map(|release| {
                let title = release["title"].as_str().unwrap_or_default();
                let score = release["score"].as_u64().unwrap_or_default();
                if title.eq_ignore_ascii_case(album) || score >= 80 {
                    Some(release.clone())
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| format!("MusicBrainz returned no release for {artist} - {album}"))?;
    let release_id = search_release["id"]
        .as_str()
        .ok_or_else(|| "MusicBrainz release had no id".to_string())?
        .to_string();

    let detail_url = format!(
        "{}/release/{release_id}?inc=recordings+labels+genres+tags&fmt=json",
        service_base_url(
            "MXTP_MKR_MUSICBRAINZ_BASE_URL",
            "https://musicbrainz.org/ws/2"
        )
    );
    let detail = musicbrainz_get_json(&client, &detail_url)?;

    let tracks = detail["media"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .flat_map(|medium| medium["tracks"].as_array().cloned().unwrap_or_default())
        .filter_map(|track| track["title"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    if tracks.is_empty() {
        return Err("MusicBrainz release had no tracks".to_string());
    }

    let year = detail["date"]
        .as_str()
        .and_then(|date| date.get(0..4))
        .and_then(|year| year.parse::<u16>().ok())
        .unwrap_or_default();
    let label = detail["label-info"]
        .as_array()
        .and_then(|labels| labels.first())
        .and_then(|label| label["label"]["name"].as_str())
        .unwrap_or("Unknown")
        .to_string();
    let cover_art_urls = cover_art_urls(&client, &release_id).unwrap_or_default();
    let tags = collect_album_tags(&search_release, &detail);

    Ok(AlbumInfo {
        artist: artist.to_string(),
        album: detail["title"].as_str().unwrap_or(album).to_string(),
        year,
        label,
        tracks,
        cover_art_urls,
        tags,
    })
}

fn cover_art_urls(
    client: &reqwest::blocking::Client,
    release_id: &str,
) -> Result<Vec<String>, String> {
    let url = format!(
        "{}/release/{release_id}",
        service_base_url("MXTP_MKR_CAA_BASE_URL", "https://coverartarchive.org")
    );
    let response = client.get(url).send().map_err(|err| err.to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    let json: Value = response
        .error_for_status()
        .map_err(|err| err.to_string())?
        .json()
        .map_err(|err| err.to_string())?;
    Ok(front_cover_urls(&json))
}

/// Front covers only (never a back, booklet or disc scan). Each front image lists its original
/// upload first (full print resolution), then the 1200 px and "large" thumbnails as fallbacks
/// for an original that is over the download cap or not a decodable image. Deduplicated.
fn front_cover_urls(listing: &Value) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for image in listing["images"].as_array().into_iter().flatten() {
        let is_front = image["front"].as_bool() == Some(true)
            || image["types"]
                .as_array()
                .is_some_and(|types| types.iter().any(|kind| kind.as_str() == Some("Front")));
        if !is_front {
            continue;
        }
        let thumbnails = &image["thumbnails"];
        for url in [
            image["image"].as_str(),
            thumbnails["1200"].as_str(),
            thumbnails["large"].as_str(),
        ]
        .into_iter()
        .flatten()
        {
            if !urls.iter().any(|seen| seen == url) {
                urls.push(url.to_string());
            }
        }
    }
    urls
}

/// A value safe inside a quoted Lucene phrase: backslashes and quotes escaped.
fn lucene_phrase(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn musicbrainz_get_json(client: &reqwest::blocking::Client, url: &str) -> Result<Value, String> {
    let mut last_error = "no attempt made".to_string();
    for attempt in 0..3 {
        if attempt > 0 {
            thread::sleep(env_duration_ms(
                "MXTP_MKR_MUSICBRAINZ_RETRY_DELAY_MS",
                1_000 * attempt,
            ));
        }
        throttle_musicbrainz();
        match client.get(url).send() {
            Ok(response) if response.status().is_success() => {
                return response.json().map_err(|err| err.to_string());
            }
            Ok(response)
                if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || response.status().is_server_error() =>
            {
                last_error = format!("HTTP {}", response.status());
            }
            Ok(response) => {
                return Err(response
                    .error_for_status()
                    .expect_err("non-success response must return an HTTP error")
                    .to_string());
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!(
        "MusicBrainz request failed after 3 tries: {last_error}"
    ))
}

fn throttle_musicbrainz() {
    static LAST_REQUEST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let lock = LAST_REQUEST.get_or_init(|| Mutex::new(None));
    let mut last_request = lock.lock().expect("MusicBrainz rate-limit mutex poisoned");
    if let Some(last) = *last_request {
        let elapsed = last.elapsed();
        let minimum_gap = env_duration_ms("MXTP_MKR_MUSICBRAINZ_THROTTLE_MS", 1_100);
        if elapsed < minimum_gap {
            thread::sleep(minimum_gap - elapsed);
        }
    }
    *last_request = Some(Instant::now());
}

fn collect_album_tags(search_release: &Value, detail: &Value) -> Vec<String> {
    let mut scores: HashMap<String, i64> = HashMap::new();
    add_tag_scores(&mut scores, &search_release["genres"], 10);
    add_tag_scores(&mut scores, &search_release["tags"], 8);
    add_tag_scores(&mut scores, &detail["genres"], 10);
    add_tag_scores(&mut scores, &detail["tags"], 8);

    if let Some(media) = detail["media"].as_array() {
        for medium in media {
            if let Some(tracks) = medium["tracks"].as_array() {
                for track in tracks {
                    let recording = &track["recording"];
                    add_tag_scores(&mut scores, &recording["genres"], 2);
                    add_tag_scores(&mut scores, &recording["tags"], 1);
                }
            }
        }
    }

    let mut ranked = scores.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|(left_name, left_score), (right_name, right_score)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_name.cmp(right_name))
    });
    ranked.into_iter().map(|(name, _)| name).take(16).collect()
}

fn add_tag_scores(scores: &mut HashMap<String, i64>, tags: &Value, weight: i64) {
    if let Some(items) = tags.as_array() {
        for item in items {
            if let Some(name) = item["name"].as_str().and_then(normalize_tag) {
                let count = item["count"].as_i64().unwrap_or(1).max(1);
                *scores.entry(name).or_default() += count * weight;
            }
        }
    }
}

fn normalize_tag(name: &str) -> Option<String> {
    let normalized = name.trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn fetch_lyrics_online(artist: &str, title: &str) -> Result<LyricsFetch, String> {
    // Lyrics are fetched per track: a slow/dead source must fail fast or a
    // 14-track album turns 6 fallback misses into minutes of silent wait.
    let client = http_client_with_timeout(Duration::from_secs(8))?;
    let genius_url = format!("https://genius.com/{}-{}-lyrics", slug(artist), slug(title));
    if let Ok(response) = client.get(&genius_url).send() {
        if response.status().is_success() {
            let html = response.text().map_err(|err| err.to_string())?;
            let text = extract_genius_lyrics(&html);
            if !text.trim().is_empty() {
                return Ok(LyricsFetch {
                    text,
                    source_url: genius_url,
                });
            }
        }
    }

    let fallback_url = format!(
        "https://api.lyrics.ovh/v1/{}/{}",
        urlencoding::encode(artist),
        urlencoding::encode(title)
    );
    let json: Value = client
        .get(&fallback_url)
        .send()
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?
        .json()
        .map_err(|err| err.to_string())?;
    json["lyrics"]
        .as_str()
        .map(|text| LyricsFetch {
            text: text.to_string(),
            source_url: fallback_url,
        })
        .filter(|result| !result.text.trim().is_empty())
        .ok_or_else(|| "lyrics API returned no lyrics".to_string())
}

fn extract_genius_lyrics(html: &str) -> String {
    let container =
        Regex::new(r#"(?s)<div[^>]+data-lyrics-container="true"[^>]*>"#).expect("valid regex");
    let div_tag = Regex::new(r#"(?s)<(/?)div\b[^>]*>"#).expect("valid regex");
    let tag = Regex::new(r"(?s)<[^>]+>").expect("valid regex");
    let mut chunks = Vec::new();
    let mut search_start = 0;

    while let Some(container_match) = container.find_at(html, search_start) {
        let inner_start = container_match.end();
        let mut depth = 1;
        let mut div_search_start = inner_start;
        let mut inner_end = None;

        while let Some(div_match) = div_tag.find_at(html, div_search_start) {
            let div_text = &html[div_match.start()..div_match.end()];
            if div_text.starts_with("</") {
                depth -= 1;
                if depth == 0 {
                    inner_end = Some(div_match.start());
                    search_start = div_match.end();
                    break;
                }
            } else {
                depth += 1;
            }
            div_search_start = div_match.end();
        }

        if let Some(inner_end) = inner_end {
            let segment = strip_genius_chrome(&html[inner_start..inner_end]);
            let mut text = segment.replace("<br/>", "\n").replace("<br>", "\n");
            text = tag.replace_all(&text, "").to_string();
            text = text
                .replace("&amp;", "&")
                .replace("&#x27;", "'")
                .replace("&quot;", "\"");
            chunks.push(text);
        } else {
            search_start = inner_start;
        }
    }

    chunks.join("\n").trim().to_string()
}

/// Genius nests non-lyric chrome inside the lyrics containers: a header block
/// (contributor count, translations dropdown, song title, bio "Read More")
/// marked data-exclude-from-selection="true", plus injected recommendation
/// asides ("You might also like"). Remove those whole elements before the
/// generic tag-strip, or their inner text leaks into the extracted lyrics.
fn strip_genius_chrome(segment: &str) -> String {
    let aside = Regex::new(r"(?s)<aside\b.*?</aside>").expect("valid regex");
    let excluded = Regex::new(r#"(?s)<div[^>]+data-exclude-from-selection="true"[^>]*>"#)
        .expect("valid regex");
    let div_tag = Regex::new(r#"(?s)<(/?)div\b[^>]*>"#).expect("valid regex");
    let mut result = aside.replace_all(segment, "").to_string();

    while let Some(open) = excluded.find(&result) {
        let mut depth = 1;
        let mut div_search_start = open.end();
        // Fail-safe: with no balanced close, drop to the end of the segment
        // rather than let the chrome text through.
        let mut remove_end = result.len();

        while let Some(div_match) = div_tag.find_at(&result, div_search_start) {
            let div_text = &result[div_match.start()..div_match.end()];
            if div_text.starts_with("</") {
                depth -= 1;
                if depth == 0 {
                    remove_end = div_match.end();
                    break;
                }
            } else {
                depth += 1;
            }
            div_search_start = div_match.end();
        }

        result.replace_range(open.start()..remove_end, "");
    }

    result
}

fn write_mock_cover_png(path: &Path, prompt: &str) -> Result<(), String> {
    // Seeded abstract composition (dark field + three soft translucent orbs in a
    // restrained palette) - a placeholder that reads as deliberate album art
    // rather than RGB noise. Deterministic per prompt.
    const SIZE: u32 = 1536;
    let mut image = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(SIZE, SIZE);
    let seed = prompt.bytes().fold(0_u32, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u32)
    });
    const PALETTES: [[(f32, f32, f32); 3]; 6] = [
        [
            (121.0, 183.0, 192.0),
            (214.0, 130.0, 170.0),
            (240.0, 235.0, 222.0),
        ],
        [
            (127.0, 210.0, 168.0),
            (122.0, 162.0, 230.0),
            (244.0, 241.0, 234.0),
        ],
        [
            (243.0, 137.0, 127.0),
            (240.0, 200.0, 130.0),
            (121.0, 183.0, 192.0),
        ],
        [
            (150.0, 130.0, 220.0),
            (121.0, 183.0, 192.0),
            (240.0, 235.0, 222.0),
        ],
        [
            (230.0, 180.0, 120.0),
            (140.0, 120.0, 110.0),
            (244.0, 241.0, 234.0),
        ],
        [
            (120.0, 200.0, 210.0),
            (90.0, 120.0, 190.0),
            (214.0, 130.0, 170.0),
        ],
    ];
    // Honor the learned album theme when the prompt carries it: hex colors in
    // the prompt (from fetch_cover_theme) replace the seeded fallback palette,
    // so even the placeholder matches the album's real artwork.
    let learned = hex_colors_in(prompt);
    let palette: [(f32, f32, f32); 3] = if learned.len() >= 2 {
        [
            learned[learned.len().saturating_sub(2).min(1)],
            learned[0],
            *learned.last().unwrap(),
        ]
    } else {
        PALETTES[(seed % PALETTES.len() as u32) as usize]
    };
    let orb = |salt: u32| {
        let h = seed
            .wrapping_mul(2_654_435_761)
            .wrapping_add(salt.wrapping_mul(40_503));
        let cx = 200.0 + (h % 1_136) as f32;
        let cy = 200.0 + ((h >> 11) % 1_136) as f32;
        let radius = 380.0 + ((h >> 22) % 420) as f32;
        (cx, cy, radius)
    };
    let orbs: Vec<(f32, f32, f32)> = (0..3).map(orb).collect();
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        // subtle vertical gradient on a near-black field
        let base = 12.0 + 10.0 * (y as f32 / SIZE as f32);
        let (mut r, mut g, mut b) = (base, base + 1.0, base + 4.0);
        for (index, (cx, cy, radius)) in orbs.iter().enumerate() {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < *radius {
                let t = 1.0 - dist / radius;
                let glow = t * t * 0.82;
                let (pr, pg, pb) = palette[index];
                r += pr * glow;
                g += pg * glow;
                b += pb * glow;
            }
        }
        *pixel = Rgba([
            r.min(255.0) as u8,
            g.min(255.0) as u8,
            b.min(255.0) as u8,
            255,
        ]);
    }
    image.save(path).map_err(|err| err.to_string())
}

fn hex_colors_in(prompt: &str) -> Vec<(f32, f32, f32)> {
    Regex::new(r"#([0-9a-fA-F]{6})")
        .expect("valid regex")
        .captures_iter(prompt)
        .filter_map(|caps| {
            let hex = caps.get(1)?.as_str();
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            Some((r as f32, g as f32, b as f32))
        })
        .take(5)
        .collect()
}

fn ensure_min_cover_size(path: &Path, minimum_px: u32) -> Result<(), String> {
    let image = image::open(path).map_err(|err| err.to_string())?;
    if image.width() >= minimum_px && image.height() >= minimum_px {
        return Ok(());
    }
    let width = image.width().max(minimum_px);
    let height = image.height().max(minimum_px);
    let upscaled = image.resize(width, height, image::imageops::FilterType::Lanczos3);
    upscaled.save(path).map_err(|err| err.to_string())
}

fn imagegen_timeout_secs() -> u64 {
    std::env::var("MXTP_MKR_IMAGEGEN_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(240)
}

fn codex_command(cwd: &Path, _timeout_secs: u64) -> Result<Command, String> {
    let executable = if cfg!(windows) { "codex.cmd" } else { "codex" };
    let mut command = Command::new(executable);
    let child_env = codex_child_env(&std::env::vars().collect());
    command
        .current_dir(cwd)
        .arg("exec")
        .arg("--skip-git-repo-check")
        .arg("--dangerously-bypass-approvals-and-sandbox")
        .arg("--sandbox")
        .arg("danger-full-access")
        .arg("--json")
        .arg("-");
    command.env_clear();
    for (key, value) in child_env {
        command.env(key, value);
    }
    command.env_remove("OPENAI_API_KEY");
    Ok(command)
}

fn codex_image_prompt(prompt: &str, style_refs: &[String], output_path: &Path) -> String {
    format!(
        "Call the built-in image generation tool exactly once to create one square album cover PNG at least 1536x1536 pixels. Do not run shell commands, do not inspect files, and do not edit source files. The parent process will save the returned image payload to: {}\nPrompt: {}\nStyle refs: {}\nFinal response after the image tool returns: IMAGE_DONE.",
        output_path.display(),
        prompt,
        style_refs.join(", ")
    )
}

fn newest_codex_image() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let pattern = PathBuf::from(home)
        .join(".codex")
        .join("generated_images")
        .join("**")
        .join("ig_*.png")
        .to_string_lossy()
        .to_string();
    glob(&pattern)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .and_then(|(modified, path)| {
            if SystemTime::now()
                .duration_since(modified)
                .unwrap_or(Duration::from_secs(u64::MAX))
                <= Duration::from_secs(120)
            {
                Some(path)
            } else {
                None
            }
        })
}

fn wait_for_codex_image(
    mut child: Child,
    timeout_secs: u64,
    explicit_path: &Path,
) -> Result<(), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open codex stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open codex stderr".to_string())?;
    let output_path = explicit_path.to_path_buf();
    let (image_tx, image_rx) = mpsc::channel();
    let stdout_handle = thread::spawn(move || {
        let mut output = String::new();
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if !output.is_empty() {
                        output.push('\n');
                    }
                    output.push_str(&line);
                    if decode_codex_image_json_line(&line, &output_path).unwrap_or(false) {
                        let _ = image_tx.send(());
                    }
                }
                Err(err) => {
                    if !output.is_empty() {
                        output.push('\n');
                    }
                    output.push_str(&format!("failed to read codex stdout: {err}"));
                    break;
                }
            }
        }
        output
    });
    let stderr_handle = thread::spawn(move || {
        let mut output = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut output);
        output
    });
    let timeout = Duration::from_secs(timeout_secs.max(1));
    let started = Instant::now();
    loop {
        if explicit_path.is_file() || image_rx.try_recv().is_ok() {
            kill_child_process_tree(&mut child);
            let _ = child.wait();
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            return Ok(());
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("codex image generation failed: {err}"))?
        {
            let stdout = stdout_handle
                .join()
                .unwrap_or_else(|_| "failed to join codex stdout reader".to_string());
            let stderr = stderr_handle
                .join()
                .unwrap_or_else(|_| "failed to join codex stderr reader".to_string());
            if explicit_path.is_file() || decode_codex_image_json(&stdout, explicit_path)? {
                return Ok(());
            }
            if status.success() {
                return Ok(());
            }
            return Err(format!(
                "codex image generation exited {status}: {stderr}{stdout}"
            ));
        }

        if started.elapsed() >= timeout {
            kill_child_process_tree(&mut child);
            let _ = child.wait();
            let stdout = stdout_handle
                .join()
                .unwrap_or_else(|_| "failed to join codex stdout reader".to_string());
            let stderr = stderr_handle
                .join()
                .unwrap_or_else(|_| "failed to join codex stderr reader".to_string());
            if explicit_path.is_file() || decode_codex_image_json(&stdout, explicit_path)? {
                return Ok(());
            }
            return Err(format!(
                "codex image generation timed out after {}s: {stderr}{stdout}",
                timeout.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn decode_codex_image_json(stdout: &str, output_path: &Path) -> Result<bool, String> {
    for line in stdout.lines() {
        if decode_codex_image_json_line(line, output_path)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn decode_codex_image_json_line(line: &str, output_path: &Path) -> Result<bool, String> {
    let json = match serde_json::from_str::<Value>(line) {
        Ok(json) => json,
        Err(_) => return Ok(false),
    };
    if let Some(result) = codex_image_result(&json) {
        write_base64_png(result, output_path)?;
        return Ok(true);
    }
    Ok(false)
}

fn codex_image_result(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    let value_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(value_type, "image_generation_call" | "image_generation_end") {
        if let Some(result) = object.get("result").and_then(Value::as_str) {
            return Some(result);
        }
    }
    for key in ["payload", "item", "message"] {
        if let Some(result) = object.get(key).and_then(codex_image_result) {
            return Some(result);
        }
    }
    None
}

fn recover_recent_codex_session_image(
    prompt: &str,
    output_path: &Path,
    max_age: Duration,
) -> Result<bool, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "USERPROFILE/HOME is required for Codex session recovery".to_string())?;
    let pattern = PathBuf::from(home)
        .join(".codex")
        .join("sessions")
        .join("**")
        .join("*.jsonl")
        .to_string_lossy()
        .to_string();
    let prompt_marker = prompt_marker(prompt);
    let mut candidates = glob(&pattern)
        .map_err(|err| err.to_string())?
        .filter_map(Result::ok)
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .filter(|(modified, _)| {
            SystemTime::now()
                .duration_since(*modified)
                .unwrap_or(Duration::from_secs(u64::MAX))
                <= max_age
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(modified, _)| *modified);

    for (_, path) in candidates.into_iter().rev() {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        if !prompt_marker.is_empty() && !text.contains(&prompt_marker) {
            continue;
        }
        for line in text.lines().rev() {
            if line.contains("\"result\"") && decode_codex_image_json_line(line, output_path)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn prompt_marker(prompt: &str) -> String {
    prompt
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
}

fn write_base64_png(result: &str, output_path: &Path) -> Result<(), String> {
    let encoded = result
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(result)
        .trim();
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|err| format!("failed to decode codex image payload: {err}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("codex image payload was not a PNG".to_string());
    }
    fs::write(output_path, bytes).map_err(|err| err.to_string())
}

/// A small inline preview: at most 512 px on the long side, so a full-size
/// cover never travels to the webview (and into project JSON) as base64.
fn cover_preview_url(path: &Path) -> Result<String, String> {
    let image = image::open(path).map_err(|err| err.to_string())?;
    let preview = if image.width() > 512 || image.height() > 512 {
        image.thumbnail(512, 512)
    } else {
        image
    };
    let mut png = Vec::new();
    preview
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(png)
    ))
}

fn kill_child_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .output();
    }
    let _ = child.kill();
}

fn derive_palette(path: &Path) -> Result<Vec<String>, String> {
    let image = image::open(path).map_err(|err| err.to_string())?.to_rgb8();
    let width = image.width().saturating_sub(1);
    let height = image.height().saturating_sub(1);
    let points = [
        (0, 0),
        (width, 0),
        (0, height),
        (width, height),
        (width / 2, height / 2),
    ];
    let mut palette = Vec::new();
    for (x, y) in points {
        let pixel = image.get_pixel(x, y);
        let color = format!("#{:02x}{:02x}{:02x}", pixel[0], pixel[1], pixel[2]);
        if !palette.contains(&color) {
            palette.push(color);
        }
    }
    Ok(palette)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    http_client_with_timeout(Duration::from_secs(20))
}

fn http_client_with_timeout(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("MXTP-MKR/0.1 (https://musicbrainz.org/doc/MusicBrainz_API)")
        .timeout(timeout)
        .build()
        .map_err(|err| err.to_string())
}

fn http_client_without_redirect(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("MXTP-MKR/0.1 (https://musicbrainz.org/doc/MusicBrainz_API)")
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| err.to_string())
}

fn service_base_url(env_key: &str, default: &str) -> String {
    std::env::var(env_key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn env_duration_ms(env_key: &str, default_ms: u64) -> Duration {
    Duration::from_millis(
        std::env::var(env_key)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default_ms),
    )
}

fn env_path(env_key: &str, default: PathBuf) -> PathBuf {
    std::env::var_os(env_key)
        .map(PathBuf::from)
        .unwrap_or(default)
}

fn slug(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// A collision-free cache file stem: the readable slug plus 16 hex digits of
/// FNV-1a 64 over the full UTF-8 key ("AC/DC" and "AC DC", or two non-Latin
/// titles that slug to nothing, get different files).
fn cache_key(key: &str) -> String {
    let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    let stem = slug(key);
    if stem.is_empty() {
        format!("{hash:016x}")
    } else {
        format!("{stem}-{hash:016x}")
    }
}

fn cache_path(kind: &str, key: &str) -> PathBuf {
    let safe = slug(key);
    env_path(
        "MXTP_MKR_CACHE_DIR",
        std::env::temp_dir().join("mxtp_mkr_cache"),
    )
    .join(kind)
    .join(format!("{safe}.json"))
}

fn write_cache<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap()).map_err(|err| err.to_string())?;
    let json = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
}

fn read_cache<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let json = fs::read(path).map_err(|err| err.to_string())?;
    serde_json::from_slice(&json).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        approved_album_cover_url, cache_key, cover_preview_url, crop_generated_artwork,
        dominant_palette, extract_genius_lyrics, lucene_phrase,
    };
    use base64::{engine::general_purpose, Engine as _};

    #[test]
    fn cache_keys_keep_slug_collisions_apart() {
        assert_ne!(cache_key("AC/DC-Back"), cache_key("AC DC-Back"));
        assert_ne!(cache_key("東京-夜"), cache_key("大阪-夜"));
        assert!(cache_key("AC/DC-Back").starts_with("ac-dc-back-"));
        assert_eq!(cache_key("東京-夜").len(), 16);
        // FNV-1a 64 of the empty string is its offset basis.
        assert_eq!(cache_key(""), "cbf29ce484222325");
    }

    #[test]
    fn musicbrainz_phrases_escape_quotes_and_backslashes() {
        assert_eq!(lucene_phrase(r#"Say "Hi" \o/"#), r#"Say \"Hi\" \\o/"#);
    }

    #[test]
    fn cover_preview_is_a_small_png_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.png");
        image::RgbImage::from_pixel(1600, 1200, image::Rgb([200, 40, 40]))
            .save(&path)
            .unwrap();
        let url = cover_preview_url(&path).unwrap();
        let encoded = url.strip_prefix("data:image/png;base64,").unwrap();
        let preview =
            image::load_from_memory(&general_purpose::STANDARD.decode(encoded).unwrap()).unwrap();
        assert_eq!((preview.width(), preview.height()), (512, 384));
    }

    #[test]
    fn art_references_reject_non_allowlisted_hosts() {
        let error = approved_album_cover_url("https://attacker.example/private.png").unwrap_err();
        assert_eq!(error, "album cover source must come from Cover Art Archive");
    }

    #[test]
    fn extracts_nested_genius_lyrics_container_sections() {
        let html = r#"
            <div data-lyrics-container="true">
                [Verse 1]<br/>
                Line one<br>
                <div>Line two</div>
                [Chorus]<br/>
                Line three<br/>
                <div><span>Line four</span></div>
                [Verse 2]<br/>
                Line five<br/>
                Line six
            </div>
        "#;

        let text = extract_genius_lyrics(html);
        let line_count = text.lines().filter(|line| !line.trim().is_empty()).count();

        assert_eq!(line_count, 9);
        assert!(text.contains("[Verse 1]"));
        assert!(text.contains("[Chorus]"));
        assert!(text.contains("[Verse 2]"));
    }

    #[test]
    fn dominant_palette_finds_the_artworks_leading_colors() {
        // 64x64: left 3/4 deep red field, right quarter near-white band.
        let image = image::ImageBuffer::from_fn(64, 64, |x, _| {
            if x < 48 {
                image::Rgb([160_u8, 24, 32])
            } else {
                image::Rgb([240_u8, 238, 234])
            }
        });

        let (palette, luminance) = dominant_palette(&image);

        assert!(!palette.is_empty());
        assert_eq!(palette[0], "#a01820"); // dominant first
        assert!(palette.contains(&"#f0eeea".to_string()));
        assert!(luminance > 0.2 && luminance < 0.7);
    }

    #[test]
    fn crops_generated_frame_artifacts_to_a_full_bleed_square() {
        let image =
            image::DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(1_000, 1_000, |x, y| {
                if x < 60 || y < 60 || x >= 940 || y >= 940 {
                    image::Rgb([220_u8, 190, 150])
                } else {
                    image::Rgb([15_u8, 35, 55])
                }
            }));

        let cropped = crop_generated_artwork(image);

        assert_eq!((cropped.width(), cropped.height()), (840, 840));
        assert_eq!(cropped.to_rgb8().get_pixel(0, 0).0, [15, 35, 55]);
    }

    #[test]
    fn strips_genius_header_chrome_and_recommendations_from_lyrics() {
        // Reduced from a real genius.com page (2026-07): the first lyrics
        // container opens with a data-exclude-from-selection header block
        // (contributor count, translations dropdown, song title, bio preview
        // with "Read More") and Genius injects a "You might also like"
        // recommendations aside mid-lyrics. None of that is lyric text.
        let html = r##"
            <div data-lyrics-container="true" class="Lyrics__Container-sc-d019c5fa-1 iHiXlq">
                <div data-exclude-from-selection="true" class="LyricsHeader__Container-sc-9723157a-1 dVQcTP">
                    <button><span>73 Contributors</span></button>
                    <div class="Dropdown__Container-sc-2f86b219-0">
                        <span>Translations</span>
                        <ul><li><a href="https://genius.com/x">Korean</a></li><li><a href="https://genius.com/y">Espanol</a></li></ul>
                    </div>
                    <div class="LyricsHeader__GroupContainer-sc-9723157a-2"><h2>15 Step Lyrics</h2></div>
                    <div class="SongBioPreview__Container-sc-d8847f07-0"><a href="#about">The opening track builds... <span>Read More</span></a></div>
                </div>[Chorus]<br/><a href="/x"><span>How come I end up where I started?</span></a><br/>Won&#x27;t take my eyes off the ball again
                <aside class="RecommendedSongs__Container"><div>You might also like</div><div></div></aside>
            </div>
            <div data-lyrics-container="true" class="Lyrics__Container-sc-d019c5fa-1 iHiXlq"></div>
            <div data-exclude-from-selection="true" class="sc-8dc7581f-0"><div id="div-gpt-ad-desktop-1"></div></div>
            <div data-lyrics-container="true" class="Lyrics__Container-sc-d019c5fa-1 iHiXlq">[Verse 1]<br/>One two three four</div>
        "##;

        let text = extract_genius_lyrics(html);

        assert!(text.contains("[Chorus]"));
        assert!(text.contains("How come I end up where I started?"));
        assert!(text.contains("Won't take my eyes off the ball again"));
        assert!(text.contains("[Verse 1]"));
        assert!(text.contains("One two three four"));
        assert!(!text.contains("Contributors"));
        assert!(!text.contains("Translations"));
        assert!(!text.contains("Korean"));
        assert!(!text.contains("Read More"));
        assert!(!text.contains("You might also like"));
        assert!(!text.contains("15 Step Lyrics"));
    }

    #[test]
    fn joins_multiple_genius_lyrics_containers() {
        let html = r#"
            <div data-lyrics-container="true">[Part 1]<br/>Line one</div>
            <aside>ignored</aside>
            <div data-lyrics-container="true">[Part 2]<br/>Line two</div>
        "#;

        let text = extract_genius_lyrics(html);
        let line_count = text.lines().filter(|line| !line.trim().is_empty()).count();

        assert_eq!(line_count, 4);
        assert!(text.contains("[Part 1]"));
        assert!(text.contains("[Part 2]"));
    }
}
