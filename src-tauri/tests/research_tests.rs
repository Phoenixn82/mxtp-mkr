use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use mxtp_mkr::research::{
    art_direct_from_references, edit_cover_from_original, fetch_cover_theme, fetch_era_covers,
    fetch_real_cover_file, generate_cover, lookup_album, CodexImageGenAdapter, ImageGenAdapter,
    MockImageGenAdapter,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
#[cfg_attr(
    not(windows),
    ignore = "the codex CLI mock is a PowerShell/.cmd script"
)]
fn codex_adapter_uses_scrubbed_env_glob_retrieval_palette_and_timeout() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    vars.set("PATH", path_with_prefix(dir.path()));
    vars.set("USERPROFILE", dir.path());
    vars.set("HOME", dir.path());
    vars.set("MXTP_MKR_IMAGEGEN", "codex");
    vars.set("MXTP_MKR_IMAGEGEN_OUTPUT_DIR", dir.path().join("imagegen"));
    vars.set("OPENAI_API_KEY", "must-not-reach-child");

    let source = dir.path().join("source.png");
    write_palette_png(&source);
    let prompt_log = dir.path().join("prompt.txt");
    let env_log = dir.path().join("env.txt");
    write_codex_copy_mock(dir.path(), &source, &prompt_log, &env_log);

    let cover = generate_cover("deep magenta grid", &["style-a".to_string()]).unwrap();
    assert!(cover.image_path.ends_with("ig_mock.png"));
    assert!(fs::read_to_string(&prompt_log)
        .unwrap()
        .contains("1536x1536"));
    assert_eq!(fs::read_to_string(&env_log).unwrap().trim(), "absent");
    assert!(
        cover.palette.contains(&"#0a141e".to_string()),
        "{:?}",
        cover.palette
    );

    write_codex_sleep_mock(dir.path());
    let started = Instant::now();
    let error = CodexImageGenAdapter {
        output_dir: dir.path().join("timeout-output"),
        timeout_secs: 1,
    }
    .generate_cover("timeout", &[])
    .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(3), "{error}");
    assert!(error.contains("timed out"), "{error}");
}

#[test]
fn mock_image_adapter_keeps_distinct_album_covers() {
    let dir = tempfile::tempdir().unwrap();
    let adapter = MockImageGenAdapter {
        output_dir: dir.path().to_path_buf(),
    };

    let first = adapter.generate_cover("Daft Punk Discovery", &[]).unwrap();
    let second = adapter
        .generate_cover("Radiohead OK Computer", &[])
        .unwrap();

    assert_ne!(first, second);
    assert!(first.is_file());
    assert!(second.is_file());
}

#[test]
#[cfg_attr(
    not(windows),
    ignore = "the codex CLI mock is a PowerShell/.cmd script"
)]
fn codex_adapter_decodes_nested_json_image_payload() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    vars.set("PATH", path_with_prefix(dir.path()));

    let source = dir.path().join("source.png");
    write_palette_png(&source);
    write_codex_json_mock(dir.path(), &source);

    let cover = CodexImageGenAdapter {
        output_dir: dir.path().join("json-output"),
        timeout_secs: 5,
    }
    .generate_cover("Daft Punk Discovery", &[])
    .unwrap();

    assert!(cover
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("codex-cover-"));
    assert!(cover.is_file());
}

#[test]
fn pollinations_is_the_keyless_default_and_retries_transient_failures() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let png = palette_png_bytes();
    let server = FixtureServer::start(move |_request, index| {
        if index == 0 {
            FixtureResponse::status(503)
        } else {
            FixtureResponse::bytes("image/png", png.clone())
        }
    });

    vars.remove("MXTP_MKR_IMAGEGEN");
    vars.remove("CLOUDFLARE_ACCOUNT_ID");
    vars.remove("CLOUDFLARE_API_TOKEN");
    vars.set("MXTP_MKR_POLLINATIONS_BASE_URL", &server.base_url);
    vars.set("MXTP_MKR_POLLINATIONS_RETRY_DELAY_MS", "0");
    vars.set("MXTP_MKR_IMAGEGEN_TIMEOUT_SECS", "5");
    vars.set(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        dir.path().join("pollinations"),
    );

    let style_refs = vec![
        "https://example.test/real-cover.png".to_string(),
        "https://example.test/era-cover.png".to_string(),
    ];
    let cover = generate_cover("fixture cyan geometry", &style_refs).unwrap();
    let image = image::open(&cover.image_path).unwrap();

    assert_eq!(cover.adapter, "pollinations-nova-canvas");
    assert!(Path::new(&cover.image_path)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("pollinations-nova-canvas-cover-"));
    assert!(image.width() >= 1_536 && image.height() >= 1_536);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].target.starts_with("/prompt/"));
    assert!(requests[0].target.contains("width=1024"));
    assert!(requests[0].target.contains("model=nova-canvas"));
    assert!(requests[0].target.contains("seed="));
    assert!(!requests[0].target.contains("seed=-1"));
    assert!(requests[0].target.contains("image=https%3A%2F%2Fexample.test%2Freal-cover.png%7Chttps%3A%2F%2Fexample.test%2Fera-cover.png"));
}

