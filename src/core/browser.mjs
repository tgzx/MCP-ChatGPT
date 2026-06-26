import { chromium } from "playwright";

export async function launchHeadlessBrowser(config, options = {}) {
  const preferredChannel = options.channel || config.browser?.preferredChannel || "msedge";
  const headless = options.headless ?? true;
  const launchOptions = {
    channel: preferredChannel,
    headless
  };

  try {
    const browser = await chromium.launch(launchOptions);

    return {
      browser,
      browserName: `${preferredChannel} ${headless ? "headless" : "headed"}`
    };
  } catch (edgeError) {
    if (config.browser?.fallbackToChromium === false) {
      throw edgeError;
    }

    const browser = await chromium.launch({
      headless
    });

    return {
      browser,
      browserName: `chromium ${headless ? "headless" : "headed"} fallback: ${edgeError.message}`
    };
  }
}

export async function launchPersistentBrowserContext(config, options = {}) {
  const preferredChannel = options.channel || config.browser?.preferredChannel || "msedge";
  const headless = options.headless ?? true;
  const viewport = options.viewport;
  const launchOptions = {
    channel: preferredChannel,
    headless,
    viewport
  };

  try {
    const context = await chromium.launchPersistentContext(options.userDataDir, launchOptions);

    return {
      context,
      browser: context.browser(),
      browserName: `${preferredChannel} persistent ${headless ? "headless" : "headed"}`
    };
  } catch (edgeError) {
    if (config.browser?.fallbackToChromium === false) {
      throw edgeError;
    }

    const context = await chromium.launchPersistentContext(options.userDataDir, {
      headless,
      viewport
    });

    return {
      context,
      browser: context.browser(),
      browserName: `chromium persistent ${headless ? "headless" : "headed"} fallback: ${edgeError.message}`
    };
  }
}

export async function connectBrowserOverCdp(options = {}) {
  const browser = await chromium.connectOverCDP(options.cdpEndpoint);

  return {
    browser,
    browserName: `cdp ${options.cdpEndpoint}`
  };
}
