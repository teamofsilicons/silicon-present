/**
 * The deck page lives outside the workspace frame: the editor fills the window with its own top bar, slide strip and
 * panels. It still mounts the providers (query client, toasts, the session keeper), for signed-in Carbons and for
 * signed-out visitors of a public deck alike.
 */
import type { ReactNode } from "react";
import { Providers } from "@/components/foundation/providers";
import { getSession } from "@/lib/server/rsc";

export default async function EditorLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  return (
    <Providers session={session ? { signedIn: true, account: session.account, expiresAt: session.expiresAt } : { signedIn: false, account: null, expiresAt: null }}>
      {children}
    </Providers>
  );
}
