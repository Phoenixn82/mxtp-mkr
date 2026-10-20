use crate::geometry::{
    mm_to_px, BLEED_SAFE_MM, DISC_HOLE_MM, DISC_INNER_MM, DISC_OUTER_MM, PAGE_MM, PRINT_DPI,
    TRAY_H_MM, TRAY_SPINE_MM, TRAY_W_MM,
};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_TEXT_FONT_SIZE_PT: f32 = 9.0;
const TITLE_FONT_SIZE_PT_DELTA: f32 = 2.0;
const LINE_HEIGHT: f32 = 1.25;
/// Text shrinks toward this size before a piece reports that it does not fit.
const MIN_TEXT_FONT_SIZE_PT: f32 = 6.0;
/// Crop marks stop this far short of the trim so a slightly off cut never shows them.
const CROP_MARK_GAP_MM: f32 = 0.8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "pages")]
pub enum PieceKind {
    Front,
    Tray,
    Disc,
    Folder(u16),
    Booklet(u16),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePlacement {
    pub path: String,
    pub x_mm: f32,
    pub y_mm: f32,
    pub w_mm: f32,
    pub h_mm: f32,
    #[serde(default = "default_image_scale")]
    pub scale: f32,
    #[serde(default)]
    pub rotation_deg: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextContent {
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPlacement {
    pub content: TextContent,
    pub x_mm: f32,
    pub y_mm: f32,
    pub w_mm: f32,
    pub h_mm: f32,
    #[serde(default = "default_text_font_size")]
    pub font_size_pt: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceSpec {
    pub kind: PieceKind,
    pub output_dir: PathBuf,
    #[serde(default)]
    pub images: Vec<ImagePlacement>,
    #[serde(default)]
    pub texts: Vec<TextPlacement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposePdfRequest {
    pub piece_id: String,
    pub output_dir: PathBuf,
    #[serde(default)]
    pub images: Vec<ImagePlacement>,
    #[serde(default)]
    pub texts: Vec<TextPlacement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInfo {
    pub path: PathBuf,
    pub media_box_mm: (f32, f32),
    pub trim_box_mm: (f32, f32),
    pub pages: u16,
}

#[derive(Debug, Clone, PartialEq)]
struct PagePlan {
    label: String,
    media_mm: (f32, f32),
    trim_mm: (f32, f32),
    trim_origin_mm: (f32, f32),
    fold_marks_mm: Vec<f32>,
    annulus_mm: Option<(f32, f32, f32)>,
    imposed_pair: Option<(u16, u16)>,
}

struct PdfImage {
    name: String,
    object_id: ObjectId,
    placement: ImagePlacement,
    width_px: u32,
    height_px: u32,
}

/// One text placement, wrapped at the size that fits.
struct TextLayout {
    font_size: f32,
    line_height_mm: f32,
    /// Lines per page (per reader page for booklets).
    capacity: usize,
    lines: Vec<(String, bool)>,
    /// Booklets: x of the left and right page columns, and their width.
    columns: Option<(f32, f32, f32)>,
}

pub fn compose_pdf(piece: PieceSpec) -> Result<PdfInfo, String> {
    fs::create_dir_all(&piece.output_dir).map_err(|err| err.to_string())?;

    let name = piece_name(&piece.kind);
    let pages = page_plans(&piece.kind)?;
    let path = piece.output_dir.join(format!("{name}.pdf"));
    write_pdf(&path, &piece.kind, &pages, &piece.images, &piece.texts)?;

    Ok(PdfInfo {
        path,
        media_box_mm: pages[0].media_mm,
        trim_box_mm: pages[0].trim_mm,
        pages: pages.len() as u16,
    })
}

pub fn compose_pdf_for_id(request: ComposePdfRequest) -> Result<PdfInfo, String> {
    let output_dir = if request.output_dir.is_relative() {
        project_root()?.join(request.output_dir)
    } else {
        request.output_dir
    };
    compose_pdf(PieceSpec {
        kind: PieceKind::from_piece_id(&request.piece_id)?,
        output_dir,
        images: request.images,
        texts: request.texts,
    })
}

impl PieceKind {
    pub fn from_piece_id(id: &str) -> Result<Self, String> {
        match id {
            "front" => Ok(Self::Front),
            "tray" => Ok(Self::Tray),
            "disc" => Ok(Self::Disc),
            "bifold" => Ok(Self::Folder(4)),
            "trifold" => Ok(Self::Folder(6)),
            "folder-8" => Ok(Self::Folder(8)),
            _ if id.starts_with("saddle-") => {
                let pages = id
                    .trim_start_matches("saddle-")
                    .parse::<u16>()
                    .map_err(|err| err.to_string())?;
                Ok(Self::Booklet(pages))
            }
            _ => Err(format!("unknown PDF piece id `{id}`")),
        }
    }
}

fn page_plans(kind: &PieceKind) -> Result<Vec<PagePlan>, String> {
    let trim_origin = (BLEED_SAFE_MM, BLEED_SAFE_MM);
    match *kind {
        PieceKind::Front => Ok(vec![rect_plan("front", PAGE_MM, PAGE_MM, trim_origin)]),
        PieceKind::Tray => {
            let mut plan = rect_plan("tray", TRAY_W_MM, TRAY_H_MM, trim_origin);
            plan.fold_marks_mm = vec![TRAY_SPINE_MM, TRAY_W_MM - TRAY_SPINE_MM];
            Ok(vec![plan])
        }
        PieceKind::Disc => {
            let mut plan = rect_plan("disc", PAGE_MM, PAGE_MM, trim_origin);
            plan.annulus_mm = Some((DISC_OUTER_MM, DISC_INNER_MM, DISC_HOLE_MM));
            Ok(vec![plan])
        }
        PieceKind::Folder(pages) => {
            if ![2, 4, 6, 8].contains(&pages) {
                return Err("fold inserts must use 2, 4, 6, or 8 pages".to_string());
            }
            let panels = (pages / 2).max(1) as f32;
            Ok(vec![rect_plan(
                &format!("folder-{pages}"),
                PAGE_MM * panels,
                PAGE_MM,
                trim_origin,
            )])
        }
        PieceKind::Booklet(pages) => {
            if pages < 4 || pages % 4 != 0 {
                return Err("booklet pages must be a multiple of 4".to_string());
            }
            Ok(impose(pages)
                .into_iter()
                .map(|spread| {
                    let mut plan = rect_plan(
                        &format!("booklet-s{}-{}", spread.sheet, spread.face),
                        PAGE_MM * 2.0,
                        PAGE_MM,
                        trim_origin,
                    );
                    plan.imposed_pair = Some((spread.left, spread.right));
                    plan
                })
                .collect())
        }
    }
}

fn rect_plan(label: &str, trim_w: f32, trim_h: f32, trim_origin_mm: (f32, f32)) -> PagePlan {
    PagePlan {
        label: label.to_string(),
        media_mm: (trim_w + BLEED_SAFE_MM * 2.0, trim_h + BLEED_SAFE_MM * 2.0),
        trim_mm: (trim_w, trim_h),
        trim_origin_mm,
        fold_marks_mm: Vec::new(),
        annulus_mm: None,
        imposed_pair: None,
    }
}

fn write_pdf(
    path: &PathBuf,
    kind: &PieceKind,
    plans: &[PagePlan],
    images: &[ImagePlacement],
    texts: &[TextPlacement],
) -> Result<(), String> {
    let label = piece_label(kind);
    let layouts = texts
        .iter()
        .map(|text| layout_text(kind, &plans[0], text, &label))
        .collect::<Result<Vec<_>, _>>()?;
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::with_capacity(plans.len());
    let pdf_images = add_image_xobjects(&mut doc, images, &label)?;
    let font_id = if texts.is_empty() {
        None
    } else {
        Some(doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        }))
    };

    for plan in plans {
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            page_content(plan, &pdf_images, texts, &layouts, plans.len()).into_bytes(),
        ));
        let page_id = add_page(&mut doc, pages_id, content_id, plan, &pdf_images, font_id);
        kids.push(Object::Reference(page_id));
    }

    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => plans.len() as i64,
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    doc.compress();
    doc.save(path).map_err(|err| err.to_string())?;
    Ok(())
}

fn add_page(
    doc: &mut Document,
    pages_id: ObjectId,
    content_id: ObjectId,
    plan: &PagePlan,
    images: &[PdfImage],
    font_id: Option<ObjectId>,
) -> ObjectId {
    let page_id = doc.new_object_id();
    let trim_x = plan.trim_origin_mm.0;
    let trim_y = plan.trim_origin_mm.1;
    let mut resources = dictionary! {};
    if !images.is_empty() {
        let mut xobjects = Dictionary::new();
        for image in images {
            xobjects.set(image.name.as_bytes(), Object::Reference(image.object_id));
        }
        resources.set("XObject", Object::Dictionary(xobjects));
    }
    if let Some(font_id) = font_id {
        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font_id));
        resources.set("Font", Object::Dictionary(fonts));
    }
    let mut page = dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => rect_array(0.0, 0.0, plan.media_mm.0, plan.media_mm.1),
        "TrimBox" => rect_array(trim_x, trim_y, trim_x + plan.trim_mm.0, trim_y + plan.trim_mm.1),
        "BleedBox" => rect_array(0.0, 0.0, plan.media_mm.0, plan.media_mm.1),
        "Contents" => content_id,
        "Resources" => resources,
        "PieceLabel" => Object::string_literal(plan.label.clone()),
    };
    if !plan.fold_marks_mm.is_empty() {
        page.set(
            "FoldMarksMm",
            Object::Array(
                plan.fold_marks_mm
                    .iter()
                    .map(|value| real(*value))
                    .collect(),
            ),
        );
    }
    if let Some((outer, inner, hole)) = plan.annulus_mm {
        page.set(
            "DiscAnnulusMm",
            Object::Array(vec![real(outer), real(inner), real(hole)]),
        );
    }
    if let Some((left, right)) = plan.imposed_pair {
        page.set(
            "ImposedPair",
            Object::Array(vec![
                Object::Integer(left as i64),
                Object::Integer(right as i64),
            ]),
        );
    }
    doc.objects.insert(page_id, Object::Dictionary(page));
    page_id
}

