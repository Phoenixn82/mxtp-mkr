use crate::hidden_command;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedAlbumTrack {
    pub title: String,
    pub duration_sec: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeAlbumMatch {
    pub url: String,
    pub title: String,
    pub artist: String,
    pub track_count: usize,
    pub confidence: f32,
    pub explanation: String,
    pub track_positions: Vec<YouTubeTrackPosition>,
    pub safe_track_positions: Vec<usize>,
    pub tracks: Vec<YouTubeAlbumTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeTrackPosition {
    pub title: String,
    pub position: usize,
}

/// A verified release entry returned before any audio is downloaded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeAlbumTrack {
    pub title: String,
    pub duration_sec: f32,
    pub position: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeTrackMatch {
    pub url: String,
    pub title: String,
    pub artist: String,
    pub confidence: f32,
    pub explanation: String,
}

#[derive(Debug, Clone)]
struct TrackCandidate {
    url: String,
    title: String,
    artist: String,
    duration_sec: f32,
    rank: usize,
}

#[derive(Debug, Clone)]
struct Candidate {
    url: String,
    title: String,
    artist: String,
    tracks: Vec<CandidateTrack>,
    rank: usize,
}

#[derive(Debug, Clone)]
struct CandidateTrack {
    title: String,
    duration_sec: f32,
    position: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlbumMatchModel {
    bias: f32,
    weights: HashMap<String, f32>,
    minimum_confidence: f32,
    minimum_track_coverage: f32,
}

#[derive(Debug, Clone, Default)]
struct Features {
    title: f32,
    artist: f32,
    track_coverage: f32,
    track_order: f32,
    duration: f32,
    count: f32,
    official: f32,
    bad_variant: f32,
    search_rank: f32,
}

pub fn find_best_album_playlist(
    app: &AppHandle,
    artist: &str,
    album: &str,
    expected_tracks: &[ExpectedAlbumTrack],
) -> Result<YouTubeAlbumMatch, String> {
    let artist = artist.trim();
    let album = album.trim();
    if artist.is_empty() || album.is_empty() {
        return Err("enter both an artist and album first".to_string());
    }
    let tool = yt_dlp_path(app)?;
    let js_args = js_runtime_args(app);
    let query_text = format!("{artist} {album} official album");
    let query = urlencoding::encode(&query_text);
    let search_url =
        format!("https://www.youtube.com/results?search_query={query}&sp=EgIQAw%3D%3D");
    let mut args = js_args.clone();
    args.extend([
        "--flat-playlist".to_string(),
        "--no-warnings".to_string(),
        "--ignore-errors".to_string(),
        "--playlist-end".to_string(),
        "20".to_string(),
        "--dump-json".to_string(),
        "--".to_string(),
        search_url,
    ]);
    let output = hidden_command(&tool)
        .args(&args)
        .output()
        .map_err(|err| format!("Couldn't start yt-dlp: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "YouTube search failed: {}",
            short_tool_error("yt-dlp album search", &output)
        ));
    }
    let album_key = normalize(album);
    let search_results = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            let title = value.get("title")?.as_str()?.to_string();
            let url = value
                .get("webpage_url")
                .or_else(|| value.get("url"))?
                .as_str()?
                .to_string();
            is_album_search_hit(&title, album, &album_key).then_some((url, title))
        })
        .take(8)
        .collect::<Vec<_>>();

    let mut candidates = Vec::new();
    for (rank, (url, search_title)) in search_results.into_iter().enumerate() {
        if let Ok(candidate) =
            probe_candidate(&tool, &js_args, &url, search_title, rank, expected_tracks)
        {
            candidates.push(candidate);
        }
    }
    if candidates.is_empty() {
        return Err(untrusted_release(
            artist,
            album,
            "no album playlists came up in the search",
        ));
    }

    let model = load_model(app);
    let mut scored = candidates
        .into_iter()
        .map(|candidate| {
            let features = candidate_features(&candidate, artist, album, expected_tracks);
            let confidence = model.predict(&features);
            (candidate, features, confidence)
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.2.total_cmp(&left.2));
    let (best, features, confidence) = &scored[0];
    let evidence_ok = expected_tracks.is_empty()
        || (features.track_coverage >= model.minimum_track_coverage
            && features.track_order >= 0.55);
    if *confidence < model.minimum_confidence || !evidence_ok {
        eprintln!(
            "album match gate for {artist} / {album}: {}",
            scored
                .iter()
                .take(3)
                .map(|(candidate, _, score)| format!("{} ({:.0}%)", candidate.title, score * 100.0))
                .collect::<Vec<_>>()
                .join("; ")
        );
        let reason = if evidence_ok {
            format!(
                "the closest match, \"{}\", did not look enough like it",
                best.title
            )
        } else if features.track_coverage < model.minimum_track_coverage {
            format!(
                "the closest match, \"{}\", only had {:.0}% of the album's tracks",
                best.title,
                features.track_coverage * 100.0
            )
        } else {
            format!(
                "the closest match, \"{}\", had the tracks out of order",
                best.title
            )
        };
        return Err(untrusted_release(artist, album, &reason));
    }
    Ok(YouTubeAlbumMatch {
        url: best.url.clone(),
        title: best.title.clone(),
        artist: best.artist.clone(),
        track_count: best.tracks.len(),
        confidence: *confidence,
        explanation: format!(
            "Verified locally: {:.0}% track coverage, {:.0}% order agreement, {:.0}% duration agreement",
            features.track_coverage * 100.0,
            features.track_order * 100.0,
            features.duration * 100.0
        ),
        track_positions: matched_track_positions(&best.tracks, expected_tracks),
        safe_track_positions: best.tracks.iter().map(|track| track.position).collect(),
        tracks: best
            .tracks
            .iter()
            .map(|track| YouTubeAlbumTrack {
                title: track.title.clone(),
                duration_sec: track.duration_sec,
                position: track.position,
            })
            .collect(),
    })
}

fn matched_track_positions(
    candidate: &[CandidateTrack],
    expected: &[ExpectedAlbumTrack],
) -> Vec<YouTubeTrackPosition> {
    expected
        .iter()
        .filter_map(|track| {
            candidate
                .iter()
                .map(|candidate| {
                    (
                        candidate.position,
                        text_similarity(&candidate.title, &track.title),
                    )
                })
                .max_by(|left, right| left.1.total_cmp(&right.1))
                .filter(|(_, score)| *score >= 0.68)
                .map(|(position, _)| YouTubeTrackPosition {
                    title: track.title.clone(),
                    position,
                })
        })
        .collect()
}

pub fn find_best_track(
    app: &AppHandle,
    artist: &str,
    title: &str,
    duration_sec: f32,
) -> Result<YouTubeTrackMatch, String> {
    let artist = artist.trim();
    let title = title.trim();
    if artist.is_empty() || title.is_empty() {
        return Err("enter both an artist and track title first".to_string());
    }
    let tool = yt_dlp_path(app)?;
    let js_args = js_runtime_args(app);
    let mut args = js_args;
    args.extend([
        "--flat-playlist".to_string(),
        "--no-warnings".to_string(),
        "--ignore-errors".to_string(),
        "--playlist-end".to_string(),
        "8".to_string(),
        "--dump-json".to_string(),
        "--".to_string(),
        format!("ytsearch8:{artist} {title} official audio"),
    ]);
    let output = hidden_command(&tool)
        .args(args)
        .output()
        .map_err(|err| format!("Couldn't start yt-dlp: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "YouTube track search failed: {}",
            short_tool_error("yt-dlp track search", &output)
        ));
    }
    let mut scored = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .enumerate()
        .filter_map(|(rank, value)| {
            Some(TrackCandidate {
                url: string_value(&value, &["webpage_url", "url"])?,
                title: string_value(&value, &["title"])?,
                artist: string_value(&value, &["channel", "uploader"]).unwrap_or_default(),
                duration_sec: value
                    .get("duration")
                    .and_then(Value::as_f64)
                    .unwrap_or_default() as f32,
                rank,
            })
        })
        .filter(|candidate| !has_unrequested_video_variant(&candidate.title, title))
        .map(|candidate| {
            let evidence = track_candidate_evidence(&candidate, artist, title, duration_sec);
            (candidate, evidence)
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.1 .0.total_cmp(&left.1 .0));
    let (best, (confidence, title_score, artist_score, duration_score)) = scored
        .first()
        .ok_or_else(|| untrusted_upload(artist, title, "no audio uploads came up in the search"))?;
    if *confidence < 0.72 || *title_score < 0.62 || *artist_score < 0.5 {
        eprintln!(
            "track match gate for {artist} / {title}: {}",
            scored
                .iter()
                .take(3)
                .map(|(candidate, evidence)| {
                    format!("{} ({:.0}%)", candidate.title, evidence.0 * 100.0)
                })
                .collect::<Vec<_>>()
                .join("; ")
        );
        return Err(untrusted_upload(
            artist,
            title,
            &format!(
                "the closest match, \"{}\", did not look enough like it",
                best.title
            ),
        ));
    }
    Ok(YouTubeTrackMatch {
        url: best.url.clone(),
        title: best.title.clone(),
        artist: best.artist.clone(),
        confidence: *confidence,
        explanation: format!(
            "Verified locally: {:.0}% title agreement, {:.0}% artist agreement, {:.0}% duration agreement",
            title_score * 100.0,
            artist_score * 100.0,
            duration_score * 100.0
        ),
    })
}

fn track_candidate_evidence(
    candidate: &TrackCandidate,
    artist: &str,
    title: &str,
    duration_sec: f32,
) -> (f32, f32, f32, f32) {
    if has_unrequested_video_variant(&candidate.title, title) {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let candidate_title = candidate.title.replace(artist, "");
    let title_score =
        text_similarity(&candidate_title, title).max(text_similarity(&candidate.title, title));
    let artist_score = text_similarity(&candidate.artist.replace(" - Topic", ""), artist)
        .max(text_similarity(&candidate.title, artist));
    let duration_score = if duration_sec > 0.0 && candidate.duration_sec > 0.0 {
        (1.0 - (duration_sec - candidate.duration_sec).abs() / 20.0).clamp(0.0, 1.0)
    } else {
        0.5
    };
    let joined = format!("{} {}", candidate.title, candidate.artist).to_ascii_lowercase();
    let official = (joined.contains("topic") || joined.contains("official audio")) as u8 as f32;
    let bad_variant =
        has_unrequested_bad_variant(&joined, &format!("{artist} {title}")) as u8 as f32;
    let rank = 1.0 - (candidate.rank as f32 / 8.0).min(1.0);
    let confidence = (title_score * 0.48
        + artist_score * 0.25
        + duration_score * 0.12
        + official * 0.1
        + rank * 0.05
        - bad_variant * 0.35)
        .clamp(0.0, 1.0);
    (confidence, title_score, artist_score, duration_score)
}

fn probe_candidate(
    tool: &Path,
    js_args: &[String],
    url: &str,
    search_title: String,
    rank: usize,
    expected_tracks: &[ExpectedAlbumTrack],
) -> Result<Candidate, String> {
    let mut args = js_args.to_vec();
    args.extend([
        "--flat-playlist".to_string(),
        "--no-warnings".to_string(),
        "--ignore-errors".to_string(),
        "--playlist-end".to_string(),
        "40".to_string(),
        "--dump-single-json".to_string(),
        "--".to_string(),
        url.to_string(),
    ]);
    let output = hidden_command(tool)
        .args(args)
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|err| err.to_string())?;
    let title = string_value(&value, &["title", "playlist_title"]).unwrap_or(search_title);
    let artist =
        string_value(&value, &["channel", "uploader", "playlist_uploader"]).unwrap_or_default();
    let tracks = safe_album_tracks(&value, expected_tracks);
    if tracks.len() < 2 {
        return Err("candidate is not an album playlist".to_string());
    }
    Ok(Candidate {
        url: url.to_string(),
        title,
        artist,
        tracks,
        rank,
    })
}

fn safe_album_tracks(value: &Value, expected_tracks: &[ExpectedAlbumTrack]) -> Vec<CandidateTrack> {
    let mut unique = HashMap::<String, (CandidateTrack, u8)>::new();
    for (index, entry) in value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(title) = entry.get("title").and_then(Value::as_str) else {
            continue;
        };
        if is_unsafe_album_video_variant(title, expected_tracks) {
            continue;
        }
        let artist = string_value(entry, &["channel", "uploader"]).unwrap_or_default();
        let track = CandidateTrack {
            title: title.to_string(),
            duration_sec: entry
                .get("duration")
                .and_then(Value::as_f64)
                .unwrap_or_default() as f32,
            position: index + 1,
        };
        let key = album_track_variant_key(title, expected_tracks);
        let preference = audio_preference(title, &artist);
        match unique.get_mut(&key) {
            Some((current, current_preference)) if preference > *current_preference => {
                *current = track;
                *current_preference = preference;
            }
            None => {
                unique.insert(key, (track, preference));
            }
            _ => {}
        }
    }
    let mut tracks = unique
        .into_values()
        .map(|(track, _)| track)
        .collect::<Vec<_>>();
    tracks.sort_by_key(|track| track.position);
    tracks
}

