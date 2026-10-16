// The on-screen keyboard: click or drag across keys, or play from the
// computer keyboard (A W S E D F T G Y H U J K O L P ;) with Z and X to
// shift octaves.

import { noteName } from "./patch";

export interface KeyboardOptions {
  noteOn(note: number): void;
  noteOff(note: number): void;
  /** Called when the visible range changes, with the lowest note shown. */
  onRange?(low: number, high: number): void;
}

const BLACK = new Set([1, 3, 6, 8, 10]);
const COMPUTER_KEYS = ["KeyA", "KeyW", "KeyS", "KeyE", "KeyD", "KeyF", "KeyT", "KeyG", "KeyY", "KeyH", "KeyU", "KeyJ", "KeyK", "KeyO", "KeyL", "KeyP", "Semicolon"];
const KEY_LABELS = ["A", "W", "S", "E", "D", "F", "T", "G", "Y", "H", "U", "J", "K", "O", "L", "P", ";"];

export class Keyboard {
  /** lowest C shown */
  private low = 48;
  private octaves = 3;
  private readonly held = new Map<number, number>(); // pointerId -> note
  private readonly typed = new Map<string, number>(); // key code -> note
  private readonly keys = new Map<number, HTMLElement>();
  enabled = () => true;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: KeyboardOptions,
  ) {
    root.classList.add("kbd-keys");
    root.addEventListener("pointerdown", (e) => this.pointer(e, "down"));
    root.addEventListener("pointermove", (e) => this.pointer(e, "move"));
    root.addEventListener("pointerup", (e) => this.pointer(e, "up"));
    root.addEventListener("pointercancel", (e) => this.pointer(e, "up"));
    root.addEventListener("lostpointercapture", (e) => this.pointer(e, "up"));
    window.addEventListener("keydown", (e) => this.key(e, true));
    window.addEventListener("keyup", (e) => this.key(e, false));
    window.addEventListener("blur", () => this.releaseAll());
    new ResizeObserver(() => this.fit()).observe(root);
    this.build();
  }

  /** First note the computer keys play: the C one octave above the lowest shown. */
  private get typedBase() {
    return this.low + (this.octaves > 2 ? 12 : 0);
  }

  shift(octaves: number) {
    const low = Math.max(12, Math.min(96, this.low + 12 * octaves));
    if (low === this.low) return;
    this.releaseAll();
    this.low = low;
    this.build();
  }

  releaseAll() {
    for (const n of new Set([...this.held.values(), ...this.typed.values()])) this.opts.noteOff(n);
    this.held.clear();
    this.typed.clear();
    this.keys.forEach((k) => k.classList.remove("on"));
  }

  private fit() {
    const want = this.root.clientWidth < 560 ? 2 : this.root.clientWidth < 1000 ? 3 : 4;
    if (want !== this.octaves) {
      this.releaseAll();
      this.octaves = want;
      this.build();
    }
  }

  private build() {
    this.keys.clear();
    const whites = this.octaves * 7 + 1;
    const frag = document.createDocumentFragment();
    let w = 0;
    for (let n = this.low; n <= this.low + this.octaves * 12; n++) {
      const black = BLACK.has(n % 12);
      const k = document.createElement("div");
      k.className = black ? "key black" : "key white";
      k.dataset.note = String(n);
      k.setAttribute("aria-hidden", "true");
      if (black) k.style.left = `calc(${(w / whites) * 100}% - var(--black-w) / 2)`;
      else w++;
      const typedIndex = n - this.typedBase;
      const labels: string[] = [];
      if (typedIndex >= 0 && typedIndex < KEY_LABELS.length) labels.push(`<span class="key-hint">${KEY_LABELS[typedIndex]}</span>`);
      if (n % 12 === 0) labels.push(`<span class="key-name">${noteName(n)}</span>`);
      k.innerHTML = labels.join("");
      this.keys.set(n, k);
      frag.append(k);
    }
    this.root.replaceChildren(frag);
    this.root.style.setProperty("--whites", String(whites));
    this.opts.onRange?.(this.low, this.low + this.octaves * 12);
  }

  private press(note: number) {
    this.keys.get(note)?.classList.add("on");
    this.opts.noteOn(note);
  }

  private release(note: number) {
    const stillHeld = [...this.held.values(), ...this.typed.values()].includes(note);
    if (stillHeld) return;
    this.keys.get(note)?.classList.remove("on");
    this.opts.noteOff(note);
  }

  private noteAt(e: PointerEvent): number | null {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".key");
    return el && this.root.contains(el) ? Number(el.dataset.note) : null;
  }

  private pointer(e: PointerEvent, kind: "down" | "move" | "up") {
    if (kind === "down") {
      if (e.button !== 0) return;
      const n = this.noteAt(e);
      if (n === null) return;
      e.preventDefault();
      this.root.setPointerCapture(e.pointerId);
      this.held.set(e.pointerId, n);
      this.press(n);
    } else if (kind === "move") {
      const was = this.held.get(e.pointerId);
      if (was === undefined) return;
      const n = this.noteAt(e);
      if (n === null || n === was) return;
      this.held.set(e.pointerId, n);
      this.release(was);
      this.press(n);
    } else {
      const was = this.held.get(e.pointerId);
      if (was === undefined) return;
      this.held.delete(e.pointerId);
      this.release(was);
    }
  }

  private key(e: KeyboardEvent, down: boolean) {
    if (!down) {
      const n = this.typed.get(e.code);
      if (n !== undefined) (this.typed.delete(e.code), this.release(n));
      return;
    }
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || !this.enabled()) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input[type=text], input:not([type]), textarea, select, dialog[open]") || document.querySelector("dialog[open]")) return;
    if (e.code === "KeyZ" || e.code === "KeyX") {
      this.shift(e.code === "KeyZ" ? -1 : 1);
      return;
    }
    const i = COMPUTER_KEYS.indexOf(e.code);
    if (i < 0) return;
    e.preventDefault();
    const n = this.typedBase + i;
    this.typed.set(e.code, n);
    this.press(n);
  }
}