#[test]
fn pollinations_keeps_regenerations_as_distinct_files() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let png = palette_png_bytes();
    let server = FixtureServer::start(move |_request, _index| {
        FixtureResponse::bytes("image/png", png.clone())
    });

    vars.set("MXTP_MKR_IMAGEGEN", "pollinations");
    vars.set("MXTP_MKR_POLLINATIONS_BASE_URL", &server.base_url);
    vars.set(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        dir.path().join("pollinations"),
    );

    let first = generate_cover(
        "same visual brief",
        &["https://example.test/ref.png".to_string()],
    )
    .unwrap();
    let second = generate_cover(
        "same visual brief",
        &["https://example.test/ref.png".to_string()],
    )
    .unwrap();

    assert_ne!(first.image_path, second.image_path);
    assert!(Path::new(&first.image_path).is_file());
    assert!(Path::new(&second.image_path).is_file());
}

#[test]
fn pollinations_and_adapter_selection_report_deterministic_errors() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let server = FixtureServer::start(|_request, _index| FixtureResponse::status(503));

    vars.set("MXTP_MKR_IMAGEGEN", "pollinations");
    vars.set("MXTP_MKR_POLLINATIONS_BASE_URL", &server.base_url);
    vars.set("MXTP_MKR_POLLINATIONS_RETRY_DELAY_MS", "0");
    vars.set(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        dir.path().join("pollinations-error"),
    );

    let error = generate_cover("unavailable fixture", &[]).unwrap_err();
    assert!(error.contains("failed after 3 tries"), "{error}");
    assert!(error.contains("503"), "{error}");
    assert_eq!(server.requests().len(), 3);

    vars.set("MXTP_MKR_IMAGEGEN", "unknown-adapter");
    let error = generate_cover("invalid adapter", &[]).unwrap_err();
    assert!(error.contains("expected pollinations, codex, cloudflare, or mock"));
}

#[test]
fn cloudflare_credentials_select_the_injected_cloudflare_endpoint() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let png = palette_png_bytes();
    let server = FixtureServer::start(move |_request, _index| {
        FixtureResponse::bytes("image/png", png.clone())
    });

    vars.set("MXTP_MKR_IMAGEGEN", "cloudflare");
    vars.set("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
    vars.set("CLOUDFLARE_API_TOKEN", "fixture-token");
    vars.set("MXTP_MKR_CLOUDFLARE_BASE_URL", &server.base_url);
    vars.set(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        dir.path().join("cloudflare"),
    );

    let prompt = format!(
        "HIGHEST PRIORITY: preserve the extracted visual grammar. {} No readable text, fake text, pseudo-letters, numbers, signatures, watermarks, barcodes, logos, jewel cases, CDs, hands, or product photography.",
        "layered emulsion and asymmetric print texture. ".repeat(70)
    );
    let cover = generate_cover(&prompt, &[]).unwrap();

    assert_eq!(cover.adapter, "cloudflare");
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert!(requests[0]
        .target
        .contains("/accounts/fixture-account/ai/run/@cf/black-forest-labs/flux-1-schnell"));
    assert_eq!(
        requests[0].headers.get("authorization").map(String::as_str),
        Some("Bearer fixture-token")
    );
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    let forwarded_prompt = body["prompt"].as_str().unwrap();
    assert!(forwarded_prompt.chars().count() <= 2_048);
    assert!(forwarded_prompt.starts_with("HIGHEST PRIORITY"));
    assert!(forwarded_prompt.contains("No readable text"));
}

#[test]
fn cloudflare_error_includes_the_api_response_detail() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let server = FixtureServer::start(move |_request, _index| FixtureResponse {
        status: 400,
        content_type: "application/json",
        body: serde_json::to_vec(&json!({
            "success": false,
            "errors": [{"message": "prompt: String should have at most 2048 characters"}]
        }))
        .unwrap(),
    });

    vars.set("MXTP_MKR_IMAGEGEN", "cloudflare");
    vars.set("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
    vars.set("CLOUDFLARE_API_TOKEN", "fixture-token");
    vars.set("MXTP_MKR_CLOUDFLARE_BASE_URL", &server.base_url);
    vars.set(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        dir.path().join("cloudflare-error"),
    );

    let error = generate_cover("fixture cloudflare cover", &[]).unwrap_err();

    assert!(error.contains("400 Bad Request"), "{error}");
    assert!(error.contains("at most 2048 characters"), "{error}");
}

#[test]
fn cloudflare_decodes_the_documented_base64_image_envelope() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let encoded = general_purpose::STANDARD.encode(palette_png_bytes());
    let server = FixtureServer::start(move |_request, _index| {
        FixtureResponse::json(json!({
            "success": true,
            "result": {"image": encoded}
        }))
    });

    vars.set("MXTP_MKR_IMAGEGEN", "cloudflare");
    vars.set("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
    vars.set("CLOUDFLARE_API_TOKEN", "fixture-token");
    vars.set("MXTP_MKR_CLOUDFLARE_BASE_URL", &server.base_url);
    vars.set(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        dir.path().join("cloudflare-json"),
    );

    let cover = generate_cover("fixture cloudflare cover", &[]).unwrap();

    assert_eq!(cover.adapter, "cloudflare");
    assert!(cover.palette.contains(&"#0a141e".to_string()));
}

