import { useEffect, useState } from "react";
import Papa from "papaparse";
export type Row = Record<string, any>;
export async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers:
      body instanceof FormData
        ? {}
        : body !== undefined
          ? { "Content-Type": "application/json" }
          : {},
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data = (await response
    .json()
    .catch(() => ({ error: "Unexpected response. Please try again." }))) as Row;
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
export function useData(path: string, refresh = 0) {
  const [result, setResult] = useState<{ path: string; data: Row } | null>(
      null,
    ),
    [failure, setFailure] = useState<{ path: string; message: string } | null>(
      null,
    );
  useEffect(() => {
    let active = true;
    setFailure(null);
    const pull = () =>
      api(path)
        .then((r) => {
          if (active) {
            setResult({ path, data: r });
            setFailure(null);
          }
        })
        .catch((e) => {
          if (active) setFailure({ path, message: e.message });
        });
    void pull();
    const timer =
      /^\/(?:tables\/|calling\/|calls|crm\/(?:actions|classifications)|jobs|inbox|search\/batches|prospecting)/.test(
        path,
      )
        ? setInterval(() => {
            if (document.visibilityState === "visible") void pull();
          }, 10000)
        : undefined;
    return () => {
      if (timer) clearInterval(timer);
      active = false;
    };
  }, [path, refresh]);
  return {
    data: result?.path === path ? result.data : null,
    error: failure?.path === path ? failure.message : "",
  };
}
export function csvDownload(items: Row[], name: string) {
  const data = Papa.unparse(items, { escapeFormulae: true });
  const url = URL.createObjectURL(
    new Blob(["\ufeff" + data], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export async function readRows(file: File): Promise<Row[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error("导入文件请小于 10 MB");
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await import("xlsx");
    const book = XLSX.read(await file.arrayBuffer());
    return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
      defval: "",
    });
  }
  const parsed = Papa.parse<Row>(await file.text(), {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.some((e) => e.type === "Quotes"))
    throw new Error("CSV 格式有误，请检查引号和分隔符");
  return parsed.data;
}
const aliases: Record<string, string> = {
  fullname: "name",
  firstname: "first_name",
  lastname: "last_name",
  姓名: "name",
  名字: "name",
  emailaddress: "email",
  邮箱: "email",
  电子邮箱: "email",
  companyname: "company",
  公司: "company",
  jobtitle: "title",
  职位: "title",
  phonenumber: "phone",
  电话号码: "phone",
  电话: "phone",
  linkedinurl: "linkedin",
  linkedinprofile: "linkedin",
  companywebsite: "website",
  网站: "website",
};
export function normalizeRows(rows: Row[]) {
  return rows.map((row) => {
    const result: Row = {};
    for (const [key, val] of Object.entries(row)) {
      const normalized = key
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, "");
      result[aliases[normalized] || normalized] = String(val ?? "").trim();
    }
    if (!result.name && result.first_name)
      result.name = `${result.first_name} ${result.last_name || ""}`.trim();
    if (!result.name) result.name = result.email || "";
    if (!result.name) throw new Error("每行需要 name / 姓名，或 email / 邮箱");
    result.custom = Object.fromEntries(
      Object.entries(result).filter(
        ([key]) =>
          ![
            "name",
            "email",
            "company",
            "title",
            "phone",
            "linkedin",
            "website",
            "stage",
            "notes",
          ].includes(key),
      ),
    );
    return result;
  });
}
export const stageNames: Record<string, string> = {
  new: "新线索",
  contacted: "已触达",
  interested: "有意向",
  meeting: "约谈中",
  customer: "已成交",
  lost: "已关闭",
};
export const stateNames: Record<string, string> = {
  draft: "草稿",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  pending: "待处理",
  queued: "排队中",
  running: "处理中",
  done: "已完成",
  failed: "失败",
  uncertain: "待核对",
  sent: "已发送",
  received: "已收到",
  ready: "待运行",
  replied: "已回复",
  stopped: "已停止",
  interested: "有意向",
  meeting_requested: "希望约谈",
  not_now: "以后联系",
  not_interested: "暂无意向",
  out_of_office: "自动回复",
  unsubscribe: "退订",
  needs_review: "待确认",
};
export const channelNames: Record<string, string> = {
  email: "邮件",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
};
export const date = (value: string) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
export function Badge({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`badge badge-${value}`}>
      {label || stateNames[value] || stageNames[value] || value}
    </span>
  );
}
