// 多 LLM 供应商抽象：OpenAI / 智谱 GLM / DeepSeek 走 OpenAI 兼容接口，Anthropic 走官方 SDK。
// 配置优先级：书稿专属 → 全局默认 → 环境变量。
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import type { AiProvider } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../env.js";

// ===== 供应商元数据（供前端下拉选择；model 可自由编辑）=====
export const AI_PROVIDERS = [
  {
    key: "AUTO",
    label: "Auto（自动选择可用供应商）",
    defaultBaseUrl: "",
    models: [] as string[],
    envKey: "",
  },
  {
    key: "OPENAI",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"],
    envKey: "OPENAI_API_KEY",
  },
  {
    key: "GLM",
    label: "智谱 GLM",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["GLM5.2", "GLM-5-Turbo", "GLM-5V-Turbo", "glm-4.6", "glm-4-plus"],
    envKey: "GLM_API_KEY",
  },
  {
    key: "DEEPSEEK",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    envKey: "DEEPSEEK_API_KEY",
  },
  {
    key: "ANTHROPIC",
    label: "Anthropic Claude",
    defaultBaseUrl: "",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
    envKey: "ANTHROPIC_API_KEY",
  },
] as const;

type ProviderMeta = (typeof AI_PROVIDERS)[number];
function providerMeta(key: string): ProviderMeta {
  return AI_PROVIDERS.find((p) => p.key === key) ?? AI_PROVIDERS[0];
}

// 对外暴露配置时隐藏 apiKey 明文，只暴露「是否已配置」
export function sanitizeAiConfig(c: {
  provider: AiProvider; model: string; apiKey: string; baseUrl: string;
}) {
  return {
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    hasApiKey: Boolean(c.apiKey),
  };
}

// ===== 审校输出结构 =====
export const SuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      paragraphIndex: z.number().int().describe("问题所在段落的序号（从 0 开始）"),
      quote: z.string().describe("引用的原文片段（20 字以内）"),
      category: z.enum(["GRAMMAR", "WORDING", "LOGIC", "STANDARD", "STYLE"]),
      issue: z.string().describe("问题说明（简明扼要，中文）"),
      suggestedParagraph: z.string().describe("修改后的完整段落文本"),
    }),
  ),
});
export type Suggestion = z.infer<typeof SuggestionSchema>["suggestions"][number];

const SYSTEM_PROMPT = `你是一位资深的图书出版审校专家，负责对出版前的书稿进行专业审校。
你的职责：智能校对、语法纠错、用词优化、逻辑瑕疵检测和内容规范性检查。

审校要求：
- 逐段检查，发现真实存在的问题才提出，不无中生有
- 每条建议都要给出修改后的完整段落文本（suggestedParagraph 必须是整段替换文本，未改动部分原样保留）
- 意见要专业、具体、可执行，使用简体中文
- 最多返回 10 条最重要的建议，按重要性排序`;

// ===== 解析生效配置 =====
export interface ResolvedAi {
  provider: Exclude<AiProvider, "AUTO">;
  model: string;
  apiKey: string;
  baseUrl: string;
  source: "project" | "global" | "env";
}

function envKeyFor(provider: string): string {
  const meta = providerMeta(provider);
  return meta.envKey ? process.env[meta.envKey] || "" : "";
}

/** 把一条（可能是 AUTO 的）配置解析为具体可调用的供应商；无可用凭据返回 null */
function concretize(
  provider: AiProvider,
  model: string,
  apiKey: string,
  baseUrl: string,
  source: ResolvedAi["source"],
): ResolvedAi | null {
  if (provider === "AUTO") {
    // 依次尝试有凭据的供应商
    for (const p of ["ANTHROPIC", "OPENAI", "GLM", "DEEPSEEK"] as const) {
      const key = envKeyFor(p);
      if (key) {
        const meta = providerMeta(p);
        return { provider: p, model: model || meta.models[0] || "", apiKey: key, baseUrl: baseUrl || meta.defaultBaseUrl, source };
      }
    }
    return null;
  }
  const meta = providerMeta(provider);
  const key = apiKey || envKeyFor(provider);
  if (!key && provider !== "ANTHROPIC") return null; // Anthropic SDK 可从 env 自读
  const finalKey = key || envKeyFor("ANTHROPIC");
  if (!finalKey) return null;
  return {
    provider,
    model: model || meta.models[0] || "",
    apiKey: finalKey,
    baseUrl: baseUrl || meta.defaultBaseUrl,
    source,
  };
}

