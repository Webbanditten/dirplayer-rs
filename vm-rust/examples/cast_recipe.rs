//! Apply a JSON recipe of edits to a Director cast with the editor's own code (`vm_rust::editor`), or list a cast.
//!
//!   cargo run --release --example cast_recipe -- <cast in> <recipe.json> <cast out>
//!   cargo run --release --example cast_recipe -- <cast in>          (lists its members as JSON)
//!
//! The recipe, every part optional, applied in this order (member names are the cast's names *before* `renames`):
//!   "newPalettes": [{ "name": "...", "rgb": [[r, g, b], ...] }]            palette members to add
//!   "palettes":    [{ "name": "...", "rgb": [[r, g, b], ...] }]            new colours for a palette member
//!   "bitmaps":     [{ "name": "...", "indices": "<base64, one byte a pixel>", "width": w, "height": h,
//!                     "palette": "<palette member's name>" | <built-in id below 0> }]
//!                  8-bit pixels for a bitmap member; its registration point stays ("regX"/"regY" change it)
//!   "addBitmaps":  [{ "template": "<a bitmap member>", "name": "<new name>", ...as "bitmaps", all optional }]
//!                  a copy of a bitmap member under a new name, with new pixels when "indices" is given
//!   "texts":       [{ "name": "...", "text": "..." }]                      a field's text
//!   "renames":     [["old name", "new name"], ...]
//!   "deletes":     ["name", ...]                                           by the name they have after `renames`
//! It stops at the first thing that doesn't fit (an unknown member, a palette that isn't one) and writes nothing.
use base64::Engine;
use serde_json::Value;
use std::fs;
use vm_rust::editor::cast::CastDoc;

fn rgb_list(v: &Value) -> Result<Vec<(u8, u8, u8)>, String> {
    v.as_array()
        .ok_or("rgb must be a list")?
        .iter()
        .map(|c| {
            let c = c.as_array().filter(|c| c.len() == 3).ok_or("a colour is [r, g, b]")?;
            let ch = |i: usize| c[i].as_u64().filter(|n| *n < 256).map(|n| n as u8).ok_or("a colour channel is 0-255");
            Ok((ch(0)?, ch(1)?, ch(2)?))
        })
        .collect::<Result<Vec<_>, &str>>()
        .map_err(|e| e.to_string())
}

fn slot_of(doc: &CastDoc, name: &str) -> Result<u32, String> {
    // exact name first: slot_by_name ignores case, and a cast may hold "small" next to "Small"
    doc.summaries().iter().find(|m| m.name == name).map(|m| m.slot).or_else(|| doc.slot_by_name(name)).ok_or(format!("No member named '{}'", name))
}

fn text_of<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key).and_then(|n| n.as_str()).ok_or(format!("'{}' is missing", key))
}

/// Write a recipe entry's 8-bit pixels into the bitmap in `slot`.
fn put_pixels(doc: &mut CastDoc, slot: u32, b: &Value) -> Result<String, String> {
    let header = doc.bitmap_header(slot)?;
    let indices = base64::engine::general_purpose::STANDARD.decode(text_of(b, "indices")?).map_err(|e| e.to_string())?;
    let num = |key: &str| b.get(key).and_then(|n| n.as_i64());
    let (w, h) = (num("width").ok_or("width is missing")? as u32, num("height").ok_or("height is missing")? as u32);
    let palette = match &b["palette"] {
        Value::String(s) => slot_of(doc, s)? as i16,
        Value::Number(n) => n.as_i64().filter(|n| *n < 0).ok_or("a palette number is a built-in, below 0")? as i16,
        _ => 0,
    };
    let reg = (num("regX").map(|n| n as i32).unwrap_or(header.reg_x), num("regY").map(|n| n as i32).unwrap_or(header.reg_y));
    doc.put_indexed(slot, &indices, w, h, reg.0, reg.1, palette)?;
    Ok(format!("{}x{} {}-bit palette {} -> {}x{} 8-bit palette {}", header.width, header.height, header.depth, header.palette_id, w, h, palette))
}

