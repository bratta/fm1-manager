// SVG drawings for the editor: the algorithm diagram, envelope editors with
// draggable points, and the keyboard scaling curve. Each editor keeps its
// <svg> element for its whole life and only redraws what's inside it, so a
// drag survives the page refreshing on every change.

import { layout, type Algorithm } from "./algorithms";
import { breakPointNote, noteName, type Operator } from "./patch";
import { levelScaling } from "../synth/engine";
import { envSpeed, envTarget, pitchOctaves, pitchSpeed, scaleOutLevel, segmentCurve } from "../synth/envelope";

const NS = "http://www.w3.org/2000/svg";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const f = (n: number) => n.toFixed(1);

export function svgEl(viewBox: string, cls: string, label: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("class", cls);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  return svg;
}

/** Pointer position in the SVG's own coordinates. */
function local(svg: SVGSVGElement, e: PointerEvent): [number, number] {
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
}

const seconds = (t: number) => (t < 0.0095 ? `${(t * 1000).toFixed(1)} ms` : t < 1 ? `${Math.round(t * 1000)} ms` : t < 10 ? `${t.toFixed(2)} s` : `${t.toFixed(1)} s`);

// --------------------------------------------------------------- algorithm

export interface AlgorithmView {
  selected?: number;
  muted?: number;
  levels?: number[];
  compact?: boolean;
}

const BOX_W = 52;
const BOX_H = 40;
const CELL_W = 76;
const CELL_H = 66;

/** SVG markup for an algorithm diagram. Operator boxes carry data-op. */
export function algorithmSvg(alg: Algorithm, view: AlgorithmView = {}): { markup: string; viewBox: string } {
  const { placed, width, height } = layout(alg);
  const pad = view.compact ? 10 : 22;
  const busGap = view.compact ? 16 : 30;
  const W = width * CELL_W + pad * 2 + 14;
  const H = height * CELL_H + pad + busGap + (view.compact ? 4 : 18);
  const cx = (op: number) => pad + placed[op - 1]!.x * CELL_W + CELL_W / 2;
  const top = (op: number) => pad + (height - 1 - placed[op - 1]!.y) * CELL_H + (CELL_H - BOX_H) / 2;
  const busY = pad + height * CELL_H + busGap - 12;
  const parts: string[] = [];

  for (const [m, t] of alg.edges) {
    const x1 = cx(m), y1 = top(m) + BOX_H, x2 = cx(t), y2 = top(t);
    const mid = y2 - (CELL_H - BOX_H) / 2;
    parts.push(
      x1 === x2
        ? `<path class="alg-wire" d="M${f(x1)} ${f(y1)}V${f(y2)}"/>`
        : `<path class="alg-wire" d="M${f(x1)} ${f(y1)}V${f(mid)}H${f(x2)}V${f(y2)}"/>`,
    );
  }

  const xs = alg.carriers.map(cx);
  for (const c of alg.carriers) parts.push(`<path class="alg-wire alg-out" d="M${f(cx(c))} ${f(top(c) + BOX_H)}V${f(busY)}"/>`);
  parts.push(`<path class="alg-bus" d="M${f(Math.min(...xs) - 10)} ${f(busY)}H${f(Math.max(...xs) + 10)}"/>`);
  if (!view.compact) parts.push(`<text class="alg-out-label" x="${f(Math.max(...xs) + 16)}" y="${f(busY + 4)}">OUT</text>`);

  // Feedback: from the bottom of `from`, round the right-hand side, into the top of `to`.
  const [from, to] = alg.feedback;
  const right = Math.max(cx(from), cx(to)) + BOX_W / 2 + (view.compact ? 7 : 10);
  const fy = top(from) + BOX_H + 7;
  const ty = top(to) - 7;
  parts.push(
    `<path class="alg-fb" d="M${f(cx(from))} ${f(top(from) + BOX_H)}V${f(fy)}H${f(right)}V${f(ty)}H${f(cx(to))}V${f(top(to))}"/>`,
  );

  for (const { op } of placed) {
    const x = cx(op) - BOX_W / 2, y = top(op);
    const carrier = alg.carriers.includes(op);
    const cls = [
      "alg-op",
      carrier ? "carrier" : "modulator",
      view.selected === op ? "selected" : "",
      view.muted && (view.muted >> (op - 1)) & 1 ? "muted" : "",
    ].join(" ");
    const level = view.levels?.[op - 1];
    parts.push(
      `<g class="${cls}" data-op="${op}"${view.compact ? "" : ` tabindex="0" role="button" aria-label="Operator ${op}, ${carrier ? "carrier" : "modulator"}"`}>` +
        `<rect x="${f(x)}" y="${f(y)}" width="${BOX_W}" height="${BOX_H}" rx="8"/>` +
        `<text x="${f(x + BOX_W / 2)}" y="${f(y + BOX_H / 2 + (view.compact ? 6 : 5))}" class="alg-num">${op}</text>` +
        (level !== undefined && !view.compact
          ? `<rect class="alg-level-bg" x="${f(x + 8)}" y="${f(y + BOX_H - 7)}" width="${BOX_W - 16}" height="3" rx="1.5"/>` +
            `<rect class="alg-level" x="${f(x + 8)}" y="${f(y + BOX_H - 7)}" width="${f(((BOX_W - 16) * level) / 99)}" height="3" rx="1.5"/>`
          : "") +
        `</g>`,
    );
  }
  return { markup: parts.join(""), viewBox: `0 0 ${f(W)} ${f(H)}` };
}

