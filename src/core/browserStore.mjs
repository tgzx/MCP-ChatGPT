import { randomUUID } from "node:crypto";

import {
  connectBrowserOverCdp,
  launchHeadlessBrowser,
  launchPersistentBrowserContext
} from "./browser.mjs";
import { redactSensitiveText } from "./redact.mjs";

const sessions = new Map();
const MAX_EVENTS = 200;

function nowIso() {
  return new Date().toISOString();
}

function pushLimited(list, item) {
  list.push(item);

  if (list.length > MAX_EVENTS) {
    list.splice(0, list.length - MAX_EVENTS);
  }
}

function createSessionId() {
  return `browser_${randomUUID().slice(0, 8)}`;
}

function createPageId(session) {
  session.pageCounter += 1;
  return `page_${session.pageCounter}`;
}

function instrumentPage(session, page) {
  if (session.instrumentedPages.has(page)) {
    return;
  }

  session.instrumentedPages.add(page);

  page.on("console", message => {
    pushLimited(session.consoleMessages, {
      at: nowIso(),
      pageId: session.pageIdByPage.get(page) || null,
      type: message.type(),
      text: redactSensitiveText(message.text()),
      location: message.location()
    });
  });

  page.on("pageerror", error => {
    pushLimited(session.pageErrors, {
      at: nowIso(),
      pageId: session.pageIdByPage.get(page) || null,
      message: redactSensitiveText(error.message),
      stack: redactSensitiveText(error.stack || "")
    });
  });

  page.on("requestfailed", request => {
    pushLimited(session.networkErrors, {
      at: nowIso(),
      pageId: session.pageIdByPage.get(page) || null,
      url: redactSensitiveText(request.url()),
      method: request.method(),
      failure: request.failure()?.errorText || null
    });
  });

  page.on("response", response => {
    const status = response.status();

    if (status >= 400) {
      pushLimited(session.badResponses, {
        at: nowIso(),
        pageId: session.pageIdByPage.get(page) || null,
        url: redactSensitiveText(response.url()),
        status,
        statusText: response.statusText()
      });
    }
  });

  page.on("close", () => {
    const pageId = session.pageIdByPage.get(page);

    if (pageId) {
      session.pages.delete(pageId);
      session.pageIdByPage.delete(page);

      if (session.activePageId === pageId) {
        session.activePageId = session.pages.keys().next().value || null;
        session.page = session.activePageId ? session.pages.get(session.activePageId) : null;
      }
    }
  });
}

function trackPage(session, page) {
  if (session.pageIdByPage.has(page)) {
    return session.pageIdByPage.get(page);
  }

  const pageId = createPageId(session);
  session.pageIdByPage.set(page, pageId);
  session.pages.set(pageId, page);
  instrumentPage(session, page);

  if (!session.activePageId || !session.page || session.page.isClosed()) {
    session.activePageId = pageId;
    session.page = page;
  }

  return pageId;
}

function getSessionContexts(session) {
  if (session.browser && typeof session.browser.contexts === "function") {
    const contexts = session.browser.contexts();

    if (contexts.length > 0) {
      return contexts;
    }
  }

  return session.context ? [session.context] : [];
}

export function refreshBrowserPages(session) {
  for (const context of getSessionContexts(session)) {
    attachContextListeners(session, context);

    for (const page of context.pages()) {
      trackPage(session, page);
    }
  }

  if (!session.activePageId && session.pages.size > 0) {
    session.activePageId = session.pages.keys().next().value;
    session.page = session.pages.get(session.activePageId);
  }

  return session;
}

function attachContextListeners(session, context) {
  if (!context || session.instrumentedContexts.has(context)) {
    return;
  }

  session.instrumentedContexts.add(context);
  context.on("page", page => {
    trackPage(session, page);
    session.activePageId = session.pageIdByPage.get(page);
    session.page = page;
  });
}

function createSessionBase(options) {
  const sessionId = createSessionId();
  const createdAt = nowIso();

  return {
    sessionId,
    browser: options.browser,
    context: options.context,
    page: null,
    browserName: options.browserName,
    headless: options.headless,
    mode: options.mode,
    userDataDir: options.userDataDir || null,
    cdpEndpoint: options.cdpEndpoint || null,
    viewport: options.viewport,
    createdAt,
    lastUsedAt: createdAt,
    consoleMessages: [],
    pageErrors: [],
    networkErrors: [],
    badResponses: [],
    refs: new Map(),
    pages: new Map(),
    pageIdByPage: new Map(),
    pageCounter: 0,
    activePageId: null,
    instrumentedPages: new WeakSet(),
    instrumentedContexts: new WeakSet(),
    lastSnapshotAt: null
  };
}

