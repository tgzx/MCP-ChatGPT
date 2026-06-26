import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { jsonResult } from "../core/result.mjs";
import { redactSensitiveText } from "../core/redact.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_PORTS = [
  3000, 3001, 4173, 4200, 5000, 5173, 5174, 8000,
  8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090
];

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 65535))];
}

function buildPorts(input) {
  if (input.discoverListening) {
    return [];
  }

  const explicit = Array.isArray(input.ports) && input.ports.length > 0
    ? input.ports
    : DEFAULT_PORTS;

  if (!input.portStart && !input.portEnd) {
    return uniqueNumbers(explicit).slice(0, input.maxPorts);
  }

  const start = Number(input.portStart || input.portEnd);
  const end = Number(input.portEnd || input.portStart);
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const range = [];

  for (let port = low; port <= high && range.length < input.maxPorts; port += 1) {
    range.push(port);
  }

  return uniqueNumbers([...explicit, ...range]).slice(0, input.maxPorts);
}

async function listWindowsListeningProcesses(timeoutMs) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$connections = Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess",
    "$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique",
    "$procs = @{}",
    "foreach ($pidValue in $pids) {",
    "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$pidValue\"",
    "  if ($p) { $procs[[string]$pidValue] = @{ ProcessId=$p.ProcessId; Name=$p.Name; CommandLine=$p.CommandLine; CreationDate=$p.CreationDate } }",
    "}",
    "$connections | ForEach-Object {",
    "  $proc = $procs[[string]$_.OwningProcess]",
    "  [pscustomobject]@{ LocalAddress=$_.LocalAddress; LocalPort=$_.LocalPort; OwningProcess=$_.OwningProcess; Process=$proc }",
    "} | ConvertTo-Json -Depth 5"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      script
    ], {
      timeout: timeoutMs,
      windowsHide: true
    });
    const parsed = JSON.parse(stdout || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];

    return rows
      .filter(row => row && row.LocalPort)
      .map(row => ({
        localAddress: row.LocalAddress,
        port: Number(row.LocalPort),
        pid: Number(row.OwningProcess),
        processName: row.Process?.Name || null,
        commandLine: redactSensitiveText(row.Process?.CommandLine || ""),
        startTime: row.Process?.CreationDate || null
      }));
  } catch {
    return [];
  }
}

function processForPort(processes, port) {
  return processes
    .filter(item => Number(item.port) === Number(port))
    .sort((a, b) => String(b.startTime || "").localeCompare(String(a.startTime || "")))[0] || null;
}

function extractTitle(text) {
  const match = String(text || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function extractUrls(text) {
  return [...String(text || "").matchAll(/https?:\/\/[^\s"'<>]+/gi)]
    .map(match => redactSensitiveText(match[0].replace(/[),.;]+$/g, "")))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .slice(0, 20);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow"
    });
    const text = await response.text();

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      finalUrl: redactSensitiveText(response.url),
      contentType: response.headers.get("content-type") || "",
      title: extractTitle(text),
      textSnippet: redactSensitiveText(text.replace(/\s+/g, " ").trim().slice(0, 1000)),
      urls: extractUrls(text)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? `Timeout after ${timeoutMs}ms` : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

export function registerLocalHttpTools(server) {
  server.tool(
    "local_http_probe",
    "Descobre/prova servidores HTTP locais em portas comuns ou informadas. Generico para Vite, Next, APIs, docs e previews locais.",
    {
      host: z.string().default("127.0.0.1"),
      path: z.string().default("/"),
      schemes: z.array(z.enum(["http", "https"])).default(["http"]),
      ports: z.array(z.number().int().min(1).max(65535)).optional(),
      portStart: z.number().int().min(1).max(65535).optional(),
      portEnd: z.number().int().min(1).max(65535).optional(),
      maxPorts: z.number().int().min(1).max(200).default(40),
      timeoutMs: z.number().int().min(100).max(10000).default(2000),
      includeFailures: z.boolean().default(false),
      discoverListening: z.boolean().default(false),
      includeProcesses: z.boolean().default(false)
    },
    async input => {
      const listeningProcesses = (input.discoverListening || input.includeProcesses)
        ? await listWindowsListeningProcesses(Math.max(10000, input.timeoutMs * 2))
        : [];
      const discoveredPorts = listeningProcesses.map(item => item.port);
      const ports = input.discoverListening
        ? uniqueNumbers(discoveredPorts).slice(0, input.maxPorts)
        : buildPorts(input);
      const normalizedPath = input.path.startsWith("/") ? input.path : `/${input.path}`;
      const results = [];

      for (const port of ports) {
        for (const scheme of input.schemes) {
          const url = `${scheme}://${input.host}:${port}${normalizedPath}`;
          const result = await fetchWithTimeout(url, input.timeoutMs);
          const processInfo = input.includeProcesses
            ? processForPort(listeningProcesses, port)
            : null;

          if (result.ok || input.includeFailures) {
            results.push({
              url,
              host: input.host,
              port,
              scheme,
              process: processInfo,
              ...result
            });
          }
        }
      }

      return jsonResult({
        checked: ports.length * input.schemes.length,
        hits: results.filter(item => item.ok).length,
        discoveredListeningPorts: input.discoverListening ? ports : undefined,
        results
      });
    }
  );
}
