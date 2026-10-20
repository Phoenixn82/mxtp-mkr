use crate::hidden_command;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MAX_TRACK_DURATION_SEC: f32 = 6_000.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeta {
    pub duration_sec: f32,
    pub sample_rate: u32,
    pub channels: u16,
    pub codec: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmTrack {
    pub path: String,
    pub duration_sec: f32,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
}

pub fn ffmpeg_version() -> Result<String, String> {
    let output = hidden_command(resolve_ffmpeg()?)
        .arg("-version")
        .output()
        .map_err(|err| format!("failed to spawn ffmpeg: {err}"))?;
    if !output.status.success() {
        return Err(command_error("ffmpeg -version", &output));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    text.lines()
        .next()
        .map(str::to_string)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "ffmpeg returned no version output".to_string())
}

pub fn probe_audio(path: &str) -> Result<AudioMeta, String> {
    let input = resolve_audio_input(path)?;
    let output = hidden_command(resolve_ffprobe()?)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,sample_rate,channels:format=duration",
            "-of",
            "json",
        ])
        .arg(&input)
        .output()
        .map_err(|err| format!("failed to spawn ffprobe: {err}"))?;
    if !output.status.success() {
        return Err(command_error("ffprobe", &output));
    }

    let json: Value = serde_json::from_slice(&output.stdout).map_err(|err| err.to_string())?;
    let stream = json["streams"]
        .as_array()
        .and_then(|streams| streams.first())
        .ok_or_else(|| "ffprobe found no audio stream".to_string())?;
    let duration_sec = json["format"]["duration"]
        .as_str()
        .ok_or_else(|| "ffprobe did not return duration".to_string())?
        .parse::<f32>()
        .map_err(|err| err.to_string())?;
    if !duration_sec.is_finite() || duration_sec <= 0.0 || duration_sec > MAX_TRACK_DURATION_SEC {
        return Err(format!(
            "audio duration must be between 0 and {MAX_TRACK_DURATION_SEC} seconds"
        ));
    }
    let sample_rate = stream["sample_rate"]
        .as_str()
        .ok_or_else(|| "ffprobe did not return sample_rate".to_string())?
        .parse::<u32>()
        .map_err(|err| err.to_string())?;
    let channels = stream["channels"]
        .as_u64()
        .ok_or_else(|| "ffprobe did not return channels".to_string())? as u16;
    let codec = stream["codec_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    Ok(AudioMeta {
        duration_sec,
        sample_rate,
        channels,
        codec,
    })
}

pub fn prepare_pcm(
    paths: Vec<String>,
    gap_sec: f32,
    normalize: bool,
) -> Result<Vec<PcmTrack>, String> {
    if paths.is_empty() {
        return Err("at least one audio path is required".to_string());
    }

    let mut prepared: Vec<PcmTrack> = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        let out = unique_temp_wav(index);
        match prepare_one_pcm(path, &out, gap_sec, normalize) {
            Ok(track) => prepared.push(track),
            Err(error) => {
                // Never leave earlier tracks' full-length WAVs behind on failure.
                let out = out.to_string_lossy().to_string();
                discard_scratch_wavs(
                    prepared
                        .iter()
                        .map(|track| track.path.as_str())
                        .chain([out.as_str()]),
                );
                return Err(error);
            }
        }
    }
    Ok(prepared)
}

