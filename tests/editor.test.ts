import { describe, expect, it } from "vitest";
import { ALGORITHMS, layout, modulatorsOf, targetsOf } from "../src/editor/algorithms";
import { frequencyLabel, initPatch, voiceFromVced, voiceToVced } from "../src/editor/patch";
import { initVoice, vmemToVced } from "../src/protocol/dx7";
import { FmEngine, lfoHz, operatorHz } from "../src/synth/engine";
import { Envelope, envSpeed, envTarget, segmentSeconds } from "../src/synth/envelope";

function sampleVced(): Uint8Array {
  const v = new Uint8Array(155);
  const ranges = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14];
  for (let op = 0; op < 6; op++) ranges.forEach((max, k) => (v[op * 21 + k] = (op * 7 + k * 5) % (max + 1)));
  [99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99, 99, 99, 99, 1, 5, 7, 48].forEach((max, k) => (v[126 + k] = (k * 11 + 3) % (max + 1)));
  v.set(Array.from("BRASS  1  ", (c) => c.charCodeAt(0)), 145);
  return v;
}

describe("patch model", () => {
  it("VCED -> Voice -> VCED is lossless", () => {
    const vced = sampleVced();
    expect(voiceToVced(voiceFromVced(vced))).toEqual(vced);
  });

  it("puts OP1 first (VCED stores OP6 first)", () => {
    const v = initPatch();
    expect(v.ops[0]!.outputLevel).toBe(99);
    expect(v.ops.slice(1).every((op) => op.outputLevel === 0)).toBe(true);
    expect(v.algorithm).toBe(1);
    expect(v.name).toBe("INIT VOICE");
    expect(voiceToVced(v)).toEqual(vmemToVced(initVoice()));
  });

  it("labels frequencies", () => {
    const op = initPatch().ops[0]!;
    expect(frequencyLabel(op)).toBe("×1.00");
    expect(frequencyLabel({ ...op, coarse: 0 })).toBe("×0.50");
    expect(frequencyLabel({ ...op, fixed: true, coarse: 2, fine: 64 })).toBe("437 Hz");
  });
});

describe("algorithms", () => {
  it("has 32 well-formed algorithms", () => {
    expect(ALGORITHMS).toHaveLength(32);
    ALGORITHMS.forEach((a) => {
      for (const [m, t] of a.edges) expect(m).toBeGreaterThan(t);
      for (let op = 1; op <= 6; op++) {
        // every operator is either heard or modulates something, never both
        expect(a.carriers.includes(op)).toBe(targetsOf(a, op).length === 0);
      }
    });
    expect(modulatorsOf(ALGORITHMS[15]!, 1).sort()).toEqual([2, 3, 5]);
  });

  it("lays every algorithm out without overlaps", () => {
    ALGORITHMS.forEach((a, i) => {
      const { placed } = layout(a);
      expect(placed, `algorithm ${i + 1}`).toHaveLength(6);
      const keys = new Set(placed.map((p) => `${p.x},${p.y}`));
      expect(keys.size, `algorithm ${i + 1}`).toBe(6);
      for (const [m, t] of a.edges) {
        expect(placed[m - 1]!.y).toBeGreaterThan(placed[t - 1]!.y);
      }
    });
  });
});

describe("envelopes", () => {
  it("the analytic segment time matches the sample-by-sample envelope", () => {
    const sr = 8000;
    for (const [rate, level] of [[50, 99], [70, 80], [30, 99]] as const) {
      const env = new Envelope(sr);
      env.start([rate, 99, 99, 99], [level, level, level, 0], 127 << 5, 0);
      let n = 0;
      while (env.stage === 0 && n < sr * 120) env.next(), n++;
      const expected = segmentSeconds(0, envTarget(level, 127 << 5), envSpeed(rate, 0));
      expect(n / sr).toBeCloseTo(expected, 1);
    }
  });
});

describe("FM engine", () => {
  const sr = 48000;
  const render = (engine: FmEngine, seconds: number) => {
    const out = new Float32Array(Math.round(sr * seconds));
    for (let i = 0; i < out.length; i += 128) engine.render(out.subarray(i, i + 128));
    return out;
  };
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  const crossings = (a: Float32Array) => a.reduce((n, x, i) => n + (i > 0 && a[i - 1]! < 0 && x >= 0 ? 1 : 0), 0);

  it("plays the init voice as a sine at the note's pitch", () => {
    const engine = new FmEngine(sr);
    engine.setVoice(initPatch());
    engine.noteOn(69, 100);
    const out = render(engine, 1);
    expect(rms(out)).toBeGreaterThan(0.05);
    expect(crossings(out)).toBeGreaterThan(437);
    expect(crossings(out)).toBeLessThan(443);
  });

  it("goes quiet and frees the note after release", () => {
    const engine = new FmEngine(sr);
    engine.setVoice(initPatch());
    engine.noteOn(60, 100);
    render(engine, 0.2);
    engine.noteOff(60);
    render(engine, 0.5);
    expect(rms(render(engine, 0.1))).toBeLessThan(1e-4);
    expect(engine.activeNotes).toBe(0);
  });

  it("holds notes while sustain is on", () => {
    const engine = new FmEngine(sr);
    engine.setVoice(initPatch());
    engine.setSustain(true);
    engine.noteOn(60, 100);
    engine.noteOff(60);
    render(engine, 0.5);
    expect(rms(render(engine, 0.1))).toBeGreaterThan(0.05);
    engine.setSustain(false);
    render(engine, 0.5);
    expect(engine.activeNotes).toBe(0);
  });

  it("modulation adds harmonics, and muting the modulator removes them", () => {
    const v = initPatch();
    v.ops[1]!.outputLevel = 90; // OP2 modulates OP1 in algorithm 1
    const engine = new FmEngine(sr);
    engine.setVoice(v);
    engine.noteOn(45, 100);
    const modulated = crossings(render(engine, 0.5));
    engine.setMuted(0b10);
    const plain = crossings(render(engine, 0.5));
    expect(plain).toBeLessThan(60);
    expect(modulated).toBeGreaterThan(plain * 1.5);
  });

  it("fixed frequency operators ignore the key", () => {
    const op = { ...initPatch().ops[0]!, fixed: true, coarse: 2, fine: 0 };
    expect(operatorHz(op, 40)).toBeCloseTo(100, 6);
    expect(operatorHz(op, 90)).toBeCloseTo(100, 6);
    expect(operatorHz({ ...op, fixed: false, coarse: 2 }, 69)).toBeCloseTo(880, 6);
  });

  it("LFO speeds span the DX7's range", () => {
    expect(lfoHz(0)).toBeCloseTo(0.065, 2);
    expect(lfoHz(99)).toBeGreaterThan(20);
  });
});
