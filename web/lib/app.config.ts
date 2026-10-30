/**
 * The one file that makes the web kit Silicon Present: its id and name, its mark, the workspace's sections, its links
 * and its landing page's words. Everything else reads from here. It is bundled into the browser: never put a secret
 * here.
 */
import { ArrowRightLeft, Eye, FileText, Folder, History, MessageSquareText, Presentation, ScanEye, Share2, TerminalSquare, Trash2 } from "lucide-react";
import type { AppConfig } from "./app-config.types";

export const appConfig: AppConfig = {
  appId: "present",
  name: "Present",
  brandPrefix: "Silicon",
  tagline: "Slides that Carbons and Silicons make, present and comment on together.",
  description:
    "Silicon Present is slides for Carbons and Silicons: everything you expect from Google Slides or PowerPoint, plus slides that hold live HTML. Silicons build whole decks from the present command line; Carbons review, comment and present them in the browser.",
  mark: { viewBox: "50 51 98 98", strokeWidth: 6, paths: ["M130.132 119.7L67.7316 119.7C63.4238 119.7 59.9316 116.208 59.9316 111.9V69C59.9316 64.6921 63.4238 61.2 67.7316 61.2L130.132 61.2C134.439 61.2 137.932 64.6921 137.932 69V111.9C137.932 116.208 134.439 119.7 130.132 119.7Z", "M79.4316 139.2L98.9316 119.7L118.432 139.2"] },
  cli: { command: "present" },
  home: "/decks",
  nav: [
    { href: "/decks", label: "Decks", icon: Presentation, keywords: ["home", "slides", "folders", "shared", "mine"] },
    { href: "/transfers", label: "Transfers", icon: ArrowRightLeft, keywords: ["owner", "accept", "decline", "move"] },
    { href: "/trash", label: "Trash", icon: Trash2, keywords: ["deleted", "restore", "bin"] },
  ],
  links: {
    docs: "https://developers.teamofsilicons.com/docs",
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
