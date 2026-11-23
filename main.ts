// main.ts — entry validator for "The agent builds a game from one prompt".
// Node 22, standard library only. It checks the entry's files, then copies
// POST.json into the output directory, as the competition's RULES.txt asks:
// the house reads the post's counts from there after this program runs.
//
// Run:  MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
// Exit 0 when every check passes, 1 otherwise. Output is deterministic:
// the same entry always prints the same report.

import { execFileSync } from "node:child_process";
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

// --- probe a media file with ffprobe (JSON output, no shell involved) ---
function probe(rel: string): Record<string, unknown> | null {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height",
        "-show_entries",
        "format=duration,size",
        "-of",
        "json",
        join(repoRoot, rel),
      ],
      { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(out) as Record<string, unknown>;
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
