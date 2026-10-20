use crate::audio_prep::{read_wav_meta, PcmTrack, MAX_TRACK_DURATION_SEC};
#[cfg(any(target_os = "linux", windows))]
use crate::hidden_command;
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(windows)]
use std::io::Write;
use std::io::{Read, Seek, SeekFrom};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdaTrack {
    pub number: u8,
    pub path: String,
    pub sectors: u32,
    pub pregap_sectors: u32,
    pub start_sector: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdaImage {
    pub tracks: Vec<CdaTrack>,
    pub leadin_sectors: u32,
    pub leadout_sectors: u32,
    pub total_sectors: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cd_text: Option<CdTextMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdTextMetadata {
    pub album_title: String,
    pub album_artist: String,
    pub tracks: Vec<CdTextTrackMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdTextTrackMetadata {
    pub title: String,
    pub artist: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnResult {
    pub simulated: bool,
    pub progress: Vec<u8>,
    pub final_percent: u8,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawImageValidation {
    pub track_count: usize,
    pub start_of_leadout: i32,
    pub stream_bytes: u64,
    pub sector_count: u64,
    pub has_cd_text: bool,
}

const SECTORS_PER_SECOND: f32 = 75.0;
const PREGAP_SECTORS: u32 = 150;
const LEADIN_SECTORS: u32 = 4_500;
const LEADOUT_SECTORS: u32 = 6_750;
#[cfg(windows)]
const RAW_LEADIN_SECTORS: usize = 22_500;
#[cfg(windows)]
const RAW_PQ_SECTOR_BYTES: u64 = 2_368;
#[cfg(windows)]
const RAW_COOKED_RW_SECTOR_BYTES: u64 = 2_448;
const CD_TEXT_PACK_BYTES: usize = 18;
const CD_TEXT_PAYLOAD_BYTES: usize = 12;

pub fn build_cda_image(tracks: Vec<PcmTrack>) -> Result<CdaImage, String> {
    build_cda_image_with_cd_text(tracks, None)
}

pub fn build_cda_image_with_cd_text(
    tracks: Vec<PcmTrack>,
    cd_text: Option<CdTextMetadata>,
) -> Result<CdaImage, String> {
    if tracks.is_empty() {
        return Err("at least one PCM track is required".to_string());
    }
    if tracks.len() > 99 {
        return Err("CD-DA supports at most 99 tracks".to_string());
    }

    let mut cursor = LEADIN_SECTORS;
    let mut cda_tracks = Vec::with_capacity(tracks.len());
    for (index, track) in tracks.iter().enumerate() {
        validate_pcm_track(track, index + 1)?;
        cursor = cursor
            .checked_add(PREGAP_SECTORS)
            .ok_or_else(|| "CD-DA sector count overflow".to_string())?;
        let sectors = (track.duration_sec * SECTORS_PER_SECOND).ceil() as u32;
        cda_tracks.push(CdaTrack {
            number: (index + 1) as u8,
            path: track.path.clone(),
            sectors,
            pregap_sectors: PREGAP_SECTORS,
            start_sector: cursor,
        });
        cursor = cursor
            .checked_add(sectors)
            .ok_or_else(|| "CD-DA sector count overflow".to_string())?;
    }

    let total = cursor
        .checked_add(LEADOUT_SECTORS)
        .ok_or_else(|| "CD-DA sector count overflow".to_string())?;
    if total > 405_000 {
        return Err("CD-DA image exceeds 90 minute sector bound".to_string());
    }

    let image = CdaImage {
        tracks: cda_tracks,
        leadin_sectors: LEADIN_SECTORS,
        leadout_sectors: LEADOUT_SECTORS,
        total_sectors: total,
        cd_text,
    };
    validate_image(&image)?;
    Ok(image)
}

pub fn cd_text_crc(bytes: &[u8]) -> u16 {
    let mut crc = 0_u16;
    for byte in bytes {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    !crc
}

pub fn encode_cd_text_packs(
    metadata: &CdTextMetadata,
    track_count: usize,
) -> Result<Vec<[u8; CD_TEXT_PACK_BYTES]>, String> {
    let normalized = normalize_cd_text(metadata, track_count)?;
    let mut packs = text_field_packs(0x80, &normalized.titles);
    packs.extend(text_field_packs(0x81, &normalized.performers));

    let mut counts = [0_u8; 16];
    for pack in &packs {
        let index = (pack[0] - 0x80) as usize;
        counts[index] = counts[index].saturating_add(1);
    }
    counts[15] = 3;
    if packs.len() + 3 > 256 {
        return Err("CD-Text metadata exceeds one 256-pack language block".to_string());
    }

    let highest_sequence = (packs.len() + 2) as u8;
    let mut size_info = [0_u8; 36];
    size_info[0] = 0x00;
    size_info[1] = 1;
    size_info[2] = track_count as u8;
    size_info[4..20].copy_from_slice(&counts);
    size_info[20] = highest_sequence;
    size_info[28] = 0x09;
    for part in 0..3 {
        let mut pack = [0_u8; CD_TEXT_PACK_BYTES];
        pack[0] = 0x8f;
        pack[1] = part as u8;
        pack[4..16].copy_from_slice(&size_info[part * 12..part * 12 + 12]);
        packs.push(pack);
    }

    for (sequence, pack) in packs.iter_mut().enumerate() {
        pack[2] = sequence as u8;
        let crc = cd_text_crc(&pack[..16]).to_be_bytes();
        pack[16..18].copy_from_slice(&crc);
    }
    Ok(packs)
}

struct NormalizedCdText {
    titles: Vec<Vec<u8>>,
    performers: Vec<Vec<u8>>,
}

fn normalize_cd_text(
    metadata: &CdTextMetadata,
    track_count: usize,
) -> Result<NormalizedCdText, String> {
    if track_count == 0 || track_count > 99 {
        return Err("CD-Text requires between 1 and 99 tracks".to_string());
    }
    if metadata.tracks.len() != track_count {
        return Err(format!(
            "CD-Text has {} track entries for a {track_count}-track image",
            metadata.tracks.len()
        ));
    }

    let album_title = sanitize_cd_text(&metadata.album_title, b"Untitled CD");
    let album_artist = sanitize_cd_text(&metadata.album_artist, b"Various Artists");
    let mut titles = vec![album_title];
    let mut performers = vec![album_artist.clone()];
    for (index, track) in metadata.tracks.iter().enumerate() {
        titles.push(sanitize_cd_text(
            &track.title,
            format!("Track {:02}", index + 1).as_bytes(),
        ));
        performers.push(sanitize_cd_text(&track.artist, &album_artist));
    }
    Ok(NormalizedCdText { titles, performers })
}

fn sanitize_cd_text(value: &str, fallback: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() || character.is_control() {
            pending_space = !bytes.is_empty();
            continue;
        }
        let replacement: &[u8] = match character {
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => b"'",
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => b"\"",
            '\u{2013}' | '\u{2014}' | '\u{2212}' => b"-",
            '\u{2026}' => b"...",
            character if (character as u32) <= 0xff => {
                if pending_space {
                    bytes.push(b' ');
                }
                pending_space = false;
                bytes.push(character as u8);
                continue;
            }
            _ => b"?",
        };
        if pending_space {
            bytes.push(b' ');
        }
        pending_space = false;
        bytes.extend_from_slice(replacement);
    }
    while bytes.last() == Some(&b' ') {
        bytes.pop();
    }
    if bytes.is_empty() {
        fallback.to_vec()
    } else {
        bytes
    }
}

fn text_field_packs(pack_type: u8, texts: &[Vec<u8>]) -> Vec<[u8; CD_TEXT_PACK_BYTES]> {
    let mut field = Vec::new();
    for (track, text) in texts.iter().enumerate() {
        for (offset, byte) in text.iter().copied().chain(std::iter::once(0)).enumerate() {
            field.push((byte, track as u8, offset));
        }
    }

    field
        .chunks(CD_TEXT_PAYLOAD_BYTES)
        .map(|chunk| {
            let mut pack = [0_u8; CD_TEXT_PACK_BYTES];
            pack[0] = pack_type;
            pack[1] = chunk[0].1;
            pack[3] = match chunk[0].2 {
                0 => 0,
                offset @ 1..=14 => offset as u8,
                _ => 15,
            };
            for (index, (byte, _, _)) in chunk.iter().enumerate() {
                pack[4 + index] = *byte;
            }
            pack
        })
        .collect()
}

#[cfg(windows)]
fn encode_cd_text_rw_subcode(packs: &[[u8; CD_TEXT_PACK_BYTES]], sector_count: usize) -> Vec<u8> {
    let mut subcode = vec![0_u8; sector_count * 96];
    let leadin_sectors = sector_count.min(RAW_LEADIN_SECTORS);
    for sector in 0..leadin_sectors {
        let mut packed = [0_u8; 72];
        for slot in 0..4 {
            let pack = &packs[(sector * 4 + slot) % packs.len()];
            packed[slot * CD_TEXT_PACK_BYTES..(slot + 1) * CD_TEXT_PACK_BYTES]
                .copy_from_slice(pack);
        }
        let symbols = &mut subcode[sector * 96..(sector + 1) * 96];
        for (input, output) in packed
            .as_chunks::<3>()
            .0
            .iter()
            .zip(symbols.as_chunks_mut::<4>().0.iter_mut())
        {
            output[0] = input[0] >> 2;
            output[1] = ((input[0] & 0x03) << 4) | (input[1] >> 4);
            output[2] = ((input[1] & 0x0f) << 2) | (input[2] >> 6);
            output[3] = input[2] & 0x3f;
        }
    }
    subcode
}

pub fn list_burners() -> Result<Vec<DriveInfo>, String> {
    #[cfg(target_os = "linux")]
    {
        list_burners_linux()
    }

    #[cfg(target_os = "macos")]
    {
        Err(MACOS_BURN_UNAVAILABLE.to_string())
    }

    #[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
    {
        Err("Audio-CD burner discovery is unsupported on this operating system".to_string())
    }

    #[cfg(windows)]
    {
        let script = r#"
$ErrorActionPreference = 'Stop'
$master = New-Object -ComObject IMAPI2.MsftDiscMaster2
$drives = @()
for ($i = 0; $i -lt $master.Count; $i++) {
  $id = [string]$master.Item($i)
  $recorder = New-Object -ComObject IMAPI2.MsftDiscRecorder2
  $recorder.InitializeDiscRecorder($id)
  $volume = if ($recorder.VolumePathNames.Count -gt 0) { [string]$recorder.VolumePathNames.Item(0) } else { $id }
  $drives += [pscustomobject]@{ id = $id; name = $volume }
}
$drives | ConvertTo-Json -Compress
"#;

        let output = hidden_command("powershell")
            .args(["-NoProfile", "-Command", script])
            .output()
            .map_err(|err| format!("failed to spawn PowerShell IMAPI2 probe: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "IMAPI2 recorder enumeration failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str::<Vec<DriveInfo>>(&stdout)
            .or_else(|_| serde_json::from_str::<DriveInfo>(&stdout).map(|drive| vec![drive]))
            .map_err(|err| format!("failed to parse IMAPI2 recorder list `{stdout}`: {err}"))
    }
}

#[cfg(target_os = "linux")]
fn list_burners_linux() -> Result<Vec<DriveInfo>, String> {
    let output = hidden_command("cdrskin")
        .arg("--device_links")
        .output()
        .map_err(|err| format!("failed to spawn cdrskin device probe: {err}"))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }

    let output_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(parse_device_links(&output_text))
}

#[cfg(target_os = "linux")]
pub fn parse_device_links(stdout: &str) -> Vec<DriveInfo> {
    stdout.lines().filter_map(parse_device_link).collect()
}

#[cfg(target_os = "linux")]
fn parse_device_link(line: &str) -> Option<DriveInfo> {
    let (number, after_dev) = line.split_once("dev='")?;
    number.trim().parse::<u32>().ok()?;
    let (id, after_id) = after_dev.split_once('\'')?;
    if id.is_empty() {
        return None;
    }
    let (_, vendor_and_model) = after_id.split_once(':')?;
    let (vendor, after_vendor) = quoted_field(vendor_and_model)?;
    let (model, _) = quoted_field(after_vendor)?;
    let name = format!("{} {}", vendor.trim(), model.trim())
        .trim()
        .to_string();
    if name.is_empty() {
        return None;
    }

    Some(DriveInfo {
        id: id.to_string(),
        name,
    })
}

#[cfg(target_os = "linux")]
fn quoted_field(value: &str) -> Option<(&str, &str)> {
    let (_, value) = value.split_once('\'')?;
    let (field, remainder) = value.split_once('\'')?;
    Some((field, remainder))
}

pub fn burn_cda(image: CdaImage, drive: &str, simulate: bool) -> Result<BurnResult, String> {
    validate_image(&image)?;
    if simulate {
        return Ok(BurnResult {
            simulated: true,
            progress: progress_from_image(&image),
            final_percent: 100,
            message: "simulate mode: validated CD-DA image without media write".to_string(),
        });
    }
    burn_cda_real(image, drive)
}

#[cfg(windows)]
fn burn_cda_real(image: CdaImage, drive: &str) -> Result<BurnResult, String> {
    use windows::core::BSTR;
    use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, VARIANT_FALSE, VARIANT_TRUE};
    use windows::Win32::Storage::Imapi::{
        IDiscFormat2RawCD, IDiscRecorder2, MsftDiscFormat2RawCD, MsftDiscRecorder2,
        IMAPI_FORMAT2_RAW_CD_SUBCODE_IS_COOKED, IMAPI_FORMAT2_RAW_CD_SUBCODE_PQ_ONLY,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        STREAM_SEEK_SET,
    };

    let drives = list_burners()?;
    let selected = drives
        .iter()
        .find(|candidate| candidate.id == drive || candidate.name == drive)
        .ok_or_else(|| format!("IMAPI2 recorder `{drive}` was not found"))?;
    let mut progress = vec![0, 5];

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninitialize = if hr.is_ok() {
            true
        } else if hr == RPC_E_CHANGED_MODE {
            false
        } else {
            return Err(format!("IMAPI2 COM initialization failed: {hr:?}"));
        };

        let result = (|| -> windows::core::Result<BurnResult> {
            let raw_image = build_imapi_raw_image(&image).map_err(|message| {
                windows::core::Error::new(windows::Win32::Foundation::E_FAIL, message)
            })?;
            let recorder: IDiscRecorder2 = CoCreateInstance(&MsftDiscRecorder2, None, CLSCTX_ALL)?;
            recorder.InitializeDiscRecorder(&BSTR::from(selected.id.as_str()))?;

            let raw_cd: IDiscFormat2RawCD =
                CoCreateInstance(&MsftDiscFormat2RawCD, None, CLSCTX_ALL)?;
            raw_cd.SetClientName(&BSTR::from("MXTP MKR"))?;
            raw_cd.SetRecorder(&recorder)?;
            recorder.AcquireExclusiveAccess(VARIANT_TRUE, &BSTR::from("MXTP MKR"))?;
            recorder.DisableMcn()?;
            progress.push(12);

            let mut prepared = false;
            let write_result = (|| -> windows::core::Result<()> {
                let sector_type = if raw_image.has_cd_text {
                    IMAPI_FORMAT2_RAW_CD_SUBCODE_IS_COOKED
                } else {
                    IMAPI_FORMAT2_RAW_CD_SUBCODE_PQ_ONLY
                };
                raw_cd.SetRequestedSectorType(sector_type).map_err(|err| {
                    windows::core::Error::new(
                        err.code(),
                        if raw_image.has_cd_text {
                            format!("the CD writer does not support cooked R-W CD-Text: {err}")
                        } else {
                            format!("SetRequestedSectorType: {err}")
                        },
                    )
                })?;
                raw_cd
                    .SetBufferUnderrunFreeDisabled(VARIANT_FALSE)
                    .map_err(|err| {
                        windows::core::Error::new(
                            err.code(),
                            format!("SetBufferUnderrunFreeDisabled: {err}"),
                        )
                    })?;
                raw_cd.SetWriteSpeed(0, VARIANT_FALSE).map_err(|err| {
                    windows::core::Error::new(err.code(), format!("SetWriteSpeed: {err}"))
                })?;
                raw_cd.PrepareMedia().map_err(|err| {
                    windows::core::Error::new(err.code(), format!("PrepareMedia: {err}"))
                })?;
                prepared = true;
                progress.push(20);
                raw_image.stream.Seek(0, STREAM_SEEK_SET, None)?;
                raw_cd.WriteMedia(&raw_image.stream).map_err(|err| {
                    windows::core::Error::new(err.code(), format!("WriteMedia: {err}"))
                })?;
                progress.push(95);
                Ok(())
            })();
            let release_result = if prepared {
                raw_cd.ReleaseMedia().map_err(|err| {
                    windows::core::Error::new(err.code(), format!("ReleaseMedia: {err}"))
                })
            } else {
                Ok(())
            };
            let _ = recorder.EnableMcn();
            let _ = recorder.ReleaseExclusiveAccess();
            write_result?;
            release_result?;
            recorder.EjectMedia()?;
            progress.push(100);

            Ok(BurnResult {
                simulated: false,
                progress,
                final_percent: 100,
                message: if raw_image.has_cd_text {
                    format!("Audio CD with CD-Text completed on {}", selected.name)
                } else {
                    format!("IMAPI2 RawCD write completed on {}", selected.name)
                },
            })
        })();

        if should_uninitialize {
            CoUninitialize();
        }

        result.map_err(|err| format!("IMAPI2 RawCD write failed: {err:?}"))
    }
}

#[cfg(target_os = "linux")]
fn burn_cda_real(image: CdaImage, drive: &str) -> Result<BurnResult, String> {
    let drives = list_burners()?;
    let selected = drives
        .iter()
        .find(|candidate| candidate.id == drive || candidate.name == drive)
        .ok_or_else(|| format!("cdrskin recorder `{drive}` was not found"))?;
    let device_id = selected.id.clone();
    let drive_name = selected.name.clone();
    let validation = validate_imapi_raw_image(&image)?;

    let minfo = hidden_command("cdrskin")
        .args([format!("dev={device_id}"), "-minfo".to_string()])
        .output()
        .map_err(|err| format!("failed to spawn cdrskin media probe: {err}"))?;
    let minfo_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&minfo.stdout),
        String::from_utf8_lossy(&minfo.stderr)
    );
    if !minfo.status.success() {
        return Err(format!("cdrskin media probe failed: {minfo_output}"));
    }
    validate_linux_media(&minfo_output, validation.sector_count)?;

    let audio_bytes = linux_audio_image_bytes(&image)?;
    let temp_dir =
        tempfile::tempdir().map_err(|err| format!("failed to create burn files: {err}"))?;
    let bin_path = temp_dir.path().join("image.bin");
    let cue_path = temp_dir.path().join("image.cue");
    fs::write(&bin_path, &audio_bytes)
        .map_err(|err| format!("failed to write audio image: {err}"))?;
    fs::write(&cue_path, linux_cue_sheet(&image, "image.bin"))
        .map_err(|err| format!("failed to write cue sheet: {err}"))?;
    let cue_path = cue_path
        .canonicalize()
        .map_err(|err| format!("failed to resolve cue sheet path: {err}"))?;

    let cd_text_path = if let Some(metadata) = image.cd_text.as_ref() {
        let path = temp_dir.path().join("cdtext.dat");
        let packs = linux_cd_text_pack_file(metadata, image.tracks.len())?;
        fs::write(&path, packs).map_err(|err| format!("failed to write CD-Text packs: {err}"))?;
        Some(
            path.canonicalize()
                .map_err(|err| format!("failed to resolve CD-Text pack path: {err}"))?,
        )
    } else {
        None
    };

    let mut command = hidden_command("cdrskin");
    command
        // cdrskin resolves FILE entries in a cue sheet against its process
        // working directory, not against the cue sheet's directory. Keep the
        // generated `FILE "image.bin"` reference portable by running the
        // writer from the temporary image directory.
        .current_dir(temp_dir.path())
        .arg("-v")
        .arg(format!("dev={device_id}"))
        .arg("-sao")
        .arg(format!("cuefile={}", cue_path.display()));
    if let Some(path) = cd_text_path.as_ref() {
        command.arg(format!("textfile={}", path.display()));
    }
    let output = command
        .arg("-eject")
        .output()
        .map_err(|err| format!("failed to spawn cdrskin burn: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!("cdrskin burn failed: {stderr}{stdout}"));
    }

    // TODO(post-burn-verify): After confirming `cd-info -C <device>` on the USB
    // burner, remove this environment-variable guard and either reinsert the ejected disc or
    // remove `-eject` above before making this check always-on.
    let toc_note = if std::env::var_os("MXTP_LINUX_BURN_TOC_CHECK").is_some() {
        post_burn_toc_note(&device_id, image.tracks.len())
    } else {
        String::new()
    };

    Ok(BurnResult {
        simulated: false,
        progress: progress_from_image(&image),
        final_percent: 100,
        message: format!("Audio CD with CD-Text completed on {drive_name}{toc_note}"),
    })
}

#[cfg(target_os = "linux")]
fn validate_linux_media(minfo: &str, required_sectors: u64) -> Result<(), String> {
    let lower = minfo.to_ascii_lowercase();
    let unwritable_indicators = [
        "not writable",
        "not writeable",
        "write protected",
        "read-only",
        "media status : is closed",
        "no media",
    ];
    if unwritable_indicators
        .iter()
        .any(|indicator| lower.contains(indicator))
    {
        return Err(format!("cdrskin reports unwritable media: {minfo}"));
    }
    if let Some(free_sectors) = minfo_free_sectors(minfo) {
        if free_sectors < required_sectors {
            return Err(format!(
                "cdrskin reports only {free_sectors} free sectors; {required_sectors} are required"
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn minfo_free_sectors(minfo: &str) -> Option<u64> {
    minfo.lines().find_map(|line| {
        if !line.to_ascii_lowercase().contains("free") {
            return None;
        }
        parse_msf_sectors(line)
    })
}

#[cfg(target_os = "linux")]
fn parse_msf_sectors(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if !bytes[cursor].is_ascii_digit() {
            cursor += 1;
            continue;
        }
        let minutes_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if bytes.get(cursor).copied() != Some(b'm') {
            continue;
        }
        let minutes = value[minutes_start..cursor].parse::<u64>().ok()?;
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let seconds_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if seconds_start == cursor || bytes.get(cursor).copied() != Some(b's') {
            continue;
        }
        let seconds = value[seconds_start..cursor].parse::<u64>().ok()?;
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let frames_start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if frames_start == cursor || bytes.get(cursor).copied() != Some(b'f') {
            continue;
        }
        let frames = value[frames_start..cursor].parse::<u64>().ok()?;
        if seconds < 60 && frames < 75 {
            return minutes
                .checked_mul(60)?
                .checked_add(seconds)?
                .checked_mul(75)?
                .checked_add(frames);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn post_burn_toc_note(device_id: &str, expected_track_count: usize) -> String {
    let output = match hidden_command("cd-info").args(["-C", device_id]).output() {
        Ok(output) => output,
        Err(err) => return format!("; post-burn TOC check could not start: {err}"),
    };
    let output_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return format!("; post-burn TOC check failed: {output_text}");
    }
    match parse_cd_info_track_count(&output_text) {
        Some(track_count) if track_count == expected_track_count => {
            format!("; post-burn TOC check confirmed {track_count} tracks")
        }
        Some(track_count) => format!(
            "; post-burn TOC check reported {track_count} tracks (expected {expected_track_count})"
        ),
        None => format!("; post-burn TOC check could not parse cd-info output: {output_text}"),
    }
}

#[cfg(target_os = "linux")]
fn parse_cd_info_track_count(output: &str) -> Option<usize> {
    let mut track_numbers = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let number = if let Some(rest) = lower.strip_prefix("track") {
            rest.trim_start()
                .split(|character: char| !character.is_ascii_digit())
                .next()
                .and_then(|number| number.parse::<u8>().ok())
        } else if let Some((number, _)) = line.split_once(':') {
            number.trim().parse::<u8>().ok()
        } else {
            None
        };
        if let Some(number) = number {
            track_numbers.push(number);
        }
    }
    track_numbers.sort_unstable();
    track_numbers.dedup();
    (!track_numbers.is_empty()).then_some(track_numbers.len())
}

pub const MACOS_BURN_UNAVAILABLE: &str = "Audio-CD writing on macOS is not implemented in this build. MXTP MKR will not report a successful physical burn until its Disc Recording backend has been implemented and verified on a Mac with an optical writer.";

#[cfg(target_os = "macos")]
fn burn_cda_real(_image: CdaImage, _drive: &str) -> Result<BurnResult, String> {
    Err(MACOS_BURN_UNAVAILABLE.to_string())
}

#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
fn burn_cda_real(_image: CdaImage, _drive: &str) -> Result<BurnResult, String> {
    Err("Audio-CD writing is unsupported on this operating system".to_string())
}

#[cfg(windows)]
struct RawImageBundle {
    stream: windows::Win32::System::Com::IStream,
    _source_streams: Vec<windows::Win32::System::Com::IStream>,
    _subcode_stream: Option<windows::Win32::System::Com::IStream>,
    _temp_dir: tempfile::TempDir,
    start_of_leadout: i32,
    sector_count: u64,
    has_cd_text: bool,
}

#[cfg(windows)]
unsafe fn build_imapi_raw_image(image: &CdaImage) -> Result<RawImageBundle, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::Storage::Imapi::{
        IMAPI_FORMAT2_RAW_CD_SUBCODE_IS_COOKED, IMAPI_FORMAT2_RAW_CD_SUBCODE_PQ_ONLY,
    };
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STGM_READ, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;

    let temp_dir = tempfile::tempdir().map_err(|err| err.to_string())?;
    let mut source_streams: Vec<IStream> = Vec::with_capacity(image.tracks.len());
    for track in &image.tracks {
        let raw_path = temp_dir
            .path()
            .join(format!("track-{:02}.pcm", track.number));
        write_raw_pcm_track(&track.path, &raw_path)?;
        let path = HSTRING::from(raw_path.to_string_lossy().as_ref());
        let stream = SHCreateStreamOnFileEx(&path, STGM_READ.0, 0, false, None::<&IStream>)
            .map_err(|err| format!("failed to open track {} for IMAPI: {err:?}", track.number))?;
        source_streams.push(stream);
    }

    let (provisional, provisional_leadout) =
        create_imapi_raw_stream(&source_streams, IMAPI_FORMAT2_RAW_CD_SUBCODE_PQ_ONLY, None)?;
    let provisional_bytes = imapi_stream_bytes(&provisional)?;
    if provisional_bytes % RAW_PQ_SECTOR_BYTES != 0 {
        return Err(format!(
            "IMAPI PQ image size {provisional_bytes} is not sector aligned"
        ));
    }
    let sector_count = provisional_bytes / RAW_PQ_SECTOR_BYTES;

    let (stream, start_of_leadout, subcode_stream, has_cd_text) = if let Some(metadata) =
        image.cd_text.as_ref()
    {
        let packs = encode_cd_text_packs(metadata, image.tracks.len())?;
        let subcode = encode_cd_text_rw_subcode(&packs, sector_count as usize);
        let subcode_stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)
            .map_err(|err| format!("failed to create CD-Text R-W stream: {err:?}"))?;
        write_stream_bytes(&subcode_stream, &subcode)
            .map_err(|err| format!("failed to write CD-Text R-W stream: {err:?}"))?;
        subcode_stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|err| format!("failed to rewind CD-Text R-W stream: {err:?}"))?;
        drop(provisional);
        let (stream, start_of_leadout) = create_imapi_raw_stream(
            &source_streams,
            IMAPI_FORMAT2_RAW_CD_SUBCODE_IS_COOKED,
            Some(&subcode_stream),
        )?;
        let expected_bytes = sector_count * RAW_COOKED_RW_SECTOR_BYTES;
        let actual_bytes = imapi_stream_bytes(&stream)?;
        if actual_bytes != expected_bytes {
            return Err(format!(
                    "IMAPI cooked R-W image size {actual_bytes} did not match expected {expected_bytes}"
                ));
        }
        (stream, start_of_leadout, Some(subcode_stream), true)
    } else {
        (provisional, provisional_leadout, None, false)
    };

    Ok(RawImageBundle {
        stream,
        _source_streams: source_streams,
        _subcode_stream: subcode_stream,
        _temp_dir: temp_dir,
        start_of_leadout,
        sector_count,
        has_cd_text,
    })
}

#[cfg(windows)]
unsafe fn create_imapi_raw_stream(
    source_streams: &[windows::Win32::System::Com::IStream],
    image_type: windows::Win32::Storage::Imapi::IMAPI_FORMAT2_RAW_CD_DATA_SECTOR_TYPE,
    subcode_stream: Option<&windows::Win32::System::Com::IStream>,
) -> Result<(windows::Win32::System::Com::IStream, i32), String> {
    use windows::Win32::Foundation::VARIANT_FALSE;
    use windows::Win32::Storage::Imapi::{
        IRawCDImageCreator, MsftRawCDImageCreator, IMAPI_CD_SECTOR_AUDIO,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, STREAM_SEEK_SET};

    let creator: IRawCDImageCreator = CoCreateInstance(&MsftRawCDImageCreator, None, CLSCTX_ALL)
        .map_err(|err| format!("failed to create IMAPI raw image creator: {err:?}"))?;
    creator
        .SetResultingImageType(image_type)
        .map_err(|err| format!("failed to select IMAPI raw image type: {err:?}"))?;
    creator
        .SetDisableGaplessAudio(VARIANT_FALSE)
        .map_err(|err| format!("failed to select standard two-second track gaps: {err:?}"))?;
    for (index, stream) in source_streams.iter().enumerate() {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|err| format!("failed to rewind track {} for IMAPI: {err:?}", index + 1))?;
        creator
            .AddTrack(IMAPI_CD_SECTOR_AUDIO, stream)
            .map_err(|err| format!("failed to add track {} to IMAPI image: {err:?}", index + 1))?;
    }
    if let Some(subcode_stream) = subcode_stream {
        creator
            .AddSubcodeRWGenerator(subcode_stream)
            .map_err(|err| format!("failed to attach CD-Text R-W subcode: {err:?}"))?;
    }
    let start_of_leadout = creator
        .StartOfLeadout()
        .map_err(|err| format!("failed to calculate CD leadout: {err:?}"))?;
    let stream = creator
        .CreateResultImage()
        .map_err(|err| format!("failed to create DAO-96 CD image: {err:?}"))?;
    Ok((stream, start_of_leadout))
}

#[cfg(windows)]
unsafe fn imapi_stream_bytes(stream: &windows::Win32::System::Com::IStream) -> Result<u64, String> {
    use windows::Win32::System::Com::{STATFLAG_NONAME, STATSTG};

    let mut stat: STATSTG = std::mem::zeroed();
    stream
        .Stat(&mut stat, STATFLAG_NONAME)
        .map_err(|err| format!("failed to inspect DAO-96 image: {err:?}"))?;
    Ok(stat.cbSize)
}

#[cfg(windows)]
fn write_raw_pcm_track(wav_path: &str, raw_path: &std::path::Path) -> Result<(), String> {
    let meta = read_wav_meta(wav_path)?;
    if meta.sample_rate != 44_100 || meta.channels != 2 || meta.bits_per_sample != 16 {
        return Err(format!(
            "`{wav_path}` is not 44.1kHz/16-bit/stereo CD audio"
        ));
    }
    let mut input = fs::File::open(wav_path).map_err(|err| err.to_string())?;
    input
        .seek(SeekFrom::Start(meta.data_offset))
        .map_err(|err| err.to_string())?;
    let mut output = fs::File::create(raw_path).map_err(|err| err.to_string())?;
    let mut remaining = meta.data_bytes as u64;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let wanted = remaining.min(buffer.len() as u64) as usize;
        input
            .read_exact(&mut buffer[..wanted])
            .map_err(|err| err.to_string())?;
        output
            .write_all(&buffer[..wanted])
            .map_err(|err| err.to_string())?;
        remaining -= wanted as u64;
    }
    let sector_remainder = meta.data_bytes as usize % 2352;
    if sector_remainder != 0 {
        output
            .write_all(&vec![0_u8; 2352 - sector_remainder])
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn validate_imapi_raw_image(image: &CdaImage) -> Result<RawImageValidation, String> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    validate_image(image)?;
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninitialize = if hr.is_ok() {
            true
        } else if hr == RPC_E_CHANGED_MODE {
            false
        } else {
            return Err(format!("IMAPI2 COM initialization failed: {hr:?}"));
        };
        let result = (|| -> Result<RawImageValidation, String> {
            let raw = build_imapi_raw_image(image)?;
            let stream_bytes = imapi_stream_bytes(&raw.stream)?;
            Ok(RawImageValidation {
                track_count: image.tracks.len(),
                start_of_leadout: raw.start_of_leadout,
                stream_bytes,
                sector_count: raw.sector_count,
                has_cd_text: raw.has_cd_text,
            })
        })();
        if should_uninitialize {
            CoUninitialize();
        }
        result
    }
}

#[cfg(target_os = "linux")]
pub fn validate_imapi_raw_image(image: &CdaImage) -> Result<RawImageValidation, String> {
    validate_image(image)?;
    let audio_bytes = linux_audio_image_bytes(image)?;
    if let Some(metadata) = image.cd_text.as_ref() {
        linux_cd_text_pack_file(metadata, image.tracks.len())?;
    }
    Ok(RawImageValidation {
        track_count: image.tracks.len(),
        start_of_leadout: (image.total_sectors - image.leadout_sectors) as i32,
        stream_bytes: audio_bytes.len() as u64,
        sector_count: audio_bytes.len() as u64 / 2352,
        has_cd_text: image.cd_text.is_some(),
    })
}

#[cfg(target_os = "macos")]
pub fn validate_imapi_raw_image(_image: &CdaImage) -> Result<RawImageValidation, String> {
    Err(MACOS_BURN_UNAVAILABLE.to_string())
}

#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
pub fn validate_imapi_raw_image(_image: &CdaImage) -> Result<RawImageValidation, String> {
    Err("Raw burn-image validation is unsupported on this operating system".to_string())
}

fn validate_pcm_track(track: &PcmTrack, number: usize) -> Result<(), String> {
    if !track.duration_sec.is_finite() || track.duration_sec > MAX_TRACK_DURATION_SEC {
        return Err(format!(
            "track {number} exceeds the {MAX_TRACK_DURATION_SEC}-second duration limit"
        ));
    }
    if track.duration_sec < 4.0 {
        return Err(format!("track {number} is shorter than 4 seconds"));
    }
    if track.sample_rate != 44_100 || track.channels != 2 || track.bits_per_sample != 16 {
        return Err(format!(
            "track {number} is not CD-DA PCM: {}Hz/{}ch/{}bit",
            track.sample_rate, track.channels, track.bits_per_sample
        ));
    }
    Ok(())
}

fn validate_image(image: &CdaImage) -> Result<(), String> {
    if image.tracks.is_empty() {
        return Err("cannot burn an empty image".to_string());
    }
    if image.leadin_sectors != LEADIN_SECTORS || image.leadout_sectors != LEADOUT_SECTORS {
        return Err("CD-DA image has invalid lead-in/lead-out sectors".to_string());
    }
    let mut cursor = image.leadin_sectors;
    for (index, track) in image.tracks.iter().enumerate() {
        if track.number as usize != index + 1 {
            return Err("CD-DA track numbers must be contiguous".to_string());
        }
        if track.pregap_sectors != PREGAP_SECTORS {
            return Err(format!("track {} has invalid pregap", track.number));
        }
        cursor = cursor
            .checked_add(track.pregap_sectors)
            .ok_or_else(|| "CD-DA sector count overflow".to_string())?;
        if track.start_sector != cursor {
            return Err(format!(
                "track {} has an invalid start sector",
                track.number
            ));
        }
        if track.sectors < (4.0 * SECTORS_PER_SECOND) as u32 {
            return Err(format!(
                "track {} is shorter than Red Book minimum",
                track.number
            ));
        }
        cursor = cursor
            .checked_add(track.sectors)
            .ok_or_else(|| "CD-DA sector count overflow".to_string())?;
    }
    let total = cursor
        .checked_add(image.leadout_sectors)
        .ok_or_else(|| "CD-DA sector count overflow".to_string())?;
    if image.total_sectors != total {
        return Err("CD-DA image total sectors do not match its tracks".to_string());
    }
    if total > 405_000 {
        return Err("CD-DA image exceeds 90 minute sector bound".to_string());
    }
    if let Some(metadata) = image.cd_text.as_ref() {
        encode_cd_text_packs(metadata, image.tracks.len())?;
    }
    Ok(())
}

pub fn cda_stream_bytes(image: &CdaImage) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0_u8; image.leadin_sectors as usize * 2352];
    for track in &image.tracks {
        bytes.extend(vec![0_u8; track.pregap_sectors as usize * 2352]);
        bytes.extend(track_pcm_sectors(track)?);
    }
    bytes.extend(vec![0_u8; image.leadout_sectors as usize * 2352]);
    Ok(bytes)
}

fn track_pcm_sectors(track: &CdaTrack) -> Result<Vec<u8>, String> {
    let meta = read_wav_meta(&track.path)?;
    let mut file = fs::File::open(&track.path).map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(meta.data_offset))
        .map_err(|err| err.to_string())?;
    let target_len = track.sectors as usize * 2352;
    let mut data = vec![0_u8; meta.data_bytes as usize];
    file.read_exact(&mut data).map_err(|err| err.to_string())?;
    if data.len() < target_len {
        data.resize(target_len, 0);
    } else {
        data.truncate(target_len);
    }
    Ok(data)
}

