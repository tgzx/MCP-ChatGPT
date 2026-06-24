import { spawn } from "node:child_process";
import { appendLog } from "./logger.mjs";
import { assertCommandAllowed, resolveAllowedPath } from "./guardrails.mjs";

export async function runShellCommand(command, options = {}) {
  const config = options.config || {};
  const cwd = resolveAllowedPath(options.cwd || process.cwd(), config);

  const timeoutMs = Math.min(
    Number(options.timeoutMs || config.defaultCommandTimeoutMs || 60000),
    Number(config.maxCommandTimeoutMs || 300000)
  );

  assertCommandAllowed(command, config);

  await appendLog("ps", {
    cwd,
    command,
    timeoutMs
  });

  const shellCommand = config.shell?.command || "powershell.exe";
  const shellArgs = Array.isArray(config.shell?.args)
    ? [...config.shell.args, command]
    : ["-NoLogo", "-NoProfile", "-Command", command];

  const windowsHide = config.shell?.windowsHide !== false;

  return await new Promise(resolve => {
    const child = spawn(shellCommand, shellArgs, {
      cwd,
      windowsHide
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        exitCode: "TIMEOUT",
        stdout,
        stderr: stderr + `\nTimeout após ${timeoutMs}ms.`
      });
    }, timeoutMs);

    child.stdout.on("data", data => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("close", code => {
      clearTimeout(timer);

      resolve({
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}
