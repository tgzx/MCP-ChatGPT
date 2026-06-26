import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { startShellProcess, readProcessSession, stopProcessSession } from "../core/processStore.mjs";
import { resolveAllowedPath } from "../core/guardrails.mjs";
import { appendLog } from "../core/logger.mjs";
import { imageResult, jsonResult } from "../core/result.mjs";
import { SCREENSHOT_DIR } from "../core/paths.mjs";
import { redactSensitiveText } from "../core/redact.mjs";
import {
  attachBrowserSession,
  createBrowserSession,
  getBrowserPage,
  getBrowserPageId,
  listBrowserPages
} from "../core/browserStore.mjs";

const execFileAsync = promisify(execFile);
const managedPreviews = new Map();

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function previewKey({ repoRoot, componentName, targetOrg }) {
  return [
    path.resolve(repoRoot).toLowerCase(),
    String(componentName || "").toLowerCase(),
    String(targetOrg || "").toLowerCase()
  ].join("|");
}

function isSessionAlive(sessionId) {
  try {
    const session = readProcessSession(sessionId);
    return !session.exited;
  } catch {
    return false;
  }
}

function managedPreviewList() {
  return [...managedPreviews.values()].map(item => ({
    ...item,
    alive: isSessionAlive(item.processSessionId)
  }));
}

