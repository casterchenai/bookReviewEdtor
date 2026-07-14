import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { logActivity, memberRole, requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { AI_PROVIDERS, sanitizeAiConfig } from "../lib/ai-providers.js";
import { parseHtml, parseMarkdown, normalizeDoc, blocksToHtml, blocksToMarkdown, textToMarkdown, type Block } from "../lib/content.js";
import { parsePdf } from "../lib/pdf.js";

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

// 建书时自动创建的默认角色（显示名可被主编后续编辑）
const DEFAULT_ROLES: { name: string; base: "CHIEF_EDITOR" | "AGENT" | "REVIEWER" | "AI_ASSISTANT"; order: number }[] = [
  { name: "主编", base: "CHIEF_EDITOR", order: 0 },
  { name: "文学经纪人", base: "AGENT", order: 1 },
  { name: "审校员", base: "REVIEWER", order: 2 },
  { name: "AI 智能助手", base: "AI_ASSISTANT", order: 3 },
];

// 创建项目（创建者自动成为主编，并自动加入 AI 智能助手；种子默认角色）
projectsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!me) return res.status(404).json({ error: "用户不存在" });
  if (!me.canCreateBooks && !me.isSuperAdmin) {
    return res.status(403).json({ error: "您没有创建书稿的权限，请联系超级管理员开通" });
  }
  const aiUser = await prisma.user.findFirst({ where: { isAI: true } });

  const project = await prisma.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: {
        title: parsed.data.title,
        description: parsed.data.description ?? "",
        ownerId: req.userId!,
      },
    });
    // 种子默认角色
    const roles = await Promise.all(
      DEFAULT_ROLES.map((r) =>
        tx.bookRole.create({ data: { projectId: p.id, name: r.name, base: r.base, order: r.order, isDefault: true } }),
      ),
    );
    const roleByBase = new Map(roles.map((r) => [r.base, r.id]));
    await tx.projectMember.create({
      data: { projectId: p.id, userId: req.userId!, role: "CHIEF_EDITOR", bookRoleId: roleByBase.get("CHIEF_EDITOR") },
    });
    if (aiUser) {
      await tx.projectMember.create({
        data: { projectId: p.id, userId: aiUser.id, role: "AI_ASSISTANT", bookRoleId: roleByBase.get("AI_ASSISTANT") },
      });
    }
    return p;
  });
  await logActivity(project.id, me.name, "创建项目", project.title);
  res.json({ id: project.id });
});

// 项目详情
projectsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });

  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      members: {
        include: {
          user: { select: { id: true, name: true, email: true, isAI: true } },
          bookRole: { select: { id: true, name: true, base: true } },
        },
      },
      bookRoles: { orderBy: { order: "asc" }, include: { _count: { select: { members: true } } } },
      aiConfig: { select: { provider: true, model: true, baseUrl: true } },
      manuscripts: {
        orderBy: { order: "asc" },
        select: {
          id: true, title: true, status: true, order: true, section: true, updatedAt: true,
          _count: { select: { revisions: true, comments: { where: { status: "OPEN" } } } },
        },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });
  if (!project) return res.status(404).json({ error: "项目不存在" });
  res.json({ ...project, myRole: role, hasBookAiConfig: Boolean(project.aiConfig) });
});

// 导出整本书为 Markdown / HTML（合并所有章节，按部分分组）
projectsRouter.get("/:id/export", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ error: "项目不存在" });
  const chapters = await prisma.manuscript.findMany({
    where: { projectId: req.params.id },
    orderBy: { order: "asc" },
    select: { title: true, content: true, docJson: true, section: true },
  });
  const format = req.query.format === "html" ? "html" : "md";

  if (format === "md") {
    const parts: string[] = [`# ${project.title}\n`];
    let lastSection = "";
    for (const c of chapters) {
      if (c.section && c.section !== lastSection) { parts.push(`## ${c.section}`); lastSection = c.section; }
      const doc = c.docJson ? normalizeDoc(JSON.parse(c.docJson)) : null;
      parts.push(`### ${c.title}`);
      parts.push(doc ? blocksToMarkdown(doc.blocks) : textToMarkdown(c.content));
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(project.title)}.md`);
    return res.send(parts.join("\n\n"));
  }

  const all: Block[] = [{ type: "heading", level: 1, text: project.title }];
  let lastSection = "";
  for (const c of chapters) {
    if (c.section && c.section !== lastSection) { all.push({ type: "heading", level: 2, text: c.section }); lastSection = c.section; }
    all.push({ type: "heading", level: 3, text: c.title });
    const doc = c.docJson ? normalizeDoc(JSON.parse(c.docJson)) : null;
    if (doc) all.push(...doc.blocks);
    else for (const p of c.content.split(/\n\n/).filter((x) => x.trim())) all.push({ type: "para", text: p });
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(project.title)}.html`);
  res.send(blocksToHtml(all, project.title));
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

