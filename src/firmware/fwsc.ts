// M-VAVE .fwsc firmware packages (JieLi UFW image for the AC791N).
// The first 20 blocks of 0x30 bytes each carry 47 data bytes plus one marker
// byte. The device requests addresses in the *logical* image, with markers
// stripped; everything after the header is sent as-is. The markers also spell
// the product id, e.g. "FM-1_015". (From AL-255/FM-1-RE tools/fm1_ota.py.)

const HEADER_BLOCKS = 20;
const BLOCK = 0x30;
const MARKER_PAD = 0x7d;

export interface KnownFirmware {
  product: string;
  label: string;
  sha256: string;
  size: number;
}

/**
 * Packages this app treats as official stock firmware. Only these can be used
 * for "restore to stock". FM-1_015 was restored to hardware successfully
 * (AL-255/FM-1-RE docs/io/12-v15-reflash-proof.md).
 */
export const STOCK_FIRMWARE: readonly KnownFirmware[] = [
  {
    product: "FM-1_015",
    label: "M-VAVE stock V15",
    sha256: "db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a",
    size: 699956,
  },
];

export interface FirmwareInfo {
  /** Product id from the header markers, e.g. "FM-1_015". */
  product: string;
  model: string;
  version: number;
  rawSize: number;
  sha256: string;
  /** The image as the device addresses it. */
  logical: Uint8Array;
  stock: KnownFirmware | null;
}

export function logicalImage(raw: Uint8Array): Uint8Array {
  if (raw.length < HEADER_BLOCKS * BLOCK) throw new Error("file is too short to be an FM-1 firmware package");
  const out = new Uint8Array(raw.length - HEADER_BLOCKS);
  for (let i = 0; i < HEADER_BLOCKS; i++) {
    out.set(raw.subarray(i * BLOCK, i * BLOCK + BLOCK - 1), i * (BLOCK - 1));
  }
  out.set(raw.subarray(HEADER_BLOCKS * BLOCK), HEADER_BLOCKS * (BLOCK - 1));
  return out;
}

export function productId(raw: Uint8Array): string {
  let product = "";
  for (let i = 0; i < HEADER_BLOCKS; i++) {
    const marker = raw[i * BLOCK + BLOCK - 1] ?? MARKER_PAD;
    if (marker !== MARKER_PAD) product += String.fromCharCode((marker - i - 1) & 0xff);
  }
  return product;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function inspectFirmware(raw: Uint8Array): Promise<FirmwareInfo> {
  const looksLikeUfw = new TextDecoder("latin1").decode(raw.subarray(-16)).includes("JLUFW");
  if (!looksLikeUfw) throw new Error("this is not an FM-1 firmware package (.fwsc)");
  const product = productId(raw);
  const m = /^(.+)_([0-9]+)$/.exec(product);
  if (!m) throw new Error(`unrecognised package id "${product}"`);
  const sha256 = await sha256Hex(raw);
  const stock = STOCK_FIRMWARE.find((k) => k.sha256 === sha256 && k.size === raw.length) ?? null;
  return {
    product,
    model: m[1]!,
    version: parseInt(m[2]!, 10),
    rawSize: raw.length,
    sha256,
    logical: logicalImage(raw),
    stock,
  };
}
