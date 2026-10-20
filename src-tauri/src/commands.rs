use crate::app_data::app_data_dir;
use crate::apple_music::{self, AppleMusicLibrary};
use crate::audio_prep::{self, AudioMeta, PcmTrack};
use crate::burn::{self, BurnResult, CdTextMetadata, CdaImage, DriveInfo};
use crate::hidden_command;
use crate::pdf_compose::{self, ComposePdfRequest, PdfInfo};
use crate::project_store;
use crate::research::{self, AlbumInfo, CoverTheme, GeneratedCover, RealCover};
use crate::youtube::{self, ExpectedAlbumTrack, YouTubeAlbumMatch, YouTubeTrackMatch};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn ffmpeg_version() -> Result<String, String> {
    audio_prep::ffmpeg_version()
}

#[tauri::command]
pub async fn probe_audio(path: String) -> Result<AudioMeta, String> {
    run_blocking(move || audio_prep::probe_audio(&path)).await
}

#[tauri::command]
pub async fn prepare_pcm(
    paths: Vec<String>,
    gap_sec: f32,
    normalize: bool,
) -> Result<Vec<PcmTrack>, String> {
    run_blocking(move || audio_prep::prepare_pcm(paths, gap_sec, normalize)).await
}

#[tauri::command]
pub async fn copy_audio_file(
    app: AppHandle,
    source_path: String,
    project_id: String,
) -> Result<String, String> {
    let base = app_data_dir(&app)?;
    run_blocking(move || {
        audio_prep::copy_audio_file(&source_path, &base, &project_id)
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub id: String,
    pub title: String,
    pub duration_sec: f32,
    pub path: String,
    pub codec: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistImport {
    pub title: String,
    pub quality: String,
    pub cover_path: Option<String>,
    /// Each path keeps its "NNN - " playlist-position prefix.
    pub tracks: Vec<PlaylistTrack>,
    /// Requested entries that did not import: failed downloads plus unreadable files.
    #[serde(default)]
    pub skipped: usize,
    /// Audio files in the folder that ffprobe could not read.
    #[serde(default)]
    pub unreadable: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPlaylist {
    pub source_path: String,
    pub title: String,
    pub quality: String,
    pub cover_path: Option<String>,
    pub tracks: Vec<PlaylistTrack>,
    pub updated_at_ms: u64,
    /// Unreadable audio files left out of this folder's tracks.
    #[serde(default)]
    pub skipped: usize,
}

#[tauri::command]
pub async fn download_playlist_best(
    app: AppHandle,
    url: String,
    playlist_items: Option<String>,
) -> Result<PlaylistImport, String> {
    run_blocking(move || download_playlist_best_sync(&app, &url, playlist_items.as_deref())).await
}

#[tauri::command]
pub async fn list_cached_playlists(app: AppHandle) -> Result<Vec<CachedPlaylist>, String> {
    run_blocking(move || list_cached_playlists_sync(&app)).await
}

#[tauri::command]
pub async fn find_youtube_album_playlist(
    app: AppHandle,
    artist: String,
    album: String,
    expected_tracks: Vec<ExpectedAlbumTrack>,
) -> Result<YouTubeAlbumMatch, String> {
    run_blocking(move || youtube::find_best_album_playlist(&app, &artist, &album, &expected_tracks))
        .await
}

#[tauri::command]
pub async fn find_youtube_track(
    app: AppHandle,
    artist: String,
    title: String,
    duration_sec: f32,
) -> Result<YouTubeTrackMatch, String> {
    run_blocking(move || youtube::find_best_track(&app, &artist, &title, duration_sec)).await
}

#[tauri::command]
pub fn load_cd_projects(app: AppHandle) -> Result<Vec<Value>, String> {
    let base = app_data_dir(&app)?;
    project_store::load_cd_projects(&base)
}

#[tauri::command]
pub fn save_cd_project(app: AppHandle, project: Value) -> Result<(), String> {
    let base = app_data_dir(&app)?;
    project_store::save_cd_project(&base, project)
}

#[tauri::command]
pub fn delete_cd_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let base = app_data_dir(&app)?;
    project_store::delete_cd_project(&base, &project_id)
}

#[tauri::command]
pub fn load_imported_music_sources(app: AppHandle) -> Result<Value, String> {
    let base = app_data_dir(&app)?;
    project_store::load_imported_music_sources(&base)
}

#[tauri::command]
pub fn save_imported_music_sources(app: AppHandle, sources: Value) -> Result<(), String> {
    let base = app_data_dir(&app)?;
    project_store::save_imported_music_sources(&base, sources)
}

#[tauri::command]
pub async fn import_apple_music_library(
    app: AppHandle,
    path: Option<String>,
) -> Result<AppleMusicLibrary, String> {
    let base = app_data_dir(&app)?;
    let library = run_blocking(move || {
        apple_music::import_with_remembered_path(
            &base,
            path.as_deref(),
            apple_music::import_library,
        )
    })
    .await?;
    allow_artwork_dir(&app, Path::new(&library.source_path));
    Ok(library)
}

/// A library chosen outside ~/Music keeps its artwork viewable: the configured
/// asset scope only covers the default library locations.
fn allow_artwork_dir(app: &AppHandle, library_db: &Path) {
    let Some(artwork) = library_db.parent().map(|package| package.join("artwork")) else {
        return;
    };
    let scope = app.asset_protocol_scope();
    if artwork.is_dir() && !scope.is_allowed(artwork.join("probe.jpeg")) {
        if let Err(error) = scope.allow_directory(&artwork, true) {
            eprintln!(
                "could not allow Apple Music artwork `{}`: {error}",
                artwork.display()
            );
        }
    }
}

pub fn playlist_download_args(
    script: &Path,
    url: &str,
    out_root: &Path,
    playlist_items: Option<&str>,
) -> Result<Vec<String>, String> {
    validate_playlist_items(playlist_items)?;
    let mut args = vec![
        "-NoProfile".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-File".to_string(),
        script.to_string_lossy().to_string(),
        "-Format".to_string(),
        "best".to_string(),
        "-OutRoot".to_string(),
        out_root.to_string_lossy().to_string(),
        "-NoPause".to_string(),
        "-Url".to_string(),
        url.to_string(),
    ];
    if let Some(items) = playlist_items.filter(|items| !items.trim().is_empty()) {
        args.push("-PlaylistItems".to_string());
        args.push(items.to_string());
    }
    Ok(args)
}

pub fn album_lookup_args(script: &Path, artist: &str, album: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-File".to_string(),
        script.to_string_lossy().to_string(),
        "-Artist".to_string(),
        artist.to_string(),
        "-Album".to_string(),
        album.to_string(),
        "-ResolveOnly".to_string(),
        "-NoPause".to_string(),
    ]
}

fn download_playlist_best_sync(
    app: &AppHandle,
    url: &str,
    playlist_items: Option<&str>,
) -> Result<PlaylistImport, String> {
    let url = url.trim();
    validate_youtube_url(url)?;
    let script = playlist_tool_path(app)?;
    let app_data = app_data_dir(app)?;
    let out_root = playlist_output_root(&app_data);
    fs::create_dir_all(&out_root).map_err(|err| {
        format!(
            "failed to create playlist output `{}`: {err}",
            out_root.display()
        )
    })?;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let output = {
        let runtime = unix_playlist_runtime()?;
        let mut command = hidden_command(&runtime.python);
        command.env("PATH", runtime.path);
        command.env("MXTP_YTDLP_PATH", runtime.yt_dlp);
        command.env("MXTP_FFMPEG_PATH", runtime.ffmpeg);
        command.arg(&script);
        command.args(unix_playlist_download_args(url, &out_root, playlist_items)?);
        command
            .output()
            .map_err(|err| format!("failed to start Playlist to MP3: {err}"))?
    };
    #[cfg(windows)]
    let output = {
        let mut command = hidden_command("powershell.exe");
        command.env("MXTP_YTDLP_PATH", youtube::yt_dlp_path(app)?);
        if let Some(node) = youtube::node_path(app) {
            command.env("MXTP_NODE_PATH", node);
        }
        command.args(playlist_download_args(
            &script,
            url,
            &out_root,
            playlist_items,
        )?);
        command
            .output()
            .map_err(|err| format!("failed to start Playlist to MP3: {err}"))?
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let failure =
        (!output.status.success()).then(|| youtube::short_tool_error("playlist download", &output));
    import_playlist_output(&stdout, failure.as_deref(), playlist_items)
}

/// Turn the playlist sidecar's report into an import. Whatever audio landed in
/// its folder is imported even when some entries failed; it is an error only
/// when nothing usable came back.
pub fn import_playlist_output(
    stdout: &str,
    failure: Option<&str>,
    playlist_items: Option<&str>,
) -> Result<PlaylistImport, String> {
    let requested = requested_playlist_items(playlist_items)?;
    let folder = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("Folder   : "))
        .map(|folder| PathBuf::from(folder.trim()));
    let Some(folder) = folder.filter(|folder| folder.is_dir()) else {
        return Err(format!(
            "Couldn't download that playlist: {}",
            failure.unwrap_or("the download did not say where it saved the audio")
        ));
    };
    let reported_skips = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("Skipped: "))
        .and_then(|rest| rest.split_whitespace().next()?.parse::<usize>().ok())
        .unwrap_or(0);
    let (mut import, video_variants) = scan_playlist_folder(&folder, requested.as_ref());
    if import.tracks.is_empty() {
        return Err(format!(
            "Couldn't download {}: {}",
            import.title,
            failure.unwrap_or(if import.unreadable.is_empty() {
                "no audio tracks came back"
            } else {
                "none of the downloaded files could be read"
            })
        ));
    }
    import.skipped = match &requested {
        // A requested music video that was dropped on purpose is not a skip.
        Some(requested) => requested
            .len()
            .saturating_sub(import.tracks.len() + video_variants),
        None => reported_skips + import.unreadable.len(),
    };
    Ok(import)
}

/// Every readable audio file in a cached playlist folder. Fails only when the
/// folder holds no usable audio.
pub fn playlist_import_from_folder(folder: &Path) -> Result<PlaylistImport, String> {
    if !folder.is_dir() {
        return Err(format!(
            "playlist folder `{}` was not found",
            folder.display()
        ));
    }
    let (mut import, _) = scan_playlist_folder(folder, None);
    if import.tracks.is_empty() {
        return Err(format!("{} has no readable audio tracks", import.title));
    }
    import.skipped = import.unreadable.len();
    Ok(import)
}

const TRACK_CACHE: &str = ".mxtp-tracks.json";

/// One ffprobe result, valid while the file keeps this size and mtime.
/// `duration_sec: None` records a file ffprobe could not read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedProbe {
    size: u64,
    mtime_ms: u64,
    duration_sec: Option<f32>,
    codec: Option<String>,
}

