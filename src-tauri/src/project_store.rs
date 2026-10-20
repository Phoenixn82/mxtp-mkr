use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

static PROJECT_STORE_MUTEX: Mutex<()> = Mutex::new(());

pub fn load_cd_projects(base: &Path) -> Result<Vec<Value>, String> {
    let _guard = project_store_guard()?;
    load_cd_projects_from(&projects_dir(base))
}

pub fn save_cd_project(base: &Path, project: Value) -> Result<(), String> {
    let _guard = project_store_guard()?;
    save_cd_project_to(&projects_dir(base), &project)
}

pub fn delete_cd_project(base: &Path, project_id: &str) -> Result<(), String> {
    let _guard = project_store_guard()?;
    delete_cd_project_from(&projects_dir(base), project_id)
}

fn project_store_guard() -> Result<MutexGuard<'static, ()>, String> {
    PROJECT_STORE_MUTEX
        .lock()
        .map_err(|_| "CD project store lock was poisoned".to_string())
}

pub fn load_imported_music_sources(base: &Path) -> Result<Value, String> {
    load_imported_music_sources_from(&libraries_path(base))
}

pub fn save_imported_music_sources(base: &Path, sources: Value) -> Result<(), String> {
    save_imported_music_sources_to(&libraries_path(base), sources)
}

fn load_imported_music_sources_from(path: &Path) -> Result<Value, String> {
    if !path.is_file() {
        return Ok(Value::Array(Vec::new()));
    }
    let bytes =
        fs::read(path).map_err(|err| format!("failed to read imported libraries: {err}"))?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) if value.is_array() => Ok(value),
        parsed => {
            // Move the bad file aside before anything can save over it, so the
            // next import starts fresh without destroying what was there.
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default();
            let mut corrupt = path.as_os_str().to_owned();
            corrupt.push(format!(".corrupt-{stamp}"));
            let corrupt = PathBuf::from(corrupt);
            fs::rename(path, &corrupt).map_err(|err| {
                format!("imported music sources are unreadable and could not be set aside: {err}")
            })?;
            let reason = parsed
                .err()
                .map(|err| err.to_string())
                .unwrap_or_else(|| "not a list".to_string());
            Err(format!(
                "Imported music sources could not be read ({reason}) and were set aside as {}.",
                corrupt
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default()
            ))
        }
    }
}

fn save_imported_music_sources_to(target: &Path, sources: Value) -> Result<(), String> {
    if !sources.is_array() {
        return Err("imported library data must be an array".to_string());
    }
    let dir = target
        .parent()
        .ok_or_else(|| "library path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|err| format!("failed to create library folder: {err}"))?;
    let json = serde_json::to_vec(&sources).map_err(|err| err.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir)
        .map_err(|err| format!("failed to stage imported libraries: {err}"))?;
    temporary
        .write_all(&json)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|err| format!("failed to write imported libraries: {err}"))?;
    temporary.persist(target).map(|_| ()).map_err(|err| {
        format!(
            "failed to replace imported libraries atomically: {}",
            err.error
        )
    })
}

fn projects_dir(base: &Path) -> PathBuf {
    base.join("MXTP MKR").join("projects")
}

fn libraries_path(base: &Path) -> PathBuf {
    base.join("MXTP MKR").join("libraries.json")
}

fn load_cd_projects_from(dir: &Path) -> Result<Vec<Value>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut projects = Vec::new();
    for entry in fs::read_dir(dir).map_err(|err| format!("failed to read CD projects: {err}"))? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        // One unreadable or malformed file must never hide every other project:
        // set it aside as <name>.corrupt and keep loading.
        match fs::read_to_string(&path)
            .map_err(|err| err.to_string())
            .and_then(|json| serde_json::from_str::<Value>(&json).map_err(|err| err.to_string()))
            .and_then(|project| {
                if is_loadable_project(&project) {
                    Ok(project)
                } else {
                    Err("missing id or entry".to_string())
                }
            }) {
            Ok(project) => projects.push(project),
            Err(reason) => {
                let corrupt = path.with_extension("json.corrupt");
                eprintln!("setting aside CD project `{}` ({reason})", path.display());
                if let Err(error) = fs::rename(&path, &corrupt) {
                    eprintln!("could not set aside `{}`: {error}", path.display());
                }
            }
        }
    }
    projects.sort_by(|left, right| {
        string_field(right, "updatedAt").cmp(string_field(left, "updatedAt"))
    });
    Ok(projects)
}

fn is_loadable_project(project: &Value) -> bool {
    project.is_object()
        && project
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.trim().is_empty())
        && project.get("entry").is_some_and(Value::is_object)
}

fn save_cd_project_to(dir: &Path, project: &Value) -> Result<(), String> {
    let id = string_field(project, "id");
    validate_project_id(id)?;
    fs::create_dir_all(dir).map_err(|err| format!("failed to create CD project folder: {err}"))?;
    let json = serde_json::to_vec_pretty(project).map_err(|err| err.to_string())?;
    let target = dir.join(format!("{id}.json"));
    let mut temporary = tempfile::NamedTempFile::new_in(dir)
        .map_err(|err| format!("failed to stage CD project: {err}"))?;
    temporary
        .write_all(&json)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|err| format!("failed to write CD project: {err}"))?;
    temporary
        .persist(target)
        .map(|_| ())
        .map_err(|err| format!("failed to replace CD project atomically: {}", err.error))
}