/// Reaction, karaoke, cover, nightcore, slowed, sped-up and live uploads, as
/// whole words ("Olive", "Deliver" and "Discover" are fine), unless the
/// request itself names them.
fn has_unrequested_bad_variant(candidate: &str, requested: &str) -> bool {
    let candidate = marker_text(candidate);
    let requested = marker_text(requested);
    [
        "reaction",
        "karaoke",
        "cover",
        "nightcore",
        "slowed",
        "sped up",
        "live",
    ]
    .iter()
    .any(|term| contains_marker(&candidate, term) && !contains_marker(&requested, term))
}

/// Whether a search result's title is close enough to the album to probe.
/// An album name with no letters or digits has an empty key, and every title
/// "contains" the empty string, so an empty key never matches by containment.
fn is_album_search_hit(title: &str, album: &str, album_key: &str) -> bool {
    text_similarity(title, album) >= 0.45
        || (!album_key.is_empty() && normalize(title).contains(album_key))
}

/// A music-video, lyric-video, official-video or visualizer upload: any
/// bracket group holding the word video or visualizer ("Song (Official HD
/// Video) [4K]"), or a separator suffix that ends the title or is followed only
/// by brackets ("Song - Visualizer", "Song - Official Video (Remastered)").
/// An unbracketed explicit phrase at the end counts too ("Song Official Music
/// Video"). "Video Games" and "Home Video" are song titles, not variants.
pub fn is_video_variant_title(title: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)[(\[][^)\]]*\b(?:video|visuali[sz]er)\b[^)\]]*[)\]]|\s[-\x{2013}\x{2014}|:]\s*(?:official\s+)?(?:(?:hd|4k|music|lyric)\s+)*(?:video|visuali[sz]er)\s*(?:[(\[].*)?$|\b(?:official\s+(?:(?:hd|4k|music|lyric)\s+)*video|(?:music|lyric)\s+video|official\s+visuali[sz]er)\s*(?:[(\[].*)?$",
            )
            .expect("video variant pattern is valid")
        })
        .is_match(title)
}

