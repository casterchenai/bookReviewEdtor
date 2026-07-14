import "./env.js";
import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { manuscriptsRouter } from "./routes/manuscripts.js";
import { aiRouter } from "./routes/ai.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/manuscripts", manuscriptsRouter);
app.use("/api/ai", aiRouter);

// 统一错误处理
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});

app.listen(env.port, () => {
  console.log(`✅ BookReviewEditor API 已启动: http://localhost:${env.port}`);
  console.log(`   AI 引擎: ${env.anthropicApiKey ? `Claude（${env.aiModel}）` : "演示模式（未配置 ANTHROPIC_API_KEY）"}`);
});
