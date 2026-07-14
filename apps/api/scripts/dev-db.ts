// 本地开发数据库：内嵌 Postgres（无需安装 Docker 或 Postgres）
// 数据持久化在 apps/api/data/pg，端口 5502
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseDir = path.join(here, "..", "data", "pg");
const initialised = existsSync(path.join(databaseDir, "PG_VERSION"));

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password: "postgres",
  port: 5502,
  persistent: true,
});

async function main() {
  if (!initialised) {
    console.log("首次运行：初始化数据库目录 …");
    await pg.initialise();
  }
  await pg.start();
  if (!initialised) {
    await pg.createDatabase("bookreview");
  }
  console.log("✅ Postgres 已启动: postgresql://postgres:postgres@localhost:5502/bookreview");
  console.log("   按 Ctrl+C 停止");

  const stop = async () => {
    console.log("正在停止数据库 …");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pg.stop();
  } catch {}
  process.exit(1);
});
