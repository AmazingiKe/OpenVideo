import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIRECTORY, "..");
const LOG_DIRECTORY = join(PROJECT_ROOT, "runtime", "logs", "dev");
const IS_WINDOWS = process.platform === "win32";
const FRONTEND_COMMAND = IS_WINDOWS
  ? "pnpm --filter @openvideo/web dev"
  : "pnpm";
const FRONTEND_ARGUMENTS = IS_WINDOWS
  ? []
  : ["--filter", "@openvideo/web", "dev"];

const SERVICE_DEFINITIONS = [
  {
    name: "backend",
    command: "uv",
    arguments: [
      "run",
      "uvicorn",
      "openvideo.ui.api:app",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "--reload",
    ],
    workingDirectory: join(PROJECT_ROOT, "apps", "backend"),
    useShell: false,
  },
  {
    name: "frontend",
    command: FRONTEND_COMMAND,
    arguments: FRONTEND_ARGUMENTS,
    workingDirectory: PROJECT_ROOT,
    useShell: IS_WINDOWS,
  },
];

mkdirSync(LOG_DIRECTORY, { recursive: true });

const runningServices = new Map();
let stopping = false;
let exitCode = 0;

function stopProcessTree(childProcess) {
  if (!childProcess.pid || childProcess.exitCode !== null) {
    return;
  }
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    return;
  }
  process.kill(-childProcess.pid, "SIGTERM");
}

function stopServices() {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const service of runningServices.values()) {
    stopProcessTree(service.childProcess);
  }
}

function startService(definition) {
  const stdoutPath = join(LOG_DIRECTORY, `${definition.name}.stdout.log`);
  const stderrPath = join(LOG_DIRECTORY, `${definition.name}.stderr.log`);
  const stdoutLog = createWriteStream(stdoutPath, { flags: "w" });
  const stderrLog = createWriteStream(stderrPath, { flags: "w" });
  const childProcess = spawn(definition.command, definition.arguments, {
    cwd: definition.workingDirectory,
    detached: !IS_WINDOWS,
    env: process.env,
    shell: definition.useShell,
    stdio: ["inherit", "pipe", "pipe"],
  });

  runningServices.set(definition.name, { childProcess, stdoutLog, stderrLog });
  childProcess.stdout.pipe(process.stdout);
  childProcess.stdout.pipe(stdoutLog);
  childProcess.stderr.pipe(process.stderr);
  childProcess.stderr.pipe(stderrLog);

  childProcess.on("error", (error) => {
    console.error(`${definition.name} 启动失败：${error.message}`);
    exitCode = 1;
    stopServices();
  });
  childProcess.on("close", (code) => {
    stdoutLog.end();
    stderrLog.end();
    runningServices.delete(definition.name);
    if (!stopping) {
      if (code !== 0) {
        console.error(
          `${definition.name} 已异常退出，退出码：${code ?? "未知"}`,
        );
        exitCode = code ?? 1;
      }
      stopServices();
    }
    if (runningServices.size === 0) {
      process.exitCode = exitCode;
    }
  });
}

process.on("SIGINT", stopServices);
process.on("SIGTERM", stopServices);

for (const definition of SERVICE_DEFINITIONS) {
  startService(definition);
}

console.log(`开发日志目录：${LOG_DIRECTORY}`);
