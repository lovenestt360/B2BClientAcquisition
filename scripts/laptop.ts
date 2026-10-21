/**
 * One-command laptop launcher:  npm run laptop   (add --dev for hot reload)
 *
 *  1. creates .env from .env.example on first run (random encryption key, Wi-Fi friendly cookies)
 *  2. makes sure PostgreSQL is reachable (starts the compose `db` service if Docker is available)
 *  3. applies migrations and seeds (idempotent)
 *  4. builds when the code changed, then serves on all interfaces so the iPhone can connect
 *  5. prints the Wi-Fi address and a QR code to scan with the iPhone camera
 */
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import QRCode from "qrcode";
import { config } from "dotenv";
import { lanAddresses } from "../src/server/lan";

const dev = process.argv.includes("--dev");
const PORT = Number(process.env.PORT ?? 3000);
const run = (cmd: string, env: NodeJS.ProcessEnv = process.env) => execSync(cmd, { stdio: "inherit", env });
const log = (m: string) => console.log(`\x1b[36m▸\x1b[0m ${m}`);

function ensureEnv() {
  if (existsSync(".env")) return;
  log("Creating .env (first run)");
  let text = readFileSync(".env.example", "utf8");
  const set = (k: string, v: string) => {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}\n${k}=${v}`;
  };
  set("APP_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  set("COOKIE_SECURE", "false"); // phone connects over plain http on Wi-Fi
  set("POSTGRES_PASSWORD", "app");
  set("JOBS_MODE", "inline");
  writeFileSync(".env", text, { mode: 0o600 });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 }, () => (s.end(), resolve(true)));
    s.on("error", () => resolve(false));
    s.on("timeout", () => (s.destroy(), resolve(false)));
  });
}

async function ensureDatabase() {
  const url = new URL(process.env.DATABASE_URL!);
  const host = url.hostname;
  const port = Number(url.port || 5432);
  if (await canConnect(host, port)) return;
  let docker = false;
  try {
    execSync("docker info", { stdio: "ignore" });
    docker = true;
  } catch {}
  if (!docker) {
    throw new Error(`PostgreSQL is not reachable at ${host}:${port}. Start Docker Desktop (then rerun) or install PostgreSQL 16.`);
  }
  log("Starting PostgreSQL in Docker");
  run("docker compose up -d db");
  for (let i = 0; i < 30; i++) {
    if (await canConnect(host, port)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("PostgreSQL did not start in time");
}

function needsBuild(): boolean {
  if (!existsSync(".next/BUILD_ID")) return true;
  try {
    const rev = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain -- src prisma", { encoding: "utf8" }).trim();
    const stamp = existsSync(".next/.laptop-rev") ? readFileSync(".next/.laptop-rev", "utf8") : "";
    return dirty !== "" || stamp !== rev;
  } catch {
    return false;
  }
}

async function main() {
  ensureEnv();
  config();
  await ensureDatabase();
  if (!existsSync("node_modules")) run("npm ci");
  log("Applying database migrations");
  run("npx prisma migrate deploy");
  log("Seeding (safe to repeat)");
  run("npx tsx prisma/seed.ts");

  if (!dev && needsBuild()) {
    log("Building the app (first run or code changed)");
    run("npx next build");
    try {
      writeFileSync(".next/.laptop-rev", execSync("git rev-parse HEAD", { encoding: "utf8" }).trim());
    } catch {}
  }

  const addrs = lanAddresses(PORT);
  console.log(`\n  Laptop:  http://localhost:${PORT}`);
  if (addrs.length) {
    console.log(`  iPhone:  ${addrs[0].url}   (same Wi-Fi)\n`);
    console.log(await QRCode.toString(`${addrs[0].url}/login`, { type: "terminal", small: true }));
    console.log("  Scan with the iPhone Camera → Safari → Share → Add to Home Screen.");
    addrs.slice(1).forEach((a) => console.log(`  also:    ${a.url}  (${a.name})`));
  } else {
    console.log("  No Wi-Fi address found: connect the laptop to Wi-Fi to use the iPhone.");
  }
  console.log("  Keep the laptop awake while you work from the phone. Ctrl+C to stop.\n");

  const child = spawn("npx", ["next", dev ? "dev" : "start", "-H", "0.0.0.0", "-p", String(PORT)], { stdio: "inherit", shell: process.platform === "win32" });
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