fn add_image_xobjects(
    doc: &mut Document,
    images: &[ImagePlacement],
    label: &str,
) -> Result<Vec<PdfImage>, String> {
    images
        .iter()
        .enumerate()
        .map(|(index, placement)| {
            let resolved_path = resolve_image_path(&placement.path)?;
            let decoded = image::ImageReader::open(&resolved_path)
                .map_err(|err| {
                    format!(
                        "failed to open placed image `{}` (resolved `{}`): {err}",
                        placement.path,
                        resolved_path.display()
                    )
                })?
                .with_guessed_format()
                .map_err(|err| err.to_string())?
                .decode()
                .map_err(|err| {
                    format!("failed to decode placed image `{}`: {err}", placement.path)
                })?
                .to_rgb8();
            enforce_300_dpi(&decoded, placement, label)?;
            let (width_px, height_px) = decoded.dimensions();
            let stream = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => decoded.width() as i64,
                    "Height" => decoded.height() as i64,
                    "ColorSpace" => "DeviceRGB",
                    "BitsPerComponent" => 8,
                    "EnforcedDpi" => PRINT_DPI as i64,
                    "SourcePath" => Object::string_literal(placement.path.clone()),
                },
                decoded.into_raw(),
            );
            Ok(PdfImage {
                name: format!("Img{}", index + 1),
                object_id: doc.add_object(stream),
                placement: placement.clone(),
                width_px,
                height_px,
            })
        })
        .collect()
}

