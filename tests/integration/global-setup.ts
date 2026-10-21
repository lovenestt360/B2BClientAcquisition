import { execSync } from "node:child_process";
import { config } from "dotenv";

export default function setup() {
  config();
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is required for integration tests");
  if (!/test/.test(url)) throw new Error("Refusing to migrate: DATABASE_URL_TEST must point at a *test* database");
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
