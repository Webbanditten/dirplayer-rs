use binary_reader::BinaryReader;

pub struct PaletteChunk {
    pub colors: Vec<(u8, u8, u8)>,
}

impl PaletteChunk {
    pub fn from_reader(reader: &mut BinaryReader, _: u16) -> Result<PaletteChunk, String> {
        reader.set_endian(binary_reader::Endian::Big);

        // A CLUT holds one 6-byte entry per colour (16 bits a channel; the high byte is the colour) and can be
        // shorter than 256 colours: Habbo's "fishole_palette" (xmas08_hole) has 14. Director shows the rest of
        // such a palette as black. They were filled with magenta here, and index 255 is what copyPixels takes
        // as its default foreground colour, so the Darken ink (41) drew the catalogue's small icon of that
        // furni in pink.
        let mut colors = Vec::with_capacity(256);
        for _ in 0..256 {
            let mut entry = [0u8; 6];
            let mut complete = true;
            for byte in entry.iter_mut() {
                match reader.read_u8() {
                    Ok(b) => *byte = b,
                    Err(_) => {
                        complete = false;
                        break;
                    }
                }
            }
            if !complete {
                break;
            }
            colors.push((entry[0], entry[2], entry[4]));
        }
        colors.resize(256, (0, 0, 0));

        return Ok(PaletteChunk { colors });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clut(colors: &[(u8, u8, u8)]) -> Vec<u8> {
        colors.iter().flat_map(|&(r, g, b)| [r, r, g, g, b, b]).collect()
    }

    #[test]
    fn short_palette_is_black_past_its_last_colour() {
        let mut data = clut(&[(255, 255, 255), (230, 255, 255), (33, 91, 115)]);
        data.extend_from_slice(&[9, 9]); // a cut-off entry is not a colour
        let mut reader = BinaryReader::from_u8(&data);
        let palette = PaletteChunk::from_reader(&mut reader, 0).unwrap();
        assert_eq!(palette.colors.len(), 256);
        assert_eq!(palette.colors[0], (255, 255, 255));
        assert_eq!(palette.colors[2], (33, 91, 115));
        assert_eq!(palette.colors[3], (0, 0, 0));
        assert_eq!(palette.colors[255], (0, 0, 0));
    }

    #[test]
    fn full_palette_reads_every_colour() {
        let colors: Vec<(u8, u8, u8)> = (0..=255u8).map(|i| (i, 255 - i, i / 2)).collect();
        let data = clut(&colors);
        let mut reader = BinaryReader::from_u8(&data);
        let palette = PaletteChunk::from_reader(&mut reader, 0).unwrap();
        assert_eq!(palette.colors, colors);
    }
}