/// The folder's readable tracks, plus how many music-video variants were left out.
fn scan_playlist_folder(
    folder: &Path,
    requested: Option<&BTreeSet<usize>>,
) -> (PlaylistImport, usize) {
    let mut paths = fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_file() && is_supported_audio(path.extension()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    paths.sort_by_key(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });
    // Folders reused across downloads hold files from earlier requests; with
    // playlist_items only the requested positions count. A single-video folder
    // has no position prefixes and is kept whole.
    let any_indexed = paths.iter().any(|path| playlist_index(path).is_some());
    if let Some(requested) = requested.filter(|_| any_indexed) {
        paths.retain(|path| playlist_index(path).is_some_and(|index| requested.contains(&index)));
    }

    let cache_path = folder.join(TRACK_CACHE);
    let cached = fs::read(&cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, CachedProbe>>(&bytes).ok())
        .unwrap_or_default();
    let mut cache = cached.clone();
    // Without ffprobe nothing was really checked: never cache "unreadable" then,
    // or the files stay hidden after the tool comes back.
    let probe_tool_ok = audio_prep::resolve_ffprobe().is_ok();
    let mut tracks = Vec::new();
    let mut unreadable = Vec::new();
    let mut video_variants = 0;
    for path in paths {
        let path_string = path.to_string_lossy().to_string();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let title = path
            .file_stem()
            .map(|stem| strip_playlist_index(&stem.to_string_lossy()))
            .unwrap_or_else(|| path_string.clone());
        if youtube::is_video_variant_title(&title) {
            video_variants += 1;
            continue;
        }
        let (size, mtime_ms) = file_stamp(&path);
        let probe = match cache.get(&name) {
            Some(hit) if hit.size == size && hit.mtime_ms == mtime_ms => hit.clone(),
            _ => {
                let probe = match audio_prep::probe_audio(&path_string) {
                    Ok(meta) => CachedProbe {
                        size,
                        mtime_ms,
                        duration_sec: Some(meta.duration_sec),
                        codec: Some(meta.codec),
                    },
                    Err(error) => {
                        eprintln!("skipping unreadable audio `{path_string}`: {error}");
                        CachedProbe {
                            size,
                            mtime_ms,
                            duration_sec: None,
                            codec: None,
                        }
                    }
                };
                if probe.duration_sec.is_some() || probe_tool_ok {
                    cache.insert(name.clone(), probe.clone());
                }
                probe
            }
        };
        match probe.duration_sec {
            Some(duration_sec) => tracks.push(PlaylistTrack {
                id: path_string.clone(),
                title,
                duration_sec,
                path: path_string,
                codec: probe.codec.unwrap_or_else(|| "unknown".to_string()),
            }),
            None => unreadable.push(name),
        }
    }
    cache.retain(|name, _| folder.join(name).is_file());
    if cache != cached {
        write_track_cache(&cache_path, &cache);
    }

    (
        PlaylistImport {
            title: cached_playlist_title(folder),
            quality: "Best available source stream per track (no lossy re-encode)".to_string(),
            cover_path: playlist_cover_path(folder).map(|path| path.to_string_lossy().to_string()),
            tracks,
            skipped: 0,
            unreadable,
        },
        video_variants,
    )
}