fn prepare_one_pcm(
    path: &str,
    out: &Path,
    gap_sec: f32,
    normalize: bool,
) -> Result<PcmTrack, String> {
    let input = resolve_audio_input(path)?;
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input.to_string_lossy().to_string(),
        "-vn".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-ar".to_string(),
        "44100".to_string(),
        "-sample_fmt".to_string(),
        "s16".to_string(),
    ];
    let filter = if normalize {
        "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=resampler=soxr:precision=28"
    } else {
        "aresample=resampler=soxr:precision=28"
    };
    args.push("-af".to_string());
    let filter_index = args.len();
    args.push(filter.to_string());
    args.push(out.to_string_lossy().to_string());

    let ffmpeg = resolve_ffmpeg()?;
    let mut output = hidden_command(&ffmpeg)
        .args(&args)
        .output()
        .map_err(|err| format!("failed to spawn ffmpeg: {err}"))?;
    if !output.status.success() && ffmpeg_soxr_unavailable(&output.stderr) {
        let fallback = if normalize {
            "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=resampler=swr"
        } else {
            "aresample=resampler=swr"
        };
        args[filter_index] = fallback.to_string();
        output = hidden_command(&ffmpeg)
            .args(&args)
            .output()
            .map_err(|err| format!("failed to spawn ffmpeg: {err}"))?;
    }
    if !output.status.success() {
        return Err(command_error("ffmpeg convert", &output));
    }
    if gap_sec > 0.0 {
        append_wav_silence(out, gap_sec)?;
    }
    let wav = read_wav_meta(out.to_str().ok_or("invalid output path")?)?;
    Ok(PcmTrack {
        path: out.to_string_lossy().to_string(),
        duration_sec: wav.duration_sec,
        sample_rate: wav.sample_rate,
        channels: wav.channels,
        bits_per_sample: wav.bits_per_sample,
    })
}

fn ffmpeg_soxr_unavailable(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr).contains("Requested resampling engine is unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(duration_sec: f32) -> PcmTrack {
        PcmTrack {
            path: String::new(),
            duration_sec,
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        }
    }

    #[test]
    fn capacity_error_reports_the_program_length() {
        assert_eq!(capacity_error(&[pcm(CD_CAPACITY_SEC)]), None);
        assert_eq!(
            capacity_error(&[pcm(2_400.0), pcm(2_650.2)]),
            Some("Program is 84:11; an 80-minute CD-R holds 79:57".to_string())
        );
    }

    #[test]
    fn scratch_cleanup_deletes_only_temp_dir_track_wavs() {
        let temp = std::env::temp_dir();
        let id = std::process::id();
        let scratch = temp.join(format!("mxtp_mkr_track_cleanup_{id}.wav"));
        let other = temp.join(format!("mxtp_mkr_other_{id}.wav"));
        let not_wav = temp.join(format!("mxtp_mkr_track_cleanup_{id}.txt"));
        let nested_dir = tempfile::tempdir_in(&temp).unwrap();
        let nested = nested_dir.path().join("mxtp_mkr_track_nested.wav");
        for path in [&scratch, &other, &not_wav, &nested] {
            fs::write(path, b"x").unwrap();
        }
        let paths =
            [&scratch, &other, &not_wav, &nested].map(|path| path.to_string_lossy().to_string());

        discard_scratch_wavs(paths.iter().map(String::as_str));

        assert!(!scratch.exists());
        assert!(
            other.exists(),
            "a non-matching file in temp_dir must survive"
        );
        assert!(not_wav.exists());
        assert!(
            nested.exists(),
            "only files directly in temp_dir are scratch"
        );
        let _ = fs::remove_file(other);
        let _ = fs::remove_file(not_wav);
    }

    #[test]
    fn scratch_names_are_unique_within_one_millisecond() {
        assert_ne!(unique_temp_wav(0), unique_temp_wav(0));
        assert!(is_scratch_wav(&unique_temp_wav(3)));
    }

    #[test]
    fn detects_ffmpeg_builds_without_libsoxr() {
        assert!(ffmpeg_soxr_unavailable(
            b"[aresample] Requested resampling engine is unavailable"
        ));
        assert!(!ffmpeg_soxr_unavailable(
            b"ffmpeg failed for an unrelated reason"
        ));
    }
}

