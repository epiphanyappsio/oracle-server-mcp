import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------- Settings (all come from environment variables) ----------
const PORT = Number(process.env.PORT || 3000);
const MCP_TOKEN = process.env.MCP_TOKEN || "";
// true  = commands run on the Oracle server itself (needs the Docker socket mounted)
// false = commands run inside this container only (safe for testing)
const HOST_ACCESS = process.env.HOST_ACCESS === "true";

const MAX_OUTPUT_CHARS = 100000;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_WRITE_BYTES = 80000;
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;

// Refuse to start without a strong login token.
if (MCP_TOKEN.length < 64) {
  console.error("MCP_TOKEN is missing or shorter than 64 characters. Exiting.");
  process.exit(1);
}

// ---------- Safety list: commands that are always refused ----------
// This is a speed bump, not a wall. The real protections are the long token
// and Claude asking you to approve each tool call.
const BLOCKED = [
  [/\brm\s+(-[a-zA-Z-]+\s+)*\/\*?(\s|$|;|&|\|)/, "deleting the root folder"],
  [/\brm\s+(-[a-zA-Z-]+\s+)*(~|\$HOME)\/?\*?(\s|$|;|&|\|)/, "deleting the home folder"],
  [/\bmkfs(\.\w+)?\b/, "formatting a disk"],
  [/\bdd\b[^\n]*\bof=\/dev\//, "writing raw data to a disk"],
  [/>\s*\/dev\/(sd|nvme|vd|mmcblk|xvd)/, "writing raw data to a disk"],
  [/:\(\)\s*\{/, "fork bomb"],
  [/\bdrop\s+(database|schema)\b/i, "dropping a database"],
  [/\btruncate\s+table\b/i, "truncating a table"],
  [/\bgit\s+push\b[^\n]*(--force|\s-f\b)/, "force pushing"],
  [/\b(shutdown|reboot|poweroff|halt)\b/, "shutting down or rebooting the server"],
  [/\binit\s+0\b/, "shutting down the server"],
  [/\bdocker\s+(system|volume)\s+prune\b/, "pruning Docker data"],
  [/\bdocker\s+volume\s+(rm|remove)\b/, "deleting Docker volumes"],
  [
    /\bdocker(\s+compose|-compose)\b[^\n]*\bdown\b[^\n]*(\s-v\b|--volumes)/,
    "deleting Docker volumes",
  ],
];

function blockedReason(command) {
  for (const [pattern, reason] of BLOCKED) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// ---------- Helpers ----------

// Compare two strings without leaking timing information.
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Wrap text in single quotes so the shell treats it as plain text.
function shellQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function audit(tool, ip, detail) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      tool,
      ip,
      detail: String(detail).slice(0, 200),
    })
  );
}

// Run one command. On the host it starts a short-lived privileged container
// that sees the host's files and runs the command there.
function runCommand(command, timeoutSeconds) {
  return new Promise((resolve) => {
    const name = `mcp-exec-${randomUUID()}`;
    let cmd;
    let args;
    if (HOST_ACCESS) {
      cmd = "docker";
      args = [
        "run",
        "--rm",
        "--name",
        name,
        "--privileged",
        "--pid=host",
        "--network=host",
        "-v",
        "/:/host",
        "alpine:3",
        "chroot",
        "/host",
        "/bin/bash",
        "-c",
        command,
      ];
    } else {
      cmd = "/bin/bash";
      args = ["-c", command];
    }

    let output = "";
    let truncated = false;
    let timedOut = false;
    let finished = false;

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    const collect = (chunk) => {
      if (output.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      if (HOST_ACCESS) {
        spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
      }
    }, timeoutSeconds * 1000);

    const done = (exitCode, extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, truncated, output: output + (extra || "") });
    };

    child.on("error", (error) => done(-1, `\nCould not start command: ${error.message}`));
    child.on("close", (code) => done(code === null ? -1 : code));
  });
}

