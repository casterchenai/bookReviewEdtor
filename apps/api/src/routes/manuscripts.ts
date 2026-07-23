import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { logActivity, memberRole, requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { roleLabel } from "./projects.js";
import {
  blocksToText, normalizeDoc, setBlockText, type Block, type Mark,
  blocksToMarkdown, blocksToHtml, textToMarkdown, textToHtml,
} from "../lib/content.js";
import { isOcrAvailable, ocrPageBlocks } from "../lib/ocr.js";
import { manuscriptToDocx, reviewReportDocx } from "../lib/docx.js";
import { buildReport, reviewReportHtml, type ReportComment } from "../lib/report.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// 将书稿渲染为 Markdown / HTML（有块用块，否则用纯文本投影）
export function renderManuscript(m: { title: string; content: string; docJson: string }, format: "md" | "html"): string {
  const doc = m.docJson ? normalizeDoc(JSON.parse(m.docJson)) : null;
  if (format === "md") {
    const body = doc ? blocksToMarkdown(doc.blocks) : textToMarkdown(m.content);
    return `# ${m.title}\n\n${body}`;
  }
  return doc ? blocksToHtml(doc.blocks, m.title) : textToHtml(m.content, m.title);
}

function contentType(format: string) {
  return format === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8";
}

export const manuscriptsRouter = Router();
manuscriptsRouter.use(requireAuth);

async function loadWithRole(manuscriptId: string, userId: string) {
  const manuscript = await prisma.manuscript.findUnique({
    where: { id: manuscriptId },
    include: { project: { select: { id: true, title: true, standards: true } } },
  });
  if (!manuscript) return { manuscript: null, role: null } as const;
  const role = await memberRole(manuscript.projectId, userId);
  return { manuscript, role } as const;
}

// 书稿详情（含意见与修订元数据）
manuscriptsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });

  const [comments, revisions] = await Promise.all([
    prisma.comment.findMany({
      where: { manuscriptId: manuscript.id },
      include: { author: { select: { name: true, isAI: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.revision.findMany({
      where: { manuscriptId: manuscript.id },
      select: {
        id: true, number: true, summary: true, createdAt: true, authorRole: true,
        author: { select: { name: true, isAI: true } },
      },
      orderBy: { number: "desc" },
    }),
  ]);
  res.json({ ...manuscript, comments, revisions, myRole: role });
});

// 修改书稿标题（仅主编，用于批量统一章节名称）
manuscriptsRouter.patch("/:id/title", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可修改标题" });

  const schema = z.object({ title: z.string().min(1, "标题不能为空").max(200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (parsed.data.title === manuscript.title) return res.status(400).json({ error: "标题没有变化" });

  await prisma.manuscript.update({ where: { id: manuscript.id }, data: { title: parsed.data.title } });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "修改标题", `${manuscript.title} → ${parsed.data.title}`);
  res.json({ ok: true, title: parsed.data.title });
});

// 删除章节（仅主编）：连同其修订与意见一并删除，并重排剩余章节顺序
manuscriptsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可删除章节" });

  await prisma.manuscript.delete({ where: { id: manuscript.id } }); // 修订/意见按级联删除
  const rest = await prisma.manuscript.findMany({
    where: { projectId: manuscript.projectId }, orderBy: { order: "asc" }, select: { id: true },
  });
  await prisma.$transaction(rest.map((m, i) => prisma.manuscript.update({ where: { id: m.id }, data: { order: i } })));

  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "删除章节", manuscript.title);
  res.json({ ok: true });
});

// 导出单章为 Markdown / HTML / Word(docx)
manuscriptsRouter.get("/:id/export", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });

  if (req.query.format === "docx") {
    const blocks = manuscript.docJson ? normalizeDoc(JSON.parse(manuscript.docJson))?.blocks ?? null : null;
    const buf = await manuscriptToDocx(manuscript, blocks);
    res.setHeader("Content-Type", DOCX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(manuscript.title)}.docx`);
    return res.send(buf);
  }
  const format = req.query.format === "html" ? "html" : "md";
  const out = renderManuscript(manuscript, format);
  res.setHeader("Content-Type", contentType(format));
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(manuscript.title)}.${format}`);
  res.send(out);
});

