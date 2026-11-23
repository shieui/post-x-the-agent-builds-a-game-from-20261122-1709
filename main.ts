// main.ts — entry validator for "The agent builds a game from one prompt".
// Node 22, standard library only. It checks the entry's files, then copies
// POST.json into the output directory, as the competition's RULES.txt asks:
// the house reads the post's counts from there after this program runs.
//
// Run:  MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
// Exit 0 when every check passes, 1 otherwise. Output is deterministic:
// the same entry always prints the same report.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type CheckResult = { name: string; ok: boolean; detail: string };

const repoRoot: string = dirname(fileURLToPath(import.meta.url));
const outputDir: string =
  process.env.MAKEFUN_OUTPUT_DIR || "/output";

const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function fileExists(rel: string): boolean {
  return existsSync(join(repoRoot, rel));
}

function readText(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

// --- probe a media file by reading its own bytes (no external program) ---
// The grader's image has no ffprobe, so parse the formats directly:
// MP4 boxes (mvhd timescale/duration, tkhd width/height, stsd codec) and
// WebM EBML (Segment/Info/Duration with TimestampScale). The returned shape
// is the same one the checks below read: { streams: [{ codec_type,
// codec_name, width, height }], format: { duration, size } }.
type Mp4Box = { type: string; content: number; end: number };

function readMp4Box(data: Buffer, at: number, end: number): Mp4Box | null {
  if (at + 8 > end) return null;
  let size = data.readUInt32BE(at);
  let content = at + 8;
  if (size === 1) {
    if (at + 16 > end) return null;
    size = Number(data.readBigUInt64BE(at + 8));
    content = at + 16;
  } else if (size === 0) {
    size = end - at;
  }
  if (size < content - at || at + size > end) return null;
  return { type: data.toString("ascii", at + 4, at + 8), content, end: at + size };
}

function findMp4Child(data: Buffer, box: Mp4Box, type: string): Mp4Box | null {
  let p = box.content;
  while (p + 8 <= box.end) {
    const child = readMp4Box(data, p, box.end);
    if (child === null) return null;
    if (child.type === type) return child;
    p = child.end;
  }
  return null;
}

function eachMp4Child(data: Buffer, box: Mp4Box, fn: (child: Mp4Box) => void): void {
  let p = box.content;
  while (p + 8 <= box.end) {
    const child = readMp4Box(data, p, box.end);
    if (child === null) return;
    fn(child);
    p = child.end;
  }
}

function probeMp4(data: Buffer): Record<string, unknown> | null {
  let moov: Mp4Box | null = null;
  let p = 0;
  while (p + 8 <= data.length) {
    const box = readMp4Box(data, p, data.length);
    if (box === null) return null;
    if (box.type === "moov") {
      moov = box;
      break;
    }
    p = box.end;
  }
  if (moov === null) return null;
  const mvhd = findMp4Child(data, moov, "mvhd");
  if (mvhd === null || mvhd.end - mvhd.content < 20) return null;
  const version = data[mvhd.content];
  const timescale =
    version === 1
      ? data.readUInt32BE(mvhd.content + 20)
      : data.readUInt32BE(mvhd.content + 12);
  if (timescale === 0) return null;
  let durationTicks: number;
  if (version === 1) {
    if (mvhd.end - mvhd.content < 32) return null;
    durationTicks = Number(data.readBigUInt64BE(mvhd.content + 24));
  } else {
    durationTicks = data.readUInt32BE(mvhd.content + 16);
  }
  const duration = durationTicks / timescale;
  const streams: Array<Record<string, unknown>> = [];
  eachMp4Child(data, moov, (trak) => {
    if (trak.type !== "trak") return;
    const mdia = findMp4Child(data, trak, "mdia");
    if (mdia === null) return;
    const hdlr = findMp4Child(data, mdia, "hdlr");
    if (hdlr === null || hdlr.end - hdlr.content < 12) return;
    const handler = data.toString("ascii", hdlr.content + 8, hdlr.content + 12);
    const codecType =
      handler === "vide" ? "video" : handler === "soun" ? "audio" : null;
    if (codecType === null) return;
    let codecName = "";
    let width = 0;
    let height = 0;
    const minf = findMp4Child(data, mdia, "minf");
    const stbl = minf === null ? null : findMp4Child(data, minf, "stbl");
    const stsd = stbl === null ? null : findMp4Child(data, stbl, "stsd");
    if (stsd !== null && stsd.end - stsd.content >= 8) {
      const entries = data.readUInt32BE(stsd.content + 4);
      if (entries >= 1) {
        const entry = readMp4Box(data, stsd.content + 8, stsd.end);
        if (entry !== null) {
          codecName = entry.type;
          if (entry.type === "avc1" && entry.end - entry.content >= 28) {
            width = data.readUInt16BE(entry.content + 24);
            height = data.readUInt16BE(entry.content + 26);
          }
        }
      }
    }
    if (codecType === "video" && (width === 0 || height === 0)) {
      const tkhd = findMp4Child(data, trak, "tkhd");
      if (tkhd !== null) {
        const tver = data[tkhd.content];
        const wOff = tver === 1 ? 88 : 76;
        const hOff = tver === 1 ? 92 : 80;
        if (tkhd.end - tkhd.content >= hOff + 4) {
          width = Math.round(data.readUInt32BE(tkhd.content + wOff) / 65536);
          height = Math.round(data.readUInt32BE(tkhd.content + hOff) / 65536);
        }
      }
    }
    streams.push({
      codec_type: codecType,
      codec_name:
        codecName === "avc1" ? "h264" : codecName === "mp4a" ? "aac" : codecName,
      width,
      height,
    });
  });
  return { streams, format: { duration, size: data.length } };
}

// Read one EBML variable-length integer (size) or element id.
function readEbmlVint(data: Buffer, at: number): { len: number; value: number } | null {
  if (at >= data.length) return null;
  const first = data[at];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    mask >>= 1;
    len++;
  }
  if (len > 8 || at + len > data.length) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < len; i++) value = value * 256 + data[at + i];
  return { len, value };
}

