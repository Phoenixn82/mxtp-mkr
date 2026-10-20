use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::process::Command;

use lopdf::{Document, Object};
use mxtp_mkr::audio_prep::{
    capacity_check, copy_audio_file, ffmpeg_version, prepare_pcm, probe_audio, read_wav_meta,
    write_sine_wav, PcmTrack,
};
use mxtp_mkr::burn::{build_cda_image, burn_cda, list_burners, BurnResult, CdaImage};
use mxtp_mkr::commands;
use mxtp_mkr::hidden_child_creation_flags;
use mxtp_mkr::pdf_compose::{compose_pdf, PieceKind, PieceSpec};
use mxtp_mkr::research::{
    codex_child_env, fetch_lyrics, generate_cover, lookup_album, ImageGenAdapter,
    MockImageGenAdapter,
};

#[test]
fn gui_media_helpers_never_create_console_windows() {
    #[cfg(windows)]
    assert_eq!(hidden_child_creation_flags(), 0x0800_0000);
    #[cfg(not(windows))]
    assert_eq!(hidden_child_creation_flags(), 0);
}

fn assert_background_future<T>(_: T)
where
    T: std::future::Future<Output = Result<BurnResult, String>> + Send,
{
}

#[test]
fn physical_burn_command_runs_off_the_ui_event_loop() {
    assert_background_future(commands::burn_cda(
        CdaImage {
            tracks: Vec::new(),
            leadin_sectors: 0,
            leadout_sectors: 0,
            total_sectors: 0,
            cd_text: None,
        },
        "D:\\".to_string(),
        false,
    ));
}

fn temp_file(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("mxtp_mkr_test_{}_{}", std::process::id(), name))
}

fn pcm(duration_sec: f32) -> PcmTrack {
    PcmTrack {
        path: "fixture.wav".to_string(),
        duration_sec,
        sample_rate: 44_100,
        channels: 2,
        bits_per_sample: 16,
    }
}

fn ffmpeg_convert(input: &std::path::Path, output: &std::path::Path) {
    let status = Command::new("ffmpeg")
        .args(["-y", "-i"])
        .arg(input)
        .arg(output)
        .status()
        .expect("ffmpeg should spawn");
    assert!(status.success(), "ffmpeg fixture conversion failed");
}

fn wav_rms(path: &str) -> f64 {
    let meta = read_wav_meta(path).unwrap();
    let mut file = fs::File::open(path).unwrap();
    file.seek(SeekFrom::Start(meta.data_offset)).unwrap();
    let mut data = vec![0_u8; meta.data_bytes as usize];
    file.read_exact(&mut data).unwrap();
    let mut sum = 0_f64;
    let mut count = 0_f64;
    for sample in data.as_chunks::<2>().0 {
        let value = i16::from_le_bytes(*sample) as f64 / i16::MAX as f64;
        sum += value * value;
        count += 1.0;
    }
    (sum / count).sqrt()
}

#[test]
fn ffmpeg_version_is_available() {
    assert!(!ffmpeg_version().unwrap().is_empty());
}

#[test]
fn probe_audio_reads_wav_duration_and_format() {
    let path = temp_file("probe.wav");
    write_sine_wav(&path, 44_100, 2, 16, 1.0, 440.0).unwrap();
    let meta = probe_audio(path.to_str().unwrap()).unwrap();
    assert!((meta.duration_sec - 1.0).abs() < 0.1);
    assert_eq!(meta.sample_rate, 44_100);
    assert_eq!(meta.channels, 2);
    assert_eq!(meta.codec, "pcm_s16le");
}

#[test]
fn prepare_pcm_converts_flac_and_mp3_to_non_silent_cdda_wav() {
    let source = temp_file("source.wav");
    let flac = temp_file("source.flac");
    let mp3 = temp_file("source.mp3");
    write_sine_wav(&source, 48_000, 1, 16, 4.5, 523.25).unwrap();
    ffmpeg_convert(&source, &flac);
    ffmpeg_convert(&source, &mp3);

    let tracks = prepare_pcm(
        vec![
            flac.to_string_lossy().to_string(),
            mp3.to_string_lossy().to_string(),
        ],
        0.25,
        false,
    )
    .unwrap();
    assert_eq!(tracks.len(), 2);
    for track in tracks {
        assert_eq!(track.sample_rate, 44_100);
        assert_eq!(track.channels, 2);
        assert_eq!(track.bits_per_sample, 16);
        assert!(track.duration_sec > 4.6);
        assert!(
            wav_rms(&track.path) > 0.01,
            "converted PCM must be non-silent"
        );
    }
}

