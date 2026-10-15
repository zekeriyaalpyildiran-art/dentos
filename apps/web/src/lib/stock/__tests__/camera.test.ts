// Camera session vectors V44-V46 (spec p7_rules_ui §14.5). Fake streams only; no device access.

import { describe, expect, it } from "vitest";
import { CameraSession, cameraErrorMessage } from "../camera-session";

function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("CameraSession", () => {
  it("V44: a stream that arrives after stop() is stopped and open rejects with AbortError", async () => {
    const session = new CameraSession();
    const pending = deferred<MediaStream>();
    const devices = { getUserMedia: () => pending.promise };
    const opened = session.open(devices);
    session.stop();
    const late = fakeStream();
    pending.resolve(late.stream);
    await expect(opened).rejects.toMatchObject({ name: "AbortError" });
    expect(late.track.stopped).toBe(true);
  });

  it("V45: an older request can never replace a newer one", async () => {
    const session = new CameraSession();
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const queue = [first.promise, second.promise];
    const devices = { getUserMedia: () => queue.shift()! };
    const openFirst = session.open(devices);
    const openSecond = session.open(devices);
    const s2 = fakeStream();
    second.resolve(s2.stream);
    await expect(openSecond).resolves.toBe(s2.stream);
    const s1 = fakeStream();
    first.resolve(s1.stream);
    await expect(openFirst).rejects.toMatchObject({ name: "AbortError" });
    expect(s1.track.stopped).toBe(true);
    expect(s2.track.stopped).toBe(false);
    session.stop();
    expect(s2.track.stopped).toBe(true);
  });

  it("passes the device id or the environment camera", async () => {
    const calls: MediaStreamConstraints[] = [];
    const devices = {
      getUserMedia: (c?: MediaStreamConstraints) => {
        calls.push(c!);
        return Promise.resolve(fakeStream().stream);
      },
    };
    const session = new CameraSession();
    await session.open(devices, "cam-2");
    await session.open(devices);
    expect(calls[0]).toMatchObject({ audio: false, video: { deviceId: { exact: "cam-2" } } });
    expect(calls[1]).toMatchObject({ audio: false, video: { facingMode: { ideal: "environment" } } });
  });
});

describe("cameraErrorMessage", () => {
  it("V46: messages by error name", () => {
    const msg = (name: string) => cameraErrorMessage(Object.assign(new Error("x"), { name }));
    expect(msg("NotAllowedError")).toBe(msg("SecurityError"));
    expect(msg("NotAllowedError")).toContain("Kamera izni verilmedi");
    expect(msg("NotFoundError")).toBe(msg("OverconstrainedError"));
    expect(msg("NotFoundError")).toContain("Kamera bulunamadı");
    expect(msg("NotReadableError")).toContain("başka bir uygulamada açık");
    expect(msg("Other")).toContain("Kamera veya okuyucu başlatılamadı");
    expect(cameraErrorMessage(new DOMException("x", "NotAllowedError"))).toContain("Kamera izni verilmedi");
  });
});
