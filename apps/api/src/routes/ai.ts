import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { logActivity, memberRole, requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { resolveAiConfig, runReview, runRewrite, runOptimizeComment, runScanIssue, runSuggestAgents, type Suggestion } from "../lib/ai-providers.js";
import { normalizeDoc, blockText, type Block } from "../lib/content.js";
import { referencesDigest } from "../lib/references.js";

// 取本书参考文献汇总文本（供审校/设计智能体核对）
async function bookReferences(projectId: string, limit = 8000): Promise<string> {
  const refs = await prisma.reference.findMany({
    where: { projectId }, orderBy: { createdAt: "asc" },
    select: { name: true, kind: true, textContent: true },
  });
  return referencesDigest(refs, limit);
}

export const aiRouter = Router();
aiRouter.use(requireAuth);

// 根据一条审阅意见，用 AI 改写对应块/段落，写入该意见的「修改建议」供采纳
aiRouter.post("/manuscripts/:id/comments/:commentId/revise", async (req: AuthedRequest, res) => {
  const manuscript = await prisma.manuscript.findUnique({
    where: { id: req.params.id },
    include: { project: { select: { standards: true } } },
  });
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  const role = await memberRole(manuscript.projectId, req.userId!);
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });
  if (manuscript.status === "FINALIZED") return res.status(409).json({ error: "已定稿书稿不可修改" });

  const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
  if (!comment || comment.manuscriptId !== manuscript.id) return res.status(404).json({ error: "意见不存在" });

  // 取目标块/段落原文
  let original = "";
  if (manuscript.docJson) {
    const doc = normalizeDoc(JSON.parse(manuscript.docJson));
    if (doc && comment.paragraphIndex < doc.blocks.length) original = blockText(doc.blocks[comment.paragraphIndex] as Block);
  } else {
    original = manuscript.content.split(/\n\n/)[comment.paragraphIndex] ?? "";
  }
  if (!original.trim()) return res.status(400).json({ error: "定位不到原文，请手动编辑" });

  const cfg = await resolveAiConfig(manuscript.projectId);
  if (!cfg) return res.status(400).json({ error: "未配置任何 AI 供应商，无法自动改写" });

  let revised: string;
  try {
    revised = await runRewrite(cfg, original, comment.body, manuscript.project.standards);
  } catch (err) {
    console.error("AI rewrite failed:", err);
    return res.status(502).json({ error: `AI 改写失败：${err instanceof Error ? err.message : "服务不可用"}` });
  }
  if (!revised) return res.status(502).json({ error: "AI 未返回有效改写" });

  const updated = await prisma.comment.update({
    where: { id: comment.id },
    data: { suggestedText: revised },
    include: { author: { select: { name: true, isAI: true } } },
  });
  res.json({ comment: updated });
});

async function ensureEditor(manuscriptId: string, userId: string) {
  const manuscript = await prisma.manuscript.findUnique({
    where: { id: manuscriptId },
    include: { project: { select: { id: true, standards: true } } },
  });
  if (!manuscript) return { ok: false as const, status: 404, msg: "书稿不存在" };
  const role = await memberRole(manuscript.projectId, userId);
  if (!role || role === "AI_ASSISTANT") return { ok: false as const, status: 403, msg: "无权限" };
  return { ok: true as const, manuscript, role };
}

// 优化一条审阅意见的文字表达（就地返回，不落库）
aiRouter.post("/manuscripts/:id/optimize", async (req: AuthedRequest, res) => {
  const ctx = await ensureEditor(req.params.id, req.userId!);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.msg });
  const parsed = z.object({ text: z.string().min(1).max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "请提供待优化的意见文字" });
  const cfg = await resolveAiConfig(ctx.manuscript.projectId);
  if (!cfg) return res.status(400).json({ error: "未配置任何 AI 供应商" });
  try {
    const text = await runOptimizeComment(cfg, parsed.data.text);
    res.json({ text: text || parsed.data.text });
  } catch (err) {
    res.status(502).json({ error: `AI 优化失败：${err instanceof Error ? err.message : "服务不可用"}` });
  }
});

