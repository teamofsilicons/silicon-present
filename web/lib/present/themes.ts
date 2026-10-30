/**
 * Custom themes (docs/architecture.md, "The service"): your own themes, usable in any deck you can edit. Saving one
 * from a deck (yours, or a shared deck you edit) keeps a copy of its fonts and colours; using one copies its uploaded
 * fonts into the deck and returns the theme to set, so the editor applies it like any other theme change.
 */
import { THEMES, type Theme } from "@silicon-present/deck";
import { api, seg } from "../client/api";

export interface SavedTheme extends Theme {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export async function listThemes(signal?: AbortSignal): Promise<SavedTheme[]> {
  const out = await api.get<{ themes?: SavedTheme[] }>("/v1/themes", { signal });
  return out?.themes ?? [];
}

/** Saves the deck's current theme to your themes (needs editor access to the deck). */
export async function saveTheme(deck: string, name: string): Promise<SavedTheme> {
  return api.post<SavedTheme>("/v1/themes", { deck, name }, { idempotencyKey: true });
}

/** The theme ready to set on `deck`, its uploaded fonts copied into the deck. */
export async function themeForDeck(theme: string, deck: string): Promise<Theme> {
  const out = await api.post<{ theme: Theme }>(`/v1/themes/${seg(theme)}/use`, { deck });
  return out.theme;
}

export async function deleteTheme(theme: string): Promise<void> {
  await api.delete(`/v1/themes/${seg(theme)}`);
}

/** Fonts, colours and custom font families: what makes two themes look the same, whatever they are called. */
export function themeLook(theme: Pick<Theme, "fonts" | "colors" | "customFonts">): string {
  const c = theme.colors;
  return JSON.stringify([
    theme.fonts.heading.toLowerCase(),
    theme.fonts.body.toLowerCase(),
    [c.background, c.text, c.accent, c.accent2, c.accent3, c.muted].map(x => x.toLowerCase()),
    (theme.customFonts ?? []).map(f => f.family.toLowerCase()).sort(),
  ]);
}

/** True when the theme looks exactly like a built-in one. */
export function isBuiltInLook(theme: Theme): boolean {
  const look = themeLook(theme);
  return THEMES.some(t => themeLook(t) === look);
}

/** A name to suggest when saving: the deck's theme name unless it is a built-in's. */
export function suggestedThemeName(theme: Theme): string {
  return THEMES.some(t => t.name.toLowerCase() === theme.name.toLowerCase()) ? `${theme.name} (custom)` : theme.name;
}
