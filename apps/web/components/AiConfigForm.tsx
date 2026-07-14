"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type AiProviderMeta = { key: string; label: string; defaultBaseUrl: string; models: string[] };
export type AiConfig = { provider: string; model: string; baseUrl: string; hasApiKey: boolean };

type Payload = { config: AiConfig | null; providers: AiProviderMeta[]; global?: AiConfig | null };

export default function AiConfigForm({
  endpoint,
  scope,
  onFlash,
}: {
  endpoint: string; // e.g. "/admin/ai-config" 或 "/projects/xxx/ai-config"
  scope: "global" | "book";
  onFlash?: (msg: string) => void;
}) {
  const [providers, setProviders] = useState<AiProviderMeta[]>([]);
  const [globalCfg, setGlobalCfg] = useState<AiConfig | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [provider, setProvider] = useState("AUTO");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [configured, setConfigured] = useState(false); // 本书是否已有专属配置
  const [busy, setBusy] = useState(false);

  function flash(m: string) { onFlash?.(m); }

  function apply(p: Payload) {
    setProviders(p.providers);
    setGlobalCfg(p.global ?? null);
    if (p.config) {
      setProvider(p.config.provider);
      setModel(p.config.model);
      setBaseUrl(p.config.baseUrl);
      setHasKey(p.config.hasApiKey);
      setConfigured(true);
    } else {
      setConfigured(false);
    }
  }

  useEffect(() => {
    api<Payload>(endpoint).then(apply).catch(() => {});
  }, [endpoint]);

  const meta = providers.find((p) => p.key === provider);

  async function save() {
    setBusy(true);
    try {
      await api(endpoint, { method: "PUT", body: { provider, model, apiKey: apiKey || undefined, baseUrl } });
      setApiKey("");
      const p = await api<Payload>(endpoint);
      apply(p);
      flash("AI 配置已保存");
    } catch (err) { flash(err instanceof Error ? err.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function clearBook() {
    setBusy(true);
    try {
      await api(endpoint, { method: "DELETE" });
      const p = await api<Payload>(endpoint);
      apply(p);
      setProvider("AUTO"); setModel(""); setBaseUrl(""); setApiKey("");
      flash("已清除本书配置，将回退到全局默认");
    } catch (err) { flash(err instanceof Error ? err.message : "操作失败"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {scope === "book" && (
        <div className="muted small" style={{ marginBottom: 10 }}>
          {configured
            ? "本书使用下方专属配置。"
            : `本书未单独配置，当前沿用全局默认${globalCfg ? `（${globalCfg.provider}${globalCfg.model ? " · " + globalCfg.model : ""}）` : ""}。`}
        </div>
      )}
      <div className="field">
        <label>供应商</label>
        <select className="select" value={provider} onChange={(e) => {
          setProvider(e.target.value);
          const m = providers.find((p) => p.key === e.target.value);
          if (m && !m.models.includes(model)) setModel(m.models[0] ?? "");
        }}>
          {providers.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {provider !== "AUTO" && (
        <>
          <div className="field">
            <label>模型 ID（可自定义）</label>
            <input className="input" list={`models-${scope}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 gpt-4o / glm-4.6 / deepseek-chat" />
            <datalist id={`models-${scope}`}>
              {meta?.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
          <div className="field">
            <label>API Key {hasKey && <span className="muted small">（已配置，留空则不改动）</span>}</label>
            <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? "••••••（已保存）" : "粘贴该供应商的 API Key"} />
          </div>
          <div className="field">
            <label>自定义端点 Base URL（可选）</label>
            <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={meta?.defaultBaseUrl || "留空使用供应商默认"} />
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button className="btn btn-sm" onClick={save} disabled={busy}>{busy ? "保存中…" : "保存配置"}</button>
        {scope === "book" && configured && (
          <button className="btn btn-ghost btn-sm" onClick={clearBook} disabled={busy}>清除（用全局默认）</button>
        )}
      </div>
    </div>
  );
}
