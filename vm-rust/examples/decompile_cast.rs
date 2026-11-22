//! Decompile every script of a Director cast (.cct/.cst/.dcr) to `<out>/<member>_<name>.ls`, with DirPlayer's own
//! decompiler. usage: cargo run --release --example decompile_cast -- <cast> <out dir>
use std::{fs, path::Path};
use vm_rust::director::{file::{get_variable_multiplier, read_director_file_bytes}, lingo::decompiler::handler::decompile_handler};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (path, out) = (&args[1], Path::new(&args[2]));
    fs::create_dir_all(out).unwrap();
    let bytes = fs::read(path).unwrap();
    let name = Path::new(path).file_name().unwrap().to_string_lossy().to_string();
    let file = read_director_file_bytes(&bytes, &name, "file:///").expect("read");
    for cast in &file.casts {
        let Some(lctx) = cast.lctx.as_ref() else { continue };
        let mult = get_variable_multiplier(cast.capital_x, cast.dir_version);
        let mut nums: Vec<_> = cast.members.keys().copied().collect();
        nums.sort();
        for num in nums {
            let m = &cast.members[&num];
            let Some(info) = m.chunk.member_info.as_ref() else { continue };
            let Some(script) = lctx.scripts.get(&info.header.script_id) else { continue };
            let mut src = String::new();
            let props: Vec<_> = script.property_name_ids.iter().map(|&i| lctx.names.get(i as usize).cloned().unwrap_or_default()).collect();
            if !props.is_empty() { src += &format!("property {}\n\n", props.join(", ")); }
            for h in &script.handlers {
                let d = decompile_handler(h, script, lctx, cast.dir_version, mult);
                src += &format!("on {}{}\n", d.name, if d.arguments.is_empty() { String::new() } else { format!(" {}", d.arguments.join(", ")) });
                for l in &d.lines { src += &format!("{}{}\n", "  ".repeat(l.indent as usize + 1), l.text); }
                src += "end\n\n";
            }
            let safe: String = info.name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '_' || c == '-' { c } else { '_' }).collect();
            fs::write(out.join(format!("{}_{}.ls", num, safe)), src).unwrap();
        }
    }
}
