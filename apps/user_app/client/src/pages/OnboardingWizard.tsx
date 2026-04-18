import { useState, useMemo, useEffect, useRef, useCallback, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import {
  Upload,
  Sparkles,
  Users,
  Rocket,
  ArrowRight,
  ArrowLeft,
  Bot,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Plus,
  Minus,
  Loader2,
  Building2,
  Globe,
  Search,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import {
  getPublicModels,
  type ConversationModelInfo,
  type RegisterData,
} from "../api";
import { userNameSchema } from "../validation";
import { VendorIcon } from "../components/VendorModelBadge";

const STEPS = ["Your Organization", "Brand Identity", "Your Team", "Web Search", "Launch"];

interface AgentDraft {
  definition: string;
  description: string;
  modelId: string;
}

type WebSearchChoice = "gemini" | "brave";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "org"
  );
}

/** Resize a client-selected image down to 200x200 and return a base64 data URL. */
async function resizeLogo(file: File, maxDim = 200): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not decode image."));
    el.src = dataUrl;
  });

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported.");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

export default function OnboardingWizard() {
  const navigate = useNavigate();
  const { register, activateSession } = useAuth();

  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [launchPhase, setLaunchPhase] = useState(0); // 0=idle, 1=rings, 2=success, 3=warp, 4=whiteout
  const [launchStatus, setLaunchStatus] = useState("");
  const [error, setError] = useState("");

  // Step 1
  const [orgName, setOrgName] = useState("");

  // Step 2
  const [logo, setLogo] = useState<string | null>(null);
  const [logoError, setLogoError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Step 3
  const [agents, setAgents] = useState<AgentDraft[]>([
    { definition: "", description: "", modelId: "" },
  ]);
  const [models, setModels] = useState<ConversationModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Step 4 — Web search agent choice (Gemini is the default)
  const [webSearchChoice, setWebSearchChoice] = useState<WebSearchChoice>("gemini");

  // Step 5 — admin account
  const [adminUserName, setAdminUserName] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    getPublicModels()
      .then((m) => setModels(m))
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, []);

  const orgSlug = useMemo(() => (orgName ? slugify(orgName) : ""), [orgName]);

  const userNameErrors = useMemo(
    () =>
      adminUserName
        ? (userNameSchema.safeParse(adminUserName).success
            ? []
            : (userNameSchema.safeParse(adminUserName) as any).error.errors.map((e: any) => e.message))
        : [],
    [adminUserName],
  );
  const passwordChecks = useMemo(() => {
    const v = adminPassword;
    return [
      { label: "8+ characters", ok: v.length >= 8 },
      { label: "Lowercase", ok: /[a-z]/.test(v) },
      { label: "Uppercase", ok: /[A-Z]/.test(v) },
      { label: "Digit", ok: /[0-9]/.test(v) },
      { label: "Special char", ok: /[^a-zA-Z0-9]/.test(v) },
    ];
  }, [adminPassword]);
  const passwordOk = passwordChecks.every((c) => c.ok);

  function canAdvance(): boolean {
    if (step === 0) return orgName.trim().length > 0;
    if (step === 1) return true; // logo is optional
    if (step === 2)
      return agents.length > 0 && agents.every((a) => a.definition.trim().length > 0);
    if (step === 3) return webSearchChoice === "gemini" || webSearchChoice === "brave";
    if (step === 4)
      return (
        userNameSchema.safeParse(adminUserName).success &&
        adminDisplayName.trim().length > 0 &&
        passwordOk
      );
    return false;
  }

  async function handleLogoPicked(file: File | null) {
    if (!file) return;
    setLogoError("");
    if (!file.type.startsWith("image/")) {
      setLogoError("Please upload an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError("Logo must be smaller than 5MB.");
      return;
    }
    try {
      const dataUrl = await resizeLogo(file);
      setLogo(dataUrl);
    } catch (err: unknown) {
      setLogoError(err instanceof Error ? err.message : "Could not read image.");
    }
  }

  function updateAgent(i: number, patch: Partial<AgentDraft>) {
    setAgents((cur) => cur.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function addAgent() {
    setAgents((cur) =>
      cur.length >= 5 ? cur : [...cur, { definition: "", description: "", modelId: "" }],
    );
  }
  function removeAgent(i: number) {
    setAgents((cur) => (cur.length <= 1 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  /** Kick off the cinematic launch sequence after registration succeeds. */
  const startLaunchSequence = useCallback(() => {
    // Phase 1: Orbital rings + scanning
    setLaunchPhase(1);
    setLaunchStatus("Initializing systems");

    setTimeout(() => setLaunchStatus("Creating organization"), 1200);
    setTimeout(() => setLaunchStatus("Provisioning agents"), 2200);
    setTimeout(() => setLaunchStatus("Building your reality"), 3200);

    // Phase 2: Success burst
    setTimeout(() => {
      setLaunchPhase(2);
      setLaunchStatus("Systems online");
    }, 4000);

    // Phase 3: Title reveal + warp
    setTimeout(() => {
      setLaunchPhase(3);
      setLaunchStatus("");
    }, 5200);

    // Phase 4: White-out and navigate
    setTimeout(() => setLaunchPhase(4), 7000);
    setTimeout(() => {
      activateSession();
      navigate("/", { replace: true });
    }, 7800);
  }, [navigate, activateSession]);

  async function handleLaunch(e: FormEvent) {
    e.preventDefault();
    if (!canAdvance() || submitting) return;
    setError("");
    setSubmitting(true);

    const payload: RegisterData = {
      organization: {
        name: orgName.trim(),
        ...(logo ? { logo } : {}),
      },
      admin: {
        userName: adminUserName.trim(),
        displayName: adminDisplayName.trim(),
        password: adminPassword,
      },
      agents: agents.map((a) => ({
        definition: a.definition.trim(),
        ...(a.description.trim() ? { description: a.description.trim() } : {}),
        ...(a.modelId ? { modelId: a.modelId } : {}),
      })),
      webSearchChoice,
    };

    try {
      await register(payload);
      startLaunchSequence();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Registration failed.");
      setSubmitting(false);
    }
  }

  return (
    <Stack
      component="main"
      alignItems="center"
      justifyContent="center"
      className="min-h-screen bg-gradient-to-br from-indigo-950 via-slate-900 to-violet-950 px-4 py-10 text-white"
      sx={{ position: "relative", overflow: "hidden" }}
    >
      {/* Floating gradient orbs — the "new world" mood */}
      <Box className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <Box className="animate-onboard-float absolute -top-40 -left-40 h-[28rem] w-[28rem] rounded-full bg-gradient-to-br from-indigo-500/30 to-fuchsia-500/20 blur-3xl" />
        <Box
          className="animate-onboard-float absolute -bottom-40 -right-40 h-[30rem] w-[30rem] rounded-full bg-gradient-to-tr from-violet-500/30 to-sky-500/20 blur-3xl"
          sx={{ animationDelay: "-6s" }}
        />
        <Box
          className="animate-onboard-float absolute top-1/3 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-gradient-to-br from-cyan-400/10 to-indigo-500/10 blur-3xl"
          sx={{ animationDelay: "-12s" }}
        />
      </Box>

      {/* ═══════════════════════════════════════════════════════════════════
          LAUNCH SEQUENCE — Cinematic multi-phase transition overlay
          ═══════════════════════════════════════════════════════════════════ */}
      {launchPhase > 0 && (
        <Box
          className="launch-backdrop fixed inset-0"
          sx={{ zIndex: 50 }}
        >
          {/* Deep space backdrop */}
          <Box className="absolute inset-0 bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950" />

          {/* Hex grid pattern */}
          <Box className="launch-grid absolute inset-0" />

          {/* Floating holographic shards */}
          {launchPhase < 4 && (
            <Box className="absolute inset-0 overflow-hidden" aria-hidden>
              {[
                { w: 60, h: 20, l: '15%', t: '20%', bg: 'rgba(99,102,241,0.08)', r: 15, dur: 5, del: 0.5 },
                { w: 40, h: 12, l: '75%', t: '30%', bg: 'rgba(168,85,247,0.08)', r: -20, dur: 6, del: 1 },
                { w: 80, h: 16, l: '25%', t: '70%', bg: 'rgba(56,189,248,0.06)', r: 10, dur: 4.5, del: 0.8 },
                { w: 50, h: 14, l: '65%', t: '75%', bg: 'rgba(236,72,153,0.06)', r: -25, dur: 5.5, del: 1.5 },
                { w: 35, h: 10, l: '45%', t: '15%', bg: 'rgba(52,211,153,0.06)', r: 30, dur: 7, del: 0.3 },
                { w: 70, h: 18, l: '85%', t: '55%', bg: 'rgba(129,140,248,0.07)', r: -12, dur: 4, del: 2 },
              ].map((s, i) => (
                <div
                  key={i}
                  className="launch-shard"
                  style={{
                    width: s.w, height: s.h, left: s.l, top: s.t,
                    background: s.bg,
                    '--shard-r': `${s.r}deg`,
                    '--shard-dur': `${s.dur}s`,
                    '--shard-delay': `${s.del}s`,
                  } as React.CSSProperties}
                />
              ))}
            </Box>
          )}

          {/* ── Phase 1: Orbital rings + scanning ────────────────────── */}
          {(launchPhase === 1 || launchPhase === 2) && (
            <Box className="absolute inset-0 flex items-center justify-center">
              <Box className="relative" sx={{ width: 280, height: 280 }}>
                {/* Scanning line */}
                {launchPhase === 1 && <div className="launch-scanline" />}

                {/* Orbital rings */}
                <Box className="launch-ring absolute inset-0" />
                <Box className="launch-ring-2 absolute" sx={{ inset: '20px' }} />
                <Box className="launch-ring-3 absolute" sx={{ inset: '44px' }} />

                {/* Core orb */}
                <Box
                  className="launch-core absolute flex items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600"
                  sx={{ inset: '72px' }}
                >
                  {/* Logo or icon inside core */}
                  {logo ? (
                    <Box
                      component="img"
                      src={logo}
                      alt=""
                      className="launch-logo h-16 w-16 rounded-2xl object-cover"
                    />
                  ) : (
                    <Building2
                      className="launch-logo h-12 w-12 text-white/90"
                      strokeWidth={1.5}
                    />
                  )}
                </Box>

                {/* Phase 2 extras: success checkmark + nova */}
                {launchPhase === 2 && (
                  <>
                    {/* Nova burst behind everything */}
                    <Box
                      className="launch-nova absolute"
                      sx={{ inset: '40px' }}
                    />

                    {/* Success badge */}
                    <Box
                      className="launch-checkmark absolute flex items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 shadow-2xl shadow-emerald-500/40"
                      sx={{ width: 48, height: 48, bottom: -8, right: -8 }}
                    >
                      <CheckCircle2 className="h-6 w-6 text-white" strokeWidth={2.5} />
                    </Box>

                    {/* Particles */}
                    {[
                      { px: '120px', py: '-100px', size: 6, bg: '#818cf8', dur: '1.5s', del: '0.1s' },
                      { px: '-130px', py: '-60px', size: 5, bg: '#a78bfa', dur: '1.3s', del: '0.2s' },
                      { px: '80px', py: '120px', size: 4, bg: '#f472b6', dur: '1.4s', del: '0.15s' },
                      { px: '-100px', py: '90px', size: 7, bg: '#38bdf8', dur: '1.6s', del: '0.05s' },
                      { px: '150px', py: '30px', size: 3, bg: '#34d399', dur: '1.2s', del: '0.25s' },
                      { px: '-60px', py: '-130px', size: 5, bg: '#c084fc', dur: '1.5s', del: '0.3s' },
                      { px: '40px', py: '-150px', size: 4, bg: '#fbbf24', dur: '1.3s', del: '0.18s' },
                      { px: '-150px', py: '10px', size: 6, bg: '#6366f1', dur: '1.7s', del: '0.08s' },
                    ].map((p, i) => (
                      <div
                        key={i}
                        className="launch-particle"
                        style={{
                          left: '50%', top: '50%',
                          width: p.size, height: p.size,
                          marginLeft: -p.size / 2, marginTop: -p.size / 2,
                          background: p.bg,
                          '--px': p.px, '--py': p.py,
                          '--pdur': p.dur, '--pdelay': p.del,
                        } as React.CSSProperties}
                      />
                    ))}
                  </>
                )}
              </Box>
            </Box>
          )}

          {/* ── Phase 1 & 2: Status text + progress ──────────────────── */}
          {(launchPhase === 1 || launchPhase === 2) && (
            <Box className="absolute bottom-[20%] left-0 right-0 flex flex-col items-center gap-4 px-8">
              <Box
                key={launchStatus}
                className="launch-status-text flex items-center gap-2 text-sm font-medium tracking-wide text-indigo-200/90"
              >
                {launchPhase === 1 && (
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                )}
                {launchPhase === 2 && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                )}
                <span>{launchStatus}</span>
              </Box>
              <Box className="launch-progress-track w-full" sx={{ maxWidth: 240 }}>
                <Box
                  className="launch-progress-bar"
                  sx={{ '--launch-duration': '4.5s' } as React.CSSProperties}
                />
              </Box>
            </Box>
          )}

          {/* ── Phase 3: Title reveal + warp stars ────────────────────── */}
          {launchPhase === 3 && (
            <Box className="absolute inset-0 flex flex-col items-center justify-center">
              {/* Warp stars */}
              <Box className="absolute inset-0 overflow-hidden" aria-hidden>
                {Array.from({ length: 40 }).map((_, i) => {
                  const angle = (i / 40) * Math.PI * 2;
                  const dist = 30 + Math.random() * 60;
                  return (
                    <div
                      key={i}
                      className="launch-star"
                      style={{
                        left: '50%', top: '50%',
                        '--sx': `${Math.cos(angle) * dist}px`,
                        '--sy': `${Math.sin(angle) * dist}px`,
                        '--sdur': `${0.8 + Math.random() * 0.6}s`,
                        '--sdelay': `${Math.random() * 0.4}s`,
                      } as React.CSSProperties}
                    />
                  );
                })}
              </Box>

              {/* Org logo — large reveal */}
              <Box className="launch-logo mb-6">
                {logo ? (
                  <Box
                    component="img"
                    src={logo}
                    alt=""
                    className="h-24 w-24 rounded-3xl object-cover shadow-2xl shadow-indigo-500/40 ring-2 ring-white/20"
                  />
                ) : (
                  <Box className="flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-2xl shadow-indigo-500/40 ring-2 ring-white/20">
                    <Building2 className="h-12 w-12 text-white/90" strokeWidth={1.5} />
                  </Box>
                )}
              </Box>

              {/* Title */}
              <Box
                component="h2"
                className="launch-title text-center text-4xl font-bold tracking-tight text-white sm:text-5xl"
              >
                Welcome to a new reality.
              </Box>

              {/* Subtitle */}
              <Box className="launch-subtitle mt-3 text-center text-base text-indigo-200/80 sm:text-lg">
                {orgName || "Your organization"} is live.
              </Box>

              {/* Agent count badge */}
              <Box className="launch-subtitle mt-6 flex items-center gap-2 rounded-full bg-white/5 px-4 py-2 text-sm text-indigo-200/70 ring-1 ring-white/10 backdrop-blur-sm">
                <Bot className="h-4 w-4 text-indigo-400" />
                <span>{agents.length} agent{agents.length === 1 ? '' : 's'} ready</span>
                <Sparkles className="h-3 w-3 text-violet-400" />
              </Box>
            </Box>
          )}

          {/* ── Phase 4: White-out transition ─────────────────────────── */}
          {launchPhase === 4 && (
            <Box className="launch-whiteout absolute inset-0 bg-white" />
          )}
        </Box>
      )}

      <Box
        className="relative z-10 w-full"
        sx={{ maxWidth: 720 }}
      >
        {/* Header */}
        <Stack alignItems="center" spacing={1.5} sx={{ mb: 4, textAlign: "center" }} className="animate-fade-in">
          <Stack direction="row" alignItems="center" spacing={1} className="text-xs uppercase tracking-[0.2em] text-indigo-300/80">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Create your organization</span>
          </Stack>
          <Box component="h1" className="text-3xl font-bold tracking-tight sm:text-4xl">
            {step === 0 && "Create Your AI-Powered Organization"}
            {step === 1 && "Define Your Brand Identity"}
            {step === 2 && "Assemble Your Team of Agents"}
            {step === 3 && "Launch Your New Reality"}
          </Box>
          <Box component="p" className="max-w-md text-sm text-indigo-100/70">
            {step === 0 && "Every great team starts with a name. What will yours be?"}
            {step === 1 && "A logo to carry across every conversation — yours will shine."}
            {step === 2 && "These are the minds you'll work with every day."}
            {step === 3 && "You're one click away from a whole new way of working."}
          </Box>
        </Stack>

        {/* Stepper */}
        <Box sx={{ mb: 4 }} className="animate-fade-in">
          <Stepper
            activeStep={step}
            alternativeLabel
            sx={{
              "& .MuiStepLabel-label": {
                color: "rgba(199, 210, 254, 0.55)",
                fontSize: "0.75rem",
                marginTop: "6px",
              },
              "& .MuiStepLabel-label.Mui-active": {
                color: "#fff",
                fontWeight: 600,
              },
              "& .MuiStepLabel-label.Mui-completed": {
                color: "rgba(199, 210, 254, 0.9)",
              },
              "& .MuiStepIcon-root": {
                color: "rgba(99, 102, 241, 0.3)",
                fontSize: "1.75rem",
              },
              "& .MuiStepIcon-root.Mui-active": {
                color: "#6366f1",
                filter: "drop-shadow(0 0 10px rgba(99,102,241,0.6))",
              },
              "& .MuiStepIcon-root.Mui-completed": {
                color: "#10b981",
              },
              "& .MuiStepConnector-line": {
                borderColor: "rgba(99, 102, 241, 0.25)",
              },
            }}
          >
            {STEPS.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>
        </Box>

        {/* Card */}
        <Box
          component="form"
          onSubmit={handleLaunch}
          key={step}
          className="animate-step-in rounded-3xl border border-white/10 bg-white/5 p-6 shadow-glass-lg backdrop-blur-2xl sm:p-8"
        >
          {error && (
            <Box className="mb-4 rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-200 ring-1 ring-red-400/30">
              {error}
            </Box>
          )}

          {/* ── STEP 1 ─────────────────────────────────────────────── */}
          {step === 0 && (
            <Stack spacing={3}>
              <Box>
                <Box component="label" className="mb-2 block text-sm font-medium text-indigo-100">
                  Organization name
                </Box>
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="e.g. Acme Labs"
                  maxLength={120}
                  autoFocus
                  className="block w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white placeholder-indigo-200/40 transition-all duration-200 focus:border-indigo-400 focus:bg-white/10 focus:outline-none focus:ring-4 focus:ring-indigo-500/20"
                />
                {orgSlug && (
                  <Box className="mt-2 flex items-center gap-2 text-xs text-indigo-200/60">
                    <Box component="span" className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-[11px]">
                      /{orgSlug}
                    </Box>
                    <span>This will be your URL slug.</span>
                  </Box>
                )}
              </Box>
            </Stack>
          )}

          {/* ── STEP 2 ─────────────────────────────────────────────── */}
          {step === 1 && (
            <Stack spacing={3}>
              <Box
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
                }}
                className="group relative flex min-h-[180px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-indigo-400/40 bg-white/5 p-6 text-center transition-all duration-200 hover:border-indigo-300/80 hover:bg-white/10"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleLogoPicked(e.target.files?.[0] ?? null)}
                />
                {logo ? (
                  <Box
                    component="img"
                    src={logo}
                    alt="Logo preview"
                    className="animate-scale-in h-24 w-24 rounded-2xl object-cover shadow-xl shadow-indigo-500/30 ring-2 ring-white/20"
                  />
                ) : (
                  <>
                    <Box className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/30 to-violet-500/30 ring-1 ring-white/10">
                      <Upload className="h-6 w-6 text-indigo-200" />
                    </Box>
                    <Box className="text-sm font-medium text-indigo-100">
                      Click or drop your logo here
                    </Box>
                    <Box className="mt-1 text-xs text-indigo-200/60">
                      PNG, JPG, or SVG · resized to 200x200
                    </Box>
                  </>
                )}
              </Box>
              {logoError && (
                <Box className="text-xs text-red-300">{logoError}</Box>
              )}

              {/* Sidebar preview */}
              <Box className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <Box className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-indigo-300/70">
                  Sidebar preview
                </Box>
                <Stack direction="row" alignItems="center" spacing={1.5} className="rounded-xl bg-gradient-to-b from-slate-50 to-gray-50 p-3">
                  {logo ? (
                    <Box
                      component="img"
                      src={logo}
                      alt=""
                      className="h-9 w-9 rounded-xl object-cover shadow-md shadow-indigo-200/50"
                    />
                  ) : (
                    <Box className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-400 to-violet-500 text-white shadow-md">
                      <Building2 className="h-5 w-5" />
                    </Box>
                  )}
                  <Box>
                    <Box component="span" className="block text-sm font-bold tracking-tight text-gray-900">
                      {orgName || "Your Organization"}
                    </Box>
                    <Box component="span" className="block text-[10px] font-medium text-gray-400">
                      Agent Management Interaction Platform
                    </Box>
                  </Box>
                </Stack>
              </Box>

              {logo && (
                <button
                  type="button"
                  onClick={() => setLogo(null)}
                  className="self-start text-xs text-indigo-200/60 underline underline-offset-2 hover:text-indigo-100"
                >
                  Remove logo
                </button>
              )}
            </Stack>
          )}

          {/* ── STEP 3 ─────────────────────────────────────────────── */}
          {step === 2 && (
            <Stack spacing={2.5}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Box className="text-sm text-indigo-100/80">
                  {agents.length} agent{agents.length === 1 ? "" : "s"} · max 5
                </Box>
                <Stack direction="row" spacing={1}>
                  <button
                    type="button"
                    onClick={() => removeAgent(agents.length - 1)}
                    disabled={agents.length <= 1}
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 text-indigo-200 ring-1 ring-white/10 transition hover:bg-white/10 disabled:opacity-30"
                    title="Remove last agent"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={addAgent}
                    disabled={agents.length >= 5}
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/30 text-indigo-50 ring-1 ring-indigo-400/40 transition hover:bg-indigo-500/50 disabled:opacity-30"
                    title="Add agent"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </Stack>
              </Stack>

              <Stack spacing={2}>
                {agents.map((a, i) => (
                  <Box
                    key={i}
                    className="animate-slide-up rounded-2xl border border-white/10 bg-slate-900/40 p-4"
                  >
                    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1.5 }}>
                      <Box className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/40 to-violet-500/40 ring-1 ring-white/10">
                        <Bot className="h-4 w-4 text-indigo-100" />
                      </Box>
                      <Box className="text-sm font-semibold text-indigo-100">
                        Agent #{i + 1}
                      </Box>
                    </Stack>

                    <Box className="grid gap-3 sm:grid-cols-2">
                      <Box>
                        <Box component="label" className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-indigo-200/70">
                          Definition
                        </Box>
                        <input
                          type="text"
                          value={a.definition}
                          onChange={(e) => updateAgent(i, { definition: e.target.value })}
                          placeholder="e.g. Senior backend engineer"
                          maxLength={120}
                          className="block w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-indigo-200/40 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                      </Box>
                      <Box>
                        <Box component="label" className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-indigo-200/70">
                          Model
                        </Box>
                        <Box sx={{ position: "relative" }}>
                          <select
                            value={a.modelId}
                            onChange={(e) => updateAgent(i, { modelId: e.target.value })}
                            disabled={modelsLoading}
                            className="block w-full appearance-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                          >
                            <option value="" className="bg-slate-900">
                              {modelsLoading ? "Loading…" : "Default"}
                            </option>
                            {models
                              .filter((m) => m.vendor?.slug !== "google")
                              .map((m) => (
                                <option key={m.id} value={m.id} className="bg-slate-900">
                                  {m.vendor?.name ? `${m.vendor.name} · ` : ""}
                                  {m.name}
                                </option>
                              ))}
                          </select>
                        </Box>
                      </Box>
                      <Box sx={{ gridColumn: { sm: "span 2" } }}>
                        <Box component="label" className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-indigo-200/70">
                          Description (optional)
                        </Box>
                        <input
                          type="text"
                          value={a.description}
                          onChange={(e) => updateAgent(i, { description: e.target.value })}
                          placeholder="A short summary of this agent's focus"
                          maxLength={1000}
                          className="block w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-indigo-200/40 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                      </Box>
                    </Box>
                  </Box>
                ))}
              </Stack>
            </Stack>
          )}

          {/* ── STEP 4 · Web search agent ─────────────────────────── */}
          {step === 3 && (
            <Stack spacing={3}>
              <Box>
                <Box className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-300/80">
                  Web search agent
                </Box>
                <Box className="mb-4 text-sm text-indigo-100/80">
                  Pick the single dedicated system agent that handles <em>all</em> web
                  searches for your organization. You can switch it later from the
                  admin panel — only one can be active at a time.
                </Box>
                <Stack spacing={2}>
                  {[
                    {
                      key: "gemini" as const,
                      title: "Gemini (Google Search)",
                      icon: <Globe className="h-5 w-5 text-indigo-100" />,
                      subtitle: "Default · powered by Google's built-in web grounding",
                      blurb:
                        "Uses Gemini's built-in Google Search tool — no extra API keys required.",
                    },
                    {
                      key: "brave" as const,
                      title: "Brave Search (MCP)",
                      icon: <Search className="h-5 w-5 text-amber-200" />,
                      subtitle: "Privacy-first · powered by Brave Search via MCP",
                      blurb:
                        "Uses the brave-search MCP server. Requires BRAVE_API_KEY in the environment.",
                    },
                  ].map((opt) => {
                    const selected = webSearchChoice === opt.key;
                    return (
                      <Box
                        key={opt.key}
                        role="button"
                        tabIndex={0}
                        onClick={() => setWebSearchChoice(opt.key)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setWebSearchChoice(opt.key);
                          }
                        }}
                        className={`cursor-pointer rounded-2xl border p-4 transition ${
                          selected
                            ? "border-indigo-400 bg-indigo-500/15 ring-2 ring-indigo-400/40"
                            : "border-white/10 bg-slate-900/40 hover:border-white/20 hover:bg-slate-900/60"
                        }`}
                      >
                        <Stack direction="row" alignItems="flex-start" spacing={1.5}>
                          <Box
                            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-white/10 ${
                              selected
                                ? "bg-gradient-to-br from-indigo-500/50 to-violet-500/50"
                                : "bg-gradient-to-br from-indigo-500/25 to-violet-500/25"
                            }`}
                          >
                            {opt.icon}
                          </Box>
                          <Box className="flex-1">
                            <Stack direction="row" alignItems="center" spacing={1}>
                              <Box className="text-sm font-semibold text-indigo-50">
                                {opt.title}
                              </Box>
                              {selected && (
                                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                              )}
                            </Stack>
                            <Box className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-indigo-300/70">
                              {opt.subtitle}
                            </Box>
                            <Box className="mt-1 text-xs text-indigo-100/70">
                              {opt.blurb}
                            </Box>
                          </Box>
                        </Stack>
                      </Box>
                    );
                  })}
                </Stack>
              </Box>
            </Stack>
          )}

          {/* ── STEP 5 · Admin account + review ───────────────────── */}
          {step === 4 && (
            <Stack spacing={3}>
              <Box>
                <Box className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-indigo-300/80">
                  Admin account
                </Box>
                <Box className="grid gap-3 sm:grid-cols-2">
                  <Box>
                    <Box component="label" className="mb-1 block text-xs font-medium text-indigo-200/80">
                      Username
                    </Box>
                    <input
                      type="text"
                      value={adminUserName}
                      onChange={(e) =>
                        setAdminUserName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
                      }
                      placeholder="e.g. admin"
                      minLength={3}
                      maxLength={30}
                      autoComplete="username"
                      className="block w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-indigo-200/40 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                    {userNameErrors.length > 0 && (
                      <Box className="mt-1 text-[11px] text-amber-300">{userNameErrors[0]}</Box>
                    )}
                  </Box>
                  <Box>
                    <Box component="label" className="mb-1 block text-xs font-medium text-indigo-200/80">
                      Display name
                    </Box>
                    <input
                      type="text"
                      value={adminDisplayName}
                      onChange={(e) => setAdminDisplayName(e.target.value)}
                      placeholder="Your full name"
                      maxLength={100}
                      className="block w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-indigo-200/40 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </Box>
                  <Box sx={{ gridColumn: { sm: "span 2" } }}>
                    <Box component="label" className="mb-1 block text-xs font-medium text-indigo-200/80">
                      Password
                    </Box>
                    <Box className="relative">
                      <input
                        type={showPw ? "text" : "password"}
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder="Strong password"
                        autoComplete="new-password"
                        className="block w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 pr-10 text-sm text-white placeholder-indigo-200/40 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPw((s) => !s)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-indigo-200/60 hover:text-indigo-100"
                        tabIndex={-1}
                      >
                        {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </Box>
                    {adminPassword && (
                      <Stack direction="row" flexWrap="wrap" sx={{ gap: "4px 10px", mt: 1 }}>
                        {passwordChecks.map((c) => (
                          <Box
                            key={c.label}
                            component="span"
                            className={`inline-flex items-center gap-1 text-[10px] font-medium ${
                              c.ok ? "text-emerald-300" : "text-indigo-200/50"
                            }`}
                          >
                            {c.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                            {c.label}
                          </Box>
                        ))}
                      </Stack>
                    )}
                  </Box>
                </Box>
              </Box>

              {/* Summary */}
              <Box className="rounded-2xl border border-white/10 bg-slate-900/40 p-4">
                <Box className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-indigo-300/80">
                  Review
                </Box>
                <Stack spacing={2}>
                  <Stack direction="row" alignItems="center" spacing={1.5}>
                    {logo ? (
                      <Box component="img" src={logo} alt="" className="h-10 w-10 rounded-xl object-cover ring-1 ring-white/10" />
                    ) : (
                      <Box className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/40 to-violet-500/40 ring-1 ring-white/10">
                        <Building2 className="h-5 w-5 text-indigo-100" />
                      </Box>
                    )}
                    <Box>
                      <Box className="text-sm font-semibold">{orgName || "Untitled"}</Box>
                      <Box className="text-[11px] text-indigo-200/60">/{orgSlug || "…"}</Box>
                    </Box>
                  </Stack>
                  <Box className="border-t border-white/5" />
                  <Stack spacing={1}>
                    {agents.map((a, i) => (
                      <Stack key={i} direction="row" alignItems="center" spacing={1.5}>
                        <Box className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/10">
                          <Bot className="h-3 w-3 text-indigo-100" />
                        </Box>
                        <Box className="flex-1 truncate text-xs text-indigo-100">
                          {a.definition || `Agent #${i + 1}`}
                        </Box>
                        {a.modelId && (
                          <Box className="text-[10px] text-indigo-200/60">
                            {(() => {
                              const m = models.find((x) => x.id === a.modelId);
                              return m ? (
                                <Stack direction="row" alignItems="center" spacing={0.5}>
                                  {m.vendor?.slug && <VendorIcon slug={m.vendor.slug} />}
                                  <span>{m.name}</span>
                                </Stack>
                              ) : null;
                            })()}
                          </Box>
                        )}
                      </Stack>
                    ))}
                  </Stack>
                  <Box className="border-t border-white/5" />
                  <Stack direction="row" alignItems="center" spacing={1.5}>
                    <Box className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/10">
                      {webSearchChoice === "brave" ? (
                        <Search className="h-3 w-3 text-amber-200" />
                      ) : (
                        <Globe className="h-3 w-3 text-indigo-100" />
                      )}
                    </Box>
                    <Box className="flex-1 text-xs text-indigo-100">
                      Web search ·{" "}
                      <Box component="span" className="font-semibold">
                        {webSearchChoice === "brave"
                          ? "Brave Search (MCP)"
                          : "Gemini (Google Search)"}
                      </Box>
                    </Box>
                  </Stack>
                </Stack>
              </Box>
            </Stack>
          )}

          {/* Footer nav */}
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 4 }}>
            <button
              type="button"
              onClick={() => {
                if (step === 0) navigate("/login");
                else setStep((s) => s - 1);
              }}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-indigo-200/80 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
            >
              <ArrowLeft className="h-4 w-4" />
              {step === 0 ? "Back to sign in" : "Back"}
            </button>

            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => canAdvance() && setStep((s) => s + 1)}
                disabled={!canAdvance()}
                className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition-all duration-200 ${
                  canAdvance()
                    ? "bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-400 hover:to-violet-400"
                    : "cursor-not-allowed bg-white/10"
                }`}
              >
                {step === 0 && <><Users className="h-4 w-4" /> Continue</>}
                {step === 1 && <>Continue <ArrowRight className="h-4 w-4" /></>}
                {step === 2 && <>Continue <ArrowRight className="h-4 w-4" /></>}
                {step === 3 && <>Continue <ArrowRight className="h-4 w-4" /></>}
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canAdvance() || submitting}
                className={`group animate-onboard-glow relative inline-flex items-center gap-2 overflow-hidden rounded-xl px-6 py-3 text-sm font-bold text-white transition-all duration-200 ${
                  canAdvance() && !submitting
                    ? "bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500"
                    : "cursor-not-allowed bg-white/10"
                }`}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Launching…
                  </>
                ) : (
                  <>
                    <Rocket className="h-4 w-4" />
                    Launch Your Organization
                  </>
                )}
              </button>
            )}
          </Stack>
        </Box>
      </Box>
    </Stack>
  );
}
