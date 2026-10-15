"use client";

// Camera / photo barcode scanner (spec p7_rules_ui §14.4, §20.6). Loaded with next/dynamic only when a scanner is
// opened; the zxing-wasm decoder is a further dynamic import, so neither enters the main bundle. Frames and photos
// are decoded on the device and never uploaded.

import { useEffect, useRef, useState } from "react";
import { CameraSession, cameraErrorMessage } from "@/lib/stock/camera-session";
import { detectorResultTrusted } from "@/lib/stock/barcode-filter";
import { MAX_BARCODE_LENGTH } from "@/lib/stock/gs1";
import { StockModal, buttonSecondary, stockInput } from "./ui";

type Reader = typeof import("@/lib/stock/barcode-reader");
let readerPromise: Promise<Reader> | null = null;

async function zxing(): Promise<Reader> {
  if (!readerPromise) {
    readerPromise = import("@/lib/stock/barcode-reader").catch((error: unknown) => {
      readerPromise = null;
      throw error;
    });
  }
  const mod = await readerPromise;
  await mod.prepareStockReader();
  return mod;
}

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface DetectorCtor {
  new (options: { formats: string[] }): DetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

const DETECTOR_FORMATS = ["data_matrix", "qr_code", "ean_13", "ean_8", "upc_a", "code_128", "itf"];

/** Browser BarcodeDetector fast path, only when it supports EAN-13 and DataMatrix (D17). */
async function nativeDetector(): Promise<DetectorLike | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (!Ctor || typeof Ctor.getSupportedFormats !== "function") return null;
  try {
    const supported = await Ctor.getSupportedFormats();
    if (!supported.includes("ean_13") || !supported.includes("data_matrix")) return null;
    return new Ctor({ formats: DETECTOR_FORMATS.filter((f) => supported.includes(f)) });
  } catch {
    return null;
  }
}

const SCAN_INTERVAL_MS = 220;
const MAX_FRAME_SIDE = 1440;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

type ScanState = "starting" | "scanning" | "stopped" | "photo";