async function stopProcessTree(pid) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = ${Number(pid)}`,
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
    "$ids = New-Object System.Collections.Generic.HashSet[int]",
    "[void]$ids.Add($root)",
    "do {",
    "  $added = $false",
    "  foreach ($p in $all) {",
    "    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {",
    "      [void]$ids.Add([int]$p.ProcessId)",
    "      $added = $true",
    "    }",
    "  }",
    "} while ($added)",
    "$ids | Sort-Object -Descending | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
  ].join("; ");

  await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    script
  ], {
    timeout: 10000,
    windowsHide: true
  }).catch(() => {});
}

async function stopManagedPreview(item, reason = "manual") {
  if (!item) {
    return null;
  }

  await stopProcessTree(item.pid);

  try {
    await stopProcessSession(item.processSessionId);
  } catch {
    // stopProcessTree can already have stopped the PowerShell parent.
  }

  managedPreviews.delete(item.key);
  await appendLog("lwc_preview_stop", {
    repoRoot: item.repoRoot,
    componentName: item.componentName,
    targetOrg: item.targetOrg || null,
    processSessionId: item.processSessionId,
    pid: item.pid,
    reason
  });

  return {
    stopped: true,
    reason,
    repoRoot: item.repoRoot,
    componentName: item.componentName,
    targetOrg: item.targetOrg || null,
    processSessionId: item.processSessionId,
    pid: item.pid
  };
}

async function stopManagedPreviews({ repoRoot, componentName, targetOrg, allForRepo = false, reason = "fresh" }) {
  const stopped = [];

  for (const item of [...managedPreviews.values()]) {
    const sameRepo = path.resolve(item.repoRoot).toLowerCase() === path.resolve(repoRoot).toLowerCase();
    const sameComponent = String(item.componentName).toLowerCase() === String(componentName || "").toLowerCase();
    const sameOrg = String(item.targetOrg || "").toLowerCase() === String(targetOrg || "").toLowerCase();

    if (sameRepo && (allForRepo || (sameComponent && sameOrg))) {
      const result = await stopManagedPreview(item, reason);
      if (result) {
        stopped.push(result);
      }
    }
  }

  return stopped;
}

async function listActiveSfPreviewProcesses() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$matches = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'lightning\\s+dev\\s+component' }",
    "$matches | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Depth 4"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      script
    ], {
      timeout: 10000,
      windowsHide: true
    });

    return parseJsonRows(stdout)
      .filter(row => row && row.ProcessId)
      .map(row => ({
        pid: Number(row.ProcessId),
        parentPid: Number(row.ParentProcessId),
        processName: row.Name || null,
        commandLine: redactSensitiveText(row.CommandLine || ""),
        startTime: row.CreationDate || null
      }));
  } catch {
    return [];
  }
}

async function stopActiveSfPreviewProcesses(reason = "cleanup-active-sf-previews") {
  const processes = await listActiveSfPreviewProcesses();
  const stopped = [];
  const seen = new Set();

  for (const item of processes.sort((a, b) => Number(b.pid) - Number(a.pid))) {
    if (seen.has(item.pid)) {
      continue;
    }

    seen.add(item.pid);
    await stopProcessTree(item.pid);
    stopped.push({
      ...item,
      reason
    });
  }

  for (const item of [...managedPreviews.values()]) {
    if (!isSessionAlive(item.processSessionId)) {
      managedPreviews.delete(item.key);
    }
  }

  if (stopped.length > 0) {
    await appendLog("lwc_preview_stop_active", {
      reason,
      count: stopped.length,
      processes: stopped
    });
  }

  return stopped;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function limit(value, maxChars = 30000) {
  return String(value || "").slice(-maxChars);
}

function extractUrls(text) {
  return [...String(text || "").matchAll(/https?:\/\/[^\s"'<>]+/gi)]
    .map(match => match[0].replace(/[),.;]+$/g, ""))
    .filter((url, index, urls) => urls.indexOf(url) === index);
}

function extractFirstUrl(text) {
  const matches = [...String(text || "").matchAll(/https?:\/\/\S+/gi)];
  const urls = matches.map(match => match[0].replace(/[),.;]+$/g, ""));
  return urls.find(url => /\/secur\/frontdoor\.jsp/i.test(url)) ||
    urls.find(url => /\.salesforce\.com/i.test(url) && !/developer\.salesforce\.com/i.test(url)) ||
    urls.at(-1) ||
    null;
}

function parseJsonRows(stdout) {
  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function getSfExecutableParts() {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "(Get-Command sf).Source"
  ], {
    timeout: 10000,
    windowsHide: true
  });
  const sfCmd = stdout.trim();

  if (!sfCmd) {
    throw new Error("Salesforce CLI 'sf' nao encontrado no PATH.");
  }

  const sfRoot = path.dirname(path.dirname(sfCmd));
  return {
    nodePath: path.join(sfRoot, "client", "bin", "node.exe"),
    runPath: path.join(sfRoot, "client", "bin", "run")
  };
}

async function sfOrgOpenUrl({ repoRoot, targetOrg, sfPath }) {
  const { nodePath, runPath } = await getSfExecutableParts();
  const args = [
    "--no-deprecation",
    runPath,
    "org",
    "open"
  ];

  if (targetOrg) {
    args.push("--target-org", targetOrg);
  }

  args.push("--path", sfPath, "--url-only");

  const { stdout, stderr } = await execFileAsync(nodePath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true
  });
  const url = extractFirstUrl(`${stdout}\n${stderr}`);

  if (!url) {
    throw new Error(`sf org open nao retornou URL utilizavel. Saida:\n${redactSensitiveText(`${stdout}\n${stderr}`)}`);
  }

  return url;
}

function buildDirectPreviewPath({ port, componentName }) {
  const encodedComponent = encodeURIComponent(`c/${componentName}`);
  return `/lwr/application/e/devpreview/ai/localdev-preview?ldpServerUrl=ws%3A%2F%2Flocalhost%3A${Number(port)}&specifier=${encodedComponent}&aura.lcdn=0`;
}

function extractLocalDevPortFromUrl(url) {
  const text = decodeURIComponent(String(url || ""));
  const match = text.match(/(?:localhost|127\.0\.0\.1):(\d{2,5})/i);
  return match ? Number(match[1]) : null;
}

function isDirectComponentPreviewUrl(url, componentName) {
  const text = decodeURIComponent(String(url || "")).toLowerCase();
  return text.includes("/localdev-preview") &&
    text.includes("specifier=c/") &&
    text.includes(`specifier=c/${String(componentName || "").toLowerCase()}`);
}

function isSelectorOrLocalDevRoot(url) {
  const text = decodeURIComponent(String(url || "")).toLowerCase();
  return /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?$/.test(text) ||
    text.includes("/localdev%2fpreview") ||
    (text.includes("/localdev/preview") && !text.includes("/localdev-preview"));
}

function extractSalesforcePath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

async function listListeningSfPreviewProcesses() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$connections = Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess",
    "$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique",
    "$procs = @{}",
    "foreach ($pidValue in $pids) {",
    "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$pidValue\"",
    "  if ($p) { $procs[[string]$pidValue] = @{ ProcessId=$p.ProcessId; ParentProcessId=$p.ParentProcessId; Name=$p.Name; CommandLine=$p.CommandLine; CreationDate=$p.CreationDate } }",
    "}",
    "$connections | ForEach-Object {",
    "  $proc = $procs[[string]$_.OwningProcess]",
    "  if ($proc -and $proc.CommandLine -match 'lightning\\s+dev\\s+component') {",
    "    [pscustomobject]@{ Port=$_.LocalPort; Pid=$_.OwningProcess; Process=$proc }",
    "  }",
    "} | ConvertTo-Json -Depth 5"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      script
    ], {
      timeout: 10000,
      windowsHide: true
    });

    return parseJsonRows(stdout)
      .filter(row => row && row.Port)
      .map(row => ({
        port: Number(row.Port),
        pid: Number(row.Pid),
        processName: row.Process?.Name || null,
        commandLine: redactSensitiveText(row.Process?.CommandLine || ""),
        rawCommandLine: row.Process?.CommandLine || "",
        startTime: row.Process?.CreationDate || null
      }));
  } catch {
    return [];
  }
}

async function listDescendantListeningPorts(rootPid) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = ${Number(rootPid)}`,
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate",
    "$ids = New-Object System.Collections.Generic.HashSet[int]",
    "[void]$ids.Add($root)",
    "do {",
    "  $added = $false",
    "  foreach ($p in $all) {",
    "    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {",
    "      [void]$ids.Add([int]$p.ProcessId)",
    "      $added = $true",
    "    }",
    "  }",
    "} while ($added)",
    "$connections = Get-NetTCPConnection -State Listen | Where-Object { $ids.Contains([int]$_.OwningProcess) }",
    "$connections | ForEach-Object {",
    "  $connection = $_",
    "  $proc = $all | Where-Object { $_.ProcessId -eq $connection.OwningProcess } | Select-Object -First 1",
    "  [pscustomobject]@{ Port=$connection.LocalPort; Pid=$connection.OwningProcess; Process=$proc }",
    "} | ConvertTo-Json -Depth 5"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      script
    ], {
      timeout: 10000,
      windowsHide: true
    });

    return parseJsonRows(stdout)
      .filter(row => row && row.Port)
      .map(row => ({
        port: Number(row.Port),
        pid: Number(row.Pid),
        processName: row.Process?.Name || null,
        commandLine: redactSensitiveText(row.Process?.CommandLine || ""),
        startTime: row.Process?.CreationDate || null
      }));
  } catch {
    return [];
  }
}

