import { describe, expect, it } from "vitest";
import { putBack, tryOnSynth } from "../src/editor/audition";
import type { SysexLink } from "../src/midi/link";
import { parseSingleVoiceSysex } from "../src/protocol/dx7";
import { buildFrame, parseFrame } from "../src/protocol/vendor";

const voice = (name: string) => {
  const v = new Uint8Array(155);
  v.set(Array.from(name.padEnd(10), (c) => c.charCodeAt(0)), 145);
  return v;
};

/**
 * Like the FM-1: a single-voice dump is stored into the selected preset,
 * parameter changes only edit the buffer, and reads return the buffer.
 */
function fakeSynth(names: string[], { answers = true } = {}) {
  const presets: Uint8Array[] = names.map(voice);
  const synth = {
    current: 0,
    presets,
    buffer: presets[0]!.slice(),
    select(n: number) {
      synth.current = n;
      synth.buffer = presets[n]!.slice();
    },
  };
  const outbox: Uint8Array[] = [];
  const link: SysexLink = {
    name: "FM-1",
    send(msg) {
      if (msg[1] === 0x43 && (msg[2]! & 0xf0) === 0x00 && msg[3] === 0x00) {
        presets[synth.current] = parseSingleVoiceSysex(msg);
        synth.buffer = presets[synth.current]!.slice();
      } else if (msg[1] === 0x43 && (msg[2]! & 0xf0) === 0x10) synth.buffer[(msg[3]! << 7) + msg[4]!] = msg[5]!;
      else if (answers && parseFrame(msg)?.type === 0x23) outbox.push(buildFrame(0x23, [5, 0, 0, 0, 0, 155, 0, 0, ...synth.buffer]));
    },
    receive: async () => outbox.shift() ?? null,
    drain: () => (outbox.length = 0),
    close: () => {},
  };
  return { link, synth };
}

const name = (v: Uint8Array) => String.fromCharCode(...v.subarray(145)).trim();

describe("try on synth", () => {
  it("keeps the preset's original sound across several tries and puts it back", async () => {
    const { link, synth } = fakeSynth(["E.PIANO 1", "BRASS 1"]);
    const a = await tryOnSynth(link, voice("TRY 1"), null);
    if (!a.ok) throw new Error("try failed");
    expect(a.firstTry).toBe(true);
    const b = await tryOnSynth(link, voice("TRY 2"), a.kept);
    if (!b.ok) throw new Error("try failed");
    expect(b.firstTry).toBe(false);
    expect(name(b.kept.original)).toBe("E.PIANO 1");
    expect(name(synth.buffer)).toBe("TRY 2");
    expect(name(synth.presets[0]!)).toBe("E.PIANO 1"); // trying never stores
    expect(await putBack(link, b.kept)).toEqual({ ok: true, name: "E.PIANO 1" });
    expect(name(synth.buffer)).toBe("E.PIANO 1");
    expect(name(synth.presets[0]!)).toBe("E.PIANO 1");
    expect(name(synth.presets[1]!)).toBe("BRASS 1");
  });

  it("starts over when the synth has moved to another preset", async () => {
    const { link, synth } = fakeSynth(["E.PIANO 1", "BRASS 1"]);
    const a = await tryOnSynth(link, voice("TRY 1"), null);
    if (!a.ok) throw new Error("try failed");
    synth.select(1);
    expect(await putBack(link, a.kept)).toEqual({ ok: false, reason: "moved" });
    expect(name(synth.presets[1]!)).toBe("BRASS 1");
    const b = await tryOnSynth(link, voice("TRY 2"), a.kept);
    if (!b.ok) throw new Error("try failed");
    expect(b.firstTry).toBe(true);
    expect(name(b.kept.original)).toBe("BRASS 1");
  });

  it("won't send without reading the synth first, unless forced", async () => {
    const { link, synth } = fakeSynth(["E.PIANO 1"], { answers: false });
    expect(await tryOnSynth(link, voice("TRY 1"), null, false, 20)).toEqual({ ok: false, reason: "no-read" });
    expect(name(synth.buffer)).toBe("E.PIANO 1");
    await tryOnSynth(link, voice("TRY 1"), null, true, 20);
    expect(name(synth.buffer)).toBe("TRY 1");
    expect(name(synth.presets[0]!)).toBe("E.PIANO 1");
  });
});
