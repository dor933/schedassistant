import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import path from "path";
import { Project, Repository } from "@scheduling-agent/database";
import { logger } from "../logger";

// ─── Env configuration ──────────────────────────────────────────────────────

const REPOS_BASE_PATH = process.env.REPOS_BASE_PATH || "/app/data/repos";
const GITHUB_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "dor933";
const AGENT_SERVICE_PUBLIC_URL = process.env.AGENT_SERVICE_PUBLIC_URL || "";
const EPIC_WEBHOOK_SECRET = process.env.EPIC_WEBHOOK_SECRET || "";

// ─── Workflow template loading (canonical YAML source-of-truth) ─────────────
//
// The YAML files live at `apps/agent_service/templates/workflows/*.yml`
// (a sibling of both `src/` and `dist/`) so the same `../../templates/...`
// path resolves correctly under `ts-node src/` (dev) and `node dist/` (prod).

const WORKFLOWS_DIR = path.resolve(__dirname, "../../templates/workflows");
const PR_APPROVED_WORKFLOW = readFileSync(
  path.join(WORKFLOWS_DIR, "pr-approved.yml"),
  "utf-8",
);
const PR_REVIEW_WORKFLOW = readFileSync(
  path.join(WORKFLOWS_DIR, "pr-review.yml"),
  "utf-8",
);

// ─── Typed errors ───────────────────────────────────────────────────────────

/**
 * Error thrown by `RepositoriesService` when a request should map to a
 * specific HTTP status. The controller unwraps `.status` → `res.status(...)`.
 */
export class RepoServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RepoServiceError";
  }
}

// ─── Public input / output types ────────────────────────────────────────────

export interface SetupRepoInput {
  name: string;
  branch: string;
  generateArchitecture: boolean;
  architectureOverview?: string;
  setupInstructions?: string;
}

export interface SetupProjectInput {
  project: {
    name: string;
    description?: string;
    architectureOverview?: string;
    techStack?: string;
  };
  repositories: SetupRepoInput[];
  userId: number;
}

export interface AddRepoInput {
  projectId: string;
  name: string;
  branch: string;
  architectureOverview?: string;
  setupInstructions?: string;
  generateArchitecture?: boolean;
}

export interface RepoResult {
  name: string;
  ok: boolean;
  /** Set when clone/checkout failed (fatal). */
  error?: string;
  /** Set when architecture generation failed (non-fatal). */
  archWarning?: string;
  /** Set when architecture will be generated asynchronously. */
  pendingArchitecture?: boolean;
  /** Repository ID — included when pendingArchitecture is true so caller can trigger generation. */
  repositoryId?: string;
}

// ─── Private helpers ────────────────────────────────────────────────────────

/** Invoke Claude CLI with spawnSync to avoid shell escaping issues with the prompt. */
function runClaudeArchitecture(cwd: string, prompt: string): string {
  logger.info("runClaudeArchitecture: spawning", { cwd, promptLen: prompt.length });

  const result = spawnSync("su-exec", [
    "agent", "claude",
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--max-turns", "10",
  ], {
    cwd,
    // HOME must be pinned to the `agent` user's home so claude writes its
    // session file under /home/agent/.claude (writable by agent) rather than
    // inheriting HOME=/root from the root-owned agent_service process.
    env: { ...process.env, HOME: "/home/agent" },
    encoding: "utf-8",
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    logger.error("runClaudeArchitecture: spawn error", { error: result.error.message });
    throw result.error;
  }

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.status !== 0) {
    logger.error("runClaudeArchitecture: non-zero exit", {
      code: result.status,
      stderr: stderr.slice(0, 2000),
    });
    throw new Error(`claude exited with code ${result.status}: ${stderr || "(no output)"}`);
  }
  return stdout;
}

/** Make a cloned repo writable by the `agent` user (Claude CLI runs as `agent` via su-exec). */
function chownToAgent(dir: string): void {
  try {
    execSync(`chown -R agent:agent "${dir}"`, { stdio: "pipe", timeout: 30_000 });
  } catch (err: any) {
    logger.warn("chownToAgent: failed (non-fatal)", { dir, error: err?.message });
  }
}

