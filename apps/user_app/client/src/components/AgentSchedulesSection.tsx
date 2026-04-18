import { useEffect, useState } from "react";
import { Clock, Plus, Power, PowerOff, Trash2, Loader2, X, Save, Pencil } from "lucide-react";
import { admin, type AdminCronJob } from "../api";
import { useToast } from "./Toast";

interface Props {
  agentId: string;
}

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day 09:00", value: "0 9 * * *" },
  { label: "Weekdays 09:00", value: "0 9 * * 1-5" },
  { label: "Every Monday 09:00", value: "0 9 * * 1" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
];

function guessBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AgentSchedulesSection({ agentId }: Props) {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<AdminCronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cronExpression, setCronExpression] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(guessBrowserTimezone());
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    admin
      .getAgentCronJobs(agentId)
      .then((data) => {
        if (!cancelled) setJobs(data);
      })
      .catch(() => {
        if (!cancelled) setJobs([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  function resetForm() {
    setName("");
    setPrompt("");
    setCronExpression("0 9 * * *");
    setTimezone(guessBrowserTimezone());
    setEnabled(true);
    setEditingId(null);
    setShowForm(false);
  }

  function loadIntoForm(job: AdminCronJob) {
    setName(job.name);
    setPrompt(job.prompt);
    setCronExpression(job.cronExpression);
    setTimezone(job.timezone);
    setEnabled(job.enabled);
    setEditingId(job.id);
    setShowForm(true);
  }

  async function reload() {
    try {
      const data = await admin.getAgentCronJobs(agentId);
      setJobs(data);
    } catch {
      /* ignore */
    }
  }

  async function save() {
    if (!name.trim() || !prompt.trim() || !cronExpression.trim()) {
      toast("Name, prompt, and cron expression are required.", "error");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await admin.updateCronJob(editingId, {
          name: name.trim(),
          prompt: prompt.trim(),
          cronExpression: cronExpression.trim(),
          timezone: timezone.trim() || "UTC",
          enabled,
        });
        toast("Schedule updated.", "success");
      } else {
        await admin.createAgentCronJob(agentId, {
          name: name.trim(),
          prompt: prompt.trim(),
          cronExpression: cronExpression.trim(),
          timezone: timezone.trim() || "UTC",
          enabled,
        });
        toast("Schedule created.", "success");
      }
      resetForm();
      await reload();
    } catch (err: any) {
      toast(err?.message ?? "Failed to save schedule.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(job: AdminCronJob) {
    try {
      await admin.updateCronJob(job.id, { enabled: !job.enabled });
      await reload();
    } catch (err: any) {
      toast(err?.message ?? "Failed to toggle schedule.", "error");
    }
  }

  async function remove(job: AdminCronJob) {
    if (!window.confirm(`Delete schedule "${job.name}"?`)) return;
    try {
      await admin.deleteCronJob(job.id);
      await reload();
    } catch (err: any) {
      toast(err?.message ?? "Failed to delete schedule.", "error");
    }
  }

  const smallInput =
    "w-full rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-xs transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10";

  return (
    <div>
      <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        <Clock className="h-3 w-3" />
        Schedules (cron)
      </label>

      {loading ? (
        <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-3 py-2 text-[11px] text-gray-400">
          Loading schedules…
        </p>
      ) : jobs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-3 py-2 text-[11px] text-gray-400">
          No schedules yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {jobs.map((job) => (
            <li
              key={job.id}
              className={`flex items-start justify-between gap-2 rounded-xl border px-3 py-2 text-[11px] ${
                job.enabled
                  ? "border-indigo-100 bg-indigo-50/40"
                  : "border-gray-200 bg-gray-50/60"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-800">{job.name}</span>
                  <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-gray-600 ring-1 ring-gray-200">
                    {job.cronExpression}
                  </code>
                  <span className="text-[10px] text-gray-400">{job.timezone}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-gray-500">{job.prompt}</p>
                <p className="mt-1 text-[10px] text-gray-400">
                  Last run: {formatDateTime(job.lastRunAt)}
                  {job.lastStatus ? ` • ${job.lastStatus}` : ""}
                  {job.lastError ? ` • ${job.lastError}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleEnabled(job)}
                  title={job.enabled ? "Disable" : "Enable"}
                  className={`rounded-full p-1 transition ${
                    job.enabled
                      ? "text-indigo-600 hover:bg-indigo-100"
                      : "text-gray-400 hover:bg-gray-200"
                  }`}
                >
                  {job.enabled ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => loadIntoForm(job)}
                  title="Edit"
                  className="rounded-full p-1 text-gray-400 transition hover:bg-gray-200 hover:text-indigo-600"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(job)}
                  title="Delete"
                  className="rounded-full p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-500"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!showForm ? (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-white px-2.5 py-1 text-[11px] font-medium text-gray-500 ring-1 ring-gray-200 transition hover:bg-indigo-50 hover:text-indigo-600 hover:ring-indigo-200"
        >
          <Plus className="h-3 w-3" />
          Add schedule
        </button>
      ) : (
        <div className="mt-2 space-y-2 rounded-xl border border-indigo-100 bg-white p-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Daily standup ping"
                maxLength={100}
                className={smallInput}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Timezone
              </label>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="UTC"
                className={smallInput}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Cron expression
            </label>
            <input
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="0 9 * * *"
              className={smallInput + " font-mono"}
            />
            <div className="mt-1 flex flex-wrap gap-1">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setCronExpression(preset.value)}
                  className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[10px] text-gray-500 ring-1 ring-gray-200 transition hover:bg-indigo-50 hover:text-indigo-600 hover:ring-indigo-200"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="What should the agent do each tick?"
              className={smallInput + " resize-y"}
            />
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-gray-600">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Enabled
          </label>

          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {editingId ? "Update" : "Create"}
            </button>
            <button
              onClick={resetForm}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-200"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
