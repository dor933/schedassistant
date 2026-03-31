import { useState, useMemo, type FormEvent } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Container from "@mui/material/Container";
import { useAuth } from "../context/AuthContext";
import { Loader2, Eye, EyeOff, CheckCircle2, XCircle } from "lucide-react";
import logo from "../assets/logo.svg";
import { userNameSchema, passwordSchema, registerSchema } from "../validation";

/** Validate a single zod schema against a value, returning error messages. */
function getErrors(schema: { safeParse: (v: unknown) => { success: boolean; error?: { errors: { message: string }[] } } }, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error?.errors.map((e) => e.message) ?? [];
}

export default function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");

  const [loginUserName, setLoginUserName] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [regUserName, setRegUserName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [showRegPw, setShowRegPw] = useState(false);
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState("");
  const [locationAndTimezone, setLocationAndTimezone] = useState("");

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const userNameErrors = useMemo(() => regUserName ? getErrors(userNameSchema, regUserName) : [], [regUserName]);
  const passwordErrors = useMemo(() => regPassword ? getErrors(passwordSchema, regPassword) : [], [regPassword]);

  const passwordChecks = useMemo(() => {
    const v = regPassword;
    return [
      { label: "8+ characters", ok: v.length >= 8 },
      { label: "Lowercase letter", ok: /[a-z]/.test(v) },
      { label: "Uppercase letter", ok: /[A-Z]/.test(v) },
      { label: "Digit", ok: /[0-9]/.test(v) },
      { label: "Special character", ok: /[^a-zA-Z0-9]/.test(v) },
    ];
  }, [regPassword]);

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

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError("");

    const userIdentity: Record<string, string> = {};
    if (role) userIdentity.role = role;
    if (department) userIdentity.department = department;
    if (locationAndTimezone.trim())
      userIdentity.location = locationAndTimezone.trim();

    const parsed = registerSchema.safeParse({
      userName: regUserName.trim(),
      displayName: displayName.trim(),
      password: regPassword,
      userIdentity: Object.keys(userIdentity).length > 0 ? userIdentity : undefined,
    });

    if (!parsed.success) {
      setError(parsed.error.errors[0]?.message ?? "Invalid input.");
      return;
    }

    setSubmitting(true);
    try {
      await register(parsed.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Registration failed");
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
              {mode === "login" ? "Sign In" : "Create your account"}
            </Box>
          </Stack>

          <Stack
            direction="row"
            className="mb-5 rounded-2xl border border-gray-200/80 bg-gray-100/80 p-1 backdrop-blur-sm"
            sx={{ width: "100%" }}
          >
            <Box
              component="button"
              type="button"
              onClick={() => {
                setMode("login");
                setError("");
              }}
              className={`flex-1 rounded-xl py-2.5 text-sm font-semibold transition-all duration-200 ${
                mode === "login"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Sign In
            </Box>
            <Box
              component="button"
              type="button"
              onClick={() => {
                setMode("register");
                setError("");
              }}
              className={`flex-1 rounded-xl py-2.5 text-sm font-semibold transition-all duration-200 ${
                mode === "register"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Register
            </Box>
          </Stack>

          {mode === "login" ? (
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
          ) : (
            <Box
              component="form"
              onSubmit={handleRegister}
              className="animate-slide-up rounded-2xl border border-gray-200/60 bg-white/90 p-6 shadow-glass-lg backdrop-blur-xl"
            >
              {error && (
                <Box className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-100">
                  {error}
                </Box>
              )}

              <Box component="label" className="mb-1.5 block text-sm font-medium text-gray-700">
                Username <span className="text-red-400">*</span>
              </Box>
              <input
                type="text"
                value={regUserName}
                onChange={(e) => setRegUserName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                placeholder="e.g. john_doe"
                required
                minLength={3}
                maxLength={30}
                autoComplete="username"
                className={inputClass}
              />
              {regUserName && userNameErrors.length > 0 && (
                <Box component="p" className="-mt-3 mb-3 text-[11px] text-amber-600">
                  {userNameErrors[0]}
                </Box>
              )}

              <Box component="label" className="mb-1.5 block text-sm font-medium text-gray-700">
                Display Name <span className="text-red-400">*</span>
              </Box>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your full name"
                required
                className={inputClass}
              />

              <Box component="label" className="mb-1.5 block text-sm font-medium text-gray-700">
                Password <span className="text-red-400">*</span>
              </Box>
              <Box className="relative mb-2">
                <input
                  type={showRegPw ? "text" : "password"}
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  placeholder="Strong password"
                  required
                  className="block w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-3 pr-11 text-sm placeholder-gray-400 transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10"
                />
                <Box
                  component="button"
                  type="button"
                  onClick={() => setShowRegPw(!showRegPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showRegPw ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Box>
              </Box>

              {regPassword && (
                <Stack direction="row" flexWrap="wrap" sx={{ gap: "4px 12px", mb: 2 }}>
                  {passwordChecks.map((c) => (
                    <Box
                      key={c.label}
                      component="span"
                      className={`inline-flex items-center gap-1 text-[10px] font-medium ${
                        c.ok ? "text-emerald-600" : "text-gray-400"
                      }`}
                    >
                      {c.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      {c.label}
                    </Box>
                  ))}
                </Stack>
              )}

              <Box className="mb-3 border-t border-gray-100 pt-3">
                <Box component="p" className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  Profile (optional)
                </Box>
              </Box>

              <Box className="grid grid-cols-2 gap-3">
                <Box>
                  <Box component="label" className="mb-1 block text-xs font-medium text-gray-500">
                    Role
                  </Box>
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="e.g. Engineer"
                    className={inputClass}
                  />
                </Box>
                <Box>
                  <Box component="label" className="mb-1 block text-xs font-medium text-gray-500">
                    Department
                  </Box>
                  <input
                    type="text"
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    placeholder="e.g. R&D"
                    className={inputClass}
                  />
                </Box>
                <Box className="col-span-2">
                  <Box component="label" className="mb-1 block text-xs font-medium text-gray-500">
                    Location &amp; timezone
                  </Box>
                  <input
                    type="text"
                    value={locationAndTimezone}
                    onChange={(e) => setLocationAndTimezone(e.target.value)}
                    placeholder="e.g. Israel (Asia/Jerusalem)"
                    className={inputClass}
                  />
                </Box>
              </Box>

              <Box
                component="button"
                type="submit"
                disabled={submitting || userNameErrors.length > 0 || passwordErrors.length > 0}
                className="flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-200/50 transition-all duration-200 hover:shadow-lg hover:shadow-indigo-200/60 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 active:scale-[0.98] disabled:opacity-60 disabled:shadow-none"
              >
                {submitting ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  "Create Account"
                )}
              </Box>
            </Box>
          )}
        </Stack>
      </Container>
    </Stack>
  );
}
