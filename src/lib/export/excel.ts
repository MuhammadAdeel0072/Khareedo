// Excel workbook builder (admin exports) — exceljs, branded + number-formatted.
import ExcelJS from "exceljs";

const BRAND_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF11402B" }, // Khareedo dark green
};

export interface ExcelColumn {
  label: string;
  /** Column width in Excel units (default 18). */
  width?: number;
  /** Format cells as PKR currency ("Rs 1,234"). */
  money?: boolean;
}

export interface ExcelSheet {
  /** Max 31 chars (Excel limit). */
  name: string;
  /** Optional merged title row above the header. */
  title?: string;
  columns: ExcelColumn[];
  rows: Array<Array<string | number | null | undefined>>;
}

export async function buildWorkbook(sheets: ExcelSheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Khareedo Admin";
  wb.lastModifiedBy = "Khareedo Admin";
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31), {
      views: [{ state: "frozen", ySplit: sheet.title ? 2 : 1 }],
    });

    ws.columns = sheet.columns.map((c) => ({ width: c.width ?? 18 }));

    let headerRowIndex = 1;
    if (sheet.title) {
      const titleRow = ws.getRow(1);
      titleRow.getCell(1).value = sheet.title;
      titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: "FF11402B" } };
      titleRow.getCell(1).alignment = { vertical: "middle" };
      ws.mergeCells(1, 1, 1, Math.max(2, sheet.columns.length));
      titleRow.height = 24;
      headerRowIndex = 2;
    }

    const header = ws.getRow(headerRowIndex);
    sheet.columns.forEach((col, i) => {
      const cell = header.getCell(i + 1);
      cell.value = col.label;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = BRAND_FILL;
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FF0B2B1D" } } };
    });
    header.height = 20;

    sheet.rows.forEach((row, rIdx) => {
      const r = ws.getRow(headerRowIndex + 1 + rIdx);
      sheet.columns.forEach((col, cIdx) => {
        const cell = r.getCell(cIdx + 1);
        const value = row[cIdx];
        cell.value = value === undefined ? null : value;
        if (col.money && typeof value === "number") {
          cell.numFmt = '"Rs" #,##0';
        }
        if (rIdx % 2 === 1) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF4F7F5" },
          };
        }
      });
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
