import { redirect } from "next/navigation";

// 服务端重定向到登录页（不依赖客户端 JS），避免根路径在缓存失效/JS 加载失败时空白。
// 已登录用户到 /login 后由登录页跳转到 /dashboard。
export default function Home() {
  redirect("/login");
}
