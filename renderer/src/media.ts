import { brotliDecompressSync, inflateSync } from "node:zlib";

// Small, dependency-free readers: what a file is, how big an image is, and what a font is called.

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  emf: "image/x-emf",
  wmf: "image/x-wmf",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
  wma: "audio/x-ms-wma",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pps: "application/vnd.ms-powerpoint",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  odp: "application/vnd.oasis.opendocument.presentation",
  key: "application/x-iwork-keynote-sffkey",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  zip: "application/zip",
};

export function extOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename ?? "");
  return m ? m[1]!.toLowerCase() : "";
}

export function typeForExt(ext: string): string {
  return EXT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

export function extForType(ct: string): string {
  const c = ct.toLowerCase().split(";")[0]!.trim();
  if (c === "image/jpeg") return "jpg";
  if (c === "audio/mpeg") return "mp3";
  if (c === "video/quicktime") return "mov";
  if (c === "image/svg+xml") return "svg";
  for (const [e, t] of Object.entries(EXT_TYPES)) if (t === c) return e;
  return c.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
}

/** Sniff the real type from magic bytes, falling back to the filename. */
export function sniffType(data: Buffer, filename = ""): string {
  const b = data;
  const s = (i: number, str: string) => b.subarray(i, i + str.length).toString("latin1") === str;
  if (s(0, "\x89PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (s(0, "GIF8")) return "image/gif";
  if (s(0, "RIFF") && s(8, "WEBP")) return "image/webp";
  if (s(0, "RIFF") && s(8, "WAVE")) return "audio/wav";
  if (s(0, "RIFF") && s(8, "AVI ")) return "video/x-msvideo";
  if (s(4, "ftypavif")) return "image/avif";
  if (s(4, "ftypqt")) return "video/quicktime";
  if (s(4, "ftypM4A")) return "audio/mp4";
  if (s(4, "ftyp")) return "video/mp4";
  if (s(0, "%PDF")) return "application/pdf";
  if (s(0, "ID3") || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && extOf(filename) === "mp3")) return "audio/mpeg";
  if (s(0, "OggS")) return extOf(filename) === "ogv" ? "video/ogg" : "audio/ogg";
  if (s(0, "fLaC")) return "audio/flac";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return extOf(filename) === "mkv" ? "video/x-matroska" : "video/webm";
  if (s(0, "wOFF")) return "font/woff";
  if (s(0, "wOF2")) return "font/woff2";
  if (s(0, "OTTO")) return "font/otf";
  if (b.readUInt32BE(0) === 0x00010000 || s(0, "true")) return "font/ttf";
  if (s(0, "\xd0\xcf\x11\xe0")) return "application/vnd.ms-powerpoint";
  if (s(0, "PK\x03\x04")) {
    const ext = extOf(filename);
    if (["pptx", "ppsx", "potx", "odp", "key", "zip"].includes(ext)) return typeForExt(ext);
    const head = b.subarray(0, 4000).toString("latin1");
    if (head.includes("ppt/")) return typeForExt("pptx");
    if (head.includes("application/vnd.oasis.opendocument.presentation")) return typeForExt("odp");
    if (head.includes("Index/Document.iwa") || head.includes("Index.zip")) return typeForExt("key");
    return "application/zip";
  }
  const text = b.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && b.subarray(0, 4096).toString("utf8").includes("<svg"))) return "image/svg+xml";
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<head") || text.startsWith("<body") || text.startsWith("<!--")) return "text/html";
  return typeForExt(extOf(filename));
}

