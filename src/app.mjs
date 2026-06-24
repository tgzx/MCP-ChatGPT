import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./core/config.mjs";
import { ROOT_DIR } from "./core/paths.mjs";
import { registerAllTools } from "./tools/index.mjs";

const config = await loadConfig();

if (process.argv.includes("--doctor")) {
  console.log(JSON.stringify({
    ok: true,
    rootDir: ROOT_DIR,
    profileName: config.profileName,
    tools: [
      "ps",
      "start_ps",
      "read_process",
      "stop_process",
      "list_processes",
      "list_directory",
      "get_file_info",
      "create_directory",
      "read_file",
      "write_file",
      "append_file",
      "delete_path",
      "move_path",
      "search_names",
      "screenshot_url"
    ],
    config
  }, null, 2));

  process.exit(0);
}

const server = new McpServer({
  name: config.profileName || "mcp-chatgpt-full-pc-dev",
  version: "1.0.0"
});

const context = {
  config
};

registerAllTools(server, context);

const transport = new StdioServerTransport();
await server.connect(transport);
