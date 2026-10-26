import type { Animation, ElementInput } from "@silicon-present/deck";
import { attr, child, find, findAll, kids, type XNode } from "./xml";

// PowerPoint's slide timing (<p:timing>) back into element animations. Entrance effects in the main sequence become
// `animation` on the elements their shapes turned into, keeping trigger (click / with previous / after previous),
// order, duration, delay and direction. Times are rebuilt so the player starts each animation when PowerPoint does.
// PowerPoint's presets that we don't have become the closest of our effects (unknown ones fade), with a note.
// Emphasis, exit and motion-path effects, and triggered (interactive) sequences, are left out with a note.

type Effect = Animation["effect"];
type Dir = NonNullable<Animation["direction"]>;

/** PowerPoint's entrance presets (presetClass="entr") by presetID: our effect, and whether it is the same effect. */
const PRESETS: Record<number, { effect: Effect; name: string; exact?: boolean }> = {
  1: { effect: "appear", name: "Appear", exact: true },
  2: { effect: "fly-in", name: "Fly In", exact: true },
  3: { effect: "wipe", name: "Blinds" },
  7: { effect: "fly-in", name: "Crawl In" },
  9: { effect: "fade", name: "Dissolve In" },
  10: { effect: "fade", name: "Fade", exact: true },
  12: { effect: "wipe", name: "Peek In" },
  16: { effect: "wipe", name: "Split" },
  17: { effect: "zoom", name: "Stretch" },
  22: { effect: "wipe", name: "Wipe", exact: true },
  23: { effect: "zoom", name: "Basic Zoom" },
  31: { effect: "zoom", name: "Grow & Turn" },
  37: { effect: "rise", name: "Rise Up", exact: true },
  42: { effect: "rise", name: "Float In" },
  47: { effect: "fly-in", name: "Float Down" },
  53: { effect: "zoom", name: "Zoom", exact: true },
  55: { effect: "zoom", name: "Expand" },
};

/** presetSubtype ("comes in from" / "starts at") -> the way the motion goes. Diagonals take their vertical part. */
const FROM: Record<number, Dir> = { 1: "down", 2: "left", 3: "down", 4: "up", 6: "up", 8: "right", 9: "down", 12: "up" };

const TRIGGER: Record<string, Animation["trigger"]> = { clickEffect: "click", withEffect: "with-previous", afterEffect: "after-previous" };

/** The first numeric delay of a time node's start conditions (0 when there is none). */
function startDelay(cTn: XNode | undefined): number {
  for (const c of kids(child(cTn, "p:stCondLst"), "p:cond")) {
    const d = Number(attr(c, "delay"));
    if (Number.isFinite(d)) return Math.max(0, d);
  }
  return 0;
}

/** How long an effect's behaviours run: the latest begin + dur among them. */
function effectDuration(effect: XNode): number | null {
  let end: number | null = null;
  for (const b of findAll(child(effect, "p:childTnLst"), "p:cBhvr")) {
    const cTn = child(b, "p:cTn");
    const dur = Number(attr(cTn, "dur"));
    if (!Number.isFinite(dur)) continue;
    end = Math.max(end ?? 0, startDelay(cTn) + dur);
  }
  return end;
}

/** The slide's timing, also when PowerPoint wrapped it in mc:AlternateContent. */
function timingOf(sld: XNode): XNode | undefined {
  const t = child(sld, "p:timing");
  if (t) return t;
  for (const ac of kids(sld, "mc:AlternateContent")) {
    const x = find(child(ac, "mc:Choice"), "p:timing") ?? find(child(ac, "mc:Fallback"), "p:timing");
    if (x) return x;
  }
  return undefined;
}

interface Read {
  els: ElementInput[];
  effect: Effect;
  direction?: Dir;
  nodeType: string;
  /** start within its click step, ms */
  start: number;
  duration: number;
}

/**
 * Read a slide's entrance animations onto its elements. `bySpid` maps each shape id to the elements it became (a
 * group's id to all its members). Notes about what was approximated or left out are added to `notes`.
 */
