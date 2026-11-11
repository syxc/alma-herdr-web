"""Build and verify the terminal playback-symbol fallback from a pinned Noto source."""

import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "web/vendor/nerd-fonts/terminal-symbols/playback.woff2"
SOURCE_SHA256 = "630846d528dbe4c4981370a4d0a9475a1fd1491a129bb411f8e157cdb5de13c6"
POINTS = set(range(0x23F4, 0x23FB))


def outline(font, name):
    glyphs = font.getGlyphSet()
    pen = DecomposingRecordingPen(glyphs)
    glyphs[name].draw(pen)
    return pen.value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Pinned NotoSansSymbols2-Regular.ttf")
    parser.add_argument("--check", action="store_true", help="Check without writing files")
    args = parser.parse_args()
    assert hashlib.sha256(args.source.read_bytes()).hexdigest() == SOURCE_SHA256, "Source font changed"
    source = TTFont(args.source, recalcTimestamp=False)
    if not args.check:
        font = TTFont(args.source, recalcTimestamp=False)
        options = subset.Options()
        options.glyph_names = True
        worker = subset.Subsetter(options=options)
        worker.populate(unicodes=POINTS)
        worker.subset(font)
        font.flavor = "woff2"
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        font.save(OUTPUT)
        font.close()
    result = TTFont(OUTPUT)
    cmap = result.getBestCmap()
    original = source.getBestCmap()
    assert set(cmap) == POINTS, "Playback character coverage changed"
    for point, name in cmap.items():
        assert result["hmtx"][name] == source["hmtx"][original[point]], hex(point)
        assert outline(result, name) == outline(source, original[point]), hex(point)
    for table, fields in {
        "head": ["unitsPerEm"],
        "hhea": ["ascent", "descent", "lineGap"],
        "OS/2": ["sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent"],
    }.items():
        for field in fields:
            assert getattr(result[table], field) == getattr(source[table], field), (table, field)
    print(f"Checked {len(cmap)} playback symbols: mappings, outlines and metrics match; {OUTPUT.stat().st_size} bytes.")


if __name__ == "__main__":
    main()
