use image::{ImageBuffer, Rgb};
use lopdf::{Document, Object};
use mxtp_mkr::geometry::PRINT_DPI;
use mxtp_mkr::pdf_compose::{
    compose_pdf, compose_pdf_for_id, ComposePdfRequest, ImagePlacement, PieceKind, PieceSpec,
    TextContent, TextPlacement,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const EPS_MM: f32 = 0.05;

#[test]
fn composed_pdf_embeds_image_xobject_and_boxes() {
    let dir = tempfile::tempdir().unwrap();
    let art = fixture_png(dir.path(), "art.png");

    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Front,
        output_dir: dir.path().to_path_buf(),
        images: vec![ImagePlacement {
            path: art.to_string_lossy().to_string(),
            x_mm: 10.0,
            y_mm: 12.0,
            w_mm: 80.0,
            h_mm: 70.0,
            scale: 1.0,
            rotation_deg: 0.0,
        }],
        texts: Vec::new(),
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let pages = doc.get_pages();
    let page = *pages.values().next().unwrap();
    assert_eq!(count_image_xobjects(&doc, page), 1);
    assert!(image_source_paths(&doc, page).contains(&art.to_string_lossy().to_string()));
    assert_box_mm(&doc, page, "MediaBox", [0.0, 0.0, 126.35, 126.35]);
    assert_box_mm(&doc, page, "TrimBox", [3.175, 3.175, 123.175, 123.175]);
}

#[test]
fn compose_pdf_for_id_resolves_project_relative_images() {
    let original_dir = std::env::current_dir().unwrap();
    std::env::set_current_dir(env!("CARGO_MANIFEST_DIR")).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let relative_art = "e2e/fixtures/art-front.png";
    let result = compose_pdf_for_id(ComposePdfRequest {
        piece_id: "front".to_string(),
        output_dir: dir.path().to_path_buf(),
        images: vec![ImagePlacement {
            path: relative_art.to_string(),
            x_mm: 0.0,
            y_mm: 0.0,
            w_mm: 120.0,
            h_mm: 120.0,
            scale: 1.0,
            rotation_deg: 0.0,
        }],
        texts: Vec::new(),
    });
    std::env::set_current_dir(original_dir).unwrap();

    let info = result.unwrap();
    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    assert_eq!(count_image_xobjects(&doc, page), 1);
    assert!(image_source_paths(&doc, page).contains(&relative_art.to_string()));
}

#[test]
fn compose_pdf_rejects_image_below_300_dpi_at_final_size() {
    let dir = tempfile::tempdir().unwrap();
    let art = tiny_png(dir.path(), "tiny.png");

    let error = compose_pdf(PieceSpec {
        kind: PieceKind::Front,
        output_dir: dir.path().to_path_buf(),
        images: vec![ImagePlacement {
            path: art.to_string_lossy().to_string(),
            x_mm: 0.0,
            y_mm: 0.0,
            w_mm: 120.0,
            h_mm: 120.0,
            scale: 1.0,
            rotation_deg: 0.0,
        }],
        texts: Vec::new(),
    })
    .unwrap_err();

    assert_eq!(
        error,
        "The Front insert image is too small to print sharply (96×96 px; it needs 1418×1418). Choose a larger image for Front insert in Artwork."
    );
    assert_eq!(PRINT_DPI, 300);
}

#[test]
fn tray_pdf_extracts_tracklist_text_inside_safe_box() {
    let dir = tempfile::tempdir().unwrap();
    let titles = [
        "Alpha Signal",
        "Beta Window",
        "Gamma Return",
        "Delta Bloom",
        "Epsilon Night",
    ];
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Tray,
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: vec![TextPlacement {
            content: TextContent {
                title: "Known Tracklist".to_string(),
                lines: titles
                    .iter()
                    .enumerate()
                    .map(|(index, title)| format!("{}. {title}", index + 1))
                    .collect(),
            },
            x_mm: 9.675,
            y_mm: 6.35,
            w_mm: 130.65,
            h_mm: 105.3,
            font_size_pt: 9.0,
        }],
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let hits = text_hits(&doc, page);
    let mut last_y = f32::MAX;
    for title in titles {
        let hit = hits
            .iter()
            .find(|hit| hit.text.contains(title))
            .unwrap_or_else(|| panic!("{title} missing from {hits:?}"));
        assert!((9.0..=12.0).contains(&hit.x_mm), "{hit:?}");
        assert!((6.0..=115.0).contains(&hit.y_mm), "{hit:?}");
        assert!(hit.y_mm < last_y, "{hits:?}");
        last_y = hit.y_mm;
    }
}

#[test]
fn saddle_booklet_flows_lyrics_across_imposed_pages_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let lines = (1..=72)
        .map(|index| format!("Lyric line {index:02} carries the melody"))
        .collect::<Vec<_>>();
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Booklet(12),
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: vec![TextPlacement {
            content: TextContent {
                title: "Song One lyrics".to_string(),
                lines: lines.clone(),
            },
            x_mm: 3.175,
            y_mm: 3.175,
            w_mm: 233.65,
            h_mm: 113.65,
            font_size_pt: 9.0,
        }],
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    assert_eq!(reader_order_text(&doc, "Lyric line"), lines);
}

