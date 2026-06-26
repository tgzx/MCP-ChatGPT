import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { launchHeadlessBrowser } from "../core/browser.mjs";
import { appendLog } from "../core/logger.mjs";
import { imageResult } from "../core/result.mjs";
import { SCREENSHOT_DIR } from "../core/paths.mjs";
import { redactSensitiveText } from "../core/redact.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function registerBrowserTools(server, context) {
  server.tool(
    "screenshot_url",
    "Abre uma URL em Edge headless, com fallback Chromium, e retorna screenshot.",
    {
      url: z.string(),
      waitMs: z.number().int().min(0).max(30000).default(context.config.browser?.waitMs || 1500),
      fullPage: z.boolean().default(context.config.browser?.fullPage ?? true),
      width: z.number().int().min(320).max(3840).default(context.config.browser?.width || 1440),
      height: z.number().int().min(240).max(2160).default(context.config.browser?.height || 1000),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default(
        context.config.browser?.waitUntil || "domcontentloaded"
      )
    },
    async ({ url, waitMs, fullPage, width, height, waitUntil }) => {
      await fs.mkdir(SCREENSHOT_DIR, {
        recursive: true
      });

      const outputPath = path.join(SCREENSHOT_DIR, `url-${timestamp()}.png`);

      const { browser, browserName } = await launchHeadlessBrowser(context.config);

      const page = await browser.newPage({
        viewport: {
          width,
          height
        }
      });

      const notes = [];

      page.on("pageerror", error => {
        notes.push(`PAGEERROR: ${error.message}`);
      });

      page.on("console", message => {
        const type = message.type();

        if (["error", "warning"].includes(type)) {
          notes.push(`CONSOLE ${type}: ${message.text()}`);
        }
      });

      let response = null;

      try {
        response = await page.goto(url, {
          waitUntil,
          timeout: 60000
        });

        if (waitMs > 0) {
          await page.waitForTimeout(waitMs);
        }

        const title = await page.title().catch(() => "");
        const finalUrl = page.url();

        const buffer = await page.screenshot({
          path: outputPath,
          fullPage
        });

        await browser.close();

        await appendLog("screenshot_url", {
          url: redactSensitiveText(url),
          finalUrl: redactSensitiveText(finalUrl),
          outputPath,
          browserName,
          width,
          height,
          fullPage,
          waitUntil
        });

        const note = JSON.stringify({
          savedAt: outputPath,
          browser: browserName,
          requestedUrl: redactSensitiveText(url),
          finalUrl: redactSensitiveText(finalUrl),
          title,
          httpStatus: response ? response.status() : null,
          notes: notes.map(note => redactSensitiveText(note))
        }, null, 2);

        return imageResult(note, buffer.toString("base64"));
      } catch (error) {
        await browser.close();

        throw new Error([
          `Falha ao abrir URL em modo headless: ${redactSensitiveText(url)}`,
          `Browser usado: ${browserName}`,
          error.message
        ].join("\n"));
      }
    }
  );
}
