import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getChatSocket } from "../sockets/chatSocket";
import {
  admin as api,
  type AdminAgent,
  type RoundtableSummary,
  type RoundtableDetail,
  type RoundtableMessageInfo,
} from "../api";

// ─── Roundtable list + create form ─────────────────────────────────────────

function RoundtableListView() {
  const navigate = useNavigate();
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
      alert(err.message);
    } finally {
      setCreating(false);
    }
  };

  const statusColor: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-700",
    running: "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">Roundtables</h1>
        <button
          onClick={() => navigate("/")}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Back to Chat
        </button>
      </div>

      {/* Create form */}
      <div className="rounded-2xl border border-gray-200/60 bg-white/80 p-6 shadow-sm backdrop-blur-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-700">
          New Roundtable Discussion
        </h2>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">
              Topic
            </label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Describe the discussion topic for the agents..."
              rows={3}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-600">
              Select Agents ({selectedAgentIds.length} selected, minimum 2)
            </label>
            <div className="flex flex-wrap gap-2">
              {agents.map((a) => {
                const selected = selectedAgentIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => toggleAgent(a.id)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {a.agentName || a.definition}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">
              Turns per agent
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Number(e.target.value))}
              className="w-24 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <button
            onClick={handleCreate}
            disabled={creating || !topic.trim() || selectedAgentIds.length < 2}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? "Starting..." : "Start Roundtable"}
          </button>
        </div>
      </div>

      {/* Existing roundtables */}
      {roundtables.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-700">
            Previous Roundtables
          </h2>
          {roundtables.map((rt) => (
            <button
              key={rt.id}
              onClick={() => navigate(`/roundtable/${rt.id}`)}
              className="w-full rounded-xl border border-gray-200/60 bg-white p-4 text-left shadow-sm transition-all hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-gray-800">
                    {rt.topic}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Round {rt.currentRound + 1} of {rt.maxTurnsPerAgent}
                    {" \u00b7 "}
                    {new Date(rt.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[rt.status] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {rt.status}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Roundtable detail view (chat-like display) ─────────────────────────────

function RoundtableDetailView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<RoundtableDetail | null>(null);
  const [messages, setMessages] = useState<RoundtableMessageInfo[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Socket.IO: live updates
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

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleStop = async () => {
    try {
      await api.stopRoundtable(id);
      setData((prev) => (prev ? { ...prev, status: "completed" } : prev));
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-gray-500">Roundtable not found</p>
        <button
          onClick={() => navigate("/roundtable")}
          className="text-sm text-indigo-600 hover:underline"
        >
          Back to list
        </button>
      </div>
    );
  }

  const statusColor: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-700",
    running: "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };

  const agentColors = [
    "border-l-indigo-400",
    "border-l-emerald-400",
    "border-l-amber-400",
    "border-l-rose-400",
    "border-l-cyan-400",
    "border-l-violet-400",
    "border-l-orange-400",
    "border-l-teal-400",
  ];

  const agentColorMap = new Map<string, string>();
  data.agents.forEach((a, i) => {
    agentColorMap.set(a.agentId, agentColors[i % agentColors.length]);
  });

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-gray-200 bg-white/80 px-6 py-4 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate("/roundtable")}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                &larr;
              </button>
              <h1 className="truncate text-lg font-semibold text-gray-800">
                {data.topic}
              </h1>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[data.status] ?? "bg-gray-100"}`}
              >
                {data.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              {data.agents.map((a) => a.agentName).join(", ")}
              {" \u00b7 "}
              Round {data.currentRound + 1} of {data.maxTurnsPerAgent}
            </p>
          </div>
          {(data.status === "running" || data.status === "pending") && (
            <button
              onClick={handleStop}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
          {messages.length === 0 && data.status !== "completed" && (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-4 border-indigo-400 border-t-transparent" />
                <p className="text-sm text-gray-400">
                  Waiting for the first agent to speak...
                </p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const showRoundHeader =
              i === 0 || messages[i - 1].roundNumber !== msg.roundNumber;

            return (
              <div key={msg.id}>
                {showRoundHeader && (
                  <div className="flex items-center gap-3 py-2">
                    <div className="h-px flex-1 bg-gray-200" />
                    <span className="text-xs font-medium text-gray-400">
                      Round {msg.roundNumber + 1}
                    </span>
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>
                )}
                <div
                  className={`rounded-xl border-l-4 bg-white p-4 shadow-sm ${agentColorMap.get(msg.agentId) ?? "border-l-gray-300"}`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-700">
                      {msg.agentName}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(msg.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-600">
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          })}

          {data.status === "running" && messages.length > 0 && (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
              <span>Next agent is thinking...</span>
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