function readEbmlId(data: Buffer, at: number): { len: number; value: number } | null {
  if (at >= data.length) return null;
  const first = data[at];
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && (first & mask) === 0) {
    mask >>= 1;
    len++;
  }
  if (len > 4 || at + len > data.length) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + data[at + i];
  return { len, value };
}

function probeWebm(data: Buffer): Record<string, unknown> | null {
  // Find the Segment element (0x18538067), then its Info child (0x1549a966)
  // for TimestampScale (0x2ad7b1, default 1000000) and Duration (0x4489).
  let segment: { content: number; end: number } | null = null;
  let p = 0;
  while (p < data.length) {
    const id = readEbmlId(data, p);
    if (id === null) return null;
    const size = readEbmlVint(data, p + id.len);
    if (size === null) return null;
    const content = p + id.len + size.len;
    const unknown = size.value === Math.pow(2, 7 * size.len) - 1;
    const end = unknown ? data.length : Math.min(content + size.value, data.length);
    if (id.value === 0x18538067) {
      segment = { content, end };
      break;
    }
    p = end;
  }
  if (segment === null) return null;
  let timestampScale = 1000000;
  let duration: number | null = null;
  let q = segment.content;
  while (q < segment.end) {
    const id = readEbmlId(data, q);
    if (id === null) break;
    const size = readEbmlVint(data, q + id.len);
    if (size === null) break;
    const content = q + id.len + size.len;
    const unknown = size.value === Math.pow(2, 7 * size.len) - 1;
    const end = unknown ? segment.end : Math.min(content + size.value, segment.end);
    if (id.value === 0x1549a966) {
      let r = content;
      while (r < end) {
        const cid = readEbmlId(data, r);
        if (cid === null) break;
        const csize = readEbmlVint(data, r + cid.len);
        if (csize === null) break;
        const ccontent = r + cid.len + csize.len;
        const cend = Math.min(ccontent + csize.value, end);
        if (cid.value === 0x2ad7b1 && csize.value > 0 && csize.value <= 8) {
          let v = 0;
          for (let i = 0; i < csize.value; i++) v = v * 256 + data[ccontent + i];
          timestampScale = v;
        } else if (
          cid.value === 0x4489 &&
          (csize.value === 4 || csize.value === 8) &&
          ccontent + csize.value <= data.length
        ) {
          duration =
            csize.value === 8 ? data.readDoubleBE(ccontent) : data.readFloatBE(ccontent);
        }
        r = cend;
      }
      break;
    }
    q = end;
  }
  if (duration === null) return null;
  return {
    streams: [],
    format: { duration: (duration * timestampScale) / 1e9, size: data.length },
  };
}

