pub const BLEED_SAFE_MM: f32 = 3.175;
pub const PAGE_MM: f32 = 120.0;
pub const TRAY_W_MM: f32 = 150.0;
pub const TRAY_H_MM: f32 = 118.0;
pub const TRAY_SPINE_MM: f32 = 6.5;
pub const DISC_OUTER_MM: f32 = 118.0;
pub const DISC_INNER_MM: f32 = 22.0;
pub const DISC_HOLE_MM: f32 = 15.0;
pub const PRINT_DPI: u32 = 300;

pub fn mm_to_px(mm: f32, dpi: u32) -> f32 {
    mm / 25.4 * dpi as f32
}
