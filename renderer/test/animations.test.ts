// Element animations through PowerPoint's slide timing, through the running converter:
//   deck -> pptx writes each animation as PowerPoint's own entrance preset (effect, trigger, order, duration, delay,
//   direction), pptx -> deck reads them back field for field, and LibreOffice carries them into .odp and back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import { normalizeDeck } from "@silicon-present/deck";
import type { Animation, DeckJson } from "@silicon-present/deck";
import { HAVE } from "../src/config";
import { importPptx } from "../src/import/pptx";
import { attr, child, find, findAll, kids, parseXml, type XNode } from "../src/import/xml";
import { type Converter, exportDeck, importThrough, startAssetServer, startConverter } from "./helpers";

let c: Converter;
let assets: Awaited<ReturnType<typeof startAssetServer>>;

before(async () => {
  [c, assets] = await Promise.all([startConverter(), startAssetServer()]);
});
after(async () => {
  await c.stop();
  assets.server.close();
});

async function exportAs(format: string, deck: DeckJson) {
  const r = await c.post("/export", { deck, format, assetBase: assets.base });
  return { status: r.status, warnings: decodeURIComponent(r.headers.get("x-converter-warnings") ?? ""), data: Buffer.from(await r.arrayBuffer()) };
}

const rt = (t: string) => ({ paragraphs: [{ runs: [{ text: t }] }] });
let z = 0;
function box(id: string, animation: Partial<Animation> | null, extra: Record<string, unknown> = {}) {
  const i = z++;
  return { id, kind: "shape", shape: "rect", x: 60 + (i % 8) * 220, y: 80 + Math.floor(i / 8) * 260, w: 180, h: 180, text: rt(id), animation, ...extra };
}

/** Every effect, every direction, every trigger, delays and odd durations, over three slides. */
function animatedDeck(): DeckJson {
  z = 0;
  const A = (effect: Animation["effect"], trigger: Animation["trigger"], order: number, duration: number, delay: number, direction?: Animation["direction"]): Animation => ({ effect, trigger, order, duration, delay, ...(direction ? { direction } : {}) });
  return normalizeDeck({
    title: "Animations",
    master: { elements: [{ id: "e_m00001", kind: "text", x: 40, y: 1000, w: 600, h: 60, text: rt("Footer"), animation: A("fade", "click", 1, 500, 0) }] },
    slides: [
      {
        id: "s_a00001",
        hideMaster: false,
        elements: [
          // starts with the slide: with previous, then after previous
          box("e_a00001", A("fade", "with-previous", 1, 500, 0)),
          box("e_a00002", A("appear", "after-previous", 2, 0, 250)),
          // click 1: fly-in left, zoom with it (delayed), rise after both
          box("e_a00003", A("fly-in", "click", 3, 600, 100, "left")),
          box("e_a00004", A("zoom", "with-previous", 4, 400, 50)),
          box("e_a00005", A("rise", "after-previous", 5, 750, 200)),
          // click 2: the other fly-in directions, all together
          box("e_a00006", A("fly-in", "click", 6, 500, 0, "right")),
          box("e_a00007", A("fly-in", "with-previous", 7, 500, 0, "up")),
          box("e_a00008", A("fly-in", "with-previous", 8, 333, 120, "down")),
          // click 3..6: every wipe direction, an appear that lasts
          box("e_a00009", A("wipe", "click", 9, 700, 0, "up")),
          box("e_a0000a", A("wipe", "click", 10, 700, 0, "down")),
          box("e_a0000b", A("wipe", "after-previous", 11, 300, 0, "left")),
          box("e_a0000c", A("wipe", "click", 12, 900, 400, "right")),
          box("e_a0000d", A("appear", "after-previous", 13, 500, 0)),
          box("e_a0000e", null),
        ],
      },
      {
        id: "s_a00002",
        elements: [
          // a group that animates as one, a still group, a group whose members animate one by one
          box("e_b00001", A("fade", "click", 1, 500, 0), { group: "g_000001" }),
          box("e_b00002", A("fade", "with-previous", 2, 500, 0), { group: "g_000001" }),
          box("e_b00003", null, { group: "g_000002" }),
          box("e_b00004", null, { group: "g_000002" }),
          box("e_b00005", A("zoom", "click", 3, 500, 0), { group: "g_000003" }),
          box("e_b00006", A("rise", "after-previous", 4, 500, 0), { group: "g_000003" }),
        ],
      },
      { id: "s_a00003", elements: [box("e_c00001", null)] },
    ],
  } as never);
}

