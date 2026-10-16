// DX7 envelope math, after the msfa engine used in Dexed (Apache 2.0,
// Google). Levels are on a log scale of 256 steps per octave (6 dB), so a
// level of 3840 is full output and each step of a 0-99 parameter is 0.75 dB.
// The editor's envelope graphs use the same functions as the sound engine.

const LEVEL_LUT = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];

/** 0-99 level parameter to the DX7's internal 0-127 scale. */
export const scaleOutLevel = (level: number) => (level >= 20 ? 28 + level : LEVEL_LUT[level] ?? 0);

/** Log level of an envelope stage, given the operator's scaled output level. */
export function envTarget(level: number, outLevel: number): number {
  const l = ((scaleOutLevel(level) >> 1) << 6) + outLevel - 4256;
  return l < 16 ? 16 : l;
}

/** Envelope rate (0-99) plus keyboard rate scaling to a speed in log-level units per second. */
export function envSpeed(rate: number, rateScaling: number): number {
  const q = Math.min(63, ((rate * 41) >> 6) + rateScaling);
  return (4 + (q & 3)) * 2 ** ((q >> 2) - 14) * 44100;
}

/** Rising segments jump straight to this level, then slow down as they approach full. */
const ATTACK_JUMP = 1716;
const attackMul = (level: number) => Math.floor(17 - level / 256);

/** Seconds a segment takes from `from` to `to` at `speed`. */
export function segmentSeconds(from: number, to: number, speed: number): number {
  if (to <= from) return (from - to) / speed;
  let t = 0;
  let l = Math.max(from, ATTACK_JUMP);
  while (l < to) {
    const next = Math.min(to, (Math.floor(l / 256) + 1) * 256);
    t += (next - l) / (attackMul((l + next) / 2) * speed);
    l = next;
  }
  return t;
}

/** Points [seconds, level] tracing a segment, exact for this model. */
export function segmentCurve(from: number, to: number, speed: number): [number, number][] {
  if (to <= from) return [[0, from], [(from - to) / speed, to]];
  const pts: [number, number][] = [[0, from]];
  let t = 0;
  let l = Math.max(from, ATTACK_JUMP);
  if (l !== from) pts.push([0, l]);
  while (l < to) {
    const next = Math.min(to, (Math.floor(l / 256) + 1) * 256);
    t += (next - l) / (attackMul((l + next) / 2) * speed);
    l = next;
    pts.push([t, l]);
  }
  return pts;
}

/** One operator's envelope generator, stepped once per sample. */
export class Envelope {
  level = 0;
  private target = 0;
  private rising = false;
  private inc = 0;
  /** 0-3 while moving through the four stages, 4 when finished. */
  stage = 0;
  down = true;
  private rates: readonly number[] = [99, 99, 99, 99];
  private levels: readonly number[] = [99, 99, 99, 0];
  private outLevel = 0;
  private rateScaling = 0;

  constructor(private readonly sampleRate: number) {}

  start(rates: readonly number[], levels: readonly number[], outLevel: number, rateScaling: number) {
    this.rates = rates;
    this.levels = levels;
    this.outLevel = outLevel;
    this.rateScaling = rateScaling;
    // An idle DX7 envelope rests at L4, so a note starts from there.
    this.level = envTarget(levels[3]!, outLevel);
    this.down = true;
    this.advance(0);
  }

  /** New parameters while a note is sounding: keep the current level, retarget the current stage. */
  update(rates: readonly number[], levels: readonly number[], outLevel: number, rateScaling: number) {
    this.rates = rates;
    this.levels = levels;
    this.outLevel = outLevel;
    this.rateScaling = rateScaling;
    if (this.stage < 4) this.advance(this.stage);
  }

  release() {
    if (!this.down) return;
    this.down = false;
    this.advance(3);
  }

  private advance(stage: number) {
    this.stage = stage;
    if (stage >= 4) return;
    this.target = envTarget(this.levels[stage]!, this.outLevel);
    this.rising = this.target > this.level;
    this.inc = envSpeed(this.rates[stage]!, this.rateScaling) / this.sampleRate;
  }

  next(): number {
    if (this.stage < 3 || (this.stage < 4 && !this.down)) {
      if (this.rising) {
        if (this.level < ATTACK_JUMP) this.level = ATTACK_JUMP;
        this.level += attackMul(this.level) * this.inc;
        if (this.level >= this.target) {
          this.level = this.target;
          this.advance(this.stage + 1);
        }
      } else {
        this.level -= this.inc;
        if (this.level <= this.target) {
          this.level = this.target;
          this.advance(this.stage + 1);
        }
      }
    }
    return this.level;
  }
}

// ------------------------------------------------------------ pitch envelope

/** Pitch envelope level (0-99, 50 is no change) to octaves. */
const PITCH_LEVELS = [
  -128, -116, -104, -95, -85, -76, -68, -61, -56, -52, -49, -46, -43, -41, -39, -37, -35, -33, -32, -31, -30, -29, -28, -27,
  -26, -25, -24, -23, -22, -21, -20, -19, -18, -17, -16, -15, -14, -13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
  34, 35, 38, 40, 43, 46, 49, 53, 58, 65, 73, 82, 92, 103, 115, 127,
];
const PITCH_RATES = [
  1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 30, 31, 33, 34, 36, 37, 38, 39, 41, 42, 44, 46, 47, 49, 51, 53, 54, 56, 58, 60, 62, 64, 66, 68,
  70, 72, 74, 76, 79, 82, 85, 88, 91, 94, 98, 102, 106, 110, 115, 120, 125, 130, 135, 141, 147, 153, 159, 165, 171, 178, 185,
  193, 202, 211, 232, 243, 254, 255,
];

export const pitchOctaves = (level: number) => (PITCH_LEVELS[level] ?? 0) / 32;
/** Octaves per second. */
export const pitchSpeed = (rate: number) => (PITCH_RATES[rate] ?? 1) / 21.3;

export class PitchEnvelope {
  value = 0;
  private target = 0;
  private inc = 0;
  stage = 0;
  private down = true;
  private rates: readonly number[] = [99, 99, 99, 99];
  private levels: readonly number[] = [50, 50, 50, 50];

  constructor(private readonly sampleRate: number) {}

  start(rates: readonly number[], levels: readonly number[]) {
    this.rates = rates;
    this.levels = levels;
    this.value = pitchOctaves(levels[3]!);
    this.down = true;
    this.advance(0);
  }

  update(rates: readonly number[], levels: readonly number[]) {
    this.rates = rates;
    this.levels = levels;
    if (this.stage < 4) this.advance(this.stage);
  }

  release() {
    if (!this.down) return;
    this.down = false;
    this.advance(3);
  }

  private advance(stage: number) {
    this.stage = stage;
    if (stage >= 4) return;
    this.target = pitchOctaves(this.levels[stage]!);
    this.inc = pitchSpeed(this.rates[stage]!) / this.sampleRate;
  }

  next(): number {
    if (this.stage < 3 || (this.stage < 4 && !this.down)) {
      if (this.target > this.value) {
        this.value = Math.min(this.target, this.value + this.inc);
      } else {
        this.value = Math.max(this.target, this.value - this.inc);
      }
      if (this.value === this.target) this.advance(this.stage + 1);
    }
    return this.value;
  }
}