// 导出审校报告（按页/段汇总意见，供排版设计师据此修改 PDF）
manuscriptsRouter.get("/:id/report", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });

  const raw = await prisma.comment.findMany({
    where: { manuscriptId: manuscript.id },
    include: { author: { select: { name: true } } },
    orderBy: { paragraphIndex: "asc" },
  });
  const comments: ReportComment[] = raw.map((c) => ({
    paragraphIndex: c.paragraphIndex,
    quote: c.quote,
    body: c.body,
    category: c.category,
    suggestedText: c.suggestedText,
    aiAgentName: c.aiAgentName,
    authorRole: c.authorRole,
    authorName: c.author.name,
    status: c.status,
  }));
  const blocks = manuscript.docJson ? normalizeDoc(JSON.parse(manuscript.docJson))?.blocks ?? null : null;
  const name = `${manuscript.title}-审校报告`;

  if (req.query.format === "docx") {
    const buf = await reviewReportDocx(manuscript.title, blocks, comments, roleLabel);
    res.setHeader("Content-Type", DOCX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}.docx`);
    return res.send(buf);
  }
  if (req.query.format === "json") {
    return res.json({ title: manuscript.title, groups: buildReport(blocks, comments) });
  }
  const html = reviewReportHtml(manuscript.title, buildReport(blocks, comments), roleLabel);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const inline = req.query.inline === "1";
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}.html`);
  res.send(html);
});

// 页面文字识别（OCR）：识别页面图片中的文字，隐藏存入该页 ocr 字段。
// 不改动图片、不新建修订版本；仅刷新纯文本投影，使 AI 审校与搜索能读到图中文字。
// body: { blockIndex?: number（只识别该页，省略则整章）, force?: boolean（重识别已有结果）}
manuscriptsRouter.post("/:id/ocr", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });
  if (!(await isOcrAvailable())) return res.status(503).json({ error: "服务器未安装文字识别组件（tesseract），请联系管理员" });

  const schema = z.object({ blockIndex: z.number().int().min(0).optional(), force: z.boolean().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const doc = manuscript.docJson ? normalizeDoc(JSON.parse(manuscript.docJson)) : null;
  if (!doc) return res.status(400).json({ error: "该书稿没有可识别的页面" });

  const { blocks, updated, scanned } = await ocrPageBlocks(doc.blocks, parsed.data);
  if (!scanned) return res.status(400).json({ error: "该书稿没有可识别的页面图片" });
  if (updated > 0) {
    const content = blocksToText(blocks);
    await prisma.manuscript.update({
      where: { id: manuscript.id },
      data: { docJson: JSON.stringify({ blocks }), content },
    });
    const me = await prisma.user.findUnique({ where: { id: req.userId! } });
    await logActivity(manuscript.projectId, me!.name, "文字识别", `${manuscript.title}：识别 ${updated} 页`);
  }
  res.json({ updated, scanned });
});

const markSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rect"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), color: z.string().max(24), by: z.string().max(60).optional() }),
  z.object({ kind: z.literal("pen"), pts: z.array(z.number()).max(6000), color: z.string().max(24), by: z.string().max(60).optional() }),
  z.object({ kind: z.literal("text"), x: z.number(), y: z.number(), text: z.string().max(500), color: z.string().max(24), by: z.string().max(60).optional() }),
]);

// 页面批注：就地更新某个块的 marks（画框/涂鸦/文字），全员可见。
// 批注属于评审标记而非正文改动，因此不新建修订版本。
manuscriptsRouter.patch("/:id/blocks/:index/marks", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: "块序号无效" });

  const parsed = z.object({ marks: z.array(markSchema).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const doc = manuscript.docJson ? normalizeDoc(JSON.parse(manuscript.docJson)) : null;
  if (!doc || !doc.blocks[index]) return res.status(404).json({ error: "该内容块不存在" });
  const target = doc.blocks[index];
  if (target.type !== "image") return res.status(400).json({ error: "只能在图片/页面块上批注" });

  const blocks = doc.blocks.slice();
  blocks[index] = { ...target, marks: parsed.data.marks as Mark[] };
  await prisma.manuscript.update({
    where: { id: manuscript.id },
    data: { docJson: JSON.stringify({ blocks }), content: blocksToText(blocks) },
  });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "页面批注", `${manuscript.title}：${target.alt || `第 ${index + 1} 块`}（${parsed.data.marks.length} 处）`);
  res.json({ ok: true, marks: parsed.data.marks.length });
});

// 保存内容 → 生成新修订版本
manuscriptsRouter.put("/:id/content", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });
  if (manuscript.status === "FINALIZED") {
    return res.status(409).json({ error: "该书稿已定稿锁定，如需修改请先由主编解除定稿" });
  }

  const schema = z.object({
    content: z.string().max(5_000_000).optional(),
    docJson: z.unknown().optional(), // 富内容：{ blocks: Block[] }
    summary: z.string().min(1, "请填写修订说明，便于追溯").max(500),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // 富内容：以块为准，重算纯文本投影
  const doc = parsed.data.docJson !== undefined ? normalizeDoc(parsed.data.docJson) : null;
  let content: string;
  let docJson: string;
  if (doc) {
    content = blocksToText(doc.blocks);
    docJson = JSON.stringify(doc);
    if (docJson === manuscript.docJson) return res.status(400).json({ error: "内容没有变化" });
  } else {
    content = parsed.data.content ?? "";
    docJson = ""; // 纯文本模式
    if (content === manuscript.content) return res.status(400).json({ error: "内容没有变化" });
  }

  const revision = await createRevision(manuscript.id, req.userId!, role, content, parsed.data.summary, docJson);
  res.json({ ok: true, revisionNumber: revision.number });
});

