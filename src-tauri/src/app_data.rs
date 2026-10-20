use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

pub fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|err| format!("failed to resolve app local data directory: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_configured_app_local_data_directory() {
        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .unwrap();
        let path = app_data_dir(app.handle()).unwrap();
        println!("app_data_dir={}", path.display());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("com.phoenix.mxtpmkr")
        );
    }
}