fn is_unsafe_album_video_variant(title: &str, expected: &[ExpectedAlbumTrack]) -> bool {
    if expected.is_empty() {
        return is_video_variant_title(title);
    }
    contains_video_marker(title)
        && !expected.iter().any(|track| {
            !has_unrequested_video_variant(title, &track.title)
                && text_similarity(title, &track.title) >= 0.68
        })
}

fn has_unrequested_video_variant(candidate_title: &str, requested_title: &str) -> bool {
    let candidate = marker_text(candidate_title);
    let requested = marker_text(requested_title);
    [
        "music video",
        "official video",
        "visualizer",
        "visualiser",
        "video",
    ]
    .iter()
    .any(|marker| contains_marker(&candidate, marker) && !contains_marker(&requested, marker))
}

fn contains_video_marker(title: &str) -> bool {
    let title = marker_text(title);
    [
        "music video",
        "official video",
        "visualizer",
        "visualiser",
        "video",
    ]
    .iter()
    .any(|marker| contains_marker(&title, marker))
}

fn marker_text(value: &str) -> String {
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn contains_marker(value: &str, marker: &str) -> bool {
    format!(" {value} ").contains(&format!(" {marker} "))
}

fn album_track_variant_key(title: &str, expected: &[ExpectedAlbumTrack]) -> String {
    expected
        .iter()
        .map(|track| (&track.title, text_similarity(title, &track.title)))
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .filter(|(_, score)| *score >= 0.68)
        .map(|(title, _)| format!("expected:{}", normalize(title)))
        .unwrap_or_else(|| normalized_track_variant(title))
}

fn normalized_track_variant(title: &str) -> String {
    title
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| {
            !token.is_empty()
                && !matches!(
                    *token,
                    "official"
                        | "audio"
                        | "video"
                        | "visualizer"
                        | "visualiser"
                        | "lyric"
                        | "lyrics"
                        | "hd"
                        | "4k"
                )
        })
        .collect()
}

