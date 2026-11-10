"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionView } from "@/lib/client/session";
import { watchLibrary } from "./library-events";

export function useLibraryEvents(account: string) {
  const router = useRouter();
  const queries = useQueryClient();
  const session = useSessionView();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!session.signedIn || session.account?.uuid !== account) return;
    return watchLibrary(() => {
      setRevision(value => value + 1);
      void queries.invalidateQueries({ queryKey: ["place"] });
      void queries.invalidateQueries({ queryKey: ["transfers"] });
      router.refresh();
    });
  }, [account, session.signedIn, session.account?.uuid, queries, router]);
  return revision;
}