// 根据意见为某段/块生成修改后的文本（就地返回，不落库；供「附带修改建议」使用）
aiRouter.post("/manuscripts/:id/suggest", async (req: AuthedRequest, res) => {
  const ctx = await ensureEditor(req.params.id, req.userId!);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.msg });
  const parsed = z.object({ paragraphIndex: z.number().int().min(0), opinion: z.string().min(1).max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "参数错误" });

  let original = "";
  if (ctx.manuscript.docJson) {
    const doc = normalizeDoc(JSON.parse(ctx.manuscript.docJson));
    if (doc && parsed.data.paragraphIndex < doc.blocks.length) original = blockText(doc.blocks[parsed.data.paragraphIndex] as Block);
  } else {
    original = ctx.manuscript.content.split(/\n\n/)[parsed.data.paragraphIndex] ?? "";
  }
  if (!original.trim()) return res.status(400).json({ error: "定位不到原文" });

  const cfg = await resolveAiConfig(ctx.manuscript.projectId);
  if (!cfg) return res.status(400).json({ error: "未配置任何 AI 供应商" });
  try {
    const suggestedText = await runRewrite(cfg, original, parsed.data.opinion, ctx.manuscript.project.standards);
    res.json({ suggestedText: suggestedText || original });
  } catch (err) {
    res.status(502).json({ error: `AI 生成失败：${err instanceof Error ? err.message : "服务不可用"}` });
  }
});

// 在本章排查与给定意见同类的问题，以当前用户身份写入审阅意见（供跨章节同类检查逐章调用）
aiRouter.post("/manuscripts/:id/scan-issue", async (req: AuthedRequest, res) => {
  const ctx = await ensureEditor(req.params.id, req.userId!);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.msg });
  const parsed = z.object({
    opinion: z.string().min(1).max(5000),
    category: z.enum(["GENERAL", "GRAMMAR", "WORDING", "LOGIC", "STYLE", "MARKET", "STANDARD"]).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "参数错误" });
  if (!ctx.manuscript.content.trim()) return res.json({ count: 0 });

  const cfg = await resolveAiConfig(ctx.manuscript.projectId);
  if (!cfg) return res.status(400).json({ error: "未配置任何 AI 供应商" });

  const paragraphs = ctx.manuscript.content.split(/\n\n/);
  let suggestions: Suggestion[];
  try {
    suggestions = await runScanIssue(cfg, paragraphs, parsed.data.opinion, ctx.manuscript.project.standards);
  } catch (err) {
    return res.status(502).json({ error: `AI 检查失败：${err instanceof Error ? err.message : "服务不可用"}` });
  }

  const created = await prisma.$transaction(
    suggestions
      .filter((s) => s.paragraphIndex >= 0 && s.paragraphIndex < paragraphs.length)
      .map((s) =>
        prisma.comment.create({
          data: {
            manuscriptId: ctx.manuscript.id,
            authorId: req.userId!,
            authorRole: ctx.role,
            paragraphIndex: s.paragraphIndex,
            quote: s.quote.slice(0, 200),
            body: s.issue,
            category: parsed.data.category ?? s.category,
            suggestedText: s.suggestedParagraph,
          },
        }),
      ),
  );
  res.json({ count: created.length });
});

