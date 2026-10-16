// M-VAVE's 8-to-7 bit packing: one continuous LSB-first bitstream.
// This is not the MSB-group packing Roland/Akai use.

export function pack7(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc |= byte << bits;
    bits += 8;
    while (bits >= 7) {
      out.push(acc & 0x7f);
      acc >>>= 7;
      bits -= 7;
    }
  }
  if (bits > 0) out.push(acc & 0x7f);
  return Uint8Array.from(out);
}

export function unpack7(septets: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const s of septets) {
    acc |= (s & 0x7f) << bits;
    bits += 7;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