/// The image is cover-fitted to its box, so it prints at 300 dpi or better
/// exactly when it has at least the box's pixel count on both axes (box axes
/// swap when the image is turned a quarter).
fn enforce_300_dpi(
    image: &image::RgbImage,
    placement: &ImagePlacement,
    label: &str,
) -> Result<(), String> {
    let scale = placement.scale.max(0.001);
    let mut required_w = mm_to_px(placement.w_mm * scale, PRINT_DPI).ceil() as u32;
    let mut required_h = mm_to_px(placement.h_mm * scale, PRINT_DPI).ceil() as u32;
    if quarter_turned(placement.rotation_deg) {
        std::mem::swap(&mut required_w, &mut required_h);
    }
    if image.width() < required_w || image.height() < required_h {
        return Err(format!(
            "The {label} image is too small to print sharply ({}×{} px; it needs {required_w}×{required_h}). Choose a larger image for {label} in Artwork.",
            image.width(),
            image.height(),
        ));
    }
    Ok(())
}

fn quarter_turned(rotation_deg: f32) -> bool {
    let angle = rotation_deg.to_radians();
    angle.sin().abs() > angle.cos().abs()
}

fn resolve_image_path(path: &str) -> Result<PathBuf, String> {
    let source = Path::new(path);
    if source.is_absolute() || source.exists() {
        return Ok(source.to_path_buf());
    }

    let mut candidates = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(source));
    }
    candidates.push(project_root()?.join(source));
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(source));

    Ok(candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| source.to_path_buf()))
}