// 对书稿执行 AI 智能审校，结果以「AI 智能助手」身份写入审阅意见
aiRouter.post("/manuscripts/:id/review", async (req: AuthedRequest, res) => {
  const manuscript = await prisma.manuscript.findUnique({
    where: { id: req.params.id },
    include: { project: { select: { id: true, standards: true } } },
  });
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  const role = await memberRole(manuscript.projectId, req.userId!);
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });
  if (!manuscript.content.trim()) return res.status(400).json({ error: "书稿内容为空，无法审校" });

  const aiUser = await prisma.user.findFirst({ where: { isAI: true } });
  if (!aiUser) return res.status(500).json({ error: "系统未初始化 AI 助手账户，请先运行数据种子" });

  // 可选：指定某个智能体审校（用它的专属指令 + 归属）
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : "";
  const agent = agentId ? await prisma.aiAgent.findFirst({ where: { id: agentId, projectId: manuscript.projectId } }) : null;
  if (agentId && !agent) return res.status(404).json({ error: "智能体不存在" });

  const paragraphs = manuscript.content.split(/\n\n/);
  const cfg = await resolveAiConfig(manuscript.projectId);

  let suggestions: Suggestion[];
  let engine: string;

  if (cfg) {
    try {
      const refs = await bookReferences(manuscript.projectId);
      suggestions = await runReview(cfg, paragraphs, manuscript.project.standards, agent?.systemPrompt ?? "", refs);
      engine = `${cfg.provider.toLowerCase()}:${cfg.model}`;
    } catch (err) {
      console.error("AI review failed:", err);
      const message = err instanceof Error ? err.message : "AI 服务暂时不可用";
      return res.status(502).json({ error: `AI 审校失败：${message}` });
    }
  } else {
    suggestions = stubReview(paragraphs);
    engine = "stub";
  }

  // 跳过已有同来源（同智能体 / 默认 AI）未处理意见的段落，避免重复审校
  const already = await prisma.comment.findMany({
    where: { manuscriptId: manuscript.id, authorId: aiUser.id, status: "OPEN", aiAgentName: agent?.name ?? null },
    select: { paragraphIndex: true },
  });
  const skipSet = new Set(already.map((c) => c.paragraphIndex));
  const toCreate = suggestions.filter((s) => s.paragraphIndex >= 0 && s.paragraphIndex < paragraphs.length && !skipSet.has(s.paragraphIndex));
  const skipped = suggestions.length - toCreate.length;

  const created = await prisma.$transaction(
    toCreate.map((s) =>
      prisma.comment.create({
        data: {
          manuscriptId: manuscript.id,
          authorId: aiUser.id,
          authorRole: "AI_ASSISTANT",
          paragraphIndex: s.paragraphIndex,
          quote: s.quote.slice(0, 200),
          body: s.issue,
          category: agent ? agent.category : s.category,
          suggestedText: s.suggestedParagraph,
          aiAgentName: agent?.name ?? null,
        },
        include: { author: { select: { name: true, isAI: true } } },
      }),
    ),
  );

  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "发起 AI 审校", `${agent ? agent.name + " · " : ""}${engine} · 生成 ${created.length} 条${skipped ? `（跳过 ${skipped} 段已审校）` : ""}`);
  res.json({ engine, agent: agent?.name ?? null, count: created.length, skipped, comments: created });
});

// AI 读稿，为本书推荐量身定制的审校智能体（不落库，返回候选供主编采纳）
aiRouter.post("/projects/:id/suggest-agents", async (req: AuthedRequest, res) => {
  const role = await memberRole(req.params.id, req.userId!);
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可生成智能体建议" });
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return res.status(404).json({ error: "项目不存在" });

  // 构造书稿摘要：章节标题清单 + 前若干章正文（截断）
  const chapters = await prisma.manuscript.findMany({
    where: { projectId: req.params.id }, orderBy: { order: "asc" },
    select: { title: true, section: true, content: true },
  });
  if (chapters.length === 0 || !chapters.some((c) => c.content.trim())) {
    return res.status(400).json({ error: "书稿内容为空，请先导入或撰写章节后再生成" });
  }
  const toc = chapters.map((c) => `${c.section ? c.section + " / " : ""}${c.title}`).join("\n");
  let sample = "";
  for (const c of chapters) {
    if (!c.content.trim()) continue;
    sample += `\n\n【${c.title}】\n${c.content.slice(0, 2500)}`;
    if (sample.length > 6000) break;
  }
  const refs = await bookReferences(req.params.id, 6000);
  const refBlock = refs ? `\n\n参考文献 / 资料（设计智能体时请一并考虑，让智能体能据此核对书稿）：\n${refs}` : "";
  const digest = `目录：\n${toc}\n\n样章：${sample}${refBlock}`.slice(0, 14000);

  const cfg = await resolveAiConfig(req.params.id);
  if (!cfg) return res.status(400).json({ error: "未配置任何 AI 供应商" });
  try {
    const agents = await runSuggestAgents(cfg, project.title, digest);
    res.json({ agents });
  } catch (err) {
    console.error("suggest-agents failed:", err);
    res.status(502).json({ error: `AI 生成失败：${err instanceof Error ? err.message : "服务不可用"}` });
  }
});

// 未配置任何供应商时的演示建议（便于离线体验完整流程）
function stubReview(paragraphs: string[]): Suggestion[] {
  const targets = paragraphs
    .map((text, index) => ({ text, index }))
    .filter((p) => p.text.trim().length > 20)
    .slice(0, 3);
  return targets.map(({ text, index }) => ({
    paragraphIndex: index,
    quote: text.slice(0, 18),
    category: "WORDING" as const,
    issue:
      "【演示建议】未配置任何 AI 供应商，当前为演示模式。在全局或本书 AI 配置中填写 OpenAI / GLM / DeepSeek / Anthropic 的密钥后，将进行真实审校。",
    suggestedParagraph: text,
  }));
}
