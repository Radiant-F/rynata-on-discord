import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AttachmentBuilder } from "discord.js";
import { ConfigError, isImageName } from "./messageBuilder";
import { listMessages } from "./store";

// Uploaded images live next to the message list. In Docker, mount ./data as a volume.
const dir = path.join(process.cwd(), "data", "images");

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Discord's default upload limit

type Ext = "png" | "jpg" | "gif" | "webp";

/** Looks at the file's first bytes instead of trusting the browser's claim. */
function detectExt(buf: Buffer): Ext | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  const gif = buf.subarray(0, 6).toString("latin1");
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export function saveImage(buf: Buffer): string {
  const ext = detectExt(buf);
  if (!ext) throw new ConfigError("That doesn't look like a PNG, JPG, GIF or WEBP image");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

export function readImage(name: string): Buffer | null {
  if (!isImageName(name)) return null;
  try {
    return fs.readFileSync(path.join(dir, name));
  } catch {
    return null;
  }
}

/** The attachment Discord receives. Always called "image.<ext>". */
export function imageAttachment(name: string): AttachmentBuilder {
  const buf = readImage(name);
  if (!buf) throw new ConfigError("The image file is missing, please upload it again");
  return new AttachmentBuilder(buf, { name: `image.${name.split(".").pop()}` });
}

/** Deletes an image file once no stored message uses it anymore. */
export function pruneImage(name: string | undefined) {
  if (!name || !isImageName(name)) return;
  if (listMessages().some((m) => m.config.image === name)) return;
  fs.rmSync(path.join(dir, name), { force: true });
}

/** On startup: remove uploads that were never used and are older than a day. */
export function sweepImages() {
  if (!fs.existsSync(dir)) return;
  const used = new Set(listMessages().map((m) => m.config.image));
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!used.has(name) && fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}
