import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type MouseEvent,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Container from "@mui/material/Container";
import {
  ArrowLeft,
  MessagesSquare,
  Users2,
  Hash,
  Play,
  Square,
  Loader2,
  Sparkles,
  Bot,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Radio,
  ScrollText,
  Send,
  User as UserIcon,
  Timer,
  RotateCw,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToast } from "../components/Toast";
import { useAuth } from "../context/AuthContext";
import { getChatSocket } from "../sockets/chatSocket";
import {
  admin as api,
  type AdminAgent,
  type AdminUser,
  type RoundtableSummary,
  type RoundtableDetail,
  type RoundtableMessageInfo,
} from "../api";
import NotificationBell from "../components/NotificationBell";

// ─── Shared design tokens ───────────────────────────────────────────────────

const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder-indigo-200/40 backdrop-blur-sm transition-all duration-200 focus:border-indigo-400/50 focus:bg-white/[0.08] focus:outline-none focus:shadow-[0_0_28px_-10px_rgba(129,140,248,0.6)]";

const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_24px_-4px_rgba(168,85,247,0.65)] transition-all duration-200 hover:shadow-[0_0_32px_-4px_rgba(168,85,247,0.9)] hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";

const btnGhost =
  "inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm font-medium text-indigo-100 backdrop-blur-sm transition-all duration-200 hover:border-white/25 hover:bg-white/[0.08] active:scale-[0.98]";

const cardClass =
  "glass-panel-elevated rounded-2xl p-5 sm:p-6";

