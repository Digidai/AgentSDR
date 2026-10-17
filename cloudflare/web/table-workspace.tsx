import React, { useEffect, useState } from "react";
import { api, useData, type Row, readRows, csvDownload } from "./lib";
import { Dialog, Panel, Form, DataList, type Action } from "./extended";
type Props = {
  tid: string;
  refresh: number;
  reload: () => void;
  act: Action;
  onClose: () => void;
};
const parse = (s: any, fallback: any = {}) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : (s ?? fallback);
  } catch {
    return fallback;
  }
};
const staticTypes = [
  "text",
  "number",
  "currency",
  "boolean",
  "date",
  "url",
  "email",
  "image",
  "select",
  "multiselect",
  "json",
];
export function AdvancedTable(p: Props) {
  const { data: t, error } = useData(`/tables/${p.tid}`, p.refresh),
    { data: catalog } = useData("/provider-catalog", p.refresh),
    { data: connections } = useData("/provider-connections", p.refresh),
    { data: runs } = useData(`/tables/${p.tid}/runs`, p.refresh),
    { data: books } = useData("/workbooks", p.refresh),
    { data: aiConnections } = useData("/ai/connections", p.refresh),
    [column, setColumn] = useState<Row | null>(null),
    [adding, setAdding] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [config, setConfig] = useState(false),
    [log, setLog] = useState(false),
    [filter, setFilter] = useState(""),
    [sort, setSort] = useState(""),
    [row, setRow] = useState<Row | null>(null);
  const run = (suffix: string, method = "POST", b: Row = {}) =>
    p
      .act(() => api(`/tables/${p.tid}${suffix}`, method, b), "已更新")
      .then((ok) => {
        if (ok) p.reload();
        return ok;
      });
  useEffect(() => {
    let active = true;
    api(`/tables/${p.tid}/selection`)
      .then((r) => {
        if (active) setSelected(r.ids || []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [p.tid]);
  useEffect(() => {
    if (t) {
      const view = parse(t.view);
      setFilter(view.filter || "");
      setSort(view.sort || "");
    }
  }, [t?.id]);
  if (!t)
    return (
      <Dialog title="数据表" onClose={p.onClose}>
        <p>{error || "正在加载…"}</p>
      </Dialog>
    );
  let rows = t.rows.filter((r: Row) =>
    JSON.stringify(r.cells).toLowerCase().includes(filter.toLowerCase()),
  );
  if (sort)
    rows = [...rows].sort((a: Row, b: Row) =>
      String(a.cells[sort] ?? "").localeCompare(
        String(b.cells[sort] ?? ""),
        undefined,
        { numeric: true },
      ),
    );
  return (
    <Dialog title={t.name} onClose={p.onClose}>
      <div className="toolbar">
        <button className="button" onClick={() => setAdding(!adding)}>
          添加行
        </button>
        <label className="button file-button">
          导入表格
          <input
            hidden
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void p.act(async () => {
                  const rows = await readRows(file);
                  for (let i = 0; i < rows.length; i += 500)
                    await api(`/tables/${t.id}/rows`, "POST", {
                      rows: rows.slice(i, i + 500),
                    });
                  p.reload();
                });
            }}
          />
        </label>
        <button
          className="button"
          onClick={() =>
            setColumn({ key: "", name: "", type: "text", config: {} })
          }
        >
          添加列
        </button>
        <button
          className="button primary"
          onClick={() =>
            void run("/run", "POST", {
              row_ids: selected.length ? selected : undefined,
            })
          }
        >
          {selected.length ? `运行 ${selected.length} 行` : "运行全部"}
        </button>
        <button className="button" onClick={() => void run("/stop")}>
          停止
        </button>
        <button className="button" onClick={p.reload}>
          刷新
        </button>
        <button
          className="button"
          onClick={() =>
            csvDownload(
              rows.map((r: Row) => r.cells),
              `${t.name}.csv`,
            )
          }
        >
          导出
        </button>
        <button
          className="button"
          onClick={() =>
            void p.act(
              () => api(`/tables/${t.id}/selection`, "PUT", { ids: selected }),
              "选择已保存",
            )
          }
        >
          保存选择
        </button>
        <button
          className="button"
          disabled={!selected.length}
          onClick={() => {
            const name = prompt("新活动名称");
            if (name)
              void p.act(async () => {
                await api(`/tables/${t.id}/campaigns`, "POST", {
                  name,
                  channel: "email",
                  row_ids: selected,
                  mapping: { name: "name", email: "email" },
                  steps: [{ subject: "Hello", body: "Hi {{first_name}}," }],
                });
                p.reload();
              }, "邮件活动草稿已创建，可到触达活动中编辑");
          }}
        >
          将所选行建为活动
        </button>
        <button className="button" onClick={() => setConfig(!config)}>
          表设置
        </button>
        <button className="button" onClick={() => setLog(!log)}>
          运行日志
        </button>
      </div>
      <div className="toolbar">
        <input
          aria-label="搜索数据行"
          placeholder="查找表格内容…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          aria-label="排序"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="">原始顺序</option>
          {t.columns.map((c: Row) => (
            <option value={c.key} key={c.key}>
              {c.name} 升序
            </option>
          ))}
        </select>
        <button
          className="text-button"
          onClick={() => void run("", "PATCH", { view: { filter, sort } })}
        >
          保存视图
        </button>
        {selected.length > 0 && (
          <button
            className="text-button danger"
            onClick={() =>
              void run("/rows", "DELETE", { ids: selected }).then((ok) => {
                if (ok) setSelected([]);
              })
            }
          >
            删除所选行
          </button>
        )}
      </div>
      {config && (
        <Panel title="表设置">
          <Form
            fields={[
              { key: "name", label: "表名称", value: t.name },
              {
                key: "workbook_id",
                label: "工作簿",
                value: t.workbook_id,
                options: [{ id: "", name: "无" }, ...(books?.items || [])],
              },
              {
                key: "auto_run",
                label: "新建和修改数据行后自动运行",
                type: "checkbox",
                value: t.auto_run,
              },
            ]}
            submit={(b) =>
              run("", "PATCH", { ...b, workbook_id: b.workbook_id || null })
            }
          />
          <div className="toolbar">
            <button className="button" onClick={() => void run("/duplicate")}>
              复制数据表
            </button>
            <button className="button" onClick={() => void run("/promote")}>
              导入联系人
            </button>
            <button
              className="button danger"
              onClick={() =>
                void run("", "DELETE").then((ok) => {
                  if (ok) p.onClose();
                })
              }
            >
              删除数据表
            </button>
          </div>
        </Panel>
      )}
      {adding && (
        <Form
          fields={t.columns
            .filter((c: Row) => staticTypes.includes(c.type))
            .map((c: Row) => ({
              key: c.key,
              label: c.name,
              type:
                c.type === "number"
                  ? "number"
                  : c.type === "boolean"
                    ? "checkbox"
                    : "text",
            }))}
          label="添加行"
          submit={async (b) => {
            if (await run("/rows", "POST", { rows: [b] })) setAdding(false);
          }}
        />
      )}
      <div className="table-scroll enrichment-table">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={
                    rows.length > 0 &&
                    rows.every((r: Row) => selected.includes(r.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? rows.map((r: Row) => r.id) : [],
                    )
                  }
                />
              </th>
              {t.columns.map((c: Row) => (
                <th key={c.key}>
                  <button className="text-button" onClick={() => setColumn(c)}>
                    {c.name} <small>{c.type}</small>
                  </button>
                </th>
              ))}
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: Row) => (
              <tr key={r.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label="选择数据行"
                    checked={selected.includes(r.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, r.id]
                          : selected.filter((id) => id !== r.id),
                      )
                    }
                  />
                  <button className="text-button" onClick={() => setRow(r)}>
                    编辑
                  </button>
                </td>
                {t.columns.map((c: Row) => (
                  <td key={c.key} title={r.cell_meta?.[c.key]?.error || ""}>
                    {typeof r.cells[c.key] === "string" &&
                      r.cells[c.key].startsWith("/api/files/") && (
                        <a
                          href={r.cells[c.key]}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            className="generated-thumbnail"
                            src={r.cells[c.key]}
                            alt="生成结果"
                          />
                        </a>
                      )}
                    <span
                      className={`cell-value cell-${r.cell_meta?.[c.key]?.status || "idle"}`}
                    >
                      {typeof r.cells[c.key] === "object"
                        ? JSON.stringify(r.cells[c.key])
                        : String(r.cells[c.key] ?? "")}
                    </span>
                    {r.cell_meta?.[c.key]?.status && (
                      <small className="cell-status">
                        {r.cell_meta[c.key].status}
                      </small>
                    )}
                  </td>
                ))}
                <td>
                  {r.status}
                  {r.error && <small className="form-error">{r.error}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {log && (
        <Panel title="单元格运行记录">
          <DataList
            items={runs?.items || []}
            columns={[
              ["column_key", "列"],
              ["status", "状态"],
              ["provider", "服务"],
              ["cost_cents", "费用（美分）"],
              ["error", "详情"],
            ]}
            actions={(r) => (
              <details>
                <summary>请求与结果</summary>
                <pre className="code-block">
                  {JSON.stringify(
                    {
                      value: parse(r.value, null),
                      outputs: parse(r.outputs),
                      audit: parse(r.audit),
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
          />
        </Panel>
      )}
      {row && (
        <Panel title="编辑数据行">
          <Form
            fields={t.columns
              .filter((c: Row) => staticTypes.includes(c.type))
              .map((c: Row) => ({
                key: c.key,
                label: c.name,
                type:
                  c.type === "number"
                    ? "number"
                    : c.type === "boolean"
                      ? "checkbox"
                      : c.type === "json"
                        ? "json"
                        : "text",
                value: row.cells[c.key],
              }))}
            submit={async (b) => {
              if (await run(`/rows/${row.id}`, "PATCH", { cells: b }))
                setRow(null);
            }}
          />
          <button className="text-button" onClick={() => setRow(null)}>
            取消
          </button>
        </Panel>
      )}
      {column && (
        <ColumnEditor
          key={column.key || "new"}
          column={column}
          columns={t.columns}
          catalog={catalog?.items || []}
          connections={connections?.items || []}
          aiConnections={aiConnections?.items || []}
          preview={(b) =>
            api(`/tables/${t.id}/formula-preview`, "POST", {
              ...b,
              row: t.rows[0]?.cells || {},
            })
          }
          generate={(b) => api(`/tables/${t.id}/formula-generate`, "POST", b)}
          save={async (b) => {
            const columns = t.columns.some((c: Row) => c.key === column.key)
              ? t.columns.map((c: Row) => (c.key === column.key ? b : c))
              : [...t.columns, b];
            if (await run("", "PATCH", { columns })) setColumn(null);
          }}
          close={() => setColumn(null)}
          remove={() =>
            void run("", "PATCH", {
              columns: t.columns.filter(
                (c: Row) =>
                  c.key !== column.key &&
                  c.config?.parentColumnKey !== column.key,
              ),
            }).then((ok) => {
              if (ok) setColumn(null);
            })
          }
          runColumn={() =>
            void run("/run", "POST", {
              column_keys: [column.key],
              row_ids: selected.length ? selected : undefined,
              force: true,
            })
          }
          dedupe={() => void run("/dedupe", "POST", { key: column.key })}
          split={(delimiter: string) =>
            run("/split", "POST", {
              key: column.key,
              separator: delimiter,
              outputs: [
                `${column.key}_1`,
                `${column.key}_2`,
                `${column.key}_3`,
              ],
            })
          }
        />
      )}
    </Dialog>
  );
}
function ColumnEditor({
  column,
  columns,
  catalog,
  connections,
  aiConnections,
  save,
  close,
  remove,
  runColumn,
  dedupe,
  split,
  preview,
  generate,
}: {
  column: Row;
  columns: Row[];
  catalog: Row[];
  connections: Row[];
  aiConnections: Row[];
  save: (c: Row) => Promise<any>;
  close: () => void;
  remove: () => void;
  runColumn: () => void;
  dedupe: () => void;
  split: (v: string) => Promise<any>;
  preview: (b: Row) => Promise<Row>;
  generate: (b: Row) => Promise<Row>;
}) {
  const cfg = { ...column, ...column.config },
    [type, setType] = useState(column.type),
    [provider, setProvider] = useState(cfg.integrationKey || "hunter"),
    [actionKey, setAction] = useState(cfg.actionKey || ""),
    [expression, setExpression] = useState(cfg.expression || ""),
    [result, setResult] = useState(""),
    [mapping, setMapping] = useState<Row>(cfg.inputs || {});
  const def = catalog.find((d) => d.key === provider),
    action =
      def?.actions.find((a: Row) => a.key === actionKey) ||
      def?.actions.find((a: Row) => a.implemented);
  return (
    <div className="column-editor compose-box">
      <div className="toolbar">
        <h3>{column.key ? "编辑列" : "添加列"}</h3>
        <button className="text-button" onClick={close}>
          收起
        </button>
      </div>
      <Form
        fields={[
          { key: "name", label: "列名称", required: true, value: column.name },
          {
            key: "key",
            label: "英文标识",
            required: true,
            value: column.key,
            hint: "字母开头，最多 50 字符；模板使用 {{标识}}",
          },
          ...(["ai", "http", "formula", "enrichment"].includes(type)
            ? [
                {
                  key: "runCondition",
                  label: "仅当条件成立时运行（可选）",
                  value: cfg.runCondition,
                  hint: "例如 {{email}} !== null",
                },
              ]
            : []),
          ...(type === "ai"
            ? [
                {
                  key: "useCase",
                  label: "AI 用途",
                  value: cfg.useCase || "text",
                  options: [
                    { id: "text", name: "生成文字" },
                    { id: "web-research", name: "网页研究" },
                    { id: "generate-image", name: "生成图片" },
                  ],
                },
                {
                  key: "upstreamProvider",
                  label: "指定 BYOK 服务商",
                  value: cfg.upstreamProvider,
                },
                {
                  key: "prompt",
                  label: "生成要求",
                  type: "textarea",
                  required: true,
                  value: cfg.prompt,
                },
                { key: "model", label: "模型（可选）", value: cfg.model },
                {
                  key: "connectionId",
                  label: "AI 连接",
                  value: cfg.connectionId,
                  options: [
                    { id: "", name: "使用工作台默认" },
                    ...aiConnections,
                  ],
                },
                {
                  key: "maxTokens",
                  label: "最多生成 token 数",
                  type: "number",
                  value: cfg.maxTokens || 1200,
                },
                {
                  key: "examples",
                  label: "示例（可选）",
                  type: "json",
                  value: cfg.examples || [],
                  hint: '[{"inputs":{"name":"Example"},"response":"…"}]',
                },
                {
                  key: "outputFormat",
                  label: "输出格式",
                  value: cfg.outputFormat || "fields",
                  options: [
                    { id: "fields", name: "字段或文字" },
                    { id: "json_schema", name: "自定义 JSON Schema" },
                  ],
                },
                {
                  key: "jsonSchema",
                  label: "自定义 JSON Schema（可选）",
                  type: "json",
                  value: cfg.jsonSchema || {},
                },
                {
                  key: "outputs",
                  label: "结构化输出（可选）",
                  type: "json",
                  value: cfg.outputs || [],
                  hint: '例如 [{"key":"summary","name":"摘要","type":"text"}]',
                },
              ]
            : type === "http"
              ? [
                  {
                    key: "url",
                    label: "请求 URL",
                    value: cfg.url,
                    required: true,
                  },
                  {
                    key: "method",
                    label: "方法",
                    value: cfg.method || "GET",
                    options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map(
                      (id) => ({ id, name: id }),
                    ),
                  },
                  {
                    key: "headers",
                    label: "请求头",
                    type: "json",
                    value: cfg.headers || {},
                  },
                  {
                    key: "body",
                    label: "请求正文",
                    type: "textarea",
                    value: cfg.body,
                  },
                  {
                    key: "responsePath",
                    label: "结果路径（可选）",
                    value: cfg.responsePath || cfg.path,
                  },
                  {
                    key: "authEnvVar",
                    label: "已保存凭据名称（可选）",
                    value: cfg.authEnvVar,
                  },
                ]
              : type === "enrichment"
                ? [
                    {
                      key: "connectionId",
                      label: "服务连接",
                      required: true,
                      value: cfg.connectionId,
                      options: [
                        { id: "", name: "选择已验证连接" },
                        ...connections.filter((c) => c.provider === provider),
                      ],
                    },
                  ]
                : []),
        ]}
        label="保存列"
        submit={async (b) => {
          const base = { ...b };
          delete base.name;
          delete base.key;
          await save({
            key: b.key,
            name: b.name,
            type,
            config: {
              ...cfg,
              ...base,
              ...(type === "formula" ? { expression } : {}),
              ...(type === "enrichment"
                ? {
                    integrationKey: provider,
                    actionKey: action?.key,
                    inputs: mapping,
                  }
                : {}),
            },
          });
        }}
      >
        <label className="field">
          <span>列类型</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {[
              ...staticTypes,
              "ai",
              "formula",
              "http",
              "enrichment",
              "integration_output",
              "ai_output",
            ].map((t) => (
              <option key={t} value={t}>
                {(
                  {
                    ai: "AI 生成",
                    formula: "公式",
                    http: "HTTP 请求",
                    enrichment: "服务商补全",
                  } as Row
                )[t] || t}
              </option>
            ))}
          </select>
        </label>
        {type === "formula" && (
          <>
            <label className="field">
              <span>公式表达式</span>
              <textarea
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                placeholder={"_.startCase({{name}})"}
                rows={4}
              />
              <small>
                支持 lodash、moment、FormulaJS 和 LOOKUP；输入通过{" "}
                {"{{column_key}}"} 引用。
              </small>
            </label>
            <div className="toolbar">
              <button
                className="button"
                type="button"
                onClick={() =>
                  void preview({ expression })
                    .then((r) => setResult(JSON.stringify(r)))
                    .catch((e) => setResult(e.message))
                }
              >
                预览第一行
              </button>
              <button
                className="button"
                type="button"
                onClick={() => {
                  const prompt = window.prompt("描述你希望计算的结果");
                  if (prompt)
                    void generate({ prompt })
                      .then((r) => setExpression(r.expression))
                      .catch((e) => setResult(e.message));
                }}
              >
                AI 编写公式
              </button>
            </div>
            {result && <pre className="code-block">{result}</pre>}
          </>
        )}
        {type === "enrichment" && (
          <>
            <label className="field">
              <span>补全服务</span>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setAction("");
                  setMapping({});
                }}
              >
                {catalog.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>动作</span>
              <select
                value={action?.key || ""}
                onChange={(e) => setAction(e.target.value)}
              >
                {def?.actions
                  .filter((a: Row) => a.implemented)
                  .map((a: Row) => (
                    <option key={a.key} value={a.key}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <p>{action?.description}</p>
            {action?.inputs
              .filter((i: Row) => !i.hidden)
              .map((i: Row) => (
                <label key={i.key} className="field">
                  <span>
                    {i.name}
                    {i.required ? " *" : ""}
                  </span>
                  <select
                    value={
                      mapping[i.key]?.source === "constant"
                        ? "__constant"
                        : mapping[i.key]?.columnKey || ""
                    }
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        [i.key]:
                          e.target.value === "__constant"
                            ? { source: "constant", value: "" }
                            : { source: "column", columnKey: e.target.value },
                      })
                    }
                  >
                    <option value="">选择输入列</option>
                    {columns.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.name}
                      </option>
                    ))}
                    <option value="__constant">固定值</option>
                  </select>
                  {mapping[i.key]?.source === "constant" && (
                    <input
                      value={mapping[i.key].value}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          [i.key]: {
                            source: "constant",
                            value:
                              i.valueType === "number"
                                ? Number(e.target.value)
                                : e.target.value,
                          },
                        })
                      }
                    />
                  )}
                  <small>{i.description}</small>
                </label>
              ))}
            <p className="muted">
              动作结果会自动添加到输出列。
              {action?.creditsPerRun
                ? `每次预计 ${action.creditsPerRun} 服务商额度。`
                : ""}
            </p>
          </>
        )}
        {column.key && (
          <div className="toolbar">
            <button type="button" className="button" onClick={runColumn}>
              运行此列
            </button>
            <button type="button" className="button" onClick={dedupe}>
              按此列去重
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                const d = prompt("分隔符", ",");
                if (d) void split(d);
              }}
            >
              拆分文本
            </button>
            <button type="button" className="button danger" onClick={remove}>
              删除列
            </button>
          </div>
        )}
      </Form>
    </div>
  );
}
