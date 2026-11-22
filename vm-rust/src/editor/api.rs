//! The editor's JavaScript API: `new CastDocument(bytes)`, then read, change and `save()` members.

use wasm_bindgen::prelude::*;

use super::bitmap::{encode, ImportMode};
use super::cast::{stored_clut_id, CastDoc, TYPE_BITMAP, TYPE_FIELD, TYPE_TEXT};
use super::render::{render, RenderSpec};
use super::swf::SwfFile;

fn err(e: String) -> JsValue {
    JsValue::from_str(&e)
}

#[wasm_bindgen]
pub struct CastDocument {
    doc: CastDoc,
}

#[wasm_bindgen]
impl CastDocument {
    /// Open a cast (.cct afterburned, or .cst uncompressed).
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<CastDocument, JsValue> {
        CastDoc::open(bytes).map(|doc| CastDocument { doc }).map_err(err)
    }

    /// `[{slot, type, name, bitmap?: {width, height, regX, regY, depth, paletteId, clutCastLib, useAlpha}, media}]`
    #[wasm_bindgen(js_name = membersJson)]
    pub fn members_json(&self) -> String {
        serde_json::to_string(&self.doc.summaries()).unwrap_or_else(|_| "[]".into())
    }

    #[wasm_bindgen(js_name = directorVersion)]
    pub fn director_version(&self) -> u16 {
        self.doc.dir_version
    }

    #[wasm_bindgen(js_name = slotByName)]
    pub fn slot_by_name(&self, name: &str) -> u32 {
        self.doc.slot_by_name(name).unwrap_or(0)
    }

    /// RGBA pixels of a bitmap member (width and height from `membersJson`).
    pub fn rgba(&self, slot: u32) -> Result<Vec<u8>, JsValue> {
        self.doc.rgba(slot).map(|(_, _, d)| d).map_err(err)
    }

    /// A palette member's colours as r, g, b bytes.
    #[wasm_bindgen(js_name = paletteColors)]
    pub fn palette_colors(&self, slot: u32) -> Vec<u8> {
        self.doc.palette_colors(slot).unwrap_or_default().into_iter().flat_map(|(r, g, b)| [r, g, b]).collect()
    }

    pub fn text(&self, slot: u32) -> Option<String> {
        self.doc.text(slot)
    }

    #[wasm_bindgen(js_name = setText)]
    pub fn set_text(&mut self, slot: u32, text: &str) -> Result<(), JsValue> {
        self.doc.set_text(slot, text).map_err(err)
    }

    #[wasm_bindgen(js_name = setName)]
    pub fn set_name(&mut self, slot: u32, name: &str) -> Result<(), JsValue> {
        self.doc.set_name(slot, name).map_err(err)
    }

    /// Registration point relative to the bitmap's top left.
    #[wasm_bindgen(js_name = setRegPoint)]
    pub fn set_reg_point(&mut self, slot: u32, reg_x: i32, reg_y: i32) -> Result<(), JsValue> {
        self.doc.set_reg_point(slot, reg_x, reg_y).map_err(err)
    }

    /// Replace a bitmap member's pixels. `mode`: "auto" (8-bit on its palette when every colour fits, else 32-bit),
    /// "indexed" (8-bit, nearest palette colours) or "rgba" (32-bit). `paletteSlot` 0 = the member's own palette.
    /// Returns a JSON report `{depth, approximated, transparent, partialAlpha, bytes}`.
    #[wasm_bindgen(js_name = setBitmap)]
    pub fn set_bitmap(&mut self, slot: u32, rgba: &[u8], width: u32, height: u32, reg_x: i32, reg_y: i32, mode: &str, palette_slot: u32) -> Result<String, JsValue> {
        let header = self.doc.bitmap_header(slot).map_err(err)?;
        let (pal_id, colors) = if palette_slot > 0 {
            (palette_slot as i16, self.doc.palette_colors(palette_slot))
        } else if header.palette_id > 0 {
            (header.palette_id, self.doc.palette_colors(header.palette_id as u32))
        } else {
            (header.palette_id, super::cast::builtin_palette_colors(header.palette_id))
        };
        let palette = colors.as_ref().map(|c| (c.as_slice(), stored_clut_id(pal_id)));
        let enc = encode(rgba, width, height, ImportMode::parse(mode), palette).map_err(err)?;
        self.doc.put_bitmap(slot, &enc, reg_x, reg_y).map_err(err)?;
        Ok(serde_json::to_string(&enc.report).unwrap())
    }

    /// Copy a member into a new slot under a new name; returns the new slot.
    pub fn duplicate(&mut self, slot: u32, name: &str) -> Result<u32, JsValue> {
        self.doc.duplicate(slot, name).map_err(err)
    }

