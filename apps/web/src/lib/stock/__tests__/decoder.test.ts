// @vitest-environment node
// The shipped zxing-wasm reader, loaded from the self-hosted WASM (public/vendor), with the scanner's options
// (legacy tests/barcode-camera.test.mjs, both decoder cases). These are the only tests proving that textMode
// 'Plain' keeps FNC1 as GS (\u001d), which parseGs1's lot / serial split depends on. Skipped when the WASM has not
// been copied yet (run `pnpm run stock-wasm`).

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ZXING_WASM_VERSION, prepareZXingModule as prepareReader, readBarcodes } from "zxing-wasm/reader";
import { prepareZXingModule as prepareWriter, writeBarcode } from "zxing-wasm/writer";
import { uniqueBarcodeTexts } from "../barcode-filter";
import { resolveStockScan, type MatchItem } from "../barcode-match";
import { stockReaderOptions } from "../barcode-reader";

const require_ = createRequire(import.meta.url);
const READER_WASM = fileURLToPath(new URL(`../../../../public/vendor/zxing-reader-${ZXING_WASM_VERSION}.wasm`, import.meta.url));
const ITEMS: MatchItem[] = [{ id: "i7", gtin: "09506000134352" }];

interface Symbol1 {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** One-channel symbol -> RGBA pixels, 5x module size, white border; optionally rotated 90 degrees. */
function imageData(symbol: Symbol1, rotated = false) {
  const scale = 5;
  const border = 30;
  const width = symbol.width * scale + border * 2;
  const height = symbol.height * scale + border * 2;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < symbol.height; y++) {
    for (let x = 0; x < symbol.width; x++) {
      const value = symbol.data[y * symbol.width + x];
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = border + x * scale + dx;
          const py = border + y * scale + dy;
          const offset = rotated ? (px * height + (height - 1 - py)) * 4 : (py * width + px) * 4;
          data[offset] = value;
          data[offset + 1] = value;
          data[offset + 2] = value;
        }
      }
    }
  }
  return { data, width: rotated ? height : width, height: rotated ? width : height, colorSpace: "srgb" as const };
}

const hasWasm = existsSync(READER_WASM);

describe.skipIf(!hasWasm)("shipped zxing-wasm decoder", () => {
  beforeAll(async () => {
    await prepareReader({ overrides: { wasmBinary: readFileSync(READER_WASM) }, fireImmediately: true });
    await prepareWriter({
      overrides: { wasmBinary: readFileSync(require_.resolve("zxing-wasm/writer/zxing_writer.wasm")) },
      fireImmediately: true,
    });
  });

  it("reads rotated GS1 DataMatrix pixels and preserves FNC1 (lot / serial split)", async () => {
    const written = await writeBarcode("(01)09506000134352(17)271231(10)LOT21ABC(21)SER17XYZ", {
      format: "DataMatrix",
      options: "gs1",
    });
    expect(written.error).toBe("");
    const results = await readBarcodes(imageData(written.symbol as Symbol1, true), stockReaderOptions);
    const codes = uniqueBarcodeTexts(results);
    expect(codes).toHaveLength(1);
    const scan = resolveStockScan(codes[0], ITEMS);
    expect(scan.itemId).toBe("i7");
    expect(scan.lot).toBe("LOT21ABC");
    expect(scan.serial).toBe("SER17XYZ");
    expect(scan.expiry).toBe("2027-12-31");
  });

  it("reads EAN13 and does not invent a code in a blank camera frame", async () => {
    const written = await writeBarcode("9506000134352", { format: "EAN13" });
    expect(written.error).toBe("");
    const codes = uniqueBarcodeTexts(await readBarcodes(imageData(written.symbol as Symbol1), stockReaderOptions));
    expect(codes).toHaveLength(1);
    expect(resolveStockScan(codes[0], ITEMS).itemId).toBe("i7");
    const blank = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(255), colorSpace: "srgb" as const };
    expect(await readBarcodes(blank, stockReaderOptions)).toHaveLength(0);
  });
});
