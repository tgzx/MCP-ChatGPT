import fs from "node:fs/promises";
import path from "node:path";
import { LOG_DIR } from "./paths.mjs";

export async function appendLog(kind, payload = {}) {
  await fs.mkdir(LOG_DIR, { recursive: true });

  const filePath = path.join(LOG_DIR, "activity.jsonl");

  const entry = {
    ts: new Date().toISOString(),
    kind,
    ...payload
  };

  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}
