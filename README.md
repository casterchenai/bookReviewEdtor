# BookReviewEditor · 图书出版前协同审校平台

BookReviewEditor 是一站式的图书出版前协同审校与修订管理平台，将 **主编、文学经纪人、AI 智能助手、审校员** 四类核心角色纳入统一的协作生态，共同完成未出版书稿的专业审阅、校对、修订与优化。

## 核心功能（MVP）

| 模块 | 说明 |
|---|---|
| 多角色协作 | 主编（制定修订标准、定稿、采纳建议）· 文学经纪人（市场适配建议）· 审校员（深度润色）· AI 智能助手（智能校对） |
| 书稿管理 | 项目 → 章节书稿，支持草稿 / 审校中 / 已定稿状态流转，定稿锁定 |
| 全流程修订记录 | 每次保存生成完整版本快照，记录修订人、角色、时间、修订说明；支持版本对比（逐字 Diff）、历史查询与一键回滚 |
| 审阅意见 | 段落级锚定的意见与整段修改建议；主编可一键采纳（自动应用并生成新版本）或驳回，全程留痕 |
| AI 智能审校 | 基于 Claude API 的语法纠错、用词优化、逻辑瑕疵检测与内容规范检查；遵循主编制定的修订标准；未配置密钥时自动退化为演示模式 |
| 操作日志 | 项目内关键操作（创建、修订、采纳、定稿、回滚等）系统化归档 |

## 技术栈

- **前端**：Next.js 15（App Router）+ React 19，简体中文界面
- **后端**：Express + TypeScript + Zod 校验，JWT 认证
- **数据库**：PostgreSQL + Prisma ORM
- **AI**：Anthropic Claude API（结构化输出，默认模型 `claude-sonnet-5`）
- **仓库结构**：npm workspaces monorepo（`apps/api` + `apps/web`）

## 快速开始

要求：Node.js ≥ 20。

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
copy .env.example .env        # Windows（macOS/Linux 用 cp）
# 如需真实 AI 审校，在 .env 中填写 ANTHROPIC_API_KEY

# 3. 启动开发数据库（内嵌 Postgres，免安装；保持窗口运行）
npm run dev:db

# 4. 初始化表结构与演示数据（新终端执行）
npm run db:push
npm run db:seed

# 5. 启动后端与前端（各开一个终端）
npm run dev:api     # http://localhost:4000
npm run dev:web     # http://localhost:3100
```

打开 http://localhost:3100 ，使用演示账户登录（密码均为 `demo1234`）：

| 角色 | 邮箱 |
|---|---|
| 主编 | chief@demo.com |
| 文学经纪人 | agent@demo.com |
| 审校员 | reviewer@demo.com |

> 也可以使用 `docker-compose up -d` 启动 Postgres 代替内嵌数据库（连接串一致）。

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` `/api/auth/login` | 注册 / 登录（JWT） |
| GET/POST | `/api/projects` | 项目列表 / 创建项目 |
| PATCH | `/api/projects/:id` | 更新项目、修订标准（仅主编） |
| POST | `/api/projects/:id/members` | 添加成员（仅主编） |
| POST | `/api/projects/:id/manuscripts` | 新建书稿 |
| GET | `/api/manuscripts/:id` | 书稿详情（含意见与修订记录） |
| PUT | `/api/manuscripts/:id/content` | 保存内容 → 生成新修订版本（须附修订说明） |
| GET | `/api/manuscripts/:id/revisions/:number` | 历史版本全文（用于对比） |
| POST | `/api/manuscripts/:id/rollback` | 回滚到历史版本（仅主编，生成新版本） |
| POST | `/api/manuscripts/:id/finalize` | 定稿 / 解除定稿（仅主编） |
| POST | `/api/manuscripts/:id/comments` | 提交审阅意见 / 修改建议 |
| PATCH | `/api/manuscripts/:id/comments/:cid` | 解决 / 采纳 / 驳回（采纳自动应用并生成版本） |
| POST | `/api/ai/manuscripts/:id/review` | AI 智能审校（写入 AI 助手的段落级建议） |

## 权限模型

- **主编 CHIEF_EDITOR**：项目设置、修订标准、成员管理、采纳/驳回建议、定稿、回滚
- **文学经纪人 AGENT** / **审校员 REVIEWER**：编辑书稿（生成版本）、提交意见与修改建议、标记解决
- **AI 智能助手 AI_ASSISTANT**：系统内置账户，仅通过 AI 审校接口以其身份写入建议

## 目录结构

```
apps/
  api/          Express API（Prisma schema、路由、AI 集成、种子数据）
  web/          Next.js 前端（登录、项目、书稿工作台）
docker-compose.yml   生产/团队用 Postgres
.env.example         环境变量模板
```

## 后续规划

- 富文本/批注级选区锚定（当前为段落级）
- WebSocket 实时协同与在线状态
- 修订记录导出（PDF/Word 审校报告）
- 三审三校流程模板与阶段门禁
