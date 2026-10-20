use aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes::Aes128;
use flate2::read::ZlibDecoder;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MUSICDB_KEY: &[u8; 16] = b"BHUILuilfghuila3";
const APPLE_TO_UNIX_SECONDS: i64 = 2_082_844_800;
const MAX_DECOMPRESSED_BYTES: u64 = 1_500_000_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleMusicTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub disc_number: Option<u16>,
    pub track_number: Option<u16>,
    pub year: Option<i32>,
    pub duration_sec: f32,
    pub bit_rate: Option<u32>,
    pub play_count: u32,
    pub last_played_unix_ms: Option<i64>,
    pub date_added_unix_ms: Option<i64>,
    pub rating: Option<u8>,
    pub like_status: u8,
    pub in_apple_library: bool,
    pub artwork_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleMusicPlaylist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleMusicSummary {
    pub track_count: usize,
    pub album_count: usize,
    pub artist_count: usize,
    pub playlist_count: usize,
    pub total_plays: u64,
    pub artwork_track_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleMusicLibrary {
    pub source_path: String,
    pub version: String,
    pub summary: AppleMusicSummary,
    pub tracks: Vec<AppleMusicTrack>,
    pub playlists: Vec<AppleMusicPlaylist>,
}

#[derive(Default)]
struct TrackBuilder {
    id: u64,
    title: String,
    artist: String,
    album: String,
    album_artist: String,
    genre: String,
    disc_number: Option<u16>,
    track_number: Option<u16>,
    year: Option<i32>,
    duration_ms: u32,
    bit_rate: Option<u32>,
    play_count: u32,
    last_played: Option<u32>,
    date_added: Option<u32>,
    rating: Option<u8>,
    like_status: u8,
    artwork_path: Option<String>,
}

#[derive(Default)]
struct PlaylistBuilder {
    id: u64,
    name: String,
    track_ids: Vec<u64>,
}

#[derive(Clone, Copy)]
enum Context {
    Track(usize),
    Playlist(usize),
}

const REMEMBERED_LIBRARY: &str = "apple-music-library.json";

/// Import with a remembered location: a chosen path is stored in app data once
/// it imports, and later calls without a path try it before the defaults.
pub fn import_with_remembered_path<T>(
    app_data: &Path,
    path: Option<&str>,
    import: impl Fn(Option<&str>) -> Result<T, String>,
) -> Result<T, String> {
    let remembered = app_data.join("MXTP MKR").join(REMEMBERED_LIBRARY);
    if let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) {
        let library = import(Some(path))?;
        let saved = remembered
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|_| fs::write(&remembered, serde_json::json!({ "path": path }).to_string()));
        if let Err(error) = saved {
            eprintln!("could not remember the Apple Music library location: {error}");
        }
        return Ok(library);
    }
    let stored = fs::read(&remembered)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("path")?.as_str().map(str::to_string))
        .filter(|path| !path.trim().is_empty());
    if let Some(stored) = stored {
        match import(Some(&stored)) {
            Ok(library) => return Ok(library),
            Err(error) => {
                eprintln!("remembered Apple Music library failed, trying defaults: {error}")
            }
        }
    }
    import(None)
}

