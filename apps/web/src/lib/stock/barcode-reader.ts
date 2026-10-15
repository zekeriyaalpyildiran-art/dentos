// zxing-wasm decoder (spec p7_rules_ui §14.4). This module is only ever loaded with a dynamic import() from the
// scanner modal, so neither the JS nor the WASM enters the main bundle. The WASM is self-hosted under
// /public/vendor (copied by the `stock-wasm` script); nothing is fetched from a CDN.

import {
  ZXING_WASM_VERSION,
  prepareZXingModule,
  purgeZXingModule,
  readBarcodes,
  type ReaderOptions,
} from "zxing-wasm/reader";
import { uniqueBarcodeTexts } from "./barcode-filter";

export const stockReaderOptions: ReaderOptions = {
  formats: ["DataMatrix", "QRCode", "EAN13", "EAN8", "UPCA", "Code128", "ITF14", "DataBar"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 4,
  textMode: "Plain",
  returnErrors: false,
};

export const ZXING_WASM_PATH = `/vendor/zxing-reader-${ZXING_WASM_VERSION}.wasm`;

let ready: Promise<unknown> | null = null;

export function prepareStockReader(): Promise<unknown> {
  if (!ready) {
    ready = prepareZXingModule({
      overrides: { locateFile: () => ZXING_WASM_PATH },
      fireImmediately: true,
    }).catch((error: unknown) => {
      // Cleared so that a later attempt can retry the download.
      ready = null;
      purgeZXingModule();
      throw error;
    });
  }
  return ready;
}

export async function readStockBarcodes(image: ImageData | Blob): Promise<string[]> {
  await prepareStockReader();
  return uniqueBarcodeTexts(await readBarcodes(image, stockReaderOptions));
}