async function waitForPreviewPort({ preview, componentName, existingUrl, waitMs }) {
  const existingPort = extractLocalDevPortFromUrl(existingUrl);

  if (existingPort) {
    return {
      port: existingPort,
      source: "existingUrl"
    };
  }

  const deadline = Date.now() + Math.max(waitMs || 0, 10000);
  let lastCandidates = [];

  while (Date.now() <= deadline) {
    if (preview?.pid) {
      const ports = await listDescendantListeningPorts(preview.pid);
      lastCandidates = ports;

      if (ports.length > 0) {
        const newest = ports.sort((a, b) => String(b.startTime || "").localeCompare(String(a.startTime || "")))[0];
        return {
          port: newest.port,
          source: "managedPreviewProcess",
          candidates: ports.map(item => ({
            port: item.port,
            pid: item.pid,
            processName: item.processName,
            commandLine: item.commandLine,
            startTime: item.startTime
          }))
        };
      }
    }

    const external = await listListeningSfPreviewProcesses();
    const matching = external
      .filter(item => item.rawCommandLine.toLowerCase().includes(`--name ${String(componentName).toLowerCase()}`) ||
        item.rawCommandLine.toLowerCase().includes(`--name '${String(componentName).toLowerCase()}'`) ||
        item.rawCommandLine.toLowerCase().includes(`--name "${String(componentName).toLowerCase()}"`))
      .sort((a, b) => String(b.startTime || "").localeCompare(String(a.startTime || "")));
    lastCandidates = matching;

    if (matching.length > 0) {
      return {
        port: matching[0].port,
        source: preview ? "activeMatchingPreviewProcess" : "latestMatchingPreviewProcess",
        candidates: matching.map(item => ({
          port: item.port,
          pid: item.pid,
          processName: item.processName,
          commandLine: item.commandLine,
          startTime: item.startTime
        }))
      };
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return {
    port: null,
    source: "notFound",
    candidates: lastCandidates.map(item => ({
      port: item.port,
      pid: item.pid,
      processName: item.processName,
      commandLine: item.commandLine,
      startTime: item.startTime
    }))
  };
}

async function findSalesforceProjectRoot(repoPath, config) {
  let current = resolveAllowedPath(repoPath, config);

  for (;;) {
    const marker = path.join(current, "sfdx-project.json");

    try {
      await fs.access(marker);
      return current;
    } catch {
      const parent = path.dirname(current);

      if (parent === current) {
        break;
      }

      current = parent;
    }
  }

  throw new Error(`Projeto Salesforce DX nao encontrado a partir de: ${repoPath}`);
}

async function deriveComponentName(input) {
  if (input.componentName) {
    return input.componentName;
  }

  if (!input.componentPath) {
    throw new Error("Informe componentName ou componentPath.");
  }

  const resolved = resolveAllowedPath(input.componentPath, input.config);
  const stat = await fs.stat(resolved);
  let current = stat.isDirectory() ? resolved : path.dirname(resolved);

  for (;;) {
    const parent = path.dirname(current);

    if (path.basename(parent).toLowerCase() === "lwc") {
      return path.basename(current);
    }

    if (parent === current) {
      break;
    }

    current = parent;
  }

  throw new Error(`Nao consegui descobrir componentName a partir de componentPath: ${resolved}`);
}

async function collectVisibleText(page, maxChars = 8000) {
  return await page.evaluate(limitChars => {
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return text.slice(0, limitChars);
  }, maxChars).catch(() => "");
}

async function maybeSelectComponent(page, componentName) {
  if (!componentName) {
    return null;
  }

  const visibleText = await collectVisibleText(page, 4000);

  if (!/select a component/i.test(visibleText)) {
    return null;
  }

  try {
    await page.getByText(componentName, { exact: false }).first().click({ timeout: 5000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    return `Tela de selecao detectada; tentei selecionar ${componentName}.`;
  } catch (error) {
    return `Tela de selecao detectada; nao consegui selecionar ${componentName}: ${error.message}`;
  }
}

function buildSfCommand({ componentName, targetOrg }) {
  const parts = [
    "sf",
    "lightning",
    "dev",
    "component",
    "--name",
    psQuote(componentName)
  ];

  if (targetOrg) {
    parts.push("--target-org", psQuote(targetOrg));
  }

  return parts.join(" ");
}

async function startLwcPreview(context, input) {
  const repoRoot = await findSalesforceProjectRoot(input.repoPath, context.config);
  const componentName = await deriveComponentName({
    componentName: input.componentName,
    componentPath: input.componentPath,
    config: context.config
  });
  const key = previewKey({ repoRoot, componentName, targetOrg: input.targetOrg });
  const existing = managedPreviews.get(key);
  const processMode = input.processMode || "fresh";
  let stoppedPreviews = [];
  let stoppedActiveSfPreviews = [];

  if (["reuse", "keep"].includes(processMode) && existing && isSessionAlive(existing.processSessionId)) {
    const processState = readProcessSession(existing.processSessionId);

    return {
      ...existing,
      reused: true,
      stoppedPreviews,
      stdout: redactSensitiveText(limit(processState.stdout)),
      stderr: redactSensitiveText(limit(processState.stderr)),
      exited: processState.exited,
      exitCode: processState.exitCode,
      discoveredUrls: extractUrls(`${processState.stdout}\n${processState.stderr}`)
    };
  }

  if (processMode === "fresh") {
    if (input.stopAllActiveSfPreviews) {
      stoppedActiveSfPreviews = await stopActiveSfPreviewProcesses("fresh-start-active-sf-cleanup");
    }

    stoppedPreviews = await stopManagedPreviews({
      repoRoot,
      componentName,
      targetOrg: input.targetOrg,
      allForRepo: Boolean(input.stopAllManagedForRepo),
      reason: "fresh-start"
    });
  }

  const command = buildSfCommand({
    componentName,
    targetOrg: input.targetOrg
  });
  const processSession = await startShellProcess(command, {
    cwd: repoRoot,
    config: context.config
  });

  if (input.waitMs > 0) {
    await new Promise(resolve => setTimeout(resolve, input.waitMs));
  }

  const processState = readProcessSession(processSession.sessionId);
  const output = `${processState.stdout}\n${processState.stderr}`;
  const discoveredUrls = extractUrls(output);

  await appendLog("lwc_preview_start", {
    repoRoot,
    componentName,
    targetOrg: input.targetOrg || null,
    processSessionId: processSession.sessionId,
    discoveredUrlCount: discoveredUrls.length,
    processMode,
    stoppedPreviewCount: stoppedPreviews.length,
    stoppedActiveSfPreviewCount: stoppedActiveSfPreviews.length
  });

  const registryItem = {
    key,
    repoRoot,
    componentName,
    targetOrg: input.targetOrg || null,
    processSessionId: processSession.sessionId,
    pid: processSession.pid,
    command,
    startedAt: processSession.startedAt
  };
  managedPreviews.set(key, registryItem);

  return {
    key,
    repoRoot,
    componentName,
    processSessionId: processSession.sessionId,
    pid: processSession.pid,
    command,
    processMode,
    reused: false,
    stoppedPreviews,
    stoppedActiveSfPreviews,
    discoveredUrls,
    stdout: redactSensitiveText(limit(processState.stdout)),
    stderr: redactSensitiveText(limit(processState.stderr)),
    exited: processState.exited,
    exitCode: processState.exitCode
  };
}

export function registerLwcPreviewTools(server, context) {
  server.tool(
    "lwc_preview_start",
    "Inicia Salesforce LWC Local Dev Preview sem deploy e sem mock automatico. Use para manter servidor vivo; para screenshot pontual prefira lwc_preview_capture.",
    {
      repoPath: z.string(),
      componentPath: z.string().optional(),
      componentName: z.string().optional(),
      targetOrg: z.string().optional(),
      clientSelect: z.string().optional(),
      processMode: z.enum(["fresh", "reuse", "keep"]).default("fresh"),
      stopAllManagedForRepo: z.boolean().default(false),
      stopAllActiveSfPreviews: z.boolean().default(false),
      waitMs: z.number().int().min(0).max(60000).default(5000)
    },
    async input => {
      const result = await startLwcPreview(context, input);
      return jsonResult({
        ...result,
        clientSelect: input.clientSelect || null,
        note: "Processo mantido vivo via start_ps/processStore. Use stop_process com processSessionId para encerrar."
      });
    }
  );

  server.tool(
    "lwc_preview_list",
    "Lista previews LWC iniciados e gerenciados por esta instancia do MCP.",
    {},
    async () => jsonResult(managedPreviewList())
  );

  server.tool(
    "lwc_preview_stop",
    "Encerra previews LWC. Por padrao so para previews gerenciados pelo MCP; com allActiveSfPreviews=true tambem mata processos externos 'sf lightning dev component'.",
    {
      repoPath: z.string().optional(),
      componentName: z.string().optional(),
      targetOrg: z.string().optional(),
      processSessionId: z.string().optional(),
      allForRepo: z.boolean().default(false),
      all: z.boolean().default(false),
      allActiveSfPreviews: z.boolean().default(false)
    },
    async input => {
      const stopped = [];
      const stoppedActiveSfPreviews = input.allActiveSfPreviews
        ? await stopActiveSfPreviewProcesses("manual-stop-active-sf-previews")
        : [];

      if (input.all) {
        for (const item of [...managedPreviews.values()]) {
          const result = await stopManagedPreview(item, "stop-all");
          if (result) {
            stopped.push(result);
          }
        }

        return jsonResult({ stopped, stoppedActiveSfPreviews });
      }

      if (input.processSessionId) {
        const item = [...managedPreviews.values()].find(entry => entry.processSessionId === String(input.processSessionId));

        if (!item) {
          return jsonResult({ stopped, stoppedActiveSfPreviews, note: `Nenhum preview gerenciado encontrado para processSessionId ${input.processSessionId}.` });
        }

        const result = await stopManagedPreview(item, "stop-session");
        return jsonResult({ stopped: result ? [result] : [], stoppedActiveSfPreviews });
      }

      if (!input.repoPath) {
        if (input.allActiveSfPreviews) {
          return jsonResult({ stopped, stoppedActiveSfPreviews });
        }

        throw new Error("Informe repoPath, processSessionId, all=true ou allActiveSfPreviews=true.");
      }

      const repoRoot = await findSalesforceProjectRoot(input.repoPath, context.config);
      const result = await stopManagedPreviews({
        repoRoot,
        componentName: input.componentName || "",
        targetOrg: input.targetOrg,
        allForRepo: input.allForRepo,
        reason: input.allForRepo ? "stop-repo" : "stop-component"
      });

      return jsonResult({ stopped: result, stoppedActiveSfPreviews });
    }
  );

  server.tool(
    "lwc_preview_capture",
    "Fluxo final para screenshot de Salesforce LWC Local Dev: limpa processos ativos 'sf lightning dev component', inicia preview novo, espera waitMs, tira print definitivo e encerra. Nao abre navegador do usuario. Spinner/loading e a tela final capturada, nao motivo para continuar investigando, salvo pedido explicito.",
    {
      repoPath: z.string(),
      componentPath: z.string().optional(),
      componentName: z.string().optional(),
      targetOrg: z.string().optional(),
      existingUrl: z.string().optional(),
      cdpEndpoint: z.string().optional(),
      userDataDir: z.string().optional(),
      channel: z.string().optional(),
      processMode: z.enum(["fresh", "reuse", "keep", "attachOnly"]).default("fresh"),
      stopAfterCapture: z.boolean().default(true),
      stopAllManagedForRepo: z.boolean().default(true),
      stopAllActiveSfPreviews: z.boolean().default(true),
      browserMode: z.enum(["headless", "headful"]).default("headless"),
      outputPath: z.string().optional(),
      width: z.number().int().min(320).max(3840).default(context.config.browser?.width || 1440),
      height: z.number().int().min(240).max(2160).default(context.config.browser?.height || 1000),
      waitMs: z.number().int().min(0).max(60000).default(5000),
      fullPage: z.boolean().default(context.config.browser?.fullPage ?? true),
      includeConsole: z.boolean().default(false)
    },
    async input => {
      const componentName = await deriveComponentName({
        componentName: input.componentName,
        componentPath: input.componentPath,
        config: context.config
      });
      const repoRoot = await findSalesforceProjectRoot(input.repoPath, context.config);

      let preview = null;
      let stoppedAfterCapture = null;
      let targetUrl = input.existingUrl || null;
      let portInfo = null;
      let directPreviewPath = null;
      const observations = [];

      try {
        if (!targetUrl && !input.cdpEndpoint && input.processMode !== "attachOnly") {
          preview = await startLwcPreview(context, {
            ...input,
            componentName,
            processMode: input.processMode === "keep" ? "keep" : input.processMode,
            waitMs: Math.max(input.waitMs, 5000)
          });
          targetUrl = preview.discoveredUrls.find(url => /devpreview|localdev|localhost|127\.0\.0\.1/i.test(url)) || preview.discoveredUrls[0] || null;
        }

        if (!input.cdpEndpoint && (!targetUrl || isSelectorOrLocalDevRoot(targetUrl))) {
          portInfo = await waitForPreviewPort({
            preview,
            componentName,
            existingUrl: targetUrl,
            waitMs: Math.max(input.waitMs, 10000)
          });

          if (portInfo.port) {
            directPreviewPath = buildDirectPreviewPath({
              port: portInfo.port,
              componentName
            });
            targetUrl = await sfOrgOpenUrl({
              repoRoot,
              targetOrg: input.targetOrg,
              sfPath: directPreviewPath
            });
            observations.push(`URL direta autenticada gerada para c/${componentName} na porta ${portInfo.port} (${portInfo.source}).`);
          }
        }

        if (!input.cdpEndpoint && targetUrl && isDirectComponentPreviewUrl(targetUrl, componentName) && !targetUrl.includes("/secur/frontdoor.jsp") && !input.userDataDir) {
          const sfPath = extractSalesforcePath(targetUrl);

          if (sfPath) {
            targetUrl = await sfOrgOpenUrl({
              repoRoot,
              targetOrg: input.targetOrg,
              sfPath
            });
            observations.push("URL direta do componente reaberta via sf org open para autenticar o browser headless.");
          }
        }

        const session = input.cdpEndpoint
          ? await attachBrowserSession(context.config, {
            cdpEndpoint: input.cdpEndpoint,
            width: input.width,
            height: input.height
          })
          : await createBrowserSession(context.config, {
            headless: input.browserMode === "headless",
            width: input.width,
            height: input.height,
            channel: input.channel,
            userDataDir: input.userDataDir
              ? resolveAllowedPath(input.userDataDir, context.config)
              : undefined
          });

        let page = getBrowserPage(session);
        let pageId = getBrowserPageId(session, page);

        if (!targetUrl && input.cdpEndpoint) {
          const pages = await listBrowserPages(session);
          const match = pages.find(item => {
            const haystack = `${item.title} ${item.url}`;
            return haystack.toLowerCase().includes(componentName.toLowerCase()) ||
              /devpreview|localdev|lwr\/application/i.test(haystack);
          });

          if (match) {
            page = getBrowserPage(session, match.pageId);
            pageId = match.pageId;
            targetUrl = page.url();
            observations.push(`URL encontrada em aba CDP existente: ${match.pageId}.`);
          }
        }

        if (!targetUrl) {
          throw new Error([
            "Nao consegui descobrir a URL direta do Live Preview.",
            "Tente novamente com processMode='fresh' ou informe existingUrl/cdpEndpoint.",
            "Nao use a pagina local http://localhost:<porta>/ como screenshot final; ela e so a pagina de instrucoes do LWC Local Dev.",
            portInfo?.candidates?.length ? `candidatePorts: ${JSON.stringify(portInfo.candidates)}` : "",
            preview ? `stdout:\n${preview.stdout}\nstderr:\n${preview.stderr}` : ""
          ].join("\n"));
        }

        const response = input.cdpEndpoint && page.url() === targetUrl
          ? null
          : await page.goto(targetUrl, {
            waitUntil: context.config.browser?.waitUntil || "domcontentloaded",
            timeout: 60000
          });

      if (input.waitMs > 0) {
        await page.waitForTimeout(input.waitMs);
      }

      const selectionNote = await maybeSelectComponent(page, componentName);

      if (selectionNote) {
        observations.push(selectionNote);
      }

      const savedPath = input.outputPath
        ? resolveAllowedPath(input.outputPath, context.config)
        : path.join(SCREENSHOT_DIR, `lwc-${componentName}-${timestamp()}.png`);
      await fs.mkdir(path.dirname(savedPath), { recursive: true });
      const buffer = await page.screenshot({
        path: savedPath,
        fullPage: input.fullPage
      });

      const visibleText = await collectVisibleText(page, 8000);
      const consoleMessages = input.includeConsole
        ? session.consoleMessages
          .filter(item => ["error", "warning"].includes(item.type))
          .slice(-50)
        : [];
      const finalUrl = page.url();
      const routeIsDirectComponentPreview = isDirectComponentPreviewUrl(finalUrl, componentName);
      const routeLooksLikeSelector = isSelectorOrLocalDevRoot(finalUrl);

      if (routeIsDirectComponentPreview) {
        observations.push("Rota direta do componente aberta. Screenshot salvo como resultado final; spinner/loading e estado sem dados contam como estado visual capturado.");
      } else if (routeLooksLikeSelector) {
        observations.push("A pagina final ainda parece ser o seletor/root do LWC Local Dev, nao a rota direta do componente.");
      }

      await appendLog("lwc_preview_capture", {
        repoPath: input.repoPath,
        componentName,
        sessionId: session.sessionId,
        pageId,
        savedPath,
        existingUrlUsed: Boolean(input.existingUrl),
        cdpUsed: Boolean(input.cdpEndpoint),
        processMode: input.processMode,
        stopAfterCapture: input.stopAfterCapture,
        portSource: portInfo?.source || null,
        routeIsDirectComponentPreview
      });

      if (input.stopAfterCapture && preview?.key) {
        stoppedAfterCapture = await stopManagedPreview(managedPreviews.get(preview.key), "stop-after-capture");
      }

      return imageResult(JSON.stringify({
        savedAt: savedPath,
        componentName,
        sessionId: session.sessionId,
        pageId,
        processSessionId: preview?.processSessionId || null,
        processMode: input.processMode,
        stoppedAfterCapture,
        url: redactSensitiveText(finalUrl),
        title: await page.title().catch(() => ""),
        httpStatus: response ? response.status() : null,
        resultKind: "final_screenshot",
        captureComplete: true,
        shouldStopAfterCapture: true,
        nextAction: "describe_screenshot_to_user",
        routeIsDirectComponentPreview,
        routeLooksLikeSelector,
        directPreviewPath,
        portInfo: portInfo
          ? {
            ...portInfo,
            candidates: portInfo.candidates || []
          }
          : null,
        note: "Captura final concluida apos waitMs. Descreva o que aparece no screenshot. Nao rode mais probes, console, snapshots ou tentativas de login apenas porque ha spinner/loading, a menos que o usuario tenha pedido investigacao adicional.",
        visibleText,
        consoleMessages,
        consoleOmitted: !input.includeConsole,
        observations
      }, null, 2), buffer.toString("base64"));
      } catch (error) {
        if (input.stopAfterCapture && preview?.key) {
          await stopManagedPreview(managedPreviews.get(preview.key), "stop-after-error");
        }

        throw error;
      }
    }
  );
}