#[test]
fn cloudflare_flux2_edit_sends_the_managed_original_and_downloads_the_edited_result() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let cover_dir = dir.path().join("real-covers");
    fs::create_dir_all(&cover_dir).unwrap();
    let source = cover_dir.join("original.png");
    DynamicImage::ImageRgb8(ImageBuffer::from_pixel(2_048, 1_024, Rgb([20, 10, 8])))
        .save(&source)
        .unwrap();
    let response_base = Arc::new(Mutex::new(String::new()));
    let response_base_for_handler = Arc::clone(&response_base);
    let edited_png = palette_png_bytes();
    let server = FixtureServer::start(move |_request, index| {
        if index == 0 {
            let base = response_base_for_handler.lock().unwrap().clone();
            FixtureResponse::json(json!({
                "state": "Completed",
                "result": {"image": format!("{base}/edited.png")}
            }))
        } else {
            FixtureResponse::bytes("image/png", edited_png.clone())
        }
    });
    *response_base.lock().unwrap() = server.base_url.clone();

    vars.set("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
    vars.set("CLOUDFLARE_API_TOKEN", "fixture-token");
    vars.set("MXTP_MKR_CLOUDFLARE_BASE_URL", &server.base_url);
    vars.set("MXTP_MKR_CLOUDFLARE_EDIT_ALLOW_INSECURE_OUTPUT", "1");
    vars.set("MXTP_MKR_COVER_OUTPUT_DIR", &cover_dir);
    vars.set(
        "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
        dir.path().join("edited-output"),
    );

    let cover = edit_cover_from_original(
        &source.to_string_lossy(),
        "Make it more cartoonish while preserving the red and black composition.",
    )
    .unwrap();

    assert_eq!(cover.adapter, "cloudflare-flux2-pro-preview-edit");
    assert!(Path::new(&cover.image_path).is_file());
    assert!(cover.preview_url.starts_with("data:image/png;base64,"));
    assert!(cover.palette.contains(&"#0a141e".to_string()));
    let image = image::open(&cover.image_path).unwrap();
    assert!(image.width() >= 1_536 && image.height() >= 1_536);

    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].target, "/accounts/fixture-account/ai/run");
    assert_eq!(
        requests[0].headers.get("authorization").map(String::as_str),
        Some("Bearer fixture-token")
    );
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["model"], "black-forest-labs/flux-2-pro-preview");
    assert_eq!(body["input"]["width"], 1536);
    assert_eq!(body["input"]["height"], 1536);
    assert_eq!(body["input"]["output_format"], "png");
    assert!(body["input"]["prompt"]
        .as_str()
        .unwrap()
        .contains("Make it more cartoonish"));
    let data_uri = body["input"]["input_images"][0].as_str().unwrap();
    assert!(data_uri.starts_with("data:image/jpeg;base64,"));
    let encoded = data_uri.strip_prefix("data:image/jpeg;base64,").unwrap();
    let source_input =
        image::load_from_memory(&general_purpose::STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!((source_input.width(), source_input.height()), (1_536, 768));
    assert_eq!(requests[1].target, "/edited.png");
}

#[test]
fn original_cover_edit_rejects_blank_or_unmanaged_sources_before_networking() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let cover_dir = dir.path().join("real-covers");
    fs::create_dir_all(&cover_dir).unwrap();
    let source = cover_dir.join("original.png");
    write_palette_png(&source);
    let outside = dir.path().join("outside.png");
    write_palette_png(&outside);
    vars.set("MXTP_MKR_COVER_OUTPUT_DIR", &cover_dir);

    assert!(edit_cover_from_original(&source.to_string_lossy(), " ")
        .unwrap_err()
        .contains("1-600 characters"));
    assert!(
        edit_cover_from_original(&outside.to_string_lossy(), "Make it cartoonish")
            .unwrap_err()
            .contains("must come from MXTP")
    );
    assert!(
        edit_cover_from_original(&source.to_string_lossy(), "Make it cartoonish")
            .unwrap_err()
            .contains("CLOUDFLARE_ACCOUNT_ID")
    );
}