pub fn import_library(path: Option<&str>) -> Result<AppleMusicLibrary, String> {
    let db_path = resolve_library_path(path)?;
    let package = db_path
        .parent()
        .ok_or_else(|| "Apple Music library path has no parent folder".to_string())?;
    let encrypted = fs::read(&db_path)
        .map_err(|err| format!("failed to read `{}`: {err}", db_path.display()))?;
    let version = musicdb_version(&encrypted)?;
    let raw = decrypt_and_decompress(&encrypted)?;
    let (mut tracks, playlists) = parse_sections(&raw)?;
    apply_artwork(package, &mut tracks);

    let albums = tracks
        .iter()
        .filter(|track| !track.album.is_empty())
        .map(|track| {
            (
                track.album.to_ascii_lowercase(),
                if track.album_artist.is_empty() {
                    track.artist.to_ascii_lowercase()
                } else {
                    track.album_artist.to_ascii_lowercase()
                },
            )
        })
        .collect::<HashSet<_>>()
        .len();
    let artists = tracks
        .iter()
        .filter(|track| !track.artist.is_empty())
        .map(|track| track.artist.to_ascii_lowercase())
        .collect::<HashSet<_>>()
        .len();
    let total_plays = tracks.iter().map(|track| track.play_count as u64).sum();
    let artwork_track_count = tracks
        .iter()
        .filter(|track| track.artwork_path.is_some())
        .count();

    let tracks = tracks.into_iter().map(finish_track).collect::<Vec<_>>();
    let playlists = playlists
        .into_iter()
        .map(|playlist| AppleMusicPlaylist {
            id: playlist.id.to_string(),
            name: playlist.name,
            track_ids: playlist
                .track_ids
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
        })
        .collect::<Vec<_>>();

    Ok(AppleMusicLibrary {
        source_path: db_path.to_string_lossy().to_string(),
        version,
        summary: AppleMusicSummary {
            track_count: tracks.len(),
            album_count: albums,
            artist_count: artists,
            playlist_count: playlists.len(),
            total_plays,
            artwork_track_count,
        },
        tracks,
        playlists,
    })
}

fn finish_track(track: TrackBuilder) -> AppleMusicTrack {
    AppleMusicTrack {
        id: track.id.to_string(),
        title: track.title,
        artist: track.artist,
        album: track.album,
        album_artist: track.album_artist,
        genre: track.genre,
        disc_number: track.disc_number,
        track_number: track.track_number,
        year: track.year,
        duration_sec: track.duration_ms as f32 / 1000.0,
        bit_rate: track.bit_rate,
        play_count: track.play_count,
        last_played_unix_ms: apple_date_to_unix_ms(track.last_played),
        date_added_unix_ms: apple_date_to_unix_ms(track.date_added),
        rating: track.rating,
        like_status: track.like_status,
        // Every record produced by Library.musicdb is a track the person has
        // added to their Apple Music library. Keep this distinct from the
        // separate favourite/like flag so the UI can scope albums correctly.
        in_apple_library: true,
        artwork_path: track.artwork_path,
    }
}

fn resolve_library_path(path: Option<&str>) -> Result<PathBuf, String> {
    let path = match path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        #[cfg(windows)]
        None => std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .ok_or_else(|| "USERPROFILE is unavailable".to_string())?
            .join("Music")
            .join("Apple Music")
            .join("Apple Music Library.musiclibrary")
            .join("Library.musicdb"),
        #[cfg(target_os = "linux")]
        None => std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is unavailable".to_string())?
            .join("Music")
            .join("Apple Music")
            .join("Apple Music Library.musiclibrary")
            .join("Library.musicdb"),
        #[cfg(target_os = "macos")]
        None => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or_else(|| "HOME is unavailable".to_string())?;
            let candidates = macos_library_candidates(&home);
            match candidates.iter().find(|candidate| candidate.is_file()) {
                Some(candidate) => candidate.clone(),
                None => {
                    let attempted = candidates
                        .iter()
                        .map(|candidate| format!("`{}`", candidate.display()))
                        .collect::<Vec<_>>()
                        .join(" or ");
                    return Err(format!(
                        "Apple Music library was not found at {attempted}. If Music uses a custom library location, choose its Library.musicdb file manually."
                    ));
                }
            }
        }
        #[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
        None => return Err("Apple Music library auto-detection is unsupported on this OS".into()),
    };
    let path = if path.is_dir() {
        path.join("Library.musicdb")
    } else {
        path
    };
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Apple Music library was not found at `{}`",
            path.display()
        ))
    }
}

/// The Music app's current default package comes first. The second candidate
/// preserves compatibility with libraries copied from the Windows layout or
/// created by older MXTP MKR workflows.
#[cfg(any(target_os = "macos", test))]
fn macos_library_candidates(home: &Path) -> [PathBuf; 2] {
    [
        home.join("Music")
            .join("Music")
            .join("Music Library.musiclibrary")
            .join("Library.musicdb"),
        home.join("Music")
            .join("Apple Music")
            .join("Apple Music Library.musiclibrary")
            .join("Library.musicdb"),
    ]
}

