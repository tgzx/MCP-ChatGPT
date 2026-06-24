import { chromium } from "playwright";

export async function launchHeadlessBrowser(config) {
  const preferredChannel = config.browser?.preferredChannel || "msedge";

  try {
    const browser = await chromium.launch({
      channel: preferredChannel,
      headless: true
    });

    return {
      browser,
      browserName: `${preferredChannel} headless`
    };
  } catch (edgeError) {
    if (config.browser?.fallbackToChromium === false) {
      throw edgeError;
    }

    const browser = await chromium.launch({
      headless: true
    });

    return {
      browser,
      browserName: `chromium headless fallback: ${edgeError.message}`
    };
  }
}
