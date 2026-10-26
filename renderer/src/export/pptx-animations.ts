import type { Animation, Element, Slide } from "@silicon-present/deck";

// Element animations as PowerPoint's slide timing (<p:timing>), written into the slide XML pptxgenjs made.
//
// Every effect is one of PowerPoint's own entrance presets (presetClass="entr"), so PowerPoint lists it under its
// usual name and LibreOffice maps it to its matching effect:
//   appear  -> Appear   presetID 1               fly-in -> Fly In  presetID 2,  subtype = where it comes from
//   fade    -> Fade     presetID 10              wipe   -> Wipe    presetID 22, subtype = the side it starts at
//   zoom    -> Zoom     presetID 53, subtype 16  (fade + grow from the object's centre; "Basic Zoom" is 23, no fade)
//   rise    -> Rise Up  presetID 37
// Direction is the way the motion goes (docs/architecture.md, "Motion"): fly-in "up" comes in from the bottom, wipe
// "right" reveals left to right (PowerPoint's "From Left").
//
// Timing follows the player (packages/render slideSteps): a click starts a step (a <p:par> waiting on the click);
// "after-previous" starts a new sub-group at the end of everything so far in the step; "with-previous" joins the
// current sub-group, its delay counted from the start of the animation before it. Each effect's own delay is set so it
// starts exactly when the player starts it. Animations before the first click start with the slide.

/** PowerPoint's presetSubtype for "comes in from": 1 top, 2 right, 4 bottom, 8 left. */
const FLY_FROM: Record<string, number> = { up: 4, down: 1, left: 2, right: 8 };
const WIPE_FROM: Record<string, number> = { right: 8, left: 2, down: 1, up: 4 };
const WIPE_FILTER: Record<string, string> = { right: "wipe(right)", left: "wipe(left)", down: "wipe(down)", up: "wipe(up)" };

const n = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const ms = (v: number) => Math.max(0, Math.round(v));

/** The direction the player uses when an animation has none. */
export function motionDirection(a: Pick<Animation, "effect" | "direction">): "up" | "down" | "left" | "right" | undefined {
  const d = ["up", "down", "left", "right"].includes(a.direction ?? "") ? a.direction : undefined;
  if (a.effect === "fly-in") return d ?? "up";
  if (a.effect === "wipe") return d ?? "right";
  return undefined;
}

/** A slide's animated elements in playing order (order, then z), as the player sorts them. */
export function animationSequence(s: Slide): Element[] {
  return s.elements
    .map((e, z) => ({ e, z }))
    .filter(({ e }) => e.animation)
    .sort((a, b) => n(a.e.animation!.order) - n(b.e.animation!.order) || a.z - b.z)
    .map(({ e }) => e);
}

function sameMotion(a: Animation, b: Animation): boolean {
  return a.effect === b.effect && ms(n(a.duration, 500)) === ms(n(b.duration, 500)) && motionDirection(a) === motionDirection(b);
}

/**
 * How a group's members animate. PowerPoint animates a group as one object, so a group is "together" when its members
 * play as one (consecutive in the sequence, the rest "with-previous" with no delay and the same effect), "still" when
 * none is animated, and "apart" otherwise (it can't be a PowerPoint group without losing animations).
 */
export function groupMotion(members: Element[], s: Slide): "still" | "together" | "apart" {
  const animated = members.filter((e) => e.animation);
  if (!animated.length) return "still";
  if (animated.length !== members.length) return "apart";
  const seq = animationSequence(s);
  const at = members.map((e) => seq.indexOf(e)).sort((a, b) => a - b);
  if (at[at.length - 1]! - at[0]! !== at.length - 1) return "apart";
  const lead = seq[at[0]!]!.animation!;
  for (const i of at.slice(1)) {
    const a = seq[i]!.animation!;
    if (a.trigger !== "with-previous" || ms(n(a.delay)) !== 0 || !sameMotion(a, lead)) return "apart";
  }
  return "together";
}

export interface ShapeRef {
  id: number;
  tag: string;
  chart: boolean;
}

/** Shape ids in a slide's XML by shape name (sp, pic, graphicFrame, cxnSp and grpSp, nested ones too). */
export function shapesByName(xml: string): Map<string, ShapeRef> {
  const out = new Map<string, ShapeRef>();
  for (const m of xml.matchAll(/<p:(sp|pic|graphicFrame|cxnSp|grpSp)>\s*<p:nv\w+>\s*<p:cNvPr id="(\d+)" name="([^"]*)"/g)) {
    let chart = false;
    if (m[1] === "graphicFrame") {
      const end = xml.indexOf("</p:graphicFrame>", m.index!);
      chart = xml.slice(m.index!, end).includes('uri="http://schemas.openxmlformats.org/drawingml/2006/chart"');
    }
    out.set(m[3]!, { id: Number(m[2]), tag: m[1]!, chart });
  }
  return out;
}

