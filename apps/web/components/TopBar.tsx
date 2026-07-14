"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clearSession, getUser } from "@/lib/api";

export default function TopBar() {
  const router = useRouter();
  const user = typeof window !== "undefined" ? getUser() : null;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/dashboard" className="brand">
          BookReviewEditor<small>图书出版前协同审校平台</small>
        </Link>
        <div className="topbar-spacer" />
        {user && <span className="user">{user.name}</span>}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            clearSession();
            router.push("/login");
          }}
        >
          退出登录
        </button>
      </div>
    </header>
  );
}