function formatResult(result) {
  const lines = [`exit_code: ${result.exitCode}`];
  if (result.timedOut) lines.push("TIMED OUT: the command was stopped.");
  if (result.truncated) lines.push(`Output was cut at ${MAX_OUTPUT_CHARS} characters.`);
  lines.push("--- output ---", result.output);
  return {
    isError: result.exitCode !== 0 || result.timedOut,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

function refusal(reason) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Refused: this looks like ${reason}. Ask the owner to run it by hand if it is really needed.`,
      },
    ],
  };
}

// ---------- MCP server ----------
function buildServer(ip) {
  const server = new McpServer({ name: "oracle-server-mcp", version: "2.0.0" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Check that the MCP server is alive and whether host access is on.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            host_access: HOST_ACCESS,
            time: new Date().toISOString(),
          }),
        },
      ],
    })
  );

  server.registerTool(
    "run_command",
    {
      title: "Run command on the Oracle server",
      description:
        "Run a bash command on the Oracle server (or inside the container when host access is off). " +
        "Returns the exit code and the combined output. Dangerous commands are refused.",
      inputSchema: {
        command: z.string().min(1).max(8000),
        timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ command, timeout_seconds }) => {
      const reason = blockedReason(command);
      if (reason) {
        audit("run_command_blocked", ip, command);
        return refusal(reason);
      }
      audit("run_command", ip, command);
      const result = await runCommand(command, timeout_seconds || DEFAULT_TIMEOUT_SECONDS);
      return formatResult(result);
    }
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description: "Read the start of a text file by its full path.",
      inputSchema: {
        path: z.string().regex(/^\//).max(1000),
        max_bytes: z.number().int().min(1).max(MAX_OUTPUT_CHARS).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, max_bytes }) => {
      audit("read_file", ip, path);
      const limit = max_bytes || 20000;
      const result = await runCommand(`head -c ${limit} -- ${shellQuote(path)}`, 30);
      return formatResult(result);
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write a file",
      description:
        "Write text to a file by its full path. Overwriting first saves a copy named <file>.bak.<time>. Use mode append to add to the end.",
      inputSchema: {
        path: z.string().regex(/^\//).max(1000),
        content: z.string().max(MAX_WRITE_BYTES),
        mode: z.enum(["overwrite", "append"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ path, content, mode }) => {
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        return refusal(`a write bigger than ${MAX_WRITE_BYTES} bytes`);
      }
      audit("write_file", ip, `${mode || "overwrite"} ${path}`);
      const encoded = Buffer.from(content, "utf8").toString("base64");
      const target = shellQuote(path);
      const command =
        mode === "append"
          ? `echo ${encoded} | base64 -d >> ${target}`
          : `p=${target}; if [ -e "$p" ]; then cp -a "$p" "$p.bak.$(date +%s)"; fi; echo ${encoded} | base64 -d > "$p"`;
      const result = await runCommand(command, 30);
      if (result.exitCode === 0) {
        result.output = result.output || `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
      }
      return formatResult(result);
    }
  );

  return server;
}

// ---------- Web app ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

// Public health check (no secrets). Used by Coolify.
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Slow down password guessing: too many bad logins and the address is paused.
const failedLogins = new Map();

function clientIp(req) {
  return req.get("cf-connecting-ip") || req.ip || "unknown";
}

function requireToken(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const record = failedLogins.get(ip);
  if (record && record.resetAt > now && record.count >= MAX_FAILED_LOGINS) {
    res.status(429).json({ error: "Too many failed attempts. Try again later." });
    return;
  }

  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match || !safeEqual(match[1], MCP_TOKEN)) {
    if (failedLogins.size > 5000) failedLogins.clear();
    const current = record && record.resetAt > now ? record : { count: 0, resetAt: now + FAILED_LOGIN_WINDOW_MS };
    current.count += 1;
    failedLogins.set(ip, current);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  failedLogins.delete(ip);
  req.clientIp = ip;
  next();
}

// Stateless mode: a fresh server and transport for every request.
app.post("/mcp", requireToken, async (req, res) => {
  try {
    const server = buildServer(req.clientIp);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

function methodNotAllowed(req, res) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}
app.get("/mcp", requireToken, methodNotAllowed);
app.delete("/mcp", requireToken, methodNotAllowed);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`oracle-server-mcp listening on port ${PORT} (host access: ${HOST_ACCESS})`);
});
