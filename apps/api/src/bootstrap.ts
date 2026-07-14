// 启动引导：从环境变量同步超级管理员账户 + 确保存在 AI 助手账户与全局 AI 配置
import bcrypt from "bcryptjs";
import { prisma } from "./db.js";
import { env } from "./env.js";

export async function bootstrap() {
  // 超级管理员：凭据来自环境变量，每次启动同步（改了 env 密码即生效）
  const passwordHash = await bcrypt.hash(env.superAdminPassword, 10);
  await prisma.user.upsert({
    where: { email: env.superAdminEmail },
    update: { passwordHash, name: env.superAdminName, isSuperAdmin: true, canCreateBooks: true },
    create: {
      email: env.superAdminEmail,
      name: env.superAdminName,
      passwordHash,
      isSuperAdmin: true,
      canCreateBooks: true,
    },
  });

  // AI 智能助手系统账户（不可登录）
  await prisma.user.upsert({
    where: { email: "ai@bookrevieweditor.local" },
    update: {},
    create: { email: "ai@bookrevieweditor.local", name: "AI 智能助手", passwordHash: "!", isAI: true },
  });

  // 全局 AI 配置单例（projectId = null）。为空时从环境变量推断默认值
  const existingGlobal = await prisma.aiConfig.findFirst({ where: { projectId: null } });
  if (!existingGlobal) {
    await prisma.aiConfig.create({
      data: {
        projectId: null,
        provider: env.anthropicApiKey ? "ANTHROPIC" : "AUTO",
        model: env.anthropicApiKey ? env.aiModel : "",
        apiKey: "",
        baseUrl: "",
      },
    });
  }

  console.log(`   超级管理员: ${env.superAdminEmail}`);
}
