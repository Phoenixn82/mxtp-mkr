use mxtp_mkr::audio_prep::{prepare_pcm, write_sine_wav, PcmTrack};
#[cfg(any(windows, target_os = "linux"))]
use mxtp_mkr::burn::build_cda_image_with_cd_text;
#[cfg(any(windows, target_os = "linux"))]
use mxtp_mkr::burn::list_burners;
use mxtp_mkr::burn::{
    build_cda_image, burn_cda, cd_text_crc, cda_stream_bytes, encode_cd_text_packs,
    validate_imapi_raw_image, CdTextMetadata, CdTextTrackMetadata, MACOS_BURN_UNAVAILABLE,
};
#[cfg(target_os = "linux")]
use mxtp_mkr::burn::{
    linux_audio_image_bytes, linux_cd_text_pack_file, linux_cue_sheet, parse_device_links,
    CdaImage, CdaTrack,
};
use mxtp_mkr::commands::{album_lookup_args, playlist_cover_path, playlist_download_args};

#[test]
fn playlist_bridge_invokes_the_named_tool_in_best_source_mode() {
    let args = playlist_download_args(
        std::path::Path::new("C:/tools/Get-PlaylistMp3.ps1"),
        "https://www.youtube.com/playlist?list=PL123",
        std::path::Path::new("C:/MXTP/playlists"),
        Some("1,3,7-9"),
    )
    .unwrap();
    assert!(args.windows(2).any(|pair| pair == ["-Format", "best"]));
    assert!(args.iter().any(|arg| arg == "-NoPause"));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-Url", "https://www.youtube.com/playlist?list=PL123"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-PlaylistItems", "1,3,7-9"]));
}