/** Build an authenticated git URL for a repo name. */
function repoUrl(repoName: string): string {
  if (GITHUB_TOKEN) {
    return `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${repoName}.git`;
  }
  return `https://github.com/${GITHUB_OWNER}/${repoName}.git`;
}

/** Remove a directory tree — best-effort cleanup. */
function rmDir(dir: string) {
  try { execSync(`rm -rf "${dir}"`, { stdio: "pipe", timeout: 15_000 }); } catch { /* ignore */ }
}

/**
 * Inject GitHub Actions workflow files into a cloned repo, commit, and push.
 * Best-effort — logs warnings but does not throw.
 */
function injectWorkflows(repoDir: string, branch: string): void {
  try {
    const workflowDir = path.join(repoDir, ".github", "workflows");
    mkdirSync(workflowDir, { recursive: true });

    writeFileSync(path.join(workflowDir, "pr-approved.yml"), PR_APPROVED_WORKFLOW);
    writeFileSync(path.join(workflowDir, "pr-review.yml"), PR_REVIEW_WORKFLOW);

    execSync("git add .github/workflows/pr-approved.yml .github/workflows/pr-review.yml", {
      cwd: repoDir, stdio: "pipe", timeout: 10_000,
    });

    // Check if there's actually something to commit (files may already exist)
    const status = execSync("git status --porcelain .github/workflows", {
      cwd: repoDir, encoding: "utf-8", timeout: 10_000,
    }).trim();

    if (!status) {
      logger.info("injectWorkflows: workflow files already up-to-date, skipping commit");
      return;
    }

    execSync('git commit -m "chore: add epic task workflow hooks (pr-approved, pr-review)"', {
      cwd: repoDir, stdio: "pipe", timeout: 15_000,
    });

    execSync(`git push origin ${branch}`, {
      cwd: repoDir, stdio: "pipe", timeout: 60_000,
    });

    logger.info("injectWorkflows: workflow files committed and pushed", { repoDir, branch });
  } catch (err: any) {
    logger.warn("injectWorkflows: failed (non-fatal)", { repoDir, error: err?.message });
  }
}

/**
 * Encrypt a secret value with the repo's libsodium sealed-box public key.
 * Returns the base64 ciphertext expected by GitHub's secrets API.
 */
