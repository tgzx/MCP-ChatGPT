import { spawn } from "node:child_process";
import { appendLog } from "./logger.mjs";
import { assertCommandAllowed, resolveAllowedPath } from "./guardrails.mjs";

const sessions = new Map();

export async function startShellProcess(command, options = {}) {
  const config = options.config || {};
  const cwd = resolveAllowedPath(options.cwd || process.cwd(), config);

  assertCommandAllowed(command, config);

  await appendLog("start_ps", {
    cwd,
    command
  });

  const shellCommand = config.shell?.command || "powershell.exe";
  const shellArgs = Array.isArray(config.shell?.args)
    ? [...config.shell.args, command]
    : ["-NoLogo", "-NoProfile", "-Command", command];

  const windowsHide = config.shell?.windowsHide !== false;

  const child = spawn(shellCommand, shellArgs, {
    cwd,
    windowsHide
  });

  const sessionId = String(child.pid);

  const session = {
    sessionId,
    pid: child.pid,
    cwd,
    command,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null
  };

  sessions.set(sessionId, session);

  child.stdout.on("data", data => {
    session.stdout += data.toString();
  });

  child.stderr.on("data", data => {
    session.stderr += data.toString();
  });

  child.on("close", code => {
    session.exited = true;
    session.exitCode = code;
  });

  return session;
}

export function readProcessSession(sessionId) {
  const session = sessions.get(String(sessionId));

  if (!session) {
    throw new Error(`Sessão não encontrada: ${sessionId}`);
  }

  return session;
}

export function listProcessSessions() {
  return [...sessions.values()];
}

export async function stopProcessSession(sessionId) {
  const session = readProcessSession(sessionId);

  try {
    process.kill(Number(session.pid));
    session.exited = true;
  } catch (error) {
    throw new Error(`Falha ao encerrar processo ${sessionId}: ${error.message}`);
  }

  await appendLog("stop_process", {
    sessionId,
    pid: session.pid
  });

  return session;
}
