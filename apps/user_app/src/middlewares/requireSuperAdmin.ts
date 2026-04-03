import { Request, Response, NextFunction } from "express";

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "super_admin") {
    res.status(403).json({ error: "Super admin access required." });
    return;
  }
  next();
}
