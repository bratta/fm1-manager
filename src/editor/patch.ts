// An editable DX7 voice. The synth stores voices in the packed 128-byte VMEM
// form and the editor works on the unpacked 155-byte VCED form, which has one
// byte per parameter. This module turns VCED bytes into named fields and back.
//
// VCED stores operator 6 first; here ops[0] is OP1, as printed on the synth.

import { initVoice, VCED_LENGTH, vmemToVced } from "../protocol/dx7";

export interface Operator {
  rates: [number, number, number, number];
  levels: [number, number, number, number];
  breakPoint: number;
  leftDepth: number;
  rightDepth: number;
  /** 0 -LIN, 1 -EXP, 2 +EXP, 3 +LIN */
  leftCurve: number;
  rightCurve: number;
  rateScaling: number;
  ampModSens: number;
  velocitySens: number;
  outputLevel: number;
  /** false: frequency is a ratio of the note; true: fixed in Hz */
  fixed: boolean;
  coarse: number;
  fine: number;
  /** 0-14, 7 is centre */
  detune: number;
}

export interface Lfo {
  speed: number;
  delay: number;
  pitchDepth: number;
  ampDepth: number;
  keySync: boolean;
  /** 0 triangle, 1 saw down, 2 saw up, 3 square, 4 sine, 5 sample & hold */
  wave: number;
  pitchSens: number;
}

export interface Voice {
  ops: Operator[];
  pitchRates: [number, number, number, number];
  pitchLevels: [number, number, number, number];
  /** 1-32 */
  algorithm: number;
  feedback: number;
  oscSync: boolean;
  lfo: Lfo;
  /** 0-48, 24 is no transpose (C3) */
  transpose: number;
  name: string;
}

const OP_SIZE = 21;
const quad = (b: Uint8Array, at: number) => [b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!] as [number, number, number, number];
const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v) || 0));

export function voiceFromVced(vced: Uint8Array): Voice {
  if (vced.length !== VCED_LENGTH) throw new RangeError(`VCED voice must be ${VCED_LENGTH} bytes`);
  const ops = Array.from({ length: 6 }, (_, i): Operator => {
    const s = (5 - i) * OP_SIZE;
    const b = (k: number) => vced[s + k]!;
    return {
      rates: quad(vced, s),
      levels: quad(vced, s + 4),
      breakPoint: b(8),
      leftDepth: b(9),
      rightDepth: b(10),
      leftCurve: b(11),
      rightCurve: b(12),
      rateScaling: b(13),
      ampModSens: b(14),
      velocitySens: b(15),
      outputLevel: b(16),
      fixed: b(17) === 1,
      coarse: b(18),
      fine: b(19),
      detune: b(20),
    };
  });
  return sanitize({
    ops,
    pitchRates: quad(vced, 126),
    pitchLevels: quad(vced, 130),
    algorithm: vced[134]! + 1,
    feedback: vced[135]!,
    oscSync: vced[136] === 1,
    lfo: {
      speed: vced[137]!,
      delay: vced[138]!,
      pitchDepth: vced[139]!,
      ampDepth: vced[140]!,
      keySync: vced[141] === 1,
      wave: vced[142]!,
      pitchSens: vced[143]!,
    },
    transpose: vced[144]!,
    name: String.fromCharCode(...Array.from(vced.subarray(145, 155), (c) => (c >= 0x20 && c < 0x7f ? c : 0x20))),
  });
}

export function voiceToVced(v: Voice): Uint8Array {
  const out = new Uint8Array(VCED_LENGTH);
  v.ops.forEach((op, i) => {
    const s = (5 - i) * OP_SIZE;
    out.set(op.rates, s);
    out.set(op.levels, s + 4);
    out.set(
      [
        op.breakPoint, op.leftDepth, op.rightDepth, op.leftCurve, op.rightCurve, op.rateScaling, op.ampModSens,
        op.velocitySens, op.outputLevel, op.fixed ? 1 : 0, op.coarse, op.fine, op.detune,
      ],
      s + 8,
    );
  });
  out.set(v.pitchRates, 126);
  out.set(v.pitchLevels, 130);
  const l = v.lfo;
  out.set(
    [v.algorithm - 1, v.feedback, v.oscSync ? 1 : 0, l.speed, l.delay, l.pitchDepth, l.ampDepth, l.keySync ? 1 : 0, l.wave, l.pitchSens, v.transpose],
    134,
  );
  out.set(Array.from(v.name.padEnd(10).slice(0, 10), (c) => (c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7f ? c.charCodeAt(0) : 0x20)), 145);
  return out;
}