#[test]
fn booklet_covers_carry_no_lyrics_and_each_page_keeps_to_its_side_of_the_fold() {
    let dir = tempfile::tempdir().unwrap();
    let lines = (1..=40)
        .map(|index| format!("Verse {index:02}"))
        .collect::<Vec<_>>();
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Booklet(8),
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: vec![booklet_text("Song", lines.clone())],
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    for page in doc.get_pages().values() {
        let (left, right) = imposed_pair(&doc, *page);
        for hit in text_hits(&doc, *page) {
            let reader_page = if hit.x_mm < 123.175 { left } else { right };
            assert!(
                reader_page != 1 && reader_page != 8,
                "cover page {reader_page} carries {hit:?}"
            );
            // Columns sit a full safety margin away from the fold.
            assert!(
                hit.x_mm < 123.175 - 3.0 || hit.x_mm > 123.175 + 3.1,
                "{hit:?}"
            );
        }
    }
    assert_eq!(reader_order_text(&doc, "Verse"), lines);
}

#[test]
fn booklet_lyrics_that_cannot_fit_return_a_named_error() {
    let dir = tempfile::tempdir().unwrap();
    let lines = (1..=600).map(|index| format!("Line {index}")).collect();
    let error = compose_pdf(PieceSpec {
        kind: PieceKind::Booklet(8),
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: vec![booklet_text("Long", lines)],
    })
    .unwrap_err();
    assert_eq!(
        error,
        "The lyrics do not fit in the 6 inside pages of the 8-page booklet, even at 6 pt. Choose more pages or shorten the lyrics."
    );
}

#[test]
fn tray_text_shrinks_to_fit_then_reports_the_piece_when_it_cannot() {
    let dir = tempfile::tempdir().unwrap();
    let tray = |count: usize| PieceSpec {
        kind: PieceKind::Tray,
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: vec![TextPlacement {
            content: TextContent {
                title: String::new(),
                lines: (1..=count).map(|index| format!("{index}. Track")).collect(),
            },
            x_mm: 9.675,
            y_mm: 6.35,
            w_mm: 130.65,
            h_mm: 105.3,
            font_size_pt: 9.0,
        }],
    };

    // 30 lines do not fit at 9 pt (26 rows) but do at a smaller size: all print.
    let info = compose_pdf(tray(30)).unwrap();
    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let hits = text_hits(&doc, page);
    assert_eq!(hits.len(), 30);
    assert!(hits.iter().all(|hit| hit.y_mm >= 6.35), "{hits:?}");

    let error = compose_pdf(tray(200)).unwrap_err();
    assert_eq!(
        error,
        "The text for Tray card does not fit, even at 6 pt. Shorten it or move some of it to the booklet."
    );
}

#[test]
fn accented_text_keeps_its_letters_in_win_ansi() {
    let dir = tempfile::tempdir().unwrap();
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Tray,
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: vec![TextPlacement {
            content: TextContent {
                title: "Café Señal".to_string(),
                lines: vec!["Ça va – “Ünïcode” €5 東".to_string()],
            },
            x_mm: 9.675,
            y_mm: 6.35,
            w_mm: 130.65,
            h_mm: 105.3,
            font_size_pt: 9.0,
        }],
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let content = decoded_content(&doc, page);
    assert!(content.contains("(Caf\\351 Se\\361al) Tj"), "{content}");
    let texts = text_hits(&doc, page)
        .into_iter()
        .map(|hit| hit.text)
        .collect::<Vec<_>>();
    assert_eq!(texts, ["Café Señal", "Ça va – “Ünïcode” €5 ?"]);
}