    /// A new bitmap member: a copy of `templateSlot` (a bitmap, for its header and palette) with these pixels.
    #[wasm_bindgen(js_name = addBitmap)]
    pub fn add_bitmap(&mut self, template_slot: u32, name: &str, rgba: &[u8], width: u32, height: u32, reg_x: i32, reg_y: i32, mode: &str) -> Result<u32, JsValue> {
        let kind = self.doc.member(template_slot).map_err(err)?.kind;
        if kind != TYPE_BITMAP {
            return Err(err("The template must be a bitmap".into()));
        }
        let slot = self.doc.duplicate(template_slot, name).map_err(err)?;
        if let Err(e) = self.set_bitmap(slot, rgba, width, height, reg_x, reg_y, mode, 0) {
            let _ = self.doc.delete(slot);
            return Err(e);
        }
        Ok(slot)
    }

    /// A new field member: a copy of `templateSlot` (a field or text member) with this name and text.
    #[wasm_bindgen(js_name = addField)]
    pub fn add_field(&mut self, template_slot: u32, name: &str, text: &str) -> Result<u32, JsValue> {
        let kind = self.doc.member(template_slot).map_err(err)?.kind;
        if kind != TYPE_FIELD && kind != TYPE_TEXT {
            return Err(err("The template must be a field".into()));
        }
        let slot = self.doc.duplicate(template_slot, name).map_err(err)?;
        self.doc.set_text(slot, text).map_err(err)?;
        Ok(slot)
    }

    pub fn delete(&mut self, slot: u32) -> Result<(), JsValue> {
        self.doc.delete(slot).map_err(err)
    }

    /// The cast as an afterburned .cct.
    pub fn save(&mut self) -> Vec<u8> {
        self.doc.save()
    }

    /// Decode a PNG/GIF/JPEG to `[width u32 LE, height u32 LE, RGBA...]`, pixels exactly as stored (no colour
    /// management, no premultiplying, unlike a browser canvas).
    #[wasm_bindgen(js_name = decodeImage)]
    pub fn decode_image(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        let img = image::load_from_memory(bytes).map_err(|e| err(e.to_string()))?.to_rgba8();
        let mut out = Vec::with_capacity(8 + img.as_raw().len());
        out.extend_from_slice(&img.width().to_le_bytes());
        out.extend_from_slice(&img.height().to_le_bytes());
        out.extend_from_slice(img.as_raw());
        Ok(out)
    }

    /// Encode RGBA pixels as a PNG.
    #[wasm_bindgen(js_name = encodePng)]
    pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsValue> {
        let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or_else(|| err("Wrong pixel count".into()))?;
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| err(e.to_string()))?;
        Ok(out.into_inner())
    }

    /// Draw members like sprites. `specJson`: `{width, height, sprites: [{slot, left, top, flipH, flipV, ink, blend,
    /// color: [r,g,b]?, bgColor: [r,g,b]?}]}`; `background`: RGBA of the canvas size, or empty for white.
    pub fn render(&self, spec_json: &str, background: &[u8]) -> Result<Vec<u8>, JsValue> {
        let spec: RenderSpec = serde_json::from_str(spec_json).map_err(|e| err(e.to_string()))?;
        render(&self.doc, &spec, if background.is_empty() { None } else { Some(background) }).map_err(err)
    }
}

/// A Flash file's assets: `new SwfDocument(bytes)`, then `summaryJson()`, `binaryText(id)`, `imageRgba(id)`.
#[wasm_bindgen]
pub struct SwfDocument {
    swf: SwfFile,
}

#[wasm_bindgen]
impl SwfDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<SwfDocument, JsValue> {
        SwfFile::read(bytes).map(|swf| SwfDocument { swf }).map_err(err)
    }

    /// `{version, binary: [{id, size, names}], images: [{id, width, height, names}], skipped: [{tag, id, reason}]}`
    #[wasm_bindgen(js_name = summaryJson)]
    pub fn summary_json(&self) -> String {
        let s = &self.swf;
        serde_json::json!({
            "version": s.version,
            "binary": s.binary.iter().map(|(id, d)| serde_json::json!({ "id": id, "size": d.len(), "names": s.names_of(*id) })).collect::<Vec<_>>(),
            "images": s.images.iter().map(|i| serde_json::json!({ "id": i.id, "width": i.width, "height": i.height, "names": s.names_of(i.id) })).collect::<Vec<_>>(),
            "skipped": s.skipped.iter().map(|(t, id, r)| serde_json::json!({ "tag": t, "id": id, "reason": r })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// A DefineBinaryData payload as text (UTF-8).
    #[wasm_bindgen(js_name = binaryText)]
    pub fn binary_text(&self, id: u16) -> Option<String> {
        self.swf.binary.iter().find(|(i, _)| *i == id).map(|(_, d)| String::from_utf8_lossy(d).into_owned())
    }

    /// A bitmap's straight RGBA pixels.
    #[wasm_bindgen(js_name = imageRgba)]
    pub fn image_rgba(&self, id: u16) -> Vec<u8> {
        self.swf.images.iter().find(|i| i.id == id).map(|i| i.rgba.clone()).unwrap_or_default()
    }
}