function StatusPill({ status }: { status: string }) {
  const map: Record<
    string,
    { className: string; Icon: typeof Clock; label: string }
  > = {
    pending: {
      className: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30",
      Icon: Clock,
      label: "Pending",
    },
    running: {
      className: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/30",
      Icon: Radio,
      label: "Running",
    },
    waiting_for_user: {
      className: "bg-fuchsia-500/15 text-fuchsia-200 ring-1 ring-fuchsia-400/30",
      Icon: Timer,
      label: "Your turn",
    },
    completed: {
      className: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30",
      Icon: CheckCircle2,
      label: "Completed",
    },
    failed: {
      className: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30",
      Icon: AlertTriangle,
      label: "Failed",
    },
  };
  const entry = map[status] ?? {
    className: "bg-white/10 text-indigo-100 ring-1 ring-white/15",
    Icon: Clock,
    label: status,
  };
  const { Icon, className, label } = entry;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium backdrop-blur-sm ${className}`}
    >
      <Icon
        className={`h-3 w-3 ${status === "running" ? "animate-pulse-soft" : ""}`}
      />
      {label}
    </span>
  );
}

// Deep-space ambient background decoration
function SpaceAmbient() {
  return (
    <>
      <Box className="space-grid" aria-hidden="true" />
      <Box className="space-orb space-orb-1" aria-hidden="true" />
      <Box className="space-orb space-orb-2" aria-hidden="true" />
      <Box className="space-orb space-orb-3" aria-hidden="true" />
    </>
  );
}

// ─── Roundtable list + create form ─────────────────────────────────────────

function RoundtableListView() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const [roundtables, setRoundtables] = useState<RoundtableSummary[]>([]);
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [orgUsers, setOrgUsers] = useState<AdminUser[]>([]);
  const [topic, setTopic] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [maxTurns, setMaxTurns] = useState(5);
  const [creating, setCreating] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const handleResumeFromList = async (
    e: MouseEvent<HTMLButtonElement>,
    rtId: string,
  ) => {
    e.stopPropagation();
    setResumingId(rtId);
    try {
      const result = await api.resumeRoundtable(rtId);
      const trimmed = result.trimmedMessages ?? 0;
      toast(
        trimmed > 0
          ? `Resumed — trimmed ${trimmed} orphan message${trimmed === 1 ? "" : "s"}`
          : "Roundtable resumed",
        "info",
      );
      setRoundtables((prev) =>
        prev.map((rt) =>
          rt.id === rtId ? { ...rt, status: "running" } : rt,
        ),
      );
    } catch (err: any) {
      toast(err.message ?? "Failed to resume roundtable", "error");
    } finally {
      setResumingId(null);
    }
  };

  useEffect(() => {
    api.getRoundtables().then(setRoundtables).catch(console.error);
    api
      .getAgents()
      .then((all) =>
        setAgents(
          all.filter((a) => a.type === "primary" || a.type === "external"),
        ),
      )
      .catch(console.error);
    api.getUsers().then(setOrgUsers).catch(console.error);
  }, []);

  const toggleAgent = (id: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleUser = (id: number) => {
    setSelectedUserIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleCreate = async () => {
    if (!topic.trim() || selectedAgentIds.length < 2) return;
    setCreating(true);
    try {
      const result = await api.createRoundtable({
        topic: topic.trim(),
        agentIds: selectedAgentIds,
        maxTurnsPerAgent: maxTurns,
        participantUserIds: selectedUserIds,
      });
      navigate(`/roundtable/${result.id}`);
    } catch (err: any) {
      toast(err.message ?? "Failed to start roundtable", "error");
    } finally {
      setCreating(false);
    }
  };

  const canSubmit =
    !!topic.trim() && selectedAgentIds.length >= 2 && !creating;

  return (
    <Stack
      component="main"
      className="space-bg"
      sx={{
        height: "100vh",
        width: "100%",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <SpaceAmbient />

      <Container
        maxWidth={false}
        disableGutters
        className="dark-scroll mx-auto box-border flex w-full min-w-0 max-w-5xl flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8"
        sx={{ position: "relative", zIndex: 1, minHeight: 0 }}
      >
        {/* Sticky header */}
        <Stack
          component="header"
          direction="row"
          className="sticky top-0 z-30 -mx-4 mb-6 min-w-0 items-center justify-between gap-3 border-b border-white/5 bg-slate-950/50 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:mb-8 sm:px-6 sm:py-4 lg:-mx-8 lg:px-8"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-indigo-500/40 via-violet-500/30 to-fuchsia-500/40 blur-md" />
              <div className="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-[0_0_20px_-4px_rgba(168,85,247,0.65)] ring-1 ring-white/20">
                <MessagesSquare className="h-5 w-5" />
              </div>
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold tracking-tight text-white">
                Roundtables
              </h1>
              <p className="text-[10px] sm:text-xs text-indigo-200/60">
                Multi-agent discussions across the network
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NotificationBell />
            <button onClick={() => navigate("/")} className={btnGhost}>
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to Chat</span>
            </button>
          </div>
        </Stack>

        <Stack component="section" className="w-full min-w-0 flex-1 space-y-6 sm:space-y-8">
          {/* Create form */}
          <Box className={`${cardClass} animate-slide-up`}>
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-white">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-[0_0_18px_-4px_rgba(168,85,247,0.7)] ring-1 ring-white/15">
                <Sparkles className="h-4 w-4" />
              </div>
              New Roundtable Discussion
            </h2>

            <div className="space-y-5">
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-indigo-300/60">
                  Topic
                </label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Describe the discussion topic for the agents..."
                  rows={3}
                  className={`${inputClass} resize-none`}
                />
              </div>

              <div>
                <label className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-indigo-300/60">
                  <Users2 className="h-3.5 w-3.5 text-indigo-300/70" />
                  Participants
                  <span className="ml-1 rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-indigo-100">
                    {selectedAgentIds.length} selected · min 2
                  </span>
                </label>
                {agents.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-6 text-center text-xs text-indigo-200/50">
                    No agents available.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {agents.map((a) => {
                      const selected = selectedAgentIds.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          onClick={() => toggleAgent(a.id)}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium backdrop-blur-sm transition-all duration-150 active:scale-[0.97] ${
                            selected
                              ? "bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-[0_0_18px_-4px_rgba(168,85,247,0.65)] ring-1 ring-white/20"
                              : "border border-white/10 bg-white/[0.04] text-indigo-100 hover:border-indigo-300/40 hover:bg-indigo-500/15 hover:text-white"
                          }`}
                        >
                          <Bot className="h-3 w-3" />
                          {a.agentName || a.definition}
                          {a.type === "external" && (
                            <span className="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[8px] font-semibold uppercase text-amber-200 ring-1 ring-amber-400/30">
                              ext
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-indigo-300/60">
                  <UserIcon className="h-3.5 w-3.5 text-fuchsia-300/70" />
                  Human participants
                  <span className="ml-1 rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-indigo-100">
                    {selectedUserIds.length} selected · optional
                  </span>
                </label>
                <p className="mb-2.5 text-[11px] text-indigo-200/60">
                  Each selected person gets their own turn at the end of every
                  round (5-minute window). Invitees are notified.
                </p>
                {orgUsers.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-6 text-center text-xs text-indigo-200/50">
                    No users available.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {orgUsers.map((u) => {
                      const selected = selectedUserIds.includes(u.id);
                      const isMe = user?.id === u.id;
                      const label =
                        u.displayName?.trim() || `User #${u.id}`;
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => toggleUser(u.id)}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium backdrop-blur-sm transition-all duration-150 active:scale-[0.97] ${
                            selected
                              ? "bg-gradient-to-r from-fuchsia-500 via-violet-500 to-indigo-500 text-white shadow-[0_0_18px_-4px_rgba(232,121,249,0.65)] ring-1 ring-white/20"
                              : "border border-white/10 bg-white/[0.04] text-indigo-100 hover:border-fuchsia-300/40 hover:bg-fuchsia-500/15 hover:text-white"
                          }`}
                        >
                          <UserIcon className="h-3 w-3" />
                          {label}
                          {isMe && (
                            <span className="ml-0.5 rounded bg-white/20 px-1 py-0.5 text-[8px] font-semibold uppercase">
                              you
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-indigo-300/60">
                  <Hash className="h-3.5 w-3.5 text-indigo-300/70" />
                  Turns per agent
                </label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(Number(e.target.value))}
                  className={`${inputClass} w-28`}
                />
              </div>

              <div className="flex justify-end pt-1">
                <button
                  onClick={handleCreate}
                  disabled={!canSubmit}
                  className={btnPrimary}
                >
                  {creating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      Start Roundtable
                    </>
                  )}
                </button>
              </div>
            </div>
          </Box>

          {/* Existing roundtables */}
          <Box className={`${cardClass} animate-slide-up`}>
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-white">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-[0_0_18px_-4px_rgba(16,185,129,0.55)] ring-1 ring-white/15">
                <MessagesSquare className="h-4 w-4" />
              </div>
              Previous Roundtables
              <span className="rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-indigo-100">
                {roundtables.length}
              </span>
            </h2>

            {roundtables.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-10 text-center">
                <MessagesSquare className="mx-auto mb-2 h-6 w-6 text-indigo-300/40" />
                <p className="text-xs text-indigo-200/50">
                  No roundtables yet. Start one above to see it here.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {roundtables.map((rt) => {
                  const canResume =
                    rt.status === "failed" &&
                    (rt.createdBy == null || rt.createdBy === user?.id);
                  const isResumingThis = resumingId === rt.id;
                  return (
                    <div
                      key={rt.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/roundtable/${rt.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/roundtable/${rt.id}`);
                        }
                      }}
                      className="group w-full cursor-pointer rounded-xl border border-white/10 bg-white/[0.04] p-4 text-left backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-fuchsia-400/40 hover:bg-white/[0.07] hover:shadow-[0_0_28px_-8px_rgba(217,70,239,0.45)]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-white group-hover:text-fuchsia-100">
                            {rt.topic}
                          </p>
                          <p className="mt-1 flex items-center gap-2 text-[11px] text-indigo-200/60">
                            <Hash className="h-3 w-3" />
                            Round {rt.currentRound + 1} of {rt.maxTurnsPerAgent}
                            <span className="text-indigo-300/40">·</span>
                            {new Date(rt.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {canResume && (
                            <button
                              type="button"
                              onClick={(e) => void handleResumeFromList(e, rt.id)}
                              disabled={isResumingThis}
                              title="Trim orphan checkpoint state and re-run the failed turn"
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200 backdrop-blur-sm transition-all duration-200 hover:bg-emerald-500/20 hover:text-emerald-100 active:scale-[0.97] disabled:opacity-50"
                            >
                              {isResumingThis ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RotateCw className="h-3 w-3" />
                              )}
                              Resume
                            </button>
                          )}
                          <StatusPill status={rt.status} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Box>
        </Stack>
      </Container>
    </Stack>
  );
}

