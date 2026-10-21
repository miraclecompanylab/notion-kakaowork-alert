// 업체 진행 대시보드 — 상태 자동 이동
//   착수금 입금 확인 체크 이고 진행 여부 = 계약 중  →  진행 여부를 진행 중으로
//   진행 중이 된 업체(최근 20분 안에 수정)  →  계약일이 비었으면 오늘 날짜, 진행 기관이 비었으면 댓글에 나온 기관을 넣는다
// 컨택 상태는 진행 여부로 합쳐졌다(26.10). 다른 진행 여부(보류, 진행 NO 등)는 건드리지 않는다.
// 옵션: --dry-run (바꿀 대상 수만 출력). 공개 저장소 로그라 업체명은 남기지 않는다.

const DASHBOARD_DB = "168180072a5d80caa1a5e2a03afd3fff";
const DRY = process.argv.includes("--dry-run");
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

async function queryAll(filter) {
  const out = [];
  let cursor;
  do {
    const r = await notion(`databases/${DASHBOARD_DB}/query`, "POST", { page_size: 100, filter, start_cursor: cursor });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

const RULES = [
  {
    name: "착수금 입금 확인 → 진행 중",
    filter: {
      and: [
        { property: "착수금 입금 확인", checkbox: { equals: true } },
        { property: "진행 여부", status: { equals: "계약 중" } },
      ],
    },
    to: "진행 중",
  },
];

let total = 0;
for (const rule of RULES) {
  const pages = await queryAll(rule.filter);
  for (const pg of pages) {
    if (!DRY) await notion(`pages/${pg.id}`, "PATCH", { properties: { "진행 여부": { status: { name: rule.to } } } });
  }
  total += pages.length;
  console.log(`${rule.name}: ${pages.length}곳${DRY ? " (시험 실행)" : ""}`);
}
console.log(`상태 자동 이동 ${total}곳`);

// 댓글에 이 단어가 나오면 그 기관을 진행 기관에 넣는다 (진행 기관 선택지 이름 → 찾을 단어)
const AGENCY_WORDS = [
  ["신보", ["신보", "신용보증기금"]], ["기보", ["기보", "기술보증"]], ["재단", ["재단"]],
  ["중진공", ["중진공", "중소벤처기업진흥공단"]], ["소진공", ["소진공", "소상공인시장진흥공단"]],
  ["무보", ["무보", "무역보험"]], ["미소금융", ["미소금융"]], ["창업기업확인서", ["창업기업확인서"]],
];
const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const started = await queryAll({ and: [
  { property: "진행 여부", status: { equals: "진행 중" } },
  { timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(Date.now() - 20 * 60 * 1000).toISOString() } },
  { or: [{ property: "계약일", date: { is_empty: true } }, { property: "진행 기관", multi_select: { is_empty: true } }] },
] });
const filled = { date: 0, agency: 0 };
for (const pg of started) {
  const props = {};
  if (!pg.properties["계약일"].date) { props["계약일"] = { date: { start: todayKST } }; filled.date++; }
  if (!pg.properties["진행 기관"].multi_select.length) {
    const comments = (await notion(`comments?block_id=${pg.id}&page_size=100`)).results.map((c) => c.rich_text.map((t) => t.plain_text).join("")).join("\n");
    const found = AGENCY_WORDS.filter(([, words]) => words.some((w) => comments.includes(w))).map(([name]) => ({ name }));
    if (found.length) { props["진행 기관"] = { multi_select: found }; filled.agency++; }
  }
  if (!DRY && Object.keys(props).length) await notion(`pages/${pg.id}`, "PATCH", { properties: props });
}
console.log(`진행 중 시작 정보 채움 — 계약일 ${filled.date}곳, 진행 기관 ${filled.agency}곳${DRY ? " (시험 실행)" : ""}`);
