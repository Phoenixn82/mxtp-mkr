use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

pub mod app_data;
pub mod apple_music;
pub mod audio_prep;
pub mod burn;
pub mod commands;
pub mod geometry;
pub mod pdf_compose;
pub mod project_store;
pub mod research;
pub mod youtube;

pub const fn hidden_child_creation_flags() -> u32 {
    if cfg!(windows) {
        0x0800_0000
    } else {
        0
    }
}

pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(not(windows))]
    let command = Command::new(program);
    #[cfg(windows)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(hidden_child_creation_flags());
    }
    command
}

/// Find an external tool: its override variable, then `preferred_dirs`, then
/// PATH, then a copy next to the app binary, then the Homebrew and /usr
/// directories a GUI launch's minimal PATH can lack. PATH comes before the app
/// binary's directory because a deb or rpm install puts that binary in
/// /usr/bin, whose distro tools must not beat the person's PATH order. A set override is final:
/// it is never silently replaced by another copy of the tool, so a stub or a
/// pinned build can't fall through to the system one.
pub fn resolve_executable(
    label: &str,
    executable: &str,
    override_var: &str,
    preferred_dirs: &[PathBuf],
) -> Result<PathBuf, String> {
    let file_name = if cfg!(windows) {
        format!("{executable}.exe")
    } else {
        executable.to_string()
    };
    if let Some(override_path) = std::env::var_os(override_var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        // A file that is not executable is still returned: starting it then
        // reports the real problem instead of running a different binary.
        return if override_path.is_file() {
            Ok(override_path)
        } else {
            Err(format!(
                "{label} was not found at {override_var} (`{}`). Fix or unset {override_var}.",
                override_path.display()
            ))
        };
    }
    let bundled_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    tool_search_dirs(preferred_dirs, std::env::var_os("PATH"), bundled_dir)
        .into_iter()
        .map(|dir| dir.join(&file_name))
        .find(|candidate| is_executable(candidate))
        .ok_or_else(|| {
            format!(
                "{label} was not found. Install `{executable}` and restart MXTP MKR, or set {override_var} to its path."
            )
        })
}

