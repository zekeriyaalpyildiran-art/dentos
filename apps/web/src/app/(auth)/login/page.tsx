"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, signOut, getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { homePathFor } from "@/lib/nav";

function loginErrorMessage(err: unknown) {
  const message = err instanceof Error ? err.message : "";
  if (message === "Invalid login credentials") return "E-posta veya şifre hatalı.";
  if (message === "Email not confirmed") return "E-posta adresiniz henüz doğrulanmamış.";
  return "Giriş yapılamadı. Lütfen tekrar deneyin.";
}

function resetErrorMessage(err: unknown) {
  const e = err as { name?: string; message?: string; status?: number } | null;
  const message = (e?.message || "").toLocaleLowerCase("tr-TR");
  if (e?.status === 429 || message.includes("rate limit") || message.includes("security purposes")) {
    return "Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.";
  }
  if (
    e?.name === "AuthRetryableFetchError" ||
    err instanceof TypeError ||
    message.includes("failed to fetch") ||
    message.includes("network")
  ) {
    return "Bağlantı hatası. İnternet bağlantınızı kontrol edip tekrar deneyin.";
  }
  // Other errors are treated as success so the response never reveals whether the email exists.
  return null;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      await signIn(email, password);
    } catch (err) {
      setError(loginErrorMessage(err));
      setLoading(false);
      return;
    }

    try {
      const user = await getCurrentUser();
      if (!user) {
        await signOut().catch(() => {});
        setError("Bu hesap bir kliniğe bağlı değil veya pasif durumda. Yöneticinizle iletişime geçin.");
        return;
      }
      // Straight to the role's start page; the store gets the user now so the panel does not wait for the
      // auth listener's own lookup.
      useAuthStore.getState().setUser(user);
      router.push(homePathFor(user.role));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError(null);
    setInfo(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Önce e-posta adresinizi yazın.");
      return;
    }

    setResetLoading(true);
    try {
      const { error: resetError } = await createClient().auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: window.location.origin + "/reset-password",
      });
      const message = resetError ? resetErrorMessage(resetError) : null;
      if (message) {
        setError(message);
      } else {
        setInfo("Şifre sıfırlama bağlantısı e-posta adresinize gönderildi.");
      }
    } catch (err) {
      setError(resetErrorMessage(err) || "Bağlantı hatası. İnternet bağlantınızı kontrol edip tekrar deneyin.");
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-blue-50 flex items-center justify-center p-4">
      {/* Decorative elements */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-blue-100 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-pulse" />
      <div className="absolute bottom-0 left-0 w-96 h-96 bg-blue-200 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-pulse" />
      
      <div className="relative w-full max-w-md">
        {/* Login Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8 md:p-10 space-y-8">
          {/* Logo & Title */}
          <div className="text-center space-y-3">
            <div className="flex justify-center">
              <span className="text-5xl">🦷</span>
            </div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-blue-800 bg-clip-text text-transparent">
              DentOS
            </h1>
            <p className="text-gray-600 text-lg font-medium">
              Diş Kliniği Yönetim Sistemi
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email Input */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-gray-900">
                📧 E-posta Adresiniz
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 text-base border-2 border-gray-200 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition bg-gray-50 hover:bg-white"
                placeholder="ahmet@klinik.com"
                required
              />
            </div>

            {/* Password Input */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-gray-900">
                🔒 Şifre
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 text-base border-2 border-gray-200 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition bg-gray-50 hover:bg-white"
                placeholder="••••••••"
                required
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={loading || resetLoading}
                  className="text-sm text-blue-600 font-semibold hover:underline disabled:text-gray-500 disabled:cursor-not-allowed disabled:no-underline"
                >
                  {resetLoading ? "Gönderiliyor..." : "Şifremi unuttum"}
                </button>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="bg-red-50 border-2 border-red-200 text-red-700 p-4 rounded-lg text-sm font-medium flex items-start gap-3">
                <span>⚠️</span>
                <div>{error}</div>
              </div>
            )}

            {info && (
              <div className="bg-green-50 border-2 border-green-200 text-green-700 p-4 rounded-lg text-sm font-medium flex items-start gap-3">
                <span>✅</span>
                <div>{info}</div>
              </div>
            )}

            {/* Login Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-bold py-3 px-4 rounded-lg transition duration-200 transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 text-lg shadow-lg"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="animate-spin">⏳</span>
                  Giriş yapılıyor...
                </span>
              ) : (
                "Giriş Yap"
              )}
            </button>
          </form>

          {/* Test Credentials: rendered only outside production */}
          {process.env.NODE_ENV !== "production" && (
            <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4 space-y-2">
              <p className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                💡 Demo Giriş Bilgileri
              </p>
              <div className="space-y-1 text-sm text-gray-700">
                <p className="font-mono bg-white px-3 py-2 rounded border border-blue-200">
                  📧 ahmet@klinik-maltepe.com
                </p>
                <p className="font-mono bg-white px-3 py-2 rounded border border-blue-200">
                  🔑 password
                </p>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="text-center pt-4 border-t border-gray-200">
            <p className="text-gray-600 text-sm">
              Sorununuz mu var?{" "}
              <a href="/" className="text-blue-600 font-semibold hover:underline">
                Ana sayfaya dön
              </a>
            </p>
          </div>
        </div>

        {/* Info Card */}
        <div className="mt-6 bg-white rounded-lg shadow p-4 text-center text-gray-600 text-sm">
          ✨ 100% Türkçe • KVKK Uyumlu • Üretim Hazır
        </div>
      </div>
    </div>
  );
}
