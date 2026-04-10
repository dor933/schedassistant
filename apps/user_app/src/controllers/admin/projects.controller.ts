import { Request, Response } from "express";
import { ProjectsService } from "../../services/admin/projects.service";
import { logger } from "../../logger";

export class ProjectsController {
  private projectsService = new ProjectsService();

  getAll = async (_req: Request, res: Response) => {
    try {
      const projects = await this.projectsService.getAll();
      return res.json(projects);
    } catch (err: any) {
      logger.error("GET /projects error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  update = async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const project = await this.projectsService.update(
        id,
        {
          name: req.body.name,
          description: req.body.description,
          architectureOverview: req.body.architectureOverview,
          techStack: req.body.techStack,
        },
        req.user!.userId,
      );
      return res.json(project);
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      logger.error("PATCH /projects/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  remove = async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      await this.projectsService.delete(id, req.user!.userId);
      return res.json({ deleted: true });
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      logger.error("DELETE /projects/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  updateRepository = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const repo = await this.projectsService.updateRepository(
        repoId,
        {
          name: req.body.name,
          url: req.body.url,
          defaultBranch: req.body.defaultBranch,
          architectureOverview: req.body.architectureOverview,
          localPath: req.body.localPath,
          setupInstructions: req.body.setupInstructions,
        },
        req.user!.userId,
      );
      return res.json(repo);
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      logger.error("PATCH /repositories/:repoId error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  deleteRepository = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      await this.projectsService.deleteRepository(repoId, req.user!.userId);
      return res.json({ deleted: true });
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      logger.error("DELETE /repositories/:repoId error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  getRemoteBranches = async (req: Request, res: Response) => {
    try {
      const repoName = String(req.query.repo ?? "").trim();
      if (!repoName) return res.status(400).json({ error: "repo query parameter is required." });
      const branches = await this.projectsService.getRemoteBranches(repoName);
      return res.json(branches);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /remote-branches error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  setupProject = async (req: Request, res: Response) => {
    try {
      const { project, repositories } = req.body ?? {};
      if (!project?.name?.trim()) return res.status(400).json({ error: "Project name is required." });
      if (!repositories?.length) return res.status(400).json({ error: "At least one repository is required." });
      const result = await this.projectsService.setupProject(
        { project, repositories },
        req.user!.userId,
      );
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /projects/setup error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  addRepository = async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const { name, branch, generateArchitecture, architectureOverview, setupInstructions } = req.body ?? {};
      if (!name?.trim()) return res.status(400).json({ error: "Repository name is required." });
      if (!branch?.trim()) return res.status(400).json({ error: "Branch is required." });
      const result = await this.projectsService.addRepository(
        projectId,
        { name: name.trim(), branch: branch.trim(), generateArchitecture, architectureOverview, setupInstructions },
        req.user!.userId,
      );
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /projects/:id/repositories error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  cloneRepository = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const repo = await this.projectsService.cloneRepository(repoId, req.user!.userId);
      return res.json(repo);
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      if (err.status === 409) return res.status(409).json({ error: err.message });
      logger.error("POST /repositories/:repoId/clone error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  getBranches = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const branches = await this.projectsService.getRepositoryBranches(repoId);
      return res.json(branches);
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      if (err.status === 400) return res.status(400).json({ error: err.message });
      logger.error("GET /repositories/:repoId/branches error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  setBranch = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const { branch } = req.body ?? {};
      if (!branch?.trim()) {
        return res.status(400).json({ error: "branch is required." });
      }
      const repo = await this.projectsService.setRepositoryBranch(repoId, branch.trim(), req.user!.userId);
      return res.json(repo);
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      if (err.status === 400) return res.status(400).json({ error: err.message });
      logger.error("PATCH /repositories/:repoId/branch error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  generateArchitecture = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      await this.projectsService.generateArchitectureAsync(repoId, req.user!.userId);
      return res.status(202).json({ accepted: true });
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      if (err.status === 400) return res.status(400).json({ error: err.message });
      logger.error("POST /repositories/:repoId/generate-architecture error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
