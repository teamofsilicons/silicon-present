/** A contact address supplied for viewing, never a sign-in or proof of identity. */
export function normalizeViewerEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[^\x21-\x7e]/.test(email)) return null;
  const [local, domain, extra] = email.split("@");
  if (!local || !domain || extra !== undefined || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/.test(label))) return null;
  return email;
}
