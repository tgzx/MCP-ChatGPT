import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { appendLog } from "../core/logger.mjs";
import { imageResult, jsonResult, textResult } from "../core/result.mjs";
import { SCREENSHOT_DIR } from "../core/paths.mjs";
import { resolveAllowedPath } from "../core/guardrails.mjs";
import { redactSensitiveObject, redactSensitiveText } from "../core/redact.mjs";
import {
  attachBrowserSession,
  closeAllBrowserSessions,
  closeBrowserSession,
  createBrowserPage,
  createBrowserSession,
  getBrowserPage,
  getBrowserPageId,
  getBrowserRef,
  getBrowserSession,
  listBrowserPages,
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
  lines.push(`URL: ${redactSensitiveText(snapshot.url)}`);
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
function resolveLocator(session, page, target) {
  if (target.selector) {
    return page.locator(target.selector).first();
  }

  if (target.text) {
    return page.getByText(target.text, { exact: target.exact ?? false }).first();
  }

  if (target.ref) {
    const savedRef = getBrowserRef(session, target.ref);
    return page.locator(savedRef.selector || refSelector(savedRef.ref)).first();
  }

  throw new Error("Informe ref, selector ou text para localizar o elemento.");
}

function pageStatus(session, page) {
  return {
    sessionId: session.sessionId,
    pageId: getBrowserPageId(session, page),
    url: redactSensitiveText(page.url())
  };
}

function trimEvalResult(value) {
  if (typeof value === "string") {
    return value.slice(0, 20000);
  }

  return value;
}

function matchTargetHints(haystack, hints) {
  const text = String(haystack || "").toLowerCase();

  return hints.map(hint => {
    const value = String(hint || "").trim();

    return {
      hint: value,
      found: value.length > 0 && text.includes(value.toLowerCase())
    };
  });
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
      height: z.number().int().min(240).max(2160).default(context.config.browser?.height || 1000),
      channel: z.string().optional(),
      userDataDir: z.string().optional()
    },
    async ({ headless, width, height, channel, userDataDir }) => {
      const resolvedUserDataDir = userDataDir
        ? resolveAllowedPath(userDataDir, context.config)
        : undefined;
      const session = await createBrowserSession(context.config, {
        headless,
        width,
        height,
        channel,
        userDataDir: resolvedUserDataDir
      });
      await appendLog("browser_start", {
        sessionId: session.sessionId,
        mode: session.mode,
        headless,
        width,
        height,
        channel: channel || null,
        userDataDir: resolvedUserDataDir || null
      });

      return jsonResult({
        sessionId: session.sessionId,
        browserName: session.browserName,
        mode: session.mode,
        headless: session.headless,
        viewport: session.viewport,
        activePageId: session.activePageId
      });
    }
  );

  server.tool(
    "browser_attach",
    "Conecta a um navegador existente via Chrome DevTools Protocol quando ele foi iniciado com remote debugging.",
    {
      cdpEndpoint: z.string(),
      width: z.number().int().min(320).max(3840).default(context.config.browser?.width || 1440),
      height: z.number().int().min(240).max(2160).default(context.config.browser?.height || 1000)
    },
    async ({ cdpEndpoint, width, height }) => {
      const session = await attachBrowserSession(context.config, { cdpEndpoint, width, height });
      await appendLog("browser_attach", {
        sessionId: session.sessionId,
        cdpEndpoint,
        width,
        height
      });

      return jsonResult({
        sessionId: session.sessionId,
        browserName: session.browserName,
        mode: session.mode,
        activePageId: session.activePageId,
        pages: await listBrowserPages(session)
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
    "browser_list_pages",
    "Lista abas/paginas abertas em uma sessao de browser.",
    {
      sessionId: z.string().optional()
    },
    async ({ sessionId }) => {
      if (sessionId) {
        return jsonResult(await listBrowserPages(getBrowserSession(sessionId)));
      }

      const pages = [];

      for (const item of listBrowserSessions()) {
        const sessionPages = await listBrowserPages(getBrowserSession(item.sessionId));
        pages.push(...sessionPages);
      }

      return jsonResult(pages);
    }
  );

  server.tool(
    "browser_open_url",
    "Abre uma URL em uma sessao persistente de browser.",
    {
      sessionId: z.string(),
      url: z.string(),
      pageId: z.string().optional(),
      newPage: z.boolean().default(false),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default(context.config.browser?.waitUntil || "domcontentloaded"),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
      waitMs: z.number().int().min(0).max(30000).default(context.config.browser?.waitMs || 1500)
    },
    async ({ sessionId, url, pageId, newPage, waitUntil, timeoutMs, waitMs }) => {
      const session = getBrowserSession(sessionId);
      const pageInfo = newPage
        ? await createBrowserPage(session, { viewport: session.viewport })
        : { page: getBrowserPage(session, pageId), pageId: pageId || session.activePageId };
      const response = await pageInfo.page.goto(url, { waitUntil, timeout: timeoutMs });

      if (waitMs > 0) {
        await pageInfo.page.waitForTimeout(waitMs);
      }

      await appendLog("browser_open_url", {
        sessionId,
        url: redactSensitiveText(url),
        pageId: pageInfo.pageId,
        finalUrl: redactSensitiveText(pageInfo.page.url()),
        waitUntil
      });
      return jsonResult({
        sessionId,
        pageId: pageInfo.pageId,
        requestedUrl: redactSensitiveText(url),
        finalUrl: redactSensitiveText(pageInfo.page.url()),
        title: await pageInfo.page.title().catch(() => ""),
        httpStatus: response ? response.status() : null
      });
    }
  );

  server.tool(
    "browser_current_url",
    "Retorna URL e titulo atuais de uma aba de browser.",
    {
      sessionId: z.string(),
      pageId: z.string().optional()
    },
    async ({ sessionId, pageId }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      return jsonResult({
        sessionId,
        pageId: getBrowserPageId(session, page),
        url: redactSensitiveText(page.url()),
        title: await page.title().catch(() => "")
      });
    }
  );

  server.tool(
    "browser_screenshot",
    "Tira screenshot de uma sessao persistente de browser.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      fullPage: z.boolean().default(context.config.browser?.fullPage ?? true),
      outputPath: z.string().optional()
    },
    async ({ sessionId, pageId, fullPage, outputPath }) => {
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      const savedPath = outputPath
        ? resolveAllowedPath(outputPath, context.config)
        : path.join(SCREENSHOT_DIR, `session-${sessionId}-${getBrowserPageId(session, page)}-${timestamp()}.png`);

      await fs.mkdir(path.dirname(savedPath), { recursive: true });

      const buffer = await page.screenshot({ path: savedPath, fullPage });

      await appendLog("browser_screenshot", {
        sessionId,
        pageId: getBrowserPageId(session, page),
        outputPath: savedPath,
        fullPage,
        url: redactSensitiveText(page.url())
      });

      return imageResult(JSON.stringify({
        sessionId,
        pageId: getBrowserPageId(session, page),
        savedAt: savedPath,
        url: redactSensitiveText(page.url()),
        title: await page.title().catch(() => ""),
        fullPage
      }, null, 2), buffer.toString("base64"));
    }
  );

  server.tool(
    "browser_capture_candidate",
    "Abre ou usa uma URL candidata, gera snapshot e tira screenshot. targetHints sao apenas sinais consultivos; hint ausente nao significa falha se a imagem/URL for a tela pedida.",
    {
      sessionId: z.string(),
      url: z.string().optional(),
      pageId: z.string().optional(),
      newPage: z.boolean().default(false),
      targetHints: z.array(z.string()).default([]),
      outputPath: z.string().optional(),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default(context.config.browser?.waitUntil || "domcontentloaded"),
      waitMs: z.number().int().min(0).max(60000).default(context.config.browser?.waitMs || 1500),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
      fullPage: z.boolean().default(context.config.browser?.fullPage ?? true),
      maxElements: z.number().int().min(1).max(300).default(120),
      maxTextLines: z.number().int().min(0).max(100).default(40)
    },
    async ({ sessionId, url, pageId, newPage, targetHints, outputPath, waitUntil, waitMs, timeoutMs, fullPage, maxElements, maxTextLines }) => {
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      const session = getBrowserSession(sessionId);
      const pageInfo = newPage
        ? await createBrowserPage(session, { viewport: session.viewport })
        : { page: getBrowserPage(session, pageId), pageId: pageId || session.activePageId };
      let response = null;

      if (url) {
        response = await pageInfo.page.goto(url, { waitUntil, timeout: timeoutMs });
      }

      if (waitMs > 0) {
        await pageInfo.page.waitForTimeout(waitMs);
      }

      const snapshot = await collectSnapshot(pageInfo.page, {
        maxElements,
        includeHidden: false,
        maxTextLines
      });
      setBrowserRefs(session, snapshot.refs);

      const savedPath = outputPath
        ? resolveAllowedPath(outputPath, context.config)
        : path.join(SCREENSHOT_DIR, `candidate-${sessionId}-${pageInfo.pageId}-${timestamp()}.png`);
      await fs.mkdir(path.dirname(savedPath), { recursive: true });
      const buffer = await pageInfo.page.screenshot({ path: savedPath, fullPage });
      const title = await pageInfo.page.title().catch(() => "");
      const finalUrl = pageInfo.page.url();
      const visibleText = snapshot.mainVisibleText.join("\n");
      const matches = matchTargetHints(`${finalUrl}\n${title}\n${visibleText}`, targetHints);
      const consoleSummary = {
        consoleMessages: compactEvents(session.consoleMessages.filter(item => ["error", "warning"].includes(item.type)), 50),
        pageErrors: compactEvents(session.pageErrors, 50),
        networkErrors: compactEvents(session.networkErrors, 50),
        badResponses: compactEvents(session.badResponses, 50)
      };

      await appendLog("browser_capture_candidate", redactSensitiveObject({
        sessionId,
        pageId: pageInfo.pageId,
        requestedUrl: url || null,
        finalUrl,
        outputPath: savedPath,
        targetHints,
        targetHintMatchedCount: matches.filter(item => item.found).length,
        targetHintTotal: matches.length
      }));

      return imageResult(JSON.stringify(redactSensitiveObject({
        sessionId,
        pageId: pageInfo.pageId,
        savedAt: savedPath,
        requestedUrl: url || null,
        finalUrl,
        title,
        httpStatus: response ? response.status() : null,
        targetHintMatches: matches,
        targetHintSummary: {
          advisoryOnly: true,
          matched: matches.filter(item => item.found).length,
          total: matches.length,
          missing: matches.filter(item => !item.found).map(item => item.hint)
        },
        captureComplete: true,
        note: "Use o screenshot, URL, titulo e texto visivel para decidir. Nao trate targetHintSummary.missing como erro automatico.",
        visibleText,
        clickableCount: snapshot.clickableElements.length,
        editableCount: snapshot.editableFields.length,
        consoleSummary
      }), null, 2), buffer.toString("base64"));
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
      const page = getBrowserPage(session);
      await page.setViewportSize({ width, height });
      session.viewport = { width, height };
      return jsonResult({ sessionId, viewport: session.viewport });
    }
  );

  server.tool(
    "browser_close",
    "Fecha uma sessao persistente de browser, ou todas quando all=true.",
    {
      sessionId: z.string().optional(),
      all: z.boolean().default(false)
    },
    async ({ sessionId, all }) => {
      if (all) {
        return jsonResult(await closeAllBrowserSessions());
      }

      if (!sessionId) {
        throw new Error("Informe sessionId ou all=true.");
      }

      return jsonResult(await closeBrowserSession(sessionId));
    }
  );

  // browser session extra tools

  server.tool(
    "browser_snapshot",
    "Gera resumo textual da pagina com refs numeradas.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      maxElements: z.number().int().min(1).max(300).default(120),
      includeHidden: z.boolean().default(false),
      maxTextLines: z.number().int().min(0).max(100).default(30)
    },
    async ({ sessionId, pageId, maxElements, includeHidden, maxTextLines }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      const snapshot = await collectSnapshot(page, { maxElements, includeHidden, maxTextLines });
      setBrowserRefs(session, snapshot.refs);
      return textResult(formatSnapshot(snapshot, session, maxTextLines));
    }
  );

  server.tool(
    "browser_click",
    "Aciona um elemento da pagina por ref ou seletor.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      exact: z.boolean().default(false),
      timeoutMs: z.number().int().min(500).max(60000).default(10000)
    },
    async ({ sessionId, pageId, ref, selector, text, exact, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      const locator = resolveLocator(session, page, { ref, selector, text, exact });
      await locator.click({ timeout: timeoutMs });
      return jsonResult({ ...pageStatus(session, page), ok: true, action: "browser_click", ref: ref || null, selector: selector || null, text: text || null });
    }
  );

  server.tool(
    "browser_type",
    "Digita ou preenche texto em elemento por ref, seletor ou texto.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      exact: z.boolean().default(false),
      value: z.string(),
      clear: z.boolean().default(true),
      delayMs: z.number().int().min(0).max(1000).default(0),
      timeoutMs: z.number().int().min(500).max(60000).default(10000)
    },
    async ({ sessionId, pageId, ref, selector, text, exact, value, clear, delayMs, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      const locator = resolveLocator(session, page, { ref, selector, text, exact });

      if (clear) {
        await locator.fill(value, { timeout: timeoutMs });
      } else {
        await locator.type(value, { delay: delayMs, timeout: timeoutMs });
      }

      return jsonResult({ ...pageStatus(session, page), ok: true, action: "browser_type", ref: ref || null, selector: selector || null, text: text || null });
    }
  );

  server.tool(
    "browser_scroll",
    "Move a pagina atual usando wheel do Playwright.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      direction: z.enum(["up", "down", "left", "right"]).default("down"),
      amount: z.number().int().min(1).max(5000).default(700)
    },
    async ({ sessionId, pageId, direction, amount }) => {
      const session = getBrowserSession(sessionId);
      getBrowserPage(session, pageId);
      const key = direction === "up" ? "PageUp" : direction === "down" ? "PageDown" : direction === "left" ? "Home" : "End";
      const times = Math.max(1, Math.ceil(amount / 700));
      for (let index = 0; index < times; index += 1) {
        await session.page.keyboard.press(key);
      }
      return jsonResult({ sessionId, ok: true, direction, amount, key, times });
    }
  );

  server.tool(
    "browser_press",
    "Envia uma tecla para a pagina atual.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      key: z.string()
    },
    async ({ sessionId, pageId, key }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      await page.keyboard.press(key);
      return jsonResult({ ...pageStatus(session, page), ok: true, key });
    }
  );

  server.tool(
    "browser_hover",
    "Move o ponteiro sobre elemento por ref ou seletor.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      exact: z.boolean().default(false),
      timeoutMs: z.number().int().min(500).max(60000).default(10000)
    },
    async ({ sessionId, pageId, ref, selector, text, exact, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      const locator = resolveLocator(session, page, { ref, selector, text, exact });
      await locator.hover({ timeout: timeoutMs });
      return jsonResult({ ...pageStatus(session, page), ok: true, action: "browser_hover", ref: ref || null, selector: selector || null, text: text || null });
    }
  );

  server.tool(
    "browser_wait",
    "Aguarda tempo, seletor ou texto na pagina atual.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      waitMs: z.number().int().min(0).max(120000).default(1000),
      selector: z.string().optional(),
      text: z.string().optional(),
      url: z.string().optional(),
      loadState: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: z.number().int().min(500).max(120000).default(30000)
    },
    async ({ sessionId, pageId, waitMs, selector, text, url, loadState, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);

      if (selector) {
        await page.locator(selector).first().waitFor({ timeout: timeoutMs });
      }
      if (!selector && text) {
        await page.getByText(text).first().waitFor({ timeout: timeoutMs });
      }
      if (url) {
        await page.waitForURL(url, { timeout: timeoutMs });
      }
      if (loadState) {
        await page.waitForLoadState(loadState, { timeout: timeoutMs });
      }

      if (!selector && !text && !url && !loadState && waitMs > 0) {
        await page.waitForTimeout(waitMs);
      }

      return jsonResult(redactSensitiveObject({ ...pageStatus(session, page), ok: true, selector: selector || null, text: text || null, url: url || null, loadState: loadState || null, waitMs }));
    }
  );

  server.tool(
    "browser_eval",
    "Executa JavaScript curto na pagina atual. Use apenas quando snapshot/click/type/wait nao bastarem.",
    {
      sessionId: z.string(),
      pageId: z.string().optional(),
      script: z.string().max(4000),
      timeoutMs: z.number().int().min(500).max(30000).default(5000)
    },
    async ({ sessionId, pageId, script, timeoutMs }) => {
      const session = getBrowserSession(sessionId);
      const page = getBrowserPage(session, pageId);
      page.setDefaultTimeout(timeoutMs);
      const value = await page.evaluate(source => {
        return Function(source)();
      }, script);

      return jsonResult({
        ...pageStatus(session, page),
        result: trimEvalResult(value)
      });
    }
  );
}
