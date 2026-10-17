/** Standard base64 for Yjs updates and state vectors, as the service sends and expects them. */

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  // Accept base64url too (a service may choose it for query strings).
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "===".slice((normal.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
