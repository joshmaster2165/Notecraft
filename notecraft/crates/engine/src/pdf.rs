//! Insert › File Printout: render each page of a PDF as a picture.
//!
//! OneNote inserts a printout as the attached file plus one picture per page.
//! The pictures carry `IsPrintoutPage` (0x08001D85); a long document is split
//! across pages with `IsPartOfSplitPrintout` (0x080034C6), and
//! `PrintoutOutOfDate` (0x08001E2F) marks pictures older than the attachment.
//! Rendering uses hayro, a pure-Rust PDF rasterizer, so it works the same in
//! the desktop app and in the browser.

use std::sync::Arc;

use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{render, PixmapSettings, RenderCache, RenderSettings};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintoutPage {
    /// PNG bytes of the rendered page.
    pub png: Vec<u8>,
    /// Page size in points (1/72 in), for laying the pictures out at real size.
    pub width_pt: f32,
    pub height_pt: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Printout {
    pub page_count: usize,
    /// Rendered pages, in order (at most `max_pages`).
    pub pages: Vec<PrintoutPage>,
}

/// Render up to `max_pages` pages at `scale` pixels per point (2.0 is sharp on retina screens).
pub fn render_pdf(bytes: &[u8], scale: f32, max_pages: usize) -> Result<Printout, String> {
    let pdf = Pdf::new(Arc::new(bytes.to_vec())).map_err(|e| format!("can't read the PDF: {e:?}"))?;
    let settings = InterpreterSettings::default();
    let cache = RenderCache::new();
    let pages = pdf.pages();
    let mut out = Vec::new();
    for page in pages.iter().take(max_pages) {
        let (w, h) = page.render_dimensions();
        // Keep very large pages to a sane bitmap size.
        let s = scale.min(4096.0 / w.max(h).max(1.0));
        let pixmap = render(page, &cache, &settings, &RenderSettings::default(), &PixmapSettings { x_scale: s, y_scale: s, bg_color: WHITE });
        let png = pixmap.into_png().map_err(|e| format!("can't encode page: {e:?}"))?;
        out.push(PrintoutPage { png, width_pt: w, height_pt: h });
    }
    Ok(Printout { page_count: pages.len(), pages: out })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal one-page PDF with a filled rectangle.
    fn tiny_pdf() -> Vec<u8> {
        let content = b"0 0 1 rg 20 20 100 50 re f";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", content.len(), std::str::from_utf8(content).unwrap()),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, o) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{}\nendobj\n", i + 1, o).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for off in offsets {
            pdf.extend(format!("{off:010} 00000 n \n").as_bytes());
        }
        pdf.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
        pdf
    }

    #[test]
    fn renders_pages_to_png() {
        let out = render_pdf(&tiny_pdf(), 2.0, 10).unwrap();
        assert_eq!(out.page_count, 1);
        let page = &out.pages[0];
        assert_eq!((page.width_pt, page.height_pt), (200.0, 100.0));
        let img = image::load_from_memory(&page.png).unwrap().to_rgba8();
        assert_eq!((img.width(), img.height()), (400, 200));
        // Inside the blue rectangle (PDF y is bottom-up): x 40..240, y 200-140..200-40 at 2x.
        assert_eq!(img.get_pixel(100, 120).0[..3], [0, 0, 255]);
        // Outside it the page is white.
        assert_eq!(img.get_pixel(5, 5).0[..3], [255, 255, 255]);
        assert!(render_pdf(b"%PDF-broken", 1.0, 1).is_err());
    }
}
