import { useState, useEffect } from "react";
import { AdminAgent, AdminMcpServer, AdminSkill, ConversationModelInfo } from "../api";
import { Box } from "@mui/material";
import { Loader2, Save, X, Pencil, Sparkles, Plug } from "lucide-react";
import { admin } from "../api";
import { stringifyAgentCharacteristics } from "../pages/AdminPage";
import { useToast } from "./Toast";
import ModelSelector from "./ModelSelector";
import VendorModelBadge from "./VendorModelBadge";

export default function AgentCard({
    agent,
    currentUserId,
    currentUserRole,
    allModels,
    allSkills,
    allMcpServers,
    onSaved,
  }: {
    agent: AdminAgent;
    currentUserId: number;
    currentUserRole: string;
    allModels: ConversationModelInfo[];
    allSkills: AdminSkill[];
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
    const [displayName, setDisplayName] = useState(agent.agentName ?? "");
    const [instructions, setInstructions] = useState(
      agent.coreInstructions ?? "",
    );
    const [characteristicsJson, setCharacteristicsJson] = useState(
      stringifyAgentCharacteristics(agent.characteristics),
    );
    const [selectedModel, setSelectedModel] = useState<ConversationModelInfo | null>(
      agent.modelId ? allModels.find((m) => m.id === agent.modelId) ?? null : null,
    );
    const [selectedSkillIds, setSelectedSkillIds] = useState<number[]>(
      agent.skillIds ?? [],
    );
    const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<number[]>(
      agent.mcpServerIds ?? [],
    );
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      setDefinition(agent.definition ?? "");
      setDisplayName(agent.agentName ?? "");
      setInstructions(agent.coreInstructions ?? "");
      setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
      setSelectedModel(agent.modelId ? allModels.find((m) => m.id === agent.modelId) ?? null : null);
      setSelectedSkillIds(agent.skillIds ?? []);
      setSelectedMcpServerIds(agent.mcpServerIds ?? []);
    }, [agent, allModels]);

    function isSkillLocked(id: number) {
      const sk = allSkills.find((s) => s.id === id);
      return sk?.locked === true;
    }

    function toggleSkill(id: number) {
      if (isSkillLocked(id)) return;
      setSelectedSkillIds((prev) =>
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
          agentName: displayName.trim() || null,
          ...(canViewCoreInstructions ? { coreInstructions: instructions || undefined } : {}),
          characteristics,
          modelId: selectedModel?.id ?? null,
          skillIds: selectedSkillIds,
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

    const assignedSkills = allSkills.filter((sk) =>
      (agent.skillIds ?? []).includes(sk.id),
    );
    const assignedMcpServers = allMcpServers.filter((s) =>
      (agent.mcpServerIds ?? []).includes(s.id),
    );

    return (
      <Box
        className={`rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200 hover:shadow-md min-w-0 ${
          editing ? "relative z-20" : ""
        }`}
      >
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

            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Display name <span className="font-normal normal-case text-gray-400">(optional)</span>
              </label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="System prompt (“Your name is …”)"
                maxLength={120}
                className={smallInput}
              />
              <p className={`text-[10px] text-right ${displayName.length >= 120 ? "text-red-400" : "text-gray-400"}`}>{displayName.length}/120</p>
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
            {allMcpServers.length > 0 && (
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
                      onClick={() =>
                        setSelectedMcpServerIds((prev) =>
                          selected ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                        )
                      }
                      className={`group/chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                        selected
                          ? "bg-gradient-to-r from-violet-50 to-purple-50 text-violet-800 ring-1 ring-violet-200/80 shadow-sm"
                          : "bg-white text-gray-400 ring-1 ring-gray-200 hover:bg-gray-50 hover:text-gray-600 hover:ring-gray-300"
                      }`}
                    >
                      <Plug className={`h-3 w-3 ${selected ? "text-violet-500" : ""}`} />
                      {s.name}
                      {selected && (
                        <X className="h-3 w-3 text-violet-400 transition-colors group-hover/chip:text-violet-600" />
                      )}
                    </button>
                  );
                })}
              </div>
              {selectedMcpServerIds.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {selectedMcpServerIds.length} server{selectedMcpServerIds.length === 1 ? "" : "s"} linked
                </p>
              )}
            </div>
            )}

            {/* Skills */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <Sparkles className="h-3 w-3" />
                Skills
              </label>
              <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                {allSkills.filter((sk) => !sk.locked || selectedSkillIds.includes(sk.id)).map((sk) => {
                  const selected = selectedSkillIds.includes(sk.id);
                  const locked = isSkillLocked(sk.id);
                  return (
                    <button
                      key={sk.id}
                      type="button"
                      onClick={() => toggleSkill(sk.id)}
                      disabled={locked}
                      className={`group/chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                        locked
                          ? "bg-gray-100 text-gray-500 ring-1 ring-gray-300 cursor-not-allowed opacity-75"
                          : selected
                            ? "bg-gradient-to-r from-amber-50 to-yellow-50 text-amber-800 ring-1 ring-amber-200/80 shadow-sm"
                            : "bg-white text-gray-400 ring-1 ring-gray-200 hover:bg-gray-50 hover:text-gray-600 hover:ring-gray-300"
                      }`}
                      title={locked ? "This skill is locked and cannot be removed" : undefined}
                    >
                      <span
                        className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[9px] font-bold transition-colors duration-150 ${
                          locked
                            ? "bg-gray-400 text-white"
                            : selected
                              ? "bg-amber-500 text-white"
                              : "bg-gray-200 text-gray-400 group-hover/chip:bg-gray-300 group-hover/chip:text-gray-500"
                        }`}
                        style={{ width: 18, height: 18 }}
                      >
                        {selected ? "\u2713" : sk.name.charAt(0).toUpperCase()}
                      </span>
                      {sk.name}
                      {selected && !locked && (
                        <X className="h-3 w-3 text-amber-400 transition-colors group-hover/chip:text-amber-600" />
                      )}
                    </button>
                  );
                })}
                {allSkills.filter((sk) => !sk.locked).length === 0 && (
                  <p className="text-[11px] text-gray-400 py-0.5">No skills defined yet (super admin can add in Skills).</p>
                )}
              </div>
              {selectedSkillIds.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {selectedSkillIds.length} skill{selectedSkillIds.length === 1 ? "" : "s"} linked
                </p>
              )}
            </div>

            {/* Model */}
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                LLM Model
              </label>
              <ModelSelector
                currentModel={selectedModel}
                onModelChanged={setSelectedModel}
                compact
              />
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
                  setDisplayName(agent.agentName ?? "");
                  setInstructions(agent.coreInstructions ?? "");
                  setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
                  setSelectedModel(agent.modelId ? allModels.find((m) => m.id === agent.modelId) ?? null : null);
                  setSelectedSkillIds(agent.skillIds ?? []);
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
            {agent.agentName?.trim() && (
              <p className="mb-1 text-xs font-medium text-indigo-600">
                Display name: {agent.agentName}
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

            {assignedSkills.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {assignedSkills.map((sk) => (
                  <span
                    key={sk.id}
                    className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-100"
                  >
                    <Sparkles className="h-2.5 w-2.5" />
                    {sk.name}
                  </span>
                ))}
              </div>
            )}

            {assignedMcpServers.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {assignedMcpServers.map((s) => (
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

            {/* Current model */}
            {agent.modelId && allModels.find((m) => m.id === agent.modelId) && (
              <div className="mt-2">
                <VendorModelBadge model={allModels.find((m) => m.id === agent.modelId)!} />
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
