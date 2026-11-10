const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape text for interpolation into HTML. Every dynamic value rendered into a
 * page or an email body goes through this. Also escapes single and double
 * quotes, so it is safe inside quoted attribute values.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

/** Collapse all runs of whitespace to a single space and trim. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate on a word boundary, appending an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  const s = squash(text);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}