#[test]
fn a_word_longer_than_the_line_is_split_not_lost() {
    let dir = tempfile::tempdir().unwrap();
    let word = "W".repeat(120);
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Front,
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: vec![TextPlacement {
            content: TextContent {
                title: String::new(),
                lines: vec![word.clone()],
            },
            x_mm: 6.35,
            y_mm: 6.35,
            w_mm: 50.0,
            h_mm: 100.0,
            font_size_pt: 9.0,
        }],
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let hits = text_hits(&doc, page);
    assert!(hits.len() > 1, "{hits:?}");
    assert_eq!(
        hits.into_iter().map(|hit| hit.text).collect::<String>(),
        word
    );
}

#[test]
fn front_art_at_the_bleed_box_covers_the_page_with_no_trim_stroke() {
    let dir = tempfile::tempdir().unwrap();
    let art = fixture_png(dir.path(), "front.png");
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Front,
        output_dir: dir.path().to_path_buf(),
        images: vec![bleed_placement(&art, 126.35, 126.35)],
        texts: Vec::new(),
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let content = decoded_content(&doc, page);
    let (a, _, _, d, e, f) = image_matrix(&content);
    assert!(e.abs() < 0.01 && f.abs() < 0.01, "{content}");
    assert!(
        (a - 358.157).abs() < 0.05 && (d - 358.157).abs() < 0.05,
        "{content}"
    );
    assert!(
        content.contains("0 0 358.1575 358.1575 re W n"),
        "{content}"
    );
    assert!(!content.contains("re S"), "{content}");
}

#[test]
fn a_wide_image_is_cover_fitted_not_stretched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wide.png");
    ImageBuffer::<Rgb<u8>, Vec<u8>>::from_pixel(3000, 1600, Rgb([20, 90, 160]))
        .save(&path)
        .unwrap();
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Front,
        output_dir: dir.path().to_path_buf(),
        images: vec![bleed_placement(&path, 126.35, 126.35)],
        texts: Vec::new(),
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let (a, _, _, d, e, f) = image_matrix(&decoded_content(&doc, page));
    assert!((a / d - 1.875).abs() < 0.001, "{a} / {d}");
    assert!((d - 358.157).abs() < 0.05, "height fills the box: {d}");
    // Centred: the overflow is split evenly left and right, none vertically.
    assert!((e + (a - 358.157) / 2.0).abs() < 0.05, "{e}");
    assert!(f.abs() < 0.01, "{f}");
}

#[test]
fn tray_fold_marks_are_trim_relative_in_content_stream() {
    let dir = tempfile::tempdir().unwrap();
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Tray,
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: Vec::new(),
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let content = decoded_content(&doc, page);
    assert!(content_has_number(&content, pt(6.5)), "{content}");
    assert!(content_has_number(&content, pt(143.5)), "{content}");
    assert!(
        !content_has_number(&content, pt(9.675)) && !content_has_number(&content, pt(146.675)),
        "{content}"
    );
}

#[test]
fn disc_face_has_white_center_hole_mask() {
    let dir = tempfile::tempdir().unwrap();
    let info = compose_pdf(PieceSpec {
        kind: PieceKind::Disc,
        output_dir: dir.path().to_path_buf(),
        images: Vec::new(),
        texts: Vec::new(),
    })
    .unwrap();

    let doc = Document::load(&info.path).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let content = decoded_content(&doc, page);
    assert!(content.contains("1 1 1 rg"), "{content}");
    assert!(content.contains(" c f\n"), "{content}");
}