function probe(rel: string): Record<string, unknown> | null {
  try {
    const data = readFileSync(join(repoRoot, rel));
    if (
      data.length >= 4 &&
      data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3
    ) {
      return probeWebm(data);
    }
    return probeMp4(data);
  } catch {
    return null;
  }
}

// The press-pack end card, fetched from https://make.fun/press/manifest.json
// when the video was made. Its sha256 pins the file to the official asset.
const END_CARD_SHA256 =
  "286b76c671fa3bf3b1580a7c71675d7b7e502f4fb374b56d30f1104044808cd1";

function sha256File(rel: string): string {
  const data = readFileSync(join(repoRoot, rel));
  return createHash("sha256").update(data).digest("hex");
}

// --- 1. POST.json: present, small, parses, names an X post address --------
const postPath = "POST.json";
if (!fileExists(postPath)) {
  check("post_file", false, "POST.json is missing");
} else {
  const postBytes = statSync(join(repoRoot, postPath)).size;
  check(
    "post_file_size",
    postBytes <= 16384,
    `POST.json is ${postBytes} bytes (cap 16384)`,
  );
  let parsed: unknown = null;
  let parseError = "";
  try {
    parsed = JSON.parse(readText(postPath));
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  if (parsed === null) {
    check("post_file", false, `POST.json does not parse: ${parseError}`);
  } else if (
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).url !== "string"
  ) {
    check("post_file", false, "POST.json is not an object with a url string");
  } else {
    const url = (parsed as Record<string, unknown>).url as string;
    const match =
      /^https:\/\/(?:www\.|mobile\.)?(x\.com|twitter\.com)\/(?:i\/web\/status\/([0-9]+)|([A-Za-z0-9_]{1,15})\/status\/([0-9]+))$/.exec(
        url,
      );
    if (match) {
      const id = match[2] || match[4];
      check("post_url", true, `X post ${match[1]}, status ${id}`);
    } else {
      check(
        "post_url",
        false,
        `url is not an X post address: ${url}`,
      );
    }
  }
}