function sealSecret(plaintext: string, publicKeyB64: string): string {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import sys, base64
from nacl.public import SealedBox, PublicKey
pub_key = base64.b64decode(sys.argv[1])
sealed = SealedBox(PublicKey(pub_key)).encrypt(sys.stdin.buffer.read())
sys.stdout.write(base64.b64encode(sealed).decode())`,
      publicKeyB64,
    ],
    {
      input: plaintext,
      encoding: "utf-8",
      timeout: 15_000,
    },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `sealSecret: python encrypt failed (exit ${result.status}): ${
        result.stderr || result.error?.message || "(no output)"
      }`,
    );
  }
  return (result.stdout ?? "").trim();
}

/**
 * Upload a single named secret to a GitHub repo. Caller must pass in the
 * already-fetched public key + key_id (one fetch per repo, many secrets).
 */
async function putRepoSecret(
  repoName: string,
  secretName: string,
  secretValue: string,
  key: string,
  keyId: string,
): Promise<void> {
  const encrypted = sealSecret(secretValue, key);
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${repoName}/actions/secrets/${secretName}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId }),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `Failed to set secret "${secretName}": ${resp.status} ${await resp.text()}`,
    );
  }
}

/**
 * Push every secret the injected workflows depend on to a GitHub repo:
 *   - AGENT_SERVICE_URL   → where the workflows POST webhooks to
 *   - EPIC_WEBHOOK_SECRET → shared secret required by the `/hooks/pr-*` routes
 *
 * Requires the GitHub token to have admin/secrets permissions.
 * Best-effort — logs warnings but does not throw. If any required env var is
 * missing on this service, the corresponding secret is skipped with a warning.
 */
async function setRepoSecrets(repoName: string): Promise<void> {
  if (!GITHUB_TOKEN) {
    logger.warn("setRepoSecrets: skipped — GITHUB_PERSONAL_ACCESS_TOKEN not set", { repoName });
    return;
  }
  if (!AGENT_SERVICE_PUBLIC_URL && !EPIC_WEBHOOK_SECRET) {
    logger.warn(
      "setRepoSecrets: skipped — neither AGENT_SERVICE_PUBLIC_URL nor EPIC_WEBHOOK_SECRET is set",
      { repoName },
    );
    return;
  }

  try {
    // One public-key fetch per repo, shared across all secrets we push.
    const keyResp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${repoName}/actions/secrets/public-key`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" } },
    );
    if (!keyResp.ok) {
      throw new Error(`Failed to get public key: ${keyResp.status} ${await keyResp.text()}`);
    }
    const { key, key_id } = (await keyResp.json()) as { key: string; key_id: string };

    const pushed: string[] = [];
    const skipped: { name: string; reason: string }[] = [];

    if (AGENT_SERVICE_PUBLIC_URL) {
      await putRepoSecret(repoName, "AGENT_SERVICE_URL", AGENT_SERVICE_PUBLIC_URL, key, key_id);
      pushed.push("AGENT_SERVICE_URL");
    } else {
      skipped.push({ name: "AGENT_SERVICE_URL", reason: "AGENT_SERVICE_PUBLIC_URL env var not set" });
    }

    if (EPIC_WEBHOOK_SECRET) {
      await putRepoSecret(repoName, "EPIC_WEBHOOK_SECRET", EPIC_WEBHOOK_SECRET, key, key_id);
      pushed.push("EPIC_WEBHOOK_SECRET");
    } else {
      skipped.push({ name: "EPIC_WEBHOOK_SECRET", reason: "EPIC_WEBHOOK_SECRET env var not set" });
    }

    logger.info("setRepoSecrets: done", { repoName, pushed, skipped });
  } catch (err: any) {
    logger.warn("setRepoSecrets: failed (non-fatal)", { repoName, error: err?.message });
  }
}

// ─── Service class ──────────────────────────────────────────────────────────

