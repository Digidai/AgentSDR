import React, { useEffect, useState } from "react";
import {
  api,
  useData,
  type Row,
  Badge,
  date,
  readRows,
  csvDownload,
  channelNames,
} from "./lib";
import {
  Phone,
  Plus,
  RefreshCw,
  X,
  Trash2,
  Play,
  Pause,
  Download,
  Search,
  Settings2,
} from "lucide-react";
export type Action = (
  work: () => Promise<any>,
  success?: string,
) => Promise<boolean>;
type Props = {
  refresh: number;
  reload: () => void;
  act: Action;
  select?: (id: string) => void;
};
type Input = {
  key: string;
  label: string;
  type?: string;
  value?: any;
  options?: Row[];
  required?: boolean;
  hint?: string;
};
const parsed = (s: any, fallback: any = {}) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : (s ?? fallback);
  } catch {
    return fallback;
  }
};
function Title({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <span className="eyebrow">AGENTSDR WORKSPACE</span>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}
export function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel extended-panel">
      <header>
        <h3>{title}</h3>
      </header>
      <div className="extended-body">{children}</div>
    </section>
  );
}
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", f);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", f);
      document.body.style.overflow = old;
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}
export function Form({
  fields,
  submit,
  label = "保存",
  children,
}: {
  fields: Input[];
  submit: (b: Row) => Promise<any>;
  label?: string;
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="extended-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const b: Row = Object.fromEntries(new FormData(e.currentTarget));
        setBusy(true);
        setError("");
        try {
          for (const f of fields) {
            if (f.type === "number") b[f.key] = Number(b[f.key]);
            if (f.type === "checkbox") b[f.key] = !!b[f.key];
            if (f.type === "json") b[f.key] = JSON.parse(b[f.key] || "{}");
            if (f.type === "lines")
              b[f.key] = String(b[f.key])
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean);
          }
          await submit(b);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        {fields.map((f) => (
          <label
            className={`field ${["textarea", "json", "lines"].includes(f.type || "") ? "span-all" : ""}`}
            key={f.key}
          >
            <span>{f.label}</span>
            {f.options ? (
              <select
                name={f.key}
                defaultValue={f.value || ""}
                required={f.required}
              >
                {f.options.map((o) => (
                  <option key={o.id ?? o.value} value={o.id ?? o.value}>
                    {o.name ?? o.label}
                  </option>
                ))}
              </select>
            ) : ["textarea", "json", "lines"].includes(f.type || "") ? (
              <textarea
                name={f.key}
                rows={f.type === "json" ? 7 : 3}
                required={f.required}
                defaultValue={
                  f.type === "json"
                    ? JSON.stringify(f.value ?? {}, null, 2)
                    : Array.isArray(f.value)
                      ? f.value.join("\n")
                      : f.value
                }
              />
            ) : (
              <input
                name={f.key}
                step={f.type === "number" ? "any" : undefined}
                type={f.type || "text"}
                required={f.required}
                defaultValue={f.type === "checkbox" ? undefined : f.value}
                defaultChecked={f.type === "checkbox" ? !!f.value : undefined}
              />
            )}{" "}
            {f.hint && <small>{f.hint}</small>}
          </label>
        ))}
      </div>
      {children}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button disabled={busy} className="button primary">
        {busy ? "正在处理…" : label}
      </button>
    </form>
  );
}
export function DataList({
  items,
  columns,
  actions,
  onRow,
}: {
  items: Row[];
  columns: [string, string][];
  actions?: (r: Row) => React.ReactNode;
  onRow?: (r: Row) => void;
}) {
  if (!items.length)
    return (
      <p className="muted extended-empty">暂无记录。添加后会显示在这里。</p>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map(([k, v]) => (
              <th key={k}>{v}</th>
            ))}
            {actions && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={r.id || i}>
              {columns.map(([k]) => (
                <td key={k}>
                  {k === "name" && onRow ? (
                    <button className="text-button" onClick={() => onRow(r)}>
                      {r[k]}
                    </button>
                  ) : typeof r[k] === "object" ? (
                    JSON.stringify(r[k])
                  ) : (
                    String(r[k] ?? "—")
                  )}
                </td>
              ))}
              {actions && (
                <td>
                  <div className="row-actions">{actions(r)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Tabs({
  items,
  value,
  onChange,
}: {
  items: string[][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="tabs standalone">
      {items.map(([key, label]) => (
        <button
          key={key}
          className={value === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
const channelOptions = Object.entries(channelNames).map(([id, name]) => ({
  id,
  name,
}));
const categories = [
  { id: "interested", name: "有意向" },
  { id: "customer", name: "客户" },
  { id: "not_interested", name: "暂无意向" },
  { id: "other", name: "其他" },
];
function useMutation(p: Props) {
  return (path: string, method = "POST", body: Row = {}) =>
    p
      .act(() => api(path, method, body), "已更新")
      .then((ok) => {
        if (ok) p.reload();
        return ok;
      });
}
export function Channels(p: Props) {
  const { data, error } = useData("/accounts", p.refresh),
    [edit, setEdit] = useState<Row | null>(null),
    [tab, setTab] = useState("accounts"),
    [channel, setChannel] = useState("email"),
    [connect, setConnect] = useState(""),
    [urls, setUrls] = useState<Row | null>(null);
  const run = useMutation(p);
  return (
    <>
      <Title
        title="让每个账号，按你的节奏工作。"
        body="邮箱、LinkedIn 与 WhatsApp 的连接、签名、工作时间和发送规则。"
      >
        <button className="button" onClick={() => void run("/accounts/sync")}>
          <RefreshCw size={16} />
          同步账号
        </button>
      </Title>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["accounts", "账号"],
          ["rules", "发送规则"],
          ["connections", "已建立连接"],
          ["events", "事件记录"],
        ]}
      />
      {error && <p role="alert">{error}</p>}
      {tab === "accounts" ? (
        <>
          <div className="toolbar">
            <button
              className="button primary"
              onClick={() => setConnect("mailbox")}
            >
              <Plus size={16} />
              连接邮箱
            </button>
            {["linkedin", "whatsapp"].map((c) => (
              <button
                className="button"
                key={c}
                onClick={() =>
                  void p.act(async () => {
                    const r = await api("/accounts/hosted-auth", "POST", {
                      channel: c,
                    });
                    location.assign(r.url);
                  })
                }
              >
                连接 {channelNames[c]}
              </button>
            ))}
            <button className="button" onClick={() => setConnect("workspace")}>
              Google Workspace 配置
            </button>
            <button
              className="button"
              onClick={() =>
                void p.act(async () =>
                  setUrls(await api("/channel-webhooks/register", "POST", {})),
                )
              }
            >
              注册消息通知
            </button>
          </div>
          <Panel title="已连接的账号">
            <DataList
              items={data?.items || []}
              columns={[
                ["name", "账号"],
                ["channel", "渠道"],
                ["address", "地址 / 号码"],
                ["status", "状态"],
                ["daily_limit", "每日上限"],
                ["last_sync_at", "上次同步"],
              ]}
              onRow={setEdit}
              actions={(r) => (
                <>
                  <button className="text-button" onClick={() => setEdit(r)}>
                    设置
                  </button>
                  <button
                    className="text-button"
                    onClick={() => void run(`/accounts/${r.id}/test`)}
                  >
                    检测
                  </button>
                  <button
                    className="text-button"
                    onClick={() => void run(`/accounts/${r.id}/sync`)}
                  >
                    同步会话
                  </button>
                  {r.channel !== "email" && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void p.act(async () =>
                          location.assign(
                            (
                              await api("/accounts/hosted-auth", "POST", {
                                channel: r.channel,
                                account_id: r.id,
                              })
                            ).url,
                          ),
                        )
                      }
                    >
                      重连
                    </button>
                  )}
                </>
              )}
            />
          </Panel>
        </>
      ) : tab === "rules" ? (
        <>
          <Tabs
            items={[
              ...channelOptions.map((c) => [c.id, c.name]),
              ["general", "通用"],
            ]}
            value={channel}
            onChange={setChannel}
          />
          <RuleEditor key={channel} channel={channel} {...p} />
        </>
      ) : tab === "connections" ? (
        <RemoteList
          path="/connections"
          {...p}
          columns={[
            ["provider_id", "联系人"],
            ["account_id", "账号"],
            ["status", "连接状态"],
            ["accepted_at", "接受时间"],
          ]}
        />
      ) : (
        <RemoteList
          path="/webhook-events"
          {...p}
          columns={[
            ["provider", "来源"],
            ["status", "状态"],
            ["created_at", "时间"],
            ["error", "详情"],
          ]}
          actions={(r) => (
            <button
              className="text-button"
              onClick={() => void run(`/webhook-events/${r.id}/replay`)}
            >
              重放
            </button>
          )}
        />
      )}
      {edit && (
        <Dialog title="账号设置" onClose={() => setEdit(null)}>
          <Form
            fields={[
              { key: "name", label: "显示名称", value: edit.name },
              {
                key: "signature",
                label: "邮件签名",
                type: "textarea",
                value: edit.signature,
              },
              {
                key: "daily_limit",
                label: "每日上限",
                type: "number",
                value: edit.daily_limit,
              },
              {
                key: "is_default",
                label: "设为默认账号",
                type: "checkbox",
                value: edit.is_default,
              },
              {
                key: "status",
                label: "状态",
                value: edit.status,
                options: [
                  { id: "connected", name: "启用" },
                  { id: "disabled", name: "暂停" },
                  { id: "disconnected", name: "断开" },
                ],
              },
            ]}
            submit={async (b) => {
              if (await run(`/accounts/${edit.id}`, "PATCH", b)) setEdit(null);
            }}
          />
          <HoursEditor
            value={edit.settings?.hours}
            save={(h) =>
              run(`/accounts/${edit.id}`, "PATCH", { settings: { hours: h } })
            }
          />
          <button
            className="button danger"
            onClick={() =>
              void run(`/accounts/${edit.id}`, "DELETE").then((ok) => {
                if (ok) setEdit(null);
              })
            }
          >
            移除账号
          </button>
        </Dialog>
      )}
      {connect && (
        <Dialog
          title={
            connect === "mailbox" ? "添加工作邮箱" : "Google Workspace 连接"
          }
          onClose={() => setConnect("")}
        >
          <Form
            fields={
              connect === "mailbox"
                ? [
                    {
                      key: "email",
                      label: "邮箱地址",
                      type: "email",
                      required: true,
                    },
                    { key: "name", label: "显示名称" },
                    { key: "signature", label: "签名", type: "textarea" },
                  ]
                : [
                    {
                      key: "client_email",
                      label: "服务账号邮箱",
                      required: true,
                    },
                    {
                      key: "private_key",
                      label: "私钥",
                      type: "textarea",
                      required: true,
                    },
                    {
                      key: "test_email",
                      label: "已授权的测试邮箱",
                      type: "email",
                      required: true,
                    },
                    { key: "pubsub_topic", label: "邮件通知主题（可选）" },
                  ]
            }
            submit={async (b) => {
              if (
                await run(
                  connect === "mailbox"
                    ? "/mailboxes"
                    : "/integrations/google-workspace",
                  "POST",
                  b,
                )
              )
                setConnect("");
            }}
          />
          {connect !== "mailbox" && (
            <p className="muted">
              Google 管理员需先授权服务账号代管
              Gmail；通知主题可选，未配置时定时同步。
            </p>
          )}
        </Dialog>
      )}
      {urls && (
        <Dialog title="消息通知地址" onClose={() => setUrls(null)}>
          <pre className="code-block">{JSON.stringify(urls, null, 2)}</pre>
          <p>这些地址含私有凭据，请只填写到对应服务的通知设置。</p>
        </Dialog>
      )}
    </>
  );
}
function RemoteList({
  path,
  columns,
  actions,
  ...p
}: Props & {
  path: string;
  columns: [string, string][];
  actions?: (r: Row) => React.ReactNode;
}) {
  const { data, error } = useData(path, p.refresh);
  return error ? (
    <p className="form-error">{error}</p>
  ) : (
    <DataList items={data?.items || []} columns={columns} actions={actions} />
  );
}
function HoursEditor({
  value,
  save,
}: {
  value: Row | null;
  save: (v: Row | null) => Promise<any>;
}) {
  return (
    <Form
      key={JSON.stringify(value)}
      fields={[
        {
          key: "timezone",
          label: "时区",
          value: value?.timezone || "Asia/Shanghai",
        },
        {
          key: "start",
          label: "开始",
          type: "time",
          value: value?.start || "09:00",
        },
        {
          key: "end",
          label: "结束",
          type: "time",
          value: value?.end || "18:00",
        },
        {
          key: "days",
          label: "每周工作日",
          value: (value?.days || [1, 2, 3, 4, 5]).join(","),
          hint: "0 周日，1 周一，依此类推；用逗号分隔",
        },
      ]}
      label="保存工作时间"
      submit={(b) =>
        save({ ...b, days: String(b.days).split(",").map(Number) })
      }
    />
  );
}
function RuleEditor({ channel, ...p }: Props & { channel: string }) {
  const { data, error } = useData(`/channel-rules/${channel}`, p.refresh),
    run = useMutation(p);
  if (!data) return <p>{error || "正在加载规则…"}</p>;
  return (
    <div className="extended-stack">
      {data.warnings.map((s: string) => (
        <p className="notice" key={s}>
          {s}
        </p>
      ))}
      <Panel title="发送节奏">
        <Form
          key={JSON.stringify(data.values)}
          fields={data.definitions
            .filter((r: Row) => r.kind !== "hours")
            .map((r: Row) => ({
              key: r.key,
              label: r.label,
              type:
                r.kind === "range"
                  ? "text"
                  : r.kind === "number"
                    ? "number"
                    : r.kind === "time"
                      ? "time"
                      : "text",
              value: Array.isArray(data.values[r.key])
                ? data.values[r.key].join(",")
                : data.values[r.key],
              hint: r.help,
            }))}
          submit={(b) =>
            run(`/channel-rules/${channel}`, "PUT", {
              ...data.values,
              ...Object.fromEntries(
                Object.entries(b).map(([k, v]) => [
                  k,
                  data.definitions.find((r: Row) => r.key === k)?.kind ===
                  "range"
                    ? String(v).split(",").map(Number)
                    : v,
                ]),
              ),
            })
          }
        />
      </Panel>
      {data.definitions
        .filter((r: Row) => r.kind === "hours")
        .map((r: Row) => (
          <Panel title={r.label} key={r.key}>
            <HoursEditor
              value={data.values[r.key]}
              save={(h) =>
                run(`/channel-rules/${channel}`, "PUT", {
                  ...data.values,
                  [r.key]: h,
                })
              }
            />
            {r.optional && (
              <button
                className="text-button"
                onClick={() =>
                  void run(`/channel-rules/${channel}`, "PUT", {
                    ...data.values,
                    [r.key]: null,
                  })
                }
              >
                不限时间
              </button>
            )}
          </Panel>
        ))}
    </div>
  );
}
export function Discovery(p: Props) {
  const [tab, setTab] = useState("linkedin"),
    [adding, setAdding] = useState(false),
    [chosen, setChosen] = useState("");
  const path = tab === "linkedin" ? "/search/batches" : "/prospecting",
    { data, error } = useData(path, p.refresh),
    { data: accounts } = useData("/accounts", p.refresh),
    run = useMutation(p);
  return (
    <>
      <Title
        title="从线索，找到下一段对话。"
        body="批量搜索 LinkedIn 联系人，或按你的标准研究公司网站。"
      >
        <button className="button primary" onClick={() => setAdding(true)}>
          <Plus size={16} />
          新建批次
        </button>
      </Title>
      <Tabs
        items={[
          ["linkedin", "LinkedIn 搜索"],
          ["prospecting", "公司研究"],
        ]}
        value={tab}
        onChange={(v) => {
          setTab(v);
          setChosen("");
        }}
      />
      {error && <p role="alert">{error}</p>}
      <DataList
        items={data?.items || []}
        columns={[
          ["name", "批次"],
          ["status", "状态"],
          ["created_at", "创建时间"],
        ]}
        onRow={(r) => setChosen(r.id)}
        actions={(r) => (
          <>
            <button className="text-button" onClick={() => setChosen(r.id)}>
              查看
            </button>
            <button
              className="text-button"
              onClick={() => void run(`${path}/${r.id}/run`)}
            >
              运行
            </button>
            <button
              className="text-button"
              onClick={() => void run(`${path}/${r.id}`, "DELETE")}
            >
              删除
            </button>
          </>
        )}
      />
      {adding && (
        <Dialog title="创建搜索批次" onClose={() => setAdding(false)}>
          <Form
            fields={[
              { key: "name", label: "批次名称", required: true },
              ...(tab === "linkedin"
                ? [
                    {
                      key: "account_id",
                      label: "LinkedIn 账号",
                      required: true,
                      options: (accounts?.items || [])
                        .filter((a: Row) => a.channel === "linkedin")
                        .map((a: Row) => ({
                          id: a.id,
                          name: a.name || a.external_id,
                        })),
                    },
                    {
                      key: "queries",
                      label: "搜索关键词，每行一条",
                      type: "lines",
                      required: true,
                    },
                  ]
                : [
                    {
                      key: "domains",
                      label: "公司域名，每行一个",
                      type: "lines",
                      required: true,
                    },
                    {
                      key: "criteria",
                      label: "筛选标准",
                      type: "textarea",
                      required: true,
                    },
                  ]),
            ]}
            submit={async (b) => {
              if (await run(path, "POST", b)) setAdding(false);
            }}
          />
        </Dialog>
      )}
      {chosen && (
        <DiscoveryDetail
          {...p}
          path={path}
          id={chosen}
          onClose={() => setChosen("")}
        />
      )}
    </>
  );
}
function DiscoveryDetail({
  path,
  id,
  onClose,
  ...p
}: Props & { path: string; id: string; onClose: () => void }) {
  const { data, error } = useData(`${path}/${id}`, p.refresh),
    run = useMutation(p);
  return (
    <Dialog title={data?.name || "批次详情"} onClose={onClose}>
      {error && <p>{error}</p>}
      <div className="toolbar">
        <button
          className="button primary"
          onClick={() => void run(`${path}/${id}/run`)}
        >
          运行未完成项
        </button>
        {path === "/search/batches" ? (
          <>
            <button
              className="button"
              onClick={() => void run(`${path}/${id}/import`)}
            >
              导入为联系人
            </button>
            <button
              className="button"
              onClick={() => void run(`${path}/${id}/continue`)}
            >
              继续下一页
            </button>
          </>
        ) : (
          <button
            className="button"
            onClick={() => void run(`${path}/${id}/stop`)}
          >
            暂停
          </button>
        )}
        <button
          className="button"
          onClick={() =>
            csvDownload(
              path === "/search/batches"
                ? (data?.queries || []).flatMap((q: Row) => q.results || [])
                : (data?.items || []).map((r: Row) => ({
                    domain: r.domain,
                    ...parsed(r.result),
                  })),
              "research.csv",
            )
          }
        >
          导出
        </button>
        {path === "/prospecting" && (
          <button
            className="button"
            onClick={() =>
              void p.act(async () =>
                window.open(
                  (await api(`${path}/${id}/apollo-link`)).url,
                  "_blank",
                  "noopener,noreferrer",
                ),
              )
            }
          >
            在 Apollo 打开合格公司
          </button>
        )}
        <button className="button" onClick={p.reload}>
          刷新
        </button>
      </div>
      {path === "/search/batches" ? (
        (data?.queries || []).map((q: Row) => (
          <Panel key={q.id} title={`${q.query} · ${q.status}`}>
            <DataList
              items={q.results || []}
              columns={[
                ["name", "姓名"],
                ["headline", "职位"],
                ["public_profile_url", "主页"],
              ]}
            />
          </Panel>
        ))
      ) : (
        <DataList
          items={(data?.items || []).map((r: Row) => ({
            ...r,
            ...parsed(r.result),
          }))}
          columns={[
            ["domain", "域名"],
            ["status", "状态"],
            ["company", "公司"],
            ["qualified", "符合条件"],
            ["reason", "依据"],
            ["parentCompany", "母公司"],
          ]}
          actions={(r) => (
            <button
              className="text-button"
              onClick={() => {
                const parentCompany = prompt(
                  "核实后的母公司名称",
                  r.parentCompany || "",
                );
                if (parentCompany !== null)
                  void run(`${path}/${id}/prospects/${r.id}`, "PATCH", {
                    parentCompany,
                  });
              }}
            >
              复核母公司
            </button>
          )}
        />
      )}
    </Dialog>
  );
}
export function CrmWorkspace(p: Props) {
  const [tab, setTab] = useState("actions"),
    [edit, setEdit] = useState<Row | null>(null),
    [create, setCreate] = useState("");
  const { data: taxonomy } = useData("/crm/categories", p.refresh),
    { data: seqs } = useData("/crm/sequences", p.refresh),
    { data: leads } = useData("/people?limit=1000", p.refresh),
    run = useMutation(p);
  const subs = (taxonomy?.items || []).flatMap((c: Row) => c.subcategories),
    people = (leads?.items || []).map((l: Row) => ({ id: l.id, name: l.name }));
  return (
    <>
      <Title
        title="每一条回复，都有下一步。"
        body="分类、复核与跟进序列。序列生成待审核草稿，发送后才推进下一步。"
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["actions", "待跟进"],
          ["taxonomy", "回复分类"],
          ["sequences", "跟进序列"],
          ["classifications", "分类复核"],
          ["exceptions", "身份待确认"],
          ["tasks", "待办"],
          ["receipts", "发送核对"],
        ]}
      />
      {tab === "actions" ? (
        <RemoteList
          {...p}
          path="/crm/actions"
          columns={[
            ["name", "联系人"],
            ["category", "分类"],
            ["sequence_name", "序列"],
            ["sequence_status", "状态"],
            ["next_run", "下一步"],
          ]}
          actions={(r) => (
            <>
              <button className="text-button" onClick={() => p.select?.(r.id)}>
                打开
              </button>
              <select
                aria-label="分配序列"
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    void run(`/crm/people/${r.id}/sequence`, "POST", {
                      sequence_id: e.target.value,
                    });
                }}
              >
                <option value="">分配序列…</option>
                {(seqs?.items || [])
                  .filter((s: Row) => s.published_version)
                  .map((s: Row) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              {["pause", "resume", "stop", "dnc"].map((a, i) => (
                <button
                  className="text-button"
                  key={a}
                  onClick={() =>
                    void run(`/crm/people/${r.id}/action`, "POST", {
                      action: a,
                    })
                  }
                >
                  {["暂停", "恢复", "停止", "勿扰"][i]}
                </button>
              ))}
              <button
                className="text-button"
                onClick={() => {
                  const until = prompt(
                    "稍后联系的日期，例如 2026-11-01T09:00:00+08:00",
                  );
                  if (until)
                    void run(`/crm/people/${r.id}/action`, "POST", {
                      action: "snooze",
                      until: new Date(until).toISOString(),
                    });
                }}
              >
                稍后
              </button>
            </>
          )}
        />
      ) : tab === "taxonomy" ? (
        <>
          <button className="button" onClick={() => setCreate("category")}>
            添加子分类
          </button>
          <DataList
            items={subs}
            columns={[
              ["name", "子分类"],
              ["category", "类别"],
              ["description", "说明"],
            ]}
            actions={(s) => (
              <>
                <button
                  className="text-button"
                  onClick={() => setEdit({ kind: "category", ...s })}
                >
                  编辑
                </button>
                <select
                  aria-label="关联序列"
                  value={s.sequence_id || ""}
                  onChange={(e) =>
                    void run(`/crm/subcategories/${s.id}`, "PATCH", {
                      sequence_id: e.target.value || null,
                    })
                  }
                >
                  <option value="">不关联序列</option>
                  {(seqs?.items || []).map((x: Row) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <button
                  className="text-button"
                  onClick={() =>
                    void run(`/crm/subcategories/${s.id}`, "DELETE")
                  }
                >
                  删除
                </button>
              </>
            )}
          />
        </>
      ) : tab === "sequences" ? (
        <>
          <button className="button" onClick={() => setCreate("sequence")}>
            新建跟进序列
          </button>
          <DataList
            items={seqs?.items || []}
            columns={[
              ["name", "序列名称"],
              ["published_version", "已发布版本"],
            ]}
            actions={(s) => (
              <>
                <button
                  className="text-button"
                  onClick={() => setEdit({ kind: "sequence", ...s })}
                >
                  编辑
                </button>
                <button
                  className="text-button"
                  onClick={() => void run(`/crm/sequences/${s.id}/publish`)}
                >
                  发布版本
                </button>
                <button
                  className="text-button"
                  onClick={() => void run(`/crm/sequences/${s.id}`, "DELETE")}
                >
                  删除
                </button>
              </>
            )}
          />
        </>
      ) : tab === "classifications" ? (
        <RemoteList
          {...p}
          path="/crm/classifications"
          columns={[
            ["person_id", "联系人"],
            ["category", "分类"],
            ["reason", "原因"],
            ["confidence", "置信度"],
            ["decision", "应用决定"],
            ["acknowledged_at", "已确认"],
          ]}
          actions={(r) => (
            <>
              <button
                className="text-button"
                onClick={() =>
                  void run(`/crm/classifications/${r.id}/acknowledge`)
                }
              >
                确认
              </button>
              {!r.applied_at && !r.undone_at && (
                <button
                  className="text-button"
                  onClick={() => void run(`/crm/classifications/${r.id}/apply`)}
                >
                  采用分类
                </button>
              )}
              <button
                className="text-button"
                onClick={() => void run(`/crm/classifications/${r.id}/undo`)}
              >
                撤销
              </button>
            </>
          )}
        />
      ) : tab === "exceptions" ? (
        <RemoteList
          {...p}
          path="/crm/identity-exceptions"
          columns={[
            ["channel", "渠道"],
            ["external_id", "消息"],
            ["created_at", "时间"],
          ]}
          actions={(r) => (
            <>
              <select
                aria-label="匹配联系人"
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    void run(`/crm/identity-exceptions/${r.id}`, "PATCH", {
                      status: "resolved",
                      person_id: e.target.value,
                    });
                }}
              >
                <option value="">匹配联系人…</option>
                {people.map((x: Row) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <button
                className="text-button"
                onClick={() =>
                  void run(`/crm/identity-exceptions/${r.id}`, "PATCH", {
                    status: "ignored",
                  })
                }
              >
                忽略
              </button>
            </>
          )}
        />
      ) : tab === "tasks" ? (
        <>
          <button className="button" onClick={() => setCreate("task")}>
            新建待办
          </button>
          <RemoteList
            {...p}
            path="/tasks"
            columns={[
              ["title", "待办"],
              ["due_at", "截止时间"],
              ["status", "状态"],
            ]}
            actions={(r) => (
              <>
                <button
                  className="text-button"
                  onClick={() =>
                    void run(`/tasks/${r.id}`, "PATCH", {
                      status: r.status === "done" ? "open" : "done",
                    })
                  }
                >
                  {r.status === "done" ? "重开" : "完成"}
                </button>
                <button
                  className="text-button"
                  onClick={() => void run(`/tasks/${r.id}`, "DELETE")}
                >
                  删除
                </button>
              </>
            )}
          />
        </>
      ) : (
        <RemoteList
          {...p}
          path="/send-attempts"
          columns={[
            ["channel", "渠道"],
            ["status", "结果"],
            ["error", "详情"],
            ["created_at", "时间"],
          ]}
          actions={(r) =>
            r.status === "uncertain" ? (
              <>
                <button
                  className="text-button"
                  onClick={() => {
                    const eid = prompt("请先在服务商确认已发送，输入消息 ID");
                    if (eid)
                      void run(`/send-attempts/${r.id}/reconcile`, "POST", {
                        outcome: "sent",
                        external_id: eid,
                      });
                  }}
                >
                  确认已发送
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void run(`/send-attempts/${r.id}/reconcile`, "POST", {
                      outcome: "not_sent",
                    })
                  }
                >
                  确认未发送
                </button>
              </>
            ) : null
          }
        />
      )}
      {(create === "sequence" || edit?.kind === "sequence") && (
        <Dialog
          title="跟进序列"
          onClose={() => {
            setEdit(null);
            setCreate("");
          }}
        >
          <SequenceForm
            value={edit}
            save={async (b) => {
              if (
                await run(
                  `/crm/sequences${edit ? "/" + edit.id : ""}`,
                  edit ? "PATCH" : "POST",
                  b,
                )
              ) {
                setEdit(null);
                setCreate("");
              }
            }}
          />
        </Dialog>
      )}
      {(create === "category" || edit?.kind === "category") && (
        <Dialog
          title="回复子分类"
          onClose={() => {
            setCreate("");
            setEdit(null);
          }}
        >
          <Form
            fields={[
              {
                key: "category",
                label: "类别",
                options: categories,
                value: edit?.category,
              },
              { key: "name", label: "名称", required: true, value: edit?.name },
              {
                key: "description",
                label: "说明",
                type: "textarea",
                value: edit?.description,
              },
              {
                key: "guidance",
                label: "AI 分类规则",
                type: "textarea",
                value: edit?.guidance,
              },
            ]}
            submit={async (b) => {
              if (
                await run(
                  `/crm/subcategories${edit ? "/" + edit.id : ""}`,
                  edit ? "PATCH" : "POST",
                  b,
                )
              ) {
                setCreate("");
                setEdit(null);
              }
            }}
          />
        </Dialog>
      )}
      {create === "task" && (
        <Dialog title="新建待办" onClose={() => setCreate("")}>
          <Form
            fields={[
              { key: "title", label: "待办内容", required: true },
              {
                key: "person_id",
                label: "相关联系人",
                options: [{ id: "", name: "无关联" }, ...people],
              },
              { key: "due_at", label: "截止时间", type: "datetime-local" },
            ]}
            submit={async (b) => {
              if (await run("/tasks", "POST", b)) setCreate("");
            }}
          />
        </Dialog>
      )}
    </>
  );
}
function SequenceForm({
  value,
  save,
}: {
  value: Row | null;
  save: (b: Row) => Promise<any>;
}) {
  const [steps, setSteps] = useState<Row[]>(
    value?.steps || [
      { channel: "email", subject: "", body: "", delay_minutes: 0 },
    ],
  );
  return (
    <Form
      fields={[
        { key: "name", label: "序列名称", required: true, value: value?.name },
      ]}
      submit={(b) => save({ ...b, steps })}
    >
      {steps.map((s, i) => (
        <div className="compose-box" key={i}>
          <h4>第 {i + 1} 步</h4>
          <div className="form-grid">
            {[
              ["channel", "渠道"],
              ["delay_minutes", "等待分钟"],
              ["subject", "标题"],
              ["body", "正文"],
              ["prompt", "AI 起草要求（可选）"],
            ].map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                {key === "channel" ? (
                  <select
                    value={s[key]}
                    onChange={(e) =>
                      setSteps(
                        steps.map((x, j) =>
                          j === i ? { ...x, [key]: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    {channelOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : key === "body" || key === "prompt" ? (
                  <textarea
                    value={s[key] || ""}
                    onChange={(e) =>
                      setSteps(
                        steps.map((x, j) =>
                          j === i ? { ...x, [key]: e.target.value } : x,
                        ),
                      )
                    }
                  />
                ) : (
                  <input
                    type={key === "delay_minutes" ? "number" : "text"}
                    min="0"
                    value={s[key] || ""}
                    onChange={(e) =>
                      setSteps(
                        steps.map((x, j) =>
                          j === i ? { ...x, [key]: e.target.value } : x,
                        ),
                      )
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => setSteps(steps.filter((_, j) => j !== i))}
          >
            移除此步
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button"
        onClick={() =>
          setSteps([
            ...steps,
            { channel: "email", body: "", delay_minutes: 1440 },
          ])
        }
      >
        添加步骤
      </button>
    </Form>
  );
}
const callOutcomes = [
  ["no_answer", "无人接听"],
  ["busy", "忙线"],
  ["not_on_whatsapp", "未开通 WhatsApp"],
  ["wrong_number", "号码有误"],
  ["interested", "有意向"],
  ["meeting_booked", "已约会议"],
  ["callback", "稍后回电"],
  ["send_details", "发送资料"],
  ["not_interested", "暂无意向"],
  ["do_not_call", "不再联系"],
];
async function bridge(body: Row) {
  const requestId = crypto.randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", listen);
      reject(new Error("通话助手未响应。请安装或重新加载助手。"));
    }, 10000);
    function listen(e: MessageEvent) {
      if (
        e.source !== window ||
        e.origin !== location.origin ||
        e.data?.source !== "agentsdr-recorder" ||
        e.data?.requestId !== requestId
      )
        return;
      clearTimeout(timeout);
      window.removeEventListener("message", listen);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve();
    }
    window.addEventListener("message", listen);
    window.postMessage(
      { source: "agentsdr-app", requestId, ...body },
      location.origin,
    );
  });
}
export function Calling(p: Props) {
  const { data } = useData("/calling/campaigns", p.refresh),
    { data: calls } = useData("/calls", p.refresh),
    [campaign, setCampaign] = useState(""),
    [adding, setAdding] = useState(false),
    [current, setCurrent] = useState<Row | null>(null),
    [tab, setTab] = useState("campaigns"),
    run = useMutation(p);
  return (
    <>
      <Title
        title="好对话，从一通电话开始。"
        body="管理通话名单、记录结果、回听录音并查看转录。"
      >
        <a className="button" href="/downloads/call-recorder">
          <Download size={16} />
          下载通话助手
        </a>
      </Title>
      <p className="notice">
        通话使用 Chrome 116 及以上版本。解压助手，在 chrome://extensions
        开启开发者模式后加载文件夹，并登录 WhatsApp Web。
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["campaigns", "通话活动"],
          ["history", "通话历史"],
        ]}
      />
      {tab === "campaigns" ? (
        <>
          <button className="button primary" onClick={() => setAdding(true)}>
            创建通话活动
          </button>
          <DataList
            items={data?.items || []}
            columns={[
              ["name", "活动"],
              ["status", "状态"],
              ["leads", "联系人"],
              ["called", "已呼叫"],
            ]}
            onRow={(r) => setCampaign(r.id)}
            actions={(r) => (
              <>
                <button
                  className="text-button"
                  onClick={() => setCampaign(r.id)}
                >
                  打开名单
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void run(`/calling/campaigns/${r.id}`, "PATCH", {
                      status: r.status === "active" ? "paused" : "active",
                    })
                  }
                >
                  {r.status === "active" ? "暂停" : "启用"}
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void run(`/calling/campaigns/${r.id}`, "DELETE")
                  }
                >
                  删除
                </button>
              </>
            )}
          />
        </>
      ) : (
        <DataList
          items={calls?.calls || []}
          columns={[
            ["phone", "号码"],
            ["status", "状态"],
            ["disposition", "结果"],
            ["durationMs", "时长（毫秒）"],
            ["transcriptStatus", "转录"],
            ["createdAt", "时间"],
          ]}
          actions={(r) => (
            <>
              <button className="text-button" onClick={() => setCurrent(r)}>
                详情
              </button>
              {r.hasRecording && (
                <a
                  className="text-button"
                  href={`/api/calls/${r.id}/recording`}
                  target="_blank"
                  rel="noreferrer"
                >
                  回听
                </a>
              )}
              <button
                className="text-button"
                onClick={() => void run(`/calls/${r.id}/transcribe`)}
              >
                转录
              </button>
            </>
          )}
        />
      )}{" "}
      {adding && (
        <Dialog title="新建通话活动" onClose={() => setAdding(false)}>
          <Form
            fields={[
              { key: "name", label: "活动名称", required: true },
              { key: "description", label: "说明", type: "textarea" },
            ]}
            submit={async (b) => {
              if (await run("/calling/campaigns", "POST", b)) setAdding(false);
            }}
          />
        </Dialog>
      )}
      {campaign && (
        <CallCampaign {...p} id={campaign} onClose={() => setCampaign("")} />
      )}{" "}
      {current && (
        <Dialog title="通话详情" onClose={() => setCurrent(null)}>
          <CallDetail {...p} id={current.id} />
        </Dialog>
      )}
    </>
  );
}
function CallDetail({ id, ...p }: Props & { id: string }) {
  const { data } = useData(`/calls/${id}`, p.refresh),
    run = useMutation(p);
  return (
    <>
      {data && (
        <>
          <Badge value={data.status} />
          {data.hasRecording && (
            <audio controls src={`/api/calls/${id}/recording`} />
          )}
          <Form
            fields={[
              {
                key: "disposition",
                label: "通话结果",
                value: data.disposition,
                options: callOutcomes.map(([id, name]) => ({ id, name })),
              },
              {
                key: "followUpAt",
                label: "约定回访时间",
                type: "datetime-local",
              },
            ]}
            submit={(b) => run(`/calls/${id}`, "PATCH", b)}
          />
          <p>{data.transcript?.summary}</p>
          {(data.transcript?.utterances || []).map((u: Row, i: number) => (
            <p key={i}>
              <strong>
                {u.speaker === "rep"
                  ? "我方"
                  : u.speaker === "lead"
                    ? "客户"
                    : "发言"}{" "}
                · {u.startSeconds}s
              </strong>{" "}
              {u.text}
            </p>
          ))}
          {data.transcriptError && (
            <p className="form-error">{data.transcriptError}</p>
          )}
        </>
      )}
    </>
  );
}
function CallCampaign({
  id,
  onClose,
  ...p
}: Props & { id: string; onClose: () => void }) {
  const { data } = useData(`/calling/campaigns/${id}`, p.refresh),
    { data: leads } = useData("/people?limit=1000", p.refresh),
    [stage, setStage] = useState("to_call"),
    [active, setActive] = useState<Row | null>(null),
    [phase, setPhase] = useState(""),
    [contact, setContact] = useState<Row | null>(null),
    run = useMutation(p);
  useEffect(() => {
    function update(e: MessageEvent) {
      if (
        e.origin === location.origin &&
        e.source === window &&
        e.data?.source === "agentsdr-recorder" &&
        e.data?.callId === active?.id
      ) {
        setPhase(e.data.phase);
        p.reload();
      }
    }
    window.addEventListener("message", update);
    return () => window.removeEventListener("message", update);
  }, [active?.id]);
  const start = (r: Row) =>
    p.act(async () => {
      if (!document.documentElement.hasAttribute("data-agentsdr-recorder"))
        throw new Error("请先安装通话助手并刷新页面");
      const result = await api("/calls", "POST", {
        personId: r.person_id,
        campaignContactId: r.id,
      });
      try {
        await bridge({
          type: "call:start",
          callId: result.call.id,
          phone: result.call.phone,
          recorderToken: result.recorderToken,
          apiBase: location.origin,
          lead: result.lead,
          clickedAt: Date.now(),
        });
        setActive(result.call);
        setPhase("正在拨号");
      } catch (e) {
        await api(`/calls/${result.call.id}/cancel`, "POST", {});
        throw e;
      }
    });
  return (
    <Dialog title={data?.name || "通话活动"} onClose={onClose}>
      <div className="toolbar">
        <label className="button file-button">
          导入 CSV / Excel
          <input
            hidden
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void p.act(async () => {
                  const rows = await readRows(f);
                  await api(`/calling/campaigns/${id}/import`, "POST", {
                    rows,
                  });
                  p.reload();
                });
            }}
          />
        </label>
        <select
          aria-label="添加联系人"
          value=""
          onChange={(e) => {
            if (e.target.value)
              void run(`/calling/campaigns/${id}/contacts`, "POST", {
                people: [e.target.value],
              });
          }}
        >
          <option value="">从联系人添加…</option>
          {(leads?.items || [])
            .filter((l: Row) => l.phone && !l.dnc)
            .map((l: Row) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.phone}
              </option>
            ))}
        </select>
        <button className="button" onClick={p.reload}>
          刷新
        </button>
      </div>
      {active && (
        <div className="notice">
          <strong>
            {active.phone} · {phase}
          </strong>
          <button
            className="button danger"
            onClick={() =>
              void p.act(async () => {
                await bridge({ type: "call:end", callId: active.id });
                setPhase("正在挂断");
              })
            }
          >
            挂断
          </button>
          <button
            className="button"
            onClick={() => {
              setContact({ callId: active.id });
              setActive(null);
            }}
          >
            记录结果
          </button>
        </div>
      )}
      <Tabs
        value={stage}
        onChange={setStage}
        items={[
          ["to_call", "待呼叫"],
          ["follow_up", "待回访"],
          ["done", "已结束"],
        ]}
      />
      <DataList
        items={(data?.contacts || []).filter((r: Row) => r.stage === stage)}
        columns={[
          ["name", "姓名"],
          ["company", "公司"],
          ["phone", "号码"],
          ["call_status", "上次结果"],
          ["follow_up_at", "回访时间"],
        ]}
        onRow={setContact}
        actions={(r) => (
          <>
            <button
              className="button"
              disabled={!!r.dnc || !!active}
              onClick={() => void start(r)}
            >
              <Phone size={14} />
              呼叫
            </button>
            <button className="text-button" onClick={() => setContact(r)}>
              详情 / 结果
            </button>
            <button
              className="text-button"
              onClick={() =>
                void p.act(() =>
                  bridge({
                    type: "message:open",
                    phone: r.phone,
                    text: `Hi ${r.name.split(" ")[0]}, `,
                  }),
                )
              }
            >
              打开 WhatsApp
            </button>
          </>
        )}
      />
      {contact && (
        <div className="compose-box">
          <button className="text-button" onClick={() => setContact(null)}>
            收起详情
          </button>
          {contact.callId ? (
            <CallDetail {...p} id={contact.callId} />
          ) : (
            <>
              <Form
                fields={[
                  {
                    key: "callStatus",
                    label: "通话结果",
                    options: callOutcomes.map(([id, name]) => ({ id, name })),
                    value: contact.call_status,
                  },
                  {
                    key: "followUpAt",
                    label: "回访时间",
                    type: "datetime-local",
                  },
                  {
                    key: "notes",
                    label: "通话备注",
                    type: "textarea",
                    value: contact.notes,
                  },
                ]}
                submit={(b) =>
                  run(`/calling/contacts/${contact.id}`, "PATCH", b)
                }
              />
              <Form
                fields={[
                  { key: "name", label: "姓名", value: contact.name },
                  { key: "company", label: "公司", value: contact.company },
                  { key: "phone", label: "电话", value: contact.phone },
                  { key: "title", label: "职位", value: contact.title },
                ]}
                label="更新联系人"
                submit={(b) =>
                  run(`/calling/contacts/${contact.id}/person`, "PATCH", b)
                }
              />
              <label className="button file-button">
                上传照片
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void p.act(async () => {
                        const form = new FormData();
                        form.append("file", file);
                        await api(
                          `/calling/contacts/${contact.id}/photo`,
                          "POST",
                          form,
                        );
                        p.reload();
                      });
                  }}
                />
              </label>
              <button
                className="text-button"
                onClick={() => p.select?.(contact.person_id)}
              >
                查看消息与客户资料
              </button>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
export function Workspace(p: Props) {
  const [tab, setTab] = useState("providers"),
    [create, setCreate] = useState(""),
    [provider, setProvider] = useState("hunter"),
    [editing, setEditing] = useState<Row | null>(null);
  const { data: catalog } = useData("/provider-catalog", p.refresh),
    { data: providers } = useData("/provider-connections", p.refresh),
    { data: orgs } = useData("/organizations", p.refresh),
    { data: settings } = useData("/settings", p.refresh),
    { data: teams } = useData("/teams", p.refresh),
    { data: ai } = useData("/ai/settings", p.refresh),
    { data: models } = useData("/ai/models", p.refresh),
    { data: fields } = useData("/lead-fields", p.refresh),
    run = useMutation(p);
  const def = catalog?.items?.find((r: Row) => r.key === provider);
  return (
    <>
      <Title
        title="把工作台，调成团队的习惯。"
        body="数据服务、AI 模型、组织团队和自定义字段。"
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["providers", "数据服务"],
          ["ai", "AI 设置"],
          ["teams", "组织与团队"],
          ["fields", "联系人字段"],
          ["library", "文件夹与工作簿"],
          ["companies", "公司资料"],
          ["domains", "域名库"],
        ]}
      />
      {tab === "providers" ? (
        <>
          <Panel title="补全服务连接">
            <Form
              fields={[
                { key: "name", label: "连接名称", required: true },
                ...(def?.auth.fields || []).map((f: Row) => ({
                  key: f.key,
                  label: f.label,
                  type: f.inputType,
                  required: f.required,
                })),
              ]}
              label="验证并连接"
              submit={(b) =>
                run("/provider-connections", "POST", {
                  provider,
                  name: b.name,
                  credentials: Object.fromEntries(
                    Object.entries(b).filter(([k]) => k !== "name"),
                  ),
                })
              }
            >
              <label className="field">
                <span>服务商</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  {(catalog?.items || []).map((d: Row) => (
                    <option key={d.key} value={d.key}>
                      {d.name} ·{" "}
                      {d.actions.filter((a: Row) => a.implemented).length}{" "}
                      个动作
                    </option>
                  ))}
                </select>
              </label>
            </Form>
            <DataList
              items={providers?.items || []}
              columns={[
                ["name", "名称"],
                ["provider", "服务"],
                ["verified_at", "验证时间"],
              ]}
              actions={(r) => (
                <button
                  className="text-button"
                  onClick={() =>
                    void run(`/provider-connections/${r.id}`, "DELETE")
                  }
                >
                  移除
                </button>
              )}
            />
          </Panel>
          <Panel title="HTTP 私有凭据">
            <Form
              fields={[
                {
                  key: "key",
                  label: "名称",
                  required: true,
                  hint: "例如 GRID_HTTP_SECRET_CRM",
                },
                {
                  key: "value",
                  label: "请求授权值",
                  type: "password",
                  required: true,
                  hint: "例如 Bearer …",
                },
              ]}
              submit={(b) =>
                run(`/http-secrets/${encodeURIComponent(b.key)}`, "PUT", {
                  value: b.value,
                })
              }
            />
          </Panel>
        </>
      ) : tab === "ai" ? (
        <>
          <Panel title="模型与写作要求">
            {ai && (
              <Form
                key={JSON.stringify(ai)}
                fields={[
                  {
                    key: "defaultModel",
                    label: "默认模型",
                    value: ai.defaultModel,
                  },
                  {
                    key: "allowedModels",
                    label: "允许使用的模型，每行一个 ID",
                    type: "lines",
                    value: ai.allowedModels,
                  },
                  {
                    key: "provider",
                    label: "指定推理服务商（可选）",
                    value: ai.provider,
                  },
                  {
                    key: "transcriptionModel",
                    label: "音频转录模型（可选）",
                    value: ai.transcriptionModel,
                  },
                  {
                    key: "byokOnly",
                    label: "仅使用自有服务商密钥",
                    type: "checkbox",
                    value: ai.byokOnly !== false,
                  },
                  {
                    key: "instructions",
                    label: "产品事实与回复要求",
                    type: "textarea",
                    value: ai.instructions,
                  },
                ]}
                submit={(b) => run("/ai/settings", "PUT", b)}
              />
            )}
            <details>
              <summary>可用模型目录</summary>
              <DataList
                items={(models?.data || models?.items || []).slice(0, 300)}
                columns={[
                  ["id", "模型 ID"],
                  ["name", "名称"],
                ]}
              />
            </details>
          </Panel>
          <Panel title="数据表专用 AI 连接">
            <Form
              fields={[
                { key: "name", label: "连接名称", required: true },
                {
                  key: "api_key",
                  label: "OpenRouter API key",
                  type: "password",
                  required: true,
                },
                {
                  key: "management_key",
                  label: "OpenRouter management key（BYOK 模型发现）",
                  type: "password",
                },
              ]}
              submit={(b) => run("/ai/connections", "POST", b)}
            />
            <RemoteList
              {...p}
              path="/ai/connections"
              columns={[
                ["name", "名称"],
                ["verified_at", "验证时间"],
              ]}
              actions={(r) => (
                <button
                  className="text-button"
                  onClick={() => void run(`/ai/connections/${r.id}`, "DELETE")}
                >
                  移除
                </button>
              )}
            />
          </Panel>
          <ByokPanel {...p} />
          <CrmInstructionSettings {...p} />
          <Panel title="Google 登录">
            <Form
              fields={[
                { key: "client_id", label: "Google 客户端 ID", required: true },
                {
                  key: "client_secret",
                  label: "客户端密钥",
                  type: "password",
                  required: true,
                },
              ]}
              submit={(b) => run("/integrations/google-signin", "POST", b)}
            />
            <p className="muted">
              回调地址：{location.origin}
              /api/auth/callback/google。仅已加入组织或受邀的邮箱可以登录。
            </p>
          </Panel>
        </>
      ) : tab === "teams" ? (
        <>
          <Panel title="我的组织">
            <DataList
              items={orgs?.items || []}
              columns={[
                ["name", "组织"],
                ["role", "角色"],
              ]}
              actions={(r) => (
                <>
                  {orgs?.active !== r.id ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        void p.act(async () => {
                          await api(
                            `/organizations/${r.id}/switch`,
                            "POST",
                            {},
                          );
                          location.reload();
                        })
                      }
                    >
                      切换
                    </button>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() => setEditing({ ...r, kind: "organization" })}
                    >
                      修改名称与标识
                    </button>
                  )}
                </>
              )}
            />
            <Form
              fields={[
                { key: "name", label: "新组织名称", required: true },
                {
                  key: "slug",
                  label: "组织标识",
                  hint: "小写字母、数字或连字符",
                },
              ]}
              label="创建组织"
              submit={(b) => run("/organizations", "POST", b)}
            />
          </Panel>
          <Panel title="团队">
            <Form
              fields={[{ key: "name", label: "团队名称", required: true }]}
              label="创建团队"
              submit={(b) => run("/teams", "POST", b)}
            />
            <DataList
              items={teams?.items || []}
              columns={[["name", "团队"]]}
              actions={(t) => (
                <>
                  <button
                    className="text-button"
                    onClick={() => setEditing({ ...t, kind: "team" })}
                  >
                    管理成员
                  </button>
                  <button
                    className="text-button"
                    onClick={() => void run(`/teams/${t.id}`, "DELETE")}
                  >
                    删除
                  </button>
                </>
              )}
            />
          </Panel>
          <Panel title="组织成员">
            <DataList
              items={settings?.members || []}
              columns={[
                ["name", "姓名"],
                ["email", "邮箱"],
                ["role", "角色"],
              ]}
              actions={(u) => (
                <select
                  aria-label="成员角色"
                  value={u.role}
                  onChange={(e) =>
                    void run(`/members/${u.id}`, "PATCH", {
                      role: e.target.value,
                    })
                  }
                >
                  {["member", "admin", "owner"].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
            />
            <Form
              fields={[
                {
                  key: "email",
                  label: "邀请邮箱",
                  type: "email",
                  required: true,
                },
                {
                  key: "role",
                  label: "角色",
                  options: [
                    { id: "member", name: "成员" },
                    { id: "admin", name: "管理员" },
                  ],
                },
                {
                  key: "sendEmail",
                  label: "同时发送邀请邮件",
                  type: "checkbox",
                },
              ]}
              label="邀请成员"
              submit={async (b) => {
                await p.act(async () => {
                  const r = await api("/members/invite", "POST", b);
                  await navigator.clipboard.writeText(r.url);
                  p.reload();
                }, "邀请链接已复制");
              }}
            />
            <RemoteList
              {...p}
              path="/invitations"
              columns={[
                ["email", "待接受邀请"],
                ["role", "角色"],
                ["expires_at", "有效期"],
              ]}
              actions={(r) => (
                <button
                  className="text-button"
                  onClick={() => void run(`/invitations/${r.id}`, "DELETE")}
                >
                  撤销
                </button>
              )}
            />
          </Panel>
        </>
      ) : tab === "fields" ? (
        <>
          <Panel title="联系人自定义字段">
            <Form
              fields={[
                { key: "name", label: "字段名称", required: true },
                { key: "key", label: "字段标识", required: true },
                {
                  key: "type",
                  label: "类型",
                  options: [
                    "text",
                    "number",
                    "boolean",
                    "date",
                    "email",
                    "url",
                    "select",
                  ].map((id) => ({ id, name: id })),
                },
                {
                  key: "options",
                  label: "选项，每行一个（仅选择类型）",
                  type: "lines",
                },
              ]}
              label="添加字段"
              submit={(b) => run("/lead-fields", "POST", b)}
            />
            <DataList
              items={fields?.items || []}
              columns={[
                ["name", "字段"],
                ["key", "标识"],
                ["type", "类型"],
              ]}
              actions={(f) => (
                <>
                  <button
                    className="text-button"
                    onClick={() => setEditing({ ...f, kind: "field" })}
                  >
                    编辑
                  </button>
                  <button
                    className="text-button"
                    onClick={() => void run(`/lead-fields/${f.id}`, "DELETE")}
                  >
                    删除
                  </button>
                </>
              )}
            />
          </Panel>
        </>
      ) : tab === "library" ? (
        <Library {...p} />
      ) : tab === "domains" ? (
        <DomainCatalog {...p} />
      ) : (
        <CompanyList {...p} />
      )}{" "}
      {editing && (
        <Dialog title={editing.name} onClose={() => setEditing(null)}>
          {editing.kind === "team" ? (
            <TeamEditor
              team={editing}
              members={settings?.members || []}
              save={(b) => run(`/teams/${editing.id}`, "PATCH", b)}
            />
          ) : (
            <Form
              fields={
                editing.kind === "organization"
                  ? [
                      { key: "name", label: "组织名称", value: editing.name },
                      { key: "slug", label: "组织标识", value: editing.slug },
                      {
                        key: "logo",
                        label: "标志图片 URL",
                        value: editing.logo,
                      },
                    ]
                  : [
                      { key: "name", label: "字段名称", value: editing.name },
                      {
                        key: "type",
                        label: "字段类型",
                        value: editing.type,
                        options: [
                          "text",
                          "number",
                          "currency",
                          "boolean",
                          "date",
                          "email",
                          "url",
                          "image",
                          "select",
                          "multiselect",
                          "json",
                        ].map((id) => ({ id, name: id })),
                      },
                    ]
              }
              submit={async (b) => {
                if (editing.kind === "field" && b.type !== editing.type) {
                  const r = await api(
                    `/lead-fields/${editing.id}/type-preview?type=${b.type}`,
                  );
                  if (
                    r.incompatible &&
                    !window.confirm(
                      `有 ${r.incompatible} 个值无法转换，将清空。继续更改类型？`,
                    )
                  )
                    return;
                  b.acknowledge_incompatible = r.incompatible;
                }
                if (
                  await run(
                    editing.kind === "organization"
                      ? `/organizations/${editing.id}`
                      : `/lead-fields/${editing.id}`,
                    "PATCH",
                    b,
                  )
                )
                  setEditing(null);
              }}
            />
          )}
        </Dialog>
      )}
    </>
  );
}
function TeamEditor({
  team,
  members,
  save,
}: {
  team: Row;
  members: Row[];
  save: (b: Row) => Promise<any>;
}) {
  const [selected, setSelected] = useState<string[]>(
    team.members.map((m: Row) => m.id),
  );
  return (
    <Form
      fields={[{ key: "name", label: "团队名称", value: team.name }]}
      submit={(b) => save({ ...b, members: selected })}
    >
      {members.map((m) => (
        <label key={m.id} className="check-row">
          <input
            type="checkbox"
            checked={selected.includes(m.id)}
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [...selected, m.id]
                  : selected.filter((id) => id !== m.id),
              )
            }
          />
          {m.name} · {m.email}
        </label>
      ))}
    </Form>
  );
}
function Library(p: Props) {
  const { data: folders } = useData("/folders", p.refresh),
    { data: books } = useData("/workbooks", p.refresh),
    run = useMutation(p);
  return (
    <>
      <Panel title="文件夹">
        <Form
          fields={[
            { key: "name", label: "文件夹名称", required: true },
            {
              key: "parent_id",
              label: "上级文件夹",
              options: [{ id: "", name: "根目录" }, ...(folders?.items || [])],
            },
          ]}
          label="添加文件夹"
          submit={(b) => run("/folders", "POST", b)}
        />
        <DataList
          items={folders?.items || []}
          columns={[["name", "名称"]]}
          actions={(r) => (
            <>
              <button
                className="text-button"
                onClick={() => {
                  const name = prompt("名称", r.name);
                  if (name) void run(`/folders/${r.id}`, "PATCH", { name });
                }}
              >
                改名
              </button>
              <button
                className="text-button"
                onClick={() => void run(`/folders/${r.id}`, "DELETE")}
              >
                删除
              </button>
            </>
          )}
        />
      </Panel>
      <Panel title="工作簿">
        <Form
          fields={[
            { key: "name", label: "工作簿名称", required: true },
            {
              key: "folder_id",
              label: "所在文件夹",
              options: [{ id: "", name: "根目录" }, ...(folders?.items || [])],
            },
          ]}
          label="添加工作簿"
          submit={(b) => run("/workbooks", "POST", b)}
        />
        <DataList
          items={books?.items || []}
          columns={[["name", "名称"]]}
          actions={(r) => (
            <>
              <button
                className="text-button"
                onClick={() => {
                  const name = prompt("名称", r.name);
                  if (name) void run(`/workbooks/${r.id}`, "PATCH", { name });
                }}
              >
                改名
              </button>
              <button
                className="text-button"
                onClick={() => void run(`/workbooks/${r.id}`, "DELETE")}
              >
                删除
              </button>
            </>
          )}
        />
      </Panel>
    </>
  );
}
function CompanyList(p: Props) {
  const { data } = useData("/company-records", p.refresh),
    run = useMutation(p),
    [edit, setEdit] = useState<Row | null>(null);
  return (
    <Panel title="公司资料">
      <Form
        fields={[
          { key: "name", label: "名称", required: true },
          { key: "domain", label: "域名" },
          { key: "industry", label: "行业" },
          { key: "notes", label: "备注", type: "textarea" },
        ]}
        label="添加公司"
        submit={(b) => run("/company-records", "POST", b)}
      />
      <DataList
        items={data?.items || []}
        columns={[
          ["name", "公司"],
          ["domain", "域名"],
          ["industry", "行业"],
        ]}
        onRow={setEdit}
        actions={(r) => (
          <>
            <button className="text-button" onClick={() => setEdit(r)}>
              编辑
            </button>
            <button
              className="text-button"
              onClick={() => void run(`/company-records/${r.id}`, "DELETE")}
            >
              删除
            </button>
          </>
        )}
      />
      {edit && (
        <Dialog title="公司资料" onClose={() => setEdit(null)}>
          <Form
            fields={["name", "domain", "industry", "notes"].map((key, i) => ({
              key,
              label: ["名称", "域名", "行业", "备注"][i],
              value: edit[key],
            }))}
            submit={async (b) => {
              if (await run(`/company-records/${edit.id}`, "PATCH", b))
                setEdit(null);
            }}
          />
        </Dialog>
      )}
    </Panel>
  );
}
export function LeadExtras({ pid, ...p }: Props & { pid: string }) {
  const { data: fields } = useData("/lead-fields", p.refresh),
    { data: lead } = useData(`/people/${pid}`, p.refresh),
    { data: notes } = useData(`/notes?person_id=${pid}`, p.refresh),
    { data: taxonomy } = useData("/crm/categories", p.refresh),
    run = useMutation(p),
    custom = parsed(lead?.custom);
  return (
    <div className="extended-stack">
      <Panel title="回复分类与个人字段">
        <Form
          key={JSON.stringify(custom)}
          fields={(fields?.items || []).map((f: Row) => ({
            key: f.key,
            label: f.name,
            type:
              f.type === "boolean"
                ? "checkbox"
                : f.type === "number"
                  ? "number"
                  : f.type === "date"
                    ? "date"
                    : "text",
            value: custom[f.key],
            options:
              f.type === "select"
                ? parsed(f.options, []).map((x: string) => ({ id: x, name: x }))
                : undefined,
          }))}
          submit={(b) =>
            run(`/people/${pid}`, "PATCH", { custom: { ...custom, ...b } })
          }
        />
        <select
          aria-label="客户分类"
          value={lead?.subcategory_id || ""}
          onChange={(e) => {
            const sub = (taxonomy?.items || [])
              .flatMap((c: Row) => c.subcategories)
              .find((s: Row) => s.id === e.target.value);
            if (sub)
              void run(`/crm/people/${pid}/category`, "POST", {
                category: sub.category,
                subcategory_id: sub.id,
              });
          }}
        >
          <option value="">选择回复子分类…</option>
          {(taxonomy?.items || [])
            .flatMap((c: Row) => c.subcategories)
            .map((s: Row) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </Panel>
      <Panel title="团队笔记">
        <Form
          fields={[
            {
              key: "body",
              label: "添加笔记",
              type: "textarea",
              required: true,
            },
          ]}
          submit={(b) => run("/notes", "POST", { ...b, person_id: pid })}
        />
        {(notes?.items || []).map((n: Row) => (
          <div className="compose-box" key={n.id}>
            <p>{n.body}</p>
            <small>{date(n.created_at)}</small>
            <button
              className="text-button"
              onClick={() => {
                const body = prompt("修改笔记", n.body);
                if (body) void run(`/notes/${n.id}`, "PATCH", { body });
              }}
            >
              编辑
            </button>
            <button
              className="text-button"
              onClick={() => void run(`/notes/${n.id}`, "DELETE")}
            >
              删除
            </button>
          </div>
        ))}
      </Panel>
    </div>
  );
}
export function Recovery({ onDone }: { onDone: () => void }) {
  const reset = location.pathname === "/reset-password",
    [done, setDone] = useState(false);
  return (
    <div className="auth-page">
      <main className="auth-form">
        <div className="auth-form-inner">
          <h2>{reset ? "设置新密码" : "找回密码"}</h2>
          {done ? (
            <>
              <p>
                {reset
                  ? "密码已更新，请重新登录。"
                  : "如果该邮箱存在账户，你会收到重置链接。"}
              </p>
              <a className="button primary" href="/">
                返回登录
              </a>
            </>
          ) : (
            <Form
              fields={
                reset
                  ? [
                      {
                        key: "password",
                        label: "新密码（至少 12 位）",
                        type: "password",
                        required: true,
                      },
                    ]
                  : [
                      {
                        key: "email",
                        label: "账户邮箱",
                        type: "email",
                        required: true,
                      },
                    ]
              }
              label={reset ? "更新密码" : "发送重置链接"}
              submit={async (b) => {
                await api(
                  reset ? "/auth/reset-password" : "/auth/forgot-password",
                  "POST",
                  {
                    ...b,
                    token: new URLSearchParams(location.hash.slice(1)).get(
                      "token",
                    ),
                  },
                );
                history.replaceState({}, "", location.pathname);
                setDone(true);
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
export function CampaignExtras({ cid, ...p }: Props & { cid: string }) {
  const { data: c } = useData(`/campaigns/${cid}`, p.refresh),
    { data: accounts } = useData("/accounts", p.refresh),
    { data: leads } = useData("/people?limit=1000", p.refresh),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<Row | null>(null),
    [steps, setSteps] = useState(false),
    run = useMutation(p);
  useEffect(() => {
    if (c) setSelected(c.accounts || []);
  }, [c?.id, c?.accounts?.join(",")]);
  if (!c) return null;
  return (
    <Panel title="活动配置与预览">
      <Form
        fields={[
          { key: "name", label: "活动名称", value: c.name },
          {
            key: "daily_limit",
            label: "每日上限",
            type: "number",
            value: c.daily_limit,
          },
          ...(c.channel === "email"
            ? [
                {
                  key: "provider",
                  label: "邮件服务",
                  value: c.provider,
                  options: [
                    { id: "resend", name: "Resend" },
                    { id: "gmail", name: "Google Workspace" },
                  ],
                },
              ]
            : []),
        ]}
        submit={(b) =>
          run(`/campaigns/${cid}`, "PATCH", { ...b, accounts: selected })
        }
      >
        {(accounts?.items || [])
          .filter((a: Row) => a.channel === c.channel)
          .map((a: Row) => (
            <label className="check-row" key={a.id}>
              <input
                type="checkbox"
                checked={selected.includes(a.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, a.id]
                      : selected.filter((id) => id !== a.id),
                  )
                }
              />
              {a.name || a.address} · {a.status}
            </label>
          ))}
      </Form>
      <div className="toolbar">
        <button
          className="button"
          onClick={() => void run(`/campaigns/${cid}/duplicate`)}
        >
          复制为新活动
        </button>
        <button className="button" onClick={() => setSteps(!steps)}>
          编辑消息步骤
        </button>
        <button
          className="button"
          onClick={() =>
            void p.act(async () =>
              csvDownload(
                (await api(`/campaigns/${cid}/export`)).items,
                `${c.name}.csv`,
              ),
            )
          }
        >
          导出联系人状态
        </button>
        <select
          aria-label="选择预览联系人"
          value=""
          onChange={(e) => {
            if (e.target.value)
              void p.act(async () =>
                setPreview(
                  await api(`/campaigns/${cid}/preview`, "POST", {
                    person_id: e.target.value,
                  }),
                ),
              );
          }}
        >
          <option value="">按联系人预览…</option>
          {(leads?.items || []).map((l: Row) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      {preview && (
        <div className="compose-box">
          {preview.steps.map((s: Row) => (
            <div key={s.id}>
              <h4>{s.subject}</h4>
              <p className="preserve">{s.body}</p>
            </div>
          ))}
        </div>
      )}
      {steps && (
        <SequenceForm
          value={{ name: c.name, steps: c.steps }}
          save={(b) => run(`/campaigns/${cid}`, "PATCH", { steps: b.steps })}
        />
      )}
      <DataList
        items={c.enrollments || []}
        columns={[
          ["name", "联系人"],
          ["status", "状态"],
          ["gate", "等待条件"],
        ]}
        actions={(e) => (
          <button
            className="text-button"
            onClick={() =>
              void run(`/campaigns/${cid}/enrollments/${e.id}`, "PATCH", {
                status: e.status === "active" ? "stopped" : "active",
              })
            }
          >
            {e.status === "active" ? "停止跟进" : "重新加入"}
          </button>
        )}
      />
    </Panel>
  );
}
export function ExtendedAnalytics(p: Props) {
  const [view, setView] = useState("channels"),
    [from, setFrom] = useState(
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(new Date().toISOString().slice(0, 10)),
    { data, error } = useData(
      `/analytics/${view}?from=${encodeURIComponent(from + "T00:00:00.000Z")}&to=${encodeURIComponent(to + "T23:59:59.999Z")}`,
      p.refresh,
    );
  return (
    <Panel title="按渠道、活动与账号分析">
      <div className="toolbar">
        <input
          type="date"
          aria-label="开始日期"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          aria-label="结束日期"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button
          className="button"
          onClick={() => csvDownload(data?.items || [], "analytics.csv")}
        >
          导出
        </button>
      </div>
      <Tabs
        value={view}
        onChange={setView}
        items={[
          ["channels", "渠道"],
          ["accounts", "账号"],
          ["campaigns", "活动"],
          ["crm", "分类"],
          ["calling", "通话"],
        ]}
      />
      {error && <p>{error}</p>}
      <DataList
        items={data?.items || []}
        columns={
          view === "calling"
            ? [
                ["day", "日期"],
                ["status", "状态"],
                ["count", "通话数"],
              ]
            : view === "crm"
              ? [
                  ["category", "分类"],
                  ["count", "分类次数"],
                ]
              : [
                  ["dimension", "维度"],
                  ["sent", "服务商接受数"],
                  ["replies", "收到消息数"],
                  ["bounced", "退信数"],
                ]
        }
      />
      <p className="muted">
        时间范围按 UTC
        日期。发送统计以服务商接受为准；回复统计为保存的入站消息数，包含手动录入。同一人多条回复会分别计数。
      </p>
    </Panel>
  );
}
export function DomainCatalog(p: Props) {
  const [filters, setFilters] = useState<Row>({}),
    [picked, setPicked] = useState<string[]>([]),
    [create, setCreate] = useState(false),
    { data } = useData("/domains?" + new URLSearchParams(filters), p.refresh),
    run = useMutation(p);
  return (
    <Panel title="公司域名库">
      <p className="muted">
        导入你的公司数据后，可以按国家、类别、平台、使用的应用和收入筛选。上游仓库不包含域名数据集。
      </p>
      <label className="button file-button">
        导入域名 CSV / Excel
        <input
          hidden
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              void p.act(async () => {
                const rows = await readRows(f);
                for (let i = 0; i < rows.length; i += 1000)
                  await api("/domains/import", "POST", {
                    rows: rows.slice(i, i + 1000),
                  });
                p.reload();
              });
          }}
        />
      </label>
      <Form
        fields={[
          { key: "countryCode", label: "国家代码" },
          { key: "c1", label: "一级类别" },
          { key: "c2", label: "二级类别" },
          { key: "c3", label: "三级类别" },
          { key: "platform", label: "平台" },
          { key: "app", label: "使用的应用" },
          { key: "minRevenue", label: "最低收入", type: "number" },
          { key: "maxRevenue", label: "最高收入", type: "number" },
        ]}
        label="筛选"
        submit={async (b) => {
          setFilters(
            Object.fromEntries(Object.entries(b).filter(([, v]) => v)),
          );
          setPicked([]);
        }}
      />
      <p>符合条件 {data?.total || 0} 个域名；当前显示最多 100 个。</p>
      <DataList
        items={data?.items || []}
        columns={[
          ["domain", "域名"],
          ["country", "国家"],
          ["c1", "类别"],
          ["platform", "平台"],
          ["revenue", "收入"],
        ]}
        actions={(r) => (
          <input
            type="checkbox"
            aria-label={`选择 ${r.domain}`}
            checked={picked.includes(r.domain)}
            onChange={(e) =>
              setPicked(
                e.target.checked
                  ? [...picked, r.domain]
                  : picked.filter((d) => d !== r.domain),
              )
            }
          />
        )}
      />
      <button
        className="button"
        disabled={!picked.length}
        onClick={() => setCreate(true)}
      >
        对 {picked.length} 个域名创建资格筛选
      </button>
      {create && (
        <Dialog title="公司资格筛选" onClose={() => setCreate(false)}>
          <Form
            fields={[
              { key: "name", label: "活动名称", required: true },
              { key: "criteria", label: "附加研究标准", type: "textarea" },
              { key: "jobTitles", label: "目标职位，每行一个", type: "lines" },
              {
                key: "targetMode",
                label: "达到目标后停止",
                options: [
                  { id: "domains", name: "按合格域名数" },
                  { id: "leads", name: "按已验证邮箱人数" },
                ],
              },
              {
                key: "targetDomainCount",
                label: "合格域名目标",
                type: "number",
                value: 100,
              },
              {
                key: "targetLeadCount",
                label: "已验证人数目标",
                type: "number",
                value: 3000,
              },
              {
                key: "minVerifiedEmployees",
                label: "每个域名最低已验证人数",
                type: "number",
                value: 10,
              },
            ]}
            submit={async (b) => {
              if (
                await run("/prospecting", "POST", {
                  ...b,
                  mode: "qualification",
                  domains: picked,
                })
              )
                setCreate(false);
            }}
          />
          <p className="muted">
            需要先连接 Apollo master API key。筛选结果包含 Apollo
            实际人数；母公司未知时留待人工复核。
          </p>
        </Dialog>
      )}
      <RemoteList
        {...p}
        path="/parent-pending"
        columns={[
          ["domain", "待确认母公司"],
          ["campaign", "研究活动"],
        ]}
        actions={(r) => (
          <button
            className="text-button"
            onClick={() => {
              const parent_domain = prompt("核实后的母公司域名");
              if (parent_domain)
                void run(`/targeted-domains/${r.domain}/parent`, "PUT", {
                  parent_domain,
                });
            }}
          >
            填写母公司
          </button>
        )}
      />
    </Panel>
  );
}
function ByokPanel(p: Props) {
  const { data: connections } = useData("/ai/connections", p.refresh),
    { data: settings } = useData("/ai/byok/settings", p.refresh),
    [cid, setCid] = useState(""),
    [catalog, setCatalog] = useState<Row[]>([]),
    [enabled, setEnabled] = useState<string[]>([]),
    [defaultModel, setDefault] = useState(""),
    [transcriptionModel, setTranscription] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    run = useMutation(p);
  useEffect(() => {
    if (settings) {
      setCid(settings.connectionId || "");
      setEnabled(
        Object.entries(settings.modelsByProvider || {}).flatMap(
          ([provider, models]: [string, any]) =>
            models.map((model: string) => provider + "::" + model),
        ),
      );
      setDefault(
        settings.defaultModel
          ? settings.defaultModel.provider +
              "::" +
              settings.defaultModel.modelId
          : "",
      );
      setTranscription(
        settings.transcriptionModel
          ? settings.transcriptionModel.provider +
              "::" +
              settings.transcriptionModel.modelId
          : "",
      );
      setConfirmed(settings.byokOnlyConfirmed);
    }
  }, [settings?.connectionId]);
  const selection = (key: string) =>
    key ? { provider: key.split("::")[0], modelId: key.split("::")[1] } : null;
  return (
    <Panel title="OpenRouter BYOK 服务商与模型">
      <p className="muted">
        读取账号中已配置的服务商，选定模型后固定路由。未启用时使用工作台现有 AI
        配置。
      </p>
      <select
        aria-label="选择 BYOK 连接"
        value={cid}
        onChange={(e) => setCid(e.target.value)}
      >
        <option value="">选择连接</option>
        {(connections?.items || []).map((c: Row) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        className="button"
        disabled={!cid}
        onClick={() =>
          void p.act(async () =>
            setCatalog(
              (await api(`/ai/byok/catalog?connectionId=${cid}`)).providers,
            ),
          )
        }
      >
        发现服务商与模型
      </button>
      {catalog.map((provider) => (
        <details key={provider.slug}>
          <summary>
            {provider.name} · {provider.prioritizedCredentialCount} 个优先密钥
          </summary>
          {provider.models.map((m: Row) => {
            const key = provider.slug + "::" + m.id;
            return (
              <label className="check-row" key={key}>
                <input
                  type="checkbox"
                  checked={enabled.includes(key)}
                  onChange={(e) =>
                    setEnabled(
                      e.target.checked
                        ? [...enabled, key]
                        : enabled.filter((k) => k !== key),
                    )
                  }
                />
                {m.name} · {m.id} · {(m.outputModalities || []).join(", ")}
              </label>
            );
          })}
        </details>
      ))}
      <label className="field">
        <span>默认文字模型</span>
        <select
          value={defaultModel}
          onChange={(e) => setDefault(e.target.value)}
        >
          <option value="">选择默认模型</option>
          {enabled.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>通话转录模型（须支持音频输入）</span>
        <select
          value={transcriptionModel}
          onChange={(e) => setTranscription(e.target.value)}
        >
          <option value="">使用默认转录</option>
          {enabled.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已在 OpenRouter 将所选服务商设为仅使用自己的密钥、关闭共享容量回退
      </label>
      <button
        className="button primary"
        onClick={() => {
          const modelsByProvider: Row = {};
          for (const key of enabled) {
            const s = selection(key)!;
            (modelsByProvider[s.provider] ||= []).push(s.modelId);
          }
          void run("/ai/byok/settings", "PUT", {
            connectionId: cid,
            providers: Object.keys(modelsByProvider),
            modelsByProvider,
            defaultModel: selection(defaultModel),
            transcriptionModel: selection(transcriptionModel),
            byokOnlyConfirmed: confirmed,
          });
        }}
      >
        保存模型选择
      </button>
    </Panel>
  );
}
function CrmInstructionSettings(p: Props) {
  const { data } = useData("/crm/settings/ai-instructions", p.refresh),
    { data: policy } = useData("/crm/policy", p.refresh),
    run = useMutation(p);
  return (
    <>
      <Panel title="CRM 自动分类策略">
        {policy && (
          <Form
            key={JSON.stringify(policy)}
            fields={[
              {
                key: "autoApplyConfidence",
                label: "自动应用最低置信度（0 到 1）",
                type: "number",
                value: policy.autoApplyConfidence,
              },
              {
                key: "reviewOther",
                label: "其他分类需要人工复核",
                type: "checkbox",
                value: policy.reviewOther,
              },
              {
                key: "customerRequiresReview",
                label: "客户分类需要人工复核",
                type: "checkbox",
                value: policy.customerRequiresReview,
              },
            ]}
            submit={(b) => run("/crm/policy", "PUT", b)}
          />
        )}
      </Panel>
      {data &&
        ["draftInstructions", "classificationInstructions"].map(
          (purpose, i) => (
            <InstructionBlocks
              key={purpose + JSON.stringify(data[purpose])}
              title={i ? "AI 分类要求" : "AI 回复要求"}
              blocks={data[purpose] || []}
              save={(blocks) =>
                run("/crm/settings/ai-instructions", "PUT", {
                  [purpose]: blocks,
                })
              }
            />
          ),
        )}
    </>
  );
}
function InstructionBlocks({
  title,
  blocks,
  save,
}: {
  title: string;
  blocks: Row[];
  save: (b: Row[]) => Promise<any>;
}) {
  const [value, setValue] = useState(blocks);
  return (
    <Panel title={title}>
      {value.map((b, i) => (
        <div className="compose-box" key={b.id || i}>
          <input
            aria-label="要求标题"
            value={b.title}
            onChange={(e) =>
              setValue(
                value.map((r, j) =>
                  j === i ? { ...r, title: e.target.value } : r,
                ),
              )
            }
          />
          <textarea
            aria-label="要求内容"
            rows={3}
            value={b.content}
            onChange={(e) =>
              setValue(
                value.map((r, j) =>
                  j === i ? { ...r, content: e.target.value } : r,
                ),
              )
            }
          />
          <button
            className="text-button"
            onClick={() => setValue(value.filter((_, j) => j !== i))}
          >
            移除
          </button>
        </div>
      ))}
      <div className="toolbar">
        <button
          className="button"
          onClick={() =>
            setValue([
              ...value,
              { id: crypto.randomUUID(), title: "", content: "" },
            ])
          }
        >
          添加要求
        </button>
        <button className="button primary" onClick={() => void save(value)}>
          保存要求
        </button>
      </div>
    </Panel>
  );
}
