import { describe, expect, it } from "vitest";
import { backupAllPresets, BackupError, DEFAULT_BACKUP } from "../src/backup";
import type { SysexLink } from "../src/midi/link";
import { buildFrame, parseFrame } from "../src/protocol/vendor";
import { vcedName } from "../src/protocol/dx7";

const FAST = { ...DEFAULT_BACKUP, settleMs: 0, readTimeoutMs: 20 };

function voice(n: number): Uint8Array {
  const v = new Uint8Array(155);
  v[0] = n % 100;
  v.set(Array.from(`PRESET ${String(n + 1).padStart(3, "0")}`, (c) => c.charCodeAt(0)), 145);
  return v;
}

/** A synth that selects presets on Program Change and answers voice reads. */
function fakeSynth({ honoursProgramChange = true, channel = 0 } = {}) {
  let current = 0;
  const outbox: Uint8Array[] = [];
  const link: SysexLink = {
    name: "FM-1 Midi",
    send(msg) {
      if ((msg[0]! & 0xf0) === 0xc0) {
        if (honoursProgramChange && (msg[0]! & 0x0f) === channel) current = msg[1]!;
      } else if (parseFrame(msg)?.type === 0x23) {
        outbox.push(buildFrame(0x23, [5, 0, 0, 0, 0, 155, 0, 0, ...voice(current)]));
      }
    },
    receive: async () => outbox.shift() ?? null,
    drain: () => (outbox.length = 0),
    close: () => {},
  };
  return link;
}

describe("backing up all presets", () => {
  it("reads all 128 presets in order", async () => {
    const seen: number[] = [];
    const voices = await backupAllPresets(fakeSynth(), { ...FAST, progress: (n) => seen.push(n) });
    expect(voices).toHaveLength(128);
    expect(vcedName(voices[0]!)).toBe("PRESET 001");
    expect(vcedName(voices[127]!)).toBe("PRESET 128");
    expect(seen.at(-1)).toBe(128);
  });

  it("sends Program Change on the chosen channel", async () => {
    const voices = await backupAllPresets(fakeSynth({ channel: 4 }), { ...FAST, channel: 5 });
    expect(vcedName(voices[64]!)).toBe("PRESET 065");
  });

  it("stops early when the synth ignores Program Change", async () => {
    await expect(backupAllPresets(fakeSynth({ honoursProgramChange: false }), FAST)).rejects.toThrow(/switching presets/);
  });

  it("can be cancelled", async () => {
    const ctrl = new AbortController();
    const run = backupAllPresets(fakeSynth(), { ...FAST, signal: ctrl.signal, progress: (n) => n === 10 && ctrl.abort() });
    await expect(run).rejects.toBeInstanceOf(BackupError);
  });
});
