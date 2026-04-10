import { Project, Repository } from "@scheduling-agent/database";
import type { ProjectId, RepositoryId, UserId } from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export class ProjectsService {
  async getAll() {
    const rows = await Project.findAll({
      include: [{ model: Repository, as: "repositories" }],
      order: [["createdAt", "DESC"]],
    });
    return rows.map((r) => r.toJSON());
  }

  async update(
    projectId: ProjectId,
    data: {
      name?: string;
      description?: string | null;
      architectureOverview?: string | null;
      techStack?: string | null;
    },
    userId: UserId,
  ) {
    const project = await Project.findByPk(projectId);
    if (!project) throw Object.assign(new Error("Project not found."), { status: 404 });

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.description !== undefined) patch.description = data.description?.trim() || null;
    if (data.architectureOverview !== undefined) patch.architectureOverview = data.architectureOverview?.trim() || null;
    if (data.techStack !== undefined) patch.techStack = data.techStack?.trim() || null;

    await project.update(patch);
    this.broadcast("project_updated", `Project "${project.name}" updated`, { projectId: project.id }, userId);
    return project;
  }

  async delete(projectId: ProjectId, userId: UserId) {
    const project = await Project.findByPk(projectId);
    if (!project) throw Object.assign(new Error("Project not found."), { status: 404 });
    const name = project.name;

    // Remove cloned repo directories from agent_service before deleting DB records
    const repos = await Repository.findAll({ where: { projectId }, attributes: ["id", "localPath"] });
    for (const repo of repos) {
      try {
        const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/${repo.id}/local`, { method: "DELETE" });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({})) as any;
          logger.warn("Failed to remove local repo directory", { repoId: repo.id, localPath: repo.localPath, status: resp.status, error: body.error });
        }
      } catch (err) {
        logger.warn("Failed to remove local repo directory (network)", { repoId: repo.id, localPath: repo.localPath, error: String(err) });
      }
    }

    await project.destroy();
    this.broadcast("project_deleted", `Project "${name}" deleted`, { projectId }, userId);
    logger.info("Project deleted", { projectId });
  }

  async updateRepository(
    repoId: RepositoryId,
    data: {
      name?: string;
      url?: string;
      defaultBranch?: string;
      architectureOverview?: string | null;
      localPath?: string | null;
      setupInstructions?: string | null;
    },
    userId: UserId,
  ) {
    const repo = await Repository.findByPk(repoId);
    if (!repo) throw Object.assign(new Error("Repository not found."), { status: 404 });

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.url !== undefined) patch.url = data.url.trim();
    if (data.defaultBranch !== undefined) patch.defaultBranch = data.defaultBranch.trim();
    if (data.architectureOverview !== undefined) patch.architectureOverview = data.architectureOverview?.trim() || null;
    if (data.localPath !== undefined) patch.localPath = data.localPath?.trim() || null;
    if (data.setupInstructions !== undefined) patch.setupInstructions = data.setupInstructions?.trim() || null;

    await repo.update(patch);
    this.broadcast("repository_updated", `Repository "${repo.name}" updated`, { repositoryId: repo.id, projectId: repo.projectId }, userId);
    return repo;
  }

  async deleteRepository(repoId: RepositoryId, userId: UserId) {
    const repo = await Repository.findByPk(repoId);
    if (!repo) throw Object.assign(new Error("Repository not found."), { status: 404 });
    const name = repo.name;
    const projectId = repo.projectId;

    // Remove cloned repo directory from agent_service
    try {
      const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/${repo.id}/local`, { method: "DELETE" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as any;
        logger.warn("Failed to remove local repo directory", { repoId: repo.id, status: resp.status, error: body.error });
      }
      else{
        logger.info(`Local repo directory removed successfully + repoId: ${repo.id}, localPath: ${repo.localPath}`);
      }
    } catch (err) {
      logger.warn("Failed to remove local repo directory (network)", { repoId: repo.id, error: String(err) });
    }

    await repo.destroy();
    this.broadcast("repository_deleted", `Repository "${name}" deleted`, { repositoryId: repoId, projectId }, userId);
    logger.info("Repository deleted", { repoId });
  }

  async getRemoteBranches(repoName: string) {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/remote-branches?repo=${encodeURIComponent(repoName)}`);
    const body = await resp.json() as any;
    if (!resp.ok) {
      throw Object.assign(new Error(body.error ?? "Failed to list remote branches"), { status: resp.status });
    }
    return body as string[];
  }

  async setupProject(
    data: {
      project: { name: string; description?: string; architectureOverview?: string; techStack?: string };
      repositories: {
        name: string;
        branch: string;
        generateArchitecture: boolean;
        architectureOverview?: string;
        setupInstructions?: string;
      }[];
    },
    userId: UserId,
  ) {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/setup-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, userId }),
    });
    const body = await resp.json() as any;
    if (!resp.ok) {
      throw Object.assign(new Error(body.error ?? "Project setup failed"), { status: resp.status });
    }
    this.broadcast("project_created", `Project "${data.project.name}" created`, { projectId: body.project?.id }, userId);

    // Fire-and-forget: generate architecture in background for repos that need it
    const pending: { repositoryId: string; name: string }[] =
      (body.repoResults ?? []).filter((r: any) => r.pendingArchitecture && r.repositoryId);
    if (pending.length > 0) {
      this.generateArchitecturesInBackground(pending, userId);
    }

    return body;
  }

  /** Runs architecture generation for multiple repos sequentially in the background. */
  private async generateArchitecturesInBackground(
    repos: { repositoryId: string; name: string }[],
    userId: UserId,
  ) {
    for (const repo of repos) {
      try {
        const resp = await fetch(
          `${AGENT_SERVICE_URL}/api/repositories/${repo.repositoryId}/generate-architecture`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        const body = await resp.json() as any;
        if (resp.ok) {
          this.emitToUser(
            userId,
            "repository_architecture_generated",
            `Architecture generated for "${repo.name}"`,
            { repositoryId: repo.repositoryId, architectureOverview: body.architectureOverview },
          );
        } else {
          logger.warn("Background architecture generation failed", { repoId: repo.repositoryId, error: body.error });
          this.emitToUser(
            userId,
            "repository_architecture_failed",
            `Architecture generation failed for "${repo.name}"`,
            { repositoryId: repo.repositoryId },
          );
        }
      } catch (err) {
        logger.warn("Background architecture generation error", { repoId: repo.repositoryId, error: String(err) });
        this.emitToUser(
          userId,
          "repository_architecture_failed",
          `Architecture generation failed for "${repo.name}"`,
          { repositoryId: repo.repositoryId },
        );
      }
    }
  }

  async addRepository(
    projectId: ProjectId,
    data: {
      name: string;
      branch: string;
      generateArchitecture?: boolean;
      architectureOverview?: string;
      setupInstructions?: string;
    },
    userId: UserId,
  ) {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/add-repo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, ...data }),
    });
    const body = await resp.json() as any;
    if (!resp.ok) {
      throw Object.assign(new Error(body.error ?? "Failed to add repository"), { status: resp.status });
    }

    this.broadcast("repository_added", `Repository "${data.name}" added`, { repositoryId: body.repository?.id, projectId }, userId);

    // Fire-and-forget architecture generation if requested
    if (body.pendingArchitecture && body.repository?.id) {
      this.generateArchitecturesInBackground(
        [{ repositoryId: body.repository.id, name: data.name }],
        userId,
      );
    }

    return body;
  }

  async cloneRepository(repoId: RepositoryId, userId: UserId) {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/${repoId}/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = await resp.json() as any;
    if (!resp.ok) {
      throw Object.assign(new Error(body.error ?? "Clone failed"), { status: resp.status });
    }
    this.broadcast("repository_cloned", `Repository cloned`, { repositoryId: repoId }, userId);
    return body;
  }

  async getRepositoryBranches(repoId: RepositoryId) {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/${repoId}/branches`);
    const body = await resp.json() as any;
    if (!resp.ok) {
      throw Object.assign(new Error(body.error ?? "Failed to list branches"), { status: resp.status });
    }
    return body;
  }

  async setRepositoryBranch(repoId: RepositoryId, branch: string, userId: UserId) {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/repositories/${repoId}/branch`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    const body = await resp.json() as any;
    if (!resp.ok) {
      throw Object.assign(new Error(body.error ?? "Branch switch failed"), { status: resp.status });
    }
    this.broadcast("repository_branch_changed", `Branch changed to "${branch}"`, { repositoryId: repoId, branch }, userId);
    return body;
  }

  /**
   * Validates that the repo can have its architecture generated, then kicks off
   * generation in the background. The caller should return 202 immediately.
   * Results are delivered via socket events.
   */
  async generateArchitectureAsync(repoId: RepositoryId, userId: UserId) {
    const repo = await Repository.findByPk(repoId);
    if (!repo) throw Object.assign(new Error("Repository not found."), { status: 404 });
    if (!repo.localPath) throw Object.assign(new Error("Repository has not been cloned yet."), { status: 400 });

    // Fire-and-forget — notify via socket when done
    this.generateArchitecturesInBackground(
      [{ repositoryId: repoId, name: repo.name }],
      userId,
    );
  }

  private broadcast(type: string, message: string, data: Record<string, unknown>, actorId: UserId) {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange error", { error: String(err) });
    }
  }

  /** Emit an admin:change event only to a specific user's socket room. */
  private emitToUser(userId: UserId, type: string, message: string, data: Record<string, unknown>) {
    try {
      getIO().to(`user:${userId}`).emit("admin:change", { type, message, data, actorId: userId });
    } catch (err) {
      logger.error("emitToUser error", { error: String(err) });
    }
  }
}
