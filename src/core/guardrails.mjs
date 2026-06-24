import { normalizePath, assertPathAllowed } from "./paths.mjs";

const DEFAULT_BLOCKED_REGEX = [
  /\bformat-volume\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bclear-disk\b/i,
  /\binitialize-disk\b/i,
  /\bremove-partition\b/i,
  /\bdelete\s+partition\b/i,
  /\bconvert\s+(gpt|mbr)\b/i,
  /\bbcdedit\b/i,
  /\bbootrec\b/i,
  /\breagentc\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\bdisable-computerrestore\b/i,
  /\bset-mppreference\b/i,
  /\badd-mppreference\b/i,
  /\bremove-mppreference\b/i,
  /\bnetsh\s+advfirewall\s+set\s+allprofiles\s+state\s+off\b/i,
  /\bnew-localuser\b/i,
  /\bnet\s+user\b/i,
  /\badd-localgroupmember\b/i,
  /\bset-executionpolicy\s+unrestricted\b/i,
  /\bstart-process\b[\s\S]*\b-verb\s+runas\b/i,
  /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[\s\S]*\|\s*(iex|invoke-expression)\b/i,
  /\biex\b/i,
  /\binvoke-expression\b/i
];

export function assertCommandAllowed(command, config) {
  const mode = config.securityMode || "denylist";

  if (mode === "off") {
    return;
  }

  const text = String(command || "");

  for (const rule of DEFAULT_BLOCKED_REGEX) {
    if (rule.test(text)) {
      throw new Error(`Comando bloqueado pela regra padrão: ${rule}`);
    }
  }

  for (const token of config.blockedTokens || []) {
    if (token && text.toLowerCase().includes(String(token).toLowerCase())) {
      throw new Error(`Comando bloqueado por blockedTokens: ${token}`);
    }
  }

  for (const pattern of config.blockedRegex || []) {
    const rule = new RegExp(pattern, "i");

    if (rule.test(text)) {
      throw new Error(`Comando bloqueado por blockedRegex: ${pattern}`);
    }
  }
}

export function resolveAllowedPath(targetPath, config) {
  const resolved = normalizePath(targetPath);
  assertPathAllowed(resolved, config);
  return resolved;
}