function shapeIds(xml: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const n of findAll(parseXml(xml), "p:cNvPr")) ids.set(attr(n, "name")!, attr(n, "id")!);
  return ids;
}

/** The effect time node pointing at this shape id, with its click step and sub-group. */
function effectFor(xml: string, spid: string): { fx: XNode; sub: XNode; step: XNode; stepIndex: number } {
  const main = findAll(parseXml(xml), "p:cTn").find((n) => attr(n, "nodeType") === "mainSeq")!;
  const steps = kids(child(main, "p:childTnLst"), "p:par");
  for (const [stepIndex, sp] of steps.entries()) {
    for (const subPar of kids(child(child(sp, "p:cTn"), "p:childTnLst"), "p:par")) {
      for (const fxPar of kids(child(child(subPar, "p:cTn"), "p:childTnLst"), "p:par")) {
        const fx = child(fxPar, "p:cTn")!;
        if (attr(find(fx, "p:spTgt"), "spid") === spid) return { fx, sub: child(subPar, "p:cTn")!, step: child(sp, "p:cTn")!, stepIndex };
      }
    }
  }
  throw new Error(`no effect for shape ${spid}`);
}

const delayOf = (n: XNode) => attr(find(child(n, "p:stCondLst"), "p:cond"), "delay");
/** How long an effect runs: the latest begin + dur of its behaviours. */
const durationOf = (fx: XNode) => Math.max(...findAll(fx, "p:cBhvr").map((b) => Number(delayOf(child(b, "p:cTn")!) ?? 0) + Number(attr(child(b, "p:cTn"), "dur"))));
const animations = (d: DeckJson) => new Map(d.slides.flatMap((s) => s.elements.map((e) => [e.id, e.animation] as const)));

