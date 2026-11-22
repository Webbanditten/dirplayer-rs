//! Tests against real casts. Set `EDITOR_CORPUS` to one or more folders (separated by `:`) of `.cct`/`.cst`/`.dcr`
//! files; without it the corpus tests do nothing. Habbo's furni casts are Sulake's and are not checked in.

use super::bitmap::{encode, ImportMode};
use super::cast::{read_stxt, stored_clut_id, write_stxt, CastDoc, MemberInfo, TYPE_BITMAP, TYPE_FIELD};
use super::container::ContainerFile;
use super::render::{render, RenderSpec};

fn corpus() -> Vec<std::path::PathBuf> {
    let Ok(dirs) = std::env::var("EDITOR_CORPUS") else { return vec![] };
    let mut files = Vec::new();
    for dir in dirs.split(':').filter(|d| !d.is_empty()) {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if matches!(p.extension().and_then(|x| x.to_str()), Some("cct" | "cst" | "dcr")) {
                files.push(p);
            }
        }
    }
    files.sort();
    files
}

#[test]
fn info_and_text_round_trip() {
    let mut info = MemberInfo::new_named("chair_norja_a_0_1_1_2_0");
    assert_eq!(info.name(), "chair_norja_a_0_1_1_2_0");
    info.set_name("x");
    assert_eq!(info.name(), "x");
    let stxt = write_stxt("a\nb", &[]);
    assert_eq!(read_stxt(&stxt).unwrap().0, "a\nb");
    assert_eq!(&stxt[12..15], b"a\rb");
}

#[test]
fn encode_indexed_and_rgba() {
    let pal: Vec<(u8, u8, u8)> = (0..=255u8).map(|i| (255 - i, 255 - i, 255 - i)).collect();
    // 3x2: transparent, black, mid grey / off-palette red, white, black
    let px = [0, 0, 0, 0, 0, 0, 0, 255, 128, 128, 128, 255, 200, 10, 10, 255, 255, 255, 255, 255, 0, 0, 0, 255];
    let e = encode(&px, 3, 2, ImportMode::Indexed, Some((&pal, 5))).unwrap();
    assert_eq!((e.depth, e.report.transparent, e.report.approximated, e.clut_id), (8, 1, 1, Some(5)));
    let a = encode(&px, 3, 2, ImportMode::Auto, Some((&pal, 5))).unwrap();
    assert_eq!(a.depth, 32, "an off-palette colour makes auto go 32-bit");
    assert!(a.use_alpha);
}

#[test]
fn corpus_round_trips() {
    let mut n = 0;
    for path in corpus() {
        let data = std::fs::read(&path).unwrap();
        let Ok(a) = ContainerFile::read(&data) else {
            eprintln!("skip {:?}: not a Director container", path);
            continue;
        };
        let written = a.write_afterburned();
        let b = ContainerFile::read(&written).unwrap_or_else(|e| panic!("{:?}: rewritten file unreadable: {}", path, e));
        assert_eq!(a.resources.len(), b.resources.len(), "{:?}", path);
        for (id, r) in &a.resources {
            let s = &b.resources[id];
            assert_eq!(r.tag, s.tag, "{:?} #{}", path, id);
            assert_eq!(r.data, s.data, "{:?} #{} {}", path, id, super::container::tag_str(&r.tag));
        }
        crate::director::file::read_director_file_bytes(&written, "x.cct", "http://localhost/")
            .unwrap_or_else(|e| panic!("{:?}: DirPlayer can't read the rewritten file: {}", path, e));
        n += 1;
    }
    eprintln!("round-tripped {} files", n);
}

