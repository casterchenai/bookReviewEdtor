// 超级管理员后台：系统用户管理 + 全局 AI 配置
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requireSuperAdmin, type AuthedRequest } from "../middleware/auth.js";
import { AI_PROVIDERS, sanitizeAiConfig } from "../lib/ai-providers.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireSuperAdmin);

// ===== 系统用户管理 =====

// 所有用户列表（排除 AI 系统账户）
adminRouter.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { isAI: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, email: true, name: true, isSuperAdmin: true, canCreateBooks: true, createdAt: true,
      _count: { select: { memberships: true, ownedProjects: true } },
    },
  });
  res.json(users);
});

const createUserSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  name: z.string().min(1, "请填写姓名").max(50),
  password: z.string().min(8, "密码至少 8 位"),
  canCreateBooks: z.boolean().optional(),
});

adminRouter.post("/users", async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, name, password, canCreateBooks } = parsed.data;

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "该邮箱已注册" });

  const user = await prisma.user.create({
    data: {
      email, name,
      passwordHash: await bcrypt.hash(password, 10),
      canCreateBooks: canCreateBooks ?? true,
    },
  });
  res.json({ id: user.id });
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  password: z.string().min(8, "密码至少 8 位").optional(),
  canCreateBooks: z.boolean().optional(),
});

adminRouter.patch("/users/:id", async (req: AuthedRequest, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.isAI) return res.status(404).json({ error: "用户不存在" });
  if (target.isSuperAdmin) return res.status(403).json({ error: "超级管理员账户由环境变量管理，不可在此修改" });

  const data: { name?: string; canCreateBooks?: boolean; passwordHash?: string } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.canCreateBooks !== undefined) data.canCreateBooks = parsed.data.canCreateBooks;
  if (parsed.data.password) data.passwordHash = await bcrypt.hash(parsed.data.password, 10);

  await prisma.user.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
});

adminRouter.delete("/users/:id", async (req: AuthedRequest, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.isAI) return res.status(404).json({ error: "用户不存在" });
  if (target.isSuperAdmin) return res.status(403).json({ error: "不可删除超级管理员账户" });
  if (target.id === req.userId) return res.status(400).json({ error: "不可删除自己" });

  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ===== 全局 AI 配置 =====

adminRouter.get("/ai-config", async (_req, res) => {
  const config = await prisma.aiConfig.findFirst({ where: { projectId: null } });
  res.json({ config: config ? sanitizeAiConfig(config) : null, providers: AI_PROVIDERS });
});

const aiConfigSchema = z.object({
  provider: z.enum(["AUTO", "OPENAI", "GLM", "DEEPSEEK", "ANTHROPIC"]),
  model: z.string().max(100).optional(),
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().max(500).optional(),
});

adminRouter.put("/ai-config", async (req, res) => {
  const parsed = aiConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await prisma.aiConfig.findFirst({ where: { projectId: null } });
  // apiKey 留空表示不改动已有密钥（避免前端拿不到明文后误清空）
  const apiKey = parsed.data.apiKey === undefined || parsed.data.apiKey === "" ? existing?.apiKey ?? "" : parsed.data.apiKey;
  const data = {
    provider: parsed.data.provider,
    model: parsed.data.model ?? "",
    apiKey,
    baseUrl: parsed.data.baseUrl ?? "",
  };
  const config = existing
    ? await prisma.aiConfig.update({ where: { id: existing.id }, data })
    : await prisma.aiConfig.create({ data: { ...data, projectId: null } });
  res.json({ config: sanitizeAiConfig(config) });
});