pub fn copy_audio_file(
    source_path: &str,
    app_data_root: &Path,
    project_id: &str,
) -> Result<PathBuf, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(format!("audio source `{source_path}` was not found"));
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "audio source has no file name".to_string())?;
    fs::create_dir_all(app_data_root).map_err(|err| err.to_string())?;
    let canonical_app_data = app_data_root
        .canonicalize()
        .map_err(|err| err.to_string())?;
    let projects_dir = app_data_root.join("MXTP MKR").join("projects");
    fs::create_dir_all(&projects_dir).map_err(|err| err.to_string())?;
    let canonical_projects = projects_dir.canonicalize().map_err(|err| err.to_string())?;
    if !canonical_projects.starts_with(&canonical_app_data) {
        return Err("project storage resolves outside the app data root".to_string());
    }

    let project_dir = project_dir(app_data_root, project_id)?;
    fs::create_dir_all(&project_dir).map_err(|err| err.to_string())?;
    let project_dir = project_dir.canonicalize().map_err(|err| err.to_string())?;
    if !project_dir.starts_with(&canonical_projects) {
        return Err("project storage resolves outside the projects root".to_string());
    }
    let audio_dir = project_dir.join("audio");
    fs::create_dir_all(&audio_dir).map_err(|err| err.to_string())?;
    let audio_dir = audio_dir.canonicalize().map_err(|err| err.to_string())?;
    if !audio_dir.starts_with(&project_dir) {
        return Err("audio storage resolves outside the project root".to_string());
    }

    let (dest, mut destination) = create_unique_destination(&audio_dir, file_name)?;
    let mut source_file = fs::File::open(&source).map_err(|err| err.to_string())?;
    if let Err(error) = std::io::copy(&mut source_file, &mut destination) {
        drop(destination);
        let _ = fs::remove_file(&dest);
        return Err(error.to_string());
    }
    dest.canonicalize().map_err(|err| err.to_string())
}

pub const CD_CAPACITY_SEC: f32 = 79.0 * 60.0 + 57.0;

pub fn capacity_check(tracks: &[PcmTrack]) -> bool {
    capacity_error(tracks).is_none()
}

/// The burn-path capacity message for a program longer than an 80-minute CD-R.
pub fn capacity_error(tracks: &[PcmTrack]) -> Option<String> {
    let total: f32 = tracks.iter().map(|track| track.duration_sec).sum();
    if total <= CD_CAPACITY_SEC {
        return None;
    }
    let seconds = total.ceil() as u64;
    Some(format!(
        "Program is {}:{:02}; an 80-minute CD-R holds 79:57",
        seconds / 60,
        seconds % 60
    ))
}

const SCRATCH_WAV_PREFIX: &str = "mxtp_mkr_track_";

/// True only for prepare_pcm's own scratch files: directly inside the temp dir
/// and named `mxtp_mkr_track_*.wav`.
pub fn is_scratch_wav(path: &Path) -> bool {
    let named = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with(SCRATCH_WAV_PREFIX)
                && name.len() > SCRATCH_WAV_PREFIX.len() + 4
                && name.ends_with(".wav")
        });
    let temp = std::env::temp_dir();
    let in_temp = path.parent().is_some_and(|parent| {
        parent == temp
            || matches!(
                (parent.canonicalize(), temp.canonicalize()),
                (Ok(parent), Ok(temp)) if parent == temp
            )
    });
    named && in_temp && !path.is_symlink()
}

/// Delete prepare_pcm scratch WAVs once a burn or image build is done with them.
/// Anything that is not a scratch WAV in the temp dir is left alone.
pub fn discard_scratch_wavs<'a>(paths: impl IntoIterator<Item = &'a str>) {
    for path in paths.into_iter().map(Path::new) {
        if is_scratch_wav(path) {
            let _ = fs::remove_file(path);
        }
    }
}

