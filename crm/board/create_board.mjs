// 고객용 정책자금 진행 현황판 생성 (REST 전용). 문구·아이콘·표지는 원본 현황판(MASTER)에서 복사한다.
import { AGENCIES, label } from "./agencies.mjs";
import { won } from "./won.mjs";
const T = process.env.NOTION_TOKEN;
const api = async (p, m = "GET", b, v = "2022-06-28") => { for (let i = 0; ; i++) { const r = await fetch("https://api.notion.com/v1/" + p, { method: m, headers: { Authorization: "Bearer " + T, "Content-Type": "application/json", "Notion-Version": v }, body: b ? JSON.stringify(b) : undefined }); if (r.status === 429 && i < 5) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; } const j = await r.json(); if (!r.ok) throw new Error(`${m} ${p} ${j.message}`); return j; } };
export const MASTER = "3e6180072a5d816fb117cd2d1ecc2c02"; // 원본 현황판 (문구·아이콘·표지를 복사해 온다)
let MASTER_NAME; // 원본 제목에서 읽는다 ("○○ 정책자금 진행 현황판")
const WIDTH = [["상품", 184], ["시도 이력", 132], ["진행 단계", 103], ["예정 시기", 110], ["비고", 284], ["승인 금액", 200]];
const STAGES = [["접수 예정", "gray"], ["접수 완료", "blue"], ["심사 중", "blue"], ["실사·면담", "purple"], ["일시 중단", "yellow"], ["예산 소진", "orange"], ["승인", "green"], ["부결", "red"]];
const months = (from, to) => { const out = []; let [y, m] = from; while (y < to[0] || (y === to[0] && m <= to[1])) { out.push(`${String(y).slice(2)}.${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } } return out; };
const upload = async (url, name) => {
  const buf = await (await fetch(url)).arrayBuffer(); const type = name.endsWith('.png') ? 'image/png' : 'image/webp';
  const f = await api('file_uploads', 'POST', { filename: name, content_type: type });
  const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(`https://api.notion.com/v1/file_uploads/${f.id}/send`, { method: 'POST', headers: { Authorization: 'Bearer ' + T, 'Notion-Version': '2022-06-28' }, body: fd });
  if (!r.ok) throw new Error('upload ' + (await r.text())); return f.id; };
const cleanRT = (rt, display) => rt.map((t) => ({ type: "text", text: { content: t.plain_text.replaceAll(MASTER_NAME, display), link: t.text?.link ?? null }, annotations: t.annotations }));
const copyBlock = async (b, display) => { const o = { type: b.type, [b.type]: { ...b[b.type] } }; if (o[b.type].rich_text) o[b.type].rich_text = cleanRT(b[b.type].rich_text, display); delete o[b.type].id; for (const k of Object.keys(o[b.type])) if (o[b.type][k] === null) delete o[b.type][k]; if (b.has_children) o[b.type].children = await Promise.all((await api(`blocks/${b.id}/children`)).results.map((c) => copyBlock(c, display))); return o; };

// rows: [{ org, product, stage, round, month, plan, amount, note }]  org = 기관 기본명(예: "신용보증기금")
export async function createBoard(companyPageId, display, rows) {
  let pageId;
  try { return await build(companyPageId, display, rows, (id) => (pageId = id)); }
  catch (e) { if (pageId) await api(`pages/${pageId}`, "PATCH", { archived: true }); throw e; }
}
async function build(companyPageId, display, rows, onPage) {
  const master = await api(`pages/${MASTER}`);
  MASTER_NAME = master.properties.title.title.map((t) => t.plain_text).join("").replace(" 정책자금 진행 현황판", "").trim();
  const [iconId, coverId] = [await upload(master.icon.file.url, "miracle_icon.png"), await upload(master.cover.file.url, "nyc_cover.webp")];
  const page = await api("pages", "POST", { parent: { page_id: companyPageId }, icon: { type: "file_upload", file_upload: { id: iconId } }, cover: { type: "file_upload", file_upload: { id: coverId } }, properties: { title: { title: [{ text: { content: `${display} 정책자금 진행 현황판` } }] } } });
  onPage(page.id);
  const mk = (await api(`blocks/${MASTER}/children?page_size=100`)).results.filter((b) => b.type !== "child_database");
  await api(`blocks/${page.id}/children`, "PATCH", { children: await Promise.all(mk.map((b) => copyBlock(b, display))) });
  const hist = [...Array.from({ length: 10 }, (_, i) => ({ name: `${i + 1}차 시도`, color: "yellow" })), ...months([2025, 1], [2029, 9]).map((n) => ({ name: n, color: { 25: "gray", 26: "blue", 27: "green", 28: "purple", 29: "orange" }[n.slice(0, 2)] }))];
  const db = await api("databases", "POST", { parent: { type: "page_id", page_id: page.id }, is_inline: true, title: [{ text: { content: "기관별 진행 현황" } }], properties: {
    상품: { title: {} }, 기관: { select: { options: AGENCIES.map(([b, , color]) => ({ name: label(b), color })) } },
    "진행 단계": { select: { options: STAGES.map(([name, color]) => ({ name, color })) } },
    "시도 이력": { multi_select: { options: hist } },
    "예정 시기": { select: { options: months([2026, 9], [2029, 9]).map((n) => ({ name: n, color: { 26: "blue", 27: "green", 28: "purple", 29: "orange" }[n.slice(0, 2)] })) } },
    비고: { rich_text: {} }, "승인 금액": { rich_text: {} }, "최종 업데이트": { last_edited_time: {} } } });
  await api(`blocks/${page.id}/children`, "PATCH", { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] });
  const P = db.properties; const dsId = (await api(`databases/${db.id}`, "GET", null, "2025-09-03")).data_sources[0].id;
  const defaults = (await api(`views?database_id=${db.id}`, "GET", null, "2026-03-11")).results;
  const tableProps = [...WIDTH.map(([n, w]) => ({ property_id: P[n].id, visible: true, width: w })), { property_id: P["기관"].id, visible: false }, { property_id: P["최종 업데이트"].id, visible: false }];
  await api("views", "POST", { database_id: db.id, data_source_id: dsId, name: "표 보기", type: "table", configuration: { type: "table", properties: tableProps, wrap_cells: true, group_by: { type: "select", property_id: P["기관"].id, sort: { type: "ascending" }, hide_empty_groups: true } } }, "2026-03-11");
  await api("views", "POST", { database_id: db.id, data_source_id: dsId, name: "카드 보기", type: "gallery", configuration: { type: "gallery", properties: ["상품", "기관", "시도 이력", "진행 단계", "예정 시기", "승인 금액", "비고"].map((n) => ({ property_id: P[n].id, visible: true })).concat([{ property_id: P["최종 업데이트"].id, visible: false }]) } }, "2026-03-11");
  for (const v of defaults) await api(`views/${v.id}`, "DELETE", null, "2026-03-11");
  for (const r of rows) await addRow(db.id, r);
  return { pageId: page.id, dbId: db.id };
}
export async function addRow(dbId, { org, product = "상품 검토 중", stage = "접수 예정", round, month, plan, amount, note }) {
  const props = { 상품: { title: [{ text: { content: product } }] }, 기관: { select: { name: label(org) } }, "진행 단계": { select: { name: stage } } };
  const hist = [round, month].filter(Boolean); if (hist.length) props["시도 이력"] = { multi_select: hist.map((name) => ({ name })) };
  if (plan) props["예정 시기"] = { select: { name: plan } };
  if (amount) props["승인 금액"] = { rich_text: [{ text: { content: typeof amount === "number" ? won(amount) : amount } }] };
  if (note) props["비고"] = { rich_text: [{ text: { content: note } }] };
  return api("pages", "POST", { parent: { database_id: dbId }, properties: props });
}