// --------------------------------------------------------- envelope editor

export interface EnvelopeModel {
  rates(): readonly number[];
  levels(): readonly number[];
  set(kind: "rate" | "level", stage: number, value: number): void;
}

const EW = 600;
const EH = 210;
const PAD_L = 14;
const PAD_R = 14;
const PAD_T = 26;
const PAD_B = 30;
const SUSTAIN_W = 70;
const PLOT_H = EH - PAD_T - PAD_B;
const AVAIL = EW - PAD_L - PAD_R - SUSTAIN_W;
const MAX_L = 3840;
const MIN_L = 16;
const FULL_OUT = 127 << 5;
/** Display width of a segment, from its duration: roughly logarithmic so 5 ms and 20 s both fit. */
const widthOf = (t: number) => 26 + 15 * Math.log2(1 + t / 0.004);

interface Seg {
  t: number;
  pts: [number, number][];
}

abstract class EnvEditorBase {
  readonly svg: SVGSVGElement;
  private drag: { stage: number; x0: number; scale: number; startX: number } | null = null;
  protected hover = -1;

  constructor(
    protected readonly model: EnvelopeModel,
    label: string,
    private readonly onDragEnd: () => void,
  ) {
    this.svg = svgEl(`0 0 ${EW} ${EH}`, "env", label);
    this.svg.addEventListener("pointerdown", (e) => this.down(e));
    this.svg.addEventListener("pointermove", (e) => this.move(e));
    this.svg.addEventListener("pointerup", (e) => this.up(e));
    this.svg.addEventListener("pointercancel", (e) => this.up(e));
    this.svg.addEventListener("pointerleave", () => {
      if (!this.drag && this.hover !== -1) (this.hover = -1), this.render();
    });
  }

  /** Levels in display units (0 bottom .. 1 top) for the start and the four stages. */
  protected abstract y01(level: number): number;
  protected abstract levelFromY01(v: number): number;
  protected abstract segments(rates: readonly number[], levels: readonly number[]): Seg[];
  protected abstract describe(stage: number, seg: Seg): string;

  private geometry() {
    const segs = this.segments(this.model.rates(), this.model.levels());
    const widths = segs.map((s) => widthOf(s.t));
    const total = widths.reduce((a, b) => a + b, 0);
    const scale = total > AVAIL ? AVAIL / total : 1;
    // Where each segment starts and ends; the key-held stretch sits between 3 and 4.
    const starts: number[] = [];
    const ends: number[] = [];
    let x = PAD_L;
    widths.forEach((w, i) => {
      if (i === 3) x += SUSTAIN_W;
      starts.push(x);
      x += w * scale;
      ends.push(x);
    });
    return { segs, scale, ends, starts };
  }

  private yOf(v01: number) {
    return PAD_T + (1 - v01) * PLOT_H;
  }

