import { Request, Response } from "express";
import {
  RepositoriesService,
  RepoServiceError,
  type SetupProjectInput,
  type AddRepoInput,
} from "../services/repositories.service";
import { logger } from "../logger";

const repositoriesService = new RepositoriesService();

/**
 * Map a thrown error onto an Express response. Typed `RepoServiceError`s carry
 * their own HTTP status; everything else becomes a 500.
 */
function handleError(res: Response, err: unknown, logContext: string): Response {
  if (err instanceof RepoServiceError) {
    if (err.status >= 500) {
      logger.error(logContext, { error: err.message });
    }
    return res.status(err.status).json({ error: err.message });
  }
  const message = (err as any)?.message ?? "Internal error";
  logger.error(logContext, { error: message });
  return res.status(500).json({ error: message });
}

export class RepositoriesController {
  getRemoteBranches = async (req: Request, res: Response) => {
    try {
      const repoName = String(req.query.repo ?? "").trim();
      const branches = await repositoriesService.listRemoteBranches(repoName);
      return res.json(branches);
    } catch (err) {
      return handleError(res, err, "GET /repositories/remote-branches error");
    }
  };

  setupProject = async (req: Request, res: Response) => {
    try {
      const result = await repositoriesService.setupProject(req.body as SetupProjectInput);
      return res.json(result);
    } catch (err) {
      return handleError(res, err, "POST /repositories/setup-project error");
    }
  };

  addRepo = async (req: Request, res: Response) => {
    try {
      const result = await repositoriesService.addRepo(req.body as AddRepoInput);
      return res.json(result);
    } catch (err) {
      return handleError(res, err, "POST /repositories/add-repo error");
    }
  };

  cloneRepo = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const repo = await repositoriesService.cloneExistingRepo(repoId);
      return res.json(repo);
    } catch (err) {
      return handleError(res, err, "POST /repositories/:repoId/clone error");
    }
  };

  listBranches = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const branches = await repositoriesService.listLocalBranches(repoId);
      return res.json(branches);
    } catch (err) {
      return handleError(res, err, "GET /repositories/:repoId/branches error");
    }
  };

  setBranch = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const branch = String(req.body?.branch ?? "");
      const repo = await repositoriesService.setBranch(repoId, branch);
      return res.json(repo);
    } catch (err) {
      return handleError(res, err, "PATCH /repositories/:repoId/branch error");
    }
  };

  generateArchitecture = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const repo = await repositoriesService.generateArchitecture(repoId);
      return res.json(repo);
    } catch (err) {
      return handleError(res, err, "POST /repositories/:repoId/generate-architecture error");
    }
  };

  deleteLocal = async (req: Request, res: Response) => {
    try {
      const repoId = String(req.params.repoId);
      const result = await repositoriesService.deleteLocal(repoId);
      return res.json(result);
    } catch (err) {
      return handleError(res, err, "DELETE /repositories/:repoId/local error");
    }
  };
}