#[test]
fn folder_and_booklet_variants_emit_expected_boxes_and_pairs() {
    for pages in [2, 4, 6, 8] {
        let dir = tempfile::tempdir().unwrap();
        let info = compose_pdf(PieceSpec {
            kind: PieceKind::Folder(pages),
            output_dir: dir.path().to_path_buf(),
            images: Vec::new(),
            texts: Vec::new(),
        })
        .unwrap();
        let doc = Document::load(&info.path).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        assert_box_mm(
            &doc,
            page,
            "MediaBox",
            [0.0, 0.0, 120.0 * (pages as f32 / 2.0) + 6.35, 126.35],
        );
    }

    for pages in [4, 8, 12, 16, 20, 24, 28] {
        let dir = tempfile::tempdir().unwrap();
        let info = compose_pdf(PieceSpec {
            kind: PieceKind::Booklet(pages),
            output_dir: dir.path().to_path_buf(),
            images: Vec::new(),
            texts: Vec::new(),
        })
        .unwrap();
        let doc = Document::load(&info.path).unwrap();
        let expected = imposed_pairs(pages);
        assert_eq!(doc.get_pages().len(), expected.len());
        let actual = doc
            .get_pages()
            .values()
            .map(|page| imposed_pair(&doc, *page))
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
}

#[test]
fn writes_b5_pdf_dimension_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let cases = vec![
        (
            "front",
            PieceKind::Front,
            (126.35, 126.35),
            (120.0, 120.0),
            1,
        ),
        ("tray", PieceKind::Tray, (156.35, 124.35), (150.0, 118.0), 1),
        ("disc", PieceKind::Disc, (126.35, 126.35), (120.0, 120.0), 1),
        (
            "folder-8",
            PieceKind::Folder(8),
            (486.35, 126.35),
            (480.0, 120.0),
            1,
        ),
        (
            "saddle-12",
            PieceKind::Booklet(12),
            (246.35, 126.35),
            (240.0, 120.0),
            6,
        ),
    ];

    let mut lines = vec![
        "# B5 PDF geometry evidence".to_string(),
        "".to_string(),
        "Before grep (git HEAD pdf_compose.rs duplicated geometry consts):".to_string(),
        grep_pdf_geometry_from_head(),
        "".to_string(),
        "After grep (working tree pdf_compose.rs duplicated geometry consts):".to_string(),
        grep_pdf_geometry_from_worktree(),
        "".to_string(),
        format!("DPI enforcement: PRINT_DPI={PRINT_DPI}"),
        "".to_string(),
        "Measured generated PDF boxes against specs/cd-packaging-spec-reference.md:".to_string(),
    ];

    for (label, kind, expected_media, expected_trim, expected_pages) in cases {
        let info = compose_pdf(PieceSpec {
            kind,
            output_dir: dir.path().to_path_buf(),
            images: Vec::new(),
            texts: Vec::new(),
        })
        .unwrap();
        let doc = Document::load(&info.path).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let media = box_size_mm(&doc, page, "MediaBox");
        let trim = box_size_mm(&doc, page, "TrimBox");
        assert_close(media.0, expected_media.0);
        assert_close(media.1, expected_media.1);
        assert_close(trim.0, expected_trim.0);
        assert_close(trim.1, expected_trim.1);
        assert_eq!(doc.get_pages().len(), expected_pages);
        lines.push(format!(
            "- {label}: PASS media={:.2}x{:.2}mm trim={:.2}x{:.2}mm pages={}",
            media.0,
            media.1,
            trim.0,
            trim.1,
            doc.get_pages().len()
        ));
    }

    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let evidence = project_root
        .join("pipeline")
        .join("goal-runs")
        .join("20260627T214816Z-mxtp-mkr-polish")
        .join("evidence")
        .join("B5-pdf-dims.txt");
    fs::create_dir_all(evidence.parent().unwrap()).unwrap();
    fs::write(evidence, lines.join("\n")).unwrap();
}

fn booklet_text(title: &str, lines: Vec<String>) -> TextPlacement {
    TextPlacement {
        content: TextContent {
            title: title.to_string(),
            lines,
        },
        x_mm: 3.175,
        y_mm: 3.175,
        w_mm: 233.65,
        h_mm: 113.65,
        font_size_pt: 9.0,
    }
}

fn bleed_placement(path: &Path, w_mm: f32, h_mm: f32) -> ImagePlacement {
    ImagePlacement {
        path: path.to_string_lossy().to_string(),
        x_mm: 0.0,
        y_mm: 0.0,
        w_mm,
        h_mm,
        scale: 1.0,
        rotation_deg: 0.0,
    }
}

/// The `a b c d e f cm` matrix that places the image XObject.
fn image_matrix(content: &str) -> (f32, f32, f32, f32, f32, f32) {
    let line = content
        .lines()
        .find(|line| line.ends_with(" cm"))
        .unwrap_or_else(|| panic!("no cm in {content}"));
    let values = line
        .split_whitespace()
        .filter_map(|token| token.parse::<f32>().ok())
        .collect::<Vec<_>>();
    (
        values[0], values[1], values[2], values[3], values[4], values[5],
    )
}