fn audio_preference(title: &str, artist: &str) -> u8 {
    let joined = format!("{title} {artist}").to_ascii_lowercase();
    (joined.contains(" - topic") as u8) * 2
        + (joined.contains("official audio") as u8) * 2
        + (joined.contains(" audio") as u8)
}

fn candidate_features(
    candidate: &Candidate,
    artist: &str,
    album: &str,
    expected: &[ExpectedAlbumTrack],
) -> Features {
    let title = text_similarity(&candidate.title, album);
    let artist_score = text_similarity(&candidate.artist.replace(" - Topic", ""), artist);
    let (track_coverage, track_order, duration) = track_evidence(&candidate.tracks, expected);
    let count = if expected.is_empty() {
        (candidate.tracks.len().min(30) as f32 / 30.0).max(0.2)
    } else {
        1.0 - (candidate.tracks.len().abs_diff(expected.len()) as f32
            / expected.len().max(1) as f32)
            .min(1.0)
    };
    let joined = format!("{} {}", candidate.title, candidate.artist).to_ascii_lowercase();
    let official =
        if joined.contains("topic") || joined.contains("official album") || artist_score > 0.92 {
            1.0
        } else {
            0.0
        };
    let bad_variant =
        has_unrequested_bad_variant(&joined, &format!("{artist} {album}")) as u8 as f32;
    Features {
        title,
        artist: artist_score,
        track_coverage,
        track_order,
        duration,
        count,
        official,
        bad_variant,
        search_rank: 1.0 - (candidate.rank as f32 / 8.0).min(1.0),
    }
}