fn file_stamp(path: &Path) -> (u64, u64) {
    let metadata = fs::metadata(path).ok();
    let size = metadata.as_ref().map(fs::Metadata::len).unwrap_or(0);
    let mtime_ms = metadata
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    (size, mtime_ms)
}

fn write_track_cache(path: &Path, cache: &HashMap<String, CachedProbe>) {
    let Some(dir) = path.parent() else {
        return;
    };
    let written = serde_json::to_vec(cache)
        .map_err(|err| err.to_string())
        .and_then(|json| {
            let mut temporary =
                tempfile::NamedTempFile::new_in(dir).map_err(|err| err.to_string())?;
            temporary.write_all(&json).map_err(|err| err.to_string())?;
            temporary
                .persist(path)
                .map(|_| ())
                .map_err(|err| err.error.to_string())
        });
    if let Err(error) = written {
        eprintln!(
            "could not cache track probes in `{}`: {error}",
            path.display()
        );
    }
}

/// The playlist position from a downloaded file's "NNN - " name prefix.
fn playlist_index(path: &Path) -> Option<usize> {
    let stem = path.file_stem()?.to_string_lossy();
    let (prefix, _) = stem.split_once(" - ")?;
    (prefix.len() == 3 && prefix.chars().all(|ch| ch.is_ascii_digit()))
        .then(|| prefix.parse().ok())
        .flatten()
}

