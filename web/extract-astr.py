#!/usr/bin/env python3
"""
Maakt filmstrips van .astr-archieven, zodat afbeeldingen van een plug-in als
knop of fader in de app gebruikt kunnen worden.

    python web/extract-astr.py                  # standaardmap hieronder
    python web/extract-astr.py "C:/pad/naar/100%"

Een .astr is een eenvoudig archief: de tekst ASTR, dan versie, aantal frames,
breedte en hoogte, dan een tabel met posities naar losse PNG's. Dit programma
zet die frames onder elkaar in één PNG, wat een browser met
background-position per stand kan tonen.

De resultaten komen in local-assets/ en blijven daarmee buiten dit project:
het beeldmateriaal is niet van ons en hoort niet in een publieke repository.
"""
import os
import shutil
import struct
import sys

try:
    from PIL import Image
except ImportError:
    print("Pillow is nodig: python -m pip install pillow")
    sys.exit(1)

DEFAULT_SRC = r"C:\ProgramData\Arturia\Jun-6 V\resources\bitmap\bmp\100%"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "local-assets")

# wat we eruit halen: bron -> naam in local-assets
STRIPS = [
    ("Faders/SideFaders.astr", "fader.png"),
    ("Dials/VolumeDials.astr", "knob.png"),
    ("Dials/TuneDials.astr", "knob-alt.png"),
    ("Switches/VCF.astr", "switch2.png"),
    ("Switches/DCO.astr", "switch3.png"),
]
COPIES = [
    ("RedLEDOn.png", "led-on.png"),
    ("Juno6VBody.png", "panel.png"),
]


def frames(path):
    """Levert (breedte, hoogte, [png-bytes...]) uit een .astr-archief."""
    d = open(path, "rb").read()
    if d[:4] != b"ASTR":
        raise ValueError("geen ASTR-archief: " + path)
    _ver, count, w, h = struct.unpack("<IIII", d[4:20])
    offs = list(struct.unpack("<%dI" % count, d[20:20 + 4 * count]))
    offs.append(len(d))
    out = []
    for i in range(count):
        chunk = d[offs[i]:offs[i + 1]]
        start = chunk.find(b"\x89PNG")
        if start >= 0:
            out.append(chunk[start:])
    return w, h, out


def build_strip(src, dest):
    w, h, pngs = frames(src)
    if not pngs:
        print("  geen frames in", src)
        return None
    import io
    sheet = Image.new("RGBA", (w, h * len(pngs)), (0, 0, 0, 0))
    for i, raw in enumerate(pngs):
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        sheet.paste(im, (0, i * h), im)
    sheet.save(dest)
    return w, h, len(pngs)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.isdir(src):
        print("bronmap niet gevonden:", src)
        sys.exit(1)
    os.makedirs(OUT, exist_ok=True)
    print("bron :", src)
    print("doel :", OUT)
    print()
    made = []
    for rel, name in STRIPS:
        path = os.path.join(src, rel.replace("/", os.sep))
        if not os.path.isfile(path):
            print("  overgeslagen (niet aanwezig):", rel)
            continue
        r = build_strip(path, os.path.join(OUT, name))
        if r:
            print("  %-28s -> %-14s %d frames van %dx%d" % (rel, name, r[2], r[0], r[1]))
            made.append((name, r))
    for rel, name in COPIES:
        path = os.path.join(src, rel)
        if os.path.isfile(path):
            shutil.copyfile(path, os.path.join(OUT, name))
            print("  %-28s -> %s" % (rel, name))
    print()
    if made:
        print("Zet dit in local-assets/skin.css om ze te gebruiken:")
        print()
        print('body[data-theme="local"] {')
        for name, (w, h, n) in made:
            key = os.path.splitext(name)[0]
            print('  --%s-img:url("%s"); --%s-frames:%d; --%s-w:%dpx; --%s-h:%dpx;'
                  % (key, name, key, n, key, w, key, h))
        print("}")


if __name__ == "__main__":
    main()