#[test]
fn original_cover_edit_rejects_incompatible_models_and_insecure_provider_output_urls() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let cover_dir = dir.path().join("real-covers");
    fs::create_dir_all(&cover_dir).unwrap();
    let source = cover_dir.join("original.png");
    write_palette_png(&source);
    vars.set("MXTP_MKR_COVER_OUTPUT_DIR", &cover_dir);
    vars.set("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
    vars.set("CLOUDFLARE_API_TOKEN", "fixture-token");
    vars.set(
        "MXTP_MKR_CLOUDFLARE_EDIT_MODEL",
        "@cf/black-forest-labs/flux-2-klein-4b",
    );

    assert!(
        edit_cover_from_original(&source.to_string_lossy(), "Make it cartoonish")
            .unwrap_err()
            .contains("must be black-forest-labs/flux-2-pro-preview")
    );

    vars.remove("MXTP_MKR_CLOUDFLARE_EDIT_MODEL");
    let server = FixtureServer::start(move |_request, _index| {
        FixtureResponse::json(json!({
            "state": "Completed",
            "result": {"image": "http://127.0.0.1:9/private.png"}
        }))
    });
    vars.set("MXTP_MKR_CLOUDFLARE_BASE_URL", &server.base_url);

    assert!(
        edit_cover_from_original(&source.to_string_lossy(), "Make it cartoonish")
            .unwrap_err()
            .contains("non-HTTPS image URL")
    );
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn real_cover_download_falls_back_caches_and_serializes_camel_case() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let png = palette_png_bytes();
    let server = FixtureServer::start(move |request, _index| match request.target.as_str() {
        "/missing.png" | "/broken.png" => FixtureResponse::status(404),
        "/cover.png" => FixtureResponse::bytes("image/png", png.clone()),
        _ => FixtureResponse::status(404),
    });

    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));
    vars.set("MXTP_MKR_COVER_OUTPUT_DIR", dir.path().join("covers"));
    vars.set("MXTP_MKR_ALLOW_INSECURE_COVER_URLS", "1");
    let refs = vec![
        format!("{}/missing.png", server.base_url),
        format!("{}/cover.png", server.base_url),
    ];

    let first = fetch_real_cover_file(&refs).unwrap();
    let request_count = server.requests().len();
    let second = fetch_real_cover_file(&refs).unwrap();

    assert_eq!(first, second);
    assert_eq!(request_count, 2);
    assert_eq!(server.requests().len(), request_count);
    assert!(Path::new(&first.image_path).is_file());
    let image = image::open(&first.image_path).unwrap();
    assert!(image.width() >= 1_536 && image.height() >= 1_536);
    assert!(first.preview_url.starts_with("data:image/png;base64,"));
    assert!(!first.palette.is_empty());
    let serialized = serde_json::to_value(&first).unwrap();
    assert!(serialized.get("imagePath").is_some());
    assert!(serialized.get("previewUrl").is_some());
    assert!(serialized.get("image_path").is_none());

    assert_eq!(
        fetch_real_cover_file(&[]).unwrap_err(),
        "album has no cover art references"
    );
    let error = fetch_real_cover_file(&[format!("{}/broken.png", server.base_url)]).unwrap_err();
    assert_eq!(error, "could not download the album cover");
}

#[test]
fn undecodable_original_cover_falls_through_to_its_thumbnail() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let png = palette_png_bytes();
    let server = FixtureServer::start(move |request, _index| match request.target.as_str() {
        "/original.pdf" => {
            FixtureResponse::bytes("application/pdf", b"%PDF-1.4 not an image".to_vec())
        }
        "/front-1200.png" => FixtureResponse::bytes("image/png", png.clone()),
        _ => FixtureResponse::status(404),
    });
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));
    vars.set("MXTP_MKR_COVER_OUTPUT_DIR", dir.path().join("covers"));
    vars.set("MXTP_MKR_ALLOW_INSECURE_COVER_URLS", "1");
    let refs = vec![
        format!("{}/original.pdf", server.base_url),
        format!("{}/front-1200.png", server.base_url),
    ];

    let cover = fetch_real_cover_file(&refs).unwrap();
    assert!(Path::new(&cover.image_path).is_file());

    let theme = fetch_cover_theme(&refs).unwrap();
    assert_eq!(theme.source_url, refs[1]);
    assert!(!theme.palette.is_empty());
}

#[test]
fn real_cover_rejects_untrusted_sources_before_downloading_or_caching_them() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));
    vars.set("MXTP_MKR_COVER_OUTPUT_DIR", dir.path().join("covers"));

    let error =
        fetch_real_cover_file(&["https://127.0.0.1/private-cover.png".to_string()]).unwrap_err();
    assert_eq!(error, "album cover source must come from Cover Art Archive");
}

#[test]
fn album_lookup_uses_injected_musicbrainz_and_caa_then_falls_back_to_cache() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let server = FixtureServer::start(|request, _index| {
        if request.target.starts_with("/mb/release/rel-1?") {
            FixtureResponse::json(json!({
                "title": "Fixture Album",
                "date": "2001-06-01",
                "label-info": [{ "label": { "name": "Fixture Records" } }],
                "genres": [{ "name": "Electronic", "count": 4 }],
                "tags": [],
                "media": [{
                    "tracks": [
                        { "title": "Alpha", "recording": { "genres": [{ "name": "Ambient", "count": 3 }], "tags": [] } },
                        { "title": "Beta", "recording": { "genres": [], "tags": [] } }
                    ]
                }]
            }))
        } else if request.target.starts_with("/mb/release?") {
            FixtureResponse::json(json!({
                "releases": [{
                    "id": "rel-1",
                    "title": "Fixture Album",
                    "score": 100,
                    "genres": [{ "name": "Electronic", "count": 2 }],
                    "tags": []
                }]
            }))
        } else if request.target == "/caa/release/rel-1" {
            FixtureResponse::json(json!({
                "images": [{ "image": "https://example.invalid/fixture-cover.png", "front": true }]
            }))
        } else {
            FixtureResponse::status(404)
        }
    });

    vars.set(
        "MXTP_MKR_MUSICBRAINZ_BASE_URL",
        format!("{}/mb", server.base_url),
    );
    vars.set("MXTP_MKR_CAA_BASE_URL", format!("{}/caa", server.base_url));
    vars.set("MXTP_MKR_MUSICBRAINZ_THROTTLE_MS", "0");
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));

    let online = lookup_album("Fixture Artist", "Fixture Album").unwrap();

    assert_eq!(online.artist, "Fixture Artist");
    assert_eq!(online.album, "Fixture Album");
    assert_eq!(online.year, 2001);
    assert_eq!(online.label, "Fixture Records");
    assert_eq!(online.tracks, ["Alpha", "Beta"]);
    assert_eq!(
        online.cover_art_urls,
        ["https://example.invalid/fixture-cover.png"]
    );
    assert!(online.tags.contains(&"electronic".to_string()));
    assert!(online.tags.contains(&"ambient".to_string()));
    assert_eq!(server.requests().len(), 3);

    drop(server);
    let cached = lookup_album("Fixture Artist", "Fixture Album").unwrap();
    assert_eq!(cached, online);
}

