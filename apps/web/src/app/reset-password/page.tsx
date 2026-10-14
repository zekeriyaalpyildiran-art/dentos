"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";

const inputClass =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        setReady(true);
        setChecking(false);
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
      setChecking(false);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Şifre en az 8 karakter olmalı.");
      return;
    }
    if (password !== confirm) {
      setError("Şifreler eşleşmiyor.");
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      router.push("/dashboard");
    } catch (err) {
      console.error("Error updating password:", err);
      setError("Şifre güncellenemedi. Bağlantı geçersiz olabilir, yeni bir bağlantı isteyin.");
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-8 space-y-6">
        <div className="text-center space-y-2">
          <span className="text-5xl">🦷</span>
          <h1 className="text-2xl font-bold text-gray-900">Yeni Şifre Belirle</h1>
        </div>

        {checking && <p className="text-center text-gray-600">Bağlantı kontrol ediliyor...</p>}

        {!checking && !ready && (
          <div className="space-y-4 text-center">
            <p className="text-red-700 bg-red-50 border border-red-200 rounded-lg p-4">
              Bu bağlantı geçersiz veya süresi dolmuş. Lütfen yeni bir şifre sıfırlama bağlantısı isteyin.
            </p>
            <Link href="/login" className="text-blue-600 hover:underline">
              Giriş sayfasına dön
            </Link>
          </div>
        )}

        {!checking && ready && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Yeni şifre</label>
              <input
                type="password"
                className={inputClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Yeni şifre (tekrar)</label>
              <input
                type="password"
                className={inputClass}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-500"
            >
              {saving ? "Kaydediliyor..." : "Şifreyi Kaydet"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
