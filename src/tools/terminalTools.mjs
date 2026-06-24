import { z } from "zod";
import { jsonResult, textResult } from "../core/result.mjs";
import { runShellCommand } from "../core/shell.mjs";
import {
  startShellProcess,
  readProcessSession,
  stopProcessSession,
  listProcessSessions
} from "../core/processStore.mjs";

function limit(value, maxChars) {
  return String(value || "").slice(-Number(maxChars || 120000));
}

export function registerTerminalTools(server, context) {
  server.tool(
    "ps",
    "Executa um comando PowerShell no PC.",
    {
      command: z.string(),
      cwd: z.string().default(process.cwd()),
      timeoutMs: z.number().int().min(1000).max(300000).default(60000)
    },
    async ({ command, cwd, timeoutMs }) => {
      const result = await runShellCommand(command, {
        cwd,
        timeoutMs,
        config: context.config
      });

      return jsonResult({
        exitCode: result.exitCode,
        stdout: limit(result.stdout, context.config.maxOutputChars),
        stderr: limit(result.stderr, context.config.maxOutputChars)
      });
    }
  );

  server.tool(
    "start_ps",
    "Inicia um comando PowerShell longo em segundo plano.",
    {
      command: z.string(),
      cwd: z.string().default(process.cwd())
    },
    async ({ command, cwd }) => {
      const session = await startShellProcess(command, {
        cwd,
        config: context.config
      });

      return jsonResult({
        sessionId: session.sessionId,
        pid: session.pid,
        cwd: session.cwd,
        command: session.command,
        startedAt: session.startedAt
      });
    }
  );

  server.tool(
    "read_process",
    "Lê stdout/stderr de um processo iniciado por start_ps.",
    {
      sessionId: z.string(),
      maxChars: z.number().int().min(1000).max(120000).default(30000)
    },
    async ({ sessionId, maxChars }) => {
      const session = readProcessSession(sessionId);

      return jsonResult({
        sessionId: session.sessionId,
        pid: session.pid,
        exited: session.exited,
        exitCode: session.exitCode,
        cwd: session.cwd,
        command: session.command,
        stdout: limit(session.stdout, maxChars),
        stderr: limit(session.stderr, maxChars)
      });
    }
  );

  server.tool(
    "stop_process",
    "Encerra um processo iniciado por start_ps.",
    {
      sessionId: z.string()
    },
    async ({ sessionId }) => {
      const session = await stopProcessSession(sessionId);

      return textResult(`Processo encerrado: ${session.sessionId}`);
    }
  );

  server.tool(
    "list_processes",
    "Lista processos criados por start_ps nesta sessão MCP.",
    {},
    async () => {
      return jsonResult(listProcessSessions());
    }
  );
}
