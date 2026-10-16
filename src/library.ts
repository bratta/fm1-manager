// The app's record of the synth's 128 presets (banks A-D, 32 voices each).
// The FM-1 cannot send its stored presets back, so this record is the
// source of truth: it is updated whenever a bank is imported or sent.

import { initVoice, VOICES_PER_BANK } from "./protocol/dx7";

export const BANKS = ["A", "B", "C", "D"] as const;
export type BankId = (typeof BANKS)[number];

export interface Bank {
  /** Where the voices came from, e.g. a file name. */
  source: string;
  voices: Uint8Array[];
  /** When this bank was last sent to the synth (ISO time), if ever. */
  sentAt: string | null;
}

const KEY = "fm1-manager.banks.v1";

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const emptyBank = (): Bank => ({
  source: "empty",
  voices: Array.from({ length: VOICES_PER_BANK }, initVoice),
  sentAt: null,
});

export function loadLibrary(): Record<BankId, Bank> {
  const lib = Object.fromEntries(BANKS.map((id) => [id, emptyBank()])) as Record<BankId, Bank>;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, { source: string; voices: string[]; sentAt: string | null }>;
    for (const id of BANKS) {
      const b = saved[id];
      if (b && b.voices.length === VOICES_PER_BANK) lib[id] = { source: b.source, sentAt: b.sentAt, voices: b.voices.map(fromBase64) };
    }
  } catch {
    // storage unavailable or corrupt: start empty
  }
  return lib;
}

export function saveLibrary(lib: Record<BankId, Bank>): void {
  try {
    const out = Object.fromEntries(
      BANKS.map((id) => [id, { source: lib[id].source, sentAt: lib[id].sentAt, voices: lib[id].voices.map(toBase64) }]),
    );
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // storage full or blocked; the session still works
  }
}
