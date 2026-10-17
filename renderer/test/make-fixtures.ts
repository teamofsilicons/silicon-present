// Builds the converter's test fixtures into renderer/test/fixtures/ (committed, so tests don't depend on the tools
// that made them): a rich .pptx made with pptxgenjs (formatted text, bullets, shapes, a group, a custom shape, a
// table, charts, pictures, video, audio, notes, sections, a hidden slide, a transition), the same deck converted by
// LibreOffice to .odp, .ppt and .pdf, a .key made by Keynote (when automation works), and plain media and fonts.
//
// Run: pnpm --filter @silicon-present/renderer fixtures
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { closeBrowser, toPng } from "../src/browser";
import { jobDir } from "../src/config";
import { pptxToKey, soffice, sofficePdfAllSlides } from "../src/office";

const here = dirname(fileURLToPath(import.meta.url));
export const FIX = join(here, "fixtures");

const PICTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
<rect width="800" height="450" fill="#2f5bea"/><circle cx="600" cy="140" r="80" fill="#ffd166"/>
<path d="M0 350 L200 200 L360 320 L520 180 L800 380 L800 450 L0 450 Z" fill="#073b4c"/>
<text x="40" y="80" font-family="Arial" font-size="48" font-weight="700" fill="#fff">Fixture picture</text></svg>`;

function wav(seconds = 1, freq = 440, rate = 8000): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  return b;
}

const GIF_1PX = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

async function richPptx(png: Buffer, jpg: Buffer, mp4: Buffer): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
  pptx.title = "Rich fixture deck";
  pptx.theme = { headFontFace: "Georgia", bodyFontFace: "Arial" };
  pptx.defineSlideMaster({
    title: "TITLE_MASTER",
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: 7.1, w: "100%", h: 0.4, fill: { color: "2F5BEA" } } },
      { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.2, w: 11.7, h: 1.6, fontSize: 48, bold: true, color: "1B1B1F", fontFace: "Georgia" }, text: "" } },
      { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 4.0, w: 11.7, h: 1.4, fontSize: 24, color: "555555" }, text: "" } },
    ],
  });

  pptx.addSection({ title: "Intro" });
  // 1: placeholders inherited from the master, formatted runs, notes
  const s1 = pptx.addSlide({ masterName: "TITLE_MASTER", sectionTitle: "Intro" });
  s1.addText("Rich fixture deck", { placeholder: "title" });
  s1.addText(
    [
      { text: "Bold ", options: { bold: true } },
      { text: "italic ", options: { italic: true } },
      { text: "underline ", options: { underline: { style: "sng" } } },
      { text: "red ", options: { color: "E5484D" } },
      { text: "big ", options: { fontSize: 36 } },
      { text: "mono ", options: { fontFace: "Courier New" } },
      { text: "highlight ", options: { highlight: "FFFF00" } },
      { text: "link", options: { hyperlink: { url: "https://teamofsilicons.com" } } },
    ],
    { placeholder: "body", align: "center" },
  );
  s1.addNotes("Welcome everyone.\nThis is the second line of the notes.");

  // 2: bullets, numbering, indent, a filled text box
  const s2 = pptx.addSlide({ sectionTitle: "Intro" });
  s2.addText("Lists and boxes", { x: 0.5, y: 0.3, w: 12, h: 1, fontSize: 36, bold: true, fontFace: "Georgia", color: "1B1B1F" });
  s2.addText(
    [
      { text: "First bullet", options: { bullet: true, breakLine: true } },
      { text: "Nested bullet", options: { bullet: true, indentLevel: 1, breakLine: true } },
      { text: "Step one", options: { bullet: { type: "number" }, breakLine: true } },
      { text: "Step two", options: { bullet: { type: "number" } } },
    ],
    { x: 0.5, y: 1.5, w: 6, h: 3, fontSize: 24, color: "333333", valign: "top" },
  );
  s2.addText("Boxed text, right aligned", { x: 7, y: 1.5, w: 5.5, h: 1.5, fontSize: 20, align: "right", fill: { color: "FFF3D6" }, line: { color: "B4532A", width: 2 }, color: "B4532A" });
  s2.addNotes("Talk about lists.");

  // 3: shapes
  const s3 = pptx.addSlide();
  s3.background = { color: "F3F5F0" };
  s3.addShape("rect", { x: 0.5, y: 0.5, w: 2.5, h: 1.5, fill: { color: "2F6B4F" }, line: { color: "1C2A22", width: 3 } });
  s3.addShape("ellipse", { x: 3.5, y: 0.5, w: 2.5, h: 1.5, fill: { color: "C2733D" } });
  s3.addText("Rounded", { shape: "roundRect", x: 6.5, y: 0.5, w: 2.5, h: 1.5, fill: { color: "3B6E8F" }, color: "FFFFFF", fontSize: 20, align: "center", valign: "middle", rectRadius: 0.3 });
  s3.addShape("rightArrow", { x: 9.5, y: 0.5, w: 2.5, h: 1.5, fill: { color: "8A9A3B" }, rotate: 30 });
  s3.addShape("star5", { x: 0.5, y: 3, w: 2, h: 2, fill: { color: "F2A93B" } });
  s3.addShape("line", { x: 3.5, y: 3.5, w: 4, h: 0, line: { color: "1B1B1F", width: 4 } });
  s3.addShape("diamond", { x: 8.5, y: 3, w: 2, h: 2, fill: { color: "E2614B" } });

  // 4: table
  const s4 = pptx.addSlide();
  s4.addText("Table", { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 32, bold: true, color: "1B1B1F" });
  s4.addTable(
    [
      [
        { text: "Region", options: { bold: true, fill: { color: "DDE6FF" } } },
        { text: "Q3", options: { bold: true, fill: { color: "DDE6FF" } } },
        { text: "Q4", options: { bold: true, fill: { color: "DDE6FF" } } },
      ],
      ["North", "12", "18"],
      ["South", { text: "9", options: { fill: { color: "E8F3EC" } } }, "11"],
    ] as never,
    { x: 0.5, y: 1.5, w: 8, colW: [3, 2.5, 2.5], rowH: [0.6, 0.6, 0.6], fontSize: 18, color: "1B1B1F", border: { type: "solid", pt: 1, color: "7D7468" } },
  );

  // 5: charts
  const s5 = pptx.addSlide();
  s5.addChart(
    pptx.ChartType.bar,
    [
      { name: "2025", labels: ["Q1", "Q2", "Q3", "Q4"], values: [10, 12.5, 9, 14] },
      { name: "2026", labels: ["Q1", "Q2", "Q3", "Q4"], values: [12, 15, 13, 18] },
    ],
    { x: 0.5, y: 0.5, w: 6, h: 4.5, barDir: "col", showLegend: true, legendPos: "b", showTitle: true, title: "Revenue", chartColors: ["3B6E8F", "E2614B"] },
  );
  s5.addChart(pptx.ChartType.pie, [{ name: "Share", labels: ["North", "South", "East"], values: [50, 30, 20] }], { x: 7, y: 0.5, w: 5.5, h: 4.5, showLegend: true, legendPos: "b" });
  s5.addChart(pptx.ChartType.line, [{ name: "Trend", labels: ["Jan", "Feb", "Mar"], values: [3, 5, 4] }], { x: 0.5, y: 5.2, w: 6, h: 2.2, showLegend: false });

  // 6: pictures and media
  const s6 = pptx.addSlide();
  s6.addImage({ data: "image/png;base64," + png.toString("base64"), x: 0.5, y: 0.5, w: 5.333, h: 3, hyperlink: { url: "https://example.com" }, altText: "Fixture picture" });
  s6.addImage({ data: "image/jpeg;base64," + jpg.toString("base64"), x: 6.5, y: 0.5, w: 3, h: 3 }); // stretched: aspect differs
  s6.addMedia({ type: "video", data: "video/mp4;base64," + mp4.toString("base64"), x: 0.5, y: 4, w: 4.8, h: 2.7, cover: "data:image/png;base64," + png.toString("base64") } as never);
  s6.addMedia({ type: "audio", data: "audio/wav;base64," + wav().toString("base64"), extn: "wav", x: 6.5, y: 4.5, w: 1, h: 1 } as never);

  // 7: hidden
  const s7 = pptx.addSlide();
  s7.hidden = true;
  s7.addText("Hidden slide", { x: 1, y: 1, w: 8, h: 1, fontSize: 32, color: "1B1B1F" });

  // 8: group, custom geometry, unknown object, transition (added below)
  pptx.addSection({ title: "End" });
  const s8 = pptx.addSlide({ sectionTitle: "End" });
  s8.addShape("rect", { x: 1, y: 1, w: 2, h: 1, fill: { color: "12A594" }, objectName: "grouped-a" });
  s8.addShape("ellipse", { x: 3.5, y: 1, w: 2, h: 1, fill: { color: "E5484D" }, objectName: "grouped-b" });
  s8.addText("After the group", { x: 1, y: 5.5, w: 8, h: 1, fontSize: 24, color: "1B1B1F" });

  const raw = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const zip = await JSZip.loadAsync(raw);
  const p = "ppt/slides/slide8.xml";
  let xml = await zip.file(p)!.async("string");
  // wrap the two shapes into a group whose children are drawn at half scale, offset to (1in, 3in)
  const sps = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const a = sps.find((s) => s.includes("grouped-a"))!;
  const b = sps.find((s) => s.includes("grouped-b"))!;
  const E = 914400;
  const grp =
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="90" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="${1 * E}" y="${3 * E}"/><a:ext cx="${2.25 * E}" cy="${0.5 * E}"/><a:chOff x="${1 * E}" y="${1 * E}"/><a:chExt cx="${4.5 * E}" cy="${1 * E}"/></a:xfrm></p:grpSpPr>` +
    a +
    b +
    `</p:grpSp>`;
  xml = xml.replace(a, "").replace(b, "");
  const custom =
    `<p:sp><p:nvSpPr><p:cNvPr id="91" name="Custom shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${7 * E}" y="${1 * E}"/><a:ext cx="${2 * E}" cy="${2 * E}"/></a:xfrm>` +
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="50" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:lnTo><a:pt x="0" y="100"/></a:lnTo><a:lnTo><a:pt x="50" y="60"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>` +
    `<a:solidFill><a:srgbClr val="7A4E3B"/></a:solidFill></p:spPr></p:sp>`;
  const unknown =
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="92" name="Unknown object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${10 * E}" y="${1 * E}"/><a:ext cx="${2 * E}" cy="${1 * E}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="urn:silicon-present:unknown-object"><x:thing xmlns:x="urn:x"/></a:graphicData></a:graphic></p:graphicFrame>`;
  xml = xml.replace("</p:spTree>", grp + custom + unknown + "</p:spTree>");
  xml = xml.replace("</p:cSld>", '</p:cSld><p:transition spd="med"><p:push dir="u"/></p:transition>');
  zip.file(p, xml);
  // slide 3 fades
  const p3 = "ppt/slides/slide3.xml";
  zip.file(p3, (await zip.file(p3)!.async("string")).replace("</p:cSld>", '</p:cSld><p:transition spd="slow"><p:fade/></p:transition>'));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Fonts (OFL, from Google Fonts, subset to the sample text): woff2, woff and ttf, by asking as different browsers. */