/// The directories `resolve_executable` searches, in order.
fn tool_search_dirs(
    preferred_dirs: &[PathBuf],
    path_var: Option<std::ffi::OsString>,
    bundled_dir: Option<PathBuf>,
) -> Vec<PathBuf> {
    let path_dirs = path_var
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    preferred_dirs
        .iter()
        .cloned()
        .chain(path_dirs)
        .chain(bundled_dir)
        .chain(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                .into_iter()
                .filter(|_| cfg!(not(windows)))
                .map(PathBuf::from),
        )
        .collect()
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Env defaults for research output that would otherwise land in the OS temp
/// dir (wiped on reboot): `(variable, directory)` pairs for every variable that
/// is not already set.
pub fn default_storage_env(
    app_data: &Path,
    is_set: impl Fn(&str) -> bool,
) -> Vec<(&'static str, PathBuf)> {
    let root = app_data.join("MXTP MKR");
    [
        ("MXTP_MKR_COVER_OUTPUT_DIR", "covers"),
        ("MXTP_MKR_IMAGEGEN_OUTPUT_DIR", "imagegen"),
        ("MXTP_MKR_CACHE_DIR", "cache"),
    ]
    .into_iter()
    .filter(|(name, _)| !is_set(name))
    .map(|(name, dir)| (name, root.join(dir)))
    .collect()
}

#[cfg(not(test))]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if let Ok(base) = app_data::app_data_dir(app.handle()) {
                for (name, dir) in default_storage_env(&base, |name| {
                    std::env::var_os(name).is_some_and(|value| !value.is_empty())
                }) {
                    std::env::set_var(name, dir);
                }
            }
            audio_prep::sweep_stale_scratch_wavs(std::time::Duration::from_secs(60 * 60));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ffmpeg_version,
            commands::probe_audio,
            commands::prepare_pcm,
            commands::copy_audio_file,
            commands::download_playlist_best,
            commands::find_youtube_album_playlist,
            commands::find_youtube_track,
            commands::list_cached_playlists,
            commands::load_cd_projects,
            commands::save_cd_project,
            commands::delete_cd_project,
            commands::load_imported_music_sources,
            commands::save_imported_music_sources,
            commands::import_apple_music_library,
            commands::list_burners,
            commands::build_cda_image,
            commands::burn_cda,
            commands::compose_pdf,
            commands::lookup_album,
            commands::fetch_lyrics,
            commands::generate_cover,
            commands::edit_cover_from_original,
            commands::fetch_cover_theme,
            commands::fetch_real_cover_file,
            commands::art_direct_from_references,
            commands::fetch_era_covers,
            commands::copy_art_file,
            commands::cover_edit_available
        ])
        .run(tauri::generate_context!())
        .expect("error while running MXTP MKR");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_env_defaults_to_app_data_and_respects_overrides() {
        let base = Path::new("/data/com.phoenix.mxtpmkr");
        let defaults = default_storage_env(base, |name| name == "MXTP_MKR_CACHE_DIR");
        assert_eq!(
            defaults,
            vec![
                (
                    "MXTP_MKR_COVER_OUTPUT_DIR",
                    base.join("MXTP MKR").join("covers")
                ),
                (
                    "MXTP_MKR_IMAGEGEN_OUTPUT_DIR",
                    base.join("MXTP MKR").join("imagegen")
                ),
            ]
        );
        assert!(default_storage_env(base, |_| true).is_empty());
    }

    #[test]
    fn missing_tool_error_names_the_tool_and_its_override() {
        let error = resolve_executable(
            "MXTP test tool",
            "mxtp-test-tool-that-does-not-exist",
            "MXTP_TEST_TOOL_PATH",
            &[],
        )
        .unwrap_err();
        assert!(error.contains("mxtp-test-tool-that-does-not-exist"));
        assert!(error.contains("MXTP_TEST_TOOL_PATH"));
        assert!(!error.contains("powershell"));
    }

    #[cfg(unix)]
    #[test]
    fn a_set_override_never_falls_through_to_another_copy() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let preferred = dir.path().join("mxtp-override-tool");
        std::fs::write(&preferred, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&preferred, std::fs::Permissions::from_mode(0o755)).unwrap();
        let stub_dir = dir.path().join("stub");
        std::fs::create_dir_all(&stub_dir).unwrap();
        let stub = stub_dir.join("mxtp-override-tool");
        std::fs::write(&stub, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o644)).unwrap();
        let var = "MXTP_TEST_OVERRIDE_IS_FINAL";

        std::env::set_var(var, &stub);
        let found = resolve_executable(
            "tool",
            "mxtp-override-tool",
            var,
            &[dir.path().to_path_buf()],
        );
        std::env::set_var(var, dir.path().join("missing-tool"));
        let missing = resolve_executable(
            "tool",
            "mxtp-override-tool",
            var,
            &[dir.path().to_path_buf()],
        );
        std::env::remove_var(var);

        assert_eq!(
            found.unwrap(),
            stub,
            "a non-executable override is still the one used"
        );
        let error = missing.unwrap_err();
        assert!(
            error.contains(var) && error.contains("missing-tool"),
            "{error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_wins_over_the_app_binary_dir() {
        let dirs = tool_search_dirs(
            &[PathBuf::from("/preferred")],
            Some(std::ffi::OsString::from(
                "/home/me/.local/bin:/usr/local/bin",
            )),
            Some(PathBuf::from("/usr/bin")),
        );
        assert_eq!(
            dirs,
            [
                "/preferred",
                "/home/me/.local/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
            ]
            .map(PathBuf::from)
        );
    }

    #[cfg(unix)]
    #[test]
    fn preferred_dirs_win_over_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("mxtp-preferred-tool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let found = resolve_executable(
            "tool",
            "mxtp-preferred-tool",
            "MXTP_UNSET_TEST_OVERRIDE",
            &[dir.path().to_path_buf()],
        )
        .unwrap();
        assert_eq!(found, tool);
    }
}
