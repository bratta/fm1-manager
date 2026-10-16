# FM-1 Manager

A browser app for the M-VAVE FM-1: manage the 128 presets and restore the stock
firmware, over USB using Web MIDI.

<video src=“fm1-manager-promo.mp4” controls=“controls” style=“max-width: 100%”></video>	

## Run it

Needs Node 20+ and Chrome, Edge or Opera (Firefox and Safari lack Web MIDI SysEx).

```sh
npm install
npm run dev        # open http://localhost:5173 and click Connect
npm test           # protocol tests, no synth needed
```

The browser asks for MIDI access with SysEx; allow it. Close other apps using
the FM-1's MIDI port (DAWs, editors) first.

## What it does

- **Connect** asks the synth for its identity (model and firmware version).
- **Presets**: import DX7 32-voice `.syx` banks into banks A-D, send them to
  the synth, export them. The synth asks on its own screen which bank to store
  a dump in. The stock firmware cannot send stored presets back, so the app
  keeps its own record (in the browser's local storage) of what it sent.
- **Back up all 128 presets** steps the synth through every preset with MIDI
  Program Change (firmware V14+) and reads each one, filling banks A-D. The
  result can be downloaded as one `.syx` file and imported again later.
- **Read current sound** pulls the voice in the synth's edit buffer (verified
  on stock V14/V15 by fm1-read-voice) so you can save it into the library.
- **Editor**: build a sound from the init voice, or open one from the library or
  a `.syx` file (Edit on any preset jumps there). Pick one of the 32 algorithms,
  edit each operator (drag the envelope points, set frequency, level and
  keyboard scaling), plus pitch envelope and LFO. An on-screen keyboard (or
  the A-L keys) plays it in the browser through a 6-operator FM engine modeled
  on Dexed's msfa code; it's close to the FM-1 but not identical. **Try on
  synth** loads it into the synth's edit buffer; **Save to bank** puts it in
  the library, from where it's sent or backed up as usual.
- **Firmware**: restore a known stock `.fwsc` package. Only packages whose
  SHA-256 is listed in `src/firmware/fwsc.ts` are accepted.

## Layout

| Path | What |
| --- | --- |
| `src/protocol/pack7.ts` | M-VAVE LSB-first 8-to-7 bit packing |
| `src/protocol/vendor.ts` | Vendor frames: identity, current-voice read, OTA requests/responses |
| `src/protocol/dx7.ts` | DX7 bank/single-voice dumps, VCED/VMEM conversion |
| `src/firmware/fwsc.ts` | `.fwsc` parsing, logical image, stock allowlist |
| `src/firmware/restore.ts` | Two-stage restore flow (check, reboot to loader, write, confirm) |
| `src/editor/` | Editor tab: voice model, algorithm table and layout, envelope editors, keyboard |
| `src/synth/` | Preview FM engine (`engine.ts`, `envelope.ts`) and its AudioWorklet |
| `src/backup.ts` | Step-and-read backup of all 128 presets |
| `src/midi/` | Transport-agnostic link + Web MIDI implementation |
| `tests/` | Golden vectors from the Python reference and a recorded real restore |

## Testing without hardware

`tests/fixtures/fm1-v15-reflash-2026-09-04.json` is the request sequence a
real FM-1 made while being restored to stock V15 (from AL-255/FM-1-RE, WTFPL).
The tests replay it and check every reply byte-for-byte against the Python
reference client. Tests that need the stock package read it from
`$FM1_STOCK_FWSC`; they are skipped if it is missing. Firmware files are never
committed.

## Safety

Firmware writes are risky: the FM-1 keeps a single firmware copy and no
hardware recovery path is proven. If a write is interrupted, leave the synth
plugged in and run the restore again; the app can resume when the synth is
already in update mode. Nothing in this app probes undocumented commands.

## Credits

Protocol knowledge comes from community reverse engineering:
[AL-255/FM-1-RE](https://github.com/AL-255/FM-1-RE) (OTA protocol, `fm1_ota.py`),
[Dexed / msfa](https://github.com/asb2m10/dexed) (DX7 envelope and scaling math the preview follows, Apache 2.0),
[czietz/fm1-read-voice](https://github.com/czietz/fm1-read-voice) (current-voice read),
[KingParamount/fm1-factory-presets](https://github.com/KingParamount/fm1-factory-presets)
(bank format and factory banks, which you can import here), and the
[awesome-fm-1](https://github.com/cicloid/awesome-fm-1) list.