#[test]
fn album_lookup_keeps_only_the_front_cover_and_escapes_the_query() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let server = FixtureServer::start(|request, _index| {
        if request.target.starts_with("/mb/release/rel-q?") {
            FixtureResponse::json(json!({
                "title": "Say \"Hi\"",
                "media": [{ "tracks": [{ "title": "One" }] }]
            }))
        } else if request.target.starts_with("/mb/release?") {
            FixtureResponse::json(json!({
                "releases": [{ "id": "rel-q", "title": "Say \"Hi\"", "score": 100 }]
            }))
        } else if request.target == "/caa/release/rel-q" {
            FixtureResponse::json(json!({
                "images": [
                    {
                        "image": "https://example.invalid/back.png",
                        "front": false,
                        "types": ["Back"],
                        "thumbnails": { "1200": "https://example.invalid/back-1200.jpg" }
                    },
                    {
                        "image": "https://example.invalid/front.png",
                        "front": true,
                        "types": ["Front"],
                        "thumbnails": {
                            "large": "https://example.invalid/front-500.jpg",
                            "1200": "https://example.invalid/front-1200.jpg"
                        }
                    },
                    {
                        "image": "https://example.invalid/medium.png",
                        "front": false,
                        "types": ["Medium"]
                    }
                ]
            }))
        } else {
            FixtureResponse::status(404)
        }
    });
    vars.set(
        "MXTP_MKR_MUSICBRAINZ_BASE_URL",
        format!("{}/mb", server.base_url),
    );
    vars.set("MXTP_MKR_CAA_BASE_URL", format!("{}/caa", server.base_url));
    vars.set("MXTP_MKR_MUSICBRAINZ_THROTTLE_MS", "0");
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));

    let album = lookup_album("Quote \\ Artist", "Say \"Hi\"").unwrap();

    assert_eq!(
        album.cover_art_urls,
        [
            "https://example.invalid/front.png",
            "https://example.invalid/front-1200.jpg",
            "https://example.invalid/front-500.jpg"
        ]
    );
    let search = server
        .requests()
        .into_iter()
        .find(|request| request.target.starts_with("/mb/release?"))
        .unwrap();
    let query = urlencoding::decode(&search.target).unwrap().into_owned();
    assert!(
        query.contains(r#"artist:"Quote \\ Artist" AND release:"Say \"Hi\"""#),
        "{query}"
    );
}

#[test]
fn album_lookup_without_a_front_image_returns_no_cover_urls() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let server = FixtureServer::start(|request, _index| {
        if request.target.starts_with("/mb/release/rel-b?") {
            FixtureResponse::json(
                json!({ "title": "Backs", "media": [{ "tracks": [{ "title": "One" }] }] }),
            )
        } else if request.target.starts_with("/mb/release?") {
            FixtureResponse::json(
                json!({ "releases": [{ "id": "rel-b", "title": "Backs", "score": 100 }] }),
            )
        } else if request.target == "/caa/release/rel-b" {
            FixtureResponse::json(json!({
                "images": [{ "image": "https://example.invalid/back.png", "front": false, "types": ["Back"] }]
            }))
        } else {
            FixtureResponse::status(404)
        }
    });
    vars.set(
        "MXTP_MKR_MUSICBRAINZ_BASE_URL",
        format!("{}/mb", server.base_url),
    );
    vars.set("MXTP_MKR_CAA_BASE_URL", format!("{}/caa", server.base_url));
    vars.set("MXTP_MKR_MUSICBRAINZ_THROTTLE_MS", "0");
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));

    assert!(lookup_album("Artist", "Backs")
        .unwrap()
        .cover_art_urls
        .is_empty());
}