fn musicdb_version(bytes: &[u8]) -> Result<String, String> {
    if bytes.get(0..4) != Some(b"hfma") {
        return Err("not an Apple Music Library.musicdb file".to_string());
    }
    let version = bytes
        .get(16..48)
        .ok_or_else(|| "Apple Music library header is truncated".to_string())?;
    let end = version
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(version.len());
    Ok(String::from_utf8_lossy(&version[..end]).to_string())
}

fn decrypt_and_decompress(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let envelope = read_u32(bytes, 4)? as usize;
    let max_crypt = read_u32(bytes, 84)? as usize;
    let payload = bytes
        .get(envelope..)
        .ok_or_else(|| "Apple Music library envelope is invalid".to_string())?;
    let crypt_len = max_crypt.min(payload.len()) / 16 * 16;
    let mut compressed = payload.to_vec();
    let cipher = Aes128::new_from_slice(MUSICDB_KEY).map_err(|err| err.to_string())?;
    for chunk in compressed[..crypt_len].as_chunks_mut::<16>().0 {
        cipher.decrypt_block(Block::<Aes128>::from_mut_slice(chunk));
    }
    decompress_with_limit(&compressed, MAX_DECOMPRESSED_BYTES)
}

fn decompress_with_limit(compressed: &[u8], limit: u64) -> Result<Vec<u8>, String> {
    let mut decoder = ZlibDecoder::new(compressed).take(limit.saturating_add(1));
    let mut raw = Vec::new();
    decoder
        .read_to_end(&mut raw)
        .map_err(|err| format!("failed to decode Apple Music library: {err}"))?;
    if raw.len() as u64 > limit {
        Err(format!(
            "Apple Music library exceeds the {limit}-byte decompressed size limit"
        ))
    } else {
        Ok(raw)
    }
}

fn parse_sections(raw: &[u8]) -> Result<(Vec<TrackBuilder>, Vec<PlaylistBuilder>), String> {
    let mut tracks = Vec::new();
    let mut track_indexes = HashMap::new();
    let mut playlists = Vec::new();
    let mut context = None;
    let mut pos = 0usize;

    while pos + 12 <= raw.len() {
        let signature = &raw[pos..pos + 4];
        if signature == [0, 0, 0, 0] {
            break;
        }
        let size = if signature == b"boma" {
            read_u32(raw, pos + 8)? as usize
        } else {
            read_u32(raw, pos + 4)? as usize
        };
        if size < 8 || pos + size > raw.len() {
            break;
        }

        match signature {
            b"itma" => {
                let id = read_u64(raw, pos + 16)?;
                let index = *track_indexes.entry(id).or_insert_with(|| {
                    tracks.push(TrackBuilder {
                        id,
                        ..TrackBuilder::default()
                    });
                    tracks.len() - 1
                });
                let track = &mut tracks[index];
                if size >= 86 {
                    let number = read_u16(raw, pos + 84)?;
                    track.disc_number = (number > 0).then_some(number);
                }
                if size >= 188 {
                    let number = read_u16(raw, pos + 160)?;
                    track.track_number = (number > 0).then_some(number);
                    let year = read_i32(raw, pos + 168)?;
                    track.year = (year > 1900 && year < 2100).then_some(year);
                }
                if size >= 66 {
                    let rating = raw[pos + 65];
                    track.rating = (rating > 0 && rating <= 100).then_some(rating);
                }
                if size >= 63 {
                    track.like_status = raw[pos + 62].min(3);
                }
                context = Some(Context::Track(index));
            }
            b"lpma" => {
                let id = read_u64(raw, pos + 30)?;
                playlists.push(PlaylistBuilder {
                    id,
                    ..PlaylistBuilder::default()
                });
                context = Some(Context::Playlist(playlists.len() - 1));
            }
            b"boma" => {
                let subtype = read_u32(raw, pos + 12)?;
                match context {
                    Some(Context::Track(index)) => {
                        parse_track_boma(raw, pos, size, subtype, &mut tracks[index])?
                    }
                    Some(Context::Playlist(index)) => {
                        parse_playlist_boma(raw, pos, size, subtype, &mut playlists[index])?
                    }
                    None => {}
                }
            }
            b"iama" | b"iAma" | b"lama" | b"lAma" | b"ltma" | b"lPma" => context = None,
            _ => {}
        }
        pos += size;
    }
    if tracks.is_empty() {
        return Err("Apple Music library contained no readable tracks".to_string());
    }
    Ok((tracks, playlists))
}

