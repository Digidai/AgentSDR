import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Building2,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  Copy,
  FileText,
  Globe,
  Inbox,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Table2,
  Target,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  api,
  useData,
  Row,
  csvDownload,
  readRows,
  normalizeRows,
  stageNames,
  stateNames,
  channelNames,
  date,
  Badge,
} from "./lib";
import "./style.css";
import {
  Channels,
  Discovery,
  CrmWorkspace,
  Calling,
  Workspace,
  LeadExtras,
  Recovery,
  CampaignExtras,
  ExtendedAnalytics,
} from "./extended";
import { AdvancedTable } from "./table-workspace";
type Action = (work: () => Promise<any>, success?: string) => Promise<boolean>;
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const C: Record<string, any> = {
    overview: LayoutDashboard,
    leads: Users,
    tables: Table2,
    campaigns: Send,
    inbox: Inbox,
    pipeline: Target,
    analytics: Activity,
    settings: Settings,
    email: Mail,
    linkedin: Globe,
    whatsapp: MessageCircle,
  };
  const Component = C[name] || Sparkles;
  return <Component size={size} strokeWidth={1.7} />;
}
function Empty({
  icon = "leads",
  title,
  body,
  action,
  onClick,
}: {
  icon?: string;
  title: string;
  body: string;
  action?: string;
  onClick?: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action && (
        <button className="button primary" onClick={onClick}>
          <Plus size={16} />
          {action}
        </button>
      )}
    </div>
  );
}
function Loading({ error }: { error?: string }) {
  return error ? (
    <div className="error-panel">
      {error}
      <button className="button" onClick={() => location.reload()}>
        重新加载
      </button>
    </div>
  ) : (
    <div className="loading">
      <Loader2 className="spin" size={23} /> 正在加载工作台…
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", fn);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", fn);
      document.body.style.overflow = old;
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Header({
  eyebrow,
  title,
  body,
  children,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {body && <p>{body}</p>}
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
function Auth({ status, onDone }: { status: Row; onDone: () => void }) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const [setupToken] = useState(hash.get("setup") || ""),
    [invite] = useState(hash.get("invite") || "");
  const setup = !status.initialized && !invite;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { data: options } = useData("/auth/options");
  useEffect(() => {
    if (setupToken || invite) history.replaceState({}, "", location.pathname);
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const b = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(
        setup ? "/auth/setup" : invite ? "/auth/invitation" : "/auth/login",
        "POST",
        { ...b, token: invite || setupToken },
      );
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <a className="brand" href="/">
          <span className="brand-mark">A</span>
          <strong>
            AgentSDR<span className="brand-dot">.</span>
          </strong>
        </a>
        <div>
          <span className="eyebrow">YOUR NEXT CONVERSATION STARTS HERE</span>
          <h1>
            把好线索，
            <br />
            变成好生意。
          </h1>
          <p>
            从第一封问候，到下一次会面。
            <br />
            一个工作台，连接每一段有价值的对话。
          </p>
          <div className="orbit">
            <span>
              <Mail />
            </span>
            <span>
              <Globe />
            </span>
            <span>
              <MessageCircle />
            </span>
            <div className="orbit-center">
              <Sparkles size={38} />
            </div>
          </div>
        </div>
        <footer>
          Gene's workspace <span>Built on AgentSDR · MIT</span>
        </footer>
      </aside>
      <main className="auth-form">
        <div className="auth-form-inner">
          <span className="small-label">PRIVATE WORKSPACE</span>
          <h2>
            {setup ? "建立你的工作台" : invite ? "加入工作台" : "欢迎回来"}
          </h2>
          <p>
            {setup
              ? "创建管理员账户，开始你的第一段客户旅程。"
              : invite
                ? "设置账户信息，接受团队邀请。"
                : "登录后，继续推进你的客户对话。"}
          </p>
          {setup && !setupToken ? (
            <div className="notice">
              <ShieldCheck size={20} />
              <div>
                <strong>这个工作台尚未初始化</strong>
                <p>请通过部署时提供的专属设置链接创建管理员账户。</p>
              </div>
            </div>
          ) : (
            <form onSubmit={submit}>
              {(setup || invite) && (
                <Field label="你的名字">
                  <input
                    name="name"
                    required
                    autoComplete="name"
                    autoFocus
                    placeholder="Gene Dai"
                  />
                </Field>
              )}
              {setup && (
                <Field label="工作台名称">
                  <input
                    name="organization"
                    required
                    defaultValue="Gene's workspace"
                  />
                </Field>
              )}
              {!invite && (
                <Field label="邮箱">
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@company.com"
                  />
                </Field>
              )}
              <Field
                label="密码"
                hint={setup || invite ? "至少 12 位字符" : ""}
              >
                <input
                  name="password"
                  type="password"
                  required
                  minLength={setup || invite ? 12 : 1}
                  maxLength={128}
                  autoComplete={
                    setup || invite ? "new-password" : "current-password"
                  }
                />
              </Field>
              {error && (
                <div role="alert" className="form-error">
                  {error}
                </div>
              )}
              <button className="button primary full" disabled={busy}>
                {busy ? <Loader2 className="spin" size={18} /> : null}
                {setup ? "创建工作台" : invite ? "接受邀请" : "登录工作台"}
                <ArrowRight size={17} />
              </button>
            </form>
          )}
          {!setup && !invite && (
            <div className="toolbar">
              <a className="text-button" href="/forgot-password">
                忘记密码
              </a>
              {options?.google && (
                <a className="button" href="/api/auth/google">
                  使用 Google 登录
                </a>
              )}
            </div>
          )}
          <div className="auth-note">
            <ShieldCheck size={14} /> 仅受邀成员可访问 · 数据属于你的工作台
          </div>
        </div>
      </main>
    </div>
  );
}
function Overview({
  refresh,
  go,
}: {
  refresh: number;
  go: (p: string) => void;
}) {
  const { data, error } = useData("/overview", refresh);
  if (!data) return <Loading error={error} />;
  const stats = [
    {
      label: "全部线索",
      value: data.people.total || 0,
      icon: Users,
      detail: "你的潜在客户关系",
    },
    {
      label: "已发送",
      value: data.messages.sent || 0,
      icon: Send,
      detail: "实际发送的消息",
    },
    {
      label: "收到回复",
      value: data.messages.replies || 0,
      icon: MessageCircle,
      detail: "跨渠道的客户对话",
    },
    {
      label: "约谈中",
      value: data.people.meetings || 0,
      icon: Target,
      detail: "正在推进的机会",
    },
  ];
  return (
    <>
      <Header
        eyebrow="YOUR OUTREACH, IN FOCUS"
        title="每一次对话，都向前一步。"
        body="这里是你的销售工作台。今天，准备和谁聊聊？"
      >
        <span className="date-chip">
          {new Intl.DateTimeFormat("zh-CN", {
            month: "long",
            day: "numeric",
            weekday: "long",
          }).format(new Date())}
        </span>
      </Header>
      <div className="stats-grid">
        {stats.map((s) => (
          <div className="stat" key={s.label}>
            <div className="stat-label">
              {s.label}
              <s.icon size={17} />
            </div>
            <strong>{s.value.toLocaleString()}</strong>
            <p>{s.detail}</p>
          </div>
        ))}
      </div>
      {data.people.total === 0 ? (
        <div className="start-banner">
          <div>
            <div className="eyebrow">MAKE YOUR FIRST MOVE</div>
            <h2>好生意，从一个好名单开始。</h2>
            <p>
              导入你想认识的人，连接常用渠道，
              <br />让 AI 帮你准备一段值得回复的开场白。
            </p>
            <button className="button primary" onClick={() => go("leads")}>
              添加第一位线索 <ArrowUpRight size={17} />
            </button>
          </div>
          <div className="path-art" aria-hidden="true">
            <div>
              <Users size={25} />
              <span>找到合适的人</span>
            </div>
            <i />
            <div>
              <Sparkles size={25} />
              <span>准备有用的话</span>
            </div>
            <i />
            <div>
              <MessageCircle size={25} />
              <span>开启下一段对话</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="focus-banner">
          <div className="focus-icon">
            <Sparkles size={28} />
          </div>
          <div>
            <span className="eyebrow">YOUR NEXT BEST ACTION</span>
            <h2>
              {data.drafts
                ? `${data.drafts} 份 AI 草稿，等你过目。`
                : "保持对话，让关系继续。"}
            </h2>
            <p>
              {data.drafts
                ? "花一分钟检查措辞，让每封回复都像你亲手写的。"
                : `目前有 ${data.campaigns.active || 0} 个进行中的活动。查看最近对话，跟进新的机会。`}
            </p>
          </div>
          <button className="button" onClick={() => go("inbox")}>
            查看收件箱 <ArrowRight size={16} />
          </button>
        </div>
      )}
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <h3>你的销售漏斗</h3>
            <button className="text-button" onClick={() => go("pipeline")}>
              查看 Pipeline <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="funnel">
            {Object.entries(stageNames)
              .slice(0, 5)
              .map(([stage, label], i) => {
                const count =
                  data.pipeline.find((p: Row) => p.stage === stage)?.count || 0;
                return (
                  <div className="funnel-row" key={stage}>
                    <span>
                      <i
                        style={{
                          background: [
                            "#b5c4bb",
                            "#95b7a1",
                            "#6c9c7b",
                            "#47795b",
                            "#204d38",
                          ][i],
                        }}
                      />
                      {label}
                    </span>
                    <div className="funnel-track">
                      <div
                        style={{
                          width: `${data.people.total ? Math.max(2, (count / data.people.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <b>{count}</b>
                  </div>
                );
              })}
          </div>
          <div className="panel-foot">
            从新线索，到长期客户。每一步都有迹可循。
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>最近动态</h3>
            <span className="subtle">实时记录</span>
          </div>
          {data.activity.length ? (
            <div className="activity-list">
              {data.activity.map((a: Row) => (
                <div className="activity-item" key={a.id}>
                  <span className="activity-dot" />
                  <div>
                    <p>{a.detail}</p>
                    <small>{date(a.created_at)}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="quiet">
              <Activity size={24} />
              <p>你的第一条动态，即将开始。</p>
              <small>添加线索、创建活动后的操作会出现在这里。</small>
            </div>
          )}
        </section>
      </div>
      <div className="next-steps">
        {[
          {
            n: "01",
            title: "整理你的线索",
            body: "导入名单，补齐客户画像",
            path: "leads",
            icon: Users,
          },
          {
            n: "02",
            title: "连接触达渠道",
            body: "邮件、LinkedIn 与 WhatsApp",
            path: "settings",
            icon: Globe,
          },
          {
            n: "03",
            title: "开启第一次触达",
            body: "写好序列，按你的节奏发送",
            path: "campaigns",
            icon: Send,
          },
        ].map((x) => (
          <button key={x.n} onClick={() => go(x.path)}>
            <span className="step-number">{x.n}</span>
            <div>
              <h4>{x.title}</h4>
              <p>{x.body}</p>
            </div>
            <ArrowUpRight size={19} />
          </button>
        ))}
      </div>
    </>
  );
}
function LeadEditor({
  person,
  onSave,
}: {
  person?: Row;
  onSave: (b: Row) => Promise<void>;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const b = Object.fromEntries(new FormData(e.currentTarget));
        void onSave({
          ...b,
          dnc: b.dnc === "on",
          tags: String(b.tags || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        });
      }}
    >
      <div className="form-grid">
        {[
          ["name", "姓名", "text"],
          ["email", "邮箱", "email"],
          ["company", "公司", "text"],
          ["title", "职位", "text"],
          ["phone", "电话（含国家代码）", "tel"],
          ["linkedin", "LinkedIn 个人主页", "text"],
          ["website", "公司网站", "text"],
        ].map(([key, label, type]) => (
          <Field key={key} label={label}>
            <input
              name={key}
              type={type}
              defaultValue={person?.[key] || ""}
              required={key === "name"}
            />
          </Field>
        ))}
        <Field label="销售阶段">
          <select name="stage" defaultValue={person?.stage || "new"}>
            {Object.entries(stageNames).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="标签（逗号分隔）">
        <input
          name="tags"
          defaultValue={
            person ? JSON.parse(person.tags || "[]").join(", ") : ""
          }
          placeholder="Founder, SaaS, US"
        />
      </Field>
      <Field label="备注">
        <textarea name="notes" defaultValue={person?.notes || ""} rows={4} />
      </Field>
      <label className="checkbox">
        <input name="dnc" type="checkbox" defaultChecked={!!person?.dnc} /> Do
        Not Contact · 停止对该线索的后续触达
      </label>
      <div className="form-actions">
        <button className="button primary" type="submit">
          <Check size={16} />
          保存线索
        </button>
      </div>
    </form>
  );
}
function LeadDetail({
  pid,
  onClose,
  act,
  refresh,
  reload,
}: {
  pid: string;
  onClose: () => void;
  act: Action;
  refresh: number;
  reload: () => void;
}) {
  const { data: p, error } = useData(`/people/${pid}`, refresh);
  const [tab, setTab] = useState("profile"),
    [reply, setReply] = useState(false),
    [prompt, setPrompt] = useState("");
  if (!p)
    return (
      <Modal title="线索详情" onClose={onClose}>
        <Loading error={error} />
      </Modal>
    );
  return (
    <Modal title={p.name} onClose={onClose} wide>
      <div className="lead-summary">
        <div className="avatar large">{p.name.slice(0, 1)}</div>
        <div>
          <h2>{p.name}</h2>
          <p>
            {[p.title, p.company].filter(Boolean).join(" · ") ||
              "补充客户画像，让对话更有针对性"}
          </p>
          <div className="inline">
            <Badge value={p.stage} />
            {p.dnc && (
              <span className="badge badge-failed">Do Not Contact</span>
            )}
          </div>
        </div>
      </div>
      <div className="tabs">
        {[
          ["profile", "个人资料"],
          ["conversation", `对话 ${p.messages.length}`],
          ["drafts", `草稿 ${p.drafts.length}`],
          ["files", `附件 ${p.files.length}`],
        ].map(([key, label]) => (
          <button
            className={tab === key ? "active" : ""}
            key={key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "profile" && (
        <LeadEditor
          person={p}
          onSave={async (b) => {
            if (
              await act(() => api(`/people/${pid}`, "PATCH", b), "线索已更新")
            )
              reload();
          }}
        />
      )}
      {tab === "conversation" && (
        <>
          <div className="toolbar">
            <button className="button" onClick={() => setReply(!reply)}>
              <Plus size={16} />
              记录客户回复
            </button>
          </div>
          {reply && (
            <form
              className="compose-box"
              onSubmit={(e) => {
                e.preventDefault();
                const b = Object.fromEntries(new FormData(e.currentTarget));
                void act(
                  () => api("/messages", "POST", { ...b, person_id: pid }),
                  "回复已记录，正在生成 AI 草稿",
                ).then((ok) => {
                  if (ok) {
                    setReply(false);
                    reload();
                  }
                });
              }}
            >
              <Field label="渠道">
                <select name="channel">
                  {Object.entries(channelNames).map(([k, v]) => (
                    <option value={k} key={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="客户回复">
                <textarea name="body" rows={4} required />
              </Field>
              <button className="button primary">保存回复</button>
            </form>
          )}
          {p.messages.length ? (
            <div className="conversation">
              {p.messages.map((m: Row) => (
                <div className={`message ${m.direction}`} key={m.id}>
                  <div>
                    <span>
                      {m.direction === "inbound" ? p.name : "你"} ·{" "}
                      {channelNames[m.channel]}
                    </span>
                    <small>{date(m.created_at)}</small>
                  </div>
                  {m.subject && <strong>{m.subject}</strong>}
                  <p>{m.body}</p>
                  <div className="inline">
                    <button
                      className="text-button"
                      onClick={() =>
                        void act(
                          () =>
                            api(`/messages/${m.id}`, "PATCH", {
                              read: !m.read_at,
                            }),
                          "已更新",
                        ).then(reload)
                      }
                    >
                      {m.read_at ? "标为未读" : "标为已读"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        void act(
                          () =>
                            api(`/messages/${m.id}`, "PATCH", {
                              important: !m.important,
                            }),
                          "已更新",
                        ).then(reload)
                      }
                    >
                      {m.important ? "取消重要标记" : "标为重要"}
                    </button>
                    <Badge value={m.status} />
                    {m.classification && <Badge value={m.classification} />}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              icon="inbox"
              title="还没有对话"
              body="已发送消息和客户回复会按时间保存在这里。"
            />
          )}
        </>
      )}
      {tab === "drafts" && (
        <>
          <div className="compose-box">
            <div className="inline">
              <Sparkles size={18} />
              <strong>准备下一次有价值的对话</strong>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：用英文写一封 80 字以内的初次联系邮件，先了解对方目前的需求。"
              rows={3}
            />
            <button
              className="button primary"
              disabled={!!p.dnc}
              onClick={() =>
                void act(
                  () => api("/ai/draft", "POST", { person_id: pid, prompt }),
                  "AI 草稿任务已提交，请稍后刷新查看",
                )
              }
            >
              <Sparkles size={16} />
              生成草稿
            </button>
          </div>
          {p.drafts.map((d: Row) => (
            <Draft key={d.id} draft={d} act={act} reload={reload} />
          ))}
          <p className="hint">
            AI 仅使用你填写的产品信息与知识库。发送前请核实内容。
          </p>
        </>
      )}
      {tab === "files" && (
        <>
          <label className="upload-zone">
            <Upload size={24} />
            <strong>添加资料或通话录音</strong>
            <span>单文件最多 20 MB · 录音可生成文字记录</span>
            <input
              type="file"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const b = new FormData();
                b.set("file", file);
                b.set("person_id", pid);
                await act(() => api("/files", "POST", b), "附件已保存");
                reload();
              }}
            />
          </label>
          {p.files.map((f: Row) => (
            <div className="file-row" key={f.id}>
              <FileText size={20} />
              <div>
                <a href={`/api/files/${f.id}`}>{f.name}</a>
                <small>
                  {(f.size / 1024).toFixed(0)} KB · {date(f.created_at)}
                </small>
                {f.transcript && <p className="transcript">{f.transcript}</p>}
              </div>
              {f.content_type.startsWith("audio/") && (
                <button
                  className="button small"
                  onClick={() =>
                    void act(
                      () => api(`/files/${f.id}/transcribe`, "POST", {}),
                      "转录任务已提交",
                    )
                  }
                >
                  <AudioLines size={14} />
                  转录
                </button>
              )}
              <button
                className="icon-button"
                aria-label="删除附件"
                onClick={() =>
                  void act(
                    () => api(`/files/${f.id}`, "DELETE"),
                    "附件已删除",
                  ).then(reload)
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </>
      )}
      <LeadExtras pid={pid} refresh={refresh} reload={reload} act={act} />
    </Modal>
  );
}
function Leads({
  refresh,
  reload,
  act,
  select,
}: {
  refresh: number;
  reload: () => void;
  act: Action;
  select: (id: string) => void;
}) {
  const [q, setQ] = useState(""),
    [stage, setStage] = useState(""),
    [page, setPage] = useState(1),
    [creating, setCreating] = useState(false),
    [importing, setImporting] = useState(false),
    [mergeImport, setMergeImport] = useState(false),
    [rows, setRows] = useState<Row[]>([]),
    [fileError, setFileError] = useState(""),
    [tab, setTab] = useState("people");
  const { data, error } = useData(
      `/people?q=${encodeURIComponent(q)}&stage=${stage}&page=${page}`,
      refresh,
    ),
    { data: companies } = useData("/companies", refresh);
  return (
    <>
      <Header
        eyebrow="THE PEOPLE BEHIND YOUR PIPELINE"
        title="每一位，都值得认真了解。"
        body="把人、公司和每一次互动，放在一起。"
      >
        <button className="button" onClick={() => setImporting(true)}>
          <Upload size={16} />
          导入名单
        </button>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          添加线索
        </button>
      </Header>
      <section className="panel">
        <div className="tabs pad">
          {[
            ["people", "联系人"],
            ["companies", "公司"],
          ].map(([k, v]) => (
            <button
              key={k}
              className={tab === k ? "active" : ""}
              onClick={() => setTab(k)}
            >
              {v}{" "}
              <span>
                {k === "people"
                  ? data?.total || 0
                  : companies?.items.length || 0}
              </span>
            </button>
          ))}
        </div>
        <div className="table-toolbar">
          <div className="search-field">
            <Search size={17} />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="搜索姓名、邮箱、公司…"
              aria-label="搜索线索"
            />
          </div>
          <div className="inline">
            <select
              value={stage}
              onChange={(e) => {
                setStage(e.target.value);
                setPage(1);
              }}
              aria-label="按销售阶段筛选"
            >
              <option value="">全部阶段</option>
              {Object.entries(stageNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="导出全部线索"
              title="导出全部线索"
              onClick={() =>
                void act(
                  async () =>
                    csvDownload(
                      (await api("/people/export")).items,
                      "agentsdr-leads.csv",
                    ),
                  "导出已下载",
                )
              }
            >
              <ArrowDownToLine size={18} />
            </button>
          </div>
        </div>
        {!data ? (
          <Loading error={error} />
        ) : tab === "companies" ? (
          companies?.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>公司</th>
                    <th>网站</th>
                    <th>联系人</th>
                  </tr>
                </thead>
                <tbody>
                  {companies.items
                    .filter((x: Row) =>
                      x.name.toLowerCase().includes(q.toLowerCase()),
                    )
                    .map((co: Row) => (
                      <tr key={co.name}>
                        <td>
                          <div className="inline">
                            <Building2 size={17} />
                            <strong>{co.name}</strong>
                          </div>
                        </td>
                        <td>{co.domain || "—"}</td>
                        <td>{co.people}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="公司关系，随线索一起积累"
              body="添加联系人的公司信息后，会自动整理到这里。"
            />
          )
        ) : data.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>联系人</th>
                    <th>公司 / 职位</th>
                    <th>联系方式</th>
                    <th>阶段</th>
                    <th>添加时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p: Row) => (
                    <tr
                      key={p.id}
                      onClick={() => select(p.id)}
                      className="clickable"
                    >
                      <td>
                        <div className="person-cell">
                          <span className="avatar">{p.name.slice(0, 1)}</span>
                          <div>
                            <strong>{p.name}</strong>
                            <small>{p.email || "尚无邮箱"}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <strong>{p.company || "—"}</strong>
                        <small>{p.title}</small>
                      </td>
                      <td>
                        <div className="reach-icons">
                          {p.email && <Mail size={16} />}{" "}
                          {p.linkedin && <Globe size={16} />}{" "}
                          {p.phone && <MessageCircle size={16} />}
                        </div>
                      </td>
                      <td>
                        {p.dnc ? (
                          <Badge value="failed" label="Do Not Contact" />
                        ) : (
                          <Badge value={p.stage} />
                        )}
                      </td>
                      <td className="muted">{date(p.created_at)}</td>
                      <td>
                        <ChevronRight size={16} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>共 {data.total} 位联系人</span>
              <div>
                <button
                  className="button small"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <span>{page}</span>
                <button
                  className="button small"
                  disabled={page * 100 >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        ) : (
          <Empty
            title={
              q ? "没有找到匹配的线索" : "你的下一位客户，可能就在这份名单里。"
            }
            body={
              q
                ? "试试其他姓名或公司名称。"
                : "添加一位联系人，或导入已有的 CSV / Excel 名单。"
            }
            action={q ? undefined : "添加第一位线索"}
            onClick={() => setCreating(true)}
          />
        )}
      </section>
      {creating && (
        <Modal title="添加线索" onClose={() => setCreating(false)}>
          <LeadEditor
            onSave={async (b) => {
              if (await act(() => api("/people", "POST", b), "线索已添加")) {
                setCreating(false);
                reload();
              }
            }}
          />
        </Modal>
      )}
      {importing && (
        <Modal
          title="导入联系人"
          onClose={() => {
            setImporting(false);
            setRows([]);
            setFileError("");
          }}
          wide
        >
          <p className="muted">
            支持 CSV、XLSX / XLS。识别
            name、email、company、title、phone、linkedin、website，或对应中文列名。重复邮箱自动跳过。
          </p>
          <label className="upload-zone">
            <Upload size={28} />
            <strong>点击选择 CSV 或 Excel 文件</strong>
            <span>最多 1,000 行 · 文件小于 10 MB</span>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              hidden
              onChange={async (e) => {
                try {
                  setFileError("");
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const r = normalizeRows(await readRows(f));
                  if (r.length > 1000)
                    throw new Error("一次最多导入 1,000 行，请拆分文件");
                  setRows(r);
                } catch (e) {
                  setFileError((e as Error).message);
                }
              }}
            />
          </label>
          {fileError && <div className="form-error">{fileError}</div>}
          {rows.length > 0 && (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>邮箱</th>
                      <th>公司</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 6).map((r, i) => (
                      <tr key={i}>
                        <td>{r.name}</td>
                        <td>{r.email || "—"}</td>
                        <td>{r.company || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={mergeImport}
                  onChange={(e) => setMergeImport(e.target.checked)}
                />
                更新已存在的邮箱或 LinkedIn 联系人，保留勿扰标记
              </label>
              <div className="form-actions">
                <span className="muted">
                  共 {rows.length} 行，以上为前 6 行预览
                </span>
                <button
                  className="button primary"
                  onClick={() =>
                    void act(async () => {
                      const r = await api("/people/import", "POST", {
                        rows,
                        mode: mergeImport ? "merge" : "skip",
                      });
                      setImporting(false);
                      setRows([]);
                      reload();
                      return r;
                    }, "导入完成，重复邮箱已跳过")
                  }
                >
                  导入 {rows.length} 位联系人
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
function CampaignEditor({ act, onDone }: { act: Action; onDone: () => void }) {
  const [channel, setChannel] = useState("email"),
    [steps, setSteps] = useState<Row[]>([
      { body: "", subject: "", delay_minutes: 0, action: "message" },
    ]);
  const update = (i: number, key: string, val: any) =>
    setSteps(steps.map((s, j) => (i === j ? { ...s, [key]: val } : s)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const b = Object.fromEntries(new FormData(e.currentTarget));
        void act(async () => {
          const created = await api("/campaigns", "POST", {
            ...b,
            channel,
            steps,
          });
          if (b.provider === "gmail")
            await api(`/campaigns/${created.id}`, "PATCH", {
              provider: "gmail",
            });
          return created;
        }, "活动草稿已创建").then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <div className="form-grid">
        <Field label="活动名称">
          <input
            name="name"
            required
            placeholder="例如：SaaS 创始人 · 第一轮交流"
          />
        </Field>
        <Field label="触达渠道">
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              setSteps(steps.map((s) => ({ ...s, action: "message" })));
            }}
          >
            {Object.entries(channelNames).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {channel === "email" && (
          <Field label="邮件服务">
            <select name="provider">
              <option value="resend">Resend</option>
              <option value="gmail">Google Workspace Gmail</option>
            </select>
          </Field>
        )}
        {channel === "email" ? (
          <Field label="发件地址（留空使用设置中的地址）">
            <input
              name="from_address"
              placeholder="Gene <hello@yourdomain.com>"
            />
          </Field>
        ) : (
          <Field label="Unipile 账户 ID（可留空使用默认）">
            <input name="account_id" />
          </Field>
        )}
        <Field label="活动每天最多发送">
          <input
            name="daily_limit"
            type="number"
            min="1"
            max="500"
            defaultValue="30"
          />
        </Field>
      </div>
      <div className="section-title">
        <h3>消息序列</h3>
        <small>
          支持 {"{{first_name}}"}、{"{{company}}"}、{"{{title}}"} 等变量
        </small>
      </div>
      {steps.map((s, i) => (
        <div className="sequence-step" key={i}>
          <div className="step-heading">
            <span className="number-circle">{i + 1}</span>
            <strong>{i === 0 ? "首次触达" : "后续跟进"}</strong>
            <span className="spacer" />
            {i > 0 && (
              <button
                type="button"
                className="icon-button"
                aria-label="删除序列步骤"
                onClick={() => setSteps(steps.filter((_, j) => i !== j))}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          <div className="form-grid">
            <Field
              label={
                i === 0
                  ? "首次发送前等待（分钟）"
                  : "上一条消息发送后等待（分钟）"
              }
            >
              <input
                type="number"
                min="0"
                max="525600"
                value={s.delay_minutes}
                onChange={(e) =>
                  update(i, "delay_minutes", Number(e.target.value))
                }
              />
            </Field>
            {channel === "linkedin" && (
              <Field label="操作">
                <select
                  value={s.action}
                  onChange={(e) => update(i, "action", e.target.value)}
                >
                  <option value="message">发送消息</option>
                  <option value="invite">发送连接邀请</option>
                </select>
              </Field>
            )}
          </div>
          {channel === "email" && (
            <Field label="邮件主题">
              <input
                value={s.subject}
                onChange={(e) => update(i, "subject", e.target.value)}
                placeholder="A quick question, {{first_name}}"
                required
              />
            </Field>
          )}
          <Field label="消息内容">
            <textarea
              rows={5}
              value={s.body}
              onChange={(e) => update(i, "body", e.target.value)}
              placeholder="Hi {{first_name}}, …"
              required
            />
          </Field>
        </div>
      ))}
      <button
        className="button full dashed"
        type="button"
        disabled={steps.length >= 12}
        onClick={() =>
          setSteps([
            ...steps,
            { body: "", subject: "", delay_minutes: 2880, action: "message" },
          ])
        }
      >
        <Plus size={16} />
        添加跟进步骤
      </button>
      <div className="notice compact">
        <Clock size={18} />
        <span>
          发送遵循工作台的时区、发送时间和每日总量。客户回复或退订后，该联系人的后续序列会停止。
        </span>
      </div>
      <div className="form-actions">
        <button className="button primary">
          保存活动草稿 <ArrowRight size={16} />
        </button>
      </div>
    </form>
  );
}
function CampaignDetail({
  cid,
  onClose,
  act,
  refresh,
  reload,
}: {
  cid: string;
  onClose: () => void;
  act: Action;
  refresh: number;
  reload: () => void;
}) {
  const { data: c, error } = useData(`/campaigns/${cid}`, refresh),
    { data: leads } = useData("/people", refresh);
  const [enrolling, setEnrolling] = useState(false),
    [selected, setSelected] = useState<string[]>([]);
  if (!c)
    return (
      <Modal title="活动详情" onClose={onClose}>
        <Loading error={error} />
      </Modal>
    );
  return (
    <Modal title={c.name} onClose={onClose} wide>
      <div className="toolbar">
        <div className="inline">
          <Icon name={c.channel} />
          {channelNames[c.channel]}
          <Badge value={c.status} />
          <span className="muted">每日最多 {c.daily_limit} 条</span>
        </div>
        <button className="button" onClick={() => setEnrolling(!enrolling)}>
          <Plus size={16} />
          添加联系人
        </button>
        <button
          className={`button ${c.status === "active" ? "" : "primary"}`}
          onClick={() =>
            void act(
              () =>
                api(`/campaigns/${cid}`, "PATCH", {
                  status: c.status === "active" ? "paused" : "active",
                }),
              c.status === "active"
                ? "活动已暂停"
                : "活动已启动，按发送时间执行",
            ).then(reload)
          }
        >
          {c.status === "active" ? <Pause size={16} /> : <Play size={16} />}{" "}
          {c.status === "active" ? "暂停活动" : "启动活动"}
        </button>
      </div>
      {enrolling && (
        <div className="enroll-box">
          <p>选择加入序列的线索（已退订的联系人会自动跳过）</p>
          <div className="enroll-list">
            {leads?.items
              .filter(
                (p: Row) =>
                  !p.dnc &&
                  !c.enrollments.some((e: Row) => e.person_id === p.id),
              )
              .map((p: Row) => (
                <label className="checkbox" key={p.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, p.id]
                          : selected.filter((x) => x !== p.id),
                      )
                    }
                  />
                  <strong>{p.name}</strong>
                  <span className="muted">{p.company || p.email}</span>
                </label>
              ))}
          </div>
          <button
            className="button primary"
            disabled={!selected.length}
            onClick={() =>
              void act(
                () =>
                  api(`/campaigns/${cid}/enroll`, "POST", { people: selected }),
                "联系人已加入序列",
              ).then((ok) => {
                if (ok) {
                  setEnrolling(false);
                  setSelected([]);
                  reload();
                }
              })
            }
          >
            加入 {selected.length} 位联系人
          </button>
          <small>
            此处显示最近 100 位线索；更多联系人可通过 API 分批加入。
          </small>
        </div>
      )}
      <h3 className="section-title">消息序列</h3>
      {c.steps.map((s: Row, i: number) => (
        <div className="sequence-step" key={s.id}>
          <div className="step-heading">
            <span className="number-circle">{i + 1}</span>
            <strong>
              {s.action === "invite" ? "连接邀请" : s.subject || "发送消息"}
            </strong>
            <span className="muted">等待 {s.delay_minutes} 分钟</span>
          </div>
          <p className="preserve">{s.body}</p>
        </div>
      ))}
      <h3 className="section-title">序列中的联系人 · {c.enrollments.length}</h3>
      {c.enrollments.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>联系人</th>
                <th>状态</th>
                <th>当前步骤</th>
                <th>计划时间</th>
              </tr>
            </thead>
            <tbody>
              {c.enrollments.map((e: Row) => (
                <tr key={e.id}>
                  <td>
                    <strong>{e.name}</strong>
                    <small>{e.email}</small>
                  </td>
                  <td>
                    <Badge value={e.status} />
                  </td>
                  <td>{e.step + 1}</td>
                  <td>{date(e.next_run)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="先把合适的人加入序列"
          body="添加联系人后，启动活动即可按时间执行。"
        />
      )}
      <div className="form-actions">
        <button
          className="button danger"
          disabled={c.status === "active"}
          onClick={() =>
            void act(
              () => api(`/campaigns/${cid}`, "DELETE"),
              "活动已删除",
            ).then((ok) => {
              if (ok) {
                onClose();
                reload();
              }
            })
          }
        >
          <Trash2 size={16} />
          删除活动
        </button>
      </div>
      <CampaignExtras cid={cid} refresh={refresh} reload={reload} act={act} />
    </Modal>
  );
}
function Campaigns({
  refresh,
  reload,
  act,
}: {
  refresh: number;
  reload: () => void;
  act: Action;
}) {
  const { data, error } = useData("/campaigns", refresh),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState(""),
    [channel, setChannel] = useState("all");
  return (
    <>
      <Header
        eyebrow="A LITTLE CONSISTENCY GOES A LONG WAY"
        title="让每一次触达，都有下一步。"
        body="为合适的人，安排合适的消息与节奏。"
      >
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          新建活动
        </button>
      </Header>
      <div className="tabs standalone">
        {[["all", "全部渠道"], ...Object.entries(channelNames)].map(
          ([k, v]) => (
            <button
              className={channel === k ? "active" : ""}
              onClick={() => setChannel(k)}
              key={k}
            >
              {k !== "all" && <Icon name={k} size={15} />} {v}
            </button>
          ),
        )}
      </div>
      {!data ? (
        <Loading error={error} />
      ) : !data.items.length ? (
        <section className="panel">
          <Empty
            icon="campaigns"
            title="第一段对话，由你开启。"
            body="创建邮件、LinkedIn 或 WhatsApp 活动，加入联系人，设定跟进节奏。"
            action="创建第一个活动"
            onClick={() => setCreating(true)}
          />
        </section>
      ) : (
        <div className="campaign-grid">
          {data.items
            .filter((c: Row) => channel === "all" || c.channel === channel)
            .map((c: Row) => (
              <button
                className="campaign-card"
                key={c.id}
                onClick={() => setSelected(c.id)}
              >
                <div className="card-top">
                  <span className={`channel-icon ${c.channel}`}>
                    <Icon name={c.channel} size={21} />
                  </span>
                  <Badge value={c.status} />
                  <ArrowUpRight size={17} />
                </div>
                <h3>{c.name}</h3>
                <p>
                  {channelNames[c.channel]} · 每日最多 {c.daily_limit} 条
                </p>
                <div className="campaign-stats">
                  <span>
                    <strong>{c.leads}</strong>联系人
                  </span>
                  <span>
                    <strong>{c.sent}</strong>已发送
                  </span>
                </div>
              </button>
            ))}
        </div>
      )}
      {creating && (
        <Modal title="创建触达活动" onClose={() => setCreating(false)} wide>
          <CampaignEditor
            act={act}
            onDone={() => {
              setCreating(false);
              reload();
            }}
          />
        </Modal>
      )}
      {selected && (
        <CampaignDetail
          cid={selected}
          onClose={() => setSelected("")}
          act={act}
          refresh={refresh}
          reload={reload}
        />
      )}
    </>
  );
}
function Draft({
  draft: d,
  act,
  reload,
}: {
  draft: Row;
  act: Action;
  reload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="draft-card">
      <div className="draft-heading">
        <Sparkles size={17} />
        <strong>AI 回复草稿 {d.name && `· ${d.name}`}</strong>
        <Badge value={d.status} />
        <span className="spacer" />
        <small>{channelNames[d.channel]}</small>
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () =>
                api(
                  `/drafts/${d.id}`,
                  "PATCH",
                  Object.fromEntries(new FormData(e.currentTarget)),
                ),
              "草稿已保存",
            ).then((ok) => {
              if (ok) {
                setEditing(false);
                reload();
              }
            });
          }}
        >
          <input
            name="subject"
            defaultValue={d.subject}
            aria-label="草稿主题"
          />
          <textarea
            name="body"
            defaultValue={d.body}
            rows={7}
            required
            aria-label="草稿内容"
          />
          <button className="button primary small">保存修改</button>
        </form>
      ) : (
        <>
          {d.subject && <strong>{d.subject}</strong>}
          <p className="preserve">{d.body}</p>
        </>
      )}
      <div className="draft-actions">
        <button
          className="text-button"
          disabled={d.status !== "pending"}
          onClick={() => setEditing(!editing)}
        >
          编辑草稿
        </button>
        <button
          className="text-button danger"
          disabled={d.status !== "pending"}
          onClick={() =>
            void act(() => api(`/drafts/${d.id}`, "DELETE"), "草稿已删除").then(
              reload,
            )
          }
        >
          删除
        </button>
        <span className="spacer" />
        <button
          className="button primary small"
          disabled={d.status !== "pending" || editing}
          onClick={() =>
            void act(
              () => api(`/drafts/${d.id}/send`, "POST", {}),
              "发送已排队，遵循工作台发送时间",
            ).then(reload)
          }
        >
          <Send size={14} />
          审核并发送
        </button>
      </div>
    </div>
  );
}
function InboxPage({
  refresh,
  reload,
  act,
  select,
}: {
  refresh: number;
  reload: () => void;
  act: Action;
  select: (id: string) => void;
}) {
  const { data, error } = useData("/inbox", refresh),
    [tab, setTab] = useState("messages");
  return (
    <>
      <Header
        eyebrow="LESS SWITCHING. MORE CONVERSATION."
        title="所有对话，在这里汇合。"
        body="统一查看客户回复，审核 AI 为你准备的下一句。"
      >
        <button className="button" onClick={reload}>
          刷新对话
        </button>
      </Header>
      <section className="panel">
        <div className="tabs pad">
          <button
            className={tab === "messages" ? "active" : ""}
            onClick={() => setTab("messages")}
          >
            全部对话 <span>{data?.messages.length || 0}</span>
          </button>
          <button
            className={tab === "drafts" ? "active" : ""}
            onClick={() => setTab("drafts")}
          >
            <Sparkles size={15} />
            待处理草稿 <span>{data?.drafts.length || 0}</span>
          </button>
        </div>
        {!data ? (
          <Loading error={error} />
        ) : tab === "drafts" ? (
          data.drafts.length ? (
            <div className="draft-list">
              {data.drafts.map((d: Row) => (
                <Draft key={d.id} draft={d} act={act} reload={reload} />
              ))}
            </div>
          ) : (
            <Empty
              icon="inbox"
              title="现在，没有等待你的草稿。"
              body="收到客户回复后，AI 会分类并准备回复。你也可以在线索详情中主动生成草稿。"
            />
          )
        ) : data.messages.length ? (
          <div className="inbox-list">
            {data.messages.map((m: Row) => (
              <button
                className="inbox-row"
                key={m.id}
                onClick={() => select(m.person_id)}
              >
                <span className="avatar">{m.name.slice(0, 1)}</span>
                <div className="inbox-content">
                  <div>
                    <strong>{m.name}</strong>
                    <span>{m.company}</span>
                    <span className="spacer" />
                    <small>{date(m.created_at)}</small>
                  </div>
                  <h4>
                    {m.subject ||
                      `${m.direction === "inbound" ? "收到" : "发出"}一条${channelNames[m.channel]}消息`}
                  </h4>
                  <p>{m.body}</p>
                  <div className="inline">
                    <Icon name={m.channel} size={13} />
                    <button
                      className="text-button"
                      onClick={() =>
                        void act(
                          () =>
                            api(`/messages/${m.id}`, "PATCH", {
                              read: !m.read_at,
                            }),
                          "已更新",
                        ).then(reload)
                      }
                    >
                      {m.read_at ? "标为未读" : "标为已读"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        void act(
                          () =>
                            api(`/messages/${m.id}`, "PATCH", {
                              important: !m.important,
                            }),
                          "已更新",
                        ).then(reload)
                      }
                    >
                      {m.important ? "取消重要标记" : "标为重要"}
                    </button>
                    <Badge value={m.status} />
                    {m.classification && <Badge value={m.classification} />}
                  </div>
                </div>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        ) : (
          <Empty
            icon="inbox"
            title="对话还没开始，机会已经在路上。"
            body="连接渠道并发起触达，或在线索详情中记录客户回复。"
          />
        )}
      </section>
    </>
  );
}
function Pipeline({
  refresh,
  reload,
  act,
  select,
}: {
  refresh: number;
  reload: () => void;
  act: Action;
  select: (id: string) => void;
}) {
  const { data, error } = useData("/people/export", refresh);
  const { data: people } = useData("/people", refresh);
  return (
    <>
      <Header
        eyebrow="RELATIONSHIPS IN MOTION"
        title="每一个机会，稳步向前。"
        body="从刚刚认识，到成为客户。记录每一步进展。"
      />
      {!data ? (
        <Loading error={error} />
      ) : (
        <div className="pipeline-grid">
          {Object.entries(stageNames).map(([key, label]) => (
            <section className={`pipeline-column stage-${key}`} key={key}>
              <header>
                <span className="stage-dot" />
                <h3>{label}</h3>
                <b>{data.items.filter((p: Row) => p.stage === key).length}</b>
              </header>
              {people?.items
                .filter((p: Row) => p.stage === key)
                .map((p: Row) => (
                  <div className="pipeline-card" key={p.id}>
                    <button
                      className="pipeline-person"
                      onClick={() => select(p.id)}
                    >
                      <strong>{p.name}</strong>
                      <span>{p.company || p.email || "待补充资料"}</span>
                      <small>{p.title}</small>
                    </button>
                    <select
                      value={p.stage}
                      aria-label={`调整 ${p.name} 的销售阶段`}
                      onChange={(e) =>
                        void act(
                          () =>
                            api(`/people/${p.id}`, "PATCH", {
                              stage: e.target.value,
                            }),
                          "销售阶段已更新",
                        ).then(reload)
                      }
                    >
                      {Object.entries(stageNames).map(([s, l]) => (
                        <option key={s} value={s}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              {!data.items.some((p: Row) => p.stage === key) && (
                <div className="pipeline-empty">新的机会，会来到这里</div>
              )}
            </section>
          ))}
        </div>
      )}
      <p className="hint">
        阶段数量统计全部联系人；卡片展示最近 100
        位。更多线索可在联系人页面筛选和更新。
      </p>
    </>
  );
}
function Analytics({ refresh }: { refresh: number }) {
  const { data: d, error } = useData("/overview", refresh);
  if (!d) return <Loading error={error} />;
  const sent = d.messages.sent || 0,
    replies = d.messages.replies || 0;
  return (
    <>
      <Header
        eyebrow="SEE WHAT MOVES THE CONVERSATION"
        title="让下一步，心中有数。"
        body="全部历史数据 · 趋势展示最近 30 天 · 按实际消息和当前销售阶段统计"
      />
      <div className="stats-grid">
        {[
          ["已发送消息", sent],
          ["收到回复", replies],
          ["有意向线索", d.people.interested || 0],
          ["已成交客户", d.people.customers || 0],
        ].map(([label, value]) => (
          <div className="stat" key={label}>
            <span className="stat-label">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <h3>触达与回复 · 最近 30 天</h3>
            <div className="chart-legend">
              <span />
              发送
              <i />
              回复
            </div>
          </div>
          {d.trend.length ? (
            <div className="bar-chart">
              {d.trend.map((day: Row) => (
                <div className="bar-day" key={day.day}>
                  <div className="bar-pair">
                    <div
                      title={`已发送 ${day.sent}`}
                      style={{
                        height: `${Math.max(2, (day.sent / Math.max(1, ...d.trend.map((r: Row) => Math.max(r.sent, r.replies)))) * 160)}px`,
                      }}
                    />
                    <div
                      title={`回复 ${day.replies}`}
                      style={{
                        height: `${Math.max(2, (day.replies / Math.max(1, ...d.trend.map((r: Row) => Math.max(r.sent, r.replies)))) * 160)}px`,
                      }}
                    />
                  </div>
                  <small>{day.day.slice(5)}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="quiet">
              <Activity size={25} />
              <p>还没有消息数据</p>
              <small>你的真实发送和回复会绘制在这里。</small>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>渠道表现</h3>
          </div>
          <table>
            <thead>
              <tr>
                <th>渠道</th>
                <th>发送</th>
                <th>回复</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(channelNames).map(([key, label]) => {
                const row =
                  d.channels.find((x: Row) => x.channel === key) || {};
                return (
                  <tr key={key}>
                    <td>
                      <div className="inline">
                        <Icon name={key} />
                        {label}
                      </div>
                    </td>
                    <td>{row.sent || 0}</td>
                    <td>{row.replies || 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="panel-foot">
            “已发送”代表服务商已接受；不等同于邮件送达或已读。
          </div>
        </section>
      </div>
      <div className="notice">
        <CircleHelp size={19} />
        <span>
          回复为消息条数，同一联系人可回复多次；“有意向 / 约谈 /
          成交”为联系人当前阶段数量。手动记录的客户回复也计入统计。
        </span>
      </div>
    </>
  );
}
const TableDetail = AdvancedTable;
function Tables({
  refresh,
  reload,
  act,
}: {
  refresh: number;
  reload: () => void;
  act: Action;
}) {
  const { data, error } = useData("/tables", refresh),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState("");
  return (
    <>
      <Header
        eyebrow="A LITTLE RESEARCH. A BETTER OPENING."
        title="先了解，再开口。"
        body="用数据和 AI 补齐线索资料，准备更有针对性的对话。"
      >
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          新建数据表
        </button>
      </Header>
      {!data ? (
        <Loading error={error} />
      ) : data.items.length ? (
        <div className="campaign-grid">
          {data.items.map((t: Row) => (
            <button
              className="table-card"
              key={t.id}
              onClick={() => setSelected(t.id)}
            >
              <div className="table-card-illustration">
                <Table2 size={36} />
                <div />
                <div />
                <div />
              </div>
              <h3>{t.name}</h3>
              <p>
                {t.row_count} 行 · {JSON.parse(t.columns).length} 列
              </p>
              <span className="text-button">
                打开数据表 <ArrowUpRight size={15} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon="tables"
            title="让每条线索，多一点上下文。"
            body="创建数据表，添加 AI 个性化文案、邮箱查找或外部 API 数据列。"
            action="创建第一张数据表"
            onClick={() => setCreating(true)}
          />
        </section>
      )}
      {creating && (
        <Modal title="新建数据表" onClose={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const b = Object.fromEntries(new FormData(e.currentTarget));
              void act(async () => {
                const r = await api("/tables", "POST", b);
                setCreating(false);
                setSelected(r.id);
                reload();
              }, "数据表已创建");
            }}
          >
            <Field label="数据表名称">
              <input
                name="name"
                required
                autoFocus
                placeholder="例如：下一批值得认识的创始人"
              />
            </Field>
            <button className="button primary">创建数据表</button>
          </form>
        </Modal>
      )}
      {selected && (
        <TableDetail
          tid={selected}
          onClose={() => setSelected("")}
          act={act}
          refresh={refresh}
          reload={reload}
        />
      )}
    </>
  );
}
const integrationFields: Record<string, Row[]> = {
  resend: [
    { key: "api_key", label: "Resend API Key", secret: true },
    {
      key: "from_address",
      label: "已验证的发件地址",
      placeholder: "Gene <hello@yourdomain.com>",
    },
  ],
  openrouter: [
    { key: "api_key", label: "OpenRouter API Key", secret: true },
    { key: "model", label: "模型 ID", placeholder: "openai/gpt-4.1-mini" },
  ],
  unipile: [
    {
      key: "base_url",
      label: "Unipile API 地址",
      placeholder: "https://apiXX.unipile.com",
    },
    { key: "api_key", label: "API Key", secret: true },
    { key: "linkedin_account_id", label: "LinkedIn 账户 ID" },
    { key: "whatsapp_account_id", label: "WhatsApp 账户 ID" },
  ],
  hunter: [{ key: "api_key", label: "Hunter API Key", secret: true }],
  apollo: [{ key: "api_key", label: "Apollo API Key", secret: true }],
  webhook: [
    { key: "secret", label: "Webhook 密钥（至少 24 字符）", secret: true },
  ],
};
function SettingsPage({
  refresh,
  reload,
  act,
  user,
}: {
  refresh: number;
  reload: () => void;
  act: Action;
  user: Row;
}) {
  const { data: d, error } = useData("/settings", refresh),
    { data: jobs } = useData("/jobs", refresh);
  const [tab, setTab] = useState("workspace"),
    [connect, setConnect] = useState(""),
    [addingKnowledge, setAddingKnowledge] = useState(false),
    [invite, setInvite] = useState(false),
    [inviteLink, setInviteLink] = useState("");
  if (!d) return <Loading error={error} />;
  const admin = ["owner", "admin"].includes(user.role);
  return (
    <>
      <Header
        eyebrow="MAKE THIS WORKSPACE YOURS"
        title="好的系统，懂你的做事方式。"
        body="产品信息、触达渠道、团队与发送节奏。"
      />
      <div className="tabs standalone">
        {[
          ["workspace", "工作台"],
          ["integrations", "渠道连接"],
          ["knowledge", "知识库"],
          ["members", "团队成员"],
          ["tasks", "任务记录"],
          ["account", "账户"],
        ].map(([k, v]) => (
          <button
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
            key={k}
          >
            {v}
          </button>
        ))}
      </div>
      {tab === "workspace" && (
        <section className="panel settings-panel">
          <div className="panel-heading">
            <h3>你的业务，先说清楚。</h3>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api(
                    "/settings",
                    "PATCH",
                    Object.fromEntries(new FormData(e.currentTarget)),
                  ),
                "工作台设置已保存",
              ).then(reload);
            }}
          >
            <fieldset disabled={!admin}>
              <div className="form-grid">
                <Field label="工作台名称">
                  <input name="name" defaultValue={d.workspace.name} required />
                </Field>
                <Field label="产品名称">
                  <input name="product" defaultValue={d.workspace.product} />
                </Field>
              </div>
              <Field label="产品官网">
                <input
                  name="website"
                  defaultValue={d.workspace.website}
                  placeholder="https://yourcompany.com"
                />
              </Field>
              <Field label="产品介绍" hint="AI 撰写消息时会参考这里的事实。">
                <textarea
                  name="description"
                  rows={5}
                  defaultValue={d.workspace.description}
                  placeholder="你解决什么问题？对谁有帮助？你的产品有什么已验证的特点？"
                />
              </Field>
              <Field label="目标客户画像">
                <textarea
                  name="target_audience"
                  rows={3}
                  defaultValue={d.workspace.target_audience}
                  placeholder="行业、公司规模、岗位、地域，以及你希望解决的具体需求。"
                />
              </Field>
              <div className="section-title">
                <h3>发送节奏</h3>
              </div>
              <div className="form-grid">
                <Field label="工作台时区">
                  <input
                    name="timezone"
                    defaultValue={d.workspace.timezone}
                    placeholder="Asia/Shanghai"
                  />
                </Field>
                <Field label="每个渠道每日总量上限">
                  <input
                    name="daily_limit"
                    type="number"
                    min="1"
                    max="500"
                    defaultValue={d.workspace.daily_limit}
                  />
                </Field>
                <Field label="开始发送（小时）">
                  <input
                    name="start_hour"
                    type="number"
                    min="0"
                    max="23"
                    defaultValue={d.workspace.start_hour}
                  />
                </Field>
                <Field label="停止发送（小时）">
                  <input
                    name="end_hour"
                    type="number"
                    min="1"
                    max="24"
                    defaultValue={d.workspace.end_hour}
                  />
                </Field>
              </div>
              <button className="button primary">
                <Check size={16} />
                保存设置
              </button>
            </fieldset>
          </form>
        </section>
      )}
      {tab === "integrations" && (
        <>
          <div className="native-ai">
            <div className="native-ai-icon">
              <Sparkles size={26} />
            </div>
            <div>
              <h3>AI 已就绪</h3>
              <p>
                已连接内置 AI，可生成回复草稿、分类客户意向、运行 AI 数据列。
              </p>
            </div>
            <Badge value="active" label="已连接" />
          </div>
          <div className="integration-grid">
            {[
              {
                kind: "resend",
                name: "Resend",
                desc: "用已验证域名发送邮件活动与回复",
                icon: "email",
              },
              {
                kind: "unipile",
                name: "Unipile",
                desc: "连接你的 LinkedIn 和 WhatsApp 账户",
                icon: "linkedin",
              },
              {
                kind: "openrouter",
                name: "OpenRouter",
                desc: "可选：使用你自己的 AI 模型与密钥",
                icon: "tables",
              },
              {
                kind: "hunter",
                name: "Hunter",
                desc: "根据姓名与公司域名查找邮箱",
                icon: "leads",
              },
              {
                kind: "apollo",
                name: "Apollo",
                desc: "补全联系人与公司资料",
                icon: "leads",
              },
              {
                kind: "webhook",
                name: "回复接入",
                desc: "接入渠道回复，统一保存并生成草稿",
                icon: "inbox",
              },
            ].map((x) => {
              const linked = d.integrations.some((i: Row) => i.kind === x.kind);
              return (
                <div className="integration-card" key={x.kind}>
                  <div className="integration-heading">
                    <span className="integration-icon">
                      <Icon name={x.icon} size={24} />
                    </span>
                    <Badge
                      value={linked ? "active" : "draft"}
                      label={linked ? "已连接" : "未连接"}
                    />
                  </div>
                  <h3>{x.name}</h3>
                  <p>{x.desc}</p>
                  <div className="inline">
                    <button
                      className="button small"
                      disabled={!admin}
                      onClick={() => setConnect(x.kind)}
                    >
                      {linked ? "更新连接" : "连接账户"}
                      <ArrowUpRight size={14} />
                    </button>
                    {linked && (
                      <button
                        className="text-button danger"
                        disabled={!admin}
                        onClick={() =>
                          void act(
                            () => api(`/integrations/${x.kind}`, "DELETE"),
                            "连接已移除",
                          ).then(reload)
                        }
                      >
                        断开
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <section className="panel settings-panel">
            <h3>回复 Webhook 地址</h3>
            <p className="muted">
              在“回复接入”设置密钥，再为渠道配置以下地址与 X-Webhook-Secret
              请求头。未匹配的联系人会跳过。
            </p>
            {Object.entries(d.webhooks).map(([k, v]) => (
              <Field key={k} label={channelNames[k]}>
                <code className="code-block">{String(v)}</code>
              </Field>
            ))}
            <p className="hint">
              邮件回复接入需由邮箱服务把回复转换为
              email、external_id、body、subject 字段；LinkedIn / WhatsApp 可接收
              Unipile 消息事件。不会自动读取你的邮箱。
            </p>
          </section>
        </>
      )}
      {tab === "knowledge" && (
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h3>让 AI 说得有根据</h3>
              <p className="muted">产品事实、常见问题、价格说明与沟通口径。</p>
            </div>
            <button
              className="button primary"
              disabled={!admin}
              onClick={() => setAddingKnowledge(true)}
            >
              <Plus size={16} />
              添加资料
            </button>
          </div>
          {d.knowledge.length ? (
            d.knowledge.map((k: Row) => (
              <div className="knowledge-card" key={k.id}>
                <div>
                  <FileText size={18} />
                  <h3>{k.title}</h3>
                  <span className="spacer" />
                  <button
                    className="icon-button"
                    disabled={!admin}
                    aria-label="删除知识库资料"
                    onClick={() =>
                      void act(
                        () => api(`/knowledge/${k.id}`, "DELETE"),
                        "资料已删除",
                      ).then(reload)
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <p className="preserve">{k.content}</p>
              </div>
            ))
          ) : (
            <Empty
              icon="tables"
              title="给 AI 一份准确的业务说明"
              body="添加真实的产品资料，让草稿更具体、更可信。"
            />
          )}
        </section>
      )}
      {tab === "members" && (
        <section className="panel">
          <div className="panel-heading">
            <h3>一起推进客户关系</h3>
            <button
              className="button primary"
              disabled={!admin}
              onClick={() => setInvite(true)}
            >
              <Plus size={16} />
              邀请成员
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>成员</th>
                <th>邮箱</th>
                <th>角色</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.members.map((m: Row) => (
                <tr key={m.id}>
                  <td>
                    <div className="person-cell">
                      <span className="avatar">{m.name.slice(0, 1)}</span>
                      <strong>{m.name}</strong>
                    </div>
                  </td>
                  <td>{m.email}</td>
                  <td>
                    <Badge
                      value={m.role}
                      label={
                        { owner: "所有者", admin: "管理员", member: "成员" }[
                          m.role as "owner"
                        ]
                      }
                    />
                  </td>
                  <td>
                    {admin && m.role !== "owner" && m.id !== user.id && (
                      <button
                        className="text-button danger"
                        onClick={() =>
                          void act(
                            () => api(`/members/${m.id}`, "DELETE"),
                            "成员已移除",
                          ).then(reload)
                        }
                      >
                        移除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {tab === "tasks" && (
        <section className="panel">
          <div className="panel-heading">
            <h3>后台任务记录</h3>
            <button className="button small" onClick={reload}>
              刷新记录
            </button>
          </div>
          {jobs?.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>状态</th>
                    <th>说明</th>
                    <th>时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobs.items.map((j: Row) => (
                    <tr key={j.id}>
                      <td>
                        {{
                          send: "消息发送",
                          crm: "AI 分类与草稿",
                          enrich: "资料补全",
                          transcribe: "录音转文字",
                        }[j.kind as "send"] || j.kind}
                      </td>
                      <td>
                        <Badge value={j.status} />
                      </td>
                      <td className="task-error">{j.error || "—"}</td>
                      <td>{date(j.updated_at)}</td>
                      <td>
                        {j.status === "failed" && (
                          <button
                            className="button small"
                            onClick={() =>
                              void act(
                                () => api(`/jobs/${j.id}/retry`, "POST", {}),
                                "已重新排队",
                              ).then(reload)
                            }
                          >
                            重试
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon="analytics"
              title="每一次执行，都留有记录"
              body="AI、发送和数据补全任务将在这里显示状态。"
            />
          )}
        </section>
      )}
      {tab === "account" && (
        <section className="panel settings-panel">
          <h3>修改密码</h3>
          <p className="muted">{user.email}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              void act(
                () =>
                  api(
                    "/auth/password",
                    "POST",
                    Object.fromEntries(new FormData(form)),
                  ),
                "密码已更新，其他登录会话已退出",
              ).then((ok) => {
                if (ok) form.reset();
              });
            }}
          >
            <Field label="当前密码">
              <input
                name="current"
                type="password"
                required
                autoComplete="current-password"
              />
            </Field>
            <Field label="新密码（至少 12 位）">
              <input
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            <button className="button primary">更新密码</button>
          </form>
        </section>
      )}
      {connect && (
        <Modal
          title={`连接 ${connect === "webhook" ? "回复接入" : connect}`}
          onClose={() => setConnect("")}
        >
          <p className="muted">
            密钥加密保存，后续不会在页面中显示。
            {connect === "resend" ? "验证连接需要可读取域名的 API Key。" : ""}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api(
                    `/integrations/${connect}`,
                    "POST",
                    Object.fromEntries(new FormData(e.currentTarget)),
                  ),
                "连接已保存",
              ).then((ok) => {
                if (ok) {
                  setConnect("");
                  reload();
                }
              });
            }}
          >
            {integrationFields[connect].map((f) => (
              <Field label={f.label} key={f.key}>
                <input
                  name={f.key}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  placeholder={f.placeholder || ""}
                  required={
                    ![
                      "model",
                      "linkedin_account_id",
                      "whatsapp_account_id",
                    ].includes(f.key)
                  }
                />
              </Field>
            ))}
            <button className="button primary">
              <Check size={16} />
              {connect === "webhook" ? "保存接入密钥" : "验证并保存"}
            </button>
          </form>
        </Modal>
      )}
      {addingKnowledge && (
        <Modal title="添加知识库资料" onClose={() => setAddingKnowledge(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api(
                    "/knowledge",
                    "POST",
                    Object.fromEntries(new FormData(e.currentTarget)),
                  ),
                "知识库已更新",
              ).then((ok) => {
                if (ok) {
                  setAddingKnowledge(false);
                  reload();
                }
              });
            }}
          >
            <Field label="标题">
              <input
                name="title"
                required
                placeholder="产品介绍 / 常见问题 / 价格说明"
              />
            </Field>
            <Field label="内容">
              <textarea name="content" rows={10} required />
            </Field>
            <button className="button primary">保存资料</button>
          </form>
        </Modal>
      )}
      {invite && (
        <Modal
          title="邀请团队成员"
          onClose={() => {
            setInvite(false);
            setInviteLink("");
          }}
        >
          {inviteLink ? (
            <>
              <p>把这条专属链接发给你的同事。有效期 7 天，仅指定邮箱可使用。</p>
              <code className="code-block">{inviteLink}</code>
              <button
                className="button primary"
                onClick={() =>
                  void act(
                    () => navigator.clipboard.writeText(inviteLink),
                    "邀请链接已复制",
                  )
                }
              >
                <Copy size={16} />
                复制邀请链接
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const r = await api(
                    "/members/invite",
                    "POST",
                    Object.fromEntries(new FormData(e.currentTarget)),
                  );
                  setInviteLink(r.url);
                });
              }}
            >
              <Field label="同事的邮箱">
                <input type="email" name="email" required />
              </Field>
              <Field label="角色">
                <select name="role">
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
              </Field>
              <button className="button primary">
                创建邀请链接 <ArrowRight size={16} />
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
const nav = [
  ["overview", "总览"],
  ["leads", "联系人"],
  ["tables", "数据表"],
  ["campaigns", "触达活动"],
  ["inbox", "统一收件箱"],
  ["pipeline", "销售漏斗"],
  ["analytics", "数据分析"],
  ["channels", "渠道账号"],
  ["discovery", "发现线索"],
  ["crm", "客户跟进"],
  ["calling", "通话工作台"],
  ["workspace", "团队与数据服务"],
];
function App() {
  const [status, setStatus] = useState<Row | null>(null),
    [authError, setAuthError] = useState(""),
    [path, setPath] = useState(location.pathname.slice(1) || "overview"),
    [refresh, setRefresh] = useState(0),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(
      null,
    ),
    [busy, setBusy] = useState(0),
    [person, setPerson] = useState(""),
    [mobile, setMobile] = useState(false);
  const loadAuth = () =>
    api("/auth/status")
      .then(setStatus)
      .catch((e) => setAuthError(e.message));
  useEffect(() => {
    void loadAuth();
    const fn = () => setPath(location.pathname.slice(1) || "overview");
    addEventListener("popstate", fn);
    return () => removeEventListener("popstate", fn);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 6000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const go = (p: string) => {
    setPath(p);
    setMobile(false);
    history.pushState({}, "", `/${p === "overview" ? "" : p}`);
    window.scrollTo(0, 0);
  };
  const reload = () => setRefresh((x) => x + 1);
  const act: Action = async (work, success) => {
    setBusy((n) => n + 1);
    try {
      await work();
      if (success) setToast({ message: success, error: false });
      return true;
    } catch (e) {
      setToast({ message: (e as Error).message, error: true });
      return false;
    } finally {
      setBusy((n) => n - 1);
    }
  };
  if (!status)
    return (
      <div className="full-loading">
        <Loading error={authError} />
      </div>
    );
  if (["/forgot-password", "/reset-password"].includes(location.pathname))
    return <Recovery onDone={() => void loadAuth()} />;
  if (!status.user)
    return <Auth status={status} onDone={() => void loadAuth()} />;
  const shared = { refresh, reload, act, select: setPerson };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            go("overview");
          }}
        >
          <span className="brand-mark">A</span>
          <strong>
            AgentSDR<span className="brand-dot">.</span>
          </strong>
        </a>
        <button className="workspace-switch" onClick={() => go("settings")}>
          <span className="workspace-avatar">G</span>
          <div>
            <strong>{status.user.org_name || "我的工作台"}</strong>
            <small>你的销售工作台</small>
          </div>
          <ChevronDown size={15} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(([key, label]) => (
            <button
              className={path === key ? "active" : ""}
              onClick={() => go(key)}
              key={key}
            >
              <Icon name={key} />
              <span>{label}</span>
              {path === key && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Sparkles size={19} />
            <strong>把时间，留给好对话。</strong>
            <p>
              让 AI 帮你准备，
              <br />
              每一句由你决定。
            </p>
            <button onClick={() => go("settings")}>
              完善你的产品资料 <ArrowUpRight size={14} />
            </button>
          </div>
          <button
            className={`sidebar-settings ${path === "settings" ? "active" : ""}`}
            onClick={() => go("settings")}
          >
            <Settings size={18} />
            工作台设置
          </button>
          <div className="user-menu">
            <span className="avatar">{status.user.name.slice(0, 1)}</span>
            <div>
              <strong>{status.user.name}</strong>
              <small>{status.user.email}</small>
            </div>
            <button
              className="icon-button"
              aria-label="退出登录"
              title="退出登录"
              onClick={() =>
                void act(async () => {
                  await api("/auth/logout", "POST", {});
                  setStatus({ ...status, user: null });
                })
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {mobile && (
        <div className="sidebar-scrim" onClick={() => setMobile(false)} />
      )}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setMobile(!mobile)}
            aria-label="打开导航"
          >
            <LayoutDashboard size={20} />
          </button>
          <div className="breadcrumb">
            <span>工作台</span>
            <ChevronRight size={13} />
            <strong>{nav.find((x) => x[0] === path)?.[1] || "设置"}</strong>
          </div>
          <div className="topbar-right">
            {busy > 0 && <Loader2 size={15} className="spin" />}
            <span className="workspace-status">
              <i />
              你的私人工作台
            </span>
            <button
              className="icon-button"
              aria-label="帮助与说明"
              onClick={() =>
                window.open(
                  "https://github.com/Digidai/AgentSDR/blob/cloudflare-native/cloudflare/README.md",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <main className="page-content">
          {path === "channels" ? (
            <Channels {...shared} />
          ) : path === "discovery" ? (
            <Discovery {...shared} />
          ) : path === "crm" ? (
            <CrmWorkspace {...shared} />
          ) : path === "calling" ? (
            <Calling {...shared} />
          ) : path === "workspace" ? (
            <Workspace {...shared} />
          ) : path === "overview" ? (
            <Overview refresh={refresh} go={go} />
          ) : path === "leads" ? (
            <Leads {...shared} />
          ) : path === "campaigns" ? (
            <Campaigns {...shared} />
          ) : path === "inbox" ? (
            <InboxPage {...shared} />
          ) : path === "pipeline" ? (
            <Pipeline {...shared} />
          ) : path === "analytics" ? (
            <>
              <Analytics refresh={refresh} />
              <ExtendedAnalytics {...shared} />
            </>
          ) : path === "tables" ? (
            <Tables {...shared} />
          ) : (
            <SettingsPage {...shared} user={status.user} />
          )}
          <footer className="page-footer">
            <span>
              AgentSDR <span>·</span> {status.user.org_name || "我的工作台"}
            </span>
            <span>每一步向前，都有价值。</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div role="alert" className={`toast ${toast.error ? "error" : ""}`}>
          {toast.error ? <CircleHelp size={18} /> : <CheckCheck size={18} />}
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {person && (
        <LeadDetail
          pid={person}
          onClose={() => setPerson("")}
          act={act}
          refresh={refresh}
          reload={reload}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