// --- 2. video.mp4: present, 1080x1920, 20-35 s, has video + audio ---------
const videoPath = "video.mp4";
if (!fileExists(videoPath)) {
  check("video_present", false, "video.mp4 is missing");
} else {
  const info = probe(videoPath);
  if (info === null) {
    check("video_probe", false, "ffprobe could not read video.mp4");
  } else {
    const streams = (info.streams as Array<Record<string, unknown>>) || [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");
    const format = (info.format as Record<string, unknown>) || {};
    const duration = Number(format.duration || 0);
    const width = Number(videoStream?.width || 0);
    const height = Number(videoStream?.height || 0);
    check(
      "video_dimensions",
      width === 1080 && height === 1920,
      `${width}x${height} (want 1080x1920)`,
    );
    check(
      "video_duration",
      duration >= 20 && duration <= 35,
      `${duration.toFixed(2)}s (want 20-35s)`,
    );
    check(
      "video_codec",
      videoStream?.codec_name === "h264",
      `video codec ${String(videoStream?.codec_name || "none")}`,
    );
    check(
      "video_audio",
      audioStream !== undefined,
      audioStream ? `audio codec ${String(audioStream.codec_name)}` : "no audio stream",
    );
    const size = statSync(join(repoRoot, videoPath)).size;
    check("video_size", size > 0 && size < 512 * 1024 * 1024, `${size} bytes`);
  }
}

// --- 3. The game: files present, page loads the game script ---------------
check("game_index", fileExists("game/index.html"), "game/index.html");
check("game_script", fileExists("game/game.js"), "game/game.js");
if (fileExists("game/index.html")) {
  const html = readText("game/index.html");
  check(
    "game_wiring",
    html.includes('src="game.js"'),
    html.includes('src="game.js"')
      ? "index.html loads game.js"
      : "index.html does not reference game.js",
  );
}
if (fileExists("game/game.js")) {
  const js = readText("game/game.js");
  check(
    "game_content",
    js.includes("Star Catcher") && js.includes("requestAnimationFrame"),
    "game.js holds the Star Catcher game loop",
  );
}

// --- 4. The prompt: the one prompt the video is about ----------------------
if (!fileExists("PROMPT.md")) {
  check("prompt_file", false, "PROMPT.md is missing");
} else {
  const prompt = readText("PROMPT.md");
  check(
    "prompt_file",
    prompt.includes("Star Catcher") && prompt.length > 50,
    `${prompt.length} chars, names Star Catcher`,
  );
}

// --- 5. Press-pack end card: the files the video ends with -----------------
check(
  "end_card",
  fileExists("assets/card-9x16.webm"),
  "assets/card-9x16.webm (make.fun referral end card, 9:16, from the press pack)",
);
check(
  "brand_badge",
  fileExists("assets/badge-9x16.png"),
  "assets/badge-9x16.png (make.fun brand badge, 9:16, from the press pack)",
);
if (fileExists("assets/card-9x16.webm")) {
  const card = probe("assets/card-9x16.webm");
  const cardFormat = (card?.format as Record<string, unknown>) || {};
  const cardDuration = Number(cardFormat.duration || 0);
  check(
    "end_card_length",
    cardDuration > 2 && cardDuration < 3,
    `end card is ${cardDuration.toFixed(2)}s long`,
  );
  const digest = sha256File("assets/card-9x16.webm");
  check(
    "end_card_official",
    digest === END_CARD_SHA256,
    digest === END_CARD_SHA256
      ? "sha256 matches the make.fun press-pack manifest"
      : `sha256 ${digest.slice(0, 16)}… does not match the press pack`,
  );
}

// --- 6. README carries the make.fun badges --------------------------------
if (!fileExists("README.md")) {
  check("readme_badges", false, "README.md is missing");
} else {
  const readme = readText("README.md");
  const hasBadges =
    readme.includes("make.fun/badge/post-x-the-agent-builds-a-game-from-20261122-1709.svg") &&
    readme.includes("/rank.svg") &&
    readme.includes("/reward.svg") &&
    readme.includes("ref=6vamqe3w");
  check(
    "readme_badges",
    hasBadges,
    hasBadges
      ? "README carries the three make.fun badges and referral code 6vamqe3w"
      : "README is missing a make.fun badge or the referral code",
  );
}

// --- 7. Ownership claim ----------------------------------------------------
if (!fileExists(".makefun/owner.json")) {
  check("owner_file", false, ".makefun/owner.json is missing");
} else {
  let owner: unknown = null;
  try {
    owner = JSON.parse(readText(".makefun/owner.json"));
  } catch {
    owner = null;
  }
  const wallet =
    owner !== null && typeof owner === "object"
      ? (owner as Record<string, unknown>).wallet
      : undefined;
  check(
    "owner_file",
    typeof wallet === "string" && wallet.length >= 32,
    typeof wallet === "string" ? `wallet ${wallet}` : "no wallet in owner.json",
  );
}

// --- report ------------------------------------------------------------------
let failures = 0;
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  if (!r.ok) failures += 1;
  console.log(`[${mark}] ${r.name}: ${r.detail}`);
}

// Copy POST.json to the output directory, as the competition requires.
if (failures === 0) {
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(join(repoRoot, postPath), join(outputDir, postPath));
  console.log(`[PASS] post_copied: POST.json copied to ${outputDir}/POST.json`);
  console.log("RESULT: PASS");
} else {
  console.log(`RESULT: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
