import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildOtaResponse, buildOtaSuccess, OTA_ADDR_FINISHED, OTA_ADDR_VERIFIED, type OtaRequest } from "../src/protocol/vendor";
import record from "./fixtures/fm1-v15-reflash-2026-09-04.json";

export const STOCK_FWSC = process.env.FM1_STOCK_FWSC ?? "/mnt/project-files/uploads/hearth/28e5d12d-ee43-4836-96be-3c36ddbedd2f";
export const stockAvailable = existsSync(STOCK_FWSC);
export const readStock = () => new Uint8Array(readFileSync(STOCK_FWSC));

type Run = [string, number, number, number, number];

/** Every request the real device made during the recorded V15 restore. */
export function recordedRequests(stage: "stage" | "flash"): OtaRequest[] {
  return (record[stage].request_runs as Run[]).flatMap(([addr, length, flashType, count, stride]) =>
    Array.from({ length: count }, (_, i) => ({ address: parseInt(addr, 16) + i * stride, length, flashType })),
  );
}

export function answer(req: OtaRequest, image: Uint8Array | null): Uint8Array {
  if (req.address === OTA_ADDR_VERIFIED || req.address === OTA_ADDR_FINISHED) return buildOtaSuccess(req.address);
  const data = image ? image.subarray(req.address, req.address + req.length) : new Uint8Array(req.length);
  return buildOtaResponse(req, data);
}

export function sha256(chunks: Uint8Array[]): string {
  const h = createHash("sha256");
  chunks.forEach((c) => h.update(c));
  return h.digest("hex");
}