#[test]
fn album_caches_that_collide_by_slug_get_different_files() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let server = FixtureServer::start(|request, _index| {
        if request.target.starts_with("/mb/release/rel-c?") {
            FixtureResponse::json(
                json!({ "title": "Same", "media": [{ "tracks": [{ "title": "One" }] }] }),
            )
        } else if request.target.starts_with("/mb/release?") {
            FixtureResponse::json(
                json!({ "releases": [{ "id": "rel-c", "title": "Same", "score": 100 }] }),
            )
        } else {
            FixtureResponse::status(404)
        }
    });
    vars.set(
        "MXTP_MKR_MUSICBRAINZ_BASE_URL",
        format!("{}/mb", server.base_url),
    );
    vars.set("MXTP_MKR_CAA_BASE_URL", format!("{}/caa", server.base_url));
    vars.set("MXTP_MKR_MUSICBRAINZ_THROTTLE_MS", "0");
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));

    for (artist, album) in [
        ("AC/DC", "Back"),
        ("AC DC", "Back"),
        ("東京", "夜"),
        ("大阪", "夜"),
    ] {
        lookup_album(artist, album).unwrap();
    }

    let files = fs::read_dir(dir.path().join("cache").join("album"))
        .unwrap()
        .count();
    assert_eq!(files, 4);
}

#[test]
fn album_lookup_retries_a_transient_musicbrainz_service_failure() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let server = FixtureServer::start(|request, index| {
        if request.target.starts_with("/mb/release?") && index == 0 {
            FixtureResponse::status(503)
        } else if request.target.starts_with("/mb/release?") {
            FixtureResponse::json(json!({
                "releases": [{ "id": "rel-retry", "title": "Retry Album", "score": 100 }]
            }))
        } else if request.target.starts_with("/mb/release/rel-retry?") {
            FixtureResponse::json(json!({
                "title": "Retry Album",
                "date": "2026-01-01",
                "label-info": [],
                "media": [{ "tracks": [{ "title": "Recovered" }] }]
            }))
        } else {
            FixtureResponse::status(404)
        }
    });

    vars.set(
        "MXTP_MKR_MUSICBRAINZ_BASE_URL",
        format!("{}/mb", server.base_url),
    );
    vars.set("MXTP_MKR_CAA_BASE_URL", format!("{}/caa", server.base_url));
    vars.set("MXTP_MKR_MUSICBRAINZ_THROTTLE_MS", "0");
    vars.set("MXTP_MKR_MUSICBRAINZ_RETRY_DELAY_MS", "0");
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));

    let album = lookup_album("Retry Artist", "Retry Album").unwrap();

    assert_eq!(album.tracks, ["Recovered"]);
    assert_eq!(server.requests().len(), 4);
}

#[test]
fn era_cover_discovery_filters_orders_and_caches_local_fixtures() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let dir = tempfile::tempdir().unwrap();
    let png = palette_png_bytes();
    let server = FixtureServer::start(move |request, _index| {
        if request.target.starts_with("/mb/artist?") {
            FixtureResponse::json(json!({ "artists": [{ "id": "artist-1" }] }))
        } else if request.target.starts_with("/mb/release-group?") {
            FixtureResponse::json(json!({
                "release-groups": [
                    { "id": "rg-far", "primary-type": "Album", "secondary-types": [], "first-release-date": "1980-01-01" },
                    { "id": "rg-near", "primary-type": "Album", "secondary-types": [], "first-release-date": "2002-01-01" },
                    { "id": "rg-mid", "primary-type": "Album", "secondary-types": [], "first-release-date": "1998-01-01" },
                    { "id": "rg-ep", "primary-type": "EP", "secondary-types": [], "first-release-date": "2003-01-01" },
                    { "id": "rg-comp", "primary-type": "Album", "secondary-types": ["Compilation"], "first-release-date": "2001-01-01" }
                ]
            }))
        } else if request.target.contains("/rg-near/") || request.target.contains("/rg-mid/") {
            FixtureResponse::bytes("image/png", png.clone())
        } else {
            FixtureResponse::status(404)
        }
    });

    vars.set(
        "MXTP_MKR_MUSICBRAINZ_BASE_URL",
        format!("{}/mb", server.base_url),
    );
    vars.set("MXTP_MKR_CAA_BASE_URL", format!("{}/caa", server.base_url));
    vars.set("MXTP_MKR_MUSICBRAINZ_THROTTLE_MS", "0");
    vars.set("MXTP_MKR_CAA_REQUEST_DELAY_MS", "0");
    vars.set("MXTP_MKR_CAA_RETRY_DELAY_MS", "0");
    vars.set("MXTP_MKR_CACHE_DIR", dir.path().join("cache"));

    let first = fetch_era_covers("Fixture Artist", 2003, 1).unwrap();

    assert_eq!(first.len(), 2);
    assert!(first[0].contains("rg-near"));
    assert!(first[1].contains("rg-mid"));
    assert!(first
        .iter()
        .all(|url| !url.contains("rg-ep") && !url.contains("rg-comp")));
    let request_count = server.requests().len();
    let second = fetch_era_covers("Fixture Artist", 2003, 1).unwrap();
    assert_eq!(second, first);
    assert_eq!(server.requests().len(), request_count);
}