fn apply(doc: &mut CastDoc, recipe: &Value) -> Result<Vec<String>, String> {
    let mut log = vec![];
    let list = |key: &str| recipe.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for p in list("newPalettes") {
        let slot = doc.add_palette(text_of(&p, "name")?, &rgb_list(&p["rgb"])?)?;
        log.push(format!("palette '{}' added in slot {}", text_of(&p, "name")?, slot));
    }
    for p in list("palettes") {
        let slot = slot_of(doc, text_of(&p, "name")?)?;
        doc.set_palette_colors(slot, &rgb_list(&p["rgb"])?)?;
        log.push(format!("palette '{}' recoloured", text_of(&p, "name")?));
    }
    for b in list("bitmaps") {
        let name = text_of(&b, "name")?;
        let slot = slot_of(doc, name)?;
        log.push(format!("bitmap '{}': {}", name, put_pixels(doc, slot, &b)?));
    }
    for b in list("addBitmaps") {
        let name = text_of(&b, "name")?;
        if doc.summaries().iter().any(|m| m.name == name) {
            return Err(format!("A member named '{}' is there already", name));
        }
        let slot = doc.duplicate(slot_of(doc, text_of(&b, "template")?)?, name)?;
        if b.get("indices").is_some() {
            put_pixels(doc, slot, &b)?;
        } else if b.get("regX").is_some() || b.get("regY").is_some() {
            let header = doc.bitmap_header(slot)?;
            let num = |key: &str, or: i32| b.get(key).and_then(|n| n.as_i64()).map(|n| n as i32).unwrap_or(or);
            doc.set_reg_point(slot, num("regX", header.reg_x), num("regY", header.reg_y))?;
        }
        log.push(format!("bitmap '{}' added in slot {}", name, slot));
    }
    for t in list("texts") {
        let slot = slot_of(doc, text_of(&t, "name")?)?;
        doc.set_text(slot, text_of(&t, "text")?)?;
    }
    let mut renamed = 0;
    for r in list("renames") {
        let pair = r.as_array().filter(|p| p.len() == 2).ok_or("a rename is [old, new]")?;
        let (old, new) = (pair[0].as_str().ok_or("a name is text")?, pair[1].as_str().ok_or("a name is text")?);
        let slot = slot_of(doc, old)?;
        doc.set_name(slot, new)?;
        renamed += 1;
    }
    if renamed > 0 {
        log.push(format!("{} members renamed", renamed));
    }
    for d in list("deletes") {
        let name = d.as_str().ok_or("a delete is a member name")?;
        let slot = slot_of(doc, name)?;
        doc.delete(slot)?;
        log.push(format!("'{}' deleted", name));
    }
    Ok(log)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 && args.len() != 4 {
        eprintln!("usage: cast_recipe <cast in> [<recipe.json> <cast out>]");
        std::process::exit(2);
    }
    let mut doc = CastDoc::open(&fs::read(&args[1]).expect("read the cast")).expect("open the cast");
    if args.len() == 2 {
        println!("{}", serde_json::to_string_pretty(&doc.summaries()).unwrap());
        return;
    }
    let recipe: Value = serde_json::from_str(&fs::read_to_string(&args[2]).expect("read the recipe")).expect("the recipe is JSON");
    match apply(&mut doc, &recipe) {
        Ok(log) => {
            let bytes = doc.save();
            // what was written must open again
            let check = CastDoc::open(&bytes).expect("the written cast opens");
            fs::write(&args[3], &bytes).expect("write the cast");
            for line in log {
                println!("  {}", line);
            }
            println!("{}: {} members, {} bytes", args[3], check.summaries().len(), bytes.len());
        }
        Err(e) => {
            eprintln!("{}: {}", args[1], e);
            std::process::exit(1);
        }
    }
}
