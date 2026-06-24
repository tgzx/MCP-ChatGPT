import { z } from "zod";
import { textResult } from "../core/result.mjs";

export function registerExampleTools(server, context) {
  server.tool(
    "hello_tool",
    "Exemplo de ferramenta nova.",
    {
      name: z.string().default("User")
    },
    async ({ name }) => {
      return textResult(`OlÃ¡, ${name}!`);
    }
  );
}

