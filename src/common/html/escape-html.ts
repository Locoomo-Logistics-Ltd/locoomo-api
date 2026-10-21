const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// For interpolating user-supplied text (parcel descriptions, names, Node
// names) into HTML emails — without it, a description like
// "<a href=…>claim refund</a>" renders as a live link in the recipient's
// inbox.
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}
