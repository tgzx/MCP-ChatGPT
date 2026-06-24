import { registerTerminalTools } from "./terminalTools.mjs";
import { registerFilesystemTools } from "./filesystemTools.mjs";
import { registerBrowserTools } from "./browserTools.mjs";
import { registerBrowserSessionTools } from "./browserSessionTools.mjs";

export function registerAllTools(server, context) {
  registerTerminalTools(server, context);
  registerFilesystemTools(server, context);
  registerBrowserTools(server, context);
  registerBrowserSessionTools(server, context);
}
