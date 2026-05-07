import { useState, useEffect } from "react";
import { AdminAgent, AdminMcpServer, AdminSdkCapability, AdminSkill, AdminTool, ConversationModelInfo, type AgentMcpServerLink, type AgentSkillLink, type AgentToolLink } from "../api";
import { Box } from "@mui/material";
import { Loader2, Save, X, Pencil, Sparkles, Plug, Power, PowerOff, Lock, Plus, ShieldCheck } from "lucide-react";
import { admin } from "../api";
import { stringifyAgentCharacteristics } from "../pages/AdminPage";
import { useToast } from "./Toast";
import ModelSelector from "./ModelSelector";
import VendorModelBadge from "./VendorModelBadge";
import AgentSchedulesSection from "./AgentSchedulesSection";

export default function AgentCard({
    agent,
    currentUserId,
    currentUserRole,
    allModels,
    allSkills,
    allTools,
    allMcpServers,
    allSdkCapabilities,
    onSaved,
  }: {
    agent: AdminAgent;
    currentUserId: number;
    currentUserRole: string;
    allModels: ConversationModelInfo[];
    allSkills: AdminSkill[];
    allTools: AdminTool[];
    allMcpServers: AdminMcpServer[];
    allSdkCapabilities: AdminSdkCapability[];
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
    const [description, setDescription] = useState(agent.description ?? "");
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
    const [tlLinks, setTlLinks] = useState<AgentToolLink[]>(
      agent.toolLinks ?? [],
    );
    const [sdkCapIds, setSdkCapIds] = useState<number[]>(
      agent.sdkCapabilityIds ?? [],
    );
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      setDefinition(agent.definition ?? "");
      setDisplayName(agent.agentName ?? "");
      setDescription(agent.description ?? "");
      setInstructions(agent.coreInstructions ?? "");
      setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
      setSelectedModel(agent.modelId ? allModels.find((m) => m.id === agent.modelId) ?? null : null);
      setMcpLinks(agent.mcpServerLinks ?? []);
      setSkLinks(agent.skillLinks ?? []);
      setTlLinks(agent.toolLinks ?? []);
      setSdkCapIds(agent.sdkCapabilityIds ?? []);
    }, [agent, allModels]);

    function isSkillLocked(id: number) {
      const sk = allSkills.find((s) => s.id === id);
      return sk?.locked === true;
    }

    const isSuperAdmin = currentUserRole === "super_admin";

    // ── MCP server link helpers ───────────────────────────────────────
    function toggleMcpServer(id: number) {
      setMcpLinks((prev) =>
        prev.map((l) => l.mcpServerId === id ? { ...l, active: !l.active } : l),
      );
    }

    function addMcpServer(id: number) {
      setMcpLinks((prev) => {
        if (prev.some((l) => l.mcpServerId === id)) return prev;
        return [...prev, { mcpServerId: id, active: true }];
      });
    }

    function removeMcpServer(id: number) {
      setMcpLinks((prev) => prev.filter((l) => l.mcpServerId !== id));
    }

    // ── Skill link helpers ────────────────────────────────────────────
    function toggleSkill(id: number) {
      if (isSkillLocked(id)) return;
      setSkLinks((prev) =>
        prev.map((l) => l.skillId === id ? { ...l, active: !l.active } : l),
      );
    }

    function addSkill(id: number) {
      if (isSkillLocked(id)) return;
      setSkLinks((prev) => {
        if (prev.some((l) => l.skillId === id)) return prev;
        return [...prev, { skillId: id, active: true }];
      });
    }

    function removeSkill(id: number) {
      if (isSkillLocked(id)) return;
      setSkLinks((prev) => prev.filter((l) => l.skillId !== id));
    }

    // ── Tool link helpers ──────────────────────────────────────────────
    function toggleTool(id: number) {
      setTlLinks((prev) =>
        prev.map((l) => l.toolId === id ? { ...l, active: !l.active } : l),
      );
    }

    function addTool(id: number) {
      setTlLinks((prev) => {
        if (prev.some((l) => l.toolId === id)) return prev;
        return [...prev, { toolId: id, active: true }];
      });
    }

    function removeTool(id: number) {
      setTlLinks((prev) => prev.filter((l) => l.toolId !== id));
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
          description: description.trim() || null,
          ...(canViewCoreInstructions ? { coreInstructions: instructions || undefined } : {}),
          characteristics,
          modelId: selectedModel?.id ?? null,
          mcpServerLinks: mcpLinks,
          skillLinks: skLinks,
          toolLinks: tlLinks,
          sdkCapabilityIds: sdkCapIds,
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
    const assignedToolLinks = (agent.toolLinks ?? []).map((link) => ({
      ...link,
      tool: allTools.find((t) => t.id === link.toolId),
    })).filter((l) => l.tool);

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

            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Description
              </label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description of what this agent does"
                className={smallInput}
              />
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

            {/* CLI MCP Access */}
            {(mcpLinks.length > 0 || (isSuperAdmin && allMcpServers.length > 0)) && (
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <Plug className="h-3 w-3" />
                CLI MCP Access
              </label>

              {/* Assigned CLI MCP servers */}
              {mcpLinks.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                  {mcpLinks.map((link) => {
                    const server = allMcpServers.find((s) => s.id === link.mcpServerId);
                    if (!server) return null;
                    return (
                      <span key={link.mcpServerId} className="group/chip inline-flex items-center gap-0">
                        <button
                          type="button"
                          onClick={() => toggleMcpServer(link.mcpServerId)}
                          title={link.active ? "Click to deactivate" : "Click to activate"}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                            link.active
                              ? "bg-gradient-to-r from-violet-50 to-purple-50 text-violet-800 ring-1 ring-violet-200/80 shadow-sm"
                              : "bg-gray-50 text-gray-400 ring-1 ring-gray-300 ring-dashed line-through decoration-gray-400/50"
                          }`}
                        >
                          {link.active ? <Power className="h-3 w-3 text-violet-500" /> : <PowerOff className="h-3 w-3 text-gray-400" />}
                          {server.name}
                        </button>
                        {isSuperAdmin && (
                          <button
                            type="button"
                            onClick={() => removeMcpServer(link.mcpServerId)}
                            title="Unassign from agent"
                            className="ml-0.5 rounded-full p-0.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-3 py-2 text-[11px] text-gray-400">
                  No CLI MCP servers assigned.
                </p>
              )}

              {mcpLinks.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {mcpLinks.filter((l) => l.active).length} active, {mcpLinks.filter((l) => !l.active).length} inactive
                </p>
              )}

              {/* Available to add — super_admin only */}
              {isSuperAdmin && (() => {
                const assignedIds = new Set(mcpLinks.map((l) => l.mcpServerId));
                const available = allMcpServers.filter((s) => !assignedIds.has(s.id));
                if (available.length === 0) return null;
                return (
                  <div className="mt-2">
                    <p className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-indigo-400">
                      <ShieldCheck className="h-2.5 w-2.5" />
                      Available CLI servers
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {available.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => addMcpServer(s.id)}
                          title={`Assign "${s.name}" to this agent`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-gray-400 ring-1 ring-gray-200 transition-all duration-150 hover:bg-indigo-50 hover:text-indigo-600 hover:ring-indigo-200"
                        >
                          <Plus className="h-3 w-3" />
                          {s.name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
            )}

            {/* SDK Capabilities (filesystem / bash). Distinct from MCP
                servers above: these are SDK-native tools the runtime
                injects based on attachment, not external subprocesses.
                Toggle = full attach/detach (no inactive state — the row
                is either present or absent on the junction). */}
            {allSdkCapabilities.length > 0 && (
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <Plug className="h-3 w-3" />
                SDK Capabilities
              </label>
              <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                {allSdkCapabilities.map((c) => {
                  const selected = sdkCapIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      title={c.description ?? undefined}
                      onClick={() =>
                        setSdkCapIds((prev) =>
                          selected ? prev.filter((id) => id !== c.id) : [...prev, c.id],
                        )
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                        selected
                          ? "bg-gradient-to-r from-emerald-50 to-teal-50 text-emerald-800 ring-1 ring-emerald-200/80 shadow-sm"
                          : "bg-white text-gray-400 ring-1 ring-gray-200 hover:bg-emerald-50 hover:text-emerald-600 hover:ring-emerald-200"
                      }`}
                    >
                      {selected ? <Power className="h-3 w-3 text-emerald-500" /> : <Plus className="h-3 w-3" />}
                      {c.name}
                      {selected && <X className="h-3 w-3" />}
                    </button>
                  );
                })}
              </div>
              {sdkCapIds.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {sdkCapIds.length} attached
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

              {/* Assigned skills */}
              {skLinks.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                  {skLinks.map((link) => {
                    const sk = allSkills.find((s) => s.id === link.skillId);
                    if (!sk) return null;
                    const locked = sk.locked === true;
                    return (
                      <span key={link.skillId} className="group/chip inline-flex items-center gap-0">
                        <button
                          type="button"
                          onClick={() => toggleSkill(link.skillId)}
                          disabled={locked}
                          title={locked ? "This skill is locked and cannot be changed" : link.active ? "Click to deactivate" : "Click to activate"}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                            locked
                              ? "bg-gray-100 text-gray-500 ring-1 ring-gray-300 cursor-not-allowed opacity-75"
                              : link.active
                                ? "bg-gradient-to-r from-amber-50 to-yellow-50 text-amber-800 ring-1 ring-amber-200/80 shadow-sm"
                                : "bg-gray-50 text-gray-400 ring-1 ring-gray-300 ring-dashed line-through decoration-gray-400/50"
                          }`}
                        >
                          {locked ? (
                            <span
                              className="flex items-center justify-center rounded-full bg-gray-400 text-white text-[9px] font-bold"
                              style={{ width: 18, height: 18 }}
                            >
                              {"\u2713"}
                            </span>
                          ) : link.active ? (
                            <Power className="h-3 w-3 text-amber-600" />
                          ) : (
                            <PowerOff className="h-3 w-3 text-gray-400" />
                          )}
                          {sk.name}
                        </button>
                        {isSuperAdmin && !locked && (
                          <button
                            type="button"
                            onClick={() => removeSkill(link.skillId)}
                            title="Unassign from agent"
                            className="ml-0.5 rounded-full p-0.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-3 py-2 text-[11px] text-gray-400">
                  No skills assigned.
                </p>
              )}

              {skLinks.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {skLinks.filter((l) => l.active).length} active, {skLinks.filter((l) => !l.active).length} inactive
                </p>
              )}

              {/* Available to add — super_admin only */}
              {isSuperAdmin && (() => {
                const assignedIds = new Set(skLinks.map((l) => l.skillId));
                const available = allSkills.filter((sk) => !assignedIds.has(sk.id) && !sk.locked);
                if (available.length === 0) return null;
                return (
                  <div className="mt-2">
                    <p className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-indigo-400">
                      <ShieldCheck className="h-2.5 w-2.5" />
                      Available to add
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {available.map((sk) => (
                        <button
                          key={sk.id}
                          type="button"
                          onClick={() => addSkill(sk.id)}
                          title={`Assign "${sk.name}" to this agent`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-gray-400 ring-1 ring-gray-200 transition-all duration-150 hover:bg-amber-50 hover:text-amber-600 hover:ring-amber-200"
                        >
                          <Plus className="h-3 w-3" />
                          {sk.name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Tools */}
            {(tlLinks.length > 0 || (isSuperAdmin && allTools.length > 0)) && (
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <Plug className="h-3 w-3" />
                Tools
              </label>

              {/* Assigned tools */}
              {tlLinks.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                  {tlLinks.map((link) => {
                    const tool = allTools.find((t) => t.id === link.toolId);
                    if (!tool) return null;
                    return (
                      <span key={link.toolId} className="group/chip inline-flex items-center gap-0">
                        <button
                          type="button"
                          onClick={() => toggleTool(link.toolId)}
                          title={`${tool.description ?? tool.slug} — ${link.active ? "Click to deactivate" : "Click to activate"}`}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                            link.active
                              ? "bg-violet-100 text-violet-800 ring-1 ring-violet-200 shadow-sm"
                              : "bg-gray-100 text-gray-400 ring-1 ring-gray-200 line-through"
                          }`}
                        >
                          {link.active ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
                          {tool.name}
                        </button>
                        {isSuperAdmin && (
                          <button
                            type="button"
                            onClick={() => removeTool(link.toolId)}
                            title="Unassign from agent"
                            className="ml-0.5 rounded-full p-0.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-3 py-2 text-[11px] text-gray-400">
                  No tools assigned.
                </p>
              )}

              {tlLinks.length > 0 && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {tlLinks.filter((l) => l.active).length} active, {tlLinks.filter((l) => !l.active).length} inactive
                </p>
              )}

              {/* Available to add — super_admin only */}
              {isSuperAdmin && (() => {
                const assignedIds = new Set(tlLinks.map((l) => l.toolId));
                const available = allTools.filter((t) => !assignedIds.has(t.id));
                if (available.length === 0) return null;
                return (
                  <div className="mt-2">
                    <p className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-indigo-400">
                      <ShieldCheck className="h-2.5 w-2.5" />
                      Available to add
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {available.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => addTool(t.id)}
                          title={`Assign "${t.name}" to this agent`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-gray-400 ring-1 ring-gray-200 transition-all duration-150 hover:bg-violet-50 hover:text-violet-600 hover:ring-violet-200"
                        >
                          <Plus className="h-3 w-3" />
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
            )}

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

            {/* Schedules (cron) */}
            <AgentSchedulesSection agentId={agent.id} />

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
                  setDescription(agent.description ?? "");
                  setInstructions(agent.coreInstructions ?? "");
                  setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
                  setSelectedModel(agent.modelId ? allModels.find((m) => m.id === agent.modelId) ?? null : null);
                  setMcpLinks(agent.mcpServerLinks ?? []);
                  setSkLinks(agent.skillLinks ?? []);
                  setSdkCapIds(agent.sdkCapabilityIds ?? []);
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
            {agent.description?.trim() && (
              <p className="mb-1 text-xs text-gray-500 italic">
                {agent.description}
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

            {assignedToolLinks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {assignedToolLinks.map((l) => (
                  <span
                    key={l.toolId}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
                      l.active
                        ? "bg-violet-50 text-violet-600 ring-violet-100"
                        : "bg-gray-50 text-gray-400 ring-gray-200 line-through decoration-gray-400/50"
                    }`}
                  >
                    {l.active ? <Power className="h-2.5 w-2.5" /> : <PowerOff className="h-2.5 w-2.5" />}
                    {l.tool!.name}
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
