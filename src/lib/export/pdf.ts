// Server-side PDF report builder (admin exports) — pdf-lib (pure JS, bundles cleanly).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const BRAND = rgb(0.067, 0.251, 0.169); // #11402B Khareedo dark green
const INK = rgb(0.12, 0.16, 0.22);
const MUTED = rgb(0.42, 0.45, 0.43);
const ZEBRA = rgb(0.957, 0.969, 0.961); // #F4F7F5
const BORDER = rgb(0.85, 0.88, 0.86);
const WHITE = rgb(1, 1, 1);

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const MARGIN = 44;
const FOOTER_ZONE = 46;

export interface PdfColumn {
  label: string;
  align?: "left" | "right";
  /** Relative width weight (default 1). */
  weight?: number;
}

export interface PdfSection {
  heading: string;
  note?: string;
  columns: PdfColumn[];
  rows: Array<Array<string | number>>;
}

export interface PdfReportMeta {
  title: string;
  subtitle?: string;
}

/** WinAnsi-safe text (standard fonts cannot encode arbitrary Unicode). */
function safe(text: string): string {
  const allowed = new Set([
    "\u2013", "\u2014", "\u2018", "\u2019", "\u201C", "\u201D", "\u2020",
    "\u2021", "\u2022", "\u2026", "\u2030", "\u2039", "\u203A", "\u20AC",
    "\u2122", "\u0152", "\u0153", "\u0160", "\u0161", "\u0178", "\u017D",
    "\u017E", "\u0192", "\u02C6", "\u02DC",
  ]);
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x100 || allowed.has(ch) ? ch : "?";
  }
  return out;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const pushLong = (word: string) => {
    let chunk = "";
    for (const ch of word) {
      if (font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) chunk += ch;
      else {
        if (chunk) lines.push(chunk);
        chunk = ch;
      }
    }
    line = chunk;
  };
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else {
      if (line) lines.push(line);
      line = "";
      pushLong(w);
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

export async function buildPdfReport(
  meta: PdfReportMeta,
  sections: PdfSection[]
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(meta.title));
  pdf.setAuthor("Khareedo Admin");
  pdf.setCreator("Khareedo");
  pdf.setProducer("Khareedo");

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const contentW = PAGE_W - MARGIN * 2;
  const pages: PDFPage[] = [];
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - MARGIN; // top-down cursor

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
  };
  const need = (h: number) => {
    if (y - h < MARGIN + FOOTER_ZONE) newPage();
  };

  // ── Letterhead ───────────────────────────────────────────────────────────
  page.drawText("KHAREEDO", { x: MARGIN, y: y - 11, size: 11, font: bold, color: BRAND });
  page.drawText(
    safe(`Generated ${new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`),
    { x: MARGIN, y: y - 26, size: 9, font: regular, color: MUTED }
  );
  y -= 46;
  page.drawText(safe(meta.title), { x: MARGIN, y: y - 20, size: 20, font: bold, color: INK });
  y -= 26;
  if (meta.subtitle) {
    page.drawText(safe(meta.subtitle), { x: MARGIN, y: y - 13, size: 10, font: regular, color: MUTED });
    y -= 18;
  }
  page.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: MARGIN + contentW, y: y - 2 }, thickness: 2, color: BRAND });
  page.drawLine({ start: { x: MARGIN, y: y - 5 }, end: { x: MARGIN + contentW, y: y - 5 }, thickness: 0.75, color: BORDER });
  y -= 26;

  // ── Sections ─────────────────────────────────────────────────────────────
  for (const section of sections) {
    need(70);
    page.drawText(safe(section.heading), { x: MARGIN, y: y - 13, size: 13, font: bold, color: BRAND });
    y -= 17;
    if (section.note) {
      page.drawText(safe(section.note), { x: MARGIN, y: y - 11, size: 9, font: regular, color: MUTED });
      y -= 14;
    }
    y -= 6;

    if (section.rows.length === 0) {
      page.drawText("No data available.", { x: MARGIN, y: y - 11, size: 9, font: regular, color: MUTED });
      y -= 24;
      continue;
    }

    const weights = section.columns.map((c) => c.weight ?? 1);
    const weightSum = weights.reduce((s, w) => s + w, 0) || 1;
    const colW = weights.map((w) => (contentW * w) / weightSum);
    const pad = 6;

    const drawHeaderRow = () => {
      const rowH = 24;
      need(rowH + 20);
      page.drawRectangle({ x: MARGIN, y: y - rowH, width: contentW, height: rowH, color: BRAND });
      let x = MARGIN;
      section.columns.forEach((col, i) => {
        const label = safe(col.label);
        const w = bold.widthOfTextAtSize(label, 8.5);
        const tx = col.align === "right" ? x + colW[i] - pad - w : x + pad;
        page.drawText(label, { x: tx, y: y - rowH + pad + 1, size: 8.5, font: bold, color: WHITE });
        x += colW[i];
      });
      y -= rowH;
    };

    drawHeaderRow();

    section.rows.forEach((row, idx) => {
      const cellLines = row.map((cell, i) =>
        wrapText(String(cell ?? ""), regular, 9, colW[i] - pad * 2)
      );
      const rowH = Math.max(20, Math.max(...cellLines.map((l) => l.length)) * 11 + 10);

      if (y - rowH < MARGIN + FOOTER_ZONE) {
        newPage();
        drawHeaderRow();
      }

      if (idx % 2 === 1) {
        page.drawRectangle({ x: MARGIN, y: y - rowH, width: contentW, height: rowH, color: ZEBRA });
      }

      let x = MARGIN;
      row.forEach((cell, i) => {
        const lines = cellLines[i];
        lines.forEach((lineText, li) => {
          const size = 9;
          const ty = y - pad - 9 - li * 11;
          if (section.columns[i].align === "right") {
            const w = regular.widthOfTextAtSize(lineText, size);
            page.drawText(lineText, { x: x + colW[i] - pad - w, y: ty, size, font: regular, color: INK });
          } else {
            page.drawText(lineText, { x: x + pad, y: ty, size, font: regular, color: INK });
          }
        });
        x += colW[i];
      });

      page.drawLine({
        start: { x: MARGIN, y: y - rowH },
        end: { x: MARGIN + contentW, y: y - rowH },
        thickness: 0.5,
        color: BORDER,
      });
      y -= rowH;
    });

    y -= 18;
  }

  // ── Footers ──────────────────────────────────────────────────────────────
  pages.forEach((p, i) => {
    const label = safe(`Khareedo Admin · ${meta.title} · Page ${i + 1} of ${pages.length}`);
    const w = regular.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: (PAGE_W - w) / 2, y: 24, size: 8, font: regular, color: MUTED });
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