/** Give every shape on the slide its own id (pptxgenjs can repeat one, and animations point at shapes by id). */
export function renumberShapes(xml: string): string {
  let k = 0;
  return xml.replace(/<p:cNvPr id="\d+"/g, () => `<p:cNvPr id="${++k}"`);
}

interface Planned {
  e: Element;
  a: Animation;
  step: number;
  /** start of its sub-group within the step, ms */
  sub: number;
  /** its own delay from the start of its sub-group, ms */
  delay: number;
  dur: number;
}

/** Steps and sub-groups, with times as the player plays them. */
function plan(seq: Element[]): Planned[] {
  const out: Planned[] = [];
  let step = 0;
  let prevStart = 0;
  let prevEnd = 0;
  let sub = 0;
  for (const e of seq) {
    const a = e.animation!;
    const dur = Math.max(1, ms(n(a.duration, 500)));
    const delay = ms(n(a.delay));
    let start: number;
    if (a.trigger === "click") {
      step++;
      prevEnd = 0;
      sub = 0;
      start = delay;
    } else if (a.trigger === "after-previous") {
      sub = prevEnd;
      start = prevEnd + delay;
    } else start = prevStart + delay;
    out.push({ e, a, step, sub, delay: start - sub, dur });
    prevStart = start;
    prevEnd = Math.max(prevEnd, start + dur);
  }
  return out;
}

// cTn ids are numbered in document order once the whole timing is put together (1 is the root, 2 the main sequence)
const ID = 'id="#"';

function tgt(spid: number): string {
  return `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
}

function setVisible(spid: number, dur: number): string {
  return (
    `<p:set><p:cBhvr><p:cTn ${ID} dur="${dur}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt(spid)}` +
    `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`
  );
}

function filterIn(spid: number, filter: string, dur: number): string {
  return `<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn ${ID} dur="${dur}"/>${tgt(spid)}</p:cBhvr></p:animEffect>`;
}

function val(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v) ? `<p:fltVal val="${v}"/>` : `<p:strVal val="${v}"/>`;
}

