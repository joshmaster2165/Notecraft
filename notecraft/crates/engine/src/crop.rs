//! Picture › Crop.
//!
//! OneNote describes a crop as the kept rectangle relative to the original
//! picture: `ImageCroppedTopLeftXPercentage` 0x140012F7,
//! `ImageCroppedTopLeftYPercentage` 0x140012F8, `ImageCroppedWidthPercentage`
//! 0x140012F5 and `ImageCroppedHeightPercentage` 0x140012F6. Despite the
//! names they hold float fractions 0–1 (file-format.md §15.1); the
//! `Deprecated_ImageCropped*` family (0x140035CA…) is unused. Notecraft keeps
//! the same four numbers as percentages 0–100, so a crop can be undone and
//! adjusted, and renders the cropped pixels for display and export.

use std::io::Cursor;

use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};

/// A crop in OneNote's terms: the kept rectangle as percentages (0–100) of the
/// original picture's width and height.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub top_left_x_percentage: f64,
    pub top_left_y_percentage: f64,
    pub width_percentage: f64,
    pub height_percentage: f64,
}

impl CropRect {
    pub const FULL: CropRect = CropRect { top_left_x_percentage: 0.0, top_left_y_percentage: 0.0, width_percentage: 100.0, height_percentage: 100.0 };

    /// Clamp to the picture and keep at least one pixel's worth.
    pub fn normalized(self) -> CropRect {
        let x = self.top_left_x_percentage.clamp(0.0, 99.9);
        let y = self.top_left_y_percentage.clamp(0.0, 99.9);
        CropRect {
            top_left_x_percentage: x,
            top_left_y_percentage: y,
            width_percentage: self.width_percentage.clamp(0.1, (100.0 - x).max(0.1)),
            height_percentage: self.height_percentage.clamp(0.1, (100.0 - y).max(0.1)),
        }
    }

    /// The kept rectangle in pixels of a `w` × `h` picture.
    pub fn pixels(self, w: u32, h: u32) -> (u32, u32, u32, u32) {
        let c = self.normalized();
        let px = |p: f64, total: u32| ((p / 100.0) * total as f64).round() as u32;
        let x = px(c.top_left_x_percentage, w).min(w.saturating_sub(1));
        let y = px(c.top_left_y_percentage, h).min(h.saturating_sub(1));
        let cw = px(c.width_percentage, w).clamp(1, w - x);
        let ch = px(c.height_percentage, h).clamp(1, h - y);
        (x, y, cw, ch)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cropped {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug)]
pub struct CropError(pub String);

impl std::fmt::Display for CropError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Crop encoded picture bytes. JPEGs stay JPEG; everything else becomes PNG.
pub fn crop(bytes: &[u8], rect: CropRect) -> Result<Cropped, CropError> {
    let reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| CropError(e.to_string()))?;
    let format = reader.format();
    let img = reader.decode().map_err(|e| CropError(format!("can't read the picture: {e}")))?;
    let (x, y, w, h) = rect.pixels(img.width(), img.height());
    let out = img.crop_imm(x, y, w, h);
    let mut buf = Cursor::new(Vec::new());
    let (fmt, media_type) = if format == Some(ImageFormat::Jpeg) { (ImageFormat::Jpeg, "image/jpeg") } else { (ImageFormat::Png, "image/png") };
    if fmt == ImageFormat::Jpeg {
        out.to_rgb8().write_to(&mut buf, fmt).map_err(|e| CropError(e.to_string()))?;
    } else {
        out.write_to(&mut buf, fmt).map_err(|e| CropError(e.to_string()))?;
    }
    Ok(Cropped { bytes: buf.into_inner(), media_type, width: w, height: h })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut img = RgbaImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = Rgba([(x * 10) as u8, (y * 10) as u8, 0, 255]);
        }
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn crops_by_percentages() {
        let rect = CropRect { top_left_x_percentage: 25.0, top_left_y_percentage: 50.0, width_percentage: 50.0, height_percentage: 50.0 };
        assert_eq!(rect.pixels(20, 10), (5, 5, 10, 5));
        let out = crop(&png(20, 10), rect).unwrap();
        assert_eq!((out.width, out.height, out.media_type), (10, 5, "image/png"));
        let img = image::load_from_memory(&out.bytes).unwrap().to_rgba8();
        // The top-left kept pixel was (5, 5) in the original.
        assert_eq!(img.get_pixel(0, 0).0, [50, 50, 0, 255]);
    }

    #[test]
    fn clamps_out_of_range_crops() {
        let rect = CropRect { top_left_x_percentage: 120.0, top_left_y_percentage: -5.0, width_percentage: 300.0, height_percentage: 0.0 };
        let (x, y, w, h) = rect.pixels(100, 100);
        assert!(x < 100 && y == 0 && w >= 1 && h >= 1 && x + w <= 100);
        assert!(crop(b"not a picture", CropRect::FULL).is_err());
    }
}
