import { useEffect, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import { Loader2, CheckCircle2, Building2, Bot, Sparkles } from "lucide-react";

/**
 * Cinematic 4-phase launch overlay played after a user provisions something
 * consequential — a new organization (onboarding wizard) or their own account
 * via SSO first-login. Self-contained: mount it with `onComplete`, it handles
 * all phase timing and fires the callback right before the whiteout finishes.
 *
 * Copy defaults describe the org-creation flow; override `stages`, `title`,
 * and `subtitle` to re-use the same visual for other "welcome" moments.
 */
export interface LaunchAnimationProps {
  /** Optional square logo shown in the core orb + phase-3 reveal. */
  logo?: string | null;
  /** Big headline shown during phase 3. */
  title?: string;
  /** Smaller line under the title during phase 3. */
  subtitle?: string;
  /**
   * Four status messages shown in phase 1 at 0/1.2s/2.2s/3.2s. Default copy
   * describes org provisioning; override for other launch contexts.
   */
  stages?: [string, string, string, string];
  /** Text shown at phase 2 (success). Defaults to "Systems online". */
  successStatus?: string;
  /**
   * Optional badge rendered below the phase-3 title. Defaults to an "N agents
   * ready" pill when `agentCount` is set; pass `null` to suppress.
   */
  agentCount?: number;
  /** Custom phase-3 badge — overrides the default agent-count pill entirely. */
  badge?: ReactNode;
  /** Called just before the component unmounts itself. Navigate / activate here. */
  onComplete: () => void;
}

const DEFAULT_STAGES: [string, string, string, string] = [
  "Initializing systems",
  "Creating organization",
  "Provisioning agents",
  "Building your reality",
];

export default function LaunchAnimation({
  logo = null,
  title = "Welcome to a new reality.",
  subtitle = "Your organization is live.",
  stages = DEFAULT_STAGES,
  successStatus = "Systems online",
  agentCount,
  badge,
  onComplete,
}: LaunchAnimationProps) {
  const [phase, setPhase] = useState<0 | 1 | 2 | 3 | 4>(1);
  const [status, setStatus] = useState(stages[0]);

  useEffect(() => {
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setStatus(stages[1]), 1200));
    timers.push(window.setTimeout(() => setStatus(stages[2]), 2200));
    timers.push(window.setTimeout(() => setStatus(stages[3]), 3200));
    timers.push(
      window.setTimeout(() => {
        setPhase(2);
        setStatus(successStatus);
      }, 4000),
    );
    timers.push(
      window.setTimeout(() => {
        setPhase(3);
        setStatus("");
      }, 5200),
    );
    timers.push(window.setTimeout(() => setPhase(4), 7000));
    timers.push(window.setTimeout(() => onComplete(), 7800));
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showBadge =
    badge !== undefined
      ? badge
      : typeof agentCount === "number" && agentCount > 0
        ? (
            <Box className="launch-subtitle mt-6 flex items-center gap-2 rounded-full bg-white/5 px-4 py-2 text-sm text-indigo-200/70 ring-1 ring-white/10 backdrop-blur-sm">
              <Bot className="h-4 w-4 text-indigo-400" />
              <span>{agentCount} agent{agentCount === 1 ? "" : "s"} ready</span>
              <Sparkles className="h-3 w-3 text-violet-400" />
            </Box>
          )
        : null;

  return (
    <Box className="launch-backdrop fixed inset-0" sx={{ zIndex: 50 }}>
      {/* Deep space backdrop */}
      <Box className="absolute inset-0 bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950" />

      {/* Hex grid pattern */}
      <Box className="launch-grid absolute inset-0" />

      {/* Floating holographic shards */}
      {phase < 4 && (
        <Box className="absolute inset-0 overflow-hidden" aria-hidden>
          {[
            { w: 60, h: 20, l: "15%", t: "20%", bg: "rgba(99,102,241,0.08)", r: 15, dur: 5, del: 0.5 },
            { w: 40, h: 12, l: "75%", t: "30%", bg: "rgba(168,85,247,0.08)", r: -20, dur: 6, del: 1 },
            { w: 80, h: 16, l: "25%", t: "70%", bg: "rgba(56,189,248,0.06)", r: 10, dur: 4.5, del: 0.8 },
            { w: 50, h: 14, l: "65%", t: "75%", bg: "rgba(236,72,153,0.06)", r: -25, dur: 5.5, del: 1.5 },
            { w: 35, h: 10, l: "45%", t: "15%", bg: "rgba(52,211,153,0.06)", r: 30, dur: 7, del: 0.3 },
            { w: 70, h: 18, l: "85%", t: "55%", bg: "rgba(129,140,248,0.07)", r: -12, dur: 4, del: 2 },
          ].map((s, i) => (
            <div
              key={i}
              className="launch-shard"
              style={{
                width: s.w,
                height: s.h,
                left: s.l,
                top: s.t,
                background: s.bg,
                "--shard-r": `${s.r}deg`,
                "--shard-dur": `${s.dur}s`,
                "--shard-delay": `${s.del}s`,
              } as React.CSSProperties}
            />
          ))}
        </Box>
      )}

      {/* ── Phase 1: Orbital rings + scanning ────────────────────── */}
      {(phase === 1 || phase === 2) && (
        <Box className="absolute inset-0 flex items-center justify-center">
          <Box className="relative" sx={{ width: 280, height: 280 }}>
            {phase === 1 && <div className="launch-scanline" />}

            <Box className="launch-ring absolute inset-0" />
            <Box className="launch-ring-2 absolute" sx={{ inset: "20px" }} />
            <Box className="launch-ring-3 absolute" sx={{ inset: "44px" }} />

            <Box
              className="launch-core absolute flex items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600"
              sx={{ inset: "72px" }}
            >
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

            {phase === 2 && (
              <>
                <Box className="launch-nova absolute" sx={{ inset: "40px" }} />

                <Box
                  className="launch-checkmark absolute flex items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 shadow-2xl shadow-emerald-500/40"
                  sx={{ width: 48, height: 48, bottom: -8, right: -8 }}
                >
                  <CheckCircle2 className="h-6 w-6 text-white" strokeWidth={2.5} />
                </Box>

                {[
                  { px: "120px", py: "-100px", size: 6, bg: "#818cf8", dur: "1.5s", del: "0.1s" },
                  { px: "-130px", py: "-60px", size: 5, bg: "#a78bfa", dur: "1.3s", del: "0.2s" },
                  { px: "80px", py: "120px", size: 4, bg: "#f472b6", dur: "1.4s", del: "0.15s" },
                  { px: "-100px", py: "90px", size: 7, bg: "#38bdf8", dur: "1.6s", del: "0.05s" },
                  { px: "150px", py: "30px", size: 3, bg: "#34d399", dur: "1.2s", del: "0.25s" },
                  { px: "-60px", py: "-130px", size: 5, bg: "#c084fc", dur: "1.5s", del: "0.3s" },
                  { px: "40px", py: "-150px", size: 4, bg: "#fbbf24", dur: "1.3s", del: "0.18s" },
                  { px: "-150px", py: "10px", size: 6, bg: "#6366f1", dur: "1.7s", del: "0.08s" },
                ].map((p, i) => (
                  <div
                    key={i}
                    className="launch-particle"
                    style={{
                      left: "50%",
                      top: "50%",
                      width: p.size,
                      height: p.size,
                      marginLeft: -p.size / 2,
                      marginTop: -p.size / 2,
                      background: p.bg,
                      "--px": p.px,
                      "--py": p.py,
                      "--pdur": p.dur,
                      "--pdelay": p.del,
                    } as React.CSSProperties}
                  />
                ))}
              </>
            )}
          </Box>
        </Box>
      )}

      {/* ── Phase 1 & 2: Status text + progress ──────────────────── */}
      {(phase === 1 || phase === 2) && (
        <Box className="absolute bottom-[20%] left-0 right-0 flex flex-col items-center gap-4 px-8">
          <Box
            key={status}
            className="launch-status-text flex items-center gap-2 text-sm font-medium tracking-wide text-indigo-200/90"
          >
            {phase === 1 && <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />}
            {phase === 2 && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
            <span>{status}</span>
          </Box>
          <Box className="launch-progress-track w-full" sx={{ maxWidth: 240 }}>
            <Box
              className="launch-progress-bar"
              sx={{ "--launch-duration": "4.5s" } as React.CSSProperties}
            />
          </Box>
        </Box>
      )}

      {/* ── Phase 3: Title reveal + warp stars ────────────────────── */}
      {phase === 3 && (
        <Box className="absolute inset-0 flex flex-col items-center justify-center">
          <Box className="absolute inset-0 overflow-hidden" aria-hidden>
            {Array.from({ length: 40 }).map((_, i) => {
              const angle = (i / 40) * Math.PI * 2;
              const dist = 30 + Math.random() * 60;
              return (
                <div
                  key={i}
                  className="launch-star"
                  style={{
                    left: "50%",
                    top: "50%",
                    "--sx": `${Math.cos(angle) * dist}px`,
                    "--sy": `${Math.sin(angle) * dist}px`,
                    "--sdur": `${0.8 + Math.random() * 0.6}s`,
                    "--sdelay": `${Math.random() * 0.4}s`,
                  } as React.CSSProperties}
                />
              );
            })}
          </Box>

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

          <Box
            component="h2"
            className="launch-title text-center text-4xl font-bold tracking-tight text-white sm:text-5xl"
          >
            {title}
          </Box>

          <Box className="launch-subtitle mt-3 text-center text-base text-indigo-200/80 sm:text-lg">
            {subtitle}
          </Box>

          {showBadge}
        </Box>
      )}

      {/* ── Phase 4: White-out transition ─────────────────────────── */}
      {phase === 4 && <Box className="launch-whiteout absolute inset-0 bg-white" />}
    </Box>
  );
}
