import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { prisma } from "../db.js";
import type { ProjectRole } from "@prisma/client";

export interface AuthedRequest extends Request {
  userId?: string;
  userName?: string;
}

export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: "7d" });
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "未登录" });
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "登录已过期，请重新登录" });
  }
}

/** 返回用户在项目中的角色；非成员返回 null */
export async function memberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
  const m = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  return m?.role ?? null;
}

export async function logActivity(projectId: string, actorName: string, action: string, detail = "") {
  await prisma.activity.create({ data: { projectId, actorName, action, detail } });
}