fn project_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve project root".to_string())
}

fn page_content(
    plan: &PagePlan,
    images: &[PdfImage],
    texts: &[TextPlacement],
    layouts: &[TextLayout],
    page_count: usize,
) -> String {
    let mut content = String::new();
    content.push_str("0.92 0.92 0.92 rg\n");
    content.push_str(&format!(
        "{} {} {} {} re f\n",
        pt(0.0),
        pt(0.0),
        pt(plan.media_mm.0),
        pt(plan.media_mm.1)
    ));
    content.push_str("0 0 0 RG 0.5 w\n");
    for mark in &plan.fold_marks_mm {
        let x = *mark;
        content.push_str(&format!(
            "{} {} m {} {} l S\n",
            pt(x),
            pt(plan.trim_origin_mm.1),
            pt(x),
            pt(plan.trim_origin_mm.1 + plan.trim_mm.1)
        ));
    }
    if let Some((outer, inner, hole)) = plan.annulus_mm {
        content.push_str(&format!(
            "% annulus outer={} inner={} hole={}\n",
            outer, inner, hole
        ));
        content.push_str("0.2 0.2 0.2 RG 1 w\n");
        let cx = plan.trim_origin_mm.0 + plan.trim_mm.0 / 2.0;
        let cy = plan.trim_origin_mm.1 + plan.trim_mm.1 / 2.0;
        content.push_str(&circle_as_beziers(cx, cy, outer / 2.0, "S"));
        content.push_str(&circle_as_beziers(cx, cy, inner / 2.0, "S"));
        content.push_str(&circle_as_beziers(cx, cy, hole / 2.0, "S"));
        content.push_str("1 1 1 rg\n");
        content.push_str(&circle_as_beziers(cx, cy, hole / 2.0, "f"));
        content.push_str("0.2 0.2 0.2 RG 1 w\n");
        content.push_str(&circle_as_beziers(cx, cy, hole / 2.0, "S"));
    }
    for image in images {
        content.push_str(&image_content(image));
    }
    for (text, layout) in texts.iter().zip(layouts) {
        content.push_str(&text_content(plan, text, layout, page_count));
    }
    content.push_str(&crop_marks(plan));
    content
}

/// Short corner marks in the bleed, drawn over the art, ending just short of
/// the trim. Nothing is stroked inside the trim.
fn crop_marks(plan: &PagePlan) -> String {
    let (x0, y0) = plan.trim_origin_mm;
    let (x1, y1) = (x0 + plan.trim_mm.0, y0 + plan.trim_mm.1);
    let (w, h) = plan.media_mm;
    let gap = CROP_MARK_GAP_MM;
    let mut content = String::from("q 0 0 0 RG 0.25 w\n");
    for (x, y, out_x, out_y, in_x, in_y) in [
        (x0, y0, 0.0, 0.0, x0 - gap, y0 - gap),
        (x1, y0, w, 0.0, x1 + gap, y0 - gap),
        (x0, y1, 0.0, h, x0 - gap, y1 + gap),
        (x1, y1, w, h, x1 + gap, y1 + gap),
    ] {
        content.push_str(&format!(
            "{} {} m {} {} l S {} {} m {} {} l S\n",
            fmt(pt(out_x)),
            fmt(pt(y)),
            fmt(pt(in_x)),
            fmt(pt(y)),
            fmt(pt(x)),
            fmt(pt(out_y)),
            fmt(pt(x)),
            fmt(pt(in_y)),
        ));
    }
    content.push_str("Q\n");
    content
}

