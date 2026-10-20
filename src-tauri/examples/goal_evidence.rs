use mxtp_mkr::research::{
    codex_child_env, fetch_lyrics_with_source, generate_cover, lookup_album, AlbumInfo,
};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const ALBUMS: [(&str, &str, &str); 2] = [
    ("Daft Punk", "Discovery", "daftpunk"),
    ("Radiohead", "OK Computer", "radiohead"),
];

fn main() -> Result<(), String> {
    let args = env::args().collect::<Vec<_>>();
    if args.len() < 3 {
        return Err("usage: cargo run --example goal_evidence -- <research|cover> <evidence-dir> [prompt-or-raw-lyrics-path]".to_string());
    }
    let evidence_dir = PathBuf::from(&args[2]);
    fs::create_dir_all(&evidence_dir).map_err(|err| err.to_string())?;
    match args[1].as_str() {
        "research" => {
            let raw_lyrics_path = args
                .get(3)
                .map(PathBuf::from)
                .unwrap_or_else(default_raw_lyrics_path);
            write_research_evidence(&evidence_dir, &raw_lyrics_path)
        }
        "cover" => {
            let prompt_path = args
                .get(3)
                .ok_or_else(|| "cover mode requires a prompt file path".to_string())?;
            write_cover_evidence(&evidence_dir, Path::new(prompt_path))
        }
        other => Err(format!("unknown evidence mode '{other}'")),
    }
}

fn write_research_evidence(evidence_dir: &Path, raw_lyrics_path: &Path) -> Result<(), String> {
    let mut lyrics_meta = Vec::new();
    let mut raw_lyrics: HashMap<String, String> = HashMap::new();

    for (artist, title, slug) in ALBUMS {
        let album = lookup_album(artist, title)?;
        write_album_evidence(evidence_dir, slug, &album)?;
        let lyric_title = album
            .tracks
            .first()
            .ok_or_else(|| format!("{artist} - {title} had no tracks"))?;
        let lyric = fetch_lyrics_with_source(&album.artist, lyric_title)?;
        if lyric.source_url.starts_with("cache:") {
            return Err(format!(
                "refusing cached lyrics for evidence: {} - {}",
                album.artist, lyric_title
            ));
        }
        let key = format!("{} - {}", album.artist, lyric_title);
        lyrics_meta.push(format!(
            "{} | chars={} | lines={} | source={}",
            key,
            lyric.text.chars().count(),
            lyric
                .text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count(),
            lyric.source_url
        ));
        raw_lyrics.insert(key, lyric.text);
    }

    fs::write(
        evidence_dir.join("G1-lyrics-meta.txt"),
        lyrics_meta.join("\n") + "\n",
    )
    .map_err(|err| err.to_string())?;
    if let Some(parent) = raw_lyrics_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        raw_lyrics_path,
        serde_json::to_vec_pretty(&raw_lyrics).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    println!("rawLyricsPath={}", raw_lyrics_path.display());
    Ok(())
}

fn write_album_evidence(evidence_dir: &Path, slug: &str, album: &AlbumInfo) -> Result<(), String> {
    let path = evidence_dir.join(format!("G1-musicbrainz-{slug}.json"));
    fs::write(
        path,
        serde_json::to_vec_pretty(album).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

fn write_cover_evidence(evidence_dir: &Path, prompt_path: &Path) -> Result<(), String> {
    let prompt = fs::read_to_string(prompt_path).map_err(|err| err.to_string())?;
    env::set_var("MXTP_MKR_IMAGEGEN", "codex");
    let child_env = codex_child_env(&env::vars().collect());
    let cover = generate_cover(&prompt, &[])?;
    let source = PathBuf::from(&cover.image_path);
    let target = evidence_dir.join("G2-cover.png");
    fs::copy(&source, &target).map_err(|err| err.to_string())?;
    let (width, height) = image::image_dimensions(&target).map_err(|err| err.to_string())?;
    let bytes = fs::metadata(&target).map_err(|err| err.to_string())?.len();
    let meta = CoverMeta {
        adapter: "codex",
        width,
        height,
        bytes,
        source_path: source.to_string_lossy().to_string(),
        evidence_path: target.to_string_lossy().to_string(),
        openai_api_key_in_child_env: child_env.contains_key("OPENAI_API_KEY"),
        prompt_file: prompt_path.to_string_lossy().to_string(),
    };
    fs::write(
        evidence_dir.join("G2-cover-meta.txt"),
        [
            format!("adapter={}", meta.adapter),
            format!("dimensions={}x{}", meta.width, meta.height),
            format!("bytes={}", meta.bytes),
            format!("sourcePath={}", meta.source_path),
            format!("evidencePath={}", meta.evidence_path),
            format!(
                "OPENAI_API_KEY in child env={}",
                if meta.openai_api_key_in_child_env {
                    "present"
                } else {
                    "absent"
                }
            ),
            format!("promptFile={}", meta.prompt_file),
        ]
        .join("\n")
            + "\n",
    )
    .map_err(|err| err.to_string())?;
    println!(
        "coverEvidence={} {}x{} {} bytes",
        target.display(),
        width,
        height,
        bytes
    );
    Ok(())
}

fn default_raw_lyrics_path() -> PathBuf {
    env::temp_dir().join("mxtp_mkr_goal_lyrics_raw.json")
}

#[derive(Serialize)]
struct CoverMeta<'a> {
    adapter: &'a str,
    width: u32,
    height: u32,
    bytes: u64,
    source_path: String,
    evidence_path: String,
    openai_api_key_in_child_env: bool,
    prompt_file: String,
}
