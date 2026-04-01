import { useState, useEffect } from "react";
import { AdminAgent, AdminMcpServer } from "../api";
import { Box } from "@mui/material";
import { Loader2, Save, X, Pencil, Plug } from "lucide-react";
import { admin } from "../api";
import { stringifyAgentCharacteristics } from "../pages/AdminPage";
import { useToast } from "./Toast";

export default function AgentCard({
    agent,
    currentUserId,
    currentUserRole,
    allMcpServers,
    onSaved,
  }: {
    agent: AdminAgent;
    currentUserId: number;
    currentUserRole: string;
    allMcpServers: AdminMcpServer[];
    onSaved: () => void;
  }) {
    const { toast } = useToast();
    const groupCount = agent.groupCount ?? 0;
    // Admins can only see/edit core instructions for agents they created; super_admin can always
    const canViewCoreInstructions =
      currentUserRole === "super_admin" ||
      agent.createdByUserId === currentUserId;
    const [editing, setEditing] = useState(false);
    const [definition, setDefinition] = useState(agent.definition ?? "");
    const [instructions, setInstructions] = useState(
      agent.coreInstructions ?? "",
    );
    const [characteristicsJson, setCharacteristicsJson] = useState(
      stringifyAgentCharacteristics(agent.characteristics),
    );
    const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<number[]>(
      agent.mcpServerIds ?? [],
    );
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      setDefinition(agent.definition ?? "");
      setInstructions(agent.coreInstructions ?? "");
      setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
      setSelectedMcpServerIds(agent.mcpServerIds ?? []);
    }, [agent]);

    function toggleMcpServer(id: number) {
      setSelectedMcpServerIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    }

    async function save() {
      let characteristics: Record<string, unknown> | null = null;
      const trimmed = characteristicsJson.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            toast("Characteristics must be a JSON object (e.g. {\"tone\": \"...\"}).", "error");
            return;
          }
          characteristics = parsed as Record<string, unknown>;
        } catch {
          toast("Invalid JSON in characteristics.", "error");
          return;
        }
      }

      setSaving(true);
      try {
        await admin.updateAgent(agent.id, {
          definition: definition || undefined,
          ...(canViewCoreInstructions ? { coreInstructions: instructions || undefined } : {}),
          characteristics,
          mcpServerIds: selectedMcpServerIds,
        });
        setEditing(false);
        onSaved();
      } catch {
        /* ignore */
      } finally {
        setSaving(false);
      }
    }

    const smallInput =
      "w-full rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-xs transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10";

    // Resolve assigned server names for display mode
    const assignedServers = allMcpServers.filter((s) =>
      (agent.mcpServerIds ?? []).includes(s.id),
    );

    return (
      <Box className="rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200 hover:shadow-md min-w-0">
        <p className="mb-2 break-all font-mono text-[10px] text-gray-400">{agent.id}</p>
        {editing ? (
          <div className="space-y-3">
            {/* Definition */}
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Definition (role label)
              </label>
              <input
                value={definition}
                onChange={(e) => setDefinition(e.target.value)}
                placeholder='e.g. "AI Default Agent"'
                maxLength={30}
                className={smallInput}
              />
              <p className={`text-[10px] text-right ${definition.length >= 30 ? "text-red-400" : "text-gray-400"}`}>{definition.length}/30</p>
            </div>

            {/* Instructions (restricted) */}
            {canViewCoreInstructions && (
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Instructions
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="Detailed instructions for the agent..."
                className={smallInput + " resize-y"}
              />
            </div>
            )}

            {/* Characteristics */}
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Characteristics (JSON object)
              </label>
              <textarea
                value={characteristicsJson}
                onChange={(e) => setCharacteristicsJson(e.target.value)}
                rows={5}
                placeholder='{"tone": "..."}'
                className={smallInput + " resize-y font-mono text-[11px]"}
              />
            </div>

            {/* MCP Servers */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <Plug className="h-3 w-3" />
                MCP Servers
              </label>
              <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                {allMcpServers.map((s) => {
                  const selected = selectedMcpServerIds.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleMcpServer(s.id)}
                      className={`group/chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                        selected
                          ? "bg-gradient-to-r from-violet-50 to-indigo-50 text-violet-700 ring-1 ring-violet-200/80 shadow-sm"
                          : "bg-white text-gray-400 ring-1 ring-gray-200 hover:bg-gray-50 hover:text-gray-600 hover:ring-gray-300"
                      }`}
                    >
                      <span
                        className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[9px] font-bold transition-colors duration-150 ${
                          selected
                            ? "bg-violet-500 text-white"
                            : "bg-gray-200 text-gray-400 group-hover/chip:bg-gray-300 group-hover/chip:text-gray-500"
                        }`}
                        style={{ width: 18, height: 18 }}
                      >
                        {selected ? "\u2713" : s.name.charAt(0).toUpperCase()}
                      </span>
                      {s.name}
                      {selected && (
                        <X className="h-3 w-3 text-violet-400 transition-colors group-hover/chip:text-violet-600" />
                      )}
                    </button>
                  );
                })}
                {allMcpServers.length === 0 && (
                  <p className="text-[11px] text-gray-400 py-0.5">No MCP servers configured.</p>
                )}
              </div>
              {selectedMcpServerIds.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {selectedMcpServerIds.length} server{selectedMcpServerIds.length === 1 ? "" : "s"} selected
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setDefinition(agent.definition ?? "");
                  setInstructions(agent.coreInstructions ?? "");
                  setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
                  setSelectedMcpServerIds(agent.mcpServerIds ?? []);
                }}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-200"
              >
                <X className="h-3 w-3" />
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            onClick={agent.editable ? () => setEditing(true) : undefined}
            className={agent.editable ? "cursor-pointer text-gray-700 hover:text-indigo-600 transition-colors duration-200" : "text-gray-700 opacity-75"}
            title={!agent.editable ? "You don't have permission to edit this agent" : "Click to edit"}
          >
            {agent.definition && (
              <p className="mb-1 text-sm font-semibold text-gray-900">
                {agent.definition}
                {groupCount > 0 ? (
                  <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[9px] font-semibold text-indigo-500 uppercase">
                    {groupCount} group{groupCount === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-semibold text-emerald-600 uppercase">
                    no groups yet
                  </span>
                )}
              </p>
            )}
            {canViewCoreInstructions && (
            <p className="line-clamp-3 text-xs text-gray-500 leading-relaxed">
              {agent.coreInstructions || "(no instructions)"}
            </p>
            )}
            {agent.characteristics &&
              Object.keys(agent.characteristics).length > 0 && (
                <pre className="mt-2 max-h-24 overflow-hidden text-[10px] leading-snug text-gray-400 font-mono line-clamp-4">
                  {stringifyAgentCharacteristics(agent.characteristics)}
                </pre>
              )}

            {/* MCP Servers display */}
            {assignedServers.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1">
                {assignedServers.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-600 ring-1 ring-violet-100"
                  >
                    <Plug className="h-2.5 w-2.5" />
                    {s.name}
                  </span>
                ))}
              </div>
            )}

            {agent.editable && (
              <p className="mt-2 flex items-center gap-1 text-[10px] font-medium text-indigo-500">
                <Pencil className="h-2.5 w-2.5" />
                Click to edit
              </p>
            )}
          </div>
        )}
      </Box>
    );
  }
