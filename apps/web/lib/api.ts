// 统一的 API 客户端：附带 JWT，统一错误处理
const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function getToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("bre_token");
}

export type SessionUser = {
  id: string; name: string; email: string;
  isSuperAdmin?: boolean; canCreateBooks?: boolean;
};

export function setSession(token: string, user: SessionUser) {
  localStorage.setItem("bre_token", token);
  localStorage.setItem("bre_user", JSON.stringify(user));
}

export function getUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("bre_user");
  return raw ? JSON.parse(raw) : null;
}

export function clearSession() {
  localStorage.removeItem("bre_token");
  localStorage.removeItem("bre_user");
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      clearSession();
      window.location.href = "/login";
    }
    throw new ApiError(res.status, (data as { error?: string }).error || "请求失败");
  }
  return data as T;
}

export const ROLE_LABEL: Record<string, string> = {
  CHIEF_EDITOR: "主编",
  AGENT: "文学经纪人",
  REVIEWER: "审校员",
  AI_ASSISTANT: "AI 智能助手",
};

export const CATEGORY_LABEL: Record<string, string> = {
  GENERAL: "一般意见",
  GRAMMAR: "语法纠错",
  WORDING: "用词优化",
  LOGIC: "逻辑问题",
  STYLE: "表达风格",
  MARKET: "市场适配",
  STANDARD: "内容规范",
};

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  IN_REVIEW: "审校中",
  FINALIZED: "已定稿",
  OPEN: "待处理",
  RESOLVED: "已解决",
  ACCEPTED: "已采纳",
  REJECTED: "已驳回",
};
