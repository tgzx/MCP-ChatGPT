import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

export const CONFIG_DIR = path.join(ROOT_DIR, "config");
export const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");
export const LOG_DIR = path.join(ROOT_DIR, "logs");
export const SCREENSHOT_DIR = path.join(ROOT_DIR, "screenshots");

export function normalizePath(inputPath) {
  if (!inputPath || String(inputPath).trim() === "") {
    return process.cwd();
  }

  return path.resolve(String(inputPath));
}

export function isDriveRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);

  return resolved.toLowerCase() === parsed.root.toLowerCase();
}

export function isInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertPathAllowed(targetPath, config) {
  const allowedRoots = Array.isArray(config.allowedRoots)
    ? config.allowedRoots.filter(Boolean)
    : [];

  if (allowedRoots.length === 0) {
    return;
  }

  const resolved = path.resolve(targetPath);

  const allowed = allowedRoots.some(root => {
    return isInside(resolved, root);
  });

  if (!allowed) {
    throw new Error([
      `Caminho fora das pastas permitidas: ${resolved}`,
      "Pastas permitidas:",
      ...allowedRoots
    ].join("\n"));
  }
}