/// Cover-fit: scale the image so it fills its box on both axes, centre it,
/// and clip to the box, so nothing is stretched and nothing spills out.
fn image_content(image: &PdfImage) -> String {
    let placement = &image.placement;
    let (box_x, box_y) = (pt(placement.x_mm), pt(placement.y_mm));
    let (box_w, box_h) = (pt(placement.w_mm), pt(placement.h_mm));
    let (mut img_w, mut img_h) = (image.width_px.max(1) as f32, image.height_px.max(1) as f32);
    if quarter_turned(placement.rotation_deg) {
        std::mem::swap(&mut img_w, &mut img_h);
    }
    let fit = (box_w / img_w).max(box_h / img_h) * placement.scale.max(0.001);
    // Drawn size of the unrotated image.
    let (w, h) = if quarter_turned(placement.rotation_deg) {
        (img_h * fit, img_w * fit)
    } else {
        (img_w * fit, img_h * fit)
    };
    let angle = placement.rotation_deg.to_radians();
    let (cos, sin) = (angle.cos(), angle.sin());
    let (cx, cy) = (box_x + box_w / 2.0, box_y + box_h / 2.0);
    let e = cx - (w / 2.0 * cos - h / 2.0 * sin);
    let f = cy - (w / 2.0 * sin + h / 2.0 * cos);
    format!(
        "q\n{} {} {} {} re W n\n{} {} {} {} {} {} cm\n/{} Do\nQ\n",
        fmt(box_x),
        fmt(box_y),
        fmt(box_w),
        fmt(box_h),
        fmt(w * cos),
        fmt(w * sin),
        fmt(-h * sin),
        fmt(h * cos),
        fmt(e),
        fmt(f),
        image.name
    )
}

/// Wrap a text placement at the largest size (down to 6 pt) where it fits.
/// Booklets flow by reader page through the inside pages (never the covers),
/// one column per page either side of the fold.
fn layout_text(
    kind: &PieceKind,
    plan: &PagePlan,
    placement: &TextPlacement,
    label: &str,
) -> Result<TextLayout, String> {
    let (pages, columns) = match *kind {
        PieceKind::Booklet(pages) => {
            let fold = plan.trim_origin_mm.0 + plan.trim_mm.0 / 2.0;
            let gap = BLEED_SAFE_MM;
            let width = (fold - gap - placement.x_mm)
                .min(placement.x_mm + placement.w_mm - fold - gap)
                .max(1.0);
            (
                usize::from(pages.saturating_sub(2)).max(1),
                Some((fold - gap - width, fold + gap, width)),
            )
        }
        _ => (1, None),
    };
    let width_mm = columns.map_or(placement.w_mm, |(_, _, width)| width);
    let mut font_size = placement.font_size_pt.max(4.0);
    loop {
        let line_height_mm = font_size * LINE_HEIGHT / 72.0 * 25.4;
        let capacity = (placement.h_mm / line_height_mm).floor().max(1.0) as usize;
        let lines = wrapped_lines(placement, max_chars_for_width(width_mm, font_size));
        if lines.len() <= capacity * pages {
            return Ok(TextLayout {
                font_size,
                line_height_mm,
                capacity,
                lines,
                columns,
            });
        }
        if font_size <= MIN_TEXT_FONT_SIZE_PT {
            return Err(match *kind {
                PieceKind::Booklet(total) => format!(
                    "The lyrics do not fit in the {} inside pages of the {total}-page booklet, even at 6 pt. Choose more pages or shorten the lyrics.",
                    total.saturating_sub(2)
                ),
                _ => format!(
                    "The text for {label} does not fit, even at 6 pt. Shorten it or move some of it to the booklet."
                ),
            });
        }
        font_size = (font_size - 0.5).max(MIN_TEXT_FONT_SIZE_PT);
    }
}

fn wrapped_lines(placement: &TextPlacement, max_chars: usize) -> Vec<(String, bool)> {
    let mut lines = Vec::new();
    let title = placement.content.title.trim();
    if !title.is_empty() {
        for line in wrap_line(title, max_chars) {
            lines.push((line, true));
        }
    }
    for source in &placement.content.lines {
        let source = source.trim();
        if source.is_empty() {
            continue;
        }
        for line in wrap_line(source, max_chars) {
            lines.push((line, false));
        }
    }
    lines
}