test("pptx: every animation is PowerPoint's own entrance preset with its trigger, timing and direction", async () => {
  const r = await exportAs("pptx", animatedDeck());
  assert.equal(r.status, 200, r.data.toString().slice(0, 300));
  const zip = await JSZip.loadAsync(r.data);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  assert.equal(XMLValidator.validate(xml), true, "well-formed XML");
  // timing sits after the transition and clrMapOvr, as the schema orders them
  assert.match(xml, /<\/p:clrMapOvr>(<mc:AlternateContent[\s\S]*<\/mc:AlternateContent>)?<p:timing>[\s\S]*<\/p:timing><\/p:sld>$/);
  const ids = shapeIds(xml);
  const shapeIdList = [...ids.values()];
  assert.equal(new Set(shapeIdList).size, shapeIdList.length, "every shape has its own id");
  const ctnIds = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(ctnIds, ctnIds.map((_, i) => i + 1), "time node ids are unique, in document order");

  // [element, presetID, presetSubtype, nodeType, effect delay, sub-group start, click step, duration]
  const expected: Array<[string, string, string, string, string, string, number, number]> = [
    ["e_a00001", "10", "0", "withEffect", "0", "0", 0, 500],
    ["e_a00002", "1", "0", "afterEffect", "250", "500", 0, 1], // appear: instant (0 ms is PowerPoint's 1)
    ["e_a00003", "2", "2", "clickEffect", "100", "0", 1, 600], // fly-in left comes in from the right
    ["e_a00004", "53", "16", "withEffect", "150", "0", 1, 400], // with previous: 50 ms after the fly-in started
    ["e_a00005", "37", "0", "afterEffect", "200", "700", 1, 750], // after both: the fly-in ends at 700
    ["e_a00006", "2", "8", "clickEffect", "0", "0", 2, 500], // right: from the left
    ["e_a00007", "2", "4", "withEffect", "0", "0", 2, 500], // up: from the bottom
    ["e_a00008", "2", "1", "withEffect", "120", "0", 2, 333], // down: from the top
    ["e_a00009", "22", "4", "clickEffect", "0", "0", 3, 700], // wipe up starts at the bottom
    ["e_a0000a", "22", "1", "clickEffect", "0", "0", 4, 700],
    ["e_a0000b", "22", "2", "afterEffect", "0", "700", 4, 300],
    ["e_a0000c", "22", "8", "clickEffect", "400", "0", 5, 900], // right: reveals left to right
    ["e_a0000d", "1", "0", "afterEffect", "0", "1300", 5, 500],
  ];
  for (const [el, preset, subtype, nodeType, delay, sub, step, dur] of expected) {
    const { fx, sub: subTn, step: stepTn, stepIndex } = effectFor(xml, ids.get(el)!);
    assert.equal(attr(fx, "presetClass"), "entr", el);
    assert.equal(attr(fx, "presetID"), preset, `${el} presetID`);
    assert.equal(attr(fx, "presetSubtype"), subtype, `${el} presetSubtype`);
    assert.equal(attr(fx, "nodeType"), nodeType, `${el} nodeType`);
    assert.equal(attr(fx, "grpId"), "0", `${el} grpId`);
    assert.equal(delayOf(fx), delay, `${el} delay`);
    assert.equal(delayOf(subTn), sub, `${el} sub-group start`);
    assert.equal(stepIndex, step, `${el} click step`);
    const conds = kids(child(stepTn, "p:stCondLst"), "p:cond");
    assert.equal(attr(conds[0], "delay"), "indefinite", `${el} step waits for a click or the slide`);
    assert.equal(conds.some((cnd) => attr(cnd, "evt") === "onBegin"), step === 0, `${el}: only step 0 starts with the slide`);
    assert.equal(durationOf(fx), dur, `${el} duration`);
    // every behaviour targets the same shape, and it becomes visible
    assert.ok(findAll(fx, "p:spTgt").every((t) => attr(t, "spid") === ids.get(el)));
    assert.equal(textOf(find(fx, "p:attrName")), "style.visibility");
    assert.match(xml, new RegExp(`<p:bldP spid="${ids.get(el)}" grpId="0" animBg="1"/>`), `${el} build entry`);
  }
  // the behaviours of each effect
  const fx = (el: string) => effectFor(xml, ids.get(el)!).fx;
  const filters = (n: XNode) => findAll(n, "p:animEffect").map((e) => attr(e, "filter"));
  const animated = (n: XNode) => findAll(n, "p:anim").map((a) => `${textOf(find(a, "p:attrName"))}:${findAll(a, "p:tav").map((t) => attr(child(child(t, "p:val"), "p:strVal") ?? child(child(t, "p:val"), "p:fltVal"), "val")).join(">")}`);
  assert.deepEqual(filters(fx("e_a00001")), ["fade"]);
  assert.deepEqual(animated(fx("e_a00003")), ["ppt_x:1+#ppt_w/2>#ppt_x", "ppt_y:#ppt_y>#ppt_y"]);
  assert.deepEqual(animated(fx("e_a00006")), ["ppt_x:0-#ppt_w/2>#ppt_x", "ppt_y:#ppt_y>#ppt_y"]);
  assert.deepEqual(animated(fx("e_a00007")), ["ppt_x:#ppt_x>#ppt_x", "ppt_y:1+#ppt_h/2>#ppt_y"]);
  assert.deepEqual(animated(fx("e_a00008")), ["ppt_x:#ppt_x>#ppt_x", "ppt_y:0-#ppt_h/2>#ppt_y"]);
  assert.deepEqual(animated(fx("e_a00004")), ["ppt_w:0>#ppt_w", "ppt_h:0>#ppt_h"]);
  assert.deepEqual(filters(fx("e_a00004")), ["fade"]);
  assert.deepEqual(animated(fx("e_a00005")), ["ppt_x:#ppt_x>#ppt_x", "ppt_y:#ppt_y+1>#ppt_y-.03", "ppt_y:#ppt_y-.03>#ppt_y"]);
  assert.deepEqual(filters(fx("e_a00005")), ["fade"]);
  assert.deepEqual(["e_a00009", "e_a0000a", "e_a0000b", "e_a0000c"].map((e) => filters(fx(e))[0]), ["wipe(up)", "wipe(down)", "wipe(left)", "wipe(right)"]);
  assert.deepEqual(filters(fx("e_a00002")), []);
  // the master's footer is on the slide but doesn't animate (the player doesn't animate master elements)
  assert.ok(ids.has("e_m00001"));
  assert.ok(!xml.includes(`<p:spTgt spid="${ids.get("e_m00001")}"/>`));
  assert.ok(!xml.includes(`spid="${ids.get("e_a0000e")}"`), "an element without animation isn't in the timing");
  // a slide without animations has no timing
  assert.ok(!(await zip.file("ppt/slides/slide3.xml")!.async("string")).includes("<p:timing>"));
});