#[cfg(target_os = "linux")]
pub fn linux_audio_image_bytes(image: &CdaImage) -> Result<Vec<u8>, String> {
    let total_sectors = image.tracks.iter().try_fold(0_u32, |total, track| {
        total
            .checked_add(track.pregap_sectors)
            .and_then(|total| total.checked_add(track.sectors))
            .ok_or_else(|| "CD-DA sector count overflow".to_string())
    })?;
    let mut bytes = Vec::with_capacity(total_sectors as usize * 2352);
    for track in &image.tracks {
        bytes.extend(vec![0_u8; track.pregap_sectors as usize * 2352]);
        bytes.extend(track_pcm_sectors(track)?);
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
pub fn linux_cue_sheet(image: &CdaImage, bin_filename: &str) -> String {
    let mut cue = format!("FILE \"{bin_filename}\" BINARY\n");
    let mut cursor = 0_u32;
    for track in &image.tracks {
        cue.push_str(&format!("  TRACK {:02} AUDIO\n", track.number));
        if track.pregap_sectors > 0 {
            cue.push_str(&format!("    INDEX 00 {}\n", sector_time(cursor)));
        }
        let index_one = cursor + track.pregap_sectors;
        cue.push_str(&format!("    INDEX 01 {}\n", sector_time(index_one)));
        cursor = index_one + track.sectors;
    }
    cue
}

#[cfg(target_os = "linux")]
pub fn linux_cd_text_pack_file(
    metadata: &CdTextMetadata,
    track_count: usize,
) -> Result<Vec<u8>, String> {
    let packs = encode_cd_text_packs(metadata, track_count)?;
    let mut bytes = Vec::with_capacity(packs.len() * CD_TEXT_PACK_BYTES);
    for pack in packs {
        bytes.extend(pack);
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn sector_time(sectors: u32) -> String {
    let frames = sectors % 75;
    let seconds = (sectors / 75) % 60;
    let minutes = sectors / (75 * 60);
    format!("{minutes:02}:{seconds:02}:{frames:02}")
}

#[cfg(windows)]
fn write_stream_bytes(
    stream: &windows::Win32::System::Com::IStream,
    bytes: &[u8],
) -> windows::core::Result<()> {
    for chunk in bytes.chunks(u32::MAX as usize) {
        unsafe {
            stream
                .Write(chunk.as_ptr().cast(), chunk.len() as u32, None)
                .ok()?;
        }
    }
    Ok(())
}

fn progress_from_image(image: &CdaImage) -> Vec<u8> {
    let mut checkpoints = vec![0];
    let writable = image
        .total_sectors
        .saturating_sub(image.leadin_sectors + image.leadout_sectors)
        .max(1);
    let mut written = 0_u32;
    for track in &image.tracks {
        written += track.pregap_sectors + track.sectors;
        let percent = ((written as f32 / writable as f32) * 100.0).round() as u8;
        if checkpoints.last().copied() != Some(percent.min(99)) {
            checkpoints.push(percent.min(99));
        }
    }
    checkpoints.push(100);
    checkpoints.dedup();
    checkpoints
}
