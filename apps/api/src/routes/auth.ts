import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, signToken, type AuthedRequest } from "../middleware/auth.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  password: z.string().min(8, "密码至少 8 位"),
  name: z.string().min(1, "请填写姓名").max(50),
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, password, name } = parsed.data;

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "该邮箱已注册" });

  const user = await prisma.user.create({
    data: { email, name, passwordHash: await bcrypt.hash(password, 10) },
  });
  res.json({ token: signToken(user.id), user: { id: user.id, email, name } });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = typeof email === "string" ? await prisma.user.findUnique({ where: { email } }) : null;
  if (!user || user.isAI || !(await bcrypt.compare(String(password ?? ""), user.passwordHash))) {
    return res.status(401).json({ error: "邮箱或密码错误" });
  }
  res.json({ token: signToken(user.id), user: { id: user.id, email: user.email, name: user.name } });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: "用户不存在" });
  res.json({ id: user.id, email: user.email, name: user.name });
});