fn text_content(
    plan: &PagePlan,
    placement: &TextPlacement,
    layout: &TextLayout,
    page_count: usize,
) -> String {
    // (first line, x) per column on this sheet face.
    let mut runs: Vec<(usize, f32)> = Vec::new();
    match (plan.imposed_pair, layout.columns) {
        (Some((left, right)), Some((left_x, right_x, _))) => {
            let back_cover = page_count * 2;
            for (page, x) in [(left, left_x), (right, right_x)] {
                let page = usize::from(page);
                if page > 1 && page < back_cover {
                    runs.push(((page - 2) * layout.capacity, x));
                }
            }
        }
        _ => runs.push((0, placement.x_mm)),
    }

    let mut content = String::new();
    for (start, x_mm) in runs {
        let end = (start + layout.capacity).min(layout.lines.len());
        if start >= end {
            continue;
        }
        if content.is_empty() {
            content.push_str("0 0 0 rg\n");
        }
        for (row, (line, title)) in layout.lines[start..end].iter().enumerate() {
            let size = if *title {
                layout.font_size + TITLE_FONT_SIZE_PT_DELTA
            } else {
                layout.font_size
            };
            let y_mm =
                placement.y_mm + placement.h_mm - ((row as f32 + 1.0) * layout.line_height_mm);
            content.push_str(&format!(
                "BT /F1 {} Tf {} {} Td ({}) Tj ET\n",
                fmt(size),
                fmt(pt(x_mm)),
                fmt(pt(y_mm)),
                escape_pdf_literal(line)
            ));
        }
    }
    content
}

fn max_chars_for_width(width_mm: f32, font_size_pt: f32) -> usize {
    ((pt(width_mm) / (font_size_pt * 0.52)).floor() as usize).max(8)
}

fn wrap_line(line: &str, max_chars: usize) -> Vec<String> {
    if line.chars().count() <= max_chars {
        return vec![line.to_string()];
    }
    let mut wrapped = Vec::new();
    let mut current = String::new();
    // A word longer than a whole line is split into line-sized pieces.
    let pieces = line.split_whitespace().flat_map(|word| {
        let chars = word.chars().collect::<Vec<_>>();
        chars
            .chunks(max_chars.max(1))
            .map(|chunk| chunk.iter().collect::<String>())
            .collect::<Vec<_>>()
    });
    for word in pieces {
        let word = word.as_str();
        let needed = if current.is_empty() {
            word.chars().count()
        } else {
            current.chars().count() + 1 + word.chars().count()
        };
        if needed > max_chars && !current.is_empty() {
            wrapped.push(current);
            current = word.to_string();
        } else {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        wrapped.push(current);
    }
    wrapped
}

/// A PDF string literal in WinAnsi (cp1252), the encoding of the Helvetica
/// resource: Latin-1 letters and the cp1252 punctuation become octal escapes;
/// only characters cp1252 cannot hold become '?'.
fn escape_pdf_literal(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '(' => escaped.push_str("\\("),
            ')' => escaped.push_str("\\)"),
            _ if ch.is_ascii() && !ch.is_control() => escaped.push(ch),
            _ => match cp1252_byte(ch) {
                Some(byte) => escaped.push_str(&format!("\\{byte:03o}")),
                None => escaped.push('?'),
            },
        }
    }
    escaped
}

fn cp1252_byte(ch: char) -> Option<u8> {
    let code = ch as u32;
    if (0xA0..=0xFF).contains(&code) {
        return Some(code as u8);
    }
    Some(match ch {
        '€' => 0x80,
        '‚' => 0x82,
        'ƒ' => 0x83,
        '„' => 0x84,
        '…' => 0x85,
        '†' => 0x86,
        '‡' => 0x87,
        'ˆ' => 0x88,
        '‰' => 0x89,
        'Š' => 0x8A,
        '‹' => 0x8B,
        'Œ' => 0x8C,
        'Ž' => 0x8E,
        '‘' => 0x91,
        '’' => 0x92,
        '“' => 0x93,
        '”' => 0x94,
        '•' => 0x95,
        '–' => 0x96,
        '—' => 0x97,
        '˜' => 0x98,
        '™' => 0x99,
        'š' => 0x9A,
        '›' => 0x9B,
        'œ' => 0x9C,
        'ž' => 0x9E,
        'Ÿ' => 0x9F,
        _ => return None,
    })
}

