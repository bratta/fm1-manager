// The Editor tab: build or change a DX7 voice, hear it in the browser, and
// save it into a bank of the library.

import { BANKS, type Bank, type BankId } from "../library";
import type { SysexLink } from "../midi/link";
import { buildSingleVoiceSysex, parseBankSysex, parseSingleVoiceSysex, splitSysex, vcedName, vcedToVmem, vmemName, vmemToVced } from "../protocol/dx7";
import { lfoHz } from "../synth/engine";
import { Preview } from "../synth/preview";
import { ALGORITHMS, algorithm, roleOf } from "./algorithms";
import { putBack, tryOnSynth, type Kept } from "./audition";
import { choice, group, slider, toggle, type Control } from "./controls";
import { algorithmSvg, AmpEnvEditor, miniEnvMarkup, PitchEnvEditor, scalingMarkup, svgEl } from "./graphs";
import { Keyboard } from "./keyboard";
import {
  breakPointNote, cloneVoice, CURVES, detuneLabel, fixedHz, frequencyLabel, initOperator, initPatch, LFO_WAVES, noteName,
  ratioOf, transposeLabel, voiceFromVced, voiceToVced, type Operator, type Voice,
} from "./patch";

export interface EditorHost {
  library: Record<BankId, Bank>;
  /** The library changed: store it and redraw the banks. */
  librarySaved(bank: BankId): void;
  /** The connected synth, if it can take a voice right now. */
  device(): SysexLink | null;
  download(name: string, data: Uint8Array): void;
}

export interface Origin {
  bank: BankId;
  /** 0-31 */
  slot: number;
}

const STORE_KEY = "fm1-manager.editor.v1";
const HISTORY_LIMIT = 200;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const slotLabel = (o: Origin) => `${o.bank}${String(o.slot + 1).padStart(2, "0")}`;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

const WAVE_ICONS = [
  '<path d="M2 12L7 4l5 8 5-8"/>',
  '<path d="M2 4l7 8V4l7 8"/>',
  '<path d="M2 12l7-8v8l7-8"/>',
  '<path d="M2 12V4h7v8h7V4"/>',
  '<path d="M2 8c2.5-6 4.5-6 7 0s4.5 6 7 0"/>',
  '<path d="M2 10h3V5h3v7h3V3h3v6h2"/>',
].map((d) => `<svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${d}</svg>`);

