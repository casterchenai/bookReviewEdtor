// 数据种子：创建 AI 助手账户 + 演示账户与演示项目
import "./env.js";
import bcrypt from "bcryptjs";
import { prisma } from "./db.js";

const SAMPLE_CONTENT = `暮色四合的时候，沈知微终于抵达了那座临海的小城。咸涩的海风穿过老街的骑楼，卷起她风衣的下摆，也卷起了她刻意尘封了十年的记忆。

十年前，她也是在这样一个黄昏离开的。那时候的码头还没有翻新，木质的栈桥在潮水中吱呀作响，像一句没有说完的告别。父亲站在船尾，朝她挥手，说等秋天第一场汛期过去就回来。可是那年秋天，台风比汛期先到了。

如今她回来，是为了处理老宅。中介在电话里说，这样的老房子在本地已经不好出手了，年轻人都往省城去，留下的只有守着渔船的老人。她原本只打算待三天，签完字就走。

但她没有想到，会在老宅的阁楼里发现那只樟木箱子。箱子上的铜锁已经锈死，她用起子撬开的瞬间，一股陈年樟脑的气味涌出来，混着某种更深的、类似旧书页的味道。箱子里整整齐齐码着几十本航海日志，最上面那本的扉页上，是父亲遒劲的字迹：留给知微，等她想读的时候。`;

async function main() {
  console.log("正在写入种子数据 …");

  // AI 智能助手（系统内置账户，不可登录）
  const ai = await prisma.user.upsert({
    where: { email: "ai@bookrevieweditor.local" },
    update: {},
    create: {
      email: "ai@bookrevieweditor.local",
      name: "AI 智能助手",
      passwordHash: "!", // 不可登录
      isAI: true,
    },
  });

  const password = await bcrypt.hash("demo1234", 10);
  const [chief, agent, reviewer] = await Promise.all([
    prisma.user.upsert({
      where: { email: "chief@demo.com" },
      update: {},
      create: { email: "chief@demo.com", name: "陈主编", passwordHash: password },
    }),
    prisma.user.upsert({
      where: { email: "agent@demo.com" },
      update: {},
      create: { email: "agent@demo.com", name: "林经纪", passwordHash: password },
    }),
    prisma.user.upsert({
      where: { email: "reviewer@demo.com" },
      update: {},
      create: { email: "reviewer@demo.com", name: "苏审校", passwordHash: password },
    }),
  ]);

  const existing = await prisma.project.findFirst({ where: { title: "《潮汐之间》出版前审校" } });
  if (existing) {
    console.log("演示项目已存在，跳过。");
    return;
  }

  const project = await prisma.project.create({
    data: {
      title: "《潮汐之间》出版前审校",
      description: "长篇小说，预计明年春季出版。当前处于三审三校的第二轮审校阶段。",
      standards:
        "1. 全书统一使用简体中文规范用字，数字用法遵循 GB/T 15835。\n2. 人物姓名、地名前后必须一致（主角：沈知微）。\n3. 避免口语化冗余表达，保持文学性叙事风格。\n4. 每章修订必须填写修订说明，重大改动需附原因。",
      ownerId: chief.id,
      bookRoles: {
        create: [
          { name: "主编", base: "CHIEF_EDITOR", order: 0, isDefault: true },
          { name: "文学经纪人", base: "AGENT", order: 1, isDefault: true },
          { name: "审校员", base: "REVIEWER", order: 2, isDefault: true },
          { name: "AI 智能助手", base: "AI_ASSISTANT", order: 3, isDefault: true },
        ],
      },
    },
    include: { bookRoles: true },
  });
  const roleByBase = new Map(project.bookRoles.map((r) => [r.base, r.id]));
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId: chief.id, role: "CHIEF_EDITOR", bookRoleId: roleByBase.get("CHIEF_EDITOR") },
      { projectId: project.id, userId: agent.id, role: "AGENT", bookRoleId: roleByBase.get("AGENT") },
      { projectId: project.id, userId: reviewer.id, role: "REVIEWER", bookRoleId: roleByBase.get("REVIEWER") },
      { projectId: project.id, userId: ai.id, role: "AI_ASSISTANT", bookRoleId: roleByBase.get("AI_ASSISTANT") },
    ],
  });

  const manuscript = await prisma.manuscript.create({
    data: {
      projectId: project.id,
      title: "第一章 归来",
      order: 0,
      status: "IN_REVIEW",
      content: SAMPLE_CONTENT,
      revisions: {
        create: [
          {
            number: 1,
            authorId: chief.id,
            authorRole: "CHIEF_EDITOR",
            content: SAMPLE_CONTENT,
            summary: "导入作者交付的初稿",
          },
        ],
      },
    },
  });

  await prisma.comment.create({
    data: {
      manuscriptId: manuscript.id,
      authorId: agent.id,
      authorRole: "AGENT",
      paragraphIndex: 2,
      quote: "中介在电话里说",
      category: "MARKET",
      body: "从市场角度看，第三段引入中介与房产信息略显平淡，建议在本段埋一个更强的悬念钩子，提升第一章的留存率。",
    },
  });

  await prisma.activity.createMany({
    data: [
      { projectId: project.id, actorName: "陈主编", action: "创建项目", detail: project.title },
      { projectId: project.id, actorName: "陈主编", action: "导入初稿", detail: "《第一章 归来》" },
      { projectId: project.id, actorName: "林经纪", action: "提交审阅意见", detail: "市场适配建议 1 条" },
    ],
  });

  console.log("✅ 种子数据完成。演示账户（密码均为 demo1234）：");
  console.log("   主编:       chief@demo.com");
  console.log("   文学经纪人: agent@demo.com");
  console.log("   审校员:     reviewer@demo.com");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