fn parse_track_boma(
    raw: &[u8],
    pos: usize,
    size: usize,
    subtype: u32,
    track: &mut TrackBuilder,
) -> Result<(), String> {
    if let Some(value) = parse_wide(raw, pos, size, subtype)? {
        match subtype {
            0x0002 => track.title = value,
            0x0003 => track.album = value,
            0x0004 => track.artist = value,
            0x0005 => track.genre = value,
            0x001b => track.album_artist = value,
            _ => {}
        }
    }
    match subtype {
        0x0017 if size >= 36 => {
            track.last_played = nonzero(read_u32(raw, pos + 28)?);
            track.play_count = read_u32(raw, pos + 32)?;
        }
        0x0001 if size >= 180 => {
            track.bit_rate = nonzero(read_u32(raw, pos + 108)?);
            track.date_added = nonzero(read_u32(raw, pos + 112)?);
            track.duration_ms = read_u32(raw, pos + 176)?;
        }
        _ => {}
    }
    Ok(())
}

fn parse_playlist_boma(
    raw: &[u8],
    pos: usize,
    size: usize,
    subtype: u32,
    playlist: &mut PlaylistBuilder,
) -> Result<(), String> {
    if subtype == 0x00c8 {
        if let Some(name) = parse_wide(raw, pos, size, subtype)? {
            playlist.name = name;
        }
    } else if subtype == 0x00ce && size >= 48 && raw.get(pos + 20..pos + 24) == Some(b"ipfa") {
        playlist.track_ids.push(read_u64(raw, pos + 40)?);
    }
    Ok(())
}

fn parse_wide(raw: &[u8], pos: usize, size: usize, subtype: u32) -> Result<Option<String>, String> {
    if !matches!(subtype, 0x0002 | 0x0003 | 0x0004 | 0x0005 | 0x001b | 0x00c8) || size < 36 {
        return Ok(None);
    }
    let byte_len = read_u32(raw, pos + 24)? as usize;
    if byte_len == 0 || byte_len >= 10_000 || 36 + byte_len > size {
        return Ok(None);
    }
    let value = raw[pos + 36..pos + 36 + byte_len]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|value| *value != 0)
        .collect::<Vec<_>>();
    let value = String::from_utf16_lossy(&value).trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

fn apply_artwork(package: &Path, tracks: &mut [TrackBuilder]) {
    let db_path = package.join("artwork.sqlite");
    let Ok(connection) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return;
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT m.item_id, m.artwork_id, c.extension \
         FROM item_to_artwork m LEFT JOIN cache_items c ON c.artwork_id = m.artwork_id",
    ) else {
        return;
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    }) else {
        return;
    };
    let artwork = rows
        .filter_map(Result::ok)
        .map(|(item_id, artwork_id, extension)| (item_id, (artwork_id, extension)))
        .collect::<HashMap<_, _>>();
    let root = package.join("artwork");
    for track in tracks {
        let Some((artwork_id, extension)) = artwork.get(&(track.id as i64)) else {
            continue;
        };
        let extension = extension.as_deref().unwrap_or("jpeg");
        let path = root.join(format!("{artwork_id}_sk1.{extension}"));
        if path.is_file() {
            track.artwork_path = Some(path.to_string_lossy().to_string());
        }
    }
}

fn apple_date_to_unix_ms(value: Option<u32>) -> Option<i64> {
    value.map(|seconds| (seconds as i64 - APPLE_TO_UNIX_SECONDS) * 1000)
}