function anim(spid: number, attr: string, from: string, to: string, dur: number, extra: { additive?: boolean; begin?: number; accel?: boolean; decel?: boolean } = {}): string {
  const cTnAttrs = `${ID} dur="${dur}"${extra.decel ? ' decel="100000"' : ""}${extra.accel ? ' accel="100000"' : ""} fill="hold"`;
  const cTn = extra.begin ? `<p:cTn ${cTnAttrs}><p:stCondLst><p:cond delay="${extra.begin}"/></p:stCondLst></p:cTn>` : `<p:cTn ${cTnAttrs}/>`;
  return (
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr${extra.additive ? ' additive="base"' : ""}>${cTn}${tgt(spid)}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr>` +
    `<p:tavLst><p:tav tm="0"><p:val>${val(from)}</p:val></p:tav><p:tav tm="100000"><p:val>${val(to)}</p:val></p:tav></p:tavLst></p:anim>`
  );
}

/** presetID, presetSubtype and the behaviours of one entrance effect. */
function effect(spid: number, a: Animation, dur: number): { id: number; subtype: number; body: string } {
  const dir = motionDirection(a);
  switch (a.effect) {
    case "appear":
      // Appear has no motion; the set lasts the animation's duration so "after previous" waits as long as the player
      return { id: 1, subtype: 0, body: setVisible(spid, dur) };
    case "fly-in": {
      const from = FLY_FROM[dir!]!;
      const x = dir === "left" ? "1+#ppt_w/2" : dir === "right" ? "0-#ppt_w/2" : "#ppt_x";
      const y = dir === "up" ? "1+#ppt_h/2" : dir === "down" ? "0-#ppt_h/2" : "#ppt_y";
      return {
        id: 2,
        subtype: from,
        body: setVisible(spid, 1) + anim(spid, "ppt_x", x, "#ppt_x", dur, { additive: true }) + anim(spid, "ppt_y", y, "#ppt_y", dur, { additive: true }),
      };
    }
    case "wipe":
      return { id: 22, subtype: WIPE_FROM[dir!]!, body: setVisible(spid, 1) + filterIn(spid, WIPE_FILTER[dir!]!, dur) };
    case "zoom":
      return {
        id: 53,
        subtype: 16,
        body: setVisible(spid, 1) + anim(spid, "ppt_w", "0", "#ppt_w", dur) + anim(spid, "ppt_h", "0", "#ppt_h", dur) + filterIn(spid, "fade", dur),
      };
    case "rise": {
      // PowerPoint's Rise Up: in from below with a small overshoot (90% of the time up, 10% settling back)
      const d1 = Math.max(1, Math.round(dur * 0.9));
      const d2 = Math.max(1, dur - d1);
      return {
        id: 37,
        subtype: 0,
        body:
          setVisible(spid, 1) +
          filterIn(spid, "fade", dur) +
          anim(spid, "ppt_x", "#ppt_x", "#ppt_x", dur) +
          anim(spid, "ppt_y", "#ppt_y+1", "#ppt_y-.03", d1, { decel: true }) +
          anim(spid, "ppt_y", "#ppt_y-.03", "#ppt_y", d2, { begin: d1, accel: true }),
      };
    }
    case "fade":
    default:
      return { id: 10, subtype: 0, body: setVisible(spid, 1) + filterIn(spid, "fade", dur) };
  }
}

const NODE_TYPE = { click: "clickEffect", "with-previous": "withEffect", "after-previous": "afterEffect" } as const;

/**
 * The slide's <p:timing>, or "" when nothing on it animates. `shapes` are the slide's shapes by name (element ids are
 * shape names); `groupShape` names the <p:grpSp> of each group that animates together.
 */
export function timingXml(s: Slide, shapes: Map<string, ShapeRef>, groupShape: Map<string, string>): string {
  const planned = plan(animationSequence(s));
  if (!planned.length) return "";
  const builds: string[] = [];
  const built = new Set<number>();
  const animatedGroups = new Set<string>();
  // steps -> sub-groups -> effects
  const steps = new Map<number, Map<number, string[]>>();
  const stepFirst = new Map<number, boolean>();
  for (const p of planned) {
    let ref: ShapeRef | undefined;
    if (p.e.group && groupShape.has(p.e.group)) {
      // a group animating together: one effect on the group, for its first member
      if (animatedGroups.has(p.e.group)) continue;
      animatedGroups.add(p.e.group);
      ref = shapes.get(groupShape.get(p.e.group)!);
    } else ref = shapes.get(p.e.id);
    if (!ref) continue; // left out of the file (an image that couldn't be fetched)
    const fx = effect(ref.id, p.a, p.dur);
    // the first effect of a click step is what the click starts, even if the one before it was left out
    const first = !stepFirst.has(p.step);
    stepFirst.set(p.step, true);
    const trigger = first && p.step > 0 ? "click" : p.a.trigger;
    const xml =
      `<p:par><p:cTn ${ID} presetID="${fx.id}" presetClass="entr" presetSubtype="${fx.subtype}" fill="hold" grpId="0" nodeType="${NODE_TYPE[trigger]}">` +
      `<p:stCondLst><p:cond delay="${p.delay}"/></p:stCondLst><p:childTnLst>${fx.body}</p:childTnLst></p:cTn></p:par>`;
    if (!steps.has(p.step)) steps.set(p.step, new Map());
    const subs = steps.get(p.step)!;
    if (!subs.has(p.sub)) subs.set(p.sub, []);
    subs.get(p.sub)!.push(xml);
    if (!built.has(ref.id)) {
      built.add(ref.id);
      if (ref.tag === "sp") builds.push(`<p:bldP spid="${ref.id}" grpId="0" animBg="1"/>`);
      else if (ref.chart) builds.push(`<p:bldGraphic spid="${ref.id}" grpId="0"><p:bldAsOne/></p:bldGraphic>`);
    }
  }
  if (!steps.size) return "";
  const stepXml = [...steps.entries()].map(([step, subs]) => {
    const subXml = [...subs.entries()].map(([sub, fx]) => `<p:par><p:cTn ${ID} fill="hold"><p:stCondLst><p:cond delay="${sub}"/></p:stCondLst><p:childTnLst>${fx.join("")}</p:childTnLst></p:cTn></p:par>`).join("");
    const start = step === 0 ? `<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>` : `<p:cond delay="indefinite"/>`;
    return `<p:par><p:cTn ${ID} fill="hold"><p:stCondLst>${start}</p:stCondLst><p:childTnLst>${subXml}</p:childTnLst></p:cTn></p:par>`;
  });
  let k = 2;
  return (
    `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>` +
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${stepXml.join("")}</p:childTnLst></p:cTn>` +
    `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
    `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>` +
    `</p:childTnLst></p:cTn></p:par></p:tnLst>${builds.length ? `<p:bldLst>${builds.join("")}</p:bldLst>` : ""}</p:timing>`
  ).replace(/id="#"/g, () => `id="${++k}"`);
}

/** Put <p:timing> where the schema wants it: after the transition, before the slide's extLst. */
export function insertTiming(xml: string, timing: string): string {
  if (!timing) return xml;
  const after = xml.indexOf("</p:cSld>");
  const ext = after >= 0 ? xml.indexOf("<p:extLst>", after) : -1;
  if (ext >= 0) return xml.slice(0, ext) + timing + xml.slice(ext);
  return xml.replace("</p:sld>", `${timing}</p:sld>`);
}
