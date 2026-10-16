import { describe, expect, it } from "vitest";
import { inspectFirmware, logicalImage, productId } from "../src/firmware/fwsc";
import golden from "./fixtures/python-golden.json";
import { answer, readStock, recordedRequests, sha256, stockAvailable } from "./helpers";

const allRequests = () => [...recordedRequests("stage"), ...recordedRequests("flash")];

describe("replaying the recorded real-device restore", () => {
  it("expands to the recorded request counts", () => {
    expect(recordedRequests("stage")).toHaveLength(49);
    expect(recordedRequests("flash")).toHaveLength(1168);
  });

  it("answers every request exactly like the Python reference (synthetic payload)", () => {
    expect(sha256(allRequests().map((r) => answer(r, null)))).toBe(golden.synthetic);
  });
});

describe.skipIf(!stockAvailable)("stock V15 package", () => {
  it("is recognised as stock V15", async () => {
    const info = await inspectFirmware(readStock());
    expect(info.product).toBe("FM-1_015");
    expect(info.model).toBe("FM-1");
    expect(info.version).toBe(15);
    expect(info.stock?.label).toBe("M-VAVE stock V15");
  });

  it("strips the header markers like the Python reference", () => {
    const logical = logicalImage(readStock());
    expect(logical.length).toBe(golden.logical_len);
    expect(sha256([logical])).toBe(golden.logical_sha256);
  });

  it("answers every recorded request with the same bytes as the Python reference", () => {
    const logical = logicalImage(readStock());
    expect(sha256(allRequests().map((r) => answer(r, logical)))).toBe(golden.stock_v15);
  });

  it("does not treat a modified package as stock", async () => {
    const raw = readStock();
    raw[5000]! ^= 0xff;
    const info = await inspectFirmware(raw);
    expect(productId(raw)).toBe("FM-1_015");
    expect(info.stock).toBeNull();
  });
});
