import { useState, useMemo, useEffect, useRef, type FormEvent } from "react";
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
  ShieldCheck,
  Copy,
  ExternalLink,
  ChevronDown,
  KeyRound,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import {
  getPublicModels,
  googleBootstrap,
  googleVerifyDomain,
  type BootstrapTxtRecord,
  type ConversationModelInfo,
  type GoogleBootstrapIdentity,
  type RegisterData,
} from "../api";
import { GOOGLE_CLIENT_ID } from "../constants";
import {
  registerGoogleIdentity,
  renderGoogleButton,
} from "../lib/googleIdentity";
import { userNameSchema } from "../validation";
import { VendorIcon } from "../components/VendorModelBadge";
import LaunchAnimation from "../components/LaunchAnimation";

const STEPS = [
  "Sign-In",
  "Your Organization",
  "Brand Identity",
  "Your Team",
  "Web Search",
  "Launch",
];

type SignInMethod = "google" | "password";

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

/**
 * Derive a reasonable default org name from a Workspace domain.
 * `grahamy.com` → `Grahamy`. The admin can always edit it.
 */
function orgNameFromDomain(hd: string): string {
  const base = hd.split(".")[0] ?? "";
  if (!base) return "";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Avatar that shows the user's Google profile picture when it loads, and
 * gracefully degrades to a colored initial-letter bubble on error (or when
 * the id token didn't carry a picture claim at all). Without this, a broken
 * CDN URL renders as the browser's missing-image glyph, which looks terrible
 * in a polished onboarding flow.
 */
function UserAvatar({
  name,
  email,
  picture,
  sizeClass = "h-10 w-10",
  textClass = "text-sm",
  ringClass = "ring-1 ring-white/20",
  gradientClass = "bg-gradient-to-br from-indigo-500/60 to-violet-500/60",
}: {
  name: string | null | undefined;
  email?: string | null;
  picture?: string | null;
  sizeClass?: string;
  textClass?: string;
  ringClass?: string;
  gradientClass?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial =
    ((name?.trim() || email?.trim() || "?")[0] || "?").toUpperCase();

  if (picture && !failed) {
    return (
      <Box
        component="img"
        src={picture}
        alt=""
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        className={`${sizeClass} rounded-full object-cover ${ringClass}`}
      />
    );
  }

  return (
    <Box
      className={`${sizeClass} flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ${gradientClass} ${ringClass} ${textClass}`}
    >
      {initial}
    </Box>
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
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");

  // Step 0 — sign-in method. `null` means the admin hasn't picked yet.
  // Picking 'google' also means we hold a short-lived bootstrap ticket
  // and the verified identity from `/auth/google-bootstrap`. The ticket
  // starts life unverified; `domainVerified` flips to true only after the
  // server confirms the DNS TXT record (via `/auth/google-verify-domain`)
  // and the ticket is swapped for its verified successor.
  const [signInMethod, setSignInMethod] = useState<SignInMethod | null>(null);
  const [googleTicket, setGoogleTicket] = useState<string | null>(null);
  const [googleIdentity, setGoogleIdentity] =
    useState<GoogleBootstrapIdentity | null>(null);
  const [txtRecord, setTxtRecord] = useState<BootstrapTxtRecord | null>(null);
  const [domainVerified, setDomainVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [copiedField, setCopiedField] = useState<"name" | "value" | null>(null);
  const [googleSigningIn, setGoogleSigningIn] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

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

  // Step 5 — admin account (password path only)
  const [adminUserName, setAdminUserName] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  // Transient feedback for the "copy client id" button on the Workspace panel.
  const [clientIdCopied, setClientIdCopied] = useState(false);

  useEffect(() => {
    getPublicModels()
      .then((m) => setModels(m))
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, []);

  // Mount the GIS button on step 0 while the admin still needs to sign in.
  // GIS initialization is centralised in `lib/googleIdentity` so navigating
  // between the login page and this wizard doesn't call `gsi.initialize()`
  // repeatedly — repeated init silently swaps the callback and the popup
  // stops opening. Here we only (re-)subscribe our callback + re-render the
  // button into the slot whenever step/ticket changes.
  useEffect(() => {
    if (step !== 0) return;
    if (!GOOGLE_CLIENT_ID) return;
    if (googleTicket) return;
    let cancelled = false;

    const unsubscribe = registerGoogleIdentity(async (resp) => {
      setGoogleError("");
      setGoogleSigningIn(true);
      try {
        const result = await googleBootstrap(resp.credential);
        if (cancelled) return;
        // Ticket is unverified at this point — the DNS TXT check hasn't
        // happened yet. We DON'T auto-advance; the admin still has to
        // publish the record and hit "Check now" to earn a verified
        // ticket before step 1 unlocks.
        setGoogleTicket(result.ticket);
        setGoogleIdentity(result.identity);
        setTxtRecord(result.txtRecord);
        setDomainVerified(false);
        setVerifyError("");
        setSignInMethod("google");
        // Prefill org name from hd, only if admin hasn't typed anything.
        setOrgName((prev) => (prev ? prev : orgNameFromDomain(result.identity.hd)));
      } catch (err: unknown) {
        if (cancelled) return;
        setGoogleError(
          err instanceof Error ? err.message : "Google sign-in failed.",
        );
      } finally {
        if (!cancelled) setGoogleSigningIn(false);
      }
    });

    if (googleButtonRef.current) {
      renderGoogleButton(googleButtonRef.current, {
        type: "standard",
        theme: "filled_blue",
        size: "large",
        shape: "pill",
        text: "continue_with",
        logo_alignment: "left",
        width: 320,
      });
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [step, googleTicket]);

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
    if (step === 0) {
      // Google branch: need a ticket AND that ticket must have passed the
      // DNS TXT check. Without `domainVerified` the server would reject the
      // final `/auth/register` call anyway (403 from the refine guard), so
      // gate the step transition itself.
      if (signInMethod === "google") return !!googleTicket && domainVerified;
      if (signInMethod === "password") return true;
      return false;
    }
    if (step === 1) return orgName.trim().length > 0;
    if (step === 2) return true; // logo is optional
    if (step === 3)
      return agents.length > 0 && agents.every((a) => a.definition.trim().length > 0);
    if (step === 4) return webSearchChoice === "gemini" || webSearchChoice === "brave";
    if (step === 5) {
      if (signInMethod === "google") return !!googleTicket && domainVerified;
      return (
        userNameSchema.safeParse(adminUserName).success &&
        adminDisplayName.trim().length > 0 &&
        passwordOk
      );
    }
    return false;
  }

  /** Switch to password mode — discards any held Google ticket/identity. */
  function choosePasswordMethod() {
    setSignInMethod("password");
    setGoogleTicket(null);
    setGoogleIdentity(null);
    setTxtRecord(null);
    setDomainVerified(false);
    setVerifyError("");
    setGoogleError("");
  }

  /** Discard the bootstrap artifacts so the admin can re-run Google sign-in. */
  function resetGoogleBootstrap() {
    setGoogleTicket(null);
    setGoogleIdentity(null);
    setTxtRecord(null);
    setDomainVerified(false);
    setVerifyError("");
    setSignInMethod(null);
  }

  /**
   * Copy a small string to the clipboard and flash a checkmark on the
   * triggering button. `field` scopes the flash to a specific pill so
   * copying "name" doesn't flash the "value" button too.
   */
  async function copyToClipboard(value: string, field: "name" | "value") {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(() => {
        setCopiedField((f) => (f === field ? null : f));
      }, 1500);
    } catch {
      // Clipboard API can fail on insecure contexts — swallow silently;
      // the value is visible so the admin can still select + copy manually.
    }
  }

  /**
   * Swap the unverified bootstrap ticket for a verified one by asking the
   * server to run a live DNS TXT lookup on the admin's Workspace domain.
   * On 409 we leave the ticket intact so the admin can retry after adding
   * or waiting on the record; on success we replace it and the step-0
   * advance guard unlocks.
   */
  async function handleVerifyDomain() {
    if (!googleTicket || verifying) return;
    setVerifying(true);
    setVerifyError("");
    try {
      const result = await googleVerifyDomain(googleTicket);
      setGoogleTicket(result.ticket);
      setDomainVerified(true);
    } catch (err: unknown) {
      setVerifyError(
        err instanceof Error
          ? err.message
          : "Domain verification failed — try again in a minute.",
      );
    } finally {
      setVerifying(false);
    }
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

  async function handleLaunch(e: FormEvent) {
    e.preventDefault();
    if (!canAdvance() || submitting) return;
    setError("");
    setSubmitting(true);

    // Two mutually-exclusive payload shapes. The server's zod refine()
    // rejects a request that sets neither (or both).
    const base = {
      organization: {
        name: orgName.trim(),
        ...(logo ? { logo } : {}),
      },
      agents: agents.map((a) => ({
        definition: a.definition.trim(),
        ...(a.description.trim() ? { description: a.description.trim() } : {}),
        ...(a.modelId ? { modelId: a.modelId } : {}),
      })),
      webSearchChoice,
    } as const;

    const payload: RegisterData =
      signInMethod === "google" && googleTicket
        ? { ...base, googleBootstrapTicket: googleTicket }
        : {
            ...base,
            admin: {
              userName: adminUserName.trim(),
              displayName: adminDisplayName.trim(),
              password: adminPassword,
            },
          };

    try {
      await register(payload);
      setLaunching(true);
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

      {launching && (
        <LaunchAnimation
          logo={logo}
          subtitle={`${orgName || "Your organization"} is live.`}
          agentCount={agents.length}
          onComplete={() => {
            activateSession();
            navigate("/", { replace: true });
          }}
        />
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
            {step === 0 && "How Will You Sign In?"}
            {step === 1 && "Create Your AI-Powered Organization"}
            {step === 2 && "Define Your Brand Identity"}
            {step === 3 && "Assemble Your Team of Agents"}
            {step === 4 && "Pick Your Web Search Agent"}
            {step === 5 && "Launch Your New Reality"}
          </Box>
          <Box component="p" className="max-w-md text-sm text-indigo-100/70">
            {step === 0 && "Pick the identity you'll use to run this workspace. You can add more later."}
            {step === 1 && "Every great team starts with a name. What will yours be?"}
            {step === 2 && "A logo to carry across every conversation — yours will shine."}
            {step === 3 && "These are the minds you'll work with every day."}
            {step === 4 && "One agent handles every web search across your org."}
            {step === 5 && "You're one click away from a whole new way of working."}
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

          {/* ── STEP 0 · Sign-in method ────────────────────────────── */}
          {step === 0 && (
            <Stack spacing={2.5}>
              {/* Google Workspace card — if configured. The GIS pill is
                  rendered inline at the bottom of the card. Modern GIS
                  renders its button inside an iframe from Google's domain;
                  programmatic `.click()` forwarding from a card wrapper
                  doesn't propagate into that iframe, so the user clicks
                  the pill directly. */}
              {GOOGLE_CLIENT_ID && (
                <Box
                  className={`rounded-2xl border p-4 transition ${
                    signInMethod === "google"
                      ? "border-indigo-400 bg-indigo-500/15 ring-2 ring-indigo-400/40"
                      : "border-white/10 bg-slate-900/40"
                  }`}
                >
                  <Stack direction="row" alignItems="flex-start" spacing={1.75}>
                    <Box className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-white/20">
                      {/* Google 4-color "G" — per brand guidelines */}
                      <svg viewBox="0 0 24 24" className="h-6 w-6">
                        <path
                          fill="#4285F4"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                    </Box>
                    <Box className="flex-1">
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Box className="text-base font-semibold text-indigo-50">
                          Continue with Google Workspace
                        </Box>
                        {signInMethod === "google" && googleTicket && (
                          <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                        )}
                      </Stack>
                      <Box className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-indigo-300/70">
                        Recommended · SSO for your whole domain
                      </Box>
                      <Box className="mt-1.5 text-xs text-indigo-100/75">
                        Your Google account becomes the admin — no password to
                        invent. Every teammate on the same domain can sign in
                        with Google too.
                      </Box>

                      {googleTicket && googleIdentity ? (
                        // Signed in — now we split on whether the domain has
                        // been proved. Unverified tickets get the DNS panel;
                        // verified tickets just show the green chip and let
                        // the global Continue button take over.
                        <Box sx={{ mt: 2 }}>
                          <Stack
                            direction="row"
                            alignItems="center"
                            spacing={1.5}
                            className={`rounded-xl border px-3 py-2 ${
                              domainVerified
                                ? "border-emerald-400/30 bg-emerald-500/10"
                                : "border-amber-400/30 bg-amber-500/10"
                            }`}
                          >
                            <UserAvatar
                              name={googleIdentity.name}
                              email={googleIdentity.email}
                              picture={googleIdentity.picture}
                              sizeClass="h-8 w-8"
                              textClass="text-xs"
                              gradientClass={
                                domainVerified
                                  ? "bg-gradient-to-br from-emerald-500/60 to-sky-500/60"
                                  : "bg-gradient-to-br from-amber-500/60 to-orange-500/60"
                              }
                            />
                            <Box className="flex-1 overflow-hidden">
                              <Box
                                className={`truncate text-sm font-medium ${
                                  domainVerified ? "text-emerald-50" : "text-amber-50"
                                }`}
                              >
                                {googleIdentity.name || googleIdentity.email}
                              </Box>
                              <Box
                                className={`truncate text-[11px] ${
                                  domainVerified ? "text-emerald-200/80" : "text-amber-200/80"
                                }`}
                              >
                                {googleIdentity.email} ·{" "}
                                <Box component="span" className="font-mono">
                                  {googleIdentity.hd}
                                </Box>
                              </Box>
                            </Box>
                            <button
                              type="button"
                              onClick={resetGoogleBootstrap}
                              className="rounded-md px-2 py-1 text-[11px] font-medium text-indigo-200/80 transition hover:bg-white/10 hover:text-white"
                            >
                              Change
                            </button>
                          </Stack>

                          {/* DNS TXT verification panel — only while the
                              ticket is still unverified. Once the server
                              confirms the record, this collapses away. */}
                          {!domainVerified && txtRecord && (
                            <Box
                              sx={{ mt: 2 }}
                              className="rounded-xl border border-white/10 bg-slate-900/60 p-3.5"
                            >
                              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.25 }}>
                                <Box className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500/40 to-indigo-500/40 ring-1 ring-white/10">
                                  <ShieldCheck className="h-3.5 w-3.5 text-sky-100" />
                                </Box>
                                <Box>
                                  <Box className="text-xs font-semibold text-indigo-50">
                                    Prove you own{" "}
                                    <Box component="span" className="font-mono">
                                      {txtRecord.name}
                                    </Box>
                                  </Box>
                                  <Box className="text-[10px] text-indigo-200/65">
                                    Publish this TXT record at your domain's DNS provider.
                                  </Box>
                                </Box>
                              </Stack>

                              <Stack spacing={1.25}>
                                <Box>
                                  <Box className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-200/70">
                                    Host / Name
                                  </Box>
                                  <Stack direction="row" spacing={1}>
                                    <Box className="flex-1 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-indigo-50">
                                      {txtRecord.name}
                                    </Box>
                                    <button
                                      type="button"
                                      onClick={() => copyToClipboard(txtRecord.name, "name")}
                                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white/5 px-2.5 text-[11px] font-medium text-indigo-100 ring-1 ring-white/10 transition hover:bg-white/10"
                                    >
                                      {copiedField === "name" ? (
                                        <>
                                          <CheckCircle2 className="h-3 w-3 text-emerald-300" />
                                          Copied
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="h-3 w-3" />
                                          Copy
                                        </>
                                      )}
                                    </button>
                                  </Stack>
                                  <Box className="mt-1 text-[10px] text-indigo-200/55">
                                    Most DNS UIs want this as <code className="rounded bg-white/5 px-1">@</code> or left blank — the record lives on the root domain.
                                  </Box>
                                </Box>

                                <Box>
                                  <Box className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-200/70">
                                    Value
                                  </Box>
                                  <Stack direction="row" spacing={1}>
                                    <Box className="flex-1 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-indigo-50">
                                      {txtRecord.value}
                                    </Box>
                                    <button
                                      type="button"
                                      onClick={() => copyToClipboard(txtRecord.value, "value")}
                                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white/5 px-2.5 text-[11px] font-medium text-indigo-100 ring-1 ring-white/10 transition hover:bg-white/10"
                                    >
                                      {copiedField === "value" ? (
                                        <>
                                          <CheckCircle2 className="h-3 w-3 text-emerald-300" />
                                          Copied
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="h-3 w-3" />
                                          Copy
                                        </>
                                      )}
                                    </button>
                                  </Stack>
                                </Box>
                              </Stack>

                              <Box className="mt-2.5 rounded-lg border border-sky-400/20 bg-sky-500/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-sky-100/80">
                                DNS changes usually appear within 1–5 minutes,
                                but some providers take up to 30 minutes. Add
                                the record, wait a moment, then click below.
                              </Box>

                              {verifyError && (
                                <Box className="mt-2 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-[10px] text-red-200 ring-1 ring-red-400/30">
                                  {verifyError}
                                </Box>
                              )}

                              <Stack
                                direction="row"
                                alignItems="center"
                                justifyContent="flex-end"
                                sx={{ mt: 1.75 }}
                              >
                                <button
                                  type="button"
                                  onClick={handleVerifyDomain}
                                  disabled={verifying}
                                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white shadow shadow-indigo-900/40 transition-all duration-200 ${
                                    verifying
                                      ? "cursor-not-allowed bg-white/10"
                                      : "bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-400 hover:to-violet-400"
                                  }`}
                                >
                                  {verifying ? (
                                    <>
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      Checking DNS…
                                    </>
                                  ) : (
                                    <>
                                      <ShieldCheck className="h-3.5 w-3.5" />
                                      I've added it — check now
                                    </>
                                  )}
                                </button>
                              </Stack>
                            </Box>
                          )}

                          {domainVerified && (
                            <Stack
                              direction="row"
                              alignItems="center"
                              spacing={1}
                              sx={{ mt: 1.5 }}
                              className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-100"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                              <span>
                                Domain{" "}
                                <Box component="span" className="font-mono">
                                  {googleIdentity.hd}
                                </Box>{" "}
                                verified. Continue to set up your organization.
                              </span>
                            </Stack>
                          )}
                        </Box>
                      ) : (
                        // Not signed in yet — render the GIS pill inline so
                        // the user clicks Google's button directly (iframe
                        // rendering means `.click()` forwarding from the
                        // wrapping card silently no-ops).
                        <Box sx={{ mt: 1.75 }}>
                          <Box ref={googleButtonRef} />
                          {googleSigningIn && (
                            <Stack
                              direction="row"
                              alignItems="center"
                              spacing={1}
                              sx={{ mt: 1 }}
                              className="text-[11px] text-indigo-200/70"
                            >
                              <Loader2 className="h-3 w-3 animate-spin" />
                              <span>Verifying your Google account…</span>
                            </Stack>
                          )}
                          {googleError && (
                            <Box className="mt-2 rounded-lg bg-red-500/15 px-3 py-2 text-[11px] text-red-200 ring-1 ring-red-400/30">
                              {googleError}
                            </Box>
                          )}
                        </Box>
                      )}
                    </Box>
                  </Stack>
                </Box>
              )}

              {/* Local admin card */}
              <Box
                role="button"
                tabIndex={0}
                onClick={choosePasswordMethod}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choosePasswordMethod();
                  }
                }}
                className={`cursor-pointer rounded-2xl border p-4 transition ${
                  signInMethod === "password"
                    ? "border-indigo-400 bg-indigo-500/15 ring-2 ring-indigo-400/40"
                    : "border-white/10 bg-slate-900/40 hover:border-white/20 hover:bg-slate-900/60"
                }`}
              >
                <Stack direction="row" alignItems="flex-start" spacing={1.75}>
                  <Box className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/40 to-violet-500/40 ring-1 ring-white/10">
                    <KeyRound className="h-5 w-5 text-indigo-100" />
                  </Box>
                  <Box className="flex-1">
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Box className="text-base font-semibold text-indigo-50">
                        Create a local admin account
                      </Box>
                      {signInMethod === "password" && (
                        <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                      )}
                    </Stack>
                    <Box className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-indigo-300/70">
                      Username + password · no external identity provider
                    </Box>
                    <Box className="mt-1.5 text-xs text-indigo-100/75">
                      Pick a username and password on the next screens. You
                      can still enable Google or Microsoft SSO later from
                      the admin panel.
                    </Box>
                  </Box>
                </Stack>
              </Box>

              {/* Microsoft Entra ID — coming soon */}
              <Box
                className="cursor-not-allowed rounded-2xl border border-white/10 bg-slate-900/30 p-4 opacity-75"
                aria-disabled="true"
              >
                <Stack direction="row" alignItems="flex-start" spacing={1.75}>
                  <Box className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-white/20">
                    {/* Microsoft 4-square mark */}
                    <svg viewBox="0 0 23 23" className="h-5 w-5">
                      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
                      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
                      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
                      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
                    </svg>
                  </Box>
                  <Box className="flex-1">
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Box className="text-base font-semibold text-indigo-50/80">
                        Continue with Microsoft Entra ID
                      </Box>
                      <Box className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-300 ring-1 ring-sky-400/30">
                        Coming soon
                      </Box>
                    </Stack>
                    <Box className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-indigo-300/70">
                      Formerly Azure AD · Microsoft 365 tenants
                    </Box>
                    <Box className="mt-1.5 text-xs text-indigo-100/60">
                      Tenant-wide SSO for Microsoft 365 organizations. Your
                      Entra admin will paste our Application (client) ID into
                      the Entra admin center and grant consent — we're
                      finishing the server side now.
                    </Box>
                  </Box>
                </Stack>
              </Box>
            </Stack>
          )}

          {/* ── STEP 1 · Org name ──────────────────────────────────── */}
          {step === 1 && (
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
                {signInMethod === "google" && googleIdentity && (
                  <Box className="mt-3 rounded-lg border border-white/10 bg-slate-900/40 px-3 py-2 text-[11px] text-indigo-200/70">
                    Detected from your Google account:{" "}
                    <Box component="span" className="font-mono text-indigo-100">
                      {googleIdentity.hd}
                    </Box>
                    . We'll link this workspace domain to your org.
                  </Box>
                )}
              </Box>
            </Stack>
          )}

          {/* ── STEP 2 · Logo ─────────────────────────────────────── */}
          {step === 2 && (
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

          {/* ── STEP 3 · Agents ───────────────────────────────────── */}
          {step === 3 && (
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
          {step === 4 && (
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

          {/* ── STEP 5 · Admin + review + launch ──────────────────── */}
          {step === 5 && (
            <Stack spacing={3}>
              {/* Admin identity — Google branch shows a read-only chip,
                  password branch shows the form. */}
              <Box>
                <Box className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-indigo-300/80">
                  Admin account
                </Box>

                {signInMethod === "google" && googleIdentity ? (
                  <Box className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4">
                    <Stack direction="row" alignItems="center" spacing={1.5}>
                      <UserAvatar
                        name={googleIdentity.name}
                        email={googleIdentity.email}
                        picture={googleIdentity.picture}
                        sizeClass="h-10 w-10"
                        textClass="text-sm"
                        gradientClass="bg-gradient-to-br from-emerald-500/60 to-sky-500/60"
                      />
                      <Box className="flex-1 overflow-hidden">
                        <Box className="truncate text-sm font-semibold text-emerald-50">
                          {googleIdentity.name || googleIdentity.email}
                        </Box>
                        <Box className="truncate text-[11px] text-emerald-200/80">
                          {googleIdentity.email} · signed in via Google Workspace
                        </Box>
                      </Box>
                      <Box className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/40">
                        SSO
                      </Box>
                    </Stack>
                    <Box className="mt-3 text-[11px] leading-relaxed text-emerald-100/80">
                      No password needed — we'll link this Google identity as
                      the first admin of{" "}
                      <Box component="span" className="font-semibold">
                        {orgName || "your organization"}
                      </Box>
                      .
                    </Box>
                  </Box>
                ) : (
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
                )}
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
                  <Box className="border-t border-white/5" />
                  <Stack direction="row" alignItems="center" spacing={1.5}>
                    <Box className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/10">
                      {signInMethod === "google" ? (
                        <ShieldCheck className="h-3 w-3 text-emerald-200" />
                      ) : (
                        <KeyRound className="h-3 w-3 text-indigo-100" />
                      )}
                    </Box>
                    <Box className="flex-1 text-xs text-indigo-100">
                      Admin ·{" "}
                      <Box component="span" className="font-semibold">
                        {signInMethod === "google" && googleIdentity
                          ? `${googleIdentity.email} (Google SSO)`
                          : `${adminUserName || "…"} (password)`}
                      </Box>
                    </Box>
                  </Stack>
                </Stack>
              </Box>

              {/* ── Workspace domain propagation (Google branch only) ───
                  The admin already demonstrated SSO works for themselves;
                  this collapsible tells them how to let every teammate on
                  the same Workspace domain sign in too — plus the DWD note
                  for server-to-server API access down the road. */}
              {signInMethod === "google" && GOOGLE_CLIENT_ID && (
                <Box
                  component="details"
                  className="group rounded-2xl border border-white/10 bg-slate-900/40 p-4 open:bg-slate-900/60"
                >
                  <Box
                    component="summary"
                    sx={{ cursor: "pointer", listStyle: "none" }}
                    className="flex items-center gap-3 [&::-webkit-details-marker]:hidden"
                  >
                    <Box className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/40 to-indigo-500/40 ring-1 ring-white/10">
                      <ShieldCheck className="h-4 w-4 text-sky-100" />
                    </Box>
                    <Box className="flex-1">
                      <Box className="text-sm font-semibold text-indigo-50">
                        Enable SSO for the rest of your team (optional)
                      </Box>
                      <Box className="text-[11px] text-indigo-200/60">
                        Share this client ID with your Workspace super-admin
                      </Box>
                    </Box>
                    <ChevronDown className="h-4 w-4 text-indigo-200/70 transition-transform group-open:rotate-180" />
                  </Box>

                  <Box sx={{ mt: 2.5 }}>
                    <Box className="mb-3 text-xs leading-relaxed text-indigo-100/75">
                      Your IT admin adds this OAuth client ID to{" "}
                      <Box component="span" className="font-medium text-indigo-50">
                        Admin Console → Security → Access and data control →
                        API controls → Domain-wide delegation
                      </Box>
                      , then authorizes the scopes below. The client ID is
                      public — safe to email or paste in a ticket.
                    </Box>

                    <Box className="mb-3">
                      <Box className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-indigo-200/70">
                        OAuth client ID
                      </Box>
                      <Stack direction="row" spacing={1} alignItems="stretch">
                        <Box className="flex-1 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-indigo-50">
                          {GOOGLE_CLIENT_ID}
                        </Box>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(GOOGLE_CLIENT_ID);
                              setClientIdCopied(true);
                              window.setTimeout(() => setClientIdCopied(false), 1500);
                            } catch {
                              // Clipboard API can fail on insecure contexts —
                              // swallow silently; the value is visible to copy manually.
                            }
                          }}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white/5 px-3 text-xs font-medium text-indigo-100 ring-1 ring-white/10 transition hover:bg-white/10"
                        >
                          {clientIdCopied ? (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" />
                              Copy
                            </>
                          )}
                        </button>
                      </Stack>
                    </Box>

                    <Box className="mb-3">
                      <Box className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-indigo-200/70">
                        OAuth scopes to authorize
                      </Box>
                      <Box className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-indigo-50">
                        openid
                        <br />
                        email
                        <br />
                        profile
                      </Box>
                      <Box className="mt-1.5 text-[11px] text-indigo-200/60">
                        These are the minimum scopes for SSO sign-in. Add
                        calendar / gmail scopes later if you enable those
                        integrations.
                      </Box>
                    </Box>

                    <Box className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-100/80">
                      <Box component="span" className="font-semibold text-amber-100">
                        Note:
                      </Box>{" "}
                      Domain-wide delegation for{" "}
                      <Box component="em">server-to-server</Box> API access
                      (e.g. reading user calendars) requires a separate{" "}
                      <Box component="em">service account</Box> — its numeric
                      Unique ID is what goes into the DWD form, not this
                      OAuth client ID. The ID above is used for user sign-in
                      only.
                    </Box>

                    <Box sx={{ mt: 2 }}>
                      <Box
                        component="a"
                        href="https://admin.google.com/ac/owl/domainwidedelegation"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-indigo-300 hover:text-indigo-100"
                      >
                        Open Google Admin Console
                        <ExternalLink className="h-3 w-3" />
                      </Box>
                    </Box>
                  </Box>
                </Box>
              )}
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
                {step === 1 ? (
                  <>
                    <Users className="h-4 w-4" /> Continue
                  </>
                ) : (
                  <>
                    Continue <ArrowRight className="h-4 w-4" />
                  </>
                )}
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
