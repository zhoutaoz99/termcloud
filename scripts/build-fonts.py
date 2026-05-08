#!/usr/bin/env python3
"""Rebuild public/fonts/sarasa-fixed-sc-regular.woff2 from upstream Sarasa Gothic.

Sarasa Fixed SC enforces 2x ASCII width on every CJK glyph (including
fullwidth punctuation like '，', '。', '：'), which is what keeps markdown
tables aligned in xterm.js where the browser's per-character font fallback
otherwise picks Western fonts that render those punctuation glyphs at the
wrong visual width.

Subset coverage: ASCII, Latin Extended, common punctuation, box drawing,
fullwidth/halfwidth forms, CJK symbols & punctuation, hiragana, katakana,
and the ~6.7K CJK ideographs covered by GB 2312. That covers daily Chinese
usage at ~970 KB after woff2/brotli; rare hanzi outside GB 2312 fall through
to the local() fallback chain in the @font-face rule.

Requires: pip install --user fonttools brotli py7zr
Run: python3 scripts/build-fonts.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SARASA_VERSION = "1.0.37"
ARCHIVE_NAME = f"SarasaFixedSC-TTF-Unhinted-{SARASA_VERSION}.7z"
ARCHIVE_URL = (
    f"https://github.com/be5invis/Sarasa-Gothic/releases/download/"
    f"v{SARASA_VERSION}/{ARCHIVE_NAME}"
)
TTF_NAME = "SarasaFixedSC-Regular.ttf"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "public" / "fonts" / "sarasa-fixed-sc-regular.woff2"


def fixed_unicode_ranges() -> list[int]:
    ranges = [
        (0x0020, 0x007E),  # ASCII
        (0x00A0, 0x024F),  # Latin-1 + Extended A/B
        (0x2000, 0x206F),  # General Punctuation
        (0x2190, 0x21FF),  # Arrows
        (0x2500, 0x257F),  # Box Drawing
        (0x2580, 0x259F),  # Block Elements
        (0x25A0, 0x25FF),  # Geometric Shapes
        (0x2600, 0x26FF),  # Misc Symbols
        (0x3000, 0x303F),  # CJK Symbols and Punctuation
        (0x3040, 0x309F),  # Hiragana
        (0x30A0, 0x30FF),  # Katakana
        (0xFE30, 0xFE4F),  # CJK Compatibility Forms
        (0xFE50, 0xFE6F),  # Small Form Variants
        (0xFF00, 0xFFEF),  # Halfwidth and Fullwidth Forms (the critical block)
    ]
    out: list[int] = []
    for a, b in ranges:
        out.extend(range(a, b + 1))
    return out


def gb2312_hanzi() -> list[int]:
    out: list[int] = []
    for cp in range(0x4E00, 0xA000):
        try:
            chr(cp).encode("gb2312")
        except UnicodeEncodeError:
            continue
        out.append(cp)
    return out


def download(url: str, dest: Path) -> None:
    print(f"downloading {url}")
    subprocess.run(
        ["curl", "-fL", "--progress-bar", "-o", str(dest), url],
        check=True,
    )


def extract_ttf(archive: Path, target_name: str, out_dir: Path) -> Path:
    import py7zr  # type: ignore[import-not-found]

    with py7zr.SevenZipFile(archive, "r") as z:
        z.extract(path=out_dir, targets=[target_name])
    return out_dir / target_name


def subset_to_woff2(src_ttf: Path, out_woff2: Path) -> None:
    from fontTools.subset import Options, Subsetter
    from fontTools.ttLib import TTFont

    unicodes = fixed_unicode_ranges() + gb2312_hanzi()
    print(f"requested codepoints: {len(unicodes)}")

    opts = Options()
    opts.desubroutinize = True
    opts.hinting = False
    opts.glyph_names = False
    opts.legacy_kern = False
    opts.layout_features = []
    opts.name_IDs = []
    opts.name_legacy = False
    opts.name_languages = []
    opts.notdef_outline = True
    opts.recommended_glyphs = False
    opts.drop_tables += [
        "FFTM", "DSIG", "TTFA", "GPOS", "GSUB", "GDEF", "BASE",
        "JSTF", "MATH", "vhea", "vmtx", "VORG", "MVAR", "STAT",
        "HVAR", "VVAR", "kern", "fpgm", "prep", "cvt ", "VDMX", "PCLT",
    ]
    opts.ignore_missing_unicodes = True
    opts.ignore_missing_glyphs = True

    font = TTFont(str(src_ttf))
    sub = Subsetter(options=opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)

    font.flavor = "woff2"
    out_woff2.parent.mkdir(parents=True, exist_ok=True)
    font.save(str(out_woff2))


def main() -> int:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sarasa-build-") as tmp:
        tmpdir = Path(tmp)
        archive = tmpdir / ARCHIVE_NAME
        download(ARCHIVE_URL, archive)
        ttf = extract_ttf(archive, TTF_NAME, tmpdir)
        print(f"extracted {ttf} ({ttf.stat().st_size / 1024 / 1024:.2f} MB)")
        subset_to_woff2(ttf, OUT_PATH)
    sz = OUT_PATH.stat().st_size
    print(f"wrote {OUT_PATH} ({sz / 1024:.0f} KB / {sz / 1024 / 1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
