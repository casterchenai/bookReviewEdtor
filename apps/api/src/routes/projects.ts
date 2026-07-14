import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { logActivity, memberRole, requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

// 我参与的项目列表
projectsRouter.get("/", async (req: AuthedRequest, res) => {
  const projects = await prisma.project.findMany({
    where: { members: { some: { userId: req.userId! } } },
    include: {
      _count: { select: { manuscripts: true, members: true } },
      members: { where: { userId: req.userId! }, select: { role: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  res.json(
    projects.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      manuscriptCount: p._count.manuscripts,
      memberCount: p._count.members,
      myRole: p.members[0]?.role,
      updatedAt: p.updatedAt,
    })),
  );
});

const createSchema = z.object({
  title: z.string().min(1, "请填写书名").max(200),
  description: z.string().max(2000).optional(),
});

// 创建项目（创建者自动成为主编，并自动加入 AI 智能助手）
projectsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  const aiUser = await prisma.user.findFirst({ where: { isAI: true } });

  const project = await prisma.project.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description ?? "",
      ownerId: req.userId!,
      members: {
        create: [
          { userId: req.userId!, role: "CHIEF_EDITOR" },
          ...(aiUser ? [{ userId: aiUser.id, role: "AI_ASSISTANT" as const }] : []),
        ],
      },
    },
  });
  await logActivity(project.id, me!.name, "创建项目", project.title);
  res.json({ id: project.id });
});

// 项目详情
projectsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });

  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      members: { include: { user: { select: { id: true, name: true, email: true, isAI: true } } } },
      manuscripts: {
        orderBy: { order: "asc" },
        select: {
          id: true, title: true, status: true, order: true, updatedAt: true,
          _count: { select: { revisions: true, comments: { where: { status: "OPEN" } } } },
        },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });
  if (!project) return res.status(404).json({ error: "项目不存在" });
  res.json({ ...project, myRole: role });
});

// 更新项目信息 / 修订标准（仅主编）
projectsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可修改项目设置" });

  const schema = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    standards: z.string().max(10000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  await prisma.project.update({ where: { id: req.params.id }, data: parsed.data });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (parsed.data.standards !== undefined) {
    await logActivity(req.params.id, me!.name, "更新修订标准");
  }
  res.json({ ok: true });
});

// 添加成员（仅主编；按邮箱邀请）
projectsRouter.post("/:id/members", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可管理成员" });

  const schema = z.object({
    email: z.string().email("邮箱格式不正确"),
    role: z.enum(["CHIEF_EDITOR", "AGENT", "REVIEWER"]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || user.isAI) return res.status(404).json({ error: "该邮箱尚未注册，请先让对方注册账户" });

  const exists = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: req.params.id, userId: user.id } },
  });
  if (exists) return res.status(409).json({ error: "该用户已是项目成员" });

  await prisma.projectMember.create({
    data: { projectId: req.params.id, userId: user.id, role: parsed.data.role },
  });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(req.params.id, me!.name, "添加成员", `${user.name}（${roleLabel(parsed.data.role)}）`);
  res.json({ ok: true });
});

// 新建书稿章节
projectsRouter.post("/:id/manuscripts", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });
  if (role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });

  const schema = z.object({ title: z.string().min(1, "请填写章节标题").max(200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const count = await prisma.manuscript.count({ where: { projectId: req.params.id } });
  const manuscript = await prisma.manuscript.create({
    data: { projectId: req.params.id, title: parsed.data.title, order: count, status: "DRAFT" },
  });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(req.params.id, me!.name, "新建书稿", parsed.data.title);
  res.json({ id: manuscript.id });
});

export function roleLabel(role: string) {
  return (
    { CHIEF_EDITOR: "主编", AGENT: "文学经纪人", REVIEWER: "审校员", AI_ASSISTANT: "AI 智能助手" } as Record<string, string>
  )[role] ?? role;
}
