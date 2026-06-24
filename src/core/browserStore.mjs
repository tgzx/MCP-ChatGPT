import { randomUUID } from "node:crypto";

import { launchHeadlessBrowser } from "./browser.mjs";

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

export async function createBrowserSession(config, options = {}) {
  const width = options.width || config.browser?.width || 1440;
  const height = options.height || config.browser?.height || 1000;
  const headless = options.headless ?? true;
  const { browser, browserName } = await launchHeadlessBrowser(config, {
    headless
  });

  const context = await browser.newContext({
    viewport: {
      width,
      height
    }
  });

  const page = await context.newPage();
  const sessionId = createSessionId();
  const createdAt = nowIso();

  const session = {
    sessionId,
    browser,
    context,
    page,
    browserName,
    headless,
    viewport: { width, height },
    createdAt,
    lastUsedAt: createdAt,
    consoleMessages: [],
    pageErrors: [],
    networkErrors: [],
    badResponses: [],
    refs: new Map(),
    lastSnapshotAt: null
  };
  page.on("console", message => {
    pushLimited(session.consoleMessages, {
      at: nowIso(),
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });

  page.on("pageerror", error => {
    pushLimited(session.pageErrors, {
      at: nowIso(),
      message: error.message,
      stack: error.stack || null
    });
  });

  page.on("requestfailed", request => {
    pushLimited(session.networkErrors, {
      at: nowIso(),
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || null
    });
  });
  page.on("response", response => {
    const status = response.status();

    if (status >= 400) {
      pushLimited(session.badResponses, {
        at: nowIso(),
        url: response.url(),
        status,
        statusText: response.statusText()
      });
    }
  });

  sessions.set(sessionId, session);
  return session;
}

export function getBrowserSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new Error(`Sessao de browser nao encontrada: ${sessionId}`);
  }

  session.lastUsedAt = nowIso();
  return session;
}
export function listBrowserSessions() {
  return [...sessions.values()].map(session => ({
    sessionId: session.sessionId,
    browserName: session.browserName,
    headless: session.headless,
    url: session.page.url(),
    viewport: session.viewport,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    consoleCount: session.consoleMessages.length,
    pageErrorCount: session.pageErrors.length,
    networkErrorCount: session.networkErrors.length,
    badResponseCount: session.badResponses.length,
    lastSnapshotAt: session.lastSnapshotAt
  }));
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