fn requested_playlist_items(
    playlist_items: Option<&str>,
) -> Result<Option<BTreeSet<usize>>, String> {
    let Some(items) = playlist_items.filter(|items| !items.trim().is_empty()) else {
        return Ok(None);
    };
    // Positions start at 1; "0" would ask yt-dlp for nothing and has led to
    // the wrong audio being matched by position.
    if !Regex::new(r"^[1-9][0-9]*(-[1-9][0-9]*)?(,[1-9][0-9]*(-[1-9][0-9]*)?)*$")
        .unwrap()
        .is_match(items)
    {
        return Err(
            "playlist_items must be comma-separated positions from 1 or ranges (for example 1,3,7-9)"
                .to_string(),
        );
    }
    let mut requested = BTreeSet::new();
    for part in items.split(',') {
        let (from, to) = part.split_once('-').unwrap_or((part, part));
        let (from, to) = (
            from.parse::<usize>().map_err(|err| err.to_string())?,
            to.parse::<usize>().map_err(|err| err.to_string())?,
        );
        if from > to || to - from > 5_000 {
            return Err(format!("playlist item range `{part}` is not valid"));
        }
        requested.extend(from..=to);
    }
    Ok(Some(requested))
}

fn list_cached_playlists_sync(app: &AppHandle) -> Result<Vec<CachedPlaylist>, String> {
    let base = app_data_dir(app)?;
    let root = playlist_output_root(&base);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut playlists = fs::read_dir(&root)
        .map_err(|err| format!("failed to read cached playlists: {err}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|folder| {
            let playlist = playlist_import_from_folder(&folder).ok()?;
            // The sidecar rewrites its source marker on every download, so its
            // mtime is the last download; the folder's own mtime also moves
            // when the probe cache is written.
            let marker = folder.join(".mxtp-source.json");
            let (_, updated_at_ms) = file_stamp(if marker.is_file() { &marker } else { &folder });
            Some(CachedPlaylist {
                source_path: folder.to_string_lossy().to_string(),
                title: playlist.title,
                quality: playlist.quality,
                cover_path: playlist.cover_path,
                tracks: playlist.tracks,
                updated_at_ms,
                skipped: playlist.skipped,
            })
        })
        .collect::<Vec<_>>();
    playlists.sort_by_key(|playlist| std::cmp::Reverse(playlist.updated_at_ms));
    Ok(playlists)
}

