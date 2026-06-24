import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { appendLog } from "../core/logger.mjs";
import { imageResult, jsonResult, textResult } from "../core/result.mjs";
import { SCREENSHOT_DIR } from "../core/paths.mjs";
import {
  closeAllBrowserSessions,
  closeBrowserSession,
  createBrowserSession,
  getBrowserRef,
  getBrowserSession,
  listBrowserSessions,
  setBrowserRefs
} from "../core/browserStore.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function compactEvents(events, maxEvents) {
  return events.slice(-maxEvents);
}
function formatBounds(bounds) {
  if (!bounds) {
    return "x=? y=? w=? h=?";
  }

  return `x=${Math.round(bounds.x)} y=${Math.round(bounds.y)} w=${Math.round(bounds.width)} h=${Math.round(bounds.height)}`;
}

function formatSnapshot(snapshot, session, maxTextLines) {
  const lines = [];
  const consoleErrors = [
    ...session.consoleMessages.filter(item => ["error", "warning"].includes(item.type)),
    ...session.pageErrors
  ].slice(-10);

  lines.push(`Session: ${session.sessionId}`);
  lines.push(`URL: ${snapshot.url}`);
  lines.push(`Title: ${snapshot.title || ""}`);
  lines.push(`Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`);
  lines.push(`Scroll: ${snapshot.scroll.y} / ${snapshot.scroll.maxY}`);
  lines.push(`Frames: ${snapshot.frames.length}`);
  if (consoleErrors.length > 0) {
    lines.push("");
    lines.push("Recent console/page errors:");

    for (const item of consoleErrors) {
      lines.push(`- ${item.type || "pageerror"}: ${item.text || item.message}`);
    }
  }

  lines.push("");
  lines.push("Clickable elements:");

  for (const item of snapshot.clickableElements) {
    lines.push(`[${item.ref}] ${item.role || item.tag} "${item.name}" ${formatBounds(item.bounds)} visible=${item.visible} disabled=${item.disabled}`);
  }

  lines.push("");
  lines.push("Editable fields:");

  for (const item of snapshot.editableFields) {
    const value = item.value ? ` value="${item.value}"` : "";
    lines.push(`[${item.ref}] ${item.role || item.tag} "${item.name}"${value} ${formatBounds(item.bounds)} visible=${item.visible} disabled=${item.disabled}`);
  }

  lines.push("");
  lines.push("Main visible text:");

  for (const text of snapshot.mainVisibleText.slice(0, maxTextLines)) {
    lines.push(`- ${text}`);
  }

  return lines.join("\n");
}

function refSelector(ref) {
  return `[data-mcp-ref="${String(ref).replaceAll('"', '\\"')}"]`;
}
function resolveLocator(session, target) {
  if (target.selector) {
    return session.page.locator(target.selector).first();
  }

  if (target.ref) {
    const savedRef = getBrowserRef(session, target.ref);
    return session.page.locator(savedRef.selector || refSelector(savedRef.ref)).first();
  }

  throw new Error("Informe ref ou selector para localizar o elemento.");
}

async function collectSnapshot(page, options) {
  return page.evaluate(({ maxElements, includeHidden, maxTextLines }) => {
    const oldRefs = document.querySelectorAll("[data-mcp-ref]");
    oldRefs.forEach(element => element.removeAttribute("data-mcp-ref"));

    const candidateSelector = [
      "a", "button", "input", "textarea", "select", "summary",
      "[role]", "[onclick]", "[tabindex]", "[contenteditable='true']"
    ].join(",");

    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isElementVisible(element, rect) {
      const style = window.getComputedStyle(element);
      const hasBox = rect.width > 0 && rect.height > 0;
      const visibleStyle = style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
      return hasBox && visibleStyle;
    }

    function getName(element) {
      return clean(
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        element.innerText ||
        element.value ||
        element.name ||
        element.id ||
        element.tagName.toLowerCase()
      ).slice(0, 120);
    }
    function getRole(element) {
      const tag = element.tagName.toLowerCase();
      return element.getAttribute("role") ||
        (tag === "a" ? "link" : null) ||
        (tag === "button" ? "button" : null) ||
        (["input", "textarea", "select"].includes(tag) ? "field" : null) ||
        tag;
    }

    function isEditable(element) {
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      return tag === "textarea" || tag === "select" ||
        (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "hidden", "image", "file"].includes(type)) ||
        element.getAttribute("contenteditable") === "true";
    }
    function isClickable(element) {
      const tag = element.tagName.toLowerCase();
      const role = String(element.getAttribute("role") || "").toLowerCase();
      const tabIndex = element.getAttribute("tabindex");
      return ["a", "button", "summary", "select"].includes(tag) ||
        ["button", "link", "menuitem", "tab", "option", "checkbox", "radio"].includes(role) ||
        element.hasAttribute("onclick") ||
        (tabIndex !== null && tabIndex !== "-1");
    }

    const refs = [];
    const clickableElements = [];
    const editableFields = [];
    let refCounter = 1;

    const candidates = [...document.querySelectorAll(candidateSelector)];

    for (const element of candidates) {
      if (refs.length >= maxElements) {
        break;
      }

      const rect = element.getBoundingClientRect();
      const visible = isElementVisible(element, rect);
      const editable = isEditable(element);
      const clickable = isClickable(element);

      if (!includeHidden && !visible) {
        continue;
      }

      if (!editable && !clickable) {
        continue;
      }

      const ref = String(refCounter++);
      element.setAttribute("data-mcp-ref", ref);

      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };

      const item = {
        ref,
        selector: `[data-mcp-ref="${ref}"]`,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || null,
        role: getRole(element),
        name: getName(element),
        value: editable ? clean(element.value || element.textContent || "") : "",
        visible,
        disabled: Boolean(element.disabled),
        bounds
      };

      refs.push(item);

      if (clickable) {
        clickableElements.push(item);
      }

      if (editable) {
        editableFields.push(item);
      }
    }

    const textLines = clean(document.body?.innerText || "")
      .split(/(?<=[.!?])\s+|\n+/)
      .map(line => clean(line))
      .filter(line => line.length > 0)
      .slice(0, maxTextLines);

    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    const scroll = {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      maxX: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
      maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight))
    };

    return {
      url: window.location.href,
      title: document.title,
      viewport,
      scroll,
      frames: [...document.querySelectorAll("iframe")].map((frame, index) => ({
        index,
        title: frame.getAttribute("title") || "",
        src: frame.getAttribute("src") || ""
      })),
      clickableElements,
      editableFields,
      mainVisibleText: textLines,
      refs
    };
  }, options);
}

