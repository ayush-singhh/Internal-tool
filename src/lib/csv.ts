/** RFC 4180 CSV read/write. Pure functions, no dependencies, no streaming —
 *  an operations spreadsheet is measured in thousands of rows, not gigabytes. */

/**
 * Parses CSV into a row/field matrix. Handles quoted fields, escaped quotes (`""`),
 * embedded commas and newlines, CRLF or LF endings, and a leading UTF-8 BOM.
 * A trailing newline does not produce a phantom final row.
 */
export function parseCsv(input: string, delimiter = ","): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let fieldStarted = false;

  const endField = () => { row.push(field); field = ""; fieldStarted = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"' && !fieldStarted) { quoted = true; fieldStarted = true; i++; continue; }
    if (ch === delimiter) { endField(); i++; continue; }
    if (ch === "\r") { if (text[i + 1] === "\n") i++; endRow(); i++; continue; }
    if (ch === "\n") { endRow(); i++; continue; }

    field += ch;
    fieldStarted = true;
    i++;
  }

  // Flush whatever is still buffered, unless the file simply ended with a newline.
  if (field !== "" || row.length > 0 || quoted) endRow();
  return rows;
}

/** Detects the delimiter by counting candidates outside quotes on the header line. */
export function sniffDelimiter(input: string): string {
  const header = input.slice(0, 8000).split(/\r?\n/)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < header.length; i++) {
      const ch = header[i];
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

const NEEDS_QUOTES = /[",\r\n]/;

export function csvField(value: unknown, delimiter = ","): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  // Excel reads a leading =, +, - or @ as a formula; prefix so exports stay inert.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return NEEDS_QUOTES.test(safe) || safe.includes(delimiter)
    ? `"${safe.replace(/"/g, '""')}"`
    : safe;
}

export function toCsv(rows: unknown[][], delimiter = ","): string {
  return rows.map((r) => r.map((f) => csvField(f, delimiter)).join(delimiter)).join("\r\n");
}