export function readAnimations(sld: XNode, bySpid: Map<string, ElementInput[]>, slideNo: number, notes: string[]): void {
  const timing = timingOf(sld);
  if (!timing) return;
  const root = find(timing, "p:tnLst");
  const seqs = findAll(root, "p:seq");
  const main = seqs.find((s) => attr(child(s, "p:cTn"), "nodeType") === "mainSeq");
  const interactive = seqs.filter((s) => s !== main && findAll(s, "p:cTn").some((c) => attr(c, "presetClass")));
  const left = new Map<string, number>();
  const approx = new Map<string, Effect>();
  let byParagraph = false;
  if (interactive.length) left.set("triggered by clicking a shape", interactive.reduce((k, s) => k + findAll(s, "p:cTn").filter((c) => attr(c, "presetClass")).length, 0));
  const steps: Read[][] = [];
  const done = new Set<ElementInput>();
  const stepPars = main ? kids(child(child(main, "p:cTn"), "p:childTnLst"), "p:par") : [];
  for (const [si, stepPar] of stepPars.entries()) {
    const stepCTn = child(stepPar, "p:cTn");
    // a step that doesn't wait for a click starts with the slide (PowerPoint: onBegin; LibreOffice: a plain delay)
    const conds = kids(child(stepCTn, "p:stCondLst"), "p:cond");
    const auto = si === 0 && (conds.some((c) => attr(c, "evt") === "onBegin") || !conds.some((c) => attr(c, "delay") === "indefinite"));
    const step: Read[] = [];
    for (const subPar of kids(child(stepCTn, "p:childTnLst"), "p:par")) {
      const subCTn = child(subPar, "p:cTn");
      const subStart = startDelay(subCTn);
      // the effects: time nodes with a preset class (normally the sub-group's children)
      const effects = findAll(child(subCTn, "p:childTnLst"), "p:cTn").filter((c) => attr(c, "presetClass"));
      for (const fx of effects) {
        const cls = attr(fx, "presetClass")!;
        if (cls !== "entr") {
          const what = cls === "exit" ? "exit" : cls === "emph" ? "emphasis" : cls === "path" ? "motion path" : cls;
          left.set(what, (left.get(what) ?? 0) + 1);
          continue;
        }
        const spTgt = find(fx, "p:spTgt");
        const els = (bySpid.get(attr(spTgt, "spid") ?? "") ?? []).filter((e) => !done.has(e));
        if (!els.length) continue; // a shape we didn't read, or a further paragraph of one already animated
        if (child(spTgt, "p:txEl")) byParagraph = true;
        for (const e of els) done.add(e);
        const id = Number(attr(fx, "presetID"));
        const preset = PRESETS[id] ?? { effect: "fade" as Effect, name: `entrance effect ${Number.isFinite(id) ? id : "?"}` };
        if (!preset.exact) approx.set(preset.name, preset.effect);
        const subtype = Number(attr(fx, "presetSubtype"));
        let direction: Dir | undefined;
        if (preset.effect === "fly-in" || preset.effect === "wipe") direction = id === 47 ? "down" : FROM[subtype] ?? (preset.effect === "fly-in" ? "up" : "right");
        let duration = effectDuration(fx) ?? 500;
        if (preset.effect === "appear" && duration <= 1) duration = 0;
        step.push({ els, effect: preset.effect, direction, nodeType: attr(fx, "nodeType") ?? "", start: subStart + startDelay(fx), duration: Math.round(duration) });
      }
    }
    if (!step.length) continue;
    if (!auto) step[0]!.nodeType = "clickEffect";
    else if (step[0]!.nodeType === "clickEffect") step[0]!.nodeType = "withEffect";
    steps.push(step);
  }
  // our triggers and delays, timed as the player times them (packages/render slideSteps)
  let order = 0;
  for (const step of steps) {
    let prevStart = 0;
    let prevEnd = 0;
    for (const r of step) {
      let trigger = TRIGGER[r.nodeType] ?? "with-previous";
      if (trigger === "click" && r !== step[0]) trigger = "with-previous"; // one click per step
      const from = trigger === "click" ? 0 : trigger === "after-previous" ? prevEnd : prevStart;
      const delay = Math.max(0, Math.round(r.start - from));
      const start = from + delay;
      prevStart = start;
      prevEnd = Math.max(prevEnd, start + Math.max(1, r.duration));
      const a: Animation = { effect: r.effect, trigger, order: ++order, duration: r.duration, delay };
      if (r.direction) a.direction = r.direction;
      // a shape that became several elements (a group's members): they play together
      r.els.forEach((e, i) => {
        e.animation = i === 0 ? { ...a } : { ...a, trigger: "with-previous", delay: 0, order: ++order };
      });
    }
  }
  if (approx.size) notes.push(`Slide ${slideNo}: PowerPoint's ${[...approx].map(([name, e]) => `${name} animation became ${e}`).join(", ")}.`);
  if (byParagraph) notes.push(`Slide ${slideNo}: text animated paragraph by paragraph animates as a whole box.`);
  if (left.size) notes.push(`Slide ${slideNo}: only entrance animations are kept; left out: ${[...left].map(([what, k]) => `${k} ${what}`).join(", ")}.`);
}
