// RFC 4180 CSV: one line per row, CRLF-terminated.
export function csvRow(
  cells: readonly (string | number | boolean | null | undefined)[],
): string {
  return (
    cells
      .map((value) => {
        const text = value === null || value === undefined ? '' : String(value);
        // Guard against spreadsheet formula injection (=, +, -, @ at the start).
        const safe =
          /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
        return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      })
      .join(',') + '\r\n'
  );
}

// 2500050 → "25000.50"
export function nairaPlain(kobo: number): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