pub fn playlist_cover_path(folder: &Path) -> Option<PathBuf> {
    ["cover.jpg", "cover.jpeg", "cover.png", "cover.webp"]
        .into_iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_file())
}

fn cached_playlist_title(folder: &Path) -> String {
    fs::read(folder.join(".mxtp-source.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("title")?.as_str().map(str::to_string))
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            folder
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "YouTube playlist".to_string())
}

fn validate_youtube_url(url: &str) -> Result<(), String> {
    let valid = reqwest::Url::parse(url).ok().is_some_and(|url| {
        matches!(url.scheme(), "https" | "http")
            && url.host_str().is_some_and(|host| {
                matches!(
                    host.to_ascii_lowercase().as_str(),
                    "youtube.com"
                        | "www.youtube.com"
                        | "m.youtube.com"
                        | "music.youtube.com"
                        | "youtu.be"
                )
            })
    });
    if valid {
        Ok(())
    } else {
        Err("paste a valid YouTube playlist URL".to_string())
    }
}

/// Checked before the download starts: syntax, no position 0, and sane ranges.
fn validate_playlist_items(playlist_items: Option<&str>) -> Result<(), String> {
    requested_playlist_items(playlist_items).map(drop)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_playlist_download_args(
    url: &str,
    out_root: &Path,
    playlist_items: Option<&str>,
) -> Result<Vec<String>, String> {
    validate_playlist_items(playlist_items)?;
    let mut args = vec![
        "-Format".to_string(),
        "best".to_string(),
        "-OutRoot".to_string(),
        out_root.to_string_lossy().to_string(),
        "-NoPause".to_string(),
        "-Url".to_string(),
        url.to_string(),
    ];
    if let Some(items) = playlist_items.filter(|items| !items.trim().is_empty()) {
        args.push("-PlaylistItems".to_string());
        args.push(items.to_string());
    }
    Ok(args)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct UnixPlaylistRuntime {
    python: PathBuf,
    path: std::ffi::OsString,
    yt_dlp: PathBuf,
    ffmpeg: PathBuf,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_playlist_runtime() -> Result<UnixPlaylistRuntime, String> {
    let python = crate::resolve_executable("Python 3", "python3", "MXTP_PYTHON_PATH", &[])?;
    let yt_dlp = crate::resolve_executable("yt-dlp", "yt-dlp", "MXTP_YTDLP_PATH", &[])
        .map_err(|_| youtube::YT_DLP_MISSING.to_string())?;
    let ffmpeg = audio_prep::resolve_ffmpeg()?;
    let mut search_dirs = [python.as_path(), yt_dlp.as_path(), ffmpeg.as_path()]
        .into_iter()
        .filter_map(Path::parent)
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("PATH") {
        search_dirs.extend(std::env::split_paths(&path));
    }
    search_dirs.dedup();
    let path = std::env::join_paths(search_dirs)
        .map_err(|err| format!("failed to prepare playlist tool PATH: {err}"))?;
    Ok(UnixPlaylistRuntime {
        python,
        path,
        yt_dlp,
        ffmpeg,
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn playlist_tool_path(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join("tools").join("playlist_fetch.py"));
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return Ok(path);
    }
    let path = unix_playlist_tool_fallback_path();
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Playlist to MP3 tool was not found at `{}`",
            path.display()
        ))
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_playlist_tool_fallback_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("playlist_fetch.py")
}

#[cfg(windows)]
fn playlist_tool_path(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join("tools").join("Get-PlaylistMp3.ps1"));
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return Ok(path);
    }
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("Get-PlaylistMp3.ps1");
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Playlist to MP3 tool was not found at `{}`",
            path.display()
        ))
    }
}

