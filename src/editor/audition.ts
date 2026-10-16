// "Try on synth". The FM-1 stores a single-voice dump straight into the
// selected preset (seen on stock firmware, 2026-10-16), so trying a sound
// sends it as parameter changes, which only touch the edit buffer. As a
// convenience we still read the sound that was there first and can send it
// back the same way.

import { readVoice } from "../backup";
import type { SysexLink } from "../midi/link";
import { buildParameterChanges, vcedName } from "../protocol/dx7";
import { voiceFromVced, voiceToVced } from "./patch";

export interface Kept {
  /** The preset's sound before the first try. */
  original: Uint8Array;
  /** What we last wrote over it. */
  lastSent: Uint8Array;
}

export type TryResult =
  | { ok: true; kept: Kept; firstTry: boolean }
  /** Couldn't read the preset first, so trying would lose it. */
  | { ok: false; reason: "no-read" };

export type PutBackResult =
  | { ok: true; name: string }
  /** The synth now holds something other than our last try: a different preset, or edited on the synth. */
  | { ok: false; reason: "moved" | "no-read" };

// Compare as the editor sees them, so stray bits the synth might add on readback don't count.
const norm = (v: Uint8Array) => voiceToVced(voiceFromVced(v));
const same = (a: Uint8Array, b: Uint8Array) => {
  const [x, y] = [norm(a), norm(b)];
  return x.every((n, i) => n === y[i]);
};

/**
 * Send `vced` to the selected preset, remembering what it replaces. If the
 * synth still holds our last try, the original from before is kept;
 * otherwise this is a new preset and its current sound becomes the original.
 * With `force`, sends even when the current sound can't be read.
 */
export async function tryOnSynth(link: SysexLink, vced: Uint8Array, kept: Kept | null, force = false, timeoutMs = 1500): Promise<TryResult> {
  const current = await readVoice(link, timeoutMs);
  if (!current && !force) return { ok: false, reason: "no-read" };
  const stillOurs = !!kept && !!current && same(current, kept.lastSent);
  const original = stillOurs ? kept!.original : current;
  await sendToEditBuffer(link, vced);
  return original
    ? { ok: true, kept: { original, lastSent: vced.slice() }, firstTry: !stillOurs }
    : { ok: false, reason: "no-read" };
}

const pause = () => new Promise((r) => setTimeout(r, 2));

/** All 155 parameters as parameter changes, in small bursts so a slow MIDI input keeps up. */
export async function sendToEditBuffer(link: SysexLink, vced: Uint8Array) {
  const msgs = buildParameterChanges(vced);
  for (let i = 0; i < msgs.length; i++) {
    link.send(msgs[i]!);
    if (i % 16 === 15) await pause();
  }
}

/** Send the original back, but only if the synth still holds our last try (unless forced). */
export async function putBack(link: SysexLink, kept: Kept, force = false, timeoutMs = 1500): Promise<PutBackResult> {
  if (!force) {
    const current = await readVoice(link, timeoutMs);
    if (!current) return { ok: false, reason: "no-read" };
    if (!same(current, kept.lastSent)) return { ok: false, reason: "moved" };
  }
  await sendToEditBuffer(link, kept.original);
  return { ok: true, name: vcedName(kept.original) };
}