fn nonzero(value: u32) -> Option<u32> {
    (value != 0).then_some(value)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| "Apple Music library is truncated".to_string())?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "Apple Music library is truncated".to_string())?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

fn read_i32(bytes: &[u8], offset: usize) -> Result<i32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "Apple Music library is truncated".to_string())?;
    Ok(i32::from_le_bytes(value.try_into().unwrap()))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| "Apple Music library is truncated".to_string())?;
    Ok(u64::from_le_bytes(value.try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;

    #[test]
    fn apple_epoch_converts_to_unix_epoch() {
        assert_eq!(apple_date_to_unix_ms(Some(2_082_844_800)), Some(0));
        assert_eq!(apple_date_to_unix_ms(None), None);
    }

    #[test]
    fn decompression_stops_at_the_configured_limit() {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"bounded output").unwrap();
        let compressed = encoder.finish().unwrap();

        let error = decompress_with_limit(&compressed, 4).unwrap_err();
        assert!(error.contains("4-byte decompressed size limit"), "{error}");
    }

    #[test]
    fn macos_autodetection_checks_current_then_legacy_library_packages() {
        let candidates = macos_library_candidates(Path::new("/Users/example"));
        assert_eq!(
            candidates[0],
            PathBuf::from("/Users/example/Music/Music/Music Library.musiclibrary/Library.musicdb")
        );
        assert_eq!(
            candidates[1],
            PathBuf::from(
                "/Users/example/Music/Apple Music/Apple Music Library.musiclibrary/Library.musicdb"
            )
        );
    }

    #[test]
    fn parses_and_serializes_disc_number_from_the_itma_header() {
        let mut raw = vec![0_u8; 188];
        raw[0..4].copy_from_slice(b"itma");
        raw[4..8].copy_from_slice(&188_u32.to_le_bytes());
        raw[16..24].copy_from_slice(&42_u64.to_le_bytes());
        raw[84..86].copy_from_slice(&2_u16.to_le_bytes());
        raw[160..162].copy_from_slice(&7_u16.to_le_bytes());
        raw[168..172].copy_from_slice(&2006_i32.to_le_bytes());

        let (mut tracks, playlists) = parse_sections(&raw).unwrap();
        assert!(playlists.is_empty());
        let track = finish_track(tracks.pop().unwrap());
        assert_eq!(track.disc_number, Some(2));
        assert_eq!(track.track_number, Some(7));
        assert_eq!(serde_json::to_value(track).unwrap()["discNumber"], 2);
    }

    #[test]
    fn a_chosen_library_path_is_remembered_across_calls() {
        let app_data = tempfile::tempdir().unwrap();
        let seen = std::cell::RefCell::new(Vec::new());
        let import = |path: Option<&str>| {
            seen.borrow_mut().push(path.map(str::to_string));
            match path {
                Some("/elsewhere/Library.musicdb") => Ok("chosen"),
                Some(_) => Err("not there".to_string()),
                None => Ok("default"),
            }
        };

        assert_eq!(
            import_with_remembered_path(app_data.path(), None, import),
            Ok("default")
        );
        assert_eq!(
            import_with_remembered_path(
                app_data.path(),
                Some("/elsewhere/Library.musicdb"),
                import
            ),
            Ok("chosen")
        );
        assert_eq!(
            import_with_remembered_path(app_data.path(), None, import),
            Ok("chosen")
        );
        // A path that fails to import is not remembered.
        assert!(import_with_remembered_path(app_data.path(), Some("/bad"), import).is_err());
        assert_eq!(
            import_with_remembered_path(app_data.path(), None, import),
            Ok("chosen")
        );
        assert_eq!(
            seen.borrow().last().cloned().flatten().as_deref(),
            Some("/elsewhere/Library.musicdb")
        );
    }

    #[test]
    fn imports_configured_live_library() {
        let Ok(path) = std::env::var("MXTP_TEST_APPLE_MUSIC_DB") else {
            return;
        };
        let library = import_library(Some(&path)).expect("live Apple Music library should import");
        assert!(library.summary.track_count > 0);
        assert!(library.summary.album_count > 0);
        assert!(library.summary.artwork_track_count > 0);
    }
}