export async function createBrowserSession(config, options = {}) {
  const width = options.width || config.browser?.width || 1440;
  const height = options.height || config.browser?.height || 1000;
  const headless = options.headless ?? true;
  const viewport = { width, height };
  let browser;
  let context;
  let browserName;
  let mode = "launch";

  if (options.userDataDir) {
    const launched = await launchPersistentBrowserContext(config, {
      headless,
      channel: options.channel,
      userDataDir: options.userDataDir,
      viewport
    });
    browser = launched.browser;
    context = launched.context;
    browserName = launched.browserName;
    mode = "persistent";
  } else {
    const launched = await launchHeadlessBrowser(config, {
      headless,
      channel: options.channel
    });
    browser = launched.browser;
    browserName = launched.browserName;
    context = await browser.newContext({
      viewport
    });
  }

  const session = createSessionBase({
    browser,
    context,
    browserName,
    headless,
    mode,
    userDataDir: options.userDataDir,
    viewport
  });

  attachContextListeners(session, context);
  refreshBrowserPages(session);

  if (session.pages.size === 0) {
    const page = await context.newPage();
    trackPage(session, page);
  }

  session.page = session.pages.get(session.activePageId);

  sessions.set(session.sessionId, session);
  return session;
}

export async function attachBrowserSession(config, options = {}) {
  const width = options.width || config.browser?.width || 1440;
  const height = options.height || config.browser?.height || 1000;
  const viewport = { width, height };
  const { browser, browserName } = await connectBrowserOverCdp({
    cdpEndpoint: options.cdpEndpoint
  });
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error("Browser CDP conectado, mas nenhum contexto foi encontrado.");
  }

  const session = createSessionBase({
    browser,
    context,
    browserName,
    headless: false,
    mode: "cdp",
    cdpEndpoint: options.cdpEndpoint,
    viewport
  });

  attachContextListeners(session, context);
  refreshBrowserPages(session);

  if (session.pages.size === 0) {
    const page = await context.newPage();
    await page.setViewportSize(viewport).catch(() => {});
    trackPage(session, page);
  }

  session.page = session.pages.get(session.activePageId);
  sessions.set(session.sessionId, session);
  return session;
}

export function getBrowserSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error(`Sessao de browser nao encontrada: ${sessionId}`);
  }

  session.lastUsedAt = nowIso();
  return refreshBrowserPages(session);
}
export function listBrowserSessions() {
  return [...sessions.values()].map(session => ({
    sessionId: session.sessionId,
    browserName: session.browserName,
    headless: session.headless,
    mode: session.mode,
    activePageId: session.activePageId,
    url: session.page && !session.page.isClosed() ? redactSensitiveText(session.page.url()) : "",
    viewport: session.viewport,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    pageCount: refreshBrowserPages(session).pages.size,
    consoleCount: session.consoleMessages.length,
    pageErrorCount: session.pageErrors.length,
    networkErrorCount: session.networkErrors.length,
    badResponseCount: session.badResponses.length,
    lastSnapshotAt: session.lastSnapshotAt
  }));
}

export async function listBrowserPages(session) {
  refreshBrowserPages(session);

  const pages = [];

  for (const [pageId, page] of session.pages) {
    if (page.isClosed()) {
      continue;
    }

    pages.push({
      sessionId: session.sessionId,
      pageId,
      active: pageId === session.activePageId,
      url: redactSensitiveText(page.url()),
      title: await page.title().catch(() => ""),
      closed: page.isClosed()
    });
  }

  return pages;
}

export function getBrowserPage(session, pageId = null) {
  refreshBrowserPages(session);

  const targetPageId = pageId || session.activePageId;
  const page = session.pages.get(targetPageId);

  if (!page || page.isClosed()) {
    throw new Error(`Pagina de browser nao encontrada: ${targetPageId || "(ativa)"}`);
  }

  session.activePageId = targetPageId;
  session.page = page;
  session.lastUsedAt = nowIso();
  return page;
}

export async function createBrowserPage(session, options = {}) {
  const context = session.context || getSessionContexts(session)[0];

  if (!context) {
    throw new Error(`Sessao sem contexto de browser: ${session.sessionId}`);
  }

  const page = await context.newPage();

  if (options.viewport) {
    await page.setViewportSize(options.viewport).catch(() => {});
  }

  const pageId = trackPage(session, page);
  session.activePageId = pageId;
  session.page = page;
  session.lastUsedAt = nowIso();
  return { page, pageId };
}

export function getBrowserPageId(session, page) {
  refreshBrowserPages(session);
  return session.pageIdByPage.get(page) || null;
}

export async function closeBrowserSession(sessionId) {
  const session = getBrowserSession(sessionId);
  sessions.delete(sessionId);
  await session.browser.close();
  return { closed: true, sessionId };
}
export async function closeAllBrowserSessions() {
  const ids = [...sessions.keys()];

  for (const id of ids) {
    await closeBrowserSession(id);
  }

  return {
    closed: ids.length,
    sessionIds: ids
  };
}

export function setBrowserRefs(session, refs) {
  session.refs = new Map(refs.map(ref => [String(ref.ref), ref]));
  session.lastSnapshotAt = nowIso();
}

export function getBrowserRef(session, ref) {
  const target = session.refs.get(String(ref));

  if (!target) {
    throw new Error(`Referencia nao encontrada no ultimo snapshot: ${ref}`);
  }

  return target;
}
