import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { APP_URL_PREFIX } from "../constants";

/**
 * Platform-admin login lives at `/platform-admin/login` and is completely
 * disjoint from the tenant login flow:
 *
 *  - different token (stored under `platformAdminToken`, never `token`)
 *  - different endpoint (`/api/platform/auth/login`, not `/api/auth/login`)
 *  - no AuthContext, no org lookup, no onboarding redirect
 *
 * Keeping the two flows physically separate guarantees that mounting this
 * page can never accidentally elevate a tenant session, and vice-versa.
 */
export default function PlatformAdminLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${APP_URL_PREFIX}/api/platform/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `Login failed (${res.status})`);
      }
      localStorage.setItem("platformAdminToken", body.token);
      navigate("/platform-admin", { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/20 ring-1 ring-amber-400/40">
            <ShieldCheck className="h-7 w-7 text-amber-300" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Global admin sign in
          </h1>
          <p className="text-sm text-slate-400">
            Platform-wide catalog management. Tenant accounts cannot sign in here.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-700 bg-slate-800/70 p-6 shadow-xl backdrop-blur"
        >
          {error && (
            <div className="mb-4 rounded-xl bg-red-900/40 px-4 py-3 text-sm text-red-200 ring-1 ring-red-800/70">
              {error}
            </div>
          )}

          <label className="mb-1.5 block text-sm font-medium text-slate-200">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
            placeholder="admin@company.com"
            className="mb-4 block w-full rounded-xl border border-slate-600 bg-slate-900/60 px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-4 focus:ring-amber-500/20"
          />

          <label className="mb-1.5 block text-sm font-medium text-slate-200">
            Password
          </label>
          <div className="relative mb-6">
            <input
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="block w-full rounded-xl border border-slate-600 bg-slate-900/60 px-4 py-3 pr-11 text-sm text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-4 focus:ring-amber-500/20"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              tabIndex={-1}
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-900 shadow-md transition hover:bg-amber-400 focus:outline-none focus:ring-4 focus:ring-amber-500/30 active:scale-[0.98] disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : "Sign in"}
          </button>
        </form>

        <div className="mt-5 text-center">
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="text-sm text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
          >
            Back to tenant sign in
          </button>
        </div>
      </div>
    </main>
  );
}