fn track_evidence(
    candidate: &[CandidateTrack],
    expected: &[ExpectedAlbumTrack],
) -> (f32, f32, f32) {
    if expected.is_empty() {
        return (0.5, 0.5, 0.5);
    }
    let mut matched_indexes = Vec::new();
    let mut duration_scores = Vec::new();
    for expected_track in expected {
        let best = candidate
            .iter()
            .enumerate()
            .map(|(index, track)| (index, text_similarity(&track.title, &expected_track.title)))
            .max_by(|left, right| left.1.total_cmp(&right.1));
        if let Some((index, _score)) = best.filter(|(_, score)| *score >= 0.68) {
            matched_indexes.push(index);
            let actual = candidate[index].duration_sec;
            if actual > 0.0 && expected_track.duration_sec > 0.0 {
                let difference = (actual - expected_track.duration_sec).abs();
                duration_scores.push((1.0 - difference / 30.0).clamp(0.0, 1.0));
            }
        }
    }
    let coverage = matched_indexes.len() as f32 / expected.len() as f32;
    let ordered = matched_indexes
        .windows(2)
        .filter(|pair| pair[0] < pair[1])
        .count();
    let order = if matched_indexes.len() < 2 {
        coverage
    } else {
        ordered as f32 / (matched_indexes.len() - 1) as f32
    };
    let duration = if duration_scores.is_empty() {
        0.5
    } else {
        duration_scores.iter().sum::<f32>() / duration_scores.len() as f32
    };
    (coverage, order, duration)
}

impl AlbumMatchModel {
    fn predict(&self, features: &Features) -> f32 {
        let values = [
            ("title", features.title),
            ("artist", features.artist),
            ("trackCoverage", features.track_coverage),
            ("trackOrder", features.track_order),
            ("duration", features.duration),
            ("count", features.count),
            ("official", features.official),
            ("badVariant", features.bad_variant),
            ("searchRank", features.search_rank),
        ];
        let linear = values.iter().fold(self.bias, |score, (name, value)| {
            score + self.weights.get(*name).copied().unwrap_or_default() * value
        });
        1.0 / (1.0 + (-linear).exp())
    }
}

fn load_model(app: &AppHandle) -> AlbumMatchModel {
    let path = resource_path(app, "album-match-model.json");
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(default_model)
}

fn default_model() -> AlbumMatchModel {
    AlbumMatchModel {
        bias: -5.4,
        weights: HashMap::from([
            ("title".to_string(), 1.8),
            ("artist".to_string(), 2.2),
            ("trackCoverage".to_string(), 3.7),
            ("trackOrder".to_string(), 2.1),
            ("duration".to_string(), 1.0),
            ("count".to_string(), 1.2),
            ("official".to_string(), 0.8),
            ("badVariant".to_string(), -3.0),
            ("searchRank".to_string(), 0.2),
        ]),
        minimum_confidence: 0.78,
        minimum_track_coverage: 0.7,
    }
}

pub const YT_DLP_MISSING: &str = "yt-dlp was not found. Install yt-dlp or set MXTP_YTDLP_PATH.";

pub fn yt_dlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        crate::resolve_executable("yt-dlp", "yt-dlp", "MXTP_YTDLP_PATH", &[])
            .map_err(|_| YT_DLP_MISSING.to_string())
    }

    #[cfg(windows)]
    {
        let bundled = resource_path(app, "yt-dlp.exe");
        if bundled.is_file() {
            Ok(bundled)
        } else {
            crate::resolve_executable("yt-dlp", "yt-dlp", "MXTP_YTDLP_PATH", &[])
                .map_err(|_| YT_DLP_MISSING.to_string())
        }
    }
}

pub fn node_path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        let _ = app;
        crate::resolve_executable("node", "node", "MXTP_NODE_PATH", &[]).ok()
    }

    #[cfg(windows)]
    {
        let bundled = resource_path(app, "node.exe");
        bundled.is_file().then_some(bundled)
    }
}

