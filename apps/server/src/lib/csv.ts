import type { Response } from "express";

export interface CsvColumn<T> {
  key: keyof T | string;
  label: string;
  value?: (row: T) => unknown;
}

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  let s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine<T>(row: T, columns: CsvColumn<T>[]): string {
  return columns
    .map((c) => escapeCell(c.value ? c.value(row) : (row as Record<string, unknown>)[c.key as string]))
    .join(",");
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  return [columns.map((c) => escapeCell(c.label)).join(","), ...rows.map((r) => csvLine(r, columns))].join("\r\n");
}

export async function streamCsv<T>(
  res: Response,
  filename: string,
  columns: CsvColumn<T>[],
  fetchPage: (skip: number, take: number) => Promise<T[]>,
  pageSize = 1000,
  maxRows = 200_000,
): Promise<void> {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`);
  res.write("﻿" + columns.map((c) => escapeCell(c.label)).join(",") + "\r\n");
  for (let skip = 0; skip < maxRows; skip += pageSize) {
    const rows = await fetchPage(skip, pageSize);
    if (!rows.length) break;
    res.write(rows.map((r) => csvLine(r, columns)).join("\r\n") + "\r\n");
    if (rows.length < pageSize) break;
  }
  res.end();
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(src);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}