/** Clamp every field into its legal DX7 range, so stray bytes in old banks can't upset the editor. */
export function sanitize(v: Voice): Voice {
  const q4 = (a: number[]) => a.map((x) => clamp(x, 99)) as [number, number, number, number];
  return {
    ops: v.ops.map((op) => ({
      rates: q4(op.rates),
      levels: q4(op.levels),
      breakPoint: clamp(op.breakPoint, 99),
      leftDepth: clamp(op.leftDepth, 99),
      rightDepth: clamp(op.rightDepth, 99),
      leftCurve: clamp(op.leftCurve, 3),
      rightCurve: clamp(op.rightCurve, 3),
      rateScaling: clamp(op.rateScaling, 7),
      ampModSens: clamp(op.ampModSens, 3),
      velocitySens: clamp(op.velocitySens, 7),
      outputLevel: clamp(op.outputLevel, 99),
      fixed: op.fixed,
      coarse: clamp(op.coarse, 31),
      fine: clamp(op.fine, 99),
      detune: clamp(op.detune, 14),
    })),
    pitchRates: q4(v.pitchRates),
    pitchLevels: q4(v.pitchLevels),
    algorithm: Math.max(1, Math.min(32, Math.round(v.algorithm) || 1)),
    feedback: clamp(v.feedback, 7),
    oscSync: v.oscSync,
    lfo: {
      speed: clamp(v.lfo.speed, 99),
      delay: clamp(v.lfo.delay, 99),
      pitchDepth: clamp(v.lfo.pitchDepth, 99),
      ampDepth: clamp(v.lfo.ampDepth, 99),
      keySync: v.lfo.keySync,
      wave: clamp(v.lfo.wave, 5),
      pitchSens: clamp(v.lfo.pitchSens, 7),
    },
    transpose: clamp(v.transpose, 48),
    name: v.name,
  };
}

export const initPatch = (): Voice => voiceFromVced(vmemToVced(initVoice()));

/** A fresh operator as in the DX7's INIT VOICE, but silent. */
export const initOperator = (): Operator => ({ ...structuredClone(initPatch().ops[1]!) });

export const cloneVoice = (v: Voice): Voice => structuredClone(v);

// ----------------------------------------------------------------- display

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** Yamaha octave numbering: MIDI 60 is C3. */
export const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 2}`;
/** Keyboard level scaling break point 0 is A-1 (MIDI 21). */
export const breakPointNote = (bp: number) => bp + 21;
export const CURVES = ["−LIN", "−EXP", "+EXP", "+LIN"];
export const LFO_WAVES = ["Triangle", "Saw down", "Saw up", "Square", "Sine", "Sample & hold"];

export const ratioOf = (op: Pick<Operator, "coarse" | "fine">) => (op.coarse === 0 ? 0.5 : op.coarse) * (1 + op.fine / 100);
export const fixedHz = (op: Pick<Operator, "coarse" | "fine">) => 10 ** ((op.coarse & 3) + op.fine / 100);

export function frequencyLabel(op: Operator): string {
  if (!op.fixed) return `×${ratioOf(op).toFixed(2)}`;
  const hz = fixedHz(op);
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${hz.toFixed(hz >= 100 ? 0 : hz >= 10 ? 1 : 2)} Hz`;
}

export const detuneLabel = (d: number) => (d === 7 ? "0" : d > 7 ? `+${d - 7}` : `−${7 - d}`);
export const transposeLabel = (t: number) => noteName(t + 36);
