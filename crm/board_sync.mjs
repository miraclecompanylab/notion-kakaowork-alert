// 업체 진행 대시보드 → 고객용 정책자금 진행 현황판 자동 관리
//   진행 여부 = 진행 중 이고 컨택 상태 = 피드백 전달 완료 인데 현황판이 없으면  →  업체 페이지 안에 현황판 생성
//   현황판이 있으면 '진행 기관'에 체크된 기관마다 줄이 있는지 확인  →  없으면 "상품 검토 중 / 접수 예정" 줄 추가
//   체크가 풀린 기관은 손대지 않은 기본 줄만 지운다 (직원이 적은 내용은 그대로 둔다)
// 평소에는 최근 20분 안에 수정된 업체만 본다. 옵션: --all (전체 확인), --dry-run (바꿀 대상 수만 출력)
// 공개 저장소 로그라 업체명은 남기지 않는다.
import { createBoard, addRow } from "./board/create_board.mjs";
import { FROM_DASH, baseOf } from "./board/agencies.mjs";

const DASHBOARD_DB = "168180072a5d80caa1a5e2a03afd3fff";
const DRY = process.argv.includes("--dry-run");
const ALL = process.argv.includes("--all");
const DEFAULT_PRODUCT = "상품 검토 중";
const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.log("::error::NOTION_TOKEN이 설정되지 않았습니다.");
  process.exit(1);
}

async function notion(path, method = "GET", body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(`Notion ${method} → ${res.status} ${json.code}: ${json.message}`);
    return json;
  }
}

async function paginate(path, method, body = {}) {
  const out = [];
  let cursor;
  do {
    const r = method === "POST"
      ? await notion(path, "POST", { ...body, page_size: 100, start_cursor: cursor })
      : await notion(`${path}?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

const filter = { and: [{ property: "진행 여부", status: { equals: "진행 중" } }] };
if (!ALL) filter.and.push({ timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(Date.now() - 20 * 60 * 1000).toISOString() } });
const companies = await paginate(`databases/${DASHBOARD_DB}/query`, "POST", { filter });

const count = { created: 0, added: 0, removed: 0, skipped: 0 };
for (const c of companies) {
  const wanted = [...new Set(c.properties["진행 기관"].multi_select.map((o) => FROM_DASH[o.name]).filter(Boolean))];
  const board = (await paginate(`blocks/${c.id}/children`)).find((b) => b.type === "child_page" && b.child_page.title.includes("현황판"));

  if (!board) {
    if (c.properties["컨택 상태"].status?.name !== "피드백 전달 완료" || !wanted.length) { count.skipped++; continue; }
    const display = c.properties["회사명"].title.map((t) => t.plain_text).join("").trim();
    if (!DRY) await createBoard(c.id, display, wanted.map((org) => ({ org })).reverse());
    count.created++;
    continue;
  }

  const dbBlock = (await paginate(`blocks/${board.id}/children`)).find((b) => b.type === "child_database");
  if (!dbBlock) continue;
  const rows = await paginate(`databases/${dbBlock.id}/query`, "POST");
  const has = new Set(rows.map((r) => r.properties["기관"].select?.name).filter(Boolean).map(baseOf));
  for (const org of wanted.filter((o) => !has.has(o))) {
    if (!DRY) await addRow(dbBlock.id, { org });
    count.added++;
  }
  for (const r of rows) {
    const p = r.properties;
    const untouched = p["상품"].title.map((t) => t.plain_text).join("") === DEFAULT_PRODUCT && p["진행 단계"].select?.name === "접수 예정"
      && !p["시도 이력"].multi_select.length && !p["예정 시기"].select && !p["비고"].rich_text.length && !p["승인 금액"].rich_text.length;
    const org = p["기관"].select?.name && baseOf(p["기관"].select.name);
    if (untouched && org && !wanted.includes(org)) {
      if (!DRY) await notion(`pages/${r.id}`, "PATCH", { archived: true });
      count.removed++;
    }
  }
}
console.log(`현황판 확인 ${companies.length}곳${DRY ? " (시험 실행)" : ""} — 새로 만듦 ${count.created}, 기관 줄 추가 ${count.added}, 기본 줄 정리 ${count.removed}, 조건 미달 ${count.skipped}`);