fn js_runtime_args(app: &AppHandle) -> Vec<String> {
    #[cfg(not(windows))]
    {
        node_path(app)
            .map(|node| {
                vec![
                    "--js-runtimes".to_string(),
                    format!("node:{}", node.display()),
                ]
            })
            .unwrap_or_default()
    }

    #[cfg(windows)]
    {
        let mut args = Vec::new();
        if let Some(node) = node_path(app) {
            args.extend([
                "--js-runtimes".to_string(),
                format!("node:{}", node.display()),
            ]);
        } else {
            args.extend(["--js-runtimes".to_string(), "node".to_string()]);
        }
        args
    }
}

fn resource_path(app: &AppHandle, name: &str) -> PathBuf {
    app.path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
        .join("tools")
        .join(name)
}

fn string_value(value: &Value, fields: &[&str]) -> Option<String> {
    fields
        .iter()
        .find_map(|field| value.get(*field)?.as_str().map(str::to_string))
}

fn text_similarity(left: &str, right: &str) -> f32 {
    let left_key = normalize(left);
    let right_key = normalize(right);
    if left_key.is_empty() || right_key.is_empty() {
        return 0.0;
    }
    if left_key == right_key {
        return 1.0;
    }
    if left_key.contains(&right_key) || right_key.contains(&left_key) {
        return 0.9;
    }
    let left_tokens = tokens(left);
    let right_tokens = tokens(right);
    let intersection = left_tokens.intersection(&right_tokens).count() as f32;
    if intersection == 0.0 {
        0.0
    } else {
        2.0 * intersection / (left_tokens.len() + right_tokens.len()) as f32
    }
}

fn tokens(value: &str) -> HashSet<String> {
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| {
            !token.is_empty()
                && !matches!(
                    *token,
                    "official" | "audio" | "video" | "lyrics" | "playlist" | "full" | "album"
                )
        })
        .map(str::to_string)
        .collect()
}

fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn untrusted_release(artist: &str, album: &str, reason: &str) -> String {
    format!("Couldn't find a trustworthy YouTube release for {album} by {artist}: {reason}.")
}

fn untrusted_upload(artist: &str, title: &str, reason: &str) -> String {
    format!("Couldn't find a trustworthy YouTube upload of {title} by {artist}: {reason}.")
}

/// The last `ERROR:` line a tool printed (or its last line), short enough to
/// show a person. The full output goes to the log.
pub fn short_tool_error(label: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    eprintln!(
        "{label} failed ({}):\n{}\n{}",
        output.status,
        stderr.trim(),
        stdout.trim()
    );
    last_error_line(&format!("{stderr}\n{stdout}"))
        .unwrap_or_else(|| format!("it stopped with {}", output.status))
}