/// All text lines starting with `prefix`, in reader-page order: each spread's
/// hits go to its left or right page by which side of the fold they sit on.
fn reader_order_text(doc: &Document, prefix: &str) -> Vec<String> {
    let mut by_page: Vec<(u16, usize, String)> = Vec::new();
    for page in doc.get_pages().values() {
        let (left, right) = imposed_pair(doc, *page);
        for (index, hit) in text_hits(doc, *page).into_iter().enumerate() {
            if hit.text.starts_with(prefix) {
                let reader_page = if hit.x_mm < 123.175 { left } else { right };
                by_page.push((reader_page, index, hit.text));
            }
        }
    }
    by_page.sort_by_key(|(page, index, _)| (*page, *index));
    by_page.into_iter().map(|(_, _, text)| text).collect()
}

fn fixture_png(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let mut image = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(1536, 1536);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = Rgb([(x / 6) as u8, (y / 6) as u8, 180]);
    }
    image.save(&path).unwrap();
    path
}

fn tiny_png(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let mut image = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(96, 96);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = Rgb([x as u8, y as u8, 180]);
    }
    image.save(&path).unwrap();
    path
}

fn count_image_xobjects(doc: &Document, page: lopdf::ObjectId) -> usize {
    let page_dict = doc.get_dictionary(page).unwrap();
    let resources = resolve_dict(doc, page_dict.get(b"Resources").unwrap());
    let xobjects = resolve_dict(doc, resources.get(b"XObject").unwrap());
    xobjects
        .iter()
        .filter(|(_, object)| {
            let Ok(dict) = resolve_stream_dict(doc, object) else {
                return false;
            };
            matches!(dict.get(b"Subtype"), Ok(Object::Name(name)) if name == b"Image")
        })
        .count()
}

fn image_source_paths(doc: &Document, page: lopdf::ObjectId) -> Vec<String> {
    let page_dict = doc.get_dictionary(page).unwrap();
    let resources = resolve_dict(doc, page_dict.get(b"Resources").unwrap());
    let xobjects = resolve_dict(doc, resources.get(b"XObject").unwrap());
    xobjects
        .iter()
        .filter_map(|(_, object)| {
            let dict = resolve_stream_dict(doc, object).ok()?;
            let bytes = dict.get(b"SourcePath").ok()?.as_str().ok()?;
            Some(String::from_utf8_lossy(bytes).to_string())
        })
        .collect()
}

fn imposed_pair(doc: &Document, page: lopdf::ObjectId) -> (u16, u16) {
    let page_dict = doc.get_dictionary(page).unwrap();
    let pair = page_dict.get(b"ImposedPair").unwrap().as_array().unwrap();
    (as_i64(&pair[0]) as u16, as_i64(&pair[1]) as u16)
}

fn imposed_pairs(pages: u16) -> Vec<(u16, u16)> {
    let mut pairs = Vec::new();
    for sheet in 0..pages / 4 {
        pairs.push((pages - 2 * sheet, 1 + 2 * sheet));
        pairs.push((2 + 2 * sheet, pages - 1 - 2 * sheet));
    }
    pairs
}

fn assert_box_mm(doc: &Document, page: lopdf::ObjectId, key: &str, expected: [f32; 4]) {
    let page_dict = doc.get_dictionary(page).unwrap();
    let rect = page_dict.get(key.as_bytes()).unwrap().as_array().unwrap();
    let actual = [
        pt_to_mm(as_f32(&rect[0])),
        pt_to_mm(as_f32(&rect[1])),
        pt_to_mm(as_f32(&rect[2])),
        pt_to_mm(as_f32(&rect[3])),
    ];
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert!(
            (actual - expected).abs() <= EPS_MM,
            "{actual} != {expected}"
        );
    }
}

fn decoded_content(doc: &Document, page: lopdf::ObjectId) -> String {
    String::from_utf8(doc.get_page_content(page).unwrap()).unwrap()
}

fn box_size_mm(doc: &Document, page: lopdf::ObjectId, key: &str) -> (f32, f32) {
    let page_dict = doc.get_dictionary(page).unwrap();
    let rect = page_dict.get(key.as_bytes()).unwrap().as_array().unwrap();
    (
        pt_to_mm(as_f32(&rect[2]) - as_f32(&rect[0])),
        pt_to_mm(as_f32(&rect[3]) - as_f32(&rect[1])),
    )
}

