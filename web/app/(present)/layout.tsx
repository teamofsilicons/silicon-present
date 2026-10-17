/**
 * Present mode, the presenter view and follow-along: full screen, no workspace shell. They may be signed out (a public
 * deck), so this layout never requires a session; it mounts the kit's providers (query client, toasts, the session
 * keeper when signed in).
 */
import type { ReactNode } from "react";
import { Providers } from "@/components/foundation/providers";
import { getOptionalSession, sessionView } from "@/lib/session-optional";

export default async function PresentLayout({ children }: { children: ReactNode }) {
  const session = await getOptionalSession();
  return <Providers session={sessionView(session)}><main id="main" tabIndex={-1}>{children}</main></Providers>;
}