/** 优先级：书稿专属 → 全局默认 → 环境变量 */
export async function resolveAiConfig(projectId: string): Promise<ResolvedAi | null> {
  const project = await prisma.aiConfig.findFirst({ where: { projectId } });
  if (project) {
    const r = concretize(project.provider, project.model, project.apiKey, project.baseUrl, "project");
    if (r) return r;
  }
  const global = await prisma.aiConfig.findFirst({ where: { projectId: null } });
  if (global) {
    const r = concretize(global.provider, global.model, global.apiKey, global.baseUrl, "global");
    if (r) return r;
  }
  // 纯环境变量回退
  if (env.anthropicApiKey) {
    return { provider: "ANTHROPIC", model: env.aiModel, apiKey: env.anthropicApiKey, baseUrl: "", source: "env" };
  }
  return concretize("AUTO", "", "", "", "env");
}

// ===== 执行审校 =====
// agentPrompt 非空时，用该智能体的专属指令替代默认系统提示词（仍附加修订标准与结构化输出要求）
export async function runReview(
  cfg: ResolvedAi,
  paragraphs: string[],
  standards: string,
  agentPrompt = "",
): Promise<Suggestion[]> {
  const standardsBlock = standards.trim()
    ? `\n\n本项目主编制定的修订标准（审校时须遵循）：\n${standards}`
    : "";
  const base = agentPrompt.trim()
    ? `${agentPrompt.trim()}\n\n审校要求：逐段检查，只报告确实存在的问题；每条给出修改后的完整段落文本（suggestedParagraph 为整段替换文本）；使用简体中文；最多返回 10 条最重要的建议。`
    : SYSTEM_PROMPT;
  const system = base + standardsBlock;
  const numbered = paragraphs.map((p, i) => `【第 ${i} 段】\n${p}`).join("\n\n");
  const userMsg = `请审校以下书稿内容，段落序号已标注：\n\n${numbered}`;

  if (cfg.provider === "ANTHROPIC") {
    return reviewWithAnthropic(cfg, system, userMsg);
  }
  return reviewWithOpenAICompatible(cfg, system, userMsg);
}

async function reviewWithAnthropic(cfg: ResolvedAi, system: string, userMsg: string): Promise<Suggestion[]> {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const response = await client.messages.parse({
    model: cfg.model || "claude-sonnet-5",
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: userMsg }],
    output_config: { format: zodOutputFormat(SuggestionSchema) },
  });
  if (response.stop_reason === "refusal") throw new Error("AI 拒绝处理该内容");
  const parsed = response.parsed_output as z.infer<typeof SuggestionSchema> | null;
  if (!parsed) throw new Error("AI 返回结果解析失败");
  return parsed.suggestions;
}

