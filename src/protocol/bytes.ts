export const hex = (data: ArrayLike<number>): string =>
  Array.from(data, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

export const fromHex = (text: string): Uint8Array =>
  Uint8Array.from(text.trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16)));

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const u24le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
export const u32le = (v: number): number[] => [...u24le(v), (v >>> 24) & 0xff];
export const readU24le = (b: Uint8Array, o: number): number =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
export const readU32le = (b: Uint8Array, o: number): number =>
  (readU24le(b, o) | ((b[o + 3] ?? 0) << 24)) >>> 0;

export function equalBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