#[test]
fn art_direction_uses_injected_freellm_images_auth_and_error_status() {
    let _guard = env_lock();
    let mut vars = EnvGuard::default();
    let png = palette_png_bytes();
    let server = FixtureServer::start(move |request, _index| match request.target.as_str() {
        "/api/settings/api-key" => FixtureResponse::json(json!({ "apiKey": "fixture-key" })),
        "/cover.png" | "/era-a.png" | "/era-b.png" | "/era-c.png" => {
            FixtureResponse::bytes("image/png", png.clone())
        }
        "/v1/chat/completions" => FixtureResponse::json(json!({
            "choices": [{ "message": { "content": "  cobalt paper collage with silver halftone  " } }]
        })),
        _ => FixtureResponse::status(404),
    });
    vars.set("FREELLMAPI_BASE_URL", format!("{}/", server.base_url));
    vars.set("MXTP_MKR_ALLOW_INSECURE_COVER_URLS", "1");

    let prompt = art_direct_from_references(
        "Fixture Artist - Fixture Album",
        &[format!("{}/cover.png", server.base_url)],
        &[
            format!("{}/era-a.png", server.base_url),
            format!("{}/era-b.png", server.base_url),
            format!("{}/era-c.png", server.base_url),
        ],
    )
    .unwrap();

    assert_eq!(prompt, "cobalt paper collage with silver halftone");
    let requests = server.requests();
    assert_eq!(requests.len(), 5);
    let completion = requests
        .iter()
        .find(|request| request.target == "/v1/chat/completions")
        .unwrap();
    assert_eq!(
        completion.headers.get("authorization").map(String::as_str),
        Some("Bearer fixture-key")
    );
    let body: Value = serde_json::from_slice(&completion.body).unwrap();
    assert_eq!(body["model"], "gemini-2.5-flash");
    let content = body["messages"][0]["content"].as_array().unwrap();
    assert_eq!(content.len(), 4);
    let instruction = content[0]["text"].as_str().unwrap();
    assert!(instruction.contains("Fixture Artist - Fixture Album"));
    assert!(instruction.contains("PRIMARY REFERENCE (80% weight)"));
    assert!(instruction.contains("TYPOGRAPHY ROLE"));
    assert!(instruction.contains("FORBIDDEN CLICHES"));
    assert!(instruction.contains("generic orb, portal, mandala, nebula"));
    assert!(content[1]["image_url"]["url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
    assert!(!String::from_utf8_lossy(&completion.body).contains("fixture-key"));

    let error_server = FixtureServer::start(|request, _index| match request.target.as_str() {
        "/api/settings/api-key" => FixtureResponse::json(json!({ "apiKey": "fixture-key" })),
        "/v1/chat/completions" => FixtureResponse::status(503),
        _ => FixtureResponse::status(404),
    });
    vars.set("FREELLMAPI_BASE_URL", &error_server.base_url);
    let error = art_direct_from_references("Fixture", &[], &[]).unwrap_err();
    assert!(
        error.contains("art-direction request failed: HTTP 503"),
        "{error}"
    );
}

fn write_palette_png(path: &Path) {
    fs::write(path, palette_png_bytes()).unwrap();
}

fn palette_png_bytes() -> Vec<u8> {
    let mut image = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(24, 24);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = if x < 12 && y < 12 {
            Rgb([10, 20, 30])
        } else if x >= 12 && y < 12 {
            Rgb([200, 40, 80])
        } else if x < 12 {
            Rgb([20, 180, 160])
        } else {
            Rgb([245, 190, 30])
        };
    }
    let mut bytes = Vec::new();
    DynamicImage::ImageRgb8(image)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .unwrap();
    bytes
}

#[cfg(windows)]
fn write_codex_copy_mock(dir: &Path, source: &Path, prompt_log: &Path, env_log: &Path) {
    let script = dir.join("codex-mock.ps1");
    fs::write(
        &script,
        format!(
            r#"$prompt = [Console]::In.ReadToEnd()
Set-Content -LiteralPath '{}' -Value $prompt
$apiKeyState = if ($env:OPENAI_API_KEY) {{ 'present' }} else {{ 'absent' }}
Set-Content -LiteralPath '{}' -Value $apiKeyState
$target = Join-Path $env:USERPROFILE '.codex\generated_images\mock'
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -LiteralPath '{}' -Destination (Join-Path $target 'ig_mock.png') -Force
"#,
            ps_path(prompt_log),
            ps_path(env_log),
            ps_path(source)
        ),
    )
    .unwrap();
    write_cmd(dir, &script);
}

#[cfg(not(windows))]
fn write_codex_copy_mock(dir: &Path, source: &Path, prompt_log: &Path, env_log: &Path) {
    write_unix_executable(
        dir,
        &format!(
            "#!/bin/sh\ncat > {}\nif [ -n \"${{OPENAI_API_KEY:-}}\" ]; then printf present; else printf absent; fi > {}\ntarget=\"$HOME/.codex/generated_images/mock\"\nmkdir -p \"$target\"\ncp {} \"$target/ig_mock.png\"\n",
            shell_path(prompt_log),
            shell_path(env_log),
            shell_path(source)
        ),
    );
}

#[cfg(windows)]
fn write_codex_sleep_mock(dir: &Path) {
    let script = dir.join("codex-mock.ps1");
    fs::write(&script, "Start-Sleep -Seconds 4\n").unwrap();
    write_cmd(dir, &script);
}

#[cfg(not(windows))]
fn write_codex_sleep_mock(dir: &Path) {
    write_unix_executable(dir, "#!/bin/sh\nexec sleep 4\n");
}

#[cfg(windows)]
fn write_codex_json_mock(dir: &Path, source: &Path) {
    let script = dir.join("codex-mock.ps1");
    fs::write(
        &script,
        format!(
            r#"$prompt = [Console]::In.ReadToEnd()
$result = [Convert]::ToBase64String([IO.File]::ReadAllBytes('{}'))
$json = @{{
  type = 'response_item'
  payload = @{{
    type = 'image_generation_call'
    status = 'generating'
    result = $result
  }}
}} | ConvertTo-Json -Compress -Depth 4
[Console]::Out.WriteLine($json)
"#,
            ps_path(source)
        ),
    )
    .unwrap();
    write_cmd(dir, &script);
}

#[cfg(not(windows))]
fn write_codex_json_mock(dir: &Path, source: &Path) {
    write_unix_executable(
        dir,
        &format!(
            "#!/bin/sh\ncat >/dev/null\nresult=$(base64 < {} | tr -d '\\n')\nprintf '%s\\n' \"{{\\\"type\\\":\\\"response_item\\\",\\\"payload\\\":{{\\\"type\\\":\\\"image_generation_call\\\",\\\"status\\\":\\\"generating\\\",\\\"result\\\":\\\"$result\\\"}}}}\"\n",
            shell_path(source)
        ),
    );
}

#[cfg(windows)]
fn write_cmd(dir: &Path, script: &Path) {
    fs::write(
        dir.join("codex.cmd"),
        format!(
            "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"\r\n",
            script.display()
        ),
    )
    .unwrap();
}

#[cfg(not(windows))]
fn write_unix_executable(dir: &Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;

    let executable = dir.join("codex");
    fs::write(&executable, contents).unwrap();
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(executable, permissions).unwrap();
}

#[cfg(not(windows))]
fn shell_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\\"'\\\"'"))
}

