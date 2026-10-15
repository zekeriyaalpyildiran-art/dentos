// Camera stream lifecycle (spec p7_rules_ui §14.4). A permission prompt can resolve after its dialog has closed:
// that late stream is stopped too, and an older request can never replace a newer one.

export class CameraSession {
  private generation = 0;
  private stream: MediaStream | null = null;

  stop(): void {
    this.generation++;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  async open(devices: Pick<MediaDevices, "getUserMedia">, deviceId?: string): Promise<MediaStream> {
    this.stop();
    const generation = this.generation;
    const stream = await devices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Camera closed", "AbortError");
    }
    this.stream = stream;
    return stream;
  }
}

export function cameraErrorMessage(error: unknown): string {
  const name =
    error && typeof error === "object" && "name" in error && typeof (error as { name: unknown }).name === "string"
      ? (error as { name: string }).name
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Kamera izni verilmedi. Tarayıcı ayarlarından kamera iznini açın veya aşağıdan etiket fotoğrafını seçin.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Kamera bulunamadı. Başka bir kamera seçin veya etiket fotoğrafını kullanın.";
  }
  if (name === "NotReadableError") {
    return "Kamera başka bir uygulamada açık olabilir. O uygulamayı kapatıp yeniden deneyin.";
  }
  return "Kamera veya okuyucu başlatılamadı. Yeniden deneyin; gerekirse sayfayı Safari veya Chrome'da doğrudan açın.";
}
