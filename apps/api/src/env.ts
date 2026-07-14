import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 依次加载 apps/api/.env 和仓库根目录 .env（先加载者优先）
dotenv.config({ path: path.join(here, "..", ".env") });
dotenv.config({ path: path.join(here, "..", "..", "..", ".env") });

export const env = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-do-not-use-in-production",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5502/bookreview",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  aiModel: process.env.AI_MODEL || "claude-sonnet-5",
  // 超级管理员凭据（存于环境变量）
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || "admin@bookreview.local",
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || "admin12345",
  superAdminName: process.env.SUPER_ADMIN_NAME || "超级管理员",
};

process.env.DATABASE_URL = env.databaseUrl;
