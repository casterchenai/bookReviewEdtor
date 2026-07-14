import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { logActivity, memberRole, requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { resolveAiConfig, runReview, type Suggestion } from "../lib/ai-providers.js";

export const aiRouter = Router();
aiRouter.use(requireAuth);

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