async function fonts() {
  const uas: Array<[string, string]> = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "woff2"],
    ["Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko", "woff"],
    ["curl/8", "ttf"],
  ];
  for (const [ua, ext] of uas) {
    const css = await (await fetch("https://fonts.googleapis.com/css2?family=Fraunces:wght@600&text=FrauncesThe%20quick%20brown%20fox%20jumps%20over%20the%20lazy%20dog.%200123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", { headers: { "user-agent": ua } })).text();
    const url = /url\((https:[^)]+)\)/.exec(css)?.[1];
    if (url) writeFileSync(join(FIX, `font.${ext}`), Buffer.from(await (await fetch(url)).arrayBuffer()));
    else console.log(`no ${ext} font served`);
  }
}

async function keyOnly() {
  const job = jobDir();
  try {
    const src = join(job.dir, "rich.pptx");
    writeFileSync(src, readFileSync(join(FIX, "rich.pptx")));
    renameSync((await pptxToKey(src, join(job.dir, "rich.key"))).path, join(FIX, "rich.key"));
    console.log("rich.key made by Keynote");
  } finally {
    job.cleanup();
  }
}

async function main() {
  if (process.argv.includes("--key-only")) return keyOnly();
  if (process.argv.includes("--fonts-only")) return fonts();
  mkdirSync(FIX, { recursive: true });
  const job = jobDir();
  try {
    const png = (await toPng(Buffer.from(PICTURE_SVG), "image/svg+xml")).png;
    writeFileSync(join(FIX, "picture.png"), png);
    writeFileSync(join(FIX, "picture.svg"), PICTURE_SVG);
    writeFileSync(join(FIX, "pixel.gif"), GIF_1PX);
    // jpg through ffmpeg (from the png), small clip and sound
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(FIX, "picture.png"), "-q:v", "4", join(FIX, "picture.jpg")]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", join(FIX, "clip.mp4")]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-t", "1", "-c:v", "libvpx-vp9", "-b:v", "200k", join(FIX, "clip.webm")]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "-b:a", "48k", join(FIX, "tone.mp3")]);
    writeFileSync(join(FIX, "tone.wav"), wav());
    await fonts();
    writeFileSync(
      join(FIX, "page.html"),
      `<!doctype html><html><head><title>A live page</title><style>body{margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#fff;font:600 64px system-ui}</style></head><body><div id="n">0</div><script>let i=0;setInterval(()=>document.getElementById('n').textContent=++i,100)</script></body></html>`,
    );
    const pptx = await richPptx(png, readFileSync(join(FIX, "picture.jpg")), readFileSync(join(FIX, "clip.mp4")));
    writeFileSync(join(FIX, "rich.pptx"), pptx);
    // the same deck through LibreOffice
    const src = join(job.dir, "rich.pptx");
    writeFileSync(src, pptx);
    for (const fmt of ["odp", "ppt"]) renameSync(await soffice(src, fmt, job.dir), join(FIX, `rich.${fmt}`));
    renameSync(await sofficePdfAllSlides(src, job.dir), join(FIX, "rich.pdf"));
    // and Keynote
    try {
      const key = (await pptxToKey(src, join(job.dir, "rich.key"))).path;
      if (existsSync(join(FIX, "rich.key"))) rmSync(join(FIX, "rich.key"), { recursive: true, force: true });
      renameSync(key, join(FIX, "rich.key"));
      console.log("rich.key made by Keynote");
    } catch (e) {
      console.log(`rich.key not made: ${e instanceof Error ? e.message : e}`);
    }
    console.log(`fixtures written to ${FIX}`);
  } finally {
    job.cleanup();
    await closeBrowser();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