fn path_with_prefix(prefix: &Path) -> OsString {
    let mut paths = vec![prefix.to_path_buf()];
    if let Some(current) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current));
    }
    env::join_paths(paths).unwrap()
}

#[cfg(windows)]
fn ps_path(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

fn env_lock() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
struct EnvGuard {
    saved: Vec<(String, Option<OsString>)>,
}

impl EnvGuard {
    fn remember(&mut self, key: &str) {
        if self.saved.iter().all(|(saved, _)| saved != key) {
            self.saved.push((key.to_string(), env::var_os(key)));
        }
    }

    fn set(&mut self, key: &str, value: impl AsRef<OsStr>) {
        self.remember(key);
        env::set_var(key, value.as_ref());
    }

    fn remove(&mut self, key: &str) {
        self.remember(key);
        env::remove_var(key);
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..).rev() {
            if let Some(value) = value {
                env::set_var(key, value);
            } else {
                env::remove_var(key);
            }
        }
    }
}

#[derive(Clone, Debug)]
struct FixtureRequest {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct FixtureResponse {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl FixtureResponse {
    fn status(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain",
            body: format!("fixture status {status}").into_bytes(),
        }
    }

    fn bytes(content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            content_type,
            body,
        }
    }

    fn json(value: Value) -> Self {
        Self::bytes("application/json", serde_json::to_vec(&value).unwrap())
    }
}

struct FixtureServer {
    base_url: String,
    requests: Arc<Mutex<Vec<FixtureRequest>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl FixtureServer {
    fn start<F>(handler: F) -> Self
    where
        F: Fn(&FixtureRequest, usize) -> FixtureResponse + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_requests = Arc::clone(&requests);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let Some(request) = read_fixture_request(&mut stream) else {
                            continue;
                        };
                        let index = {
                            let mut captured = thread_requests
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            let index = captured.len();
                            captured.push(request.clone());
                            index
                        };
                        write_fixture_response(&mut stream, handler(&request, index));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => {
                        if thread_stop.load(Ordering::Relaxed) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(2));
                    }
                }
            }
        });

        Self {
            base_url: format!("http://{address}"),
            requests,
            stop,
            handle: Some(handle),
        }
    }

    fn requests(&self) -> Vec<FixtureRequest> {
        self.requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

fn read_fixture_request(stream: &mut TcpStream) -> Option<FixtureRequest> {
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        let mut chunk = [0_u8; 4_096];
        let count = stream.read(&mut chunk).ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    };

    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_string();
    let target = request_line.next()?.to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_lowercase(), value.trim().to_string()))
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    while bytes.len() < body_start + content_length {
        let mut chunk = [0_u8; 4_096];
        let count = stream.read(&mut chunk).ok()?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() < body_start + content_length {
        return None;
    }

    Some(FixtureRequest {
        method,
        target,
        headers,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

fn write_fixture_response(stream: &mut TcpStream, response: FixtureResponse) {
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Fixture Response",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        reason,
        response.content_type,
        response.body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&response.body);
    let _ = stream.flush();
}
