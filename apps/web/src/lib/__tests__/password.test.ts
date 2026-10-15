// New-password rules and messages (/reset-password). Synthetic values only.

import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, PASSWORD_TEXTS, newPasswordError, passwordUpdateErrorMessage } from "../password";

describe("newPasswordError", () => {
  it("requires at least 10 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(PASSWORD_TEXTS.tooShort).toBe("Şifre en az 10 karakter olmalı.");
    expect(PASSWORD_TEXTS.hint).toBe("En az 10 karakter.");
    expect(newPasswordError("", "")).toBe(PASSWORD_TEXTS.tooShort);
    expect(newPasswordError("abcdefghi", "abcdefghi")).toBe(PASSWORD_TEXTS.tooShort);
    expect(newPasswordError("abcdefghij", "abcdefghij")).toBeNull();
  });

  it("checks the length before the confirmation", () => {
    expect(newPasswordError("short", "other")).toBe(PASSWORD_TEXTS.tooShort);
    expect(newPasswordError("abcdefghij", "abcdefghiJ")).toBe(PASSWORD_TEXTS.mismatch);
  });
});

describe("passwordUpdateErrorMessage", () => {
  const weak = (reasons: string[]) => ({
    name: "AuthWeakPasswordError",
    code: "weak_password",
    status: 422,
    message: "Password should be at least 10 characters.",
    reasons,
  });

  it("explains a weak_password refusal by its reason", () => {
    expect(passwordUpdateErrorMessage(weak(["pwned"]))).toBe(PASSWORD_TEXTS.pwned);
    expect(passwordUpdateErrorMessage(weak(["length", "pwned"]))).toBe(PASSWORD_TEXTS.pwned);
    expect(passwordUpdateErrorMessage(weak(["characters"]))).toBe(PASSWORD_TEXTS.characters);
    expect(passwordUpdateErrorMessage(weak(["length"]))).toBe(PASSWORD_TEXTS.length);
    expect(passwordUpdateErrorMessage(weak([]))).toBe(PASSWORD_TEXTS.weak);
    expect(passwordUpdateErrorMessage({ code: "weak_password" })).toBe(PASSWORD_TEXTS.weak);
    expect(passwordUpdateErrorMessage({ name: "AuthWeakPasswordError" })).toBe(PASSWORD_TEXTS.weak);
  });

  it("never shows the invalid-link text for a weak password", () => {
    for (const reasons of [["pwned"], ["characters"], ["length"], []]) {
      expect(passwordUpdateErrorMessage(weak(reasons))).not.toBe(PASSWORD_TEXTS.generic);
    }
  });

  it("handles the same password and network failures", () => {
    expect(passwordUpdateErrorMessage({ name: "AuthApiError", code: "same_password", status: 422 })).toBe(
      PASSWORD_TEXTS.samePassword,
    );
    expect(passwordUpdateErrorMessage({ name: "AuthRetryableFetchError", message: "Failed to fetch" })).toBe(
      PASSWORD_TEXTS.network,
    );
    expect(passwordUpdateErrorMessage(new TypeError("Failed to fetch"))).toBe(PASSWORD_TEXTS.network);
  });

  it("falls back to the invalid-link text for anything else", () => {
    expect(passwordUpdateErrorMessage({ name: "AuthSessionMissingError", message: "Auth session missing!" })).toBe(
      PASSWORD_TEXTS.generic,
    );
    expect(passwordUpdateErrorMessage(null)).toBe(PASSWORD_TEXTS.generic);
    expect(passwordUpdateErrorMessage("boom")).toBe(PASSWORD_TEXTS.generic);
  });
});