// 添加成员（仅主编；按邮箱邀请，分配本书角色）
projectsRouter.post("/:id/members", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可管理成员" });

  const schema = z.object({
    email: z.string().email("邮箱格式不正确"),
    bookRoleId: z.string().min(1, "请选择角色"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const bookRole = await prisma.bookRole.findFirst({
    where: { id: parsed.data.bookRoleId, projectId: req.params.id },
  });
  if (!bookRole) return res.status(404).json({ error: "角色不存在" });
  if (bookRole.base === "AI_ASSISTANT") return res.status(400).json({ error: "AI 助手角色不可分配给用户" });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || user.isAI) return res.status(404).json({ error: "该邮箱尚未注册，请先让对方注册账户" });

  const exists = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: req.params.id, userId: user.id } },
  });
  if (exists) return res.status(409).json({ error: "该用户已是项目成员" });

  await prisma.projectMember.create({
    data: { projectId: req.params.id, userId: user.id, role: bookRole.base, bookRoleId: bookRole.id },
  });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(req.params.id, me!.name, "添加成员", `${user.name}（${bookRole.name}）`);
  res.json({ ok: true });
});

// 调整成员角色（仅主编）
projectsRouter.patch("/:id/members/:memberId", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可管理成员" });

  const schema = z.object({ bookRoleId: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "参数错误" });

  const member = await prisma.projectMember.findFirst({
    where: { id: req.params.memberId, projectId: req.params.id },
    include: { user: { select: { isAI: true } } },
  });
  if (!member) return res.status(404).json({ error: "成员不存在" });
  if (member.user.isAI) return res.status(400).json({ error: "AI 助手角色不可更改" });

  const bookRole = await prisma.bookRole.findFirst({ where: { id: parsed.data.bookRoleId, projectId: req.params.id } });
  if (!bookRole || bookRole.base === "AI_ASSISTANT") return res.status(400).json({ error: "角色无效" });

  await prisma.projectMember.update({
    where: { id: member.id },
    data: { role: bookRole.base, bookRoleId: bookRole.id },
  });
  res.json({ ok: true });
});

// 移除成员（仅主编）
projectsRouter.delete("/:id/members/:memberId", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可管理成员" });

  const member = await prisma.projectMember.findFirst({
    where: { id: req.params.memberId, projectId: req.params.id },
    include: { user: { select: { isAI: true, id: true } } },
  });
  if (!member) return res.status(404).json({ error: "成员不存在" });
  if (member.user.isAI) return res.status(400).json({ error: "不可移除 AI 助手" });
  if (member.userId === req.userId) return res.status(400).json({ error: "不可移除自己" });

  await prisma.projectMember.delete({ where: { id: member.id } });
  res.json({ ok: true });
});

// ===== 本书角色管理（可编辑角色名）=====

