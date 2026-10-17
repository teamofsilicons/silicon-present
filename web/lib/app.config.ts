/**
 * The one file an app edits to make the kit its own: its id and name, its mark and colour, the navigation of its
 * signed-in workspace, its links and its landing page's words. Everything else reads from here.
 *
 * This copy describes "Web Kit", the kit's own demo (app_id `webkit` on the shared local Accounts stack). An app that
 * adopts the kit replaces every value (ADOPTING.md, step 2). It is bundled into the browser: never put a secret here.
 */
import { BookOpen, Bot, KeyRound, LayoutList, MonitorSmartphone, Settings2, Share2, SunMoon, TerminalSquare, UserRoundCheck } from "lucide-react";
import type { AppConfig } from "./app-config.types";

export const appConfig: AppConfig = {
  appId: "webkit",
  name: "Web Kit",
  brandPrefix: "Silicon",
  tagline: "The shared web frontend every Silicon app is built from.",
  description:
    "Web Kit is the template behind the web frontends of Silicon apps: the Silicon look, sign-in with Silicon Accounts, a signed-in workspace and a safe path to the app's own service. Carbons use it in the browser; Silicons use the same app from its command line.",
  // A window with a header and a sidebar (lucide "panels-top-left").
  mark: { paths: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 9h18", "M9 21V9"] },
  cli: { command: "webkit" },
  home: "/items",
  nav: [
    { href: "/items", label: "Items", icon: LayoutList, keywords: ["list", "table", "home"] },
    { href: "/settings", label: "Settings", icon: Settings2, keywords: ["preferences", "sharing", "notifications"] },
  ],
  links: {
    docs: "https://developers.teamofsilicons.com/docs",
    store: "https://apps.teamofsilicons.com/apps/webkit",
  },
  signIn: { scopes: ["email", "timezone"] },
  landing: {
    headline: "One look and one sign-in for every Silicon app",
    lede:
      "Web Kit gives an app a fast, accessible web workspace in the Silicon look. Carbons sign in with Silicon Accounts, the server keeps their tokens, and every page talks to the app's own service.",
    forCarbons: [
      { icon: KeyRound, title: "Sign in with Silicon Accounts", text: "Google, Apple, email or phone on the hosted pages. The browser never holds a token." },
      { icon: Share2, title: "Share with exact accounts", text: "Name a Carbon or a Silicon by its c: or si: id; nothing is ever open to everyone who signed in." },
      { icon: SunMoon, title: "Light, dark or your device's", text: "The choice is kept per browser and painted before the first frame, so nothing flashes." },
      { icon: MonitorSmartphone, title: "Made for every screen", text: "A sidebar on wide screens, a compact menu on phones, and every action within reach of the keyboard." },
    ],
    forSilicons: [
      { icon: TerminalSquare, title: "Install with one command", text: "silicon-apps install webkit puts the command line on any machine, and Silicon Apps keeps it up to date." },
      { icon: Bot, title: "Sign in without a page", text: "A Silicon hands the app a short-lived token from silicon-accounts login --app webkit; no browser is involved." },
      { icon: UserRoundCheck, title: "Custodians see what their Silicons do", text: "A Carbon who looks after a Silicon can see and manage what that Silicon keeps in the app." },
      { icon: BookOpen, title: "Written for Silicons to read", text: "The landing page and llms.txt are plain, server-rendered text that any Silicon can read and quote." },
    ],
  },
};

export type { AppConfig, NavItem } from "./app-config.types";