export function mountEditor(host: EditorHost) {
  const preview = new Preview();
  let voice: Voice = initPatch();
  let origin: Origin | null = null;
  /** The bytes last loaded or saved, to tell whether there are unsaved changes. */
  let baseline: Uint8Array = voiceToVced(voice);
  let selected = 0;
  let muted = 0;
  let solo = -1;
  let clipboard: Operator | null = null;
  const undo: Voice[] = [];
  const redo: Voice[] = [];
  let lastKey = "";
  let lastTime = 0;
  const controls: Control[] = [];
  /** What "Try on synth" replaced on the synth, so it can be put back. */
  let kept: Kept | null = null;
  let synthBusy = false;
  /** A second press of Put back within this time writes even though the check failed. */
  let forceUntil = 0;

  // ------------------------------------------------------------ state

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as {
        vced: string;
        base: string;
        origin: Origin | null;
        selected: number;
        kept?: { original: string; lastSent: string } | null;
      } | null;
      if (!saved) return;
      if (saved.kept) kept = { original: fromBase64(saved.kept.original), lastSent: fromBase64(saved.kept.lastSent) };
      voice = voiceFromVced(fromBase64(saved.vced));
      baseline = fromBase64(saved.base);
      origin = saved.origin;
      selected = Math.max(0, Math.min(5, saved.selected | 0));
    } catch {
      // nothing saved, or storage blocked: start from the init voice
    }
  }

  let persistTimer = 0;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            vced: toBase64(voiceToVced(voice)),
            base: toBase64(baseline),
            origin,
            selected,
            kept: kept && { original: toBase64(kept.original), lastSent: toBase64(kept.lastSent) },
          }),
        );
      } catch {
        // storage full or blocked; the session still works
      }
    }, 250);
  }

  /** Apply a change. Changes to the same control in quick succession undo as one step. */
  function change(key: string, fn: (v: Voice) => void) {
    const now = performance.now();
    if (key !== lastKey || now - lastTime > 1200) {
      undo.push(cloneVoice(voice));
      if (undo.length > HISTORY_LIMIT) undo.shift();
      redo.length = 0;
    }
    lastKey = key;
    lastTime = now;
    fn(voice);
    commit();
  }

  /** Replace the whole voice (new, open, undo) as one step. */
  function replace(v: Voice, newOrigin: Origin | null | undefined, record = true) {
    if (record) {
      undo.push(cloneVoice(voice));
      if (undo.length > HISTORY_LIMIT) undo.shift();
      redo.length = 0;
    }
    voice = v;
    if (newOrigin !== undefined) {
      origin = newOrigin;
      baseline = voiceToVced(v);
    }
    lastKey = "";
    commit();
  }

  function commit() {
    preview.setVoice(voice);
    persist();
    render();
  }

  function step(from: Voice[], to: Voice[]) {
    const v = from.pop();
    if (!v) return;
    to.push(cloneVoice(voice));
    voice = v;
    lastKey = "";
    commit();
  }

  const op = () => voice.ops[selected]!;
  const opChange = (key: string, fn: (o: Operator) => void) => change(`op${selected}.${key}`, (v) => fn(v.ops[selected]!));

  function notify(text: string, kind: "" | "bad" = "") {
    const el = $("ed-notice");
    el.textContent = text;
    el.className = `notice ${kind}`;
    el.hidden = !text;
  }

  // ------------------------------------------------------- patch bar

  const nameInput = $<HTMLInputElement>("ed-name");
  nameInput.addEventListener("input", () => {
    const clean = nameInput.value.replace(/[^\x20-\x7e]/g, "").slice(0, 10);
    if (clean !== nameInput.value) nameInput.value = clean;
    change("name", (v) => (v.name = clean.padEnd(10)));
  });

  function renderPatchBar() {
    if (document.activeElement !== nameInput) nameInput.value = voice.name.trimEnd();
    const dirty = !sameBytes(voiceToVced(voice), baseline);
    const where = origin ? `${slotLabel(origin)}${dirty ? " · EDITED" : ""}` : dirty ? "NOT SAVED" : "NEW";
    $("ed-summary").textContent = `ALG ${voice.algorithm} · FB ${voice.feedback} · ${where}`;
    $<HTMLButtonElement>("ed-undo").disabled = !undo.length;
    $<HTMLButtonElement>("ed-redo").disabled = !redo.length;
    $<HTMLButtonElement>("ed-try").disabled = !host.device() || synthBusy;
    const back = $<HTMLButtonElement>("ed-putback");
    back.hidden = !kept;
    back.disabled = !host.device() || synthBusy;
    if (kept) {
      const name = vcedName(kept.original).trim() || "the original";
      back.textContent = `Put back ${name}`;
      back.title = `Play ${name} on the synth again`;
    }
  }

  $("ed-new").onclick = () => {
    replace(initPatch(), null);
    selected = 0;
    render();
    notify("Started a new sound from the init voice. Undo to go back.");
  };
  $("ed-undo").onclick = () => step(undo, redo);
  $("ed-redo").onclick = () => step(redo, undo);
  $("ed-export").onclick = () => {
    const name = voice.name.trim().replace(/[^\w-]+/g, "-") || "voice";
    host.download(`${name}.syx`, buildSingleVoiceSysex(voiceToVced(voice)));
  };
  async function withSynth(work: (link: SysexLink) => Promise<void>) {
    const link = host.device();
    if (!link || synthBusy) return;
    synthBusy = true;
    renderPatchBar();
    try {
      await work(link);
    } catch (e) {
      notify(`Couldn't reach the synth: ${(e as Error).message}.`, "bad");
    } finally {
      synthBusy = false;
      persist();
      renderPatchBar();
    }
  }

  $("ed-try").onclick = () =>
    withSynth(async (link) => {
      const sound = voice.name.trim() || "this sound";
      // Parameter changes only touch the edit buffer, so sending without a copy of what's there is safe.
      const result = await tryOnSynth(link, voiceToVced(voice), kept, true);
      if (!result.ok) {
        kept = null;
        notify(`${sound} is playing on the synth. It isn't stored; selecting a preset on the synth brings that preset back.`);
        return;
      }
      kept = result.kept;
      const was = vcedName(result.kept.original).trim() || "the preset's sound";
      notify(
        `${sound} is playing on the synth in place of ${was}. Nothing is stored: select a preset on the synth, or press Put back, to hear ${was} again.`,
      );
    });

  $("ed-putback").onclick = () =>
    withSynth(async (link) => {
      if (!kept) return;
      const force = performance.now() < forceUntil;
      forceUntil = 0;
      const result = await putBack(link, kept, force);
      if (result.ok) {
        kept = null;
        notify(`${result.name.trim() || "The original sound"} is playing on the synth again.`);
        return;
      }
      forceUntil = performance.now() + 15000;
      notify(
        result.reason === "moved"
          ? "The synth has moved on from the sound you tried, so there's nothing to put back. Press Put back again if you still want to hear the old sound."
          : "The synth didn't say what it's playing. Press Put back again to send the old sound anyway.",
        "bad",
      );
    });

  window.addEventListener("keydown", (e) => {
    if ($("view-editor").hidden || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    if ((e.target as HTMLElement | null)?.closest("input[type=text], input:not([type]), textarea")) return;
    e.preventDefault();
    if (e.shiftKey) step(redo, undo);
    else step(undo, redo);
  });

  // -------------------------------------------------------- algorithm

  const diagram = $("ed-alg-diagram");
  const algSvg = svgEl("0 0 10 10", "alg", "Algorithm diagram");
  diagram.append(algSvg);
  const pickOp = (target: EventTarget | null) => {
    const g = (target as Element | null)?.closest<SVGGElement>("[data-op]");
    if (!g) return;
    selected = Number(g.dataset.op) - 1;
    persist();
    render();
  };
  algSvg.addEventListener("click", (e) => pickOp(e.target));
  algSvg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") (e.preventDefault(), pickOp(e.target));
  });
  const setAlgorithm = (n: number) => change("algorithm", (v) => (v.algorithm = ((n - 1 + 32) % 32) + 1));
  $("ed-alg-prev").onclick = () => setAlgorithm(voice.algorithm - 1);
  $("ed-alg-next").onclick = () => setAlgorithm(voice.algorithm + 1);

  const grid = $("ed-alg-grid");
  const gridButtons = ALGORITHMS.map((alg, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "alg-thumb";
    b.setAttribute("aria-label", `Algorithm ${i + 1}`);
    const { markup, viewBox } = algorithmSvg(alg, { compact: true });
    b.innerHTML = `<span class="alg-thumb-num">${i + 1}</span><svg viewBox="${viewBox}" class="alg" aria-hidden="true">${markup}</svg>`;
    b.onclick = () => setAlgorithm(i + 1);
    grid.append(b);
    return b;
  });
  $("ed-alg-all").onclick = () => {
    grid.hidden = !grid.hidden;
    $("ed-alg-all").textContent = grid.hidden ? "Show all 32" : "Hide the list";
    $("ed-alg-all").setAttribute("aria-expanded", String(!grid.hidden));
  };

  const algControls = [
    slider({
      label: "Feedback",
      max: 7,
      get: () => voice.feedback,
      set: (n) => change("feedback", (v) => (v.feedback = n)),
      hint: "Feeds an operator back into itself (the loop in the diagram). Higher values add buzz and then noise.",
    }),
    toggle({
      label: "Restart oscillators on each note",
      hint: "Oscillator key sync: every note starts with the same phase, for consistent attacks",
      get: () => voice.oscSync,
      set: (b) => change("oscSync", (v) => (v.oscSync = b)),
    }),
  ];
  $("ed-alg-controls").append(...algControls.map((c) => c.el));
  controls.push(...algControls);

  function effectiveMute() {
    return solo >= 0 ? 0b111111 & ~(1 << solo) : muted;
  }

  function renderAlgorithm() {
    const alg = algorithm(voice.algorithm);
    const { markup, viewBox } = algorithmSvg(alg, {
      selected: selected + 1,
      muted: effectiveMute(),
      levels: voice.ops.map((o) => o.outputLevel),
    });
    algSvg.setAttribute("viewBox", viewBox);
    algSvg.innerHTML = markup;
    $("ed-alg-num").textContent = String(voice.algorithm).padStart(2, "0");
    gridButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(i + 1 === voice.algorithm)));
  }

  // -------------------------------------------------------- operators

  const tiles = $("ed-ops");
  const tileEls = voice.ops.map((_, i) => {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "op-tile";
    t.setAttribute("role", "tab");
    t.id = `ed-tile-${i}`;
    t.setAttribute("aria-controls", "ed-op");
    t.onclick = () => {
      selected = i;
      persist();
      render();
    };
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      selected = (selected + (e.key === "ArrowRight" ? 1 : 5)) % 6;
      render();
      tileEls[selected]!.focus();
    });
    tiles.append(t);
    return t;
  });

  function renderTiles() {
    const alg = algorithm(voice.algorithm);
    const mask = effectiveMute();
    voice.ops.forEach((o, i) => {
      const t = tileEls[i]!;
      const carrier = alg.carriers.includes(i + 1);
      t.className = `op-tile ${carrier ? "carrier" : "modulator"}${(mask >> i) & 1 ? " muted" : ""}`;
      t.setAttribute("aria-selected", String(i === selected));
      t.tabIndex = i === selected ? 0 : -1;
      t.innerHTML =
        `<span class="op-tile-head"><span class="op-tile-num">OP${i + 1}</span><span class="op-tile-role">${carrier ? "Carrier" : "Mod"}</span></span>` +
        `<span class="op-tile-freq">${frequencyLabel(o)}</span>` +
        miniEnvMarkup(o) +
        `<span class="op-tile-level" aria-label="Level ${o.outputLevel}"><span style="width:${(o.outputLevel / 99) * 100}%"></span></span>`;
    });
  }

  $("ed-op-mute").onclick = () => {
    solo = -1;
    muted ^= 1 << selected;
    preview.setMuted(effectiveMute());
    render();
  };
  $("ed-op-solo").onclick = () => {
    solo = solo === selected ? -1 : selected;
    preview.setMuted(effectiveMute());
    render();
  };
  $("ed-op-copy").onclick = () => {
    clipboard = structuredClone(op());
    notify(`Copied operator ${selected + 1}. Select another operator and press Paste.`);
    render();
  };
  $("ed-op-paste").onclick = () => {
    if (!clipboard) return;
    const c = structuredClone(clipboard);
    change(`paste${selected}`, (v) => (v.ops[selected] = c));
    notify("");
  };
  $("ed-op-reset").onclick = () => {
    const fresh = initOperator();
    if (selected === 0) fresh.outputLevel = 99;
    change(`reset${selected}`, (v) => (v.ops[selected] = fresh));
  };

  // Envelope editor and its sliders
  const envEditor = new AmpEnvEditor(
    {
      rates: () => op().rates,
      levels: () => op().levels,
      // one drag moves rate and level together, so it undoes as one step
      set: (kind, i, value) => opChange(`env.drag${i}`, (o) => ((kind === "rate" ? o.rates : o.levels)[i] = value)),
    },
    "Operator envelope",
    () => (lastKey = ""),
  );
  $("ed-env").append(envEditor.svg);
  const envSliders = [0, 1, 2, 3].flatMap((i) => [
    slider({ label: `Rate ${i + 1}`, max: 99, get: () => op().rates[i]!, set: (n) => opChange(`env.rate${i}`, (o) => (o.rates[i] = n)) }),
    slider({ label: `Level ${i + 1}`, max: 99, get: () => op().levels[i]!, set: (n) => opChange(`env.level${i}`, (o) => (o.levels[i] = n)) }),
  ]);
  // rates in the first row, levels in the second
  const envOrder = [0, 2, 4, 6, 1, 3, 5, 7].map((i) => envSliders[i]!);
  $("ed-env-sliders").append(...envOrder.map((c) => c.el));
  controls.push(...envSliders);

  const freqReadout = document.createElement("div");
  freqReadout.className = "lcd lcd-sm freq-lcd";
  const freqControls: Control[] = [
    choice({
      label: "Mode",
      options: [
        { label: "Ratio", title: "Follows the key you play, as a multiple of its pitch" },
        { label: "Fixed", title: "Stays at one frequency whatever key you play" },
      ],
      get: () => (op().fixed ? 1 : 0),
      set: (n) => opChange("fixed", (o) => (o.fixed = n === 1)),
    }),
    slider({
      label: "Coarse",
      max: 31,
      get: () => op().coarse,
      set: (n) => opChange("coarse", (o) => (o.coarse = n)),
      format: (n) => (op().fixed ? `${10 ** (n & 3)} Hz` : n === 0 ? "0.5" : String(n)),
    }),
    slider({
      label: "Fine",
      max: 99,
      get: () => op().fine,
      set: (n) => opChange("fine", (o) => (o.fine = n)),
      format: (n) => (op().fixed ? `×${(10 ** (n / 100)).toFixed(2)}` : `+${n}%`),
    }),
    slider({
      label: "Detune",
      max: 14,
      get: () => op().detune,
      set: (n) => opChange("detune", (o) => (o.detune = n)),
      format: detuneLabel,
      hint: "A slight pitch offset. Two operators detuned apart give a chorus-like shimmer.",
    }),
  ];
  const levelControls: Control[] = [
    slider({
      label: "Output level",
      max: 99,
      big: true,
      get: () => op().outputLevel,
      set: (n) => opChange("level", (o) => (o.outputLevel = n)),
      hint: "For a carrier, how loud it is. For a modulator, how strongly it changes the tone.",
    }),
    slider({
      label: "Velocity",
      max: 7,
      get: () => op().velocitySens,
      set: (n) => opChange("vel", (o) => (o.velocitySens = n)),
      hint: "How much harder playing raises this operator's level",
    }),
    slider({
      label: "LFO amp mod",
      max: 3,
      get: () => op().ampModSens,
      set: (n) => opChange("ams", (o) => (o.ampModSens = n)),
      hint: "How much the LFO's amplitude depth affects this operator (tremolo, or tone wobble on a modulator)",
    }),
    slider({
      label: "Rate scaling",
      max: 7,
      get: () => op().rateScaling,
      set: (n) => opChange("rs", (o) => (o.rateScaling = n)),
      hint: "Makes the envelope faster on higher notes, like a real piano or string",
    }),
  ];
  const curveOptions = CURVES.map((c) => ({ label: c }));
  const scalingGraph = document.createElement("div");
  scalingGraph.className = "scaling-wrap";
  const scalingControls: Control[] = [
    slider({
      label: "Break point",
      max: 99,
      get: () => op().breakPoint,
      set: (n) => opChange("bp", (o) => (o.breakPoint = n)),
      format: (n) => noteName(breakPointNote(n)),
      hint: "The key where scaling starts. Keys to the left use the left settings, keys to the right the right settings.",
    }),
    slider({ label: "Left depth", max: 99, get: () => op().leftDepth, set: (n) => opChange("ld", (o) => (o.leftDepth = n)) }),
    choice({ label: "Left curve", options: curveOptions, get: () => op().leftCurve, set: (n) => opChange("lc", (o) => (o.leftCurve = n)) }),
    slider({ label: "Right depth", max: 99, get: () => op().rightDepth, set: (n) => opChange("rd", (o) => (o.rightDepth = n)) }),
    choice({ label: "Right curve", options: curveOptions, get: () => op().rightCurve, set: (n) => opChange("rc", (o) => (o.rightCurve = n)) }),
  ];
  $("ed-op-groups").append(
    group("Frequency", freqReadout, ...freqControls),
    group("Level", ...levelControls),
    group("Keyboard scaling", scalingGraph, ...scalingControls),
  );
  controls.push(...freqControls, ...levelControls, ...scalingControls);

  function renderOperator() {
    const o = op();
    const alg = algorithm(voice.algorithm);
    $("ed-op-title").textContent = `Operator ${selected + 1}`;
    $("ed-op-role").textContent = roleOf(alg, selected + 1);
    $("ed-op").setAttribute("aria-labelledby", `ed-tile-${selected}`);
    const mask = effectiveMute();
    $("ed-op-mute").setAttribute("aria-pressed", String(solo < 0 && !!((muted >> selected) & 1)));
    $("ed-op-solo").setAttribute("aria-pressed", String(solo === selected));
    $<HTMLButtonElement>("ed-op-paste").disabled = !clipboard;
    $("ed-op").classList.toggle("muted", !!((mask >> selected) & 1));
    freqReadout.innerHTML = `<span class="lcd-mid">${frequencyLabel(o)}</span><span class="lcd-small">${
      o.fixed ? `${fixedHz(o).toFixed(1)} Hz on every key` : `${ratioOf(o).toFixed(3)} × the note's pitch`
    }</span>`;
    scalingGraph.innerHTML = scalingMarkup(o);
    envEditor.render();
  }

  // ------------------------------------------------------- pitch & LFO

  const pitchEditor = new PitchEnvEditor(
    {
      rates: () => voice.pitchRates,
      levels: () => voice.pitchLevels,
      set: (kind, i, value) => change(`penv.drag${i}`, (v) => ((kind === "rate" ? v.pitchRates : v.pitchLevels)[i] = value)),
    },
    "Pitch envelope",
    () => (lastKey = ""),
  );
  $("ed-penv").append(pitchEditor.svg);
  const pitchControls: Control[] = [
    slider({
      label: "Transpose",
      max: 48,
      get: () => voice.transpose,
      set: (n) => change("transpose", (v) => (v.transpose = n)),
      format: (n) => `${transposeLabel(n)}${n === 24 ? "" : ` (${n > 24 ? "+" : "−"}${Math.abs(n - 24)})`}`,
      hint: "Which note middle C plays. C3 is no transpose.",
    }),
    ...[0, 1, 2, 3].flatMap((i) => [
      slider({ label: `Rate ${i + 1}`, max: 99, get: () => voice.pitchRates[i]!, set: (n) => change(`penv.rate${i}`, (v) => (v.pitchRates[i] = n)) }),
      slider({ label: `Level ${i + 1}`, max: 99, get: () => voice.pitchLevels[i]!, set: (n) => change(`penv.level${i}`, (v) => (v.pitchLevels[i] = n)) }),
    ]),
  ];
  const pitchEl = $("ed-pitch");
  pitchEl.append(pitchControls[0]!.el);
  pitchControls[0]!.el.classList.add("span-all");
  pitchEl.append(...[1, 3, 5, 7, 2, 4, 6, 8].map((i) => pitchControls[i]!.el));
  controls.push(...pitchControls);

  const lfoControls: Control[] = [
    choice({
      label: "Wave",
      options: LFO_WAVES.map((label, i) => ({ label, icon: WAVE_ICONS[i] })),
      get: () => voice.lfo.wave,
      set: (n) => change("lfo.wave", (v) => (v.lfo.wave = n)),
    }),
    slider({
      label: "Speed",
      max: 99,
      get: () => voice.lfo.speed,
      set: (n) => change("lfo.speed", (v) => (v.lfo.speed = n)),
      format: (n) => `${n} · ${lfoHz(n) < 10 ? lfoHz(n).toFixed(2) : lfoHz(n).toFixed(1)} Hz`,
    }),
    slider({ label: "Delay", max: 99, get: () => voice.lfo.delay, set: (n) => change("lfo.delay", (v) => (v.lfo.delay = n)), hint: "How long after a key goes down the LFO fades in" }),
    slider({ label: "Pitch depth", max: 99, get: () => voice.lfo.pitchDepth, set: (n) => change("lfo.pmd", (v) => (v.lfo.pitchDepth = n)), hint: "Vibrato amount" }),
    slider({ label: "Pitch sensitivity", max: 7, get: () => voice.lfo.pitchSens, set: (n) => change("lfo.pms", (v) => (v.lfo.pitchSens = n)), hint: "Scales the pitch depth for this voice" }),
    slider({ label: "Amp depth", max: 99, get: () => voice.lfo.ampDepth, set: (n) => change("lfo.amd", (v) => (v.lfo.ampDepth = n)), hint: "Tremolo amount, for operators with LFO amp mod turned up" }),
    toggle({ label: "Restart LFO on each note", get: () => voice.lfo.keySync, set: (b) => change("lfo.sync", (v) => (v.lfo.keySync = b)) }),
  ];
  $("ed-lfo").append(...lfoControls.map((c) => c.el));
  lfoControls[0]!.el.classList.add("span-all");
  lfoControls.at(-1)!.el.classList.add("span-all");
  controls.push(...lfoControls);

  // ---------------------------------------------------------- keyboard

  let velocity = 100;
  const keyboard = new Keyboard($("kbd"), {
    noteOn: (n) => void preview.noteOn(n, velocity),
    noteOff: (n) => preview.noteOff(n),
    onRange: (lo, hi) => ($("kbd-range").textContent = `${noteName(lo)}–${noteName(hi)}`),
  });
  keyboard.enabled = () => !$("view-editor").hidden;
  $("kbd-down").onclick = () => keyboard.shift(-1);
  $("kbd-up").onclick = () => keyboard.shift(1);
  let hold = false;
  let volume = 0.7;
  const kbdControls: Control[] = [
    slider({ label: "Velocity", min: 1, max: 127, get: () => velocity, set: (n) => (velocity = n) }),
    slider({ label: "Volume", max: 100, get: () => Math.round(volume * 100), set: (n) => preview.setVolume((volume = n / 100)), format: (n) => `${n}%` }),
    toggle({
      label: "Hold",
      hint: "Keep notes sounding after you let go, so you can tweak while listening. Turn off to release them.",
      get: () => hold,
      set: (b) => preview.setSustain((hold = b)),
    }),
  ];
  $("kbd-controls").append(...kbdControls.map((c) => c.el));
  kbdControls.forEach((c) => c.update());

  // ------------------------------------------------- open / save dialog

  const dialog = $<HTMLDialogElement>("ed-dialog");
  let dialogMode: "open" | "save" = "open";
  let dialogBank: BankId = "A";
  let dialogSlot = 0;
  /** voices from a .syx file the user opened, shown in place of a bank */
  let fileVoices: { name: string; voices: Uint8Array[] } | null = null;

  const bankTabs = $("ed-dialog-banks");
  const fileTab = document.createElement("button");
  fileTab.type = "button";
  fileTab.className = "seg-btn";
  const tabButtons = BANKS.map((id) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn";
    b.setAttribute("role", "tab");
    b.textContent = `Bank ${id}`;
    b.onclick = () => {
      dialogBank = id;
      showingFile = false;
      renderDialog();
    };
    bankTabs.append(b);
    return b;
  });
  let showingFile = false;
  fileTab.setAttribute("role", "tab");
  fileTab.onclick = () => {
    showingFile = true;
    renderDialog();
  };
  bankTabs.append(fileTab);

  const fileInput = $("ed-dialog-file").querySelector("input")!;
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const msgs = splitSysex(new Uint8Array(await file.arrayBuffer()));
      const single = msgs.find((m) => m.length === 163);
      if (single) {
        replace(voiceFromVced(parseSingleVoiceSysex(single)), null);
        dialog.close();
        notify(`Opened ${file.name}. Undo to go back.`);
        return;
      }
      const banks = msgs.filter((m) => m.length === 4104);
      if (!banks.length) throw new Error("there's no DX7 voice or bank in this file");
      fileVoices = { name: file.name, voices: banks.flatMap((b) => parseBankSysex(b)) };
      showingFile = true;
      renderDialog();
    } catch (e) {
      $("ed-dialog-hint").textContent = `Couldn't open ${file.name}: ${(e as Error).message}.`;
    }
  };

  function openDialog(mode: "open" | "save") {
    dialogMode = mode;
    showingFile = false;
    if (origin) {
      dialogBank = origin.bank;
      dialogSlot = origin.slot;
    }
    $("ed-dialog-h").textContent = mode === "open" ? "Open a sound" : "Save to bank";
    $("ed-dialog-file").hidden = mode === "save";
    $("ed-dialog-ok").hidden = mode === "open";
    renderDialog();
    dialog.showModal();
    dialog.querySelector<HTMLElement>('.slot[aria-pressed="true"], .slot')?.focus();
  }

  function renderDialog() {
    const fromFile = showingFile && fileVoices && dialogMode === "open";
    tabButtons.forEach((b, i) => b.setAttribute("aria-selected", String(!fromFile && BANKS[i] === dialogBank)));
    fileTab.hidden = !(fileVoices && dialogMode === "open");
    fileTab.textContent = fileVoices?.name ?? "";
    fileTab.setAttribute("aria-selected", String(!!fromFile));
    const voices = fromFile ? fileVoices!.voices : host.library[dialogBank].voices;
    const list = $("ed-dialog-slots");
    list.replaceChildren(
      ...voices.map((vm, i) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "slot";
        const isOrigin = !fromFile && origin?.bank === dialogBank && origin.slot === i;
        b.setAttribute("aria-pressed", String(dialogMode === "save" ? i === dialogSlot : isOrigin));
        b.innerHTML = `<span class="slot-num"></span><span class="slot-name"></span>`;
        b.querySelector(".slot-num")!.textContent = fromFile ? String(i + 1).padStart(2, "0") : `${dialogBank}${String(i + 1).padStart(2, "0")}`;
        b.querySelector(".slot-name")!.textContent = vmemName(vm) || "(no name)";
        b.onclick = () => {
          if (dialogMode === "open") {
            replace(voiceFromVced(vmemToVced(vm)), fromFile ? null : { bank: dialogBank, slot: i });
            dialog.close();
            notify(`Opened ${vmemName(vm) || "a sound"}${fromFile ? ` from ${fileVoices!.name}` : ` from bank ${dialogBank}, slot ${i + 1}`}. Undo to go back.`);
          } else {
            dialogSlot = i;
            renderDialog();
          }
        };
        li.append(b);
        return li;
      }),
    );
    const hint = $("ed-dialog-hint");
    if (dialogMode === "open") {
      hint.textContent = fromFile ? `${voices.length} sounds in ${fileVoices!.name}` : "Pick a sound to edit. Your current sound stays in undo.";
    } else {
      const replaced = vmemName(host.library[dialogBank].voices[dialogSlot]!);
      hint.textContent = `${dialogBank}${String(dialogSlot + 1).padStart(2, "0")} · replaces ${replaced || "(no name)"}`;
      $("ed-dialog-ok").textContent = `Save to ${dialogBank}${String(dialogSlot + 1).padStart(2, "0")}`;
    }
  }

  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "ok" || dialogMode !== "save") return;
    const bank = host.library[dialogBank];
    bank.voices[dialogSlot] = vcedToVmem(voiceToVced(voice));
    bank.sentAt = null;
    if (bank.source === "empty") bank.source = "Edited";
    origin = { bank: dialogBank, slot: dialogSlot };
    baseline = voiceToVced(voice);
    host.librarySaved(dialogBank);
    persist();
    render();
    notify(`Saved ${voice.name.trim() || "the sound"} to bank ${dialogBank}, slot ${dialogSlot + 1}. Send bank ${dialogBank} from the Presets tab to put it on the synth.`);
  });
  $("ed-load").onclick = () => openDialog("open");
  $("ed-save").onclick = () => openDialog("save");

  // ------------------------------------------------------------ render

  function render() {
    renderPatchBar();
    renderAlgorithm();
    renderTiles();
    renderOperator();
    pitchEditor.render();
    controls.forEach((c) => c.update());
  }

  restore();
  preview.setVoice(voice);
  render();

  return {
    /** Load a voice from the library into the editor. */
    open(vmem: Uint8Array, from: Origin | null) {
      replace(voiceFromVced(vmemToVced(vmem)), from);
      notify(`Opened ${vmemName(vmem) || "a sound"}${from ? ` from bank ${from.bank}, slot ${from.slot + 1}` : ""}. Undo to go back.`);
    },
    /** The device came or went. */
    refresh: renderPatchBar,
    /** The tab is being hidden: stop any sound. */
    hidden() {
      keyboard.releaseAll();
      preview.allOff();
    },
  };
}

export type Editor = ReturnType<typeof mountEditor>;