// 新建角色（仅主编）
projectsRouter.post("/:id/roles", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可管理角色" });

  const schema = z.object({
    name: z.string().min(1, "请填写角色名").max(50),
    base: z.enum(["CHIEF_EDITOR", "AGENT", "REVIEWER"]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const count = await prisma.bookRole.count({ where: { projectId: req.params.id } });
  try {
    const created = await prisma.bookRole.create({
      data: { projectId: req.params.id, name: parsed.data.name, base: parsed.data.base, order: count },
    });
    res.json({ id: created.id });
  } catch {
    res.status(409).json({ error: "同名角色已存在" });
  }
});

// 重命名 / 改能力原型（仅主编）
projectsRouter.patch("/:id/roles/:roleId", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可管理角色" });

  const schema = z.object({
    name: z.string().min(1).max(50).optional(),
    base: z.enum(["CHIEF_EDITOR", "AGENT", "REVIEWER"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const target = await prisma.bookRole.findFirst({ where: { id: req.params.roleId, projectId: req.params.id } });
  if (!target) return res.status(404).json({ error: "角色不存在" });
  if (target.base === "AI_ASSISTANT") return res.status(400).json({ error: "AI 助手角色不可编辑" });

  try {
    await prisma.bookRole.update({ where: { id: target.id }, data: parsed.data });
    // 改能力原型时同步已分配成员的鉴权基线
    if (parsed.data.base) {
      await prisma.projectMember.updateMany({
        where: { bookRoleId: target.id },
        data: { role: parsed.data.base },
      });
    }
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "同名角色已存在" });
  }
});

// 删除角色（仅主编；不可删默认主编/AI，或仍有成员的角色）
projectsRouter.delete("/:id/roles/:roleId", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可管理角色" });

  const target = await prisma.bookRole.findFirst({
    where: { id: req.params.roleId, projectId: req.params.id },
    include: { _count: { select: { members: true } } },
  });
  if (!target) return res.status(404).json({ error: "角色不存在" });
  if (target.base === "AI_ASSISTANT" || (target.base === "CHIEF_EDITOR" && target.isDefault)) {
    return res.status(400).json({ error: "默认主编 / AI 角色不可删除" });
  }
  if (target._count.members > 0) return res.status(409).json({ error: "该角色仍有成员，请先调整成员角色" });

  await prisma.bookRole.delete({ where: { id: target.id } });
  res.json({ ok: true });
});

// ===== 本书专属 AI 配置（仅主编）=====

projectsRouter.get("/:id/ai-config", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可查看本书 AI 配置" });
  const config = await prisma.aiConfig.findFirst({ where: { projectId: req.params.id } });
  const global = await prisma.aiConfig.findFirst({ where: { projectId: null } });
  res.json({
    config: config ? sanitizeAiConfig(config) : null,
    global: global ? sanitizeAiConfig(global) : null,
    providers: AI_PROVIDERS,
  });
});

projectsRouter.put("/:id/ai-config", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可配置本书 AI" });

  const schema = z.object({
    provider: z.enum(["AUTO", "OPENAI", "GLM", "DEEPSEEK", "ANTHROPIC"]),
    model: z.string().max(100).optional(),
    apiKey: z.string().max(500).optional(),
    baseUrl: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await prisma.aiConfig.findFirst({ where: { projectId: req.params.id } });
  const apiKey = !parsed.data.apiKey ? existing?.apiKey ?? "" : parsed.data.apiKey;
  const data = {
    provider: parsed.data.provider,
    model: parsed.data.model ?? "",
    apiKey,
    baseUrl: parsed.data.baseUrl ?? "",
  };
  const config = existing
    ? await prisma.aiConfig.update({ where: { id: existing.id }, data })
    : await prisma.aiConfig.create({ data: { ...data, projectId: req.params.id } });
  res.json({ config: sanitizeAiConfig(config) });
});

// 清除本书 AI 配置（回退到全局默认）
projectsRouter.delete("/:id/ai-config", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可配置本书 AI" });
  await prisma.aiConfig.deleteMany({ where: { projectId: req.params.id } });
  res.json({ ok: true });
});

// 新建书稿章节（可选：上传 HTML / Markdown 解析为结构化内容）
projectsRouter.post("/:id/manuscripts", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });
  if (role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });

  const schema = z.object({
    title: z.string().min(1, "请填写章节标题").max(200),
    section: z.string().max(100).optional(),
    sourceType: z.enum(["text", "html", "md", "pdf"]).optional(),
    source: z.string().max(30_000_000).optional(), // pdf 为 base64
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // 解析上传内容
  let content = "";
  let docJson = "";
  if (parsed.data.source && parsed.data.sourceType === "html") {
    const r = parseHtml(parsed.data.source);
    content = r.text; docJson = JSON.stringify(r.doc);
  } else if (parsed.data.source && parsed.data.sourceType === "md") {
    const r = parseMarkdown(parsed.data.source);
    content = r.text; docJson = JSON.stringify(r.doc);
  } else if (parsed.data.source && parsed.data.sourceType === "pdf") {
    try {
      const buf = Buffer.from(parsed.data.source, "base64");
      const r = await parsePdf(new Uint8Array(buf));
      content = r.text; docJson = JSON.stringify(r.doc);
    } catch (err) {
      console.error("PDF parse failed:", err);
      return res.status(400).json({ error: "PDF 解析失败，请确认文件有效" });
    }
  } else if (parsed.data.source) {
    content = parsed.data.source;
  }

  const count = await prisma.manuscript.count({ where: { projectId: req.params.id } });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  const manuscript = await prisma.$transaction(async (tx) => {
    const m = await tx.manuscript.create({
      data: {
        projectId: req.params.id, title: parsed.data.title, section: parsed.data.section ?? "",
        order: count, status: content ? "IN_REVIEW" : "DRAFT", content, docJson,
      },
    });
    if (content) {
      await tx.revision.create({
        data: { manuscriptId: m.id, number: 1, authorId: req.userId!, authorRole: role, content, docJson, summary: "导入初稿" },
      });
    }
    return m;
  });
  await logActivity(req.params.id, me!.name, "新建书稿", parsed.data.title + (docJson ? "（导入解析）" : ""));
  res.json({ id: manuscript.id });
});

export function roleLabel(role: string) {
  return (
    { CHIEF_EDITOR: "主编", AGENT: "文学经纪人", REVIEWER: "审校员", AI_ASSISTANT: "AI 智能助手" } as Record<string, string>
  )[role] ?? role;
}
