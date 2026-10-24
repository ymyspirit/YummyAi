"use client";
import { ArrowRight, Layers3, ShieldCheck } from "lucide-react";
import "./identity.css";
export function ErpLogin({
  returnTo,
  reason,
  configured,
}: {
  returnTo: string;
  reason: string;
  configured: boolean;
}) {
  const message =
    reason === "erp_access_denied"
      ? "当前账户尚无运营工作台权限 请联系管理员"
      : reason === "login_invalid"
        ? "上次登录未完成 请重新登录"
        : reason === "session_unavailable" || !configured
          ? "登录服务暂时不可用 请联系管理员核对入口"
          : reason === "authority_changed"
            ? "当前权限已变化 请重新核对后继续"
            : "";
  return (
    <main className="erp-login">
      <a className="erp-login-brand" href="/login">
        <Layers3 size={25} />
        <span>YummyAI</span>
      </a>
      <section aria-label="运营账户登录">
        <ShieldCheck size={28} />
        <h1>登录运营工作台</h1>
        <p>使用自己的账户 访问获授权的商品与订单</p>
        {message && (
          <p role="alert" className="erp-login-notice">
            {message}
          </p>
        )}
        <a
          className="erp-login-action"
          aria-disabled={!configured}
          href={configured ? `/api/erp-auth/login?${new URLSearchParams({ returnTo })}` : undefined}
        >
          使用运营账户登录
          <ArrowRight size={17} />
        </a>
        <p className="erp-login-help">账户开通和权限变更请联系团队管理员</p>
      </section>
    </main>
  );
}
