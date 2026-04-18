import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Container from "@mui/material/Container";
import { useAuth } from "../context/AuthContext";
import { Loader2, Eye, EyeOff, Sparkles } from "lucide-react";
import logo from "../assets/logo.svg";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [loginUserName, setLoginUserName] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(loginUserName.trim(), password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "mb-4 block w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-3 text-sm placeholder-gray-400 transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10";

  return (
    <Stack
      component="main"
      alignItems="center"
      justifyContent="center"
      className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50/40 px-4"
      sx={{ position: "relative", overflow: "hidden" }}
    >
      <Box
        className="pointer-events-none fixed inset-0 overflow-hidden"
        aria-hidden
      >
        <Box
          className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-gradient-to-br from-blue-100/40 to-indigo-100/40 blur-3xl"
        />
        <Box
          className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-gradient-to-tr from-violet-100/30 to-blue-100/30 blur-3xl"
        />
      </Box>

      <Container
        maxWidth={false}
        disableGutters
        className="animate-fade-in relative z-10"
        sx={{ width: "100%", maxWidth: 384 }}
      >
        <Stack spacing={0} alignItems="stretch">
          <Stack spacing={2} alignItems="center" sx={{ mb: 4, textAlign: "center" }}>
            <Box
              component="img"
              src={logo}
              alt="Logo"
              className="h-16 w-16 rounded-2xl object-cover shadow-lg shadow-indigo-200/60"
            />
            <Box component="h1" className="text-2xl font-bold tracking-tight text-gray-900">
              Agent Management System
            </Box>
            <Box component="p" className="mt-1.5 text-sm text-gray-500">
              Sign in to your organization
            </Box>
          </Stack>

          <Box
            component="form"
            onSubmit={handleLogin}
            className="animate-slide-up rounded-2xl border border-gray-200/60 bg-white/90 p-6 shadow-glass-lg backdrop-blur-xl"
          >
            {error && (
              <Box className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-100">
                {error}
              </Box>
            )}

            <Box component="label" className="mb-1.5 block text-sm font-medium text-gray-700">
              Username
            </Box>
            <input
              type="text"
              value={loginUserName}
              onChange={(e) => setLoginUserName(e.target.value)}
              placeholder="e.g. john_doe"
              required
              autoComplete="username"
              className={inputClass}
            />

            <Box component="label" className="mb-1.5 block text-sm font-medium text-gray-700">
              Password
            </Box>
            <Box className="relative mb-6">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                className="block w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-3 pr-11 text-sm placeholder-gray-400 transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10"
              />
              <Box
                component="button"
                type="button"
                onClick={() => setShowPw(!showPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition hover:text-gray-600"
                tabIndex={-1}
              >
                {showPw ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Box>
            </Box>

            <Box
              component="button"
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-200/50 transition-all duration-200 hover:shadow-lg hover:shadow-indigo-200/60 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 active:scale-[0.98] disabled:opacity-60 disabled:shadow-none"
            >
              {submitting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                "Sign in"
              )}
            </Box>
          </Box>

          {/* Register CTA — navigates to the onboarding wizard */}
          <Box className="mt-5 text-center">
            <Box component="p" className="text-sm text-gray-500">
              Don't have an organization yet?
            </Box>
            <button
              type="button"
              onClick={() => navigate("/onboarding")}
              className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-50 to-violet-50 px-5 py-2.5 text-sm font-semibold text-indigo-600 ring-1 ring-indigo-100 transition-all duration-200 hover:from-indigo-100 hover:to-violet-100 hover:shadow-sm"
            >
              <Sparkles className="h-4 w-4" />
              Create your organization
            </button>
          </Box>
        </Stack>
      </Container>
    </Stack>
  );
}
