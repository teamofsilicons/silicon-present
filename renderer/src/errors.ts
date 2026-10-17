// Errors in the shape every Silicon Present part uses: {"error": {"code", "message", "hint"}}.
export class ConverterError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ConverterError";
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, hint: this.hint } };
  }
}

export function asConverterError(e: unknown): ConverterError {
  if (e instanceof ConverterError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new ConverterError("conversion_failed", `The conversion failed: ${msg}`, "Try again; if it keeps failing, the file may be damaged or use something the converter can't read.", 500);
}
