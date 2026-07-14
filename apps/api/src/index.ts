import "./env.js";
import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { manuscriptsRouter } from "./routes/manuscripts.js";
import { aiRouter } from "./routes/ai.js";
import { adminRouter } from "./routes/admin.js";
import { bootstrap } from "./bootstrap.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "40mb" })); // 容纳 base64 编码的 PDF 上传

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/manuscripts", manuscriptsRouter);
app.use("/api/ai", aiRouter);

// 统一错误处理
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});

bootstrap()
  .catch((e) => console.error("引导初始化失败:", e))
  .finally(() => {
    app.listen(env.port, () => {
      console.log(`✅ BookReviewEditor API 已启动: http://localhost:${env.port}`);
    });
  });