// ─── Roundtable detail view (chat-like display) ─────────────────────────────

const AGENT_ACCENTS = [
  {
    border: "border-l-indigo-400/60",
    dot: "bg-indigo-400",
    text: "text-indigo-200",
    chip: "bg-indigo-500/15 ring-indigo-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(129,140,248,0.65)]",
  },
  {
    border: "border-l-emerald-400/60",
    dot: "bg-emerald-400",
    text: "text-emerald-200",
    chip: "bg-emerald-500/15 ring-emerald-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(52,211,153,0.65)]",
  },
  {
    border: "border-l-amber-400/60",
    dot: "bg-amber-400",
    text: "text-amber-200",
    chip: "bg-amber-500/15 ring-amber-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(251,191,36,0.65)]",
  },
  {
    border: "border-l-rose-400/60",
    dot: "bg-rose-400",
    text: "text-rose-200",
    chip: "bg-rose-500/15 ring-rose-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(251,113,133,0.65)]",
  },
  {
    border: "border-l-cyan-400/60",
    dot: "bg-cyan-400",
    text: "text-cyan-200",
    chip: "bg-cyan-500/15 ring-cyan-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(34,211,238,0.65)]",
  },
  {
    border: "border-l-violet-400/60",
    dot: "bg-violet-400",
    text: "text-violet-200",
    chip: "bg-violet-500/15 ring-violet-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(167,139,250,0.65)]",
  },
  {
    border: "border-l-orange-400/60",
    dot: "bg-orange-400",
    text: "text-orange-200",
    chip: "bg-orange-500/15 ring-orange-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(251,146,60,0.65)]",
  },
  {
    border: "border-l-fuchsia-400/60",
    dot: "bg-fuchsia-400",
    text: "text-fuchsia-200",
    chip: "bg-fuchsia-500/15 ring-fuchsia-400/30",
    glow: "shadow-[0_0_24px_-10px_rgba(232,121,249,0.65)]",
  },
];