pub fn last_error_line(text: &str) -> Option<String> {
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    // yt-dlp's own ERROR line names the cause; the sidecar's "XX" summary is
    // the fallback, then whatever came last.
    let last_with = |prefix: &str| {
        lines
            .iter()
            .rev()
            .find_map(|line| line.strip_prefix(prefix))
    };
    let line = last_with("ERROR:")
        .or_else(|| last_with("XX "))
        .or_else(|| lines.last().copied())?
        .trim();
    let mut short = line.chars().take(160).collect::<String>();
    if short.len() < line.len() {
        short.push_str("...");
    }
    (!short.is_empty()).then_some(short)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_ordered_release_beats_wrong_edition() {
        let expected = [
            ExpectedAlbumTrack {
                title: "First Song".into(),
                duration_sec: 180.0,
            },
            ExpectedAlbumTrack {
                title: "Second Song".into(),
                duration_sec: 200.0,
            },
        ];
        let good = Candidate {
            url: "good".into(),
            title: "Album".into(),
            artist: "Artist - Topic".into(),
            rank: 1,
            tracks: vec![
                CandidateTrack {
                    title: "Artist - First Song (Official Audio)".into(),
                    duration_sec: 181.0,
                    position: 1,
                },
                CandidateTrack {
                    title: "Artist - Second Song".into(),
                    duration_sec: 198.0,
                    position: 2,
                },
            ],
        };
        let bad = Candidate {
            url: "bad".into(),
            title: "Album live reaction".into(),
            artist: "Fan Channel".into(),
            rank: 0,
            tracks: vec![CandidateTrack {
                title: "First Song live".into(),
                duration_sec: 250.0,
                position: 1,
            }],
        };
        let model = default_model();
        assert!(model.predict(&candidate_features(&good, "Artist", "Album", &expected)) > 0.9);
        assert!(model.predict(&candidate_features(&bad, "Artist", "Album", &expected)) < 0.5);
    }

    #[test]
    fn track_evidence_checks_coverage_order_and_duration() {
        let expected = [
            ExpectedAlbumTrack {
                title: "Alpha".into(),
                duration_sec: 100.0,
            },
            ExpectedAlbumTrack {
                title: "Beta".into(),
                duration_sec: 120.0,
            },
        ];
        let candidate = [
            CandidateTrack {
                title: "Alpha (Official Audio)".into(),
                duration_sec: 101.0,
                position: 1,
            },
            CandidateTrack {
                title: "Beta".into(),
                duration_sec: 121.0,
                position: 2,
            },
        ];
        let (coverage, order, duration) = track_evidence(&candidate, &expected);
        assert_eq!(coverage, 1.0);
        assert_eq!(order, 1.0);
        assert!(duration > 0.9);
    }

    #[test]
    fn single_track_gate_prefers_official_matching_audio() {
        let good = TrackCandidate {
            url: "good".into(),
            title: "Alice in Chains - Would? (Official Audio)".into(),
            artist: "Alice in Chains - Topic".into(),
            duration_sec: 207.0,
            rank: 0,
        };
        let bad = TrackCandidate {
            url: "bad".into(),
            title: "Would karaoke cover live".into(),
            artist: "Fan".into(),
            duration_sec: 260.0,
            rank: 1,
        };
        assert!(track_candidate_evidence(&good, "Alice in Chains", "Would?", 207.0).0 > 0.8);
        assert!(track_candidate_evidence(&bad, "Alice in Chains", "Would?", 207.0).0 < 0.5);
    }

    #[test]
    fn album_match_returns_real_playlist_positions() {
        let candidate = [
            CandidateTrack {
                title: "Intro".into(),
                duration_sec: 30.0,
                position: 1,
            },
            CandidateTrack {
                title: "Artist - Second (Official Audio)".into(),
                duration_sec: 200.0,
                position: 2,
            },
            CandidateTrack {
                title: "Artist - First".into(),
                duration_sec: 180.0,
                position: 3,
            },
        ];
        let expected = [
            ExpectedAlbumTrack {
                title: "First".into(),
                duration_sec: 180.0,
            },
            ExpectedAlbumTrack {
                title: "Second".into(),
                duration_sec: 200.0,
            },
        ];
        let positions = matched_track_positions(&candidate, &expected);
        assert_eq!(positions[0].position, 3);
        assert_eq!(positions[1].position, 2);
    }

    #[test]
    fn album_tracks_drop_video_variants_dedupe_and_keep_original_audio_position() {
        let playlist = serde_json::json!({
            "entries": [
                {
                    "title": "Song",
                    "duration": 180.0,
                    "uploader": "Artist"
                },
                {
                    "title": "Song (Official Audio)",
                    "duration": 180.0,
                    "uploader": "Artist - Topic"
                },
                {
                    "title": "Song (Official Music Video)",
                    "duration": 240.0,
                    "uploader": "Artist"
                }
            ]
        });
        let expected = [ExpectedAlbumTrack {
            title: "Song".into(),
            duration_sec: 180.0,
        }];

        let tracks = safe_album_tracks(&playlist, &expected);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "Song (Official Audio)");
        assert_eq!(tracks[0].position, 2);
    }

    #[test]
    fn individual_track_gate_hard_rejects_unrequested_video_variants() {
        let music_video = TrackCandidate {
            url: "video".into(),
            title: "Alice in Chains - Would? (Official Music Video)".into(),
            artist: "Alice in Chains".into(),
            duration_sec: 207.0,
            rank: 0,
        };
        let visualizer = TrackCandidate {
            title: "Alice in Chains - Would? (Visualizer)".into(),
            ..music_video.clone()
        };

        assert_eq!(
            track_candidate_evidence(&music_video, "Alice in Chains", "Would?", 207.0).0,
            0.0
        );
        assert_eq!(
            track_candidate_evidence(&visualizer, "Alice in Chains", "Would?", 207.0).0,
            0.0
        );
        assert!(!has_unrequested_video_variant(
            "Lana Del Rey - Video Games (Official Audio)",
            "Video Games"
        ));
    }

    #[test]
    fn album_match_serializes_safe_positions_in_camel_case() {
        let value = serde_json::to_value(YouTubeAlbumMatch {
            url: "playlist".into(),
            title: "Album".into(),
            artist: "Artist".into(),
            track_count: 1,
            confidence: 0.99,
            explanation: "safe audio only".into(),
            track_positions: vec![],
            safe_track_positions: vec![2],
            tracks: vec![YouTubeAlbumTrack {
                title: "Track".into(),
                duration_sec: 180.0,
                position: 2,
            }],
        })
        .unwrap();
        assert_eq!(value["safeTrackPositions"], serde_json::json!([2]));
    }

    #[test]
    fn cyrillic_album_and_artist_match_their_playlist() {
        let expected = [
            ExpectedAlbumTrack {
                title: "Группа крови".into(),
                duration_sec: 285.0,
            },
            ExpectedAlbumTrack {
                title: "Закрой за мной дверь".into(),
                duration_sec: 255.0,
            },
        ];
        let candidate = Candidate {
            url: "kino".into(),
            title: "Группа крови".into(),
            artist: "Кино - Topic".into(),
            rank: 0,
            tracks: vec![
                CandidateTrack {
                    title: "Группа крови".into(),
                    duration_sec: 286.0,
                    position: 1,
                },
                CandidateTrack {
                    title: "Закрой за мной дверь".into(),
                    duration_sec: 254.0,
                    position: 2,
                },
            ],
        };
        assert_eq!(normalize("Группа Крови"), "группакрови");
        assert!(text_similarity("Кино - Группа крови (Full Album)", "Группа крови") >= 0.45);
        let features = candidate_features(&candidate, "Кино", "Группа крови", &expected);
        assert_eq!(features.track_coverage, 1.0);
        let model = default_model();
        assert!(model.predict(&features) >= model.minimum_confidence);
    }

    #[test]
    fn an_empty_album_key_never_matches_every_title() {
        assert_eq!(normalize("!!!"), "");
        assert_eq!(text_similarity("Anything at all", "!!!"), 0.0);
        assert!(!is_album_search_hit(
            "Anything at all",
            "!!!",
            &normalize("!!!")
        ));
        assert!(is_album_search_hit(
            "Artist - Blue Album (Full Album)",
            "Blue Album",
            &normalize("Blue Album")
        ));
    }

    #[test]
    fn variant_filters_match_whole_words_and_bracketed_video_suffixes() {
        for kept in ["Olive", "Deliver", "Discover", "Video Games", "Home Video"] {
            assert!(
                !has_unrequested_bad_variant(kept, "Artist Album"),
                "{kept} was treated as a bad variant"
            );
            assert!(
                !is_unsafe_album_video_variant(kept, &[]),
                "{kept} was treated as a video"
            );
        }
        assert!(has_unrequested_bad_variant("Song (Live)", "Artist Song"));
        assert!(!has_unrequested_bad_variant(
            "Song (Live)",
            "Artist Song Live"
        ));
        assert!(is_unsafe_album_video_variant("Song (Official Video)", &[]));
        for video in [
            "Song (Official Music Video)",
            "Song [Lyric Video]",
            "Song - Visualizer",
            "Song (Official Video 4K)",
            "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
            "Song (Official HD Video)",
            "Song (Official Music Video) [HD]",
            "Song - Official Video (Remastered)",
            "Song | Official Lyric Video",
            "Artist - Song Official Music Video",
            "Song Official Video",
            "Song Lyric Video (2009)",
        ] {
            assert!(is_video_variant_title(video), "{video}");
            assert!(is_unsafe_album_video_variant(video, &[]), "{video}");
        }
        for kept in [
            "Video Games",
            "Lana Del Rey - Video Games",
            "Home Video",
            "Olive",
            "Song (Official Audio)",
        ] {
            assert!(!is_video_variant_title(kept), "{kept}");
            assert!(!is_unsafe_album_video_variant(kept, &[]), "{kept}");
        }
    }

    #[test]
    fn tool_errors_keep_only_the_last_error_line() {
        let output =
            "[download] 10%\n[download] 20%\nERROR: [youtube] abc: Video unavailable\nWARNING: x";
        assert_eq!(
            last_error_line(output).as_deref(),
            Some("[youtube] abc: Video unavailable")
        );
        assert_eq!(
            last_error_line("just one line").as_deref(),
            Some("just one line")
        );
        assert_eq!(last_error_line("  \n "), None);
        assert_eq!(
            last_error_line("ERROR: [youtube] b: blocked\nXX  Nothing downloaded (yt-dlp exit 1).")
                .as_deref(),
            Some("[youtube] b: blocked")
        );
        let long = format!("ERROR: {}", "x".repeat(500));
        assert!(last_error_line(&long).unwrap().len() < 200);
        assert!(
            untrusted_release(
                "Artist",
                "Album",
                "no album playlists came up in the search"
            )
            .len()
                < 200
        );
    }
}
