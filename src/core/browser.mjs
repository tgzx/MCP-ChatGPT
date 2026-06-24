import { chromium } from "playwright";

export async function launchHeadlessBrowser(config, options = {}) {
  const preferredChannel = config.browser?.preferredChannel || "msedge";
  const headless = options.headless ?? true;

  try {
    const browser = await chromium.launch({
      channel: preferredChannel,
      headless
    });

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