test("pptx: a group animating as one is one effect on the group; members animating apart are left ungrouped", async () => {
  const r = await exportAs("pptx", animatedDeck());
  const xml = await (await JSZip.loadAsync(r.data)).file("ppt/slides/slide2.xml")!.async("string");
  assert.equal(XMLValidator.validate(xml), true);
  const ids = shapeIds(xml);
  assert.equal((xml.match(/<p:grpSp>/g) ?? []).length, 2, "the together group and the still group are groups");
  const groups = findAll(parseXml(xml), "p:grpSp").map((g) => ({ id: attr(find(g, "p:cNvPr"), "id")!, members: findAll(g, "p:cNvPr").slice(1).map((n) => attr(n, "name")) }));
  const together = groups.find((g) => g.members.includes("e_b00001"))!;
  assert.deepEqual(together.members, ["e_b00001", "e_b00002"]);
  assert.deepEqual(groups.find((g) => g.members.includes("e_b00003"))!.members, ["e_b00003", "e_b00004"]);
  const { fx } = effectFor(xml, together.id);
  assert.equal(attr(fx, "presetID"), "10");
  assert.equal(attr(fx, "nodeType"), "clickEffect");
  assert.ok(!xml.includes(`spid="${ids.get("e_b00001")}"`) && !xml.includes(`spid="${ids.get("e_b00002")}"`), "members aren't targeted inside the group");
  assert.ok(!xml.includes(`<p:bldP spid="${together.id}"`), "no build entry for a group");
  // members animating one by one: loose shapes, each with its own effect, and a warning
  assert.equal(attr(effectFor(xml, ids.get("e_b00005")!).fx, "presetID"), "53");
  assert.equal(attr(effectFor(xml, ids.get("e_b00006")!).fx, "presetID"), "37");
  assert.match(r.warnings, /Slide 2: grouped elements animate one by one, so they were left ungrouped/);
});

test("pptx round trip: deck -> pptx -> deck keeps every animation field", async () => {
  // order comes back as each animation's place on its slide (1, 2, 3...), so it is exact for decks numbered that way
  // and keeps the sequence otherwise (the contract deck's empty image isn't exported, so the ones after it move up)
  for (const [orig, exact] of [[animatedDeck(), true], [exportDeck(), false]] as const) {
    const r = await exportAs("pptx", orig);
    const back = await importThrough(c, "deck.pptx", r.data);
    assert.equal(back.status, 200);
    const got = animations(back.deck);
    for (const s of orig.slides) {
      const sent = s.elements.filter((e) => !(e.kind === "image" && !e.src));
      for (const e of sent) {
        if (exact) assert.deepEqual(got.get(e.id), e.animation, `${e.id} on ${s.id}`);
        else assert.deepEqual(got.get(e.id) && { ...got.get(e.id), order: 0 }, e.animation && { ...e.animation, order: 0 }, `${e.id} on ${s.id}`);
      }
      const seq = (f: (id: string) => Animation | null | undefined) => sent.filter((e) => e.animation).sort((a, b) => f(a.id)!.order - f(b.id)!.order).map((e) => e.id);
      assert.deepEqual(seq((id) => got.get(id)), seq((id) => s.elements.find((e) => e.id === id)!.animation), `${s.id} sequence`);
    }
    assert.ok(back.deck.master.elements.every((e) => !e.animation));
  }
  // the group that animated as one is still a group
  const back = (await importThrough(c, "deck.pptx", (await exportAs("pptx", animatedDeck())).data)).deck;
  const g = back.slides[1]!.elements.filter((e) => e.id === "e_b00001" || e.id === "e_b00002");
  assert.ok(g[0]!.group && g[0]!.group === g[1]!.group);
});

