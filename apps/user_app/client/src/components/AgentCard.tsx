import { useState, useEffect } from "react";
import { AdminAgent, AdminMcpServer, AdminSkill, ConversationModelInfo, type AgentMcpServerLink, type AgentSkillLink } from "../api";
import { Box } from "@mui/material";
import { Loader2, Save, X, Pencil, Sparkles, Plug, Power, PowerOff, Lock } from "lucide-react";
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
    const [mcpLinks, setMcpLinks] = useState<AgentMcpServerLink[]>(
      agent.mcpServerLinks ?? [],
    );
    const [skLinks, setSkLinks] = useState<AgentSkillLink[]>(
      agent.skillLinks ?? [],
    );
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      setDefinition(agent.definition ?? "");
      setDisplayName(agent.agentName ?? "");
      setInstructions(agent.coreInstructions ?? "");
      setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
      setSelectedModel(agent.modelId ? allModels.find((m) => m.id === agent.modelId) ?? null : null);
      setMcpLinks(agent.mcpServerLinks ?? []);
      setSkLinks(agent.skillLinks ?? []);
    }, [agent, allModels]);

    function isSkillLocked(id: number) {
      const sk = allSkills.find((s) => s.id === id);
      return sk?.locked === true;
    }

    // ── MCP server link helpers ───────────────────────────────────────
    function getMcpLinkState(id: number): "unassigned" | "active" | "inactive" {
      const link = mcpLinks.find((l) => l.mcpServerId === id);
      if (!link) return "unassigned";
      return link.active ? "active" : "inactive";
    }

    function cycleMcpServer(id: number) {
      setMcpLinks((prev) => {
        const existing = prev.find((l) => l.mcpServerId === id);
        if (!existing) return [...prev, { mcpServerId: id, active: true }];
        // active → inactive
        if (existing.active) return prev.map((l) => l.mcpServerId === id ? { ...l, active: false } : l);
        // inactive → unassigned (remove)
        return prev.filter((l) => l.mcpServerId !== id);
      });
    }

    function removeMcpServer(id: number) {
      setMcpLinks((prev) => prev.filter((l) => l.mcpServerId !== id));
    }

    // ── Skill link helpers ────────────────────────────────────────────
    function getSkillLinkState(id: number): "unassigned" | "active" | "inactive" {
      const link = skLinks.find((l) => l.skillId === id);
      if (!link) return "unassigned";
      return link.active ? "active" : "inactive";
    }

    function cycleSkill(id: number) {
      if (isSkillLocked(id)) return;
      setSkLinks((prev) => {
        const existing = prev.find((l) => l.skillId === id);
        if (!existing) return [...prev, { skillId: id, active: true }];
        if (existing.active) return prev.map((l) => l.skillId === id ? { ...l, active: false } : l);
        return prev.filter((l) => l.skillId !== id);
      });
    }

    function removeSkill(id: number) {
      if (isSkillLocked(id)) return;
      setSkLinks((prev) => prev.filter((l) => l.skillId !== id));
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
          mcpServerLinks: mcpLinks,
          skillLinks: skLinks,
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

    const assignedSkillLinks = (agent.skillLinks ?? []).map((link) => ({
      ...link,
      skill: allSkills.find((sk) => sk.id === link.skillId),
    })).filter((l) => l.skill);
    const assignedMcpLinks = (agent.mcpServerLinks ?? []).map((link) => ({
      ...link,
      server: allMcpServers.find((s) => s.id === link.mcpServerId),
    })).filter((l) => l.server);

    return (
      <Box
        className={`rounded-xl border bg-white p-4 shadow-glass transition-all duration-200 hover:shadow-md min-w-0 ${
          agent.isLocked ? "border-amber-200/70 bg-gradient-to-br from-amber-50/40 via-white to-white" : "border-gray-200/60"
        } ${editing ? "relative z-20" : ""}`}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="break-all font-mono text-[10px] text-gray-400">{agent.id}</p>
          {agent.isLocked && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200/70"
              title="This agent is locked and cannot be configured"
            >
              <Lock className="h-2.5 w-2.5" />
              Locked
            </span>
          )}
        </div>
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
                  const state = getMcpLinkState(s.id);
                  return (
                    <span key={s.id} className="group/chip inline-flex items-center gap-0">
                      <button
                        type="button"
                        onClick={() => cycleMcpServer(s.id)}
                        title={state === "unassigned" ? "Click to assign" : state === "active" ? "Click to deactivate" : "Click to remove"}
                        className={`inline-flex items-center gap-1.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                          state === "active"
                            ? "rounded-full bg-gradient-to-r from-violet-50 to-purple-50 text-violet-800 ring-1 ring-violet-200/80 shadow-sm px-2.5"
                            : state === "inactive"
                              ? "rounded-full bg-gray-50 text-gray-400 ring-1 ring-gray-300 ring-dashed px-2.5 line-through decoration-gray-400/50"
                              : "rounded-full bg-white text-gray-400 ring-1 ring-gray-200 hover:bg-gray-50 hover:text-gray-600 hover:ring-gray-300 px-2.5"
                        }`}
                      >
                        {state === "active" && <Power className="h-3 w-3 text-violet-500" />}
                        {state === "inactive" && <PowerOff className="h-3 w-3 text-gray-400" />}
                        {state === "unassigned" && <Plug className="h-3 w-3" />}
                        {s.name}
                      </button>
                      {state !== "unassigned" && (
                        <button
                          type="button"
                          onClick={() => removeMcpServer(s.id)}
                          title="Remove from agent"
                          className="ml-0.5 rounded-full p-0.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
              {mcpLinks.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {mcpLinks.filter((l) => l.active).length} active, {mcpLinks.filter((l) => !l.active).length} inactive
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
                {allSkills.filter((sk) => !sk.locked || skLinks.some((l) => l.skillId === sk.id)).map((sk) => {
                  const state = getSkillLinkState(sk.id);
                  const locked = isSkillLocked(sk.id);
                  return (
                    <span key={sk.id} className="group/chip inline-flex items-center gap-0">
                      <button
                        type="button"
                        onClick={() => cycleSkill(sk.id)}
                        disabled={locked}
                        title={locked ? "This skill is locked and cannot be changed" : state === "unassigned" ? "Click to assign" : state === "active" ? "Click to deactivate" : "Click to remove"}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                          locked
                            ? "bg-gray-100 text-gray-500 ring-1 ring-gray-300 cursor-not-allowed opacity-75"
                            : state === "active"
                              ? "bg-gradient-to-r from-amber-50 to-yellow-50 text-amber-800 ring-1 ring-amber-200/80 shadow-sm"
                              : state === "inactive"
                                ? "bg-gray-50 text-gray-400 ring-1 ring-gray-300 ring-dashed line-through decoration-gray-400/50"
                                : "bg-white text-gray-400 ring-1 ring-gray-200 hover:bg-gray-50 hover:text-gray-600 hover:ring-gray-300"
                        }`}
                      >
                        {locked ? (
                          <span
                            className="flex items-center justify-center rounded-full bg-gray-400 text-white text-[9px] font-bold"
                            style={{ width: 18, height: 18 }}
                          >
                            {"\u2713"}
                          </span>
                        ) : state === "active" ? (
                          <Power className="h-3 w-3 text-amber-600" />
                        ) : state === "inactive" ? (
                          <PowerOff className="h-3 w-3 text-gray-400" />
                        ) : (
                          <Sparkles className="h-3 w-3" />
                        )}
                        {sk.name}
                      </button>
                      {state !== "unassigned" && !locked && (
                        <button
                          type="button"
                          onClick={() => removeSkill(sk.id)}
                          title="Remove from agent"
                          className="ml-0.5 rounded-full p-0.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  );
                })}
                {allSkills.filter((sk) => !sk.locked).length === 0 && (
                  <p className="text-[11px] text-gray-400 py-0.5">No skills defined yet (super admin can add in Skills).</p>
                )}
              </div>
              {skLinks.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {skLinks.filter((l) => l.active).length} active, {skLinks.filter((l) => !l.active).length} inactive
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
                  setMcpLinks(agent.mcpServerLinks ?? []);
                  setSkLinks(agent.skillLinks ?? []);
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
            title={
              agent.isLocked
                ? "This agent is locked and cannot be configured"
                : !agent.editable
                  ? "You don't have permission to edit this agent"
                  : "Click to edit"
            }
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

            {assignedSkillLinks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {assignedSkillLinks.map((l) => (
                  <span
                    key={l.skillId}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
                      l.active
                        ? "bg-amber-50 text-amber-700 ring-amber-100"
                        : "bg-gray-50 text-gray-400 ring-gray-200 line-through decoration-gray-400/50"
                    }`}
                  >
                    {l.active ? <Power className="h-2.5 w-2.5" /> : <PowerOff className="h-2.5 w-2.5" />}
                    {l.skill!.name}
                  </span>
                ))}
              </div>
            )}

            {assignedMcpLinks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {assignedMcpLinks.map((l) => (
                  <span
                    key={l.mcpServerId}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
                      l.active
                        ? "bg-violet-50 text-violet-600 ring-violet-100"
                        : "bg-gray-50 text-gray-400 ring-gray-200 line-through decoration-gray-400/50"
                    }`}
                  >
                    {l.active ? <Power className="h-2.5 w-2.5" /> : <PowerOff className="h-2.5 w-2.5" />}
                    {l.server!.name}
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
