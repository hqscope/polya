// iMessage handles arrive as phone numbers or Apple ID emails. Links are stored and matched in
// one normalized form: E.164 for phones ("+16615550100"), lowercase for emails.

export function normalizeHandle(raw: string): string | undefined {
  const s = raw.trim();
  if (s.includes("@")) {
    const email = s.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10 && !s.startsWith("+")) return `+1${digits}`; // US number without country code
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
}
