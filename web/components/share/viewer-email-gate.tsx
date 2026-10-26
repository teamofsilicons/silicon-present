"use client";

import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Problem } from "@/components/foundation/feedback/problem";
import { normalizeViewerEmail } from "@/lib/viewer-email";
import styles from "./viewer-email-gate.module.css";

export function ViewerEmailGate() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = normalizeViewerEmail(email);
    if (!value) { setError("Enter a valid email address, such as name@example.com."); return; }
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/viewer-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: value }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? "Your email could not be saved. Try again.");
      }
      // A full navigation also discards any pre-gate editor state or cached content.
      window.location.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your email could not be saved. Try again.");
      setBusy(false);
    }
  }
  return <Problem icon={<Mail size={20} />} title="Enter your email to view">
    <p className={styles.intro}>The owner asks for your email before you open this presentation. They can see your email and when you visit.</p>
    <form className={styles.form} onSubmit={submit}>
      <Input label="Email address" type="email" name="email" autoComplete="email" maxLength={254} required value={email} onChange={event => { setEmail(event.target.value); setError(undefined); }} error={error} disabled={busy} />
      <Button type="submit" loading={busy}>Continue to presentation</Button>
    </form>
    <p className={styles.note}>No sign-in or verification needed. We’ll remember this email in this browser for 24 hours for presentations that request it.</p>
  </Problem>;
}