fn circle_as_beziers(cx_mm: f32, cy_mm: f32, r_mm: f32, operator: &str) -> String {
    let k = 0.552_284_8 * r_mm;
    let mut s = String::new();
    s.push_str(&format!("{} {} m\n", pt(cx_mm + r_mm), pt(cy_mm)));
    s.push_str(&format!(
        "{} {} {} {} {} {} c\n",
        pt(cx_mm + r_mm),
        pt(cy_mm + k),
        pt(cx_mm + k),
        pt(cy_mm + r_mm),
        pt(cx_mm),
        pt(cy_mm + r_mm)
    ));
    s.push_str(&format!(
        "{} {} {} {} {} {} c\n",
        pt(cx_mm - k),
        pt(cy_mm + r_mm),
        pt(cx_mm - r_mm),
        pt(cy_mm + k),
        pt(cx_mm - r_mm),
        pt(cy_mm)
    ));
    s.push_str(&format!(
        "{} {} {} {} {} {} c\n",
        pt(cx_mm - r_mm),
        pt(cy_mm - k),
        pt(cx_mm - k),
        pt(cy_mm - r_mm),
        pt(cx_mm),
        pt(cy_mm - r_mm)
    ));
    s.push_str(&format!(
        "{} {} {} {} {} {} c {}\n",
        pt(cx_mm + k),
        pt(cy_mm - r_mm),
        pt(cx_mm + r_mm),
        pt(cy_mm - k),
        pt(cx_mm + r_mm),
        pt(cy_mm),
        operator
    ));
    s
}

#[derive(Debug, Clone, PartialEq)]
struct Spread {
    sheet: u16,
    face: &'static str,
    left: u16,
    right: u16,
}

fn impose(pages: u16) -> Vec<Spread> {
    let mut spreads = Vec::new();
    for sheet in 0..pages / 4 {
        spreads.push(Spread {
            sheet,
            face: "outer",
            left: pages - 2 * sheet,
            right: 1 + 2 * sheet,
        });
        spreads.push(Spread {
            sheet,
            face: "inner",
            left: 2 + 2 * sheet,
            right: pages - 1 - 2 * sheet,
        });
    }
    spreads
}

/// The piece's name as the Artwork panel shows it (insertSpecs labels).
fn piece_label(kind: &PieceKind) -> String {
    match *kind {
        PieceKind::Front => "Front insert".to_string(),
        PieceKind::Tray => "Tray card".to_string(),
        PieceKind::Disc => "Disc face".to_string(),
        PieceKind::Folder(4) => "Bi-fold insert".to_string(),
        PieceKind::Folder(6) => "Tri-fold insert".to_string(),
        PieceKind::Folder(pages) => format!("{pages}-page folder"),
        PieceKind::Booklet(pages) => format!("{pages}-page saddle booklet"),
    }
}

fn piece_name(kind: &PieceKind) -> String {
    match *kind {
        PieceKind::Front => "front".to_string(),
        PieceKind::Tray => "tray".to_string(),
        PieceKind::Disc => "disc".to_string(),
        PieceKind::Folder(pages) => format!("folder-{pages}"),
        PieceKind::Booklet(pages) => format!("saddle-{pages}"),
    }
}

fn rect_array(x1: f32, y1: f32, x2: f32, y2: f32) -> Object {
    Object::Array(vec![real_pt(x1), real_pt(y1), real_pt(x2), real_pt(y2)])
}

fn real_pt(mm: f32) -> Object {
    real(pt(mm))
}

fn real(value: f32) -> Object {
    Object::Real(value)
}

fn default_image_scale() -> f32 {
    1.0
}

fn default_text_font_size() -> f32 {
    DEFAULT_TEXT_FONT_SIZE_PT
}

fn pt(mm: f32) -> f32 {
    mm / 25.4 * 72.0
}

fn fmt(value: f32) -> String {
    let text = format!("{value:.4}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}