/// Startup sweep for scratch WAVs left behind by a crash or an abandoned run.
pub fn sweep_stale_scratch_wavs(max_age: Duration) {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = SystemTime::now();
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let stale = fs::symlink_metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if stale && is_scratch_wav(&path) {
            let _ = fs::remove_file(&path);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WavMeta {
    pub duration_sec: f32,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub data_offset: u64,
    pub data_bytes: u32,
}

pub fn read_wav_meta(path: &str) -> Result<WavMeta, String> {
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut riff = [0_u8; 12];
    file.read_exact(&mut riff).map_err(|err| err.to_string())?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }

    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut data_offset = None;
    let mut data_bytes = None;

    loop {
        let mut header = [0_u8; 8];
        match file.read_exact(&mut header) {
            Ok(()) => {}
            Err(_) => break,
        }
        let chunk_id = &header[0..4];
        let chunk_len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let chunk_start = file.stream_position().map_err(|err| err.to_string())?;
        if chunk_id == b"fmt " {
            let mut fmt = vec![0_u8; chunk_len as usize];
            file.read_exact(&mut fmt).map_err(|err| err.to_string())?;
            if fmt.len() < 16 {
                return Err("invalid WAV fmt chunk".to_string());
            }
            channels = Some(u16::from_le_bytes([fmt[2], fmt[3]]));
            sample_rate = Some(u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]));
            bits_per_sample = Some(u16::from_le_bytes([fmt[14], fmt[15]]));
        } else if chunk_id == b"data" {
            data_offset = Some(chunk_start);
            data_bytes = Some(chunk_len);
            file.seek(SeekFrom::Current(chunk_len as i64))
                .map_err(|err| err.to_string())?;
        } else {
            file.seek(SeekFrom::Current(chunk_len as i64))
                .map_err(|err| err.to_string())?;
        }
        if chunk_len % 2 == 1 {
            file.seek(SeekFrom::Current(1))
                .map_err(|err| err.to_string())?;
        }
    }

    let channels = channels.ok_or_else(|| "WAV fmt chunk missing channels".to_string())?;
    let sample_rate = sample_rate.ok_or_else(|| "WAV fmt chunk missing sample rate".to_string())?;
    let bits_per_sample =
        bits_per_sample.ok_or_else(|| "WAV fmt chunk missing bit depth".to_string())?;
    let data_offset = data_offset.ok_or_else(|| "WAV data chunk missing".to_string())?;
    let data_bytes = data_bytes.ok_or_else(|| "WAV data length missing".to_string())?;
    let bytes_per_sample = (bits_per_sample / 8) as u32;
    let duration_sec =
        data_bytes as f32 / (sample_rate * channels as u32 * bytes_per_sample) as f32;

    Ok(WavMeta {
        duration_sec,
        sample_rate,
        channels,
        bits_per_sample,
        data_offset,
        data_bytes,
    })
}