#[test]
fn copy_audio_file_imports_external_flac_before_real_pcm_prepare() {
    let outside = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let source = outside.path().join("external-source.wav");
    let flac = outside.path().join("external-source.flac");
    write_sine_wav(&source, 48_000, 1, 16, 4.5, 659.25).unwrap();
    ffmpeg_convert(&source, &flac);

    let imported = copy_audio_file(flac.to_str().unwrap(), project.path(), "p1").unwrap();
    let audio_dir = project
        .path()
        .join("MXTP MKR")
        .join("projects")
        .join("p1")
        .join("audio")
        .canonicalize()
        .unwrap();
    assert!(imported.starts_with(audio_dir));
    assert!(imported.is_file());

    let tracks = prepare_pcm(vec![imported.to_string_lossy().to_string()], 0.0, false).unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].sample_rate, 44_100);
    assert_eq!(tracks[0].channels, 2);
    assert_eq!(tracks[0].bits_per_sample, 16);
    assert!(
        wav_rms(&tracks[0].path) > 0.01,
        "imported external FLAC must produce non-silent PCM"
    );
}

#[test]
fn capacity_check_rejects_overlong_cdda_program() {
    assert!(capacity_check(&[pcm(60.0), pcm(61.0)]));
    assert!(!capacity_check(&[pcm(4_900.0)]));
}

#[test]
fn build_cda_image_refuses_a_program_longer_than_an_80_minute_cd() {
    let error = commands::build_cda_image(vec![pcm(4_000.0), pcm(1_000.0)], None).unwrap_err();
    assert_eq!(error, "Program is 83:20; an 80-minute CD-R holds 79:57");
    assert!(commands::build_cda_image(vec![pcm(4_000.0), pcm(797.0)], None).is_ok());
}

#[test]
fn a_failed_image_build_deletes_only_its_scratch_wavs() {
    let scratch = std::env::temp_dir().join(format!(
        "mxtp_mkr_track_failed_build_{}.wav",
        std::process::id()
    ));
    let keep = tempfile::tempdir().unwrap();
    let user_file = keep.path().join("mxtp_mkr_track_user.wav");
    fs::write(&scratch, b"x").unwrap();
    fs::write(&user_file, b"x").unwrap();
    let mut tracks = vec![pcm(4_000.0), pcm(1_000.0)];
    tracks[0].path = scratch.to_string_lossy().to_string();
    tracks[1].path = user_file.to_string_lossy().to_string();

    assert!(commands::build_cda_image(tracks, None).is_err());

    assert!(!scratch.exists(), "scratch WAV left behind");
    assert!(user_file.exists(), "a WAV outside temp_dir was deleted");
}

fn playlist_folder() -> (tempfile::TempDir, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("Sine Wave Suite");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join(".mxtp-source.json"),
        r#"{"source":"youtube-playlist:SINE","title":"Sine Wave Suite"}"#,
    )
    .unwrap();
    (root, folder)
}

#[test]
fn a_partial_playlist_download_imports_what_arrived() {
    let (_root, folder) = playlist_folder();
    write_sine_wav(&folder.join("001 - Alpha.wav"), 44_100, 2, 16, 1.0, 440.0).unwrap();
    let stdout = format!(
        "==> Reading playlist\n    Folder   : {}\n  Done. 1 x .wav in:\nSkipped: 1 entries\n",
        folder.display()
    );

    let import = commands::import_playlist_output(
        &stdout,
        Some("[youtube] b: Video unavailable"),
        Some("1,2"),
    )
    .unwrap();

    assert_eq!(import.tracks.len(), 1);
    assert_eq!(import.skipped, 1);
    assert!(import.tracks[0].path.ends_with("001 - Alpha.wav"));
    assert_eq!(import.tracks[0].title, "Alpha");

    let no_items = commands::import_playlist_output(&stdout, None, None).unwrap();
    assert_eq!(
        no_items.skipped, 1,
        "the sidecar's skip report is passed on"
    );
}

#[test]
fn a_failed_download_with_no_audio_reports_one_short_sentence() {
    let (_root, folder) = playlist_folder();
    let stdout = format!(
        "{}    Folder   : {}\n",
        "[download] 12.5% of 3.00MiB\n".repeat(400),
        folder.display()
    );
    let error = commands::import_playlist_output(
        &stdout,
        Some("[youtube] a: Sign in to confirm your age"),
        None,
    )
    .unwrap_err();
    assert_eq!(
        error,
        "Couldn't download Sine Wave Suite: [youtube] a: Sign in to confirm your age"
    );
    assert!(error.len() < 200);
    assert!(!error.contains("[download]"));
}