export function registerBrowserSessionTools(server, context) {
  server.tool(
    "browser_start",
    "Cria uma sessao persistente de browser Playwright para navegacao e testes visuais.",
    {
      headless: z.boolean().default(true),
      width: z.number().int().min(320).max(3840).default(context.config.browser?.width || 1440),
      height: z.number().int().min(240).max(2160).default(context.config.browser?.height || 1000)
    },
    async ({ headless, width, height }) => {
      const session = await createBrowserSession(context.config, { headless, width, height });
      await appendLog("browser_start", { sessionId: session.sessionId, headless, width, height });

      return jsonResult({
        sessionId: session.sessionId,
        browserName: session.browserName,
        headless: session.headless,
        viewport: session.viewport
      });
    }
  );

  server.tool(
    "browser_list_sessions",
    "Lista sessoes persistentes de browser abertas pelo MCP.",
    {},
    async () => jsonResult(listBrowserSessions())
  );

  server.tool(
    "browser_open_url",
    "Abre uma URL em uma sessao persistente de browser.",
    {
      sessionId: z.string(),
      url: z.string(),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default(context.config.browser?.waitUntil || "domcontentloaded"),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
      waitMs: z.number().int().min(0).max(30000).default(context.config.browser?.waitMs || 1500)
    },
    async ({ sessionId, url, waitUntil, timeoutMs, waitMs }) => {
      const session = getBrowserSession(sessionId);
      const response = await session.page.goto(url, { waitUntil, timeout: timeoutMs });

      if (waitMs > 0) {
        await session.page.waitForTimeout(waitMs);
      }

      await appendLog("browser_open_url", {
        sessionId,
        url,
        finalUrl: session.page.url(),
        waitUntil
      });
      return jsonResult({
        sessionId,
        requestedUrl: url,
        finalUrl: session.page.url(),
        title: await session.page.title().catch(() => ""),
        httpStatus: response ? response.status() : null
      });
    }
  );

  server.tool(
    "browser_get_url",
    "Retorna URL e titulo atuais de uma sessao de browser.",
    { sessionId: z.string() },
    async ({ sessionId }) => {
      const session = getBrowserSession(sessionId);
      return jsonResult({ sessionId, url: session.page.url(), title: await session.page.title().catch(() => "") });
    }
  );

  server.tool(
    "browser_screenshot",
    "Tira screenshot de uma sessao persistente de browser.",
    {
      sessionId: z.string(),
      fullPage: z.boolean().default(context.config.browser?.fullPage ?? true)
    },
    async ({ sessionId, fullPage }) => {
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      const session = getBrowserSession(sessionId);
      const outputPath = path.join(SCREENSHOT_DIR, `session-${sessionId}-${timestamp()}.png`);

      const buffer = await session.page.screenshot({ path: outputPath, fullPage });

      await appendLog("browser_screenshot", { sessionId, outputPath, fullPage, url: session.page.url() });

      return imageResult(JSON.stringify({ sessionId, savedAt: outputPath, url: session.page.url(), fullPage }, null, 2), buffer.toString("base64"));
    }
  );

  server.tool(
    "browser_console",
    "Retorna eventos de console, page errors e responses com erro da sessao.",
    {
      sessionId: z.string(),
      maxEvents: z.number().int().min(1).max(200).default(50),
      includeInfo: z.boolean().default(false)
    },
    async ({ sessionId, maxEvents, includeInfo }) => {
      const session = getBrowserSession(sessionId);
      const consoleMessages = includeInfo
        ? session.consoleMessages
        : session.consoleMessages.filter(item => ["error", "warning"].includes(item.type));

      return jsonResult({
        sessionId,
        consoleMessages: compactEvents(consoleMessages, maxEvents),
        pageErrors: compactEvents(session.pageErrors, maxEvents),
        networkErrors: compactEvents(session.networkErrors, maxEvents),
        badResponses: compactEvents(session.badResponses, maxEvents)
      });
    }
  );

  server.tool(
    "browser_resize",
    "Redimensiona viewport de uma sessao de browser.",
    {
      sessionId: z.string(),
      width: z.number().int().min(320).max(3840),
      height: z.number().int().min(240).max(2160)
    },
    async ({ sessionId, width, height }) => {
      const session = getBrowserSession(sessionId);
      await session.page.setViewportSize({ width, height });
      session.viewport = { width, height };
      return jsonResult({ sessionId, viewport: session.viewport });
    }
  );

  server.tool(
    "browser_close",
    "Fecha uma sessao persistente de browser.",
    { sessionId: z.string() },
    async ({ sessionId }) => jsonResult(await closeBrowserSession(sessionId))
  );

  // browser session extra tools

  server.tool(
    "browser_snapshot",
    "Gera resumo textual da pagina com refs numeradas.",
    {
      sessionId: z.string(),
      maxElements: z.number().int().min(1).max(300).default(120),
      includeHidden: z.boolean().default(false),
      maxTextLines: z.number().int().min(0).max(100).default(30)
    },
    async ({ sessionId, maxElements, includeHidden, maxTextLines }) => {
      const session = getBrowserSession(sessionId);
      const snapshot = await collectSnapshot(session.page, { maxElements, includeHidden, maxTextLines });
      setBrowserRefs(session, snapshot.refs);
      return textResult(formatSnapshot(snapshot, session, maxTextLines));
    }
  );

  server.tool(
    "browser_click",
    "Aciona um elemento da pagina por ref ou seletor.",
    {
      sessionId: z.string(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(60000).default(10000)
    },
    async ({ sessionId, ref, selector, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const locator = resolveLocator(session, { ref, selector });
      await locator.click({ timeout: timeoutMs });
      return jsonResult({ sessionId, ok: true, action: "browser_click", ref: ref || null, selector: selector || null });
    }
  );

  server.tool(
    "browser_fill",
    "Define o valor de um campo da pagina por ref ou seletor.",
    {
      sessionId: z.string(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      value: z.string(),
      timeoutMs: z.number().int().min(500).max(60000).default(10000)
    },
    async ({ sessionId, ref, selector, value, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const locator = resolveLocator(session, { ref, selector });
      await locator.fill(value, { timeout: timeoutMs });
      return jsonResult({ sessionId, ok: true, action: "browser_fill", ref: ref || null, selector: selector || null });
    }
  );

  server.tool(
    "browser_scroll",
    "Move a pagina atual usando wheel do Playwright.",
    {
      sessionId: z.string(),
      direction: z.enum(["up", "down", "left", "right"]).default("down"),
      amount: z.number().int().min(1).max(5000).default(700)
    },
    async ({ sessionId, direction, amount }) => {
      const session = getBrowserSession(sessionId);
      const key = direction === "up" ? "PageUp" : direction === "down" ? "PageDown" : direction === "left" ? "Home" : "End";
      const times = Math.max(1, Math.ceil(amount / 700));
      for (let index = 0; index < times; index += 1) {
        await session.page.keyboard.press(key);
      }
      return jsonResult({ sessionId, ok: true, direction, amount, key, times });
    }
  );

  server.tool(
    "browser_key",
    "Envia uma tecla para a pagina atual.",
    {
      sessionId: z.string(),
      key: z.string()
    },
    async ({ sessionId, key }) => {
      const session = getBrowserSession(sessionId);
      await session.page.keyboard.press(key);
      return jsonResult({ sessionId, ok: true, key });
    }
  );

  server.tool(
    "browser_hover",
    "Move o ponteiro sobre elemento por ref ou seletor.",
    {
      sessionId: z.string(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(60000).default(10000)
    },
    async ({ sessionId, ref, selector, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const locator = resolveLocator(session, { ref, selector });
      await locator.hover({ timeout: timeoutMs });
      return jsonResult({ sessionId, ok: true, action: "browser_hover", ref: ref || null, selector: selector || null });
    }
  );

  server.tool(
    "browser_wait",
    "Aguarda tempo, seletor ou texto na pagina atual.",
    {
      sessionId: z.string(),
      waitMs: z.number().int().min(0).max(120000).default(1000),
      selector: z.string().optional(),
      text: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(120000).default(30000)
    },
    async ({ sessionId, waitMs, selector, text, timeoutMs }) => {
      const session = getBrowserSession(sessionId);

      if (selector) {
        await session.page.locator(selector).first().waitFor({ timeout: timeoutMs });
      }
      if (!selector && text) {
        await session.page.getByText(text).first().waitFor({ timeout: timeoutMs });
      }

      if (!selector && !text && waitMs > 0) {
        await session.page.waitForTimeout(waitMs);
      }

      return jsonResult({ sessionId, ok: true, selector: selector || null, text: text || null, waitMs });
    }
  );
}
