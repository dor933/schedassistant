import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
} from "lucide-react";
import { useToast } from "../components/Toast";
import { getChatSocket } from "../sockets/chatSocket";
import {
  admin as api,
  type AdminAgent,
  type RoundtableSummary,
  type RoundtableDetail,
  type RoundtableMessageInfo,
} from "../api";

// ─── Shared design tokens ───────────────────────────────────────────────────

const inputClass =
  "w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-2.5 text-sm transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10";

const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md hover:shadow-indigo-200/50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";

const btnGhost =
  "inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm active:scale-[0.98]";

const cardClass =
  "rounded-2xl border border-gray-200/60 bg-white/80 p-5 sm:p-6 shadow-glass backdrop-blur-sm";

function StatusPill({ status }: { status: string }) {
  const map: Record<
    string,
    { className: string; Icon: typeof Clock; label: string }
  > = {
    pending: {
      className: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/70",
      Icon: Clock,
      label: "Pending",
    },
    running: {
      className: "bg-blue-50 text-blue-700 ring-1 ring-blue-200/70",
      Icon: Radio,
      label: "Running",
    },
    completed: {
      className: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70",
      Icon: CheckCircle2,
      label: "Completed",
    },
    failed: {
      className: "bg-rose-50 text-rose-700 ring-1 ring-rose-200/70",
      Icon: AlertTriangle,
      label: "Failed",
    },
  };
  const entry = map[status] ?? {
    className: "bg-gray-100 text-gray-600 ring-1 ring-gray-200/70",
    Icon: Clock,
    label: status,
  };
  const { Icon, className, label } = entry;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${className}`}
    >
      <Icon
        className={`h-3 w-3 ${status === "running" ? "animate-pulse-soft" : ""}`}
      />
      {label}
    </span>
  );
}

// ─── Roundtable list + create form ─────────────────────────────────────────

function RoundtableListView() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [roundtables, setRoundtables] = useState<RoundtableSummary[]>([]);
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [topic, setTopic] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [maxTurns, setMaxTurns] = useState(5);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.getRoundtables().then(setRoundtables).catch(console.error);
    api.getAgents().then(setAgents).catch(console.error);
  }, []);

  const toggleAgent = (id: string) => {
    setSelectedAgentIds((prev) =>
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
      className="min-h-screen w-full bg-gradient-to-br from-slate-50 via-white to-indigo-50/30"
    >
      <Container
        maxWidth={false}
        disableGutters
        className="mx-auto box-border w-full min-w-0 max-w-5xl px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8"
      >
        {/* Sticky header */}
        <Stack
          component="header"
          direction="row"
          className="sticky top-0 z-10 -mx-4 mb-6 min-w-0 items-center justify-between gap-3 border-b border-gray-200/60 bg-white/90 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:mb-8 sm:px-6 sm:py-4 lg:-mx-8 lg:px-8"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm">
              <MessagesSquare className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold tracking-tight text-gray-900">
                Roundtables
              </h1>
              <p className="text-[10px] sm:text-xs text-gray-400">
                Multi-agent discussions
              </p>
            </div>
          </div>
          <button onClick={() => navigate("/")} className={btnGhost}>
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back to Chat</span>
          </button>
        </Stack>

        <Stack component="section" className="w-full min-w-0 space-y-6 sm:space-y-8">
          {/* Create form */}
          <Box className={`${cardClass} animate-slide-up`}>
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm">
                <Sparkles className="h-4 w-4" />
              </div>
              New Roundtable Discussion
            </h2>

            <div className="space-y-5">
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
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
                <label className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <Users2 className="h-3.5 w-3.5 text-gray-400" />
                  Participants
                  <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-gray-500">
                    {selectedAgentIds.length} selected · min 2
                  </span>
                </label>
                {agents.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-4 py-6 text-center text-xs text-gray-400">
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
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.97] ${
                            selected
                              ? "bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-sm shadow-indigo-200/50"
                              : "border border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:bg-indigo-50/50 hover:text-indigo-700"
                          }`}
                        >
                          <Bot className="h-3 w-3" />
                          {a.agentName || a.definition}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <Hash className="h-3.5 w-3.5 text-gray-400" />
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
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
                <MessagesSquare className="h-4 w-4" />
              </div>
              Previous Roundtables
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {roundtables.length}
              </span>
            </h2>

            {roundtables.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/40 px-4 py-10 text-center">
                <MessagesSquare className="mx-auto mb-2 h-6 w-6 text-gray-300" />
                <p className="text-xs text-gray-400">
                  No roundtables yet. Start one above to see it here.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {roundtables.map((rt) => (
                  <button
                    key={rt.id}
                    onClick={() => navigate(`/roundtable/${rt.id}`)}
                    className="group w-full rounded-xl border border-gray-200/70 bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md hover:shadow-indigo-100/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-gray-800 group-hover:text-indigo-700">
                          {rt.topic}
                        </p>
                        <p className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
                          <Hash className="h-3 w-3" />
                          Round {rt.currentRound + 1} of {rt.maxTurnsPerAgent}
                          <span className="text-gray-300">·</span>
                          {new Date(rt.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <StatusPill status={rt.status} />
                    </div>
                  </button>
                ))}
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
  { border: "border-l-indigo-400", dot: "bg-indigo-500", text: "text-indigo-700", chip: "bg-indigo-50 ring-indigo-200/70" },
  { border: "border-l-emerald-400", dot: "bg-emerald-500", text: "text-emerald-700", chip: "bg-emerald-50 ring-emerald-200/70" },
  { border: "border-l-amber-400", dot: "bg-amber-500", text: "text-amber-700", chip: "bg-amber-50 ring-amber-200/70" },
  { border: "border-l-rose-400", dot: "bg-rose-500", text: "text-rose-700", chip: "bg-rose-50 ring-rose-200/70" },
  { border: "border-l-cyan-400", dot: "bg-cyan-500", text: "text-cyan-700", chip: "bg-cyan-50 ring-cyan-200/70" },
  { border: "border-l-violet-400", dot: "bg-violet-500", text: "text-violet-700", chip: "bg-violet-50 ring-violet-200/70" },
  { border: "border-l-orange-400", dot: "bg-orange-500", text: "text-orange-700", chip: "bg-orange-50 ring-orange-200/70" },
  { border: "border-l-teal-400", dot: "bg-teal-500", text: "text-teal-700", chip: "bg-teal-50 ring-teal-200/70" },
];

function RoundtableDetailView({ id }: { id: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [data, setData] = useState<RoundtableDetail | null>(null);
  const [messages, setMessages] = useState<RoundtableMessageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await api.getRoundtable(id);
      setData(result);
      setMessages(result.messages);
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
      agentId: string;
      agentLabel: string;
      roundNumber: number;
      content: string;
      createdAt: string;
    }) => {
      if (payload.roundtableId !== id) return;
      setMessages((prev) => [
        ...prev,
        {
          id: `live-${Date.now()}`,
          agentId: payload.agentId,
          agentName: payload.agentLabel,
          roundNumber: payload.roundNumber,
          content: payload.content,
          createdAt: payload.createdAt,
        },
      ]);
    };

    const handleCompleted = (payload: { roundtableId: string }) => {
      if (payload.roundtableId !== id) return;
      setData((prev) => (prev ? { ...prev, status: "completed" } : prev));
    };

    const handleError = (payload: {
      roundtableId: string;
      error: string;
    }) => {
      if (payload.roundtableId !== id) return;
      setData((prev) => (prev ? { ...prev, status: "failed" } : prev));
    };

    socket.on("roundtable:message", handleMessage);
    socket.on("roundtable:completed", handleCompleted);
    socket.on("roundtable:error", handleError);

    return () => {
      socket.off("roundtable:message", handleMessage);
      socket.off("roundtable:completed", handleCompleted);
      socket.off("roundtable:error", handleError);
    };
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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

  const agentAccentMap = useMemo(() => {
    const map = new Map<string, (typeof AGENT_ACCENTS)[number]>();
    data?.agents.forEach((a, i) => {
      map.set(a.agentId, AGENT_ACCENTS[i % AGENT_ACCENTS.length]);
    });
    return map;
  }, [data]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
        <AlertTriangle className="h-8 w-8 text-gray-300" />
        <p className="text-sm text-gray-500">Roundtable not found</p>
        <button onClick={() => navigate("/roundtable")} className={btnGhost}>
          <ArrowLeft className="h-4 w-4" />
          Back to list
        </button>
      </div>
    );
  }

  const isActive = data.status === "running" || data.status === "pending";

  return (
    <div className="flex h-screen flex-col bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
      {/* Header */}
      <header className="shrink-0 border-b border-gray-200/60 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <button
              onClick={() => navigate("/roundtable")}
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500 transition-all hover:-translate-x-0.5 hover:border-indigo-200 hover:text-indigo-600"
              aria-label="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold text-gray-900 sm:text-lg">
                  {data.topic}
                </h1>
                <StatusPill status={data.status} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                <span className="inline-flex items-center gap-1">
                  <Hash className="h-3 w-3 text-gray-400" />
                  Round {data.currentRound + 1} of {data.maxTurnsPerAgent}
                </span>
                <span className="text-gray-300">·</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {data.agents.map((a) => {
                    const accent = agentAccentMap.get(a.agentId);
                    return (
                      <span
                        key={a.agentId}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${accent?.chip ?? "bg-gray-50 ring-gray-200/70"} ${accent?.text ?? "text-gray-600"}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${accent?.dot ?? "bg-gray-400"}`}
                        />
                        {a.agentName}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          {isActive && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-600 transition-all duration-200 hover:bg-rose-50 hover:shadow-sm active:scale-[0.98] disabled:opacity-50"
            >
              {stopping ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5 fill-rose-600" />
              )}
              Stop
            </button>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6 lg:px-8">
          {messages.length === 0 && data.status !== "completed" && (
            <div className="flex items-center justify-center py-16">
              <div className="text-center">
                <div className="relative mx-auto mb-4 h-12 w-12">
                  <div className="absolute inset-0 animate-ping rounded-full bg-indigo-400/30" />
                  <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-indigo-200/50">
                    <MessagesSquare className="h-5 w-5" />
                  </div>
                </div>
                <p className="text-sm font-medium text-gray-600">
                  Waiting for the first agent to speak
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  Responses will stream in live
                </p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const showRoundHeader =
              i === 0 || messages[i - 1].roundNumber !== msg.roundNumber;
            const accent = agentAccentMap.get(msg.agentId);

            return (
              <div key={msg.id} className="animate-slide-up">
                {showRoundHeader && (
                  <div className="flex items-center gap-3 py-3">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent to-gray-200" />
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 shadow-sm">
                      <Hash className="h-3 w-3 text-gray-400" />
                      Round {msg.roundNumber + 1}
                    </span>
                    <div className="h-px flex-1 bg-gradient-to-l from-transparent to-gray-200" />
                  </div>
                )}
                <div
                  className={`rounded-2xl border border-gray-200/60 border-l-4 bg-white/90 p-4 shadow-glass backdrop-blur-sm sm:p-5 ${accent?.border ?? "border-l-gray-300"}`}
                >
                  <div className="mb-2.5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`flex h-7 w-7 items-center justify-center rounded-lg ${accent?.chip ?? "bg-gray-50 ring-1 ring-gray-200/70"}`}
                      >
                        <Bot
                          className={`h-3.5 w-3.5 ${accent?.text ?? "text-gray-500"}`}
                        />
                      </span>
                      <span className="text-sm font-semibold text-gray-800">
                        {msg.agentName}
                      </span>
                    </div>
                    <span className="text-[11px] text-gray-400">
                      {new Date(msg.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          })}

          {data.status === "running" && messages.length > 0 && (
            <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-indigo-200/80 bg-indigo-50/40 px-4 py-3 text-sm text-indigo-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="font-medium">Next agent is thinking…</span>
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-indigo-400" />
                <span
                  className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-indigo-400"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-indigo-400"
                  style={{ animationDelay: "300ms" }}
                />
              </span>
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