function RoundtableDetailView({ id }: { id: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const [data, setData] = useState<RoundtableDetail | null>(null);
  const [messages, setMessages] = useState<RoundtableMessageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // Where the discussion summary should render relative to the messages list:
  //   - "top"    → summary already existed when we entered the roundtable
  //                (post-completion review)
  //   - "bottom" → summary arrived live via socket while we were watching
  //                the roundtable; placed after the last message so the
  //                conversation reads top-to-bottom in arrival order.
  const [summaryPlacement, setSummaryPlacement] = useState<"top" | "bottom">("top");
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [userTurn, setUserTurn] = useState<{
    roundNumber: number;
    deadline: number;
    userId: number | null;
    displayName: string | null;
  } | null>(null);
  const [userDraft, setUserDraft] = useState("");
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const userDraftRef = useRef("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevMsgCountRef = useRef(0);

  const fetchData = useCallback(async () => {
    try {
      const result = await api.getRoundtable(id);
      setData(result);
      setMessages(result.messages);
      // Summary already present on entry → render at top (review mode).
      // If it isn't there yet, default to "bottom" so any later live arrival
      // appears after the messages we're watching.
      setSummaryPlacement(result.summary ? "top" : "bottom");
      if (result.status === "waiting_for_user") {
        const activeUser =
          result.users.find((u) => u.turnsCompleted <= result.currentRound) ??
          null;
        setUserTurn({
          roundNumber: result.currentRound,
          deadline: Date.now() + 5 * 60 * 1000,
          userId: activeUser?.userId ?? null,
          displayName: activeUser?.displayName ?? null,
        });
      }
    } catch (err) {
      console.error("Failed to load roundtable", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;

    const socket = getChatSocket(token);

    const handleMessage = (payload: {
      roundtableId: string;
      agentId: string | null;
      agentLabel: string;
      roundNumber: number;
      content: string;
      createdAt: string;
      senderType?: "agent" | "user";
      userId?: number | null;
      displayName?: string | null;
    }) => {
      if (payload.roundtableId !== id) return;
      setMessages((prev) => [
        ...prev,
        {
          id: `live-${Date.now()}`,
          agentId: payload.agentId ?? null,
          agentName: payload.agentLabel,
          roundNumber: payload.roundNumber,
          content: payload.content,
          createdAt: payload.createdAt,
          senderType: payload.senderType ?? "agent",
          userId: payload.userId ?? undefined,
          displayName: payload.displayName ?? undefined,
        },
      ]);
      if (payload.senderType === "user") {
        setUserTurn(null);
      }
    };

    const handleUserTurn = (payload: {
      roundtableId: string;
      roundNumber: number;
      userId: number;
      displayName: string;
      deadlineSeconds: number;
    }) => {
      if (payload.roundtableId !== id) return;
      setUserTurn({
        roundNumber: payload.roundNumber,
        deadline: Date.now() + payload.deadlineSeconds * 1000,
        userId: payload.userId,
        displayName: payload.displayName,
      });
      setUserDraft("");
      userDraftRef.current = "";
      setData((prev) => (prev ? { ...prev, status: "waiting_for_user" } : prev));
    };

    const handleCompleted = (payload: {
      roundtableId: string;
      summary?: string | null;
      summaryGeneratedAt?: string | null;
    }) => {
      if (payload.roundtableId !== id) return;
      setUserTurn(null);
      setData((prev) =>
        prev
          ? {
              ...prev,
              status: "completed",
              summary: payload.summary ?? prev.summary,
              summaryGeneratedAt:
                payload.summaryGeneratedAt ?? prev.summaryGeneratedAt,
            }
          : prev,
      );
    };

    const handleError = (payload: {
      roundtableId: string;
      error: string;
    }) => {
      if (payload.roundtableId !== id) return;
      setUserTurn(null);
      setData((prev) => (prev ? { ...prev, status: "failed" } : prev));
    };

    socket.on("roundtable:message", handleMessage);
    socket.on("roundtable:user_turn", handleUserTurn);
    socket.on("roundtable:completed", handleCompleted);
    socket.on("roundtable:error", handleError);

    return () => {
      socket.off("roundtable:message", handleMessage);
      socket.off("roundtable:user_turn", handleUserTurn);
      socket.off("roundtable:completed", handleCompleted);
      socket.off("roundtable:error", handleError);
    };
  }, [id]);

  useEffect(() => {
    if (messages.length > 0 && messages.length >= prevMsgCountRef.current) {
      const c = scrollContainerRef.current;
      if (c) c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  const handleStop = async () => {
    setStopping(true);
    try {
      await api.stopRoundtable(id);
      setData((prev) => (prev ? { ...prev, status: "completed" } : prev));
      toast("Roundtable stopped", "info");
    } catch (err: any) {
      toast(err.message ?? "Failed to stop roundtable", "error");
    } finally {
      setStopping(false);
    }
  };

  const handleResume = async () => {
    setResuming(true);
    try {
      const result = await api.resumeRoundtable(id);
      setData((prev) => (prev ? { ...prev, status: "running" } : prev));
      const trimmed = result.trimmedMessages ?? 0;
      toast(
        trimmed > 0
          ? `Roundtable resumed — trimmed ${trimmed} orphan message${trimmed === 1 ? "" : "s"}`
          : "Roundtable resumed",
        "info",
      );
    } catch (err: any) {
      toast(err.message ?? "Failed to resume roundtable", "error");
    } finally {
      setResuming(false);
    }
  };

  const submitUserTurn = useCallback(
    async (content: string) => {
      if (submittingTurn) return;
      setSubmittingTurn(true);
      try {
        await api.submitRoundtableUserTurn(id, content);
        setUserTurn(null);
        setUserDraft("");
        userDraftRef.current = "";
      } catch (err: any) {
        toast(err.message ?? "Failed to submit your turn", "error");
      } finally {
        setSubmittingTurn(false);
      }
    },
    [id, submittingTurn, toast],
  );

  useEffect(() => {
    userDraftRef.current = userDraft;
  }, [userDraft]);

  const isMyTurn = !!userTurn && userTurn.userId === user?.id;

  useEffect(() => {
    if (!userTurn) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((userTurn.deadline - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      // Only the active user auto-submits when the timer expires.
      if (remaining === 0 && isMyTurn) {
        void submitUserTurn(userDraftRef.current);
      }
    };
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [userTurn, submitUserTurn, isMyTurn]);

  const agentAccentMap = useMemo(() => {
    const map = new Map<string, (typeof AGENT_ACCENTS)[number]>();
    data?.agents.forEach((a, i) => {
      map.set(a.agentId, AGENT_ACCENTS[i % AGENT_ACCENTS.length]);
    });
    return map;
  }, [data]);

  if (loading) {
    return (
      <div className="space-bg relative flex h-screen items-center justify-center">
        <SpaceAmbient />
        <div className="relative flex flex-col items-center gap-3">
          <div className="relative flex h-16 w-16 items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-500/40 via-violet-500/30 to-fuchsia-500/30 blur-xl aurora-glow" />
            <Loader2 className="relative h-8 w-8 animate-spin text-indigo-200" />
          </div>
          <p className="text-xs font-medium text-indigo-200/60">
            Loading roundtable...
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-bg relative flex h-screen flex-col items-center justify-center gap-4">
        <SpaceAmbient />
        <div className="relative flex flex-col items-center gap-4">
          <AlertTriangle className="h-8 w-8 text-rose-300/80" />
          <p className="text-sm text-indigo-200/70">Roundtable not found</p>
          <button onClick={() => navigate("/roundtable")} className={btnGhost}>
            <ArrowLeft className="h-4 w-4" />
            Back to list
          </button>
        </div>
      </div>
    );
  }

  const isActive =
    data.status === "running" ||
    data.status === "pending" ||
    data.status === "waiting_for_user";

  return (
    <div className="space-bg relative flex h-[100dvh] flex-col overflow-hidden">
      <SpaceAmbient />

      {/* Header — z-30 so the NotificationBell popover (z-50 inside) renders
          above the messages container (z-10) below. Sharing z-10 with the
          messages would let them stack over the dropdown despite the inner
          z-50, since they live in the same parent stacking context. */}
      <header className="relative z-30 shrink-0 border-b border-white/5 bg-slate-950/50 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <button
              onClick={() => navigate("/roundtable")}
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-indigo-200/80 backdrop-blur-sm transition-all hover:-translate-x-0.5 hover:border-fuchsia-400/40 hover:bg-white/[0.08] hover:text-white"
              aria-label="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              {/* Row 1: topic title only */}
              <h1 className="truncate text-base font-semibold text-white sm:text-lg">
                {data.topic}
              </h1>
              {/* Row 2: status pill + round indicator (always together) */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-indigo-200/60">
                <StatusPill status={data.status} />
                <span className="inline-flex items-center gap-1">
                  <Hash className="h-3 w-3 text-indigo-300/70" />
                  Round {data.currentRound + 1} of {data.maxTurnsPerAgent}
                </span>
              </div>
              {/* Row 3: participant chips on their own line so they get the
                  full content width and never get crammed next to the status
                  on mobile. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {data.agents.map((a) => {
                  const accent = agentAccentMap.get(a.agentId);
                  return (
                    <span
                      key={a.agentId}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 backdrop-blur-sm ${accent?.chip ?? "bg-white/[0.04] ring-white/10"} ${accent?.text ?? "text-indigo-100"}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${accent?.dot ?? "bg-indigo-300"}`}
                      />
                      {a.agentName}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Center the dropdown under the bell when a Stop or Resume button
                follows it — otherwise the panel anchors to the bell's right
                edge and visually overlaps the sibling button on mobile. */}
            <NotificationBell
              align={isActive || data.status === "failed" ? "center" : "end"}
            />
            {isActive && (
              <button
                onClick={handleStop}
                disabled={stopping}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-200 backdrop-blur-sm transition-all duration-200 hover:bg-rose-500/20 hover:text-rose-100 hover:shadow-[0_0_18px_-6px_rgba(244,63,94,0.65)] active:scale-[0.98] disabled:opacity-50"
              >
                {stopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-3.5 w-3.5 fill-rose-300" />
                )}
                Stop
              </button>
            )}
            {data.status === "failed" && (
              <button
                onClick={handleResume}
                disabled={resuming}
                title="Trim any orphan checkpoint state and re-run the failed turn"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-200 backdrop-blur-sm transition-all duration-200 hover:bg-emerald-500/20 hover:text-emerald-100 hover:shadow-[0_0_18px_-6px_rgba(16,185,129,0.65)] active:scale-[0.98] disabled:opacity-50"
              >
                {resuming ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" />
                )}
                Resume
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollContainerRef} className="relative z-10 flex-1 overflow-y-auto dark-scroll">
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6 lg:px-8">
          {/* Discussion summary — rendered either at the top (review mode:
              already present when we loaded the roundtable) or at the bottom
              (live mode: arrived via socket while we were watching). The two
              slots use the same markup; placement is controlled by
              `summaryPlacement` set in `fetchData`. */}
          {data.summary && summaryPlacement === "top" && (
            <div className="glass-panel-elevated animate-slide-up overflow-hidden rounded-2xl">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-gradient-to-r from-indigo-500/10 via-violet-500/10 to-fuchsia-500/10 px-5 py-3 backdrop-blur-sm">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-[0_0_18px_-4px_rgba(168,85,247,0.7)] ring-1 ring-white/15">
                    <ScrollText className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-sm font-bold text-white">
                      Discussion Summary
                    </h2>
                    <p className="text-[11px] text-indigo-200/60">
                      Auto-generated when the roundtable ended
                      {data.summaryGeneratedAt && (
                        <>
                          <span className="text-indigo-300/30"> · </span>
                          {new Date(data.summaryGeneratedAt).toLocaleString()}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-400/30 backdrop-blur-sm">
                  <Sparkles className="h-3 w-3" />
                  AI
                </span>
              </div>
              <div className="chat-prose chat-prose-dark px-5 py-4 text-sm text-slate-100">
                <Markdown remarkPlugins={[remarkGfm]}>{data.summary}</Markdown>
              </div>
            </div>
          )}

          {messages.length === 0 &&
            data.status !== "completed" &&
            data.status !== "failed" && (
              <div className="flex items-center justify-center py-16">
                <div className="text-center">
                  <div className="relative mx-auto mb-4 h-14 w-14">
                    <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-500/40 via-violet-500/40 to-fuchsia-500/40 blur-xl aurora-glow" />
                    <div className="absolute inset-0 animate-ping rounded-full bg-fuchsia-400/25" />
                    <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-[0_0_28px_-4px_rgba(168,85,247,0.75)] ring-1 ring-white/20">
                      <MessagesSquare className="h-6 w-6" />
                    </div>
                  </div>
                  <p className="text-sm font-medium text-white">
                    Waiting for the first agent to speak
                  </p>
                  <p className="mt-1 text-xs text-indigo-200/60">
                    Responses will stream in live
                  </p>
                </div>
              </div>
            )}

          {data.status === "failed" && (
            <div className="glass-panel-elevated animate-slide-up rounded-2xl border border-rose-400/30 p-5 shadow-[0_0_24px_-10px_rgba(244,63,94,0.55)]">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 ring-1 ring-rose-400/40 backdrop-blur-sm">
                    <AlertTriangle className="h-4 w-4 text-rose-200" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white">
                      This roundtable failed mid-run
                    </p>
                    <p className="mt-0.5 text-[12px] text-indigo-200/70">
                      {messages.length === 0
                        ? "No turns completed before the failure. Resume to start over from round 1."
                        : `Resuming will trim any orphan checkpoint state and re-run round ${data.currentRound + 1} starting with the agent that died.`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleResume}
                  disabled={resuming}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-200 backdrop-blur-sm transition-all duration-200 hover:bg-emerald-500/20 hover:text-emerald-100 hover:shadow-[0_0_18px_-6px_rgba(16,185,129,0.65)] active:scale-[0.98] disabled:opacity-50"
                >
                  {resuming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCw className="h-3.5 w-3.5" />
                  )}
                  Resume
                </button>
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const showRoundHeader =
              i === 0 || messages[i - 1].roundNumber !== msg.roundNumber;
            const isUser =
              msg.senderType === "user" || (msg.userId != null && !msg.agentId);
            const isMe = isUser && msg.userId != null && msg.userId === user?.id;
            const accent = msg.agentId ? agentAccentMap.get(msg.agentId) : undefined;

            return (
              <div key={msg.id} className="animate-slide-up">
                {showRoundHeader && (
                  <div className="flex items-center gap-3 py-3">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-indigo-400/30 to-fuchsia-400/30" />
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-indigo-100 backdrop-blur-sm">
                      <Hash className="h-3 w-3 text-indigo-300/70" />
                      Round {msg.roundNumber + 1}
                    </span>
                    <div className="h-px flex-1 bg-gradient-to-l from-transparent via-indigo-400/30 to-fuchsia-400/30" />
                  </div>
                )}
                {isUser ? (
                  <div className="rounded-2xl border border-fuchsia-400/25 border-l-4 border-l-fuchsia-400/70 bg-gradient-to-br from-fuchsia-500/[0.08] via-violet-500/[0.05] to-indigo-500/[0.06] p-4 backdrop-blur-xl sm:p-5 shadow-[0_0_24px_-10px_rgba(232,121,249,0.5)]">
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-fuchsia-500/20 ring-1 ring-fuchsia-400/40 backdrop-blur-sm">
                          <UserIcon className="h-3.5 w-3.5 text-fuchsia-200" />
                        </span>
                        <span className="text-sm font-semibold text-white">
                          {msg.displayName ?? msg.agentName ?? "User"}
                        </span>
                        {isMe && (
                          <span className="rounded-full bg-fuchsia-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-100 ring-1 ring-fuchsia-400/40">
                            You
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-indigo-200/50">
                        {new Date(msg.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div
                    className={`rounded-2xl border border-white/10 border-l-4 bg-white/[0.04] p-4 backdrop-blur-xl sm:p-5 ${accent?.border ?? "border-l-indigo-400/40"} ${accent?.glow ?? ""}`}
                  >
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`flex h-7 w-7 items-center justify-center rounded-lg ring-1 backdrop-blur-sm ${accent?.chip ?? "bg-white/[0.06] ring-white/10"}`}
                        >
                          <Bot
                            className={`h-3.5 w-3.5 ${accent?.text ?? "text-indigo-200"}`}
                          />
                        </span>
                        <span className="text-sm font-semibold text-white">
                          {msg.agentName}
                        </span>
                      </div>
                      <span className="text-[11px] text-indigo-200/50">
                        {new Date(msg.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
                      {msg.content}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Live-arrival placement of the discussion summary — rendered after
              the last message so the conversation reads top-to-bottom in
              arrival order for users who watched it complete in real time. */}
          {data.summary && summaryPlacement === "bottom" && (
            <div className="glass-panel-elevated animate-slide-up overflow-hidden rounded-2xl">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-gradient-to-r from-indigo-500/10 via-violet-500/10 to-fuchsia-500/10 px-5 py-3 backdrop-blur-sm">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-[0_0_18px_-4px_rgba(168,85,247,0.7)] ring-1 ring-white/15">
                    <ScrollText className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-sm font-bold text-white">
                      Discussion Summary
                    </h2>
                    <p className="text-[11px] text-indigo-200/60">
                      Auto-generated when the roundtable ended
                      {data.summaryGeneratedAt && (
                        <>
                          <span className="text-indigo-300/30"> · </span>
                          {new Date(data.summaryGeneratedAt).toLocaleString()}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-400/30 backdrop-blur-sm">
                  <Sparkles className="h-3 w-3" />
                  AI
                </span>
              </div>
              <div className="chat-prose chat-prose-dark px-5 py-4 text-sm text-slate-100">
                <Markdown remarkPlugins={[remarkGfm]}>{data.summary}</Markdown>
              </div>
            </div>
          )}

          {data.status === "running" && messages.length > 0 && (
            <div className="flex items-center gap-2.5 rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100 backdrop-blur-sm shadow-[0_0_18px_-8px_rgba(129,140,248,0.55)]">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-200" />
              <span className="font-medium">Next agent is thinking…</span>
              <span className="flex gap-1">
                <span className="typing-dot h-1.5 w-1.5" />
                <span
                  className="typing-dot h-1.5 w-1.5"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="typing-dot h-1.5 w-1.5"
                  style={{ animationDelay: "300ms" }}
                />
              </span>
            </div>
          )}

          {userTurn && data.status === "waiting_for_user" && !isMyTurn && (
            <div className="glass-panel-elevated animate-slide-up rounded-2xl border border-white/10 p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-500/15 ring-1 ring-indigo-400/30 backdrop-blur-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-200" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">
                      Waiting for {userTurn.displayName ?? "another participant"}…
                    </p>
                    <p className="text-[11px] text-indigo-200/60">
                      Round {userTurn.roundNumber + 1} — they have up to 5
                      minutes to contribute.
                    </p>
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-200 ring-1 ring-indigo-400/30 backdrop-blur-sm">
                  <Timer className="h-3 w-3" />
                  {Math.floor(secondsLeft / 60)}:
                  {String(secondsLeft % 60).padStart(2, "0")}
                </span>
              </div>
            </div>
          )}

          {userTurn && isMyTurn && (
            <div className="glass-panel-elevated animate-slide-up rounded-2xl border-l-4 border-l-fuchsia-400/70 p-4 shadow-[0_0_36px_-10px_rgba(217,70,239,0.55)] sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-fuchsia-500/15 ring-1 ring-fuchsia-400/30 backdrop-blur-sm">
                    <UserIcon className="h-4 w-4 text-fuchsia-200" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white">
                      Your turn{user?.displayName ? `, ${user.displayName}` : ""}
                    </p>
                    <p className="text-[11px] text-indigo-200/60">
                      Round {userTurn.roundNumber + 1} — share your thoughts before the window closes
                    </p>
                  </div>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold backdrop-blur-sm ${
                    secondsLeft <= 30
                      ? "bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/40"
                      : "bg-fuchsia-500/15 text-fuchsia-200 ring-1 ring-fuchsia-400/30"
                  }`}
                >
                  <Timer
                    className={`h-3 w-3 ${secondsLeft <= 30 ? "animate-pulse-soft" : ""}`}
                  />
                  {Math.floor(secondsLeft / 60)}:
                  {String(secondsLeft % 60).padStart(2, "0")}
                </span>
              </div>
              <textarea
                value={userDraft}
                onChange={(e) => setUserDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    (e.metaKey || e.ctrlKey) &&
                    userDraft.trim()
                  ) {
                    e.preventDefault();
                    void submitUserTurn(userDraft.trim());
                  }
                }}
                placeholder="Type your contribution..."
                rows={3}
                disabled={submittingTurn}
                className={`${inputClass} resize-none`}
                autoFocus
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-[11px] text-indigo-200/50">
                  <kbd className="rounded border border-white/15 bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-indigo-100">
                    {typeof navigator !== "undefined" &&
                    navigator.platform.includes("Mac")
                      ? "⌘"
                      : "Ctrl"}{" "}
                    + Enter
                  </kbd>
                  <span className="ml-1.5">to send · empty = skip</span>
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void submitUserTurn("")}
                    disabled={submittingTurn}
                    className={btnGhost}
                  >
                    Skip
                  </button>
                  <button
                    onClick={() => void submitUserTurn(userDraft.trim())}
                    disabled={!userDraft.trim() || submittingTurn}
                    className={btnPrimary}
                  >
                    {submittingTurn ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <Send className="h-4 w-4" />
                        Send turn
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function RoundtablePage() {
  const { id } = useParams<{ id: string }>();

  if (id) {
    return <RoundtableDetailView id={id} />;
  }
  return <RoundtableListView />;
}