#[test]
fn corpus_edits() {
    for path in corpus() {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("hh_furni_xx_") {
            continue;
        }
        let data = std::fs::read(&path).unwrap();
        let mut doc = CastDoc::open(&data).unwrap();
        let members = doc.summaries();
        let bitmaps: Vec<u32> = members.iter().filter(|m| m.kind == "bitmap" && m.bitmap.as_ref().unwrap().width > 1).map(|m| m.slot).collect();
        let field = members.iter().find(|m| m.kind == "field").map(|m| m.slot);

        // Every bitmap decodes and renders.
        for &s in &bitmaps {
            let (w, h, px) = doc.rgba(s).unwrap_or_else(|e| panic!("{} slot {}: {}", name, s, e));
            assert_eq!(px.len() as u32, w * h * 4);
        }
        let spec: RenderSpec = serde_json::from_str(&format!(
            r#"{{"width":200,"height":200,"sprites":[{}]}}"#,
            bitmaps.iter().map(|s| format!(r#"{{"slot":{},"left":40,"top":40,"ink":8}}"#, s)).collect::<Vec<_>>().join(",")
        ))
        .unwrap();
        let out = render(&doc, &spec, None).unwrap();
        assert!(out.chunks(4).any(|p| p[..3] != [255, 255, 255]), "{}: nothing drawn", name);

        // Edit: rename, text, registration point, new pixels (both depths), copy, delete.
        let first = bitmaps[0];
        let h0 = doc.bitmap_header(first).unwrap();
        doc.set_reg_point(first, h0.reg_x + 3, h0.reg_y - 2).unwrap();
        doc.set_name(first, "renamed_member").unwrap();
        if let Some(f) = field {
            let t = doc.text(f).unwrap_or_default();
            doc.set_text(f, &format!("{}\n-- edited", t)).unwrap();
        }
        let (w, h) = (7u32, 5u32);
        let mut px = Vec::new();
        for y in 0..h {
            for x in 0..w {
                px.extend_from_slice(&[(x * 30) as u8, (y * 40) as u8, 90, if x == 0 { 0 } else { 255 }]);
            }
        }
        let enc = encode(&px, w, h, ImportMode::Rgba32, None).unwrap();
        doc.put_bitmap(bitmaps[bitmaps.len() - 1], &enc, 2, 4).unwrap();
        let copy = doc.duplicate(first, "copied_member").unwrap();
        let last_header = doc.bitmap_header(first).unwrap();
        let pal = if last_header.palette_id > 0 { doc.palette_colors(last_header.palette_id as u32) } else { super::cast::builtin_palette_colors(last_header.palette_id) };
        let enc8 = encode(&px, w, h, ImportMode::Indexed, pal.as_deref().map(|p| (p, stored_clut_id(last_header.palette_id)))).unwrap();
        doc.put_bitmap(copy, &enc8, 1, 1).unwrap();
        let last_slot = bitmaps[bitmaps.len() - 1];
        let victim = members.iter().find(|m| m.name.ends_with("_small") && m.slot != first && m.slot != last_slot).map(|m| m.slot);
        if let Some(v) = victim {
            doc.delete(v).unwrap();
        }
        let saved = doc.save();

        let again = CastDoc::open(&saved).unwrap_or_else(|e| panic!("{}: saved cast unreadable: {}", name, e));
        crate::director::file::read_director_file_bytes(&saved, "x.cct", "http://localhost/").unwrap();
        let h1 = again.bitmap_header(first).unwrap();
        assert_eq!((h1.reg_x, h1.reg_y), (h0.reg_x + 3, h0.reg_y - 2), "{}", name);
        assert_eq!(again.member(first).unwrap().name(), "renamed_member");
        if let Some(f) = field {
            assert!(again.text(f).unwrap().ends_with("-- edited"), "{}", name);
        }
        let last = bitmaps[bitmaps.len() - 1];
        let hl = again.bitmap_header(last).unwrap();
        assert_eq!((hl.width, hl.height, hl.depth, hl.reg_x, hl.reg_y), (7, 5, 32, 2, 4), "{}", name);
        let (_, _, got) = again.rgba(last).unwrap();
        for i in 0..(w * h) as usize {
            let a = px[i * 4 + 3];
            if a == 255 {
                assert_eq!(&got[i * 4..i * 4 + 3], &px[i * 4..i * 4 + 3], "{} pixel {}", name, i);
            }
        }
        let c = again.member(copy).unwrap();
        assert_eq!((c.kind, c.name()), (TYPE_BITMAP, "copied_member".to_string()));
        assert_eq!(again.bitmap_header(copy).unwrap().depth, 8);
        if let Some(v) = victim {
            assert!(again.member(v).is_err(), "{}: deleted member still there", name);
        }
        let _ = TYPE_FIELD;
        eprintln!("{}: edited and reopened", name);
    }
}

#[test]
fn corpus_palettes_and_indices() {
    for path in corpus() {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("hh_furni_xx_") {
            continue;
        }
        let mut doc = CastDoc::open(&std::fs::read(&path).unwrap()).unwrap();
        let members = doc.summaries();
        let Some(m) = members.iter().find(|m| m.bitmap.as_ref().map(|b| b.depth == 8 && b.width > 2 && b.height > 2).unwrap_or(false)) else { continue };
        let slot = m.slot;
        let h = m.bitmap.clone().unwrap();
        let (w, hh, mut ix) = doc.indices(slot).unwrap();
        assert_eq!((w as i32, hh as i32), (h.width, h.height));
        ix[(w + 1) as usize] = 255;
        doc.put_indexed(slot, &ix, w, hh, h.reg_x, h.reg_y, 0).unwrap();
        // A new palette: a grey ramp, white at 0 like Director's palettes; then the member on it.
        let ramp: Vec<(u8, u8, u8)> = (0..256).map(|i| (255 - i as u8, 255 - i as u8, 255 - i as u8)).collect();
        let pal = doc.add_palette("Test ramp", &ramp).unwrap();
        doc.put_indexed(slot, &ix, w, hh, h.reg_x, h.reg_y, pal as i16).unwrap();
        let saved = doc.save();
        let mut again = CastDoc::open(&saved).unwrap();
        crate::director::file::read_director_file_bytes(&saved, "x.cct", "http://localhost/").unwrap();
        assert_eq!(again.indices(slot).unwrap().2, ix, "{}: indices", name);
        let hb = again.bitmap_header(slot).unwrap();
        assert_eq!(hb.palette_id, pal as i16, "{}: palette", name);
        assert_eq!(again.member(pal).unwrap().name(), "Test ramp");
        assert_eq!(again.palette_colors(pal).unwrap()[1], (254, 254, 254));
        let (_, _, px) = again.rgba(slot).unwrap();
        let i = (w + 1) as usize;
        assert_eq!(&px[i * 4..i * 4 + 3], &[0, 0, 0], "{}: index 255 of the ramp is black", name);
        // Recolouring the palette recolours the member.
        let mut red = ramp.clone();
        red[255] = (255, 0, 0);
        again.set_palette_colors(pal, &red).unwrap();
        let (_, _, px) = again.rgba(slot).unwrap();
        assert_eq!(&px[i * 4..i * 4 + 3], &[255, 0, 0], "{}", name);
        eprintln!("{}: slot {} clutCastLib {} -> palette {} ok", name, slot, h.clut_cast_lib, pal);
    }
}
