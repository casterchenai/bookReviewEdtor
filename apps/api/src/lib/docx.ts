// 块 → Word(.docx)：标题 / 正文 / 注记 / 列表 / 表格 / 图片占位 / 分页
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from "docx";
import type { Block } from "./content.js";

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