  render() {
    const levels = this.model.levels();
    const { segs, ends, starts } = this.geometry();
    const path: string[] = [];
    segs.forEach((s, i) => {
      const x0 = starts[i]!;
      const span = ends[i]! - x0;
      s.pts.forEach(([t, lv], k) => {
        const x = x0 + (s.t > 0 ? (t / s.t) * span : k ? span : 0);
        path.push(`${path.length ? "L" : "M"}${f(x)} ${f(this.yOf(lv))}`);
      });
    });
    const line = path.join("");
    const sustainX = ends[2]!;
    const parts = [
      `<rect class="env-sustain" x="${f(sustainX)}" y="${PAD_T}" width="${SUSTAIN_W}" height="${PLOT_H}"/>`,
      `<text class="env-note" x="${f(sustainX + SUSTAIN_W / 2)}" y="${PAD_T + 14}">key held</text>`,
      `<text class="env-note" x="${f(starts[3]! + 6)}" y="${EH - 10}" text-anchor="start">released</text>`,
      `<path class="env-axis" d="M${PAD_L} ${PAD_T + PLOT_H}H${EW - PAD_R}"/>`,
      this.extra(),
      `<path class="env-fill" d="${line}L${f(ends[3]!)} ${PAD_T + PLOT_H}L${PAD_L} ${PAD_T + PLOT_H}Z"/>`,
      `<path class="env-line" d="${line}"/>`,
    ];
    for (let i = 0; i < 4; i++) {
      const x = ends[i]!;
      const y = this.yOf(this.y01(levels[i]!));
      const on = this.drag?.stage === i || this.hover === i;
      parts.push(
        `<g class="env-pt${on ? " on" : ""}"><circle cx="${f(x)}" cy="${f(y)}" r="${on ? 9 : 7}"/>` +
          `<text x="${f(x)}" y="${f(y + 3.5)}">${i + 1}</text></g>`,
      );
    }
    const focus = this.drag?.stage ?? this.hover;
    if (focus >= 0) {
      parts.push(`<text class="env-readout" x="${EW - PAD_R}" y="16">${esc(this.describe(focus, segs[focus]!))}</text>`);
    } else {
      parts.push(`<text class="env-readout dim" x="${EW - PAD_R}" y="16">Drag a point: up/down for level, left/right for time</text>`);
    }
    this.svg.innerHTML = parts.join("");
  }

  protected extra() {
    return "";
  }

  private nearest(x: number, y: number): number {
    const levels = this.model.levels();
    const { ends } = this.geometry();
    let best = -1;
    let bestD = 30 * 30;
    for (let i = 0; i < 4; i++) {
      const dx = ends[i]! - x;
      const dy = this.yOf(this.y01(levels[i]!)) - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) (bestD = d), (best = i);
    }
    return best;
  }

  private down(e: PointerEvent) {
    const [x, y] = local(this.svg, e);
    const stage = this.nearest(x, y);
    if (stage < 0) return;
    const g = this.geometry();
    this.drag = { stage, x0: x, scale: g.scale, startX: g.starts[stage]! };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.render();
  }

  private move(e: PointerEvent) {
    const [x, y] = local(this.svg, e);
    if (!this.drag) {
      const h = this.nearest(x, y);
      if (h !== this.hover) (this.hover = h), this.render();
      return;
    }
    const { stage, scale, startX } = this.drag;
    const v01 = Math.max(0, Math.min(1, 1 - (y - PAD_T) / PLOT_H));
    const level = this.levelFromY01(v01);
    if (level !== this.model.levels()[stage]) this.model.set("level", stage, level);

    // Pick the rate whose segment ends closest to the pointer.
    const want = (x - startX) / scale;
    const rates = [...this.model.rates()];
    const levels = this.model.levels();
    let best = rates[stage]!;
    let bestD = Infinity;
    for (let r = 0; r <= 99; r++) {
      rates[stage] = r;
      const d = Math.abs(widthOf(this.segments(rates, levels)[stage]!.t) - want);
      if (d < bestD) (bestD = d), (best = r);
    }
    if (best !== this.model.rates()[stage]) this.model.set("rate", stage, best);
    this.render();
  }

  private up(e: PointerEvent) {
    if (!this.drag) return;
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    this.render();
    this.onDragEnd();
  }
}

/** The amplitude envelope of an operator. */
export class AmpEnvEditor extends EnvEditorBase {
  protected y01(level: number) {
    return (envTarget(level, FULL_OUT) - MIN_L) / (MAX_L - MIN_L);
  }

  protected levelFromY01(v: number) {
    const want = MIN_L + v * (MAX_L - MIN_L);
    let best = 0;
    for (let l = 0; l <= 99; l++) if (Math.abs(envTarget(l, FULL_OUT) - want) < Math.abs(envTarget(best, FULL_OUT) - want)) best = l;
    return best;
  }

  protected segments(rates: readonly number[], levels: readonly number[]): Seg[] {
    const targets = levels.map((l) => envTarget(l, FULL_OUT));
    const from = [targets[3]!, targets[0]!, targets[1]!, targets[2]!];
    return from.map((a, i) => {
      const pts = segmentCurve(a, targets[i]!, envSpeed(rates[i]!, 0));
      return { t: pts.at(-1)![0], pts: pts.map(([t, l]) => [t, (l - MIN_L) / (MAX_L - MIN_L)] as [number, number]) };
    });
  }

  protected describe(stage: number, seg: Seg) {
    const names = ["Attack", "Decay 1", "Decay 2 → sustain", "Release"];
    return `${names[stage]}: rate ${this.model.rates()[stage]}, level ${this.model.levels()[stage]} · ${seconds(seg.t)}`;
  }
}

