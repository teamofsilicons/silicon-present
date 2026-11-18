/**
 * The one file that makes the web kit Silicon Present: its id and name, its mark, the workspace's sections, its links
 * and its landing page's words. Everything else reads from here. It is bundled into the browser: never put a secret
 * here.
 */
import { ContactRound, Building2, ArrowRightLeft, Eye, FileText, Folder, History, MessageSquareText, Presentation, ScanEye, Share2, TerminalSquare, Trash2 } from "lucide-react";
import type { AppConfig } from "./app-config.types";

export const appConfig: AppConfig = {
  appId: "present",
  name: "Present",
  brandPrefix: "Silicon",
  tagline: "Slides that Carbons and Silicons make, present and comment on together.",
  description:
    "Silicon Present is slides for Carbons and Silicons: everything you expect from Google Slides or PowerPoint, plus slides that hold live HTML. Silicons build whole decks from the present command line; Carbons review, comment and present them in the browser.",
  mark: { viewBox: "17 17 166 166", strokeWidth: 0, fill: true, paths: ["M21.87102 75.87102H44.99996V124.51848H21.87102Z", "M154.99954 75.87102H177.71248V124.51848H154.99954Z", "M48.05304 68.05304H151.94646V131.94646H48.05304Z"] },
  cli: { command: "present" },
  home: "/decks",
  nav: [
    { href: "/decks", label: "Decks", icon: Presentation, keywords: ["home", "slides", "folders", "shared", "mine"] },
    { href: "/transfers", label: "Transfers", icon: ArrowRightLeft, keywords: ["owner", "accept", "decline", "move"] },
    { href: "/contacts", label: "Contacts", icon: ContactRound, keywords: ["people", "trust"] },
    { href: "/organizations", label: "Organizations", icon: Building2, keywords: ["teams", "settings", "work"] },
    { href: "/trash", label: "Trash", icon: Trash2, keywords: ["deleted", "restore", "bin"] },
  ],
  links: {
    docs: "https://backend.present.teamofsilicons.com/interface-api",
    store: "https://apps.teamofsilicons.com/apps/present",
  },
  signIn: { scopes: ["email"] },
  // Opening a file (POST /v1/imports, POST /v1/decks/{id}/assets) names it in X-Filename, percent-encoded.
  api: { forwardHeaders: ["x-filename"] },
  landing: {
    headline: "Slides for Carbons and Silicons",
    lede:
      "Make, present and comment on decks together. Silicons build whole decks from the command line, Carbons review and present them in the browser, and a slide can be anything a web page can be.",
    forCarbons: [
      { icon: Presentation, title: "Everything you expect from slides", text: "Layouts, themes, transitions, animations, speaker notes, tables, charts, video, skipped slides and sections." },
      { icon: MessageSquareText, title: "Comment by pointing", text: "Click a spot on a slide, drag over an area or select some text, and write. Mention a Silicon to ask it for a change." },
      { icon: Share2, title: "Share with exact accounts", text: "Invite Carbons and Silicons by c: id, si: id or email as editor, commenter or viewer, or make a deck public with one switch." },
      { icon: Eye, title: "Present anywhere", text: "Full screen with a presenter view, notes and a timer, and a link everyone can follow live." },
    ],
    forSilicons: [
      { icon: TerminalSquare, title: "Build a whole deck from the command line", text: "Add and change exactly the slide or element you mean, so your change merges cleanly with everyone else's." },
      { icon: FileText, title: "Read every deck as text", text: "Every slide, element, position, speaker note and comment, next to what it is on." },
      { icon: ScanEye, title: "See what you made", text: "Render any slide to an image, the same way a Carbon sees it, live HTML included." },
      { icon: Folder, title: "Work in a folder", text: "present pull brings a deck down as files, HTML elements and assets included; present push merges it back." },
      { icon: History, title: "Nothing is ever lost", text: "List, compare, name and restore versions; every change keeps who made it." },
    ],
  },
};

export type { AppConfig, NavItem } from "./app-config.types";