fn playlist_output_root(base: &Path) -> PathBuf {
    base.join("MXTP MKR").join("playlists")
}

fn is_supported_audio(extension: Option<&OsStr>) -> bool {
    extension
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|extension| {
            matches!(
                extension.as_str(),
                "mp3" | "m4a" | "opus" | "webm" | "flac" | "wav" | "ogg" | "aac"
            )
        })
}

fn strip_playlist_index(title: &str) -> String {
    title
        .split_once(" - ")
        .filter(|(prefix, _)| prefix.len() == 3 && prefix.chars().all(|ch| ch.is_ascii_digit()))
        .map(|(_, title)| title.to_string())
        .unwrap_or_else(|| title.to_string())
}

#[tauri::command]
pub async fn list_burners() -> Result<Vec<DriveInfo>, String> {
    run_blocking(burn::list_burners).await
}

/// Build the CD-DA image for prepared PCM. A program longer than an 80-minute
/// CD-R is refused, and on any error the scratch WAVs are deleted because no
/// burn will follow to clean them up.
#[tauri::command]
pub fn build_cda_image(
    tracks: Vec<PcmTrack>,
    cd_text: Option<CdTextMetadata>,
) -> Result<CdaImage, String> {
    let scratch = tracks
        .iter()
        .map(|track| track.path.clone())
        .collect::<Vec<_>>();
    let result = match audio_prep::capacity_error(&tracks) {
        Some(error) => Err(error),
        None => burn::build_cda_image_with_cd_text(tracks, cd_text),
    };
    if result.is_err() {
        audio_prep::discard_scratch_wavs(scratch.iter().map(String::as_str));
    }
    result
}

/// Burn (or simulate) the image, then delete its scratch WAVs whether or not
/// the burn succeeded.
#[tauri::command]
pub async fn burn_cda(
    image: CdaImage,
    drive: String,
    simulate: bool,
) -> Result<BurnResult, String> {
    let scratch = image
        .tracks
        .iter()
        .map(|track| track.path.clone())
        .collect::<Vec<_>>();
    let result = run_blocking(move || burn::burn_cda(image, &drive, simulate)).await;
    audio_prep::discard_scratch_wavs(scratch.iter().map(String::as_str));
    result
}

#[tauri::command]
pub async fn compose_pdf(app: AppHandle, piece: ComposePdfRequest) -> Result<PdfInfo, String> {
    let base = app_data_dir(&app)?;
    run_blocking(move || compose_pdf_under(&base, piece)).await
}

/// Compose one print PDF. A relative output dir lands under
/// `<app data>/MXTP MKR/`; an absolute one is used as given.
pub fn compose_pdf_under(app_data: &Path, mut piece: ComposePdfRequest) -> Result<PdfInfo, String> {
    piece.output_dir = resolve_output_dir(app_data, &piece.output_dir)?;
    fs::create_dir_all(&piece.output_dir).map_err(|err| {
        format!(
            "couldn't create the export folder `{}`: {err}",
            piece.output_dir.display()
        )
    })?;
    pdf_compose::compose_pdf_for_id(piece)
}

pub fn resolve_output_dir(app_data: &Path, output_dir: &Path) -> Result<PathBuf, String> {
    if output_dir.is_absolute() {
        return Ok(output_dir.to_path_buf());
    }
    if output_dir.as_os_str().is_empty()
        || !output_dir
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "export folder `{}` must stay inside the app's data",
            output_dir.display()
        ));
    }
    Ok(app_data.join("MXTP MKR").join(output_dir))
}

const PICKED_ART_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Copy a picture picked from anywhere on disk into app data, so a saved
/// project's art stays inside the asset scope after a restart.
#[tauri::command]
pub async fn copy_art_file(app: AppHandle, path: String) -> Result<String, String> {
    let base = app_data_dir(&app)?;
    run_blocking(move || {
        copy_art_file_into(&base, Path::new(&path)).map(|path| path.to_string_lossy().to_string())
    })
    .await
}