/** The voice's pitch envelope: 50 is no change, up to four octaves either way. */
export class PitchEnvEditor extends EnvEditorBase {
  protected y01(level: number) {
    return level / 99;
  }

  protected levelFromY01(v: number) {
    return Math.round(v * 99);
  }

  protected segments(rates: readonly number[], levels: readonly number[]): Seg[] {
    const from = [levels[3]!, levels[0]!, levels[1]!, levels[2]!];
    return from.map((a, i) => {
      const t = Math.abs(pitchOctaves(levels[i]!) - pitchOctaves(a)) / pitchSpeed(rates[i]!);
      return { t, pts: [[0, a / 99], [t, levels[i]! / 99]] };
    });
  }

  protected extra() {
    const y = PAD_T + (1 - 50 / 99) * PLOT_H;
    return `<path class="env-axis dashed" d="M${PAD_L} ${f(y)}H${EW - PAD_R}"/>`;
  }

  protected describe(stage: number, seg: Seg) {
    const l = this.model.levels()[stage]!;
    const semis = pitchOctaves(l) * 12;
    const shift = Math.abs(semis) < 0.05 ? "no shift" : `${semis > 0 ? "+" : "−"}${Math.abs(semis).toFixed(Math.abs(semis) < 10 ? 1 : 0)} semitones`;
    return `Stage ${stage + 1}: rate ${this.model.rates()[stage]}, level ${l} (${shift}) · ${seconds(seg.t)}`;
  }
}

/** A small read-only envelope for the operator tiles. */
export function miniEnvMarkup(op: Operator, w = 120, h = 34): string {
  const t = op.levels.map((l) => envTarget(l, FULL_OUT));
  const from = [t[3]!, t[0]!, t[1]!, t[2]!];
  const segs = from.map((a, i) => segmentCurve(a, t[i]!, envSpeed(op.rates[i]!, 0)));
  const widths = segs.map((s) => widthOf(s.at(-1)![0]));
  const sus = 18;
  const scale = (w - 4 - sus) / Math.max(widths.reduce((a, b) => a + b, 0), (w - 4 - sus) * 0.6);
  const y = (l: number) => 2 + (1 - (l - MIN_L) / (MAX_L - MIN_L)) * (h - 4);
  let x = 2;
  const d: string[] = [];
  segs.forEach((s, i) => {
    const total = s.at(-1)![0];
    const span = widths[i]! * scale;
    s.forEach(([tt, l], k) => d.push(`${d.length ? "L" : "M"}${f(x + (total > 0 ? (tt / total) * span : k ? span : 0))} ${f(y(l))}`));
    x += span;
    if (i === 2) (x += sus), d.push(`L${f(x)} ${f(y(t[2]!))}`);
  });
  return `<svg viewBox="0 0 ${w} ${h}" class="mini-env" aria-hidden="true"><path d="${d.join("")}"/></svg>`;
}

// ------------------------------------------------------ keyboard scaling

/** The operator's effective output level across the keyboard, with its break point. */
export function scalingMarkup(op: Operator): string {
  const w = 280, h = 92, lo = 21, hi = 120;
  const x = (n: number) => 6 + ((n - lo) / (hi - lo)) * (w - 12);
  const y = (lvl: number) => 6 + (1 - lvl / 127) * (h - 24);
  const base = scaleOutLevel(op.outputLevel);
  const d: string[] = [];
  for (let n = lo; n <= hi; n++) {
    const lvl = Math.max(0, Math.min(127, base + levelScaling(op, n)));
    d.push(`${n === lo ? "M" : "L"}${f(x(n))} ${f(y(lvl))}`);
  }
  const bp = breakPointNote(op.breakPoint);
  const keys: string[] = [];
  for (let n = lo; n <= hi; n++) {
    if ([1, 3, 6, 8, 10].includes(n % 12)) continue;
    keys.push(`<rect x="${f(x(n) - 1)}" y="${h - 14}" width="${f(((w - 12) / (hi - lo)) * 1.5)}" height="10" class="kbd-w"/>`);
  }
  return (
    `<svg viewBox="0 0 ${w} ${h}" class="scaling" role="img" aria-label="Output level across the keyboard, break point ${noteName(bp)}">` +
    keys.join("") +
    `<path class="env-axis dashed" d="M${f(x(bp))} 4V${h - 16}"/>` +
    `<text class="env-note" x="${f(Math.min(w - 20, Math.max(20, x(bp))))}" y="${h - 18}">${noteName(bp)}</text>` +
    `<path class="env-line" d="${d.join("")}"/>` +
    `</svg>`
  );
}