test("pptx import: PowerPoint's other entrance presets become the closest effect, with a note", async () => {
  const r = await exportAs("pptx", animatedDeck());
  const zip = await JSZip.loadAsync(r.data);
  let xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const ids = shapeIds(xml);
  const retag = (el: string, from: RegExp, to: string) => {
    const fx = effectFor(xml, ids.get(el)!).fx;
    const open = `<p:cTn id="${attr(fx, "id")}" `;
    const at = xml.indexOf(open);
    const end = xml.indexOf(">", at);
    xml = xml.slice(0, at) + xml.slice(at, end).replace(from, to) + xml.slice(end);
  };
  retag("e_a00001", /presetID="10"/, 'presetID="26"'); // Bounce: unknown here -> fade
  retag("e_a00005", /presetID="37"/, 'presetID="42"'); // Float In -> rise
  retag("e_a00004", /presetID="53" presetClass="entr" presetSubtype="16"/, 'presetID="23" presetClass="entr" presetSubtype="16"'); // Basic Zoom
  retag("e_a00009", /presetClass="entr"/, 'presetClass="exit"'); // an exit: left out
  zip.file("ppt/slides/slide1.xml", xml);
  const imp = await importPptx(await zip.generateAsync({ type: "nodebuffer" }));
  const got = animations(imp.deck);
  assert.equal(got.get("e_a00001")!.effect, "fade");
  assert.equal(got.get("e_a00005")!.effect, "rise");
  assert.equal(got.get("e_a00004")!.effect, "zoom");
  assert.equal(got.get("e_a00009"), null, "an exit effect is not an entrance");
  assert.deepEqual(got.get("e_a00003"), { effect: "fly-in", trigger: "click", order: 3, duration: 600, delay: 100, direction: "left" });
  assert.equal(imp.notes.length, 2, imp.notes.join("\n"));
  assert.match(imp.notes[0]!, /^Slide 1: PowerPoint's .*entrance effect 26 animation became fade/);
  assert.match(imp.notes[0]!, /Float In animation became rise/);
  assert.match(imp.notes[0]!, /Basic Zoom animation became zoom/);
  assert.equal(imp.notes[1], "Slide 1: only entrance animations are kept; left out: 1 exit.");
});

test("odp: LibreOffice keeps every animation, and it comes back from the .odp", { skip: HAVE.soffice() ? false : "LibreOffice is not installed" }, async () => {
  const orig = animatedDeck();
  const r = await exportAs("odp", orig);
  assert.equal(r.status, 200, r.data.toString().slice(0, 300));
  const content = await (await JSZip.loadAsync(r.data)).file("content.xml")!.async("string");
  const presets = [...content.matchAll(/presentation:node-type="([^"]+)" presentation:preset-class="entrance" presentation:preset-id="([^"]+)"(?: presentation:preset-sub-type="([^"]+)")?/g)].map((m) => `${m[1]} ${m[2]}${m[3] ? " " + m[3] : ""}`);
  assert.deepEqual(presets.slice(0, 13), [
    "with-previous ooo-entrance-fade-in",
    "after-previous ooo-entrance-appear",
    "on-click ooo-entrance-fly-in from-right",
    "with-previous ooo-entrance-fade-in-and-zoom in",
    "after-previous ooo-entrance-rise-up",
    "on-click ooo-entrance-fly-in from-left",
    "with-previous ooo-entrance-fly-in from-bottom",
    "with-previous ooo-entrance-fly-in from-top",
    "on-click ooo-entrance-wipe from-bottom",
    "on-click ooo-entrance-wipe from-top",
    "after-previous ooo-entrance-wipe from-right",
    "on-click ooo-entrance-wipe from-left",
    "after-previous ooo-entrance-appear",
  ]);
  // and back: .odp -> (LibreOffice) .pptx -> deck
  const back = await importThrough(c, "deck.odp", r.data);
  assert.equal(back.status, 200);
  const got = animations(back.deck);
  for (const e of orig.slides[0]!.elements) assert.deepEqual(got.get(e.id), e.animation, e.id);
});

function textOf(n: XNode | undefined): string {
  return n ? (n.name === "#text" ? n.text : n.children.map(textOf).join("")) : "";
}