#[test]
fn album_search_uses_artist_album_resolver_without_a_pasted_url() {
    let args = album_lookup_args(
        std::path::Path::new("C:/tools/Get-PlaylistMp3.ps1"),
        "Prettifun",
        "Pretti Loves U 2",
    );
    assert!(args.windows(2).any(|pair| pair == ["-Artist", "Prettifun"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-Album", "Pretti Loves U 2"]));
    assert!(args.iter().any(|arg| arg == "-ResolveOnly"));
    assert!(!args.iter().any(|arg| arg == "-Url"));
}

#[test]
fn playlist_bridge_finds_downloaded_cover_art() {
    let dir = tempfile::tempdir().unwrap();
    let cover = dir.path().join("cover.jpg");
    std::fs::write(&cover, b"cover").unwrap();
    assert_eq!(playlist_cover_path(dir.path()), Some(cover));
}

#[test]
fn macos_burn_capability_message_never_claims_an_unverified_write() {
    assert!(MACOS_BURN_UNAVAILABLE.contains("not implemented"));
    assert!(MACOS_BURN_UNAVAILABLE.contains("Disc Recording"));
    assert!(MACOS_BURN_UNAVAILABLE.contains("verified on a Mac"));
}

#[test]
fn cd_text_crc_matches_the_documented_reference_pack() {
    let pack_without_crc = [
        0x88, 0x00, 0x23, 0x00, 0x01, 0x0e, 0x00, 0x3f, 0x02, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00,
    ];
    assert_eq!(cd_text_crc(&pack_without_crc), 0x1200);
}

#[test]
fn cd_text_packs_sanitize_titles_and_keep_valid_crcs() {
    let metadata = CdTextMetadata {
        album_title: "  Psykotic\0 ".to_string(),
        album_artist: "System\nof a Down".to_string(),
        tracks: vec![CdTextTrackMetadata {
            title: "Track\tOne — “Mix” 🧨".to_string(),
            artist: "".to_string(),
        }],
    };
    let packs = encode_cd_text_packs(&metadata, 1).unwrap();

    assert!(packs
        .iter()
        .all(|pack| { u16::from_be_bytes([pack[16], pack[17]]) == cd_text_crc(&pack[..16]) }));
    assert_eq!(packs.iter().filter(|pack| pack[0] == 0x8f).count(), 3);
    assert_eq!(
        cd_text_values(&packs, 0x80, 2),
        [b"Psykotic".to_vec(), b"Track One - \"Mix\" ?".to_vec(),]
    );
    assert_eq!(
        cd_text_values(&packs, 0x81, 2),
        [b"System of a Down".to_vec(), b"System of a Down".to_vec(),]
    );
}

#[test]
fn cd_text_rejects_a_track_metadata_count_mismatch() {
    let metadata = CdTextMetadata {
        album_title: "Album".to_string(),
        album_artist: "Artist".to_string(),
        tracks: vec![],
    };
    let error = encode_cd_text_packs(&metadata, 1).unwrap_err();
    assert!(
        error.contains("0 track entries for a 1-track image"),
        "{error}"
    );
}

fn cd_text_values(packs: &[[u8; 18]], pack_type: u8, count: usize) -> Vec<Vec<u8>> {
    packs
        .iter()
        .filter(|pack| pack[0] == pack_type)
        .flat_map(|pack| pack[4..16].iter().copied())
        .collect::<Vec<_>>()
        .split(|byte| *byte == 0)
        .take(count)
        .map(<[u8]>::to_vec)
        .collect()
}

#[cfg(windows)]
#[test]
fn non_simulated_burn_reaches_imapi_path_instead_of_stub_gate() {
    let image = build_cda_image(vec![PcmTrack {
        path: "track.wav".to_string(),
        duration_sec: 5.0,
        sample_rate: 44_100,
        channels: 2,
        bits_per_sample: 16,
    }])
    .unwrap();

    let error = burn_cda(image, "definitely-not-a-real-drive", false).unwrap_err();
    assert!(
        error.contains("IMAPI2")
            || error.contains("drive")
            || error.contains("recorder")
            || error.contains("Windows"),
        "{error}"
    );
}

#[test]
fn simulated_burn_never_touches_a_real_drive_id() {
    let image = build_cda_image(vec![PcmTrack {
        path: "track.wav".to_string(),
        duration_sec: 5.0,
        sample_rate: 44_100,
        channels: 2,
        bits_per_sample: 16,
    }])
    .unwrap();

    let result = burn_cda(image, "real-hardware-drive-id", true).unwrap();
    assert!(result.simulated);
    assert_eq!(
        result.message,
        "simulate mode: validated CD-DA image without media write"
    );
}

#[test]
fn absurd_track_duration_is_rejected_before_sector_math() {
    let error = build_cda_image(vec![PcmTrack {
        path: "track.wav".to_string(),
        duration_sec: f32::MAX,
        sample_rate: 44_100,
        channels: 2,
        bits_per_sample: 16,
    }])
    .unwrap_err();

    assert!(error.contains("duration limit"), "{error}");
}

#[test]
fn cda_stream_bytes_include_silent_leadin_and_leadout_regions() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("track.wav");
    write_sine_wav(&wav, 44_100, 2, 16, 4.0, 440.0).unwrap();
    let image = build_cda_image(vec![PcmTrack {
        path: wav.to_string_lossy().to_string(),
        duration_sec: 4.0,
        sample_rate: 44_100,
        channels: 2,
        bits_per_sample: 16,
    }])
    .unwrap();

    let bytes = cda_stream_bytes(&image).unwrap();
    let sector_bytes = 2352_usize;
    assert_eq!(bytes.len(), image.total_sectors as usize * sector_bytes);
    assert!(bytes[..image.leadin_sectors as usize * sector_bytes]
        .iter()
        .all(|byte| *byte == 0));
    assert!(
        bytes[bytes.len() - image.leadout_sectors as usize * sector_bytes..]
            .iter()
            .all(|byte| *byte == 0)
    );
}

#[cfg(windows)]
#[test]
fn imapi_builds_a_real_dao96_image_with_toc_and_pq_subchannels() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.wav");
    let second = dir.path().join("second.wav");
    write_sine_wav(&first, 44_100, 2, 16, 4.0, 440.0).unwrap();
    write_sine_wav(&second, 44_100, 2, 16, 5.0, 660.0).unwrap();
    let image = build_cda_image(vec![
        PcmTrack {
            path: first.to_string_lossy().to_string(),
            duration_sec: 4.0,
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        },
        PcmTrack {
            path: second.to_string_lossy().to_string(),
            duration_sec: 5.0,
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        },
    ])
    .unwrap();

    let raw = validate_imapi_raw_image(&image).unwrap();
    assert_eq!(raw.track_count, 2);
    assert!(raw.start_of_leadout > 0);
    assert!(!raw.has_cd_text);
    assert_eq!(raw.stream_bytes, raw.sector_count * 2368);
    assert!(raw.stream_bytes > image.total_sectors as u64 * 2352);
}

#[cfg(windows)]
#[test]
fn imapi_builds_a_cooked_rw_image_with_cd_text() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("track.wav");
    write_sine_wav(&wav, 44_100, 2, 16, 4.0, 440.0).unwrap();
    let image = build_cda_image_with_cd_text(
        vec![PcmTrack {
            path: wav.to_string_lossy().to_string(),
            duration_sec: 4.0,
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        }],
        Some(CdTextMetadata {
            album_title: "Psykotic".to_string(),
            album_artist: "System of a Down".to_string(),
            tracks: vec![CdTextTrackMetadata {
                title: "Track One".to_string(),
                artist: "System of a Down".to_string(),
            }],
        }),
    )
    .unwrap();

    let raw = validate_imapi_raw_image(&image).unwrap();
    assert!(raw.has_cd_text);
    assert!(raw.sector_count > 0);
    assert_eq!(raw.stream_bytes, raw.sector_count * 2448);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_validator_builds_plain_audio_image_with_cd_text() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("track.wav");
    write_sine_wav(&wav, 44_100, 2, 16, 4.0, 440.0).unwrap();
    let image = build_cda_image_with_cd_text(
        vec![PcmTrack {
            path: wav.to_string_lossy().to_string(),
            duration_sec: 4.0,
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        }],
        Some(CdTextMetadata {
            album_title: "Psykotic".to_string(),
            album_artist: "System of a Down".to_string(),
            tracks: vec![CdTextTrackMetadata {
                title: "Track One".to_string(),
                artist: "System of a Down".to_string(),
            }],
        }),
    )
    .unwrap();

    let bytes = linux_audio_image_bytes(&image).unwrap();
    let raw = validate_imapi_raw_image(&image).unwrap();
    let expected_sectors = image.tracks[0].pregap_sectors + image.tracks[0].sectors;
    assert_eq!(raw.track_count, 1);
    assert_eq!(raw.sector_count, expected_sectors as u64);
    assert_eq!(raw.stream_bytes, bytes.len() as u64);
    assert_eq!(raw.stream_bytes, raw.sector_count * 2352);
    assert_eq!(
        raw.start_of_leadout,
        (image.total_sectors - image.leadout_sectors) as i32
    );
    assert!(raw.has_cd_text);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_cue_sheet_uses_local_pregap_offsets() {
    let image = build_cda_image(vec![
        PcmTrack {
            path: "first.wav".to_string(),
            duration_sec: 4.0,
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        },
        PcmTrack {
            path: "second.wav".to_string(),
            duration_sec: 5.0,
            sample_rate: 44_100,
            channels: 2,
            bits_per_sample: 16,
        },
    ])
    .unwrap();

    assert_eq!(
        linux_cue_sheet(&image, "image.bin"),
        concat!(
            "FILE \"image.bin\" BINARY\n",
            "  TRACK 01 AUDIO\n",
            "    INDEX 00 00:00:00\n",
            "    INDEX 01 00:02:00\n",
            "  TRACK 02 AUDIO\n",
            "    INDEX 00 00:06:00\n",
            "    INDEX 01 00:08:00\n",
        )
    );

    let no_pregap = CdaImage {
        tracks: vec![CdaTrack {
            number: 1,
            path: "track.wav".to_string(),
            sectors: 300,
            pregap_sectors: 0,
            start_sector: 0,
        }],
        leadin_sectors: 4_500,
        leadout_sectors: 6_750,
        total_sectors: 11_550,
        cd_text: None,
    };
    assert_eq!(
        linux_cue_sheet(&no_pregap, "image.bin"),
        "FILE \"image.bin\" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn linux_cd_text_pack_file_has_no_header() {
    let metadata = CdTextMetadata {
        album_title: "Psykotic".to_string(),
        album_artist: "System of a Down".to_string(),
        tracks: vec![CdTextTrackMetadata {
            title: "Track One".to_string(),
            artist: "System of a Down".to_string(),
        }],
    };
    let packs = encode_cd_text_packs(&metadata, 1).unwrap();
    let pack_file = linux_cd_text_pack_file(&metadata, 1).unwrap();

    assert_eq!(pack_file.len(), packs.len() * 18);
    assert_eq!(
        pack_file,
        packs
            .iter()
            .flat_map(|pack| pack.iter().copied())
            .collect::<Vec<_>>()
    );
}

#[cfg(target_os = "linux")]
#[test]
fn linux_device_link_parser_ignores_this_machine_no_drive_output() {
    let output = r#"cdrskin 1.5.8 : limited cdrecord compatibility wrapper for libburn
cdrskin: scanning for devices ...
cdrskin: NOTE : No usable drive detected.
cdrskin: HINT : Run this program as superuser with option --devices
cdrskin: HINT : Allow rw-access to the dev='...' file of the burner.
cdrskin: HINT : Busy drives are invisible. (Busy = open O_EXCL)
cdrskin: ... scanning for devices done
cdrskin: Overview of accessible drives (0 found) :
-----------------------------------------------------------------------------
-----------------------------------------------------------------------------"#;
    assert!(parse_device_links(output).is_empty());
}

#[cfg(target_os = "linux")]
#[test]
fn linux_device_link_parser_reads_documented_device_rows() {
    let output = concat!(
        "cdrskin 1.5.8 : limited cdrecord compatibility wrapper for libburn\n",
        "  0  dev='/dev/cdrw' rw-rw---- : 'HL-DT-ST' 'DVDRAM GH24NSD5'\n",
        "  1  dev='/dev/cdrom' rw-rw---- : 'PIONEER' 'BD-RW   BDR-XD08'\n",
        "cdrskin: Overview of accessible drives (2 found) :\n",
    );
    assert_eq!(
        parse_device_links(output),
        vec![
            mxtp_mkr::burn::DriveInfo {
                id: "/dev/cdrw".to_string(),
                name: "HL-DT-ST DVDRAM GH24NSD5".to_string(),
            },
            mxtp_mkr::burn::DriveInfo {
                id: "/dev/cdrom".to_string(),
                name: "PIONEER BD-RW   BDR-XD08".to_string(),
            },
        ]
    );
}

#[test]
fn downloaded_best_source_builds_cdda_image_when_requested() {
    let Ok(source) = std::env::var("MXTP_SMOKE_AUDIO") else {
        return;
    };
    let pcm = prepare_pcm(vec![source], 0.0, false).unwrap();
    assert_eq!(pcm.len(), 1);
    assert_eq!(pcm[0].sample_rate, 44_100);
    assert_eq!(pcm[0].channels, 2);
    assert_eq!(pcm[0].bits_per_sample, 16);
    let image = build_cda_image(pcm).unwrap();
    let raw = validate_imapi_raw_image(&image).unwrap();
    println!(
        "prepared {} DAO-96 bytes; leadout LBA {}",
        raw.stream_bytes, raw.start_of_leadout
    );
    assert!(raw.stream_bytes > 0);
}

#[cfg(any(windows, target_os = "linux"))]
#[test]
fn simulate_reports_no_burner_detected_when_imapi2_enumerates_zero_recorders() {
    let burners = list_burners().unwrap();
    if !burners.is_empty() {
        return;
    }

    let image = build_cda_image(vec![PcmTrack {
        path: "track.wav".to_string(),
        duration_sec: 5.0,
        sample_rate: 44_100,
        channels: 2,
        bits_per_sample: 16,
    }])
    .unwrap();

    let result = burn_cda(image, "simulate", true).unwrap();
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    let message = result.message.to_lowercase();
    assert!(
        message.contains("validated cd-da image without media write"),
        "{message}"
    );
    assert!(!message.contains("test-burn ready"), "{message}");
}