/** 写入新版本：更新快照 + 追加修订记录（事务保证一致） */
export async function createRevision(
  manuscriptId: string,
  authorId: string,
  authorRole: "CHIEF_EDITOR" | "AGENT" | "REVIEWER" | "AI_ASSISTANT",
  content: string,
  summary: string,
  docJson = "",
) {
  return prisma.$transaction(async (tx) => {
    const last = await tx.revision.findFirst({
      where: { manuscriptId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const revision = await tx.revision.create({
      data: { manuscriptId, authorId, authorRole, content, docJson, summary, number: (last?.number ?? 0) + 1 },
    });
    await tx.manuscript.update({
      where: { id: manuscriptId },
      data: { content, docJson, status: "IN_REVIEW" },
    });
    return revision;
  });
}

// 修订版本全文（用于对比）
manuscriptsRouter.get("/:id/revisions/:number", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role) return res.status(403).json({ error: "您不是该项目成员" });

  const revision = await prisma.revision.findUnique({
    where: { manuscriptId_number: { manuscriptId: manuscript.id, number: Number(req.params.number) } },
    include: { author: { select: { name: true } } },
  });
  if (!revision) return res.status(404).json({ error: "版本不存在" });
  res.json(revision);
});

// 回滚到历史版本（生成新版本，不删除历史）
manuscriptsRouter.post("/:id/rollback", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可回滚版本" });
  if (manuscript.status === "FINALIZED") return res.status(409).json({ error: "已定稿书稿不可回滚" });

  const schema = z.object({ number: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "参数错误" });

  const target = await prisma.revision.findUnique({
    where: { manuscriptId_number: { manuscriptId: manuscript.id, number: parsed.data.number } },
  });
  if (!target) return res.status(404).json({ error: "版本不存在" });

  const revision = await createRevision(
    manuscript.id, req.userId!, role, target.content, `回滚至第 ${target.number} 版`, target.docJson,
  );
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "回滚版本", `《${manuscript.title}》→ 第 ${target.number} 版`);
  res.json({ ok: true, revisionNumber: revision.number });
});

// 定稿 / 解除定稿（仅主编）
manuscriptsRouter.post("/:id/finalize", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可定稿" });

  const finalize = req.body?.finalize !== false;
  await prisma.manuscript.update({
    where: { id: manuscript.id },
    data: { status: finalize ? "FINALIZED" : "IN_REVIEW" },
  });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, finalize ? "定稿" : "解除定稿", `《${manuscript.title}》`);
  res.json({ ok: true });
});

// 清除本章所有 AI 审校意见（便于清理后重新审校）
manuscriptsRouter.delete("/:id/ai-comments", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });

  const del = await prisma.comment.deleteMany({
    where: { manuscriptId: manuscript.id, author: { isAI: true } },
  });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "清除 AI 审校意见", `《${manuscript.title}》${del.count} 条`);
  res.json({ ok: true, count: del.count });
});

// 全部采纳：一次性采纳所有含建议的待处理意见，合并生成一个新版本
manuscriptsRouter.post("/:id/accept-all", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (role !== "CHIEF_EDITOR") return res.status(403).json({ error: "仅主编可采纳修改建议" });
  if (manuscript.status === "FINALIZED") return res.status(409).json({ error: "已定稿书稿不可修改" });

  const schema = z.object({ summary: z.string().max(500).optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "参数错误" });

  // 待采纳：含建议、待处理，按段落顺序 + 提交时间应用（同段后者覆盖前者）
  const pending = await prisma.comment.findMany({
    where: { manuscriptId: manuscript.id, status: "OPEN", suggestedText: { not: null } },
    orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
  });
  if (pending.length === 0) return res.status(400).json({ error: "没有可采纳的修改建议" });

  // 应用到内容
  let content: string;
  let docJson = "";
  if (manuscript.docJson) {
    const doc = normalizeDoc(JSON.parse(manuscript.docJson));
    if (!doc) return res.status(500).json({ error: "内容解析失败" });
    for (const c of pending) {
      if (c.paragraphIndex < doc.blocks.length && c.suggestedText != null) {
        doc.blocks[c.paragraphIndex] = setBlockText(doc.blocks[c.paragraphIndex] as Block, c.suggestedText);
      }
    }
    content = blocksToText(doc.blocks);
    docJson = JSON.stringify(doc);
  } else {
    const paragraphs = manuscript.content.split(/\n\n/);
    for (const c of pending) {
      if (c.paragraphIndex < paragraphs.length && c.suggestedText != null) paragraphs[c.paragraphIndex] = c.suggestedText;
    }
    content = paragraphs.join("\n\n");
  }

  // 版本说明：留空则自动汇总各角色采纳条数
  const summary = parsed.data.summary?.trim() || autoAcceptSummary(pending.map((c) => c.authorRole));

  await createRevision(manuscript.id, req.userId!, role, content, summary, docJson);
  await prisma.comment.updateMany({ where: { id: { in: pending.map((c) => c.id) } }, data: { status: "ACCEPTED" } });
  const me = await prisma.user.findUnique({ where: { id: req.userId! } });
  await logActivity(manuscript.projectId, me!.name, "全部采纳", `《${manuscript.title}》${pending.length} 条建议`);
  res.json({ ok: true, count: pending.length, summary });
});

