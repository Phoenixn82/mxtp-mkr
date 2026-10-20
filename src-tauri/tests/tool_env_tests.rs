//! Tool lookup and probe caching, driven through environment variables. Kept
//! in its own test binary with a single test so no other test sees the env
//! changes.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use mxtp_mkr::audio_prep::{probe_audio, write_sine_wav};
use mxtp_mkr::commands::playlist_import_from_folder;

fn real_tool(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("{name} must be installed for this test"))
}

/// A stand-in that counts its calls in `counter`, then runs the real tool.
fn counting_stub(dir: &Path, name: &str, counter: &Path) -> PathBuf {
    let stub = dir.join(name);
    fs::write(
        &stub,
        format!(
            "#!/bin/sh\necho call >> '{}'\nexec '{}' \"$@\"\n",
            counter.display(),
            real_tool(name).display()
        ),
    )
    .unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();
    stub
}

fn calls(counter: &Path) -> usize {
    fs::read_to_string(counter)
        .map(|text| text.lines().count())
        .unwrap_or(0)
}

#[test]
fn ffprobe_override_sibling_lookup_and_probe_cache() {
    let temp = tempfile::tempdir().unwrap();
    let wav = temp.path().join("probe.wav");
    write_sine_wav(&wav, 44_100, 2, 16, 1.0, 440.0).unwrap();

    // MXTP_FFPROBE_PATH wins.
    let override_dir = temp.path().join("override");
    fs::create_dir_all(&override_dir).unwrap();
    let override_counter = temp.path().join("override-calls");
    let override_stub = counting_stub(&override_dir, "ffprobe", &override_counter);
    std::env::set_var("MXTP_FFPROBE_PATH", &override_stub);
    probe_audio(wav.to_str().unwrap()).unwrap();
    assert_eq!(
        calls(&override_counter),
        1,
        "MXTP_FFPROBE_PATH was not used"
    );

    // Without an ffprobe override, the ffprobe next to the resolved ffmpeg is used.
    std::env::remove_var("MXTP_FFPROBE_PATH");
    let bundle = temp.path().join("bundle");
    fs::create_dir_all(&bundle).unwrap();
    let sibling_counter = temp.path().join("sibling-calls");
    let ffmpeg = counting_stub(&bundle, "ffmpeg", &temp.path().join("ffmpeg-calls"));
    counting_stub(&bundle, "ffprobe", &sibling_counter);
    std::env::set_var("MXTP_FFMPEG_PATH", &ffmpeg);
    probe_audio(wav.to_str().unwrap()).unwrap();
    assert_eq!(
        calls(&sibling_counter),
        1,
        "the ffmpeg sibling ffprobe was not used"
    );
    std::env::remove_var("MXTP_FFMPEG_PATH");

    // Cached-album recovery probes each file once, unreadable ones included.
    std::env::set_var("MXTP_FFPROBE_PATH", &override_stub);
    let folder = temp.path().join("playlists").join("Album");
    fs::create_dir_all(&folder).unwrap();
    write_sine_wav(&folder.join("001 - One.wav"), 44_100, 2, 16, 1.0, 440.0).unwrap();
    fs::write(folder.join("002 - Broken.opus"), b"truncated").unwrap();
    write_sine_wav(&folder.join("003 - Three.wav"), 44_100, 2, 16, 1.0, 440.0).unwrap();
    let before = calls(&override_counter);

    let first = playlist_import_from_folder(&folder).unwrap();
    assert_eq!(
        first.tracks.len(),
        2,
        "one corrupt file must not drop the album"
    );
    assert_eq!(calls(&override_counter) - before, 3);
    assert!(folder.join(".mxtp-tracks.json").is_file());

    let second = playlist_import_from_folder(&folder).unwrap();
    assert_eq!(second.tracks, first.tracks);
    assert_eq!(second.skipped, 1);
    assert_eq!(
        calls(&override_counter) - before,
        3,
        "the second scan re-ran ffprobe instead of reading .mxtp-tracks.json"
    );

    // A changed file is probed again.
    write_sine_wav(&folder.join("003 - Three.wav"), 44_100, 2, 16, 2.0, 440.0).unwrap();
    let third = playlist_import_from_folder(&folder).unwrap();
    assert_eq!(calls(&override_counter) - before, 4);
    assert!(third.tracks[1].duration_sec > 1.5);

    // A missing ffprobe never marks files unreadable in the cache.
    let fresh = temp.path().join("playlists").join("Fresh");
    fs::create_dir_all(&fresh).unwrap();
    write_sine_wav(&fresh.join("001 - One.wav"), 44_100, 2, 16, 1.0, 440.0).unwrap();
    write_sine_wav(&fresh.join("002 - Two.wav"), 44_100, 2, 16, 1.0, 440.0).unwrap();
    std::env::set_var(
        "MXTP_FFPROBE_PATH",
        temp.path().join("gone").join("ffprobe"),
    );
    let missing = playlist_import_from_folder(&fresh);
    assert!(missing
        .map(|import| import.tracks.is_empty())
        .unwrap_or(true));
    let cache = fs::read_to_string(fresh.join(".mxtp-tracks.json")).unwrap_or_default();
    assert!(
        !cache.contains("One.wav") && !cache.contains("Two.wav"),
        "cached a probe that never ran: {cache}"
    );
    std::env::set_var("MXTP_FFPROBE_PATH", &override_stub);
    assert_eq!(playlist_import_from_folder(&fresh).unwrap().tracks.len(), 2);
    std::env::remove_var("MXTP_FFPROBE_PATH");
}