pub fn write_sine_wav(
    path: &Path,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    duration_sec: f32,
    frequency_hz: f32,
) -> Result<(), String> {
    if bits_per_sample != 16 {
        return Err("test sine writer only supports 16-bit PCM".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let frames = (duration_sec * sample_rate as f32).round() as u32;
    let mut pcm = Vec::with_capacity(frames as usize * channels as usize * 2);
    for frame in 0..frames {
        let phase = frame as f32 * frequency_hz * std::f32::consts::TAU / sample_rate as f32;
        let sample = (phase.sin() * i16::MAX as f32 * 0.35) as i16;
        for _ in 0..channels {
            pcm.extend(sample.to_le_bytes());
        }
    }
    write_wav_pcm(path, sample_rate, channels, bits_per_sample, &pcm)
}

pub fn write_silent_wav(
    path: &Path,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    duration_sec: f32,
) -> Result<(), String> {
    let bytes_per_sample = (bits_per_sample / 8) as u32;
    let frames = (duration_sec * sample_rate as f32).round() as u32;
    let data_bytes = frames * channels as u32 * bytes_per_sample;
    write_wav_pcm(
        path,
        sample_rate,
        channels,
        bits_per_sample,
        &vec![0_u8; data_bytes as usize],
    )
}

fn append_wav_silence(path: &Path, gap_sec: f32) -> Result<(), String> {
    let meta = read_wav_meta(path.to_str().ok_or("invalid wav path")?)?;
    let bytes_per_sample = (meta.bits_per_sample / 8) as u32;
    let gap_frames = (gap_sec * meta.sample_rate as f32).round() as u32;
    let gap_bytes = gap_frames * meta.channels as u32 * bytes_per_sample;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    file.seek(SeekFrom::End(0)).map_err(|err| err.to_string())?;
    file.write_all(&vec![0_u8; gap_bytes as usize])
        .map_err(|err| err.to_string())?;
    let new_data_bytes = meta.data_bytes + gap_bytes;
    let riff_size = 36 + new_data_bytes;
    file.seek(SeekFrom::Start(4))
        .map_err(|err| err.to_string())?;
    file.write_all(&riff_size.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(meta.data_offset - 4))
        .map_err(|err| err.to_string())?;
    file.write_all(&new_data_bytes.to_le_bytes())
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn write_wav_pcm(
    path: &Path,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    pcm: &[u8],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let bytes_per_sample = (bits_per_sample / 8) as u32;
    let byte_rate = sample_rate * channels as u32 * bytes_per_sample;
    let block_align = channels * (bits_per_sample / 8);
    let mut file = fs::File::create(path).map_err(|err| err.to_string())?;
    file.write_all(b"RIFF").map_err(|err| err.to_string())?;
    file.write_all(&(36 + pcm.len() as u32).to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(b"WAVEfmt ").map_err(|err| err.to_string())?;
    file.write_all(&16_u32.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(&1_u16.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(&channels.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(&sample_rate.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(&byte_rate.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(&block_align.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(&bits_per_sample.to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(b"data").map_err(|err| err.to_string())?;
    file.write_all(&(pcm.len() as u32).to_le_bytes())
        .map_err(|err| err.to_string())?;
    file.write_all(pcm).map_err(|err| err.to_string())?;
    Ok(())
}

fn unique_temp_wav(index: usize) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "{SCRATCH_WAV_PREFIX}{}_{}_{}_{}.wav",
        std::process::id(),
        millis,
        NEXT.fetch_add(1, Ordering::Relaxed),
        index
    ))
}

fn resolve_audio_input(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if candidate.is_file() {
        return Ok(candidate);
    }
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    roots.push(manifest.clone());
    if let Some(parent) = manifest.parent() {
        roots.push(parent.to_path_buf());
    }
    roots.push(std::env::temp_dir());
    for root in roots {
        let resolved = root.join(path);
        if resolved.is_file() {
            return Ok(resolved);
        }
    }
    Err(format!("audio input `{path}` was not found"))
}

fn project_dir(app_data_root: &Path, project_id: &str) -> Result<PathBuf, String> {
    if project_id.is_empty()
        || !project_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("project id contains unsupported characters".to_string());
    }
    Ok(app_data_root
        .join("MXTP MKR")
        .join("projects")
        .join(project_id))
}

fn create_unique_destination(
    audio_dir: &Path,
    file_name: &std::ffi::OsStr,
) -> Result<(PathBuf, fs::File), String> {
    let source_name = Path::new(file_name);
    let stem = source_name
        .file_stem()
        .unwrap_or(file_name)
        .to_string_lossy();
    let extension = source_name.extension().map(|value| value.to_string_lossy());

    for number in 1_u32.. {
        let candidate = if number == 1 {
            audio_dir.join(file_name)
        } else {
            let numbered = match &extension {
                Some(extension) => format!("{stem} ({number}).{extension}"),
                None => format!("{stem} ({number})"),
            };
            audio_dir.join(numbered)
        };
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    unreachable!("u32 destination suffixes cannot be exhausted in practice")
}

/// ffmpeg: MXTP_FFMPEG_PATH, then a bundled copy, then PATH and the fallback dirs.
pub fn resolve_ffmpeg() -> Result<PathBuf, String> {
    crate::resolve_executable("ffmpeg", "ffmpeg", "MXTP_FFMPEG_PATH", &[])
}

/// ffprobe: MXTP_FFPROBE_PATH, then the ffprobe next to the resolved ffmpeg,
/// then a bundled copy, PATH and the fallback dirs.
pub fn resolve_ffprobe() -> Result<PathBuf, String> {
    let sibling_dir = resolve_ffmpeg()
        .ok()
        .and_then(|ffmpeg| ffmpeg.parent().map(Path::to_path_buf));
    crate::resolve_executable(
        "ffprobe",
        "ffprobe",
        "MXTP_FFPROBE_PATH",
        sibling_dir.as_slice(),
    )
}

fn command_error(label: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    format!(
        "{label} failed with status {}: {stderr}{stdout}",
        output.status
    )
}
