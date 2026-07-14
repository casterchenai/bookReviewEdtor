import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { logActivity, memberRole, requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { resolveAiConfig, runReview, runRewrite, type Suggestion } from "../lib/ai-providers.js";
import { normalizeDoc, blockText, type Block } from "../lib/content.js";

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

  const paragraphs = manuscript.content.split(/\n\n/);
  const cfg = await resolveAiConfig(manuscript.projectId);

  let suggestions: Suggestion[];
  let engine: string;

  if (cfg) {
    try {
      suggestions = await runReview(cfg, paragraphs, manuscript.project.standards);
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

  const created = await prisma.$transaction(
    suggestions
      .filter((s) => s.paragraphIndex >= 0 && s.paragraphIndex < paragraphs.length)
      .map((s) =>
        prisma.comment.create({
          data: {
            manuscriptId: manuscript.id,
            authorId: aiUser.id,
            authorRole: "AI_ASSISTANT",
            paragraphIndex: s.paragraphIndex,
            quote: s.quote.slice(0, 200),
            body: s.issue,
            category: s.category,
            suggestedText: s.suggestedParagraph,
          },
          include: { author: { select: { name: true, isAI: true } } },
        }),
      ),
  );

  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "发起 AI 审校", `${engine} · 生成 ${created.length} 条建议`);
  res.json({ engine, count: created.length, comments: created });
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
