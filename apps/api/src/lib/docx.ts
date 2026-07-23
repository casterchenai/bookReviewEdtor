// 块 → Word(.docx)：标题 / 正文 / 注记 / 列表 / 表格 / 图片占位 / 分页
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from "docx";
import type { Block } from "./content.js";
import { buildReport, categoryLabel, statusLabel, type ReportComment } from "./report.js";

function headingLevel(level: number) {
  return level <= 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
}

const EDGE = { style: BorderStyle.SINGLE, size: 4, color: "888888" };
const CELL_BORDERS = { top: EDGE, bottom: EDGE, left: EDGE, right: EDGE };

function blockToNodes(b: Block): (Paragraph | Table)[] {
  switch (b.type) {
    case "heading":
      return [new Paragraph({ text: b.text, heading: headingLevel(b.level) })];
    case "para":
      return [new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 120 } })];
    case "note":
      return [new Paragraph({ children: [new TextRun({ text: b.text, italics: true, color: "555555" })], spacing: { after: 120 } })];
    case "list":
      return b.items.map((it) => new Paragraph({ text: it, bullet: { level: 0 } }));
    case "table":
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r) => new TableRow({
          children: r.cells.map((c) => new TableCell({
            borders: CELL_BORDERS,
            children: [new Paragraph({ children: [new TextRun({ text: c, bold: r.header })] })],
          })),
        })),
      })];
    case "image":
      return [new Paragraph({ children: [new TextRun({ text: `［图片：${b.alt || "无说明"}］`, italics: true, color: "888888" })] })];
    case "page":
      return [new Paragraph({ children: [new TextRun({ text: `【${b.label} · ${b.pageKind === "gallery" ? "图册页" : "文本页"}】`, bold: true, color: "999999" })], alignment: AlignmentType.CENTER })];
  }
}

function textToNodes(content: string): Paragraph[] {
  return content.split(/\n\n/).map((p) => p.trim()).filter(Boolean).map((p) => new Paragraph({ children: [new TextRun(p)], spacing: { after: 120 } }));
}

// 单章导出
export async function manuscriptToDocx(m: { title: string; content: string; docJson: string }, blocks: Block[] | null): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [new Paragraph({ text: m.title, heading: HeadingLevel.TITLE })];
  if (blocks) body.push(...blocks.flatMap(blockToNodes));
  else body.push(...textToNodes(m.content));
  const doc = new Document({ sections: [{ children: body }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// 审校报告导出：按页/段汇总意见，供排版设计师据此修改 PDF
function reportCell(text: string, opts: { bold?: boolean; color?: string; width: number }): TableCell {
  return new TableCell({
    borders: CELL_BORDERS,
    width: { size: opts.width, type: WidthType.PERCENTAGE },
    children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold, color: opts.color })] })],
  });
}

export async function reviewReportDocx(
  title: string,
  blocks: Block[] | null,
  comments: ReportComment[],
  roleLabel: (r: string) => string,
): Promise<Buffer> {
  const groups = buildReport(blocks, comments);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const date = new Date().toLocaleString("zh-CN", { hour12: false });
  const body: (Paragraph | Table)[] = [
    new Paragraph({ text: `${title} · 审校报告`, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `共 ${total} 条审校意见 · 生成于 ${date}`, color: "888888", italics: true })], spacing: { after: 200 } }),
  ];
  if (!total) body.push(new Paragraph({ children: [new TextRun({ text: "暂无审校意见。", color: "999999" })] }));

  for (const g of groups) {
    const kind = g.pageKind === "gallery" ? " · 图册页" : g.pageKind === "text" ? " · 文本页" : "";
    body.push(new Paragraph({ text: `${g.page}${kind}（${g.items.length} 条）`, heading: HeadingLevel.HEADING_2, spacing: { before: 200 } }));
    const header = new TableRow({
      tableHeader: true,
      children: [
        reportCell("位置", { bold: true, width: 8 }),
        reportCell("类别", { bold: true, width: 10 }),
        reportCell("审校意见 / 修改建议", { bold: true, width: 60 }),
        reportCell("审校人", { bold: true, width: 22 }),
      ],
    });
    const rows = g.items.map((c) => {
      const who = c.aiAgentName ? `${c.aiAgentName}（AI）` : `${c.authorName}（${roleLabel(c.authorRole)}）`;
      const cnt: Paragraph[] = [];
      if (c.blockText) cnt.push(new Paragraph({ children: [new TextRun({ text: c.blockText.slice(0, 300), color: "777777", italics: true })] }));
      cnt.push(new Paragraph({ children: [new TextRun(c.body)] }));
      if (c.suggestedText) cnt.push(new Paragraph({ children: [new TextRun({ text: "建议改为：", bold: true, color: "2e7d32" }), new TextRun({ text: c.suggestedText, color: "2e7d32" })] }));
      return new TableRow({
        children: [
          reportCell(`¶${c.paragraphIndex + 1}`, { color: "888888", width: 8 }),
          reportCell(categoryLabel(c.category), { width: 10 }),
          new TableCell({ borders: CELL_BORDERS, width: { size: 60, type: WidthType.PERCENTAGE }, children: cnt }),
          new TableCell({ borders: CELL_BORDERS, width: { size: 22, type: WidthType.PERCENTAGE }, children: [
            new Paragraph({ children: [new TextRun(who)] }),
            new Paragraph({ children: [new TextRun({ text: statusLabel(c.status), color: "999999" })] }),
          ] }),
        ],
      });
    });
    body.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] }));
  }
  const doc = new Document({ sections: [{ children: body }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// 整书导出（按部分/章节合并，章节间分页）
export async function bookToDocx(
  title: string,
  chapters: { title: string; section: string; content: string; docJson: string }[],
  parse: (docJson: string) => Block[] | null,
): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  let lastSection = "";
  chapters.forEach((c, i) => {
    if (i > 0) body.push(new Paragraph({ text: "", pageBreakBefore: true }));
    if (c.section && c.section !== lastSection) { body.push(new Paragraph({ text: c.section, heading: HeadingLevel.HEADING_1 })); lastSection = c.section; }
    body.push(new Paragraph({ text: c.title, heading: HeadingLevel.HEADING_2 }));
    const blocks = c.docJson ? parse(c.docJson) : null;
    if (blocks) body.push(...blocks.flatMap(blockToNodes));
    else body.push(...textToNodes(c.content));
  });
  const doc = new Document({ sections: [{ children: body }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