pub fn copy_art_file_into(app_data: &Path, source: &Path) -> Result<PathBuf, String> {
    let extension = source
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .filter(|extension| matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp"))
        .ok_or_else(|| "Pick a JPEG, PNG or WebP picture.".to_string())?;
    let metadata = fs::metadata(source)
        .map_err(|err| format!("couldn't read `{}`: {err}", source.display()))?;
    if !metadata.is_file() {
        return Err(format!("`{}` is not a file", source.display()));
    }
    if metadata.len() > PICKED_ART_MAX_BYTES {
        return Err("That picture is larger than 64 MB.".to_string());
    }
    let bytes =
        fs::read(source).map_err(|err| format!("couldn't read `{}`: {err}", source.display()))?;
    let dir = app_data.join("MXTP MKR").join("covers").join("picked");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("couldn't create `{}`: {err}", dir.display()))?;
    let hash = fnv1a64(&bytes);
    for attempt in 0_u32.. {
        let name = if attempt == 0 {
            format!("{hash:016x}.{extension}")
        } else {
            format!("{hash:016x}-{attempt}.{extension}")
        };
        let destination = dir.join(name);
        match fs::read(&destination) {
            Ok(existing) if existing == bytes => {
                return destination.canonicalize().map_err(|err| err.to_string())
            }
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut temporary =
                    tempfile::NamedTempFile::new_in(&dir).map_err(|err| err.to_string())?;
                temporary.write_all(&bytes).map_err(|err| err.to_string())?;
                temporary
                    .persist(&destination)
                    .map_err(|err| err.error.to_string())?;
                return destination.canonicalize().map_err(|err| err.to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    unreachable!("u32 name suffixes cannot be exhausted in practice")
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// Whether original-cover edits can run: both Cloudflare variables are set.
/// Only the yes/no leaves the backend, never the values.
#[tauri::command]
pub fn cover_edit_available() -> bool {
    cover_edit_available_from(|name| std::env::var(name).ok())
}

pub fn cover_edit_available_from(get: impl Fn(&str) -> Option<String>) -> bool {
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]
        .iter()
        .all(|name| get(name).is_some_and(|value| !value.trim().is_empty()))
}

#[tauri::command]
pub async fn lookup_album(artist: String, album: String) -> Result<AlbumInfo, String> {
    run_blocking(move || research::lookup_album(&artist, &album)).await
}

#[tauri::command]
pub async fn fetch_lyrics(artist: String, title: String) -> Result<String, String> {
    run_blocking(move || research::fetch_lyrics(&artist, &title)).await
}

#[tauri::command]
pub async fn generate_cover(
    prompt: String,
    style_refs: Vec<String>,
) -> Result<GeneratedCover, String> {
    run_blocking(move || research::generate_cover(&prompt, &style_refs)).await
}

#[tauri::command]
pub async fn edit_cover_from_original(
    source_image_path: String,
    instruction: String,
) -> Result<GeneratedCover, String> {
    run_blocking(move || research::edit_cover_from_original(&source_image_path, &instruction)).await
}

#[tauri::command]
pub async fn fetch_cover_theme(cover_art_urls: Vec<String>) -> Result<CoverTheme, String> {
    run_blocking(move || research::fetch_cover_theme(&cover_art_urls)).await
}

#[tauri::command]
pub async fn fetch_real_cover_file(cover_art_urls: Vec<String>) -> Result<RealCover, String> {
    run_blocking(move || research::fetch_real_cover_file(&cover_art_urls)).await
}

#[tauri::command]
pub async fn art_direct_from_references(
    album_label: String,
    cover_art_urls: Vec<String>,
    era_ref_urls: Vec<String>,
) -> Result<String, String> {
    run_blocking(move || {
        research::art_direct_from_references(&album_label, &cover_art_urls, &era_ref_urls)
    })
    .await
}

#[tauri::command]
pub async fn fetch_era_covers(
    artist: String,
    year: u16,
    limit: usize,
) -> Result<Vec<String>, String> {
    run_blocking(move || research::fetch_era_covers(&artist, year, limit)).await
}

/// Run a synchronous, potentially slow operation (subprocess shell-out, network
/// call) on the async runtime's blocking pool so the webview main thread never
/// freezes while a command is in flight.
async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_url_validation_uses_the_parsed_host() {
        assert!(validate_youtube_url("https://music.youtube.com/playlist?list=PL123").is_ok());
        assert!(validate_youtube_url("http://attacker.example/x?y=youtube.com/").is_err());
    }

    #[test]
    fn playlist_items_accept_only_numbers_and_ranges() {
        assert!(validate_playlist_items(None).is_ok());
        assert!(validate_playlist_items(Some("")).is_ok());
        assert!(validate_playlist_items(Some("1,3,7-9")).is_ok());
        assert!(validate_playlist_items(Some("1;Remove-Item C:\\")).is_err());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn unix_playlist_fetch_uses_the_native_python_resource() {
        let script = unix_playlist_tool_fallback_path();
        assert!(script.is_file(), "{}", script.display());
        assert_eq!(
            script.file_name().and_then(|name| name.to_str()),
            Some("playlist_fetch.py")
        );
        assert_ne!(
            script.extension().and_then(|extension| extension.to_str()),
            Some("ps1")
        );
    }

    #[test]
    fn playlist_items_reject_position_zero() {
        assert!(validate_playlist_items(Some("0")).is_err());
        assert!(validate_playlist_items(Some("1,0")).is_err());
        assert!(validate_playlist_items(Some("0-3")).is_err());
        assert!(validate_playlist_items(Some("10,20-21")).is_ok());
        assert_eq!(
            requested_playlist_items(Some("1,3-4")).unwrap(),
            Some(BTreeSet::from([1, 3, 4]))
        );
        assert!(requested_playlist_items(Some("4-2")).is_err());
        assert!(validate_playlist_items(Some("4-2")).is_err());
        assert!(validate_playlist_items(Some("1-9000")).is_err());
    }

    #[test]
    fn relative_export_dirs_stay_under_app_data() {
        let base = Path::new("/data/app");
        assert_eq!(
            resolve_output_dir(base, Path::new("exports/p1/t1")).unwrap(),
            base.join("MXTP MKR").join("exports/p1/t1")
        );
        let absolute = std::env::temp_dir().join("mxtp-abs");
        assert_eq!(resolve_output_dir(base, &absolute).unwrap(), absolute);
        assert!(resolve_output_dir(base, Path::new("../outside")).is_err());
        assert!(resolve_output_dir(base, Path::new("")).is_err());
    }

    #[test]
    fn cover_edit_availability_needs_both_cloudflare_values_and_returns_only_a_bool() {
        let both = |name: &str| Some(format!("secret-{name}"));
        assert!(cover_edit_available_from(both));
        let one = |name: &str| (name == "CLOUDFLARE_ACCOUNT_ID").then(|| "secret".to_string());
        assert!(!cover_edit_available_from(one));
        let blank = |_: &str| Some("  ".to_string());
        assert!(!cover_edit_available_from(blank));
        let json = serde_json::to_string(&cover_edit_available_from(both)).unwrap();
        assert_eq!(json, "true");
    }

    #[test]
    fn picked_art_is_copied_into_app_data_once() {
        let outside = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let picture = outside.path().join("Holiday Photo.JPG");
        fs::write(&picture, b"jpeg bytes").unwrap();

        let copied = copy_art_file_into(app_data.path(), &picture).unwrap();
        let picked = app_data
            .path()
            .join("MXTP MKR")
            .join("covers")
            .join("picked")
            .canonicalize()
            .unwrap();
        assert!(copied.is_absolute());
        assert!(copied.starts_with(&picked), "{}", copied.display());
        assert_eq!(copied.extension().unwrap(), "jpg");
        assert_eq!(fs::read(&copied).unwrap(), b"jpeg bytes");
        assert_eq!(
            copy_art_file_into(app_data.path(), &picture).unwrap(),
            copied
        );

        let not_art = outside.path().join("notes.txt");
        fs::write(&not_art, b"x").unwrap();
        assert!(copy_art_file_into(app_data.path(), &not_art).is_err());
    }

    #[test]
    fn playlist_index_reads_the_three_digit_prefix() {
        assert_eq!(playlist_index(Path::new("/x/001 - Song.opus")), Some(1));
        assert_eq!(
            playlist_index(Path::new("/x/042 - Song - Live.m4a")),
            Some(42)
        );
        assert_eq!(playlist_index(Path::new("/x/Song.opus")), None);
        assert_eq!(playlist_index(Path::new("/x/1 - Song.opus")), None);
    }

    #[test]
    fn playlist_cache_marker_preserves_title_when_folder_has_identity_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("Greatest Hits [source-hash]");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join(".mxtp-source.json"),
            r#"{"source":"youtube-playlist:SECOND","title":"Greatest Hits"}"#,
        )
        .unwrap();

        assert_eq!(cached_playlist_title(&folder), "Greatest Hits");
    }
}
