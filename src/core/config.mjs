import fs from "node:fs/promises";
import { SETTINGS_PATH } from "./paths.mjs";

const DEFAULT_CONFIG = {
  profileName: "mcp-chatgpt-full-pc-dev",
  securityMode: "denylist",
  allowedRoots: [],
  maxCommandTimeoutMs: 300000,
  defaultCommandTimeoutMs: 60000,
  maxOutputChars: 120000,
  shell: {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-Command"],
    windowsHide: true
  },
  browser: {
    preferredChannel: "msedge",
    fallbackToChromium: true,
    width: 1440,
    height: 1000,
    waitMs: 1500,
    fullPage: true,
    waitUntil: "domcontentloaded"
  },
  search: {
    skipDirs: ["node_modules", ".git", ".sfdx", ".sf", "dist", "build", ".next", ".angular"]
  },
  blockedTokens: [],
  blockedRegex: []
};

export async function loadConfig() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const userConfig = JSON.parse(raw);

    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      shell: {
        ...DEFAULT_CONFIG.shell,
        ...(userConfig.shell || {})
      },
      browser: {
        ...DEFAULT_CONFIG.browser,
        ...(userConfig.browser || {})
      },
      search: {
        ...DEFAULT_CONFIG.search,
        ...(userConfig.search || {})
      }
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
