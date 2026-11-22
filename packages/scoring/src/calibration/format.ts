/** Number formatting for pl-PL output without locale data (a decimal comma, a fixed number of digits). */
export function pl(value: number, digits = 3): string {
  return value.toFixed(digits).replace('.', ',');
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
