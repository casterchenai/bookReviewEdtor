import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { prisma } from "../db.js";
import { logActivity, memberRole, requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const aiRouter = Router();
aiRouter.use(requireAuth);

// AI 审校结果的结构化输出模式
const SuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      paragraphIndex: z.number().int().describe("问题所在段落的序号（从 0 开始）"),
      quote: z.string().describe("引用的原文片段（20 字以内）"),
      category: z.enum(["GRAMMAR", "WORDING", "LOGIC", "STANDARD", "STYLE"])
        .describe("问题类型：GRAMMAR 语法错误 / WORDING 用词不当 / LOGIC 逻辑瑕疵 / STANDARD 内容规范 / STYLE 表达风格"),
      issue: z.string().describe("问题说明（简明扼要，中文）"),
      suggestedParagraph: z.string()
        .describe("修改后的完整段落文本（保留原段落未改动的部分，仅修正问题处）"),
    }),
  ),
});

const SYSTEM_PROMPT = `你是一位资深的图书出版审校专家，负责对出版前的书稿进行专业审校。
你的职责：智能校对、语法纠错、用词优化、逻辑瑕疵检测和内容规范性检查。

审校要求：
- 逐段检查，发现真实存在的问题才提出，不无中生有
- 每条建议都要给出修改后的完整段落文本（suggestedParagraph 必须是整段替换文本，未改动部分原样保留）
- 意见要专业、具体、可执行，使用简体中文
- 最多返回 10 条最重要的建议，按重要性排序`;

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
  let suggestions: z.infer<typeof SuggestionSchema>["suggestions"];
  let engine: "claude" | "stub";

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      suggestions = await reviewWithClaude(paragraphs, manuscript.project.standards);
      engine = "claude";
    } catch (err) {
      const message = err instanceof Anthropic.APIError ? `AI 服务错误（${err.status}）` : "AI 服务暂时不可用";
      console.error("AI review failed:", err);
      return res.status(502).json({ error: `${message}，请稍后重试` });
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
  await logActivity(manuscript.projectId, me!.name, "发起 AI 审校", `生成 ${created.length} 条建议`);
  res.json({ engine, count: created.length, comments: created });
});

async function reviewWithClaude(paragraphs: string[], standards: string) {
  const client = new Anthropic();
  const numbered = paragraphs.map((p, i) => `【第 ${i} 段】\n${p}`).join("\n\n");
  const standardsBlock = standards.trim()
    ? `\n\n本项目主编制定的修订标准（审校时须遵循）：\n${standards}`
    : "";

  const response = await client.messages.parse({
    model: process.env.AI_MODEL || "claude-sonnet-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT + standardsBlock,
    messages: [
      {
        role: "user",
        content: `请审校以下书稿内容，段落序号已标注：\n\n${numbered}`,
      },
    ],
    output_config: { format: zodOutputFormat(SuggestionSchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("AI 拒绝处理该内容");
  }
  const parsed = response.parsed_output as z.infer<typeof SuggestionSchema> | null;
  if (!parsed) throw new Error("AI 返回结果解析失败");
  return parsed.suggestions;
}

// 未配置 API Key 时的演示建议（便于离线体验完整流程）
function stubReview(paragraphs: string[]) {
  const targets = paragraphs
    .map((text, index) => ({ text, index }))
    .filter((p) => p.text.trim().length > 20)
    .slice(0, 3);
  return targets.map(({ text, index }) => ({
    paragraphIndex: index,
    quote: text.slice(0, 18),
    category: "WORDING" as const,
    issue:
      "【演示建议】未配置 ANTHROPIC_API_KEY，当前为演示模式。配置密钥后，AI 将对本段进行真实的语法纠错、用词优化与逻辑检测。",
    suggestedParagraph: text,
  }));
}
