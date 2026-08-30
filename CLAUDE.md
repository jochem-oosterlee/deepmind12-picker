# Working on this repo

A controller for a Behringer DeepMind 12. `README.md` explains what the thing
does and what we learned about the synth's protocol; this file is about working
on the code.

## The one rule

**`android/app/src/main/assets/index.html` is the whole app** — markup, style
and logic in one file, used by both the Android app and the web version. Edit
that file, never `dm12-web.html`: that one is generated.

```
node web/build-web.js        # index.html + web/bridge.js -> dm12-web.html
```

Forget the rebuild and the PC version silently stays on the old code.

## Running and testing

```
node android/test-ui.js android/app/src/main/assets/index.html      # with a skin
node android/test-ui.js android/app/src/main/assets/index.html --no-skin
node web/build-web.js && node android/test-ui.js dm12-web.html      # the built page
node web/test-bridge.js            # decoding, packing, global writes
node web/test-bridge-queue.js      # outgoing messages are coalesced
python web/test-python-bridge.py   # the bridge against a fake DeepMind
```

`android/test-ui.js` runs the page's JavaScript against a stubbed DOM. It is the
only thing standing between a typo and a blank app, so a change to the UI
belongs with a check in there. The stub mimics a browser where it matters:
`classList` works on `className`, and the fake synth takes on whatever the app
sends it.

Running the app locally:

```
python dm12-bridge.py        # finds the synth itself, serves the page on :8080
```

Then <http://localhost:8080>. No IP needed — the bridge remembers the address
that worked last time (`.dm12-last-ip`) and otherwise sweeps every network this
machine is on until a device answers an AppleMIDI invitation, and keeps doing so
while it runs.

## How the page hangs together

- **Transport is behind one interface.** The page only ever calls
  `AndroidBridge.*` (`sendNRPN`, `sendCC`, `libParams`, `libStatus`, …). On
  Android that is a Java object; in the browser `web/bridge.js` provides the
  same names over Web MIDI or the HTTP bridge. Anything synth-specific lives in
  the page, the transports stay dumb.
- **One place holds the values.** `params` is the store: `params.get(n)` to
  read, `params.fromUi(n, v, ch)` when the user moves something, and
  `params.fromSynth(n, v)` when a reading comes in. A control subscribes with
  `params.subscribe(n, fn)` and repaints itself; a value change must never
  rebuild the page. What you just set is held as pending for `ECHO_MS`, so a
  reading that has not caught up cannot drag your knob back — keep that window
  comfortably longer than the poll interval. A reading is also ignored when it
  answers a request that went out *before* your change (`params.askedAt`): a
  full dump takes seconds, and the one already in flight knows nothing about
  what you just moved. Ask for the buffer through `askEditBuffer()` so that
  stays true.
- **Rebuild only when the shape changes.** `loadSynthParams()` re-renders solely
  when a changed parameter is on screen *and* nobody subscribes to it
  (`shownParams`). A page rebuild during typing or dragging is a bug, and the
  test checks for it.
- **Tabs live in the URL hash**, so F5 stays where you were.
- **The look comes from a design.** `design/synth-oscillator-interface-ontwerp/`
  holds the handoff bundle from Claude Design that the panel style was built
  from — colours, sizes and the shape of every control are in
  `OSC Layouts.dc.html`. Read it before inventing a new control; there is
  probably already a class for it. The building blocks live in the CSS as
  `.pnl` (frame plus head), `.fads` (row of faders), `.cells`/`.cell` (grid
  below the rule), `.seg` (a handful of settings side by side, `.amber` for the
  second accent), `.pick` (long list), `.dial`, `.sw` and `.hbtn`. There is one
  colour scheme now - the design's own token set. The light and dark variants
  were dropped along with the switch in the header; a skin still overrides the
  same tokens.
- **Skin.** `local-assets/` holds Arturia Jun-6 V bitmaps and `skin.css`; it is
  gitignored on purpose (not ours to publish), so every layout must also look
  right without it. Hence the two test runs. Loading it is automatic - it sets
  `data-theme="local"`, and without the file the design's own colours stay.
  Buttons do not get an LED.
- **The header is one LED and one word**: `USB` or `WiFi`, whichever the page is
  talking over. Everything else - what it is waiting for, which program the synth
  reports, what the library just did - hangs under it as the tooltip.

## House style

- The interface is **English**; comments and test output are **Dutch**. Watch
  the seam between them: a card built in one language and updated in the other
  once shipped labels that flipped from "onbekend" to "unknown" while you looked
  at them.
- Comments say *why*, and only where the reason is not obvious from the code.
- Commit messages are prose that explains the reason for the change and any
  surprise found along the way — not a list of touched files. End them with the
  `Co-Authored-By: Claude ...` trailer.

## Measuring against the real instrument

Half of what this app knows about the DeepMind is not in the manual, and the
way to settle a question is to ask the synth. With the bridge running:

```python
# NRPN sturen
post(["b06300", "b06205", "b00601", "b02648"])          # parameter 5 = 200
# de edit buffer opvragen en uitpakken (8 bytes dragen 7 databytes)
post(["f00020322000037f"])                              # antwoord: commando 0x04
```

`GET /recv?since=N&wait=1` long-polls received MIDI as hex strings; several
readers can follow along at once, so you can watch while the page is open. That
is how the note-value encoding and the phase range were settled. Put back
whatever you changed on the instrument, and say so.

## Where things stand

Working: presets and banks, the editor, the library (read names, fetch patches,
write back), global settings over NRPN with your own labels and menus, the LFO
panels, discovery, and the readable SysEx log.

The **Panel** tab holds every panel at once, in signal order: LFO 1 and 2, OSC
1 and 2, VCF, VCA, HPF, and the three envelopes. The separate tabs still exist
and render the same panels.

Open threads:

- Arp/Seq is still plain cards; no design for it yet.
- Whether the separate per-section tabs are still worth keeping now that the
  Panel tab shows everything.
- 18 global settings are still unnamed, and the user's own Global layout has not
  been committed as a shared mapping file.
