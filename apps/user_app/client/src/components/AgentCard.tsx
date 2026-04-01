import { useState, useEffect } from "react";
import { AdminAgent } from "../api";
import { Box } from "@mui/material";
import { Loader2 } from "lucide-react";
import { Save } from "lucide-react";
import { X } from "lucide-react";
import { Pencil } from "lucide-react";
import { admin } from "../api";
import { stringifyAgentCharacteristics } from "../pages/AdminPage";
import { useToast } from "./Toast";

export default function AgentCard({
    agent,
    onSaved,
  }: {
    agent: AdminAgent;
    onSaved: () => void;
  }) {
    const { toast } = useToast();
    const groupCount = agent.groupCount ?? 0;
    const [editing, setEditing] = useState(false);
    const [definition, setDefinition] = useState(agent.definition ?? "");
    const [instructions, setInstructions] = useState(
      agent.coreInstructions ?? "",
    );
    const [characteristicsJson, setCharacteristicsJson] = useState(
      stringifyAgentCharacteristics(agent.characteristics),
    );
    const [saving, setSaving] = useState(false);
  
    useEffect(() => {
      setDefinition(agent.definition ?? "");
      setInstructions(agent.coreInstructions ?? "");
      setCharacteristicsJson(stringifyAgentCharacteristics(agent.characteristics));
    }, [agent]);
  
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
          coreInstructions: instructions || undefined,
          characteristics,
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
  
    return (
      <Box className="rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200 hover:shadow-md min-w-0">
        <p className="mb-2 break-all font-mono text-[10px] text-gray-400">{agent.id}</p>
        {editing ? (
          <div className="space-y-3">
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
            <div className="flex gap-2">
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
            <p className="line-clamp-3 text-xs text-gray-500 leading-relaxed">
              {agent.coreInstructions || "(no instructions)"}
            </p>
            {agent.characteristics &&
              Object.keys(agent.characteristics).length > 0 && (
                <pre className="mt-2 max-h-24 overflow-hidden text-[10px] leading-snug text-gray-400 font-mono line-clamp-4">
                  {stringifyAgentCharacteristics(agent.characteristics)}
                </pre>
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