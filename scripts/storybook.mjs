import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIRECTORY, "..");
const WEB_DIRECTORY = join(PROJECT_ROOT, "apps", "web");
const LOG_DIRECTORY = join(tmpdir(), "OpenVideo", "logs", "dev");
const STORYBOOK_LOG_PATH = join(LOG_DIRECTORY, "storybook.log");
const IS_WINDOWS = process.platform === "win32";
const STORYBOOK_PACKAGE_PATH = join(
  WEB_DIRECTORY,
  "node_modules",
  "storybook",
  "package.json",
);
const storybookPackage = JSON.parse(
  readFileSync(STORYBOOK_PACKAGE_PATH, "utf8"),
);
const STORYBOOK_CLI_PATH = join(
  dirname(STORYBOOK_PACKAGE_PATH),
  storybookPackage.bin,
);
const COMMAND_ARGUMENTS = {
  build: ["build"],
  dev: ["dev", "--port", "6006"],
};

const commandName = process.argv[2];
const commandArguments = COMMAND_ARGUMENTS[commandName];
if (!commandArguments) {
  console.error("Storybook 命令必须是 dev 或 build");
  process.exitCode = 1;
} else {
  mkdirSync(LOG_DIRECTORY, { recursive: true });
  const childProcess = spawn(
    process.execPath,
    [STORYBOOK_CLI_PATH, ...commandArguments, "--logfile", STORYBOOK_LOG_PATH],
    {
      cwd: WEB_DIRECTORY,
      env: process.env,
      stdio: "inherit",
    },
  );

  function stopStorybook() {
    if (!childProcess.pid || childProcess.exitCode !== null) {
      return;
    }
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      return;
    }
    childProcess.kill("SIGTERM");
  }

  process.on("SIGINT", stopStorybook);
  process.on("SIGTERM", stopStorybook);
  childProcess.on("error", (error) => {
    console.error(`Storybook 启动失败：${error.message}`);
    process.exitCode = 1;
  });
  childProcess.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
