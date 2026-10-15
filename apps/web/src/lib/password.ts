// Rules and messages for setting a new password (invite and "Şifremi unuttum" links, /reset-password).

export const MIN_PASSWORD_LENGTH = 10;

export const PASSWORD_TEXTS = {
  tooShort: `Şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı.`,
  hint: `En az ${MIN_PASSWORD_LENGTH} karakter.`,
  mismatch: "Şifreler eşleşmiyor.",
  pwned:
    "Bu şifre internette sızdırılmış şifre listelerinde geçiyor, güvenli değil. Lütfen başka bir şifre seçin.",
  characters: "Şifre yeterince güçlü değil. Büyük harf, küçük harf, rakam ve sembolü birlikte kullanın.",
  length: "Şifre çok kısa. Lütfen daha uzun bir şifre seçin.",
  weak: "Şifre yeterince güçlü değil. Daha uzun ve tahmin edilmesi zor bir şifre seçin.",
  samePassword: "Yeni şifre eski şifrenizle aynı olamaz. Lütfen farklı bir şifre seçin.",
  network: "Bağlantı hatası. İnternet bağlantınızı kontrol edip tekrar deneyin.",
  generic: "Şifre güncellenemedi. Bağlantı geçersiz olabilir, yeni bir bağlantı isteyin.",
} as const;

/** Checks the form before anything is sent; null when the password may be submitted. */
export function newPasswordError(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return PASSWORD_TEXTS.tooShort;
  if (password !== confirm) return PASSWORD_TEXTS.mismatch;
  return null;
}

/** Turkish message for an error from supabase.auth.updateUser({ password }). */
export function passwordUpdateErrorMessage(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; reasons?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const code = typeof e?.code === "string" ? e.code : "";
  const message = (typeof e?.message === "string" ? e.message : "").toLocaleLowerCase("en-US");

  if (code === "weak_password" || name === "AuthWeakPasswordError") {
    const reasons: unknown[] = Array.isArray(e?.reasons) ? (e?.reasons as unknown[]) : [];
    if (reasons.includes("pwned")) return PASSWORD_TEXTS.pwned;
    if (reasons.includes("characters")) return PASSWORD_TEXTS.characters;
    if (reasons.includes("length")) return PASSWORD_TEXTS.length;
    return PASSWORD_TEXTS.weak;
  }
  if (code === "same_password") return PASSWORD_TEXTS.samePassword;
  if (
    name === "AuthRetryableFetchError" ||
    err instanceof TypeError ||
    message.includes("failed to fetch") ||
    message.includes("network")
  ) {
    return PASSWORD_TEXTS.network;
  }
  return PASSWORD_TEXTS.generic;
}