// OpenAI 兼容：OpenAI / GLM / DeepSeek 共用 chat/completions + JSON 输出
async function reviewWithOpenAICompatible(cfg: ResolvedAi, system: string, userMsg: string): Promise<Suggestion[]> {
  const schemaHint = `请仅输出 JSON，格式为：{"suggestions":[{"paragraphIndex":number,"quote":string,"category":"GRAMMAR"|"WORDING"|"LOGIC"|"STANDARD"|"STYLE","issue":string,"suggestedParagraph":string}]}`;
  const base = cfg.baseUrl.replace(/\/$/, "");
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system + "\n\n" + schemaHint },
        { role: "user", content: userMsg },
      ],
      temperature: 0.3,
      max_tokens: 8000,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`供应商返回 ${resp.status}：${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseLenientJson(content);
  if (parsed === null) throw new Error("AI 返回结果解析失败（非 JSON）");
  const result = SuggestionSchema.safeParse(parsed);
  if (!result.success) {
    // 容错：部分模型可能直接返回数组
    const arr = z.array(SuggestionSchema.shape.suggestions.element).safeParse(parsed);
    if (arr.success) return arr.data;
    throw new Error("AI 返回结构不符合预期");
  }
  return result.data.suggestions;
}

// ===== 通用纯文本补全（供应商无关）=====
export async function runText(cfg: ResolvedAi, system: string, user: string, maxTokens = 4000): Promise<string> {
  if (cfg.provider === "ANTHROPIC") {
    const client = new Anthropic({ apiKey: cfg.apiKey });
    const resp = await client.messages.create({
      model: cfg.model || "claude-sonnet-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = resp.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : "";
  }
  const base = cfg.baseUrl.replace(/\/$/, "");
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`供应商返回 ${resp.status}：${t.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

// ===== 按审阅意见改写单段文本（AI 辅助采纳）=====
export async function runRewrite(cfg: ResolvedAi, original: string, opinion: string, standards: string): Promise<string> {
  const standardsBlock = standards.trim() ? `\n\n须遵循的修订标准：\n${standards}` : "";
  const system = `你是资深图书审校编辑。请根据给定的审阅意见改写这段文本。要求：只输出改写后的完整文本，不要解释、不要加引号或标注。保持原文风格与未涉及部分不变，仅针对意见所指问题修改。${standardsBlock}`;
  return runText(cfg, system, `【审阅意见】\n${opinion}\n\n【原文】\n${original}`);
}

// ===== 优化一条审阅意见的表达 =====
export async function runOptimizeComment(cfg: ResolvedAi, text: string): Promise<string> {
  const system = `你是资深图书审校编辑。请优化下面这条审阅意见的表达，使其更专业、准确、简练、可执行。只输出优化后的意见文字本身，不要解释、不要加引号。`;
  return runText(cfg, system, text, 1000);
}

// ===== 在一章中查找与给定意见同类的问题，返回结构化建议 =====
export async function runScanIssue(cfg: ResolvedAi, paragraphs: string[], opinion: string, standards: string): Promise<Suggestion[]> {
  const standardsBlock = standards.trim() ? `\n\n本项目修订标准：\n${standards}` : "";
  const schemaHint = `请仅输出 JSON：{"suggestions":[{"paragraphIndex":number,"quote":string,"category":"GRAMMAR"|"WORDING"|"LOGIC"|"STANDARD"|"STYLE","issue":string,"suggestedParagraph":string}]}。若本章没有同类问题，返回 {"suggestions":[]}。`;
  const system = `你是资深图书审校专家。下面给出一条在其他章节发现的问题意见，请在本章内查找**同类**问题（相同性质，不必字面相同），逐段核对，只报告确实存在的同类问题，最多 8 条。${standardsBlock}\n\n${schemaHint}`;
  const numbered = paragraphs.map((p, i) => `【第 ${i} 段】\n${p}`).join("\n\n");
  const user = `【需要在本章排查的同类问题】\n${opinion}\n\n【本章内容】\n${numbered}`;
  const content = await runText(cfg, system, user, 8000);
  const parsed = parseLenientJson(content);
  if (!parsed) return [];
  const result = SuggestionSchema.safeParse(parsed);
  if (result.success) return result.data.suggestions;
  const arr = z.array(SuggestionSchema.shape.suggestions.element).safeParse(parsed);
  return arr.success ? arr.data : [];
}

// ===== AI 读稿，推荐为本书量身定制的审校智能体 =====
export const AgentSuggestionSchema = z.object({
  agents: z.array(
    z.object({
      name: z.string().describe("智能体名称（简短，体现其专长）"),
      role: z.string().describe("一句话角色定位"),
      systemPrompt: z.string().describe("该智能体的审校指令（详细，作为其“技能”，指导它以何种视角、查什么、按什么标准审校本书）"),
      category: z.enum(["GENERAL", "GRAMMAR", "WORDING", "LOGIC", "STYLE", "MARKET", "STANDARD"]).describe("该智能体意见的主要归类"),
    }),
  ),
});
export type AgentSuggestion = z.infer<typeof AgentSuggestionSchema>["agents"][number];

export async function runSuggestAgents(cfg: ResolvedAi, bookTitle: string, digest: string): Promise<AgentSuggestion[]> {
  const system = `你是资深图书出版策划与审校总编。请阅读给定书稿的概要与样章，判断这本书的**体裁、题材、读者对象与专业领域**，然后为它设计一支「AI 审校智能体团队」。
每个智能体针对本书的特点承担一类专门审校职责（例如：一部道教宫观财务书可能需要「会计准则合规」「宗教政策合规」「财务术语一致性」「表格数据准确性」「制度可操作性」等智能体；一部小说则可能需要「情节一致性」「人物弧光」「语言风格/去 AI 腔」「节奏与爽点」等）。
为每个智能体给出：name（名称）、role（一句话定位）、systemPrompt（详细的审校指令，作为它的“技能”，写明它以什么视角、重点查什么、依据什么标准），以及 category（意见归类）。
设计 4-6 个互补、不重复、真正贴合本书的智能体。只输出 JSON：{"agents":[{"name":string,"role":string,"systemPrompt":string,"category":"GENERAL"|"GRAMMAR"|"WORDING"|"LOGIC"|"STYLE"|"MARKET"|"STANDARD"}]}`;
  const user = `【书名】${bookTitle}\n\n【书稿概要与样章】\n${digest}`;
  const content = await runText(cfg, system, user, 6000);
  const parsed = parseLenientJson(content);
  if (!parsed) throw new Error("AI 返回结果解析失败");
  const result = AgentSuggestionSchema.safeParse(parsed);
  if (result.success) return result.data.agents;
  const arr = z.array(AgentSuggestionSchema.shape.agents.element).safeParse(parsed);
  if (arr.success) return arr.data;
  throw new Error("AI 返回结构不符合预期");
}

// 宽松解析 LLM 返回的 JSON：先直接解析，失败则用 jsonrepair 修复（未转义引号/换行/尾逗号等）
function parseLenientJson(content: string): unknown | null {
  const text = extractJson(content);
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(jsonrepair(text));
    } catch {
      return null;
    }
  }
}

// 从可能带 ```json 包裹的文本中提取 JSON 主体
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.search(/[[{]/);
  return start >= 0 ? text.slice(start).trim() : text.trim();
}