function autoAcceptSummary(roles: string[]): string {
  const tally = new Map<string, number>();
  for (const r of roles) tally.set(r, (tally.get(r) ?? 0) + 1);
  const parts = [...tally.entries()].map(([r, n]) => `${roleLabel(r)} ${n} 条`);
  return `采纳 ${parts.join("、")}修订意见`;
}

// 提交审阅意见 / 修改建议
manuscriptsRouter.post("/:id/comments", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });

  const schema = z.object({
    paragraphIndex: z.number().int().min(0),
    quote: z.string().max(1000).optional(),
    body: z.string().min(1, "请填写意见内容").max(5000),
    category: z.enum(["GENERAL", "GRAMMAR", "WORDING", "LOGIC", "STYLE", "MARKET", "STANDARD"]).optional(),
    suggestedText: z.string().max(20000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const comment = await prisma.comment.create({
    data: {
      manuscriptId: manuscript.id,
      authorId: req.userId!,
      authorRole: role,
      paragraphIndex: parsed.data.paragraphIndex,
      quote: parsed.data.quote ?? "",
      body: parsed.data.body,
      category: parsed.data.category ?? (role === "AGENT" ? "MARKET" : "GENERAL"),
      suggestedText: parsed.data.suggestedText,
    },
    include: { author: { select: { name: true, isAI: true } } },
  });
  res.json(comment);
});

// 处理意见：解决 / 采纳建议 / 驳回建议
manuscriptsRouter.patch("/:id/comments/:commentId", async (req: AuthedRequest, res) => {
  const { manuscript, role } = await loadWithRole(req.params.id, req.userId!);
  if (!manuscript) return res.status(404).json({ error: "书稿不存在" });
  if (!role || role === "AI_ASSISTANT") return res.status(403).json({ error: "无权限" });

  const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
  if (!comment || comment.manuscriptId !== manuscript.id) return res.status(404).json({ error: "意见不存在" });

  const schema = z.object({ status: z.enum(["RESOLVED", "ACCEPTED", "REJECTED", "OPEN"]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "参数错误" });
  const { status } = parsed.data;

  // 采纳/驳回修改建议是定稿权：仅主编可操作
  if ((status === "ACCEPTED" || status === "REJECTED") && role !== "CHIEF_EDITOR") {
    return res.status(403).json({ error: "仅主编可采纳或驳回修改建议" });
  }

  // 采纳建议：将建议文本应用到对应块/段落，自动生成修订版本
  if (status === "ACCEPTED") {
    if (!comment.suggestedText) return res.status(400).json({ error: "该意见不包含修改建议文本" });
    if (manuscript.status === "FINALIZED") return res.status(409).json({ error: "已定稿书稿不可修改" });

    const summary = `采纳${roleLabel(comment.authorRole)}的修改建议（第 ${comment.paragraphIndex + 1} 处）`;
    if (manuscript.docJson) {
      // 富内容：替换对应块的主文本
      const doc = normalizeDoc(JSON.parse(manuscript.docJson));
      if (!doc || comment.paragraphIndex >= doc.blocks.length) {
        return res.status(409).json({ error: "原内容块已不存在，无法自动应用，请手动编辑" });
      }
      doc.blocks[comment.paragraphIndex] = setBlockText(doc.blocks[comment.paragraphIndex] as Block, comment.suggestedText);
      await createRevision(manuscript.id, req.userId!, role, blocksToText(doc.blocks), summary, JSON.stringify(doc));
    } else {
      const paragraphs = manuscript.content.split(/\n\n/);
      if (comment.paragraphIndex >= paragraphs.length) {
        return res.status(409).json({ error: "原段落已不存在，无法自动应用，请手动编辑" });
      }
      paragraphs[comment.paragraphIndex] = comment.suggestedText;
      await createRevision(manuscript.id, req.userId!, role, paragraphs.join("\n\n"), summary);
    }
  }

  await prisma.comment.update({ where: { id: comment.id }, data: { status } });
  res.json({ ok: true });
});