fn delete_cd_project_from(dir: &Path, project_id: &str) -> Result<(), String> {
    validate_project_id(project_id)?;
    let target = dir.join(format!("{project_id}.json"));
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to delete CD project: {error}")),
    }
}

fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.is_empty()
        || !project_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("CD project id contains unsupported characters".to_string());
    }
    Ok(())
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_store_round_trips_and_sorts_recent_first() {
        let dir = tempfile::tempdir().unwrap();
        let older = json!({ "id": "older", "updatedAt": "2026-01-01T00:00:00Z", "entry": { "album": "Old" } });
        let newer = json!({ "id": "newer", "updatedAt": "2026-08-25T00:00:00Z", "entry": { "album": "New" } });
        save_cd_project_to(dir.path(), &older).unwrap();
        save_cd_project_to(dir.path(), &newer).unwrap();

        let loaded = load_cd_projects_from(dir.path()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0]["id"], "newer");
        assert_eq!(loaded[1]["id"], "older");
    }

    #[test]
    fn project_store_rejects_paths_as_ids() {
        let dir = tempfile::tempdir().unwrap();
        let error = save_cd_project_to(dir.path(), &json!({ "id": "../outside" })).unwrap_err();
        assert!(error.contains("unsupported characters"));
    }

    #[test]
    fn project_store_deletes_only_the_requested_project() {
        let dir = tempfile::tempdir().unwrap();
        let keep = json!({ "id": "keep", "updatedAt": "2026-01-01T00:00:00Z", "entry": {} });
        let remove = json!({ "id": "remove", "updatedAt": "2026-01-02T00:00:00Z", "entry": {} });
        save_cd_project_to(dir.path(), &keep).unwrap();
        save_cd_project_to(dir.path(), &remove).unwrap();

        delete_cd_project_from(dir.path(), "remove").unwrap();
        let loaded = load_cd_projects_from(dir.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["id"], "keep");
        assert!(delete_cd_project_from(dir.path(), "../outside").is_err());
    }

    #[test]
    fn project_store_quarantines_corrupt_json_and_keeps_valid_projects() {
        let dir = tempfile::tempdir().unwrap();
        let good = json!({ "id": "good", "updatedAt": "2026-01-01T00:00:00Z", "entry": {} });
        save_cd_project_to(dir.path(), &good).unwrap();
        let corrupt = dir.path().join("broken.json");
        fs::write(&corrupt, "{not json").unwrap();

        let loaded = load_cd_projects_from(dir.path()).unwrap();

        assert_eq!(loaded, vec![good]);
        assert!(!corrupt.exists());
        assert!(dir.path().join("broken.json.corrupt").is_file());
    }

    #[test]
    fn malformed_projects_are_set_aside_and_the_rest_still_load() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["one", "two"] {
            save_cd_project_to(
                dir.path(),
                &json!({ "id": id, "updatedAt": "2026-01-01T00:00:00Z", "entry": { "album": id } }),
            )
            .unwrap();
        }
        fs::write(
            dir.path().join("null-entry.json"),
            r#"{"id":"null-entry","entry":null}"#,
        )
        .unwrap();
        fs::write(dir.path().join("no-id.json"), r#"{"entry":{}}"#).unwrap();
        fs::write(dir.path().join("array.json"), "[1,2]").unwrap();
        fs::write(dir.path().join("binary.json"), [0xff_u8, 0xfe, 0x00]).unwrap();

        let loaded = load_cd_projects_from(dir.path()).unwrap();

        assert_eq!(loaded.len(), 2);
        for name in ["null-entry", "no-id", "array", "binary"] {
            assert!(
                dir.path().join(format!("{name}.json.corrupt")).is_file(),
                "{name}"
            );
            assert!(!dir.path().join(format!("{name}.json")).exists(), "{name}");
        }
    }

    #[test]
    fn unparsable_imported_sources_are_set_aside_before_any_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("libraries.json");
        fs::write(&path, "{broken").unwrap();

        let error = load_imported_music_sources_from(&path).unwrap_err();

        assert!(error.contains("set aside"), "{error}");
        assert!(!path.exists());
        let aside = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .find(|name| name.starts_with("libraries.json.corrupt-"))
            .expect("corrupt copy kept");
        assert_eq!(
            fs::read_to_string(dir.path().join(aside)).unwrap(),
            "{broken"
        );
        assert_eq!(load_imported_music_sources_from(&path).unwrap(), json!([]));
    }

    #[test]
    fn imported_sources_require_an_array() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("libraries.json");
        assert!(save_imported_music_sources_to(&path, json!({ "source": "spotify" })).is_err());
        let sources = json!([{ "source": "spotify", "tracks": [] }]);
        save_imported_music_sources_to(&path, sources.clone()).unwrap();
        assert_eq!(load_imported_music_sources_from(&path).unwrap(), sources);
    }
}