/** Natural size of png/jpeg/gif/webp/svg/bmp images, or null. */
export function imageSize(data: Buffer, ct: string): { width: number; height: number } | null {
  try {
    if (ct === "image/png" && data.length > 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (ct === "image/gif") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (ct === "image/bmp") return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
    if (ct === "image/webp") {
      const kind = data.subarray(12, 16).toString("latin1");
      if (kind === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") {
        const b0 = data[21]!, b1 = data[22]!, b2 = data[23]!, b3 = data[24]!;
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (kind === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    }
    if (ct === "image/jpeg") {
      let i = 2;
      while (i < data.length) {
        if (data[i] !== 0xff) return null;
        const marker = data[i + 1]!;
        const len = data.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    if (ct === "image/svg+xml") {
      const head = data.subarray(0, 4096).toString("utf8");
      const tag = /<svg[^>]*>/i.exec(head)?.[0] ?? "";
      const w = /\swidth="([\d.]+)(px)?"/.exec(tag);
      const h = /\sheight="([\d.]+)(px)?"/.exec(tag);
      if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
      const vb = /viewBox="[\d.\s-]+?\s([\d.]+)\s([\d.]+)"/.exec(tag);
      if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- fonts

function sfntTables(d: Buffer): Map<string, { offset: number; length: number }> {
  const n = d.readUInt16BE(4);
  const out = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    out.set(d.subarray(rec, rec + 4).toString("latin1"), { offset: d.readUInt32BE(rec + 8), length: d.readUInt32BE(rec + 12) });
  }
  return out;
}

function readNameTable(t: Buffer): string | null {
  const count = t.readUInt16BE(2);
  const strOff = t.readUInt16BE(4);
  let best: { prio: number; name: string } | null = null;
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = t.readUInt16BE(r);
    const nameId = t.readUInt16BE(r + 6);
    const len = t.readUInt16BE(r + 8);
    const off = t.readUInt16BE(r + 10);
    if (nameId !== 1 && nameId !== 16) continue; // family / typographic family
    const raw = t.subarray(strOff + off, strOff + off + len);
    const name = platform === 1 ? raw.toString("latin1") : Buffer.from(raw).swap16().toString("utf16le");
    const prio = (nameId === 16 ? 2 : 1) + (platform === 3 ? 1 : 0);
    if (!best || prio > best.prio) best = { prio, name };
  }
  return best?.name.trim() || null;
}

function readUIntBase128(d: Buffer, pos: { i: number }): number {
  let v = 0;
  for (let k = 0; k < 5; k++) {
    const b = d[pos.i++]!;
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return v;
  }
  return v;
}

const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

/** The family name inside a ttf/otf/woff/woff2 font, or null. */
export function fontFamily(data: Buffer): string | null {
  try {
    const sig = data.subarray(0, 4).toString("latin1");
    if (sig === "wOFF") {
      const n = data.readUInt16BE(12);
      for (let i = 0; i < n; i++) {
        const r = 44 + i * 20;
        if (data.subarray(r, r + 4).toString("latin1") !== "name") continue;
        const off = data.readUInt32BE(r + 4);
        const comp = data.readUInt32BE(r + 8);
        const orig = data.readUInt32BE(r + 12);
        const raw = data.subarray(off, off + comp);
        return readNameTable(comp < orig ? inflateSync(raw) : raw);
      }
      return null;
    }
    if (sig === "wOF2") {
      const numTables = data.readUInt16BE(12);
      const pos = { i: 48 };
      let nameOffset = -1;
      let nameLen = 0;
      let acc = 0;
      for (let t = 0; t < numTables; t++) {
        const flags = data[pos.i++]!;
        const tagIdx = flags & 0x3f;
        let tag: string;
        if (tagIdx === 63) {
          tag = data.subarray(pos.i, pos.i + 4).toString("latin1");
          pos.i += 4;
        } else tag = WOFF2_TAGS[tagIdx]!;
        const orig = readUIntBase128(data, pos);
        const transformVersion = (flags >> 6) & 3;
        let length = orig;
        const transformed = tag === "glyf" || tag === "loca" ? transformVersion === 0 : transformVersion !== 0;
        if (transformed) length = readUIntBase128(data, pos);
        if (tag === "name") {
          nameOffset = acc;
          nameLen = length;
        }
        acc += length;
      }
      const totalCompressed = data.readUInt32BE(20);
      const stream = brotliDecompressSync(data.subarray(pos.i, pos.i + totalCompressed));
      return nameOffset >= 0 ? readNameTable(stream.subarray(nameOffset, nameOffset + nameLen)) : null;
    }
    const tables = sfntTables(data);
    const name = tables.get("name");
    return name ? readNameTable(data.subarray(name.offset, name.offset + name.length)) : null;
  } catch {
    return null;
  }
}