export class RepositoriesService {
  /**
   * List remote branches for a GitHub repo via `git ls-remote` (no clone).
   */
  async listRemoteBranches(repoName: string): Promise<string[]> {
    if (!repoName) {
      throw new RepoServiceError(400, "repo query parameter is required.");
    }
    try {
      const url = repoUrl(repoName);
      const output = execSync(`git ls-remote --heads ${url}`, {
        encoding: "utf-8" as const,
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^.*refs\/heads\//, ""));
    } catch (err: any) {
      throw new RepoServiceError(
        500,
        `Failed to list remote branches: ${err?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Unified create flow: create project, clone all repos (with rollback on
   * failure), inject workflows, set secrets, create DB records.
   *
   * Architecture generation is NOT done here — callers get `pendingArchitecture`
   * in `repoResults` and trigger it asynchronously.
   */
  async setupProject(
    input: SetupProjectInput,
  ): Promise<{ project: unknown; repoResults: RepoResult[] }> {
    const { project: projData, repositories: reposData, userId } = input;

    if (!projData?.name?.trim()) {
      throw new RepoServiceError(400, "Project name is required.");
    }
    if (!reposData?.length) {
      throw new RepoServiceError(400, "At least one repository is required.");
    }

    // ── Create project ──
    let project: any;
    try {
      project = await Project.create({
        name: projData.name.trim(),
        description: projData.description?.trim() || null,
        architectureOverview: projData.architectureOverview?.trim() || null,
        techStack: projData.techStack?.trim() || null,
        userId,
      });
    } catch (err: any) {
      logger.error("setupProject: project creation failed", { error: err?.message });
      throw new RepoServiceError(500, `Failed to create project: ${err?.message}`);
    }

    // ── Phase 1: Clone & checkout all repos ──
    const clonedDirs: string[] = [];

    for (const rd of reposData) {
      const repoName = rd.name.trim();
      const url = repoUrl(repoName);
      const targetDir = path.join(REPOS_BASE_PATH, repoName);

      if (existsSync(targetDir)) {
        for (const dir of clonedDirs) rmDir(dir);
        await project.destroy();
        throw new RepoServiceError(
          409,
          `Repository "${repoName}" already exists on disk at "${targetDir}". No changes were made.`,
        );
      }

      try {
        execSync(`git clone ${url} "${targetDir}"`, { stdio: "pipe", timeout: 120_000 });
        clonedDirs.push(targetDir);
      } catch (err: any) {
        for (const dir of clonedDirs) rmDir(dir);
        rmDir(targetDir); // partial clone
        await project.destroy();
        logger.error("setupProject: clone failed, rolling back", {
          repoName,
          error: err?.message,
        });
        throw new RepoServiceError(
          500,
          `Failed to clone "${repoName}": ${err?.message ?? String(err)}. No changes were made.`,
        );
      }

      try {
        execSync(`git checkout ${rd.branch}`, {
          cwd: targetDir,
          encoding: "utf-8" as const,
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch (err: any) {
        for (const dir of clonedDirs) rmDir(dir);
        await project.destroy();
        logger.error("setupProject: checkout failed, rolling back", {
          repoName,
          branch: rd.branch,
          error: err?.message,
        });
        throw new RepoServiceError(
          500,
          `Failed to checkout branch "${rd.branch}" for "${repoName}": ${err?.message ?? String(err)}. No changes were made.`,
        );
      }
    }

    // ── Phase 1.5: Inject workflow files + set GitHub secrets ──
    for (const rd of reposData) {
      const repoName = rd.name.trim();
      const targetDir = path.join(REPOS_BASE_PATH, repoName);
      injectWorkflows(targetDir, rd.branch);
      await setRepoSecrets(repoName);
    }

    // ── Phase 1.6: Hand ownership to `agent` user AFTER all root git operations ──
    for (const dir of clonedDirs) {
      chownToAgent(dir);
    }

    // ── Phase 2: All cloned — create DB records ──
    const repoResults: RepoResult[] = [];

    for (const rd of reposData) {
      const repoName = rd.name.trim();
      const targetDir = path.join(REPOS_BASE_PATH, repoName);
      const architecture = rd.architectureOverview?.trim() || null;

      const repo = await Repository.create({
        projectId: project.id,
        name: repoName,
        url: `https://github.com/${GITHUB_OWNER}/${repoName}.git`,
        defaultBranch: rd.branch,
        architectureOverview: architecture,
        localPath: targetDir,
        setupInstructions: rd.setupInstructions?.trim() || null,
      });

      repoResults.push({
        name: repoName,
        ok: true,
        ...(rd.generateArchitecture ? { pendingArchitecture: true, repositoryId: repo.id } : {}),
      });
    }

    const full = await Project.findByPk(project.id, {
      include: [{ model: Repository, as: "repositories" }],
    });

    return { project: full?.toJSON() ?? project.toJSON(), repoResults };
  }

  /**
   * Add a single repository to an existing project. Clones, injects workflows,
   * sets secrets, creates the DB record. Architecture generation is caller-driven.
   */
  async addRepo(
    input: AddRepoInput,
  ): Promise<{ repository: unknown; pendingArchitecture: boolean }> {
    const {
      projectId,
      name,
      branch,
      architectureOverview,
      setupInstructions,
      generateArchitecture,
    } = input;

    if (!projectId || !name?.trim() || !branch?.trim()) {
      throw new RepoServiceError(400, "projectId, name, and branch are required.");
    }

    const project = await Project.findByPk(projectId);
    if (!project) {
      throw new RepoServiceError(404, "Project not found.");
    }

    const repoName = name.trim();
    const url = repoUrl(repoName);
    const targetDir = path.join(REPOS_BASE_PATH, repoName);

    if (existsSync(targetDir)) {
      throw new RepoServiceError(
        409,
        `Repository "${repoName}" already exists on disk at "${targetDir}".`,
      );
    }

    try {
      execSync(`git clone ${url} "${targetDir}"`, { stdio: "pipe", timeout: 120_000 });
    } catch (err: any) {
      rmDir(targetDir);
      logger.error("addRepo: clone failed", { repoName, error: err?.message });
      throw new RepoServiceError(
        500,
        `Failed to clone "${repoName}": ${err?.message ?? String(err)}`,
      );
    }

    try {
      execSync(`git checkout ${branch}`, {
        cwd: targetDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch (err: any) {
      rmDir(targetDir);
      logger.error("addRepo: checkout failed", { repoName, branch, error: err?.message });
      throw new RepoServiceError(
        500,
        `Failed to checkout branch "${branch}" for "${repoName}": ${err?.message ?? String(err)}`,
      );
    }

    injectWorkflows(targetDir, branch);
    await setRepoSecrets(repoName);
    chownToAgent(targetDir);

    const repo = await Repository.create({
      projectId,
      name: repoName,
      url: `https://github.com/${GITHUB_OWNER}/${repoName}.git`,
      defaultBranch: branch,
      architectureOverview: architectureOverview?.trim() || null,
      localPath: targetDir,
      setupInstructions: setupInstructions?.trim() || null,
    });

    logger.info("addRepo: repository added to project", { repoName, projectId });
    return {
      repository: repo.toJSON(),
      pendingArchitecture: !!generateArchitecture,
    };
  }

  /**
   * Clone an existing repository record into its target directory.
   */
  async cloneExistingRepo(repoId: string): Promise<unknown> {
    const repo = await Repository.findByPk(repoId);
    if (!repo) {
      throw new RepoServiceError(404, "Repository not found.");
    }

    const targetDir = path.join(REPOS_BASE_PATH, repo.name);

    if (repo.localPath && existsSync(repo.localPath)) {
      throw new RepoServiceError(409, `Repository already cloned at "${repo.localPath}".`);
    }

    try {
      const url = GITHUB_TOKEN
        ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${repo.name}.git`
        : repo.url;

      execSync(`git clone ${url} "${targetDir}"`, { stdio: "pipe", timeout: 120_000 });

      injectWorkflows(targetDir, repo.defaultBranch);
      await setRepoSecrets(repo.name);
      chownToAgent(targetDir);

      await repo.update({ localPath: targetDir });
      logger.info("Repository cloned", { repoId, targetDir });
      return repo.toJSON();
    } catch (err: any) {
      logger.error("cloneExistingRepo error", { error: err?.message });
      throw new RepoServiceError(500, err?.message ?? "Internal error");
    }
  }

  /**
   * List local branches of a cloned repository (`git branch -r`).
   */
  async listLocalBranches(repoId: string): Promise<string[]> {
    const repo = await Repository.findByPk(repoId);
    if (!repo) {
      throw new RepoServiceError(404, "Repository not found.");
    }
    if (!repo.localPath || !existsSync(repo.localPath)) {
      throw new RepoServiceError(400, "Repository has not been cloned yet.");
    }

    try {
      const output = execSync("git branch -r", {
        cwd: repo.localPath,
        encoding: "utf-8" as const,
        timeout: 30_000,
      });
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.includes("HEAD"))
        .map((line) => line.replace(/^origin\//, ""));
    } catch (err: any) {
      logger.error("listLocalBranches error", { error: err?.message });
      throw new RepoServiceError(500, err?.message ?? "Internal error");
    }
  }

  /**
   * Switch the tracked branch of a cloned repository.
   */
  async setBranch(repoId: string, branch: string): Promise<unknown> {
    if (!branch?.trim()) {
      throw new RepoServiceError(400, "branch is required.");
    }

    const repo = await Repository.findByPk(repoId);
    if (!repo) {
      throw new RepoServiceError(404, "Repository not found.");
    }
    if (!repo.localPath || !existsSync(repo.localPath)) {
      throw new RepoServiceError(400, "Repository has not been cloned yet.");
    }

    try {
      execSync(`git checkout ${branch}`, {
        cwd: repo.localPath,
        encoding: "utf-8" as const,
        stdio: "pipe",
        timeout: 30_000,
      });

      // Checkout may create new root-owned files from the target branch
      chownToAgent(repo.localPath);

      await repo.update({ defaultBranch: branch });
      logger.info("Repository branch changed", { repoId, branch });
      return repo.toJSON();
    } catch (err: any) {
      logger.error("setBranch error", { error: err?.message });
      throw new RepoServiceError(500, err?.message ?? "Internal error");
    }
  }

  /**
   * Generate an architecture overview for a cloned repository via Claude CLI.
   */
  async generateArchitecture(repoId: string): Promise<unknown> {
    const repo = await Repository.findByPk(repoId);
    if (!repo) {
      throw new RepoServiceError(404, "Repository not found.");
    }
    if (!repo.localPath || !existsSync(repo.localPath)) {
      throw new RepoServiceError(400, "Repository has not been cloned yet.");
    }

    const currentOverview = repo.architectureOverview?.trim() || "(none)";
    const prompt =
      "Analyze this repository's current structure and produce a concise architecture overview. " +
      "Include: top-level folder tree (depth 2), major components and their responsibilities, " +
      "key patterns (e.g. MVC, monorepo, microservices), and entry points. " +
      "Be factual — only describe what exists now.\n\n" +
      "Current stored overview (may be outdated):\n" +
      currentOverview + "\n\n" +
      "Output ONLY the updated architecture overview text — no preamble, no markdown fences, " +
      "no explanation. Keep it under 2000 characters.";

    try {
      const result = runClaudeArchitecture(repo.localPath, prompt);

      if (!result || result.length < 20) {
        throw new RepoServiceError(500, "Claude returned an empty or too-short architecture overview.");
      }

      const overview = result.length > 5000 ? result.slice(0, 5000) : result;
      await repo.update({ architectureOverview: overview });
      logger.info("Architecture generated", { repoId });
      return repo.toJSON();
    } catch (err: any) {
      if (err instanceof RepoServiceError) throw err;
      logger.error("generateArchitecture error", { error: err?.message });
      throw new RepoServiceError(500, err?.message ?? "Internal error");
    }
  }

  /**
   * Remove the cloned repository directory from disk.
   */
  async deleteLocal(repoId: string): Promise<{ ok: true }> {
    logger.info("deleteLocal invoked", { repoId });
    const repo = await Repository.findByPk(repoId);
    if (!repo) {
      throw new RepoServiceError(404, "Repository not found.");
    }

    logger.info("Deleting local repo directory", { repoId, localPath: repo.localPath });

    if (repo.localPath && existsSync(repo.localPath)) {
      try {
        const result = execSync(`rm -rf "${repo.localPath}"`, { stdio: "pipe", timeout: 30_000 });
        logger.info(`Result of rm -rf: ${result.toString()}`);
      } catch (err: any) {
        logger.error("Failed to rm repo directory", {
          repoId,
          localPath: repo.localPath,
          error: err?.message,
        });
        throw new RepoServiceError(500, `Failed to remove directory: ${err?.message}`);
      }

      if (existsSync(repo.localPath)) {
        logger.error("Repo directory still exists after rm", {
          repoId,
          localPath: repo.localPath,
        });
        throw new RepoServiceError(500, "Directory still exists after removal attempt.");
      }

      logger.info("Local repo directory removed", { repoId, localPath: repo.localPath });
    } else {
      logger.info("Local repo directory does not exist", {
        repoId,
        localPath: repo.localPath,
      });
    }

    return { ok: true };
  }
}
