# Your own skin

Anything you drop in this folder stays on your machine: git ignores it, apart
from this file and the example. Use it to restyle the app with your own images
and colours without putting them in the repository — handy when the artwork
belongs to someone else, as bitmaps from a commercial plug-in do.

## How

1. Copy `skin.css.example` to `skin.css` in this same folder.
2. Reload the app. The skin button gains a fourth option, `local`.
3. Put your images next to it and refer to them relatively:
   `background-image: url("fader-cap.png")`.

The page loads `local-assets/skin.css` if it is there and ignores it if it is
not, so nothing breaks either way. Scope your rules to
`body[data-theme="local"]` to keep them on that one skin, or leave them
unscoped to change every skin at once.

Served by `dm12-bridge.py` on the PC version, and it works from `file://` too.
The Android app compiles its assets in, so this is a PC-side thing.
