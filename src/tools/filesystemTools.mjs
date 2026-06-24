import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { jsonResult, textResult } from "../core/result.mjs";
import { appendLog } from "../core/logger.mjs";
import { resolveAllowedPath } from "../core/guardrails.mjs";
import { isDriveRoot } from "../core/paths.mjs";

async function walkNames(root, pattern, results, options) {
  if (results.length >= options.maxResults) {
    return;
  }

  const entries = await fs.readdir(root, {
    withFileTypes: true
  });

  for (const entry of entries) {
    if (results.length >= options.maxResults) {
      break;
    }

    const fullPath = path.join(root, entry.name);

    if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
      results.push(fullPath);
    }

    if (entry.isDirectory()) {
      const skip = options.skipDirs.includes(entry.name);

      if (!skip) {
        await walkNames(fullPath, pattern, results, options).catch(() => {});
      }
    }
  }
}

export function registerFilesystemTools(server, context) {
  server.tool(
    "list_directory",
    "Lista arquivos e pastas de um caminho.",
    {
      targetPath: z.string().default(process.cwd())
    },
    async ({ targetPath }) => {
      const p = resolveAllowedPath(targetPath, context.config);
      const entries = await fs.readdir(p, { withFileTypes: true });

      const lines = entries
        .map(entry => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
        .sort();

      return textResult(`Path: ${p}\n\n${lines.join("\n")}`);
    }
  );

  server.tool(
    "get_file_info",
    "Mostra metadados básicos de arquivo ou pasta.",
    {
      targetPath: z.string()
    },
    async ({ targetPath }) => {
      const p = resolveAllowedPath(targetPath, context.config);
      const stat = await fs.stat(p);

      return jsonResult({
        path: p,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        createdAt: stat.birthtime,
        modifiedAt: stat.mtime,
        accessedAt: stat.atime
      });
    }
  );

  server.tool(
    "create_directory",
    "Cria uma pasta recursivamente.",
    {
      targetPath: z.string()
    },
    async ({ targetPath }) => {
      const p = resolveAllowedPath(targetPath, context.config);

      await fs.mkdir(p, { recursive: true });

      await appendLog("create_directory", {
        targetPath: p
      });

      return textResult(`Pasta criada/confirmada: ${p}`);
    }
  );

  server.tool(
    "read_file",
    "Lê arquivo de texto.",
    {
      targetPath: z.string(),
      maxChars: z.number().int().min(100).max(500000).default(120000)
    },
    async ({ targetPath, maxChars }) => {
      const p = resolveAllowedPath(targetPath, context.config);
      const content = await fs.readFile(p, "utf8");

      return textResult(content.slice(0, maxChars));
    }
  );

  server.tool(
    "write_file",
    "Cria ou sobrescreve arquivo de texto.",
    {
      targetPath: z.string(),
      content: z.string()
    },
    async ({ targetPath, content }) => {
      const p = resolveAllowedPath(targetPath, context.config);

      await fs.mkdir(path.dirname(p), {
        recursive: true
      });

      await fs.writeFile(p, content, "utf8");

      await appendLog("write_file", {
        targetPath: p,
        chars: content.length
      });

      return textResult(`Arquivo gravado: ${p}`);
    }
  );

  server.tool(
    "append_file",
    "Adiciona texto ao final de um arquivo.",
    {
      targetPath: z.string(),
      content: z.string()
    },
    async ({ targetPath, content }) => {
      const p = resolveAllowedPath(targetPath, context.config);

      await fs.mkdir(path.dirname(p), {
        recursive: true
      });

      await fs.appendFile(p, content, "utf8");

      await appendLog("append_file", {
        targetPath: p,
        chars: content.length
      });

      return textResult(`Texto adicionado: ${p}`);
    }
  );

  server.tool(
    "delete_path",
    "Remove arquivo ou pasta. Recusa raiz de unidade.",
    {
      targetPath: z.string(),
      recursive: z.boolean().default(false)
    },
    async ({ targetPath, recursive }) => {
      const p = resolveAllowedPath(targetPath, context.config);

      if (isDriveRoot(p)) {
        throw new Error(`Recusado: não removo raiz de unidade (${p}).`);
      }

      const stat = await fs.stat(p);

      if (stat.isDirectory()) {
        await fs.rm(p, {
          recursive,
          force: false
        });
      } else {
        await fs.unlink(p);
      }

      await appendLog("delete_path", {
        targetPath: p,
        recursive
      });

      return textResult(`Removido: ${p}`);
    }
  );

  server.tool(
    "move_path",
    "Move ou renomeia arquivo/pasta.",
    {
      sourcePath: z.string(),
      destinationPath: z.string()
    },
    async ({ sourcePath, destinationPath }) => {
      const src = resolveAllowedPath(sourcePath, context.config);
      const dst = resolveAllowedPath(destinationPath, context.config);

      await fs.mkdir(path.dirname(dst), {
        recursive: true
      });

      await fs.rename(src, dst);

      await appendLog("move_path", {
        sourcePath: src,
        destinationPath: dst
      });

      return textResult(`Movido: ${src} -> ${dst}`);
    }
  );

  server.tool(
    "search_names",
    "Busca arquivos e pastas por nome.",
    {
      rootPath: z.string(),
      pattern: z.string(),
      maxResults: z.number().int().min(1).max(500).default(100)
    },
    async ({ rootPath, pattern, maxResults }) => {
      const root = resolveAllowedPath(rootPath, context.config);
      const results = [];

      await walkNames(root, pattern, results, {
        maxResults,
        skipDirs: context.config.search?.skipDirs || []
      });

      return textResult(results.join("\n") || "Nenhum resultado.");
    }
  );
}