export default function BarcodeScannerModal({
  purpose = "movement",
  onClose,
  onScan,
}: {
  purpose?: "movement" | "product";
  onClose: () => void;
  onScan: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const camera = useRef(new CameraSession());
  const operation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef({ onClose, onScan });
  callbacks.current = { onClose, onScan };

  const [state, setState] = useState<ScanState>("starting");
  const [message, setMessage] = useState("");
  const [hint, setHint] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [manual, setManual] = useState("");

  function stop() {
    operation.current++;
    camera.current.stop();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function accept(codes: string[]): boolean {
    if (codes.length > 1) {
      setHint("Birden fazla kod görünüyor. Yalnızca okutacağınız barkodu yaklaştırın.");
      return false;
    }
    if (codes.length === 0) return false;
    stop();
    callbacks.current.onClose();
    callbacks.current.onScan(codes[0]);
    return true;
  }

  useEffect(() => {
    setState("starting");
    setMessage("");
    setHint("");
    const current = ++operation.current;
    let alive = true;
    const isCurrent = () => alive && operation.current === current;

    async function start() {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new DOMException("Camera unavailable", "NotSupportedError");
        }
        const stream = await camera.current.open(navigator.mediaDevices, deviceId || undefined);
        if (!isCurrent()) return;
        const video = videoRef.current;
        if (!video) {
          stop();
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (!isCurrent()) return;

        let detector = await nativeDetector();
        // Without a native detector the WASM decoder is needed right away.
        if (!detector) await zxing();
        if (!isCurrent()) return;
        setState("scanning");
        void navigator.mediaDevices
          .enumerateDevices()
          .then((list) => {
            if (isCurrent()) setDevices(list.filter((d) => d.kind === "videoinput"));
          })
          .catch(() => {});

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Camera frame unavailable");

        const frame = () => context.getImageData(0, 0, canvas.width, canvas.height);

        async function decode(): Promise<string[]> {
          if (detector) {
            try {
              const found = await detector.detect(canvas);
              const texts = [
                ...new Set(found.map((f) => f.rawValue).filter((t) => t && t.length <= MAX_BARCODE_LENGTH)),
              ];
              if (texts.length !== 1) return texts;
              if (detectorResultTrusted(texts[0])) return texts;
              // Separators may have been dropped: re-read the same frame with zxing and use only its result.
              const reader = await zxing();
              return reader.readStockBarcodes(frame());
            } catch {
              detector = null; // detector API failed: zxing for the rest of this session
            }
          }
          const reader = await zxing();
          return reader.readStockBarcodes(frame());
        }

        async function tick() {
          if (!isCurrent()) return;
          const v = videoRef.current;
          try {
            if (v && v.readyState >= 2 && v.videoWidth && v.videoHeight) {
              const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(v.videoWidth, v.videoHeight));
              canvas.width = Math.round(v.videoWidth * scale);
              canvas.height = Math.round(v.videoHeight * scale);
              context!.drawImage(v, 0, 0, canvas.width, canvas.height);
              const codes = await decode();
              if (!isCurrent()) return;
              if (accept(codes)) return;
            }
            timer.current = setTimeout(tick, SCAN_INTERVAL_MS);
          } catch {
            if (isCurrent()) {
              stop();
              setState("stopped");
              setMessage("Görüntü okunamadı. Yeniden deneyin veya etiket fotoğrafını seçin.");
            }
          }
        }
        void tick();
      } catch (error) {
        if (isCurrent()) {
          stop();
          setState("stopped");
          setMessage(cameraErrorMessage(error));
        }
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        setState("stopped");
        setMessage("Başka ekrana geçtiğiniz için kamera kapatıldı. Devam etmek için yeniden başlatın.");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void start();
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
    // stop/accept only touch refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, attempt]);

  async function readPhoto(file?: File) {
    if (!file) return;
    stop();
    const current = operation.current;
    setState("photo");
    setMessage("");
    setHint("");
    try {
      if (file.size > MAX_PHOTO_BYTES) {
        throw new Error("Fotoğraf çok büyük. Barkodu yakından, daha küçük bir fotoğrafla tekrar çekin.");
      }
      const reader = await zxing();
      if (operation.current !== current) return;
      const codes = await reader.readStockBarcodes(file);
      if (operation.current !== current) return;
      if (!accept(codes)) {
        setState("stopped");
        setMessage(
          codes.length
            ? "Fotoğrafta birden fazla kod var. Tek barkodun fotoğrafını çekin."
            : "Barkod okunamadı. Net ve yansımasız bir etiket fotoğrafı çekin veya kodu elle girin."
        );
      }
    } catch (error) {
      if (operation.current === current) {
        setState("stopped");
        setMessage(
          error instanceof Error && error.message.startsWith("Fotoğraf çok")
            ? error.message
            : "Fotoğraf okunamadı. JPG veya PNG olarak yeniden deneyin ya da barkodu elle girin."
        );
      }
    }
  }

  const close = () => {
    stop();
    onClose();
  };

  return (
    <StockModal
      title="Kamerayla okut"
      description={
        purpose === "product"
          ? "Yeni ürünün ambalajındaki tek barkodu gösterin. Barkod numarası ürün kartına otomatik yazılır."
          : "Ambalajdaki tek barkodu gösterin. Okuma tamamlanınca ürün bilgilerine döneceksiniz."
      }
      onClose={close}
    >
      <div className="space-y-3">
        <div className="relative grid min-h-52 place-items-center overflow-hidden rounded-lg bg-slate-900">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label="Barkod kamerası"
            className="max-h-[42dvh] w-full object-contain"
          />
          {(state === "starting" || state === "photo") && (
            <div
              role="status"
              className="absolute inset-0 flex items-center justify-center bg-slate-900/85 p-5 text-center text-sm text-white"
            >
              {state === "photo" ? "Fotoğraf okunuyor…" : "Kamera hazırlanıyor; istenirse kamera izni verin."}
            </div>
          )}
        </div>
        {state === "scanning" && (
          <p role="status" className="text-sm text-gray-600">
            {hint || "Kodu netleştirmek için telefonu yavaşça yaklaştırın. Ambalajdaki yansımayı azaltın."}
          </p>
        )}
        {message && (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {message}
          </p>
        )}
        {devices.length > 1 && (
          <label className="block text-sm font-semibold text-gray-800">
            Kamera seçimi
            <select
              className={`${stockInput} mt-1`}
              value={deviceId}
              disabled={state === "photo"}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">Arka kamera (otomatik)</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Kamera ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          {state === "stopped" && (
            <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={() => setAttempt((n) => n + 1)}>
              Yeniden başlat
            </button>
          )}
          <button
            type="button"
            className={`${buttonSecondary} min-h-[44px]`}
            disabled={state === "photo"}
            onClick={() => {
              stop();
              setState("stopped");
              fileRef.current?.click();
            }}
          >
            Etiket fotoğrafı seç
          </button>
          <button type="button" className={`${buttonSecondary} min-h-[44px]`} onClick={close}>
            Kapat
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            aria-label="Etiket fotoğrafı"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void readPhoto(file);
            }}
          />
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const code = manual.trim();
            if (!code) return;
            stop();
            onClose();
            onScan(code);
          }}
        >
          <input
            className={stockInput}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Kodu elle yazın"
            aria-label="Barkodu elle yaz"
            maxLength={MAX_BARCODE_LENGTH}
          />
          <button type="submit" className={`${buttonSecondary} min-h-[44px] whitespace-nowrap`}>
            Kullan
          </button>
        </form>
        <p className="text-xs text-gray-500">
          {purpose === "product"
            ? "Görüntüler telefonunuzda okunur. Ürün bilgilerini tamamlayıp kaydedin; ilk miktarı daha sonra Malzeme geldi ile girin."
            : "Görüntüler telefonunuzda okunur. Stok, bilgileri kontrol edip Hareketi kaydet düğmesine bastığınızda değişir."}
        </p>
      </div>
    </StockModal>
  );
}