fn grep_pdf_geometry_from_head() -> String {
    let output = Command::new("git")
        .args(["show", "HEAD:src-tauri/src/pdf_compose.rs"])
        .output()
        .unwrap();
    if !output.status.success() {
        return "git show failed".to_string();
    }
    grep_pdf_geometry(&String::from_utf8_lossy(&output.stdout))
}

fn grep_pdf_geometry_from_worktree() -> String {
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let source = fs::read_to_string(project_root.join("src-tauri/src/pdf_compose.rs")).unwrap();
    grep_pdf_geometry(&source)
}

fn grep_pdf_geometry(source: &str) -> String {
    let matches = source
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed.starts_with("const ") && (trimmed.contains("_MM") || trimmed.contains("DPI"))
                || trimmed.contains("3.175")
                || trimmed.contains("120.0")
                || trimmed.contains("150.0")
                || trimmed.contains("118.0")
                || trimmed.contains("6.5")
        })
        .collect::<Vec<_>>();
    if matches.is_empty() {
        "(no matches)".to_string()
    } else {
        matches.join("\n")
    }
}

#[derive(Debug)]
struct TextHit {
    text: String,
    x_mm: f32,
    y_mm: f32,
}

fn text_hits(doc: &Document, page: lopdf::ObjectId) -> Vec<TextHit> {
    decoded_content(doc, page)
        .lines()
        .filter_map(|line| {
            let (position, literal) = line.split_once(" Td ")?;
            let mut coords = position.split_whitespace().rev();
            let y_pt = coords.next()?.parse::<f32>().ok()?;
            let x_pt = coords.next()?.parse::<f32>().ok()?;
            let start = literal.find('(')? + 1;
            let end = literal.rfind(") Tj")?;
            Some(TextHit {
                text: unescape_win_ansi(&literal[start..end]),
                x_mm: pt_to_mm(x_pt),
                y_mm: pt_to_mm(y_pt),
            })
        })
        .collect()
}

/// Undo PDF literal escapes, reading octal escapes as WinAnsi (cp1252) bytes.
fn unescape_win_ansi(literal: &str) -> String {
    let mut text = String::new();
    let mut chars = literal.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            text.push(ch);
            continue;
        }
        let digits = std::iter::from_fn(|| chars.next_if(|next| next.is_digit(8)))
            .take(3)
            .collect::<String>();
        if digits.is_empty() {
            text.extend(chars.next());
            continue;
        }
        let byte = u8::from_str_radix(&digits, 8).unwrap();
        text.push(match byte {
            0x80 => '€',
            0x93 => '“',
            0x94 => '”',
            0x96 => '–',
            0x97 => '—',
            _ => char::from(byte),
        });
    }
    text
}

fn resolve_dict<'a>(doc: &'a Document, object: &'a Object) -> &'a lopdf::Dictionary {
    match object {
        Object::Dictionary(dict) => dict,
        Object::Reference(id) => doc.get_dictionary(*id).unwrap(),
        _ => panic!("expected dictionary, got {object:?}"),
    }
}

fn resolve_stream_dict<'a>(
    doc: &'a Document,
    object: &'a Object,
) -> Result<&'a lopdf::Dictionary, String> {
    match object {
        Object::Stream(stream) => Ok(&stream.dict),
        Object::Reference(id) => Ok(&doc
            .get_object(*id)
            .map_err(|err| err.to_string())?
            .as_stream()
            .map_err(|err| err.to_string())?
            .dict),
        _ => Err(format!("expected stream, got {object:?}")),
    }
}

fn as_f32(object: &Object) -> f32 {
    match object {
        Object::Real(value) => *value,
        Object::Integer(value) => *value as f32,
        other => panic!("expected number, got {other:?}"),
    }
}

fn as_i64(object: &Object) -> i64 {
    match object {
        Object::Integer(value) => *value,
        other => panic!("expected integer, got {other:?}"),
    }
}

fn pt(mm: f32) -> f32 {
    mm / 25.4 * 72.0
}

fn pt_to_mm(pt: f32) -> f32 {
    pt / 72.0 * 25.4
}

fn content_has_number(content: &str, expected: f32) -> bool {
    content
        .split_whitespace()
        .filter_map(|token| token.parse::<f32>().ok())
        .any(|value| (value - expected).abs() <= 0.01)
}

fn assert_close(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() < 0.1,
        "expected {expected}, got {actual}"
    );
}