#[test]
fn requested_items_filter_a_reused_cache_folder_and_drop_videos() {
    let (_root, folder) = playlist_folder();
    for (index, title) in ["Alpha", "Beta", "Gamma", "Delta"].iter().enumerate() {
        let name = format!("{:03} - {title}.wav", index + 1);
        write_sine_wav(&folder.join(name), 44_100, 2, 16, 1.0, 440.0).unwrap();
    }
    write_sine_wav(
        &folder.join("005 - Alpha (Official Music Video).wav"),
        44_100,
        2,
        16,
        1.0,
        440.0,
    )
    .unwrap();
    let stdout = format!("    Folder   : {}\n", folder.display());

    let picked = commands::import_playlist_output(&stdout, None, Some("1,3")).unwrap();
    let names = picked
        .tracks
        .iter()
        .map(|track| {
            std::path::Path::new(&track.path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["001 - Alpha.wav", "003 - Gamma.wav"]);
    assert_eq!(picked.skipped, 0);

    let everything = commands::import_playlist_output(&stdout, None, None).unwrap();
    assert_eq!(
        everything.tracks.len(),
        4,
        "the music video is never imported"
    );
    assert!(commands::import_playlist_output(&stdout, None, Some("0")).is_err());

    let with_video = commands::import_playlist_output(&stdout, None, Some("1,5")).unwrap();
    assert_eq!(with_video.tracks.len(), 1);
    assert_eq!(
        with_video.skipped, 0,
        "a requested music video left out on purpose is not a skipped entry"
    );
}

#[test]
fn an_unreadable_file_is_skipped_not_fatal() {
    let (_root, folder) = playlist_folder();
    write_sine_wav(&folder.join("001 - Alpha.wav"), 44_100, 2, 16, 1.0, 440.0).unwrap();
    fs::write(folder.join("002 - Truncated.opus"), b"not audio at all").unwrap();
    write_sine_wav(&folder.join("003 - Gamma.wav"), 44_100, 2, 16, 1.0, 440.0).unwrap();

    let cached = commands::playlist_import_from_folder(&folder).unwrap();
    assert_eq!(cached.tracks.len(), 2);
    assert_eq!(cached.unreadable, vec!["002 - Truncated.opus".to_string()]);
    assert_eq!(cached.skipped, 1);

    let stdout = format!("    Folder   : {}\n", folder.display());
    let downloaded = commands::import_playlist_output(&stdout, None, Some("1-3")).unwrap();
    assert_eq!(downloaded.tracks.len(), 2);
    assert_eq!(downloaded.skipped, 1);
}

#[test]
fn compose_pdf_puts_relative_exports_under_app_data() {
    let app_data = tempfile::tempdir().unwrap();
    let request: mxtp_mkr::pdf_compose::ComposePdfRequest = serde_json::from_value(
        serde_json::json!({ "pieceId": "front", "outputDir": "exports/p1/t1" }),
    )
    .unwrap();

    let pdf = commands::compose_pdf_under(app_data.path(), request).unwrap();

    let expected = app_data
        .path()
        .join("MXTP MKR")
        .join("exports")
        .join("p1")
        .join("t1");
    assert!(pdf.path.starts_with(&expected), "{}", pdf.path.display());
    assert!(pdf.path.is_file());
    assert!(!pdf.path.starts_with(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
    ));
}

#[test]
fn cda_image_has_red_book_layout_and_validated_simulation() {
    let image = build_cda_image(vec![pcm(4.0), pcm(5.0)]).unwrap();
    assert_eq!(image.tracks.len(), 2);
    assert_eq!(image.tracks[0].pregap_sectors, 150);
    assert_eq!(image.tracks[0].start_sector, 4_650);
    assert!(image.total_sectors < 405_000);
    let burners = list_burners().unwrap();
    assert!(burners.iter().all(|drive| !drive.id.is_empty()));
    let result = burn_cda(image, "simulate", true).unwrap();
    assert_eq!(result.progress.first().copied(), Some(0));
    assert_eq!(result.progress.last().copied(), Some(100));
    assert_eq!(result.final_percent, 100);
    assert!(!result.message.is_empty());
}

#[test]
fn compose_pdf_writes_parseable_boxes_marks_imposition_and_annulus() {
    let out = temp_file("pdfs");
    let front = compose_pdf(PieceSpec {
        kind: PieceKind::Front,
        output_dir: out.clone(),
        images: Vec::new(),
        texts: Vec::new(),
    })
    .unwrap();
    assert_pdf_boxes(&front.path, (126.35, 126.35), (120.0, 120.0), 1);

    let tray = compose_pdf(PieceSpec {
        kind: PieceKind::Tray,
        output_dir: out.clone(),
        images: Vec::new(),
        texts: Vec::new(),
    })
    .unwrap();
    let tray_page = first_page_dict(&tray.path);
    assert_pdf_boxes(&tray.path, (156.35, 124.35), (150.0, 118.0), 1);
    assert_eq!(
        real_array(tray_page.get(b"FoldMarksMm").unwrap()),
        vec![6.5, 143.5]
    );

    let booklet = compose_pdf(PieceSpec {
        kind: PieceKind::Booklet(12),
        output_dir: out.clone(),
        images: Vec::new(),
        texts: Vec::new(),
    })
    .unwrap();
    assert_pdf_boxes(&booklet.path, (246.35, 126.35), (240.0, 120.0), 6);
    let doc = Document::load(&booklet.path).unwrap();
    let pages = doc.get_pages();
    let first = doc
        .get_object(*pages.values().next().unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(int_array(first.get(b"ImposedPair").unwrap()), vec![12, 1]);

    let disc = compose_pdf(PieceSpec {
        kind: PieceKind::Disc,
        output_dir: out,
        images: Vec::new(),
        texts: Vec::new(),
    })
    .unwrap();
    let disc_page = first_page_dict(&disc.path);
    assert_eq!(
        real_array(disc_page.get(b"DiscAnnulusMm").unwrap()),
        vec![118.0, 22.0, 15.0]
    );
}

#[test]
fn research_fetches_real_album_data_and_lyrics() {
    let album = lookup_album("Daft Punk", "Discovery").unwrap();
    assert!(album.tracks.len() >= 10);
    assert_eq!(album.tracks[0], "One More Time");
    assert!(album.year >= 2001);
    let lyrics = fetch_lyrics("Daft Punk", "One More Time").unwrap();
    assert!(lyrics.len() > 100);
}

#[test]
fn image_generation_has_mock_png_and_codex_cost_guard() {
    let adapter = MockImageGenAdapter {
        output_dir: temp_file("imagegen"),
    };
    let cover = adapter.generate_cover("Discovery cover", &[]).unwrap();
    let image = image::open(&cover).unwrap();
    assert!(image.width() >= 1417);
    assert!(image.height() >= 1417);

    let mut env = HashMap::new();
    env.insert("OPENAI_API_KEY".to_string(), "metered-key".to_string());
    env.insert("PATH".to_string(), "keep".to_string());
    let child_env = codex_child_env(&env);
    assert!(!child_env.contains_key("OPENAI_API_KEY"));
    assert_eq!(child_env["PATH"], "keep");

    let old_mode = std::env::var("MXTP_MKR_IMAGEGEN").ok();
    std::env::set_var("MXTP_MKR_IMAGEGEN", "mock");
    let generated = generate_cover("mock mode cover", &[]).unwrap();
    assert!(fs::metadata(generated.image_path).unwrap().is_file());
    if let Some(mode) = old_mode {
        std::env::set_var("MXTP_MKR_IMAGEGEN", mode);
    } else {
        std::env::remove_var("MXTP_MKR_IMAGEGEN");
    }
}

fn assert_pdf_boxes(
    path: &std::path::Path,
    media_mm: (f32, f32),
    trim_mm: (f32, f32),
    pages: usize,
) {
    let doc = Document::load(path).unwrap();
    assert_eq!(doc.get_pages().len(), pages);
    let dict = first_page_dict(path);
    let media = rect_mm(dict.get(b"MediaBox").unwrap());
    let trim = rect_mm(dict.get(b"TrimBox").unwrap());
    assert_close(media[2] - media[0], media_mm.0);
    assert_close(media[3] - media[1], media_mm.1);
    assert_close(trim[2] - trim[0], trim_mm.0);
    assert_close(trim[3] - trim[1], trim_mm.1);
}

fn first_page_dict(path: &std::path::Path) -> lopdf::Dictionary {
    let doc = Document::load(path).unwrap();
    let pages = doc.get_pages();
    doc.get_object(*pages.values().next().unwrap())
        .unwrap()
        .as_dict()
        .unwrap()
        .clone()
}

fn rect_mm(object: &Object) -> Vec<f32> {
    real_array(object)
        .into_iter()
        .map(|pt| pt / 72.0 * 25.4)
        .collect()
}

fn real_array(object: &Object) -> Vec<f32> {
    object
        .as_array()
        .unwrap()
        .iter()
        .map(|value| match value {
            Object::Real(value) => *value,
            Object::Integer(value) => *value as f32,
            other => panic!("expected numeric PDF object, got {other:?}"),
        })
        .collect()
}

fn int_array(object: &Object) -> Vec<i64> {
    object
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_i64().unwrap())
        .collect()
}

fn assert_close(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() < 0.1,
        "expected {expected}, got {actual}"
    );
}
