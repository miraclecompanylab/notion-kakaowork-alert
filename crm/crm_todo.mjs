// 업체 진행 대시보드 → To Do List 자동 알림
// 대시보드의 상태·날짜를 읽어 "지금 해야 할 일"을 To Do List에 만들고, 카카오워크로 요약을 보낸다.
//   NOTION_TOKEN, KAKAOWORK_APP_KEY, KAKAOWORK_CONVERSATION_IDS  (GitHub Secrets)
// 옵션: --dry-run (노션에 쓰지 않고 할 일 목록만 출력), --no-kakao (카카오워크 발송 안 함),
//       --summary (새 할 일이 없어도 미완료 요약 발송 — 아침 실행용)
// 공개 저장소의 실행 로그는 누구나 볼 수 있으므로 업체명은 로그에 남기지 않는다(--dry-run 로컬 실행 제외).

import * as T from "./templates.mjs";

const DASHBOARD_DB = "168180072a5d80caa1a5e2a03afd3fff";
const TODO_DB = "1c8180072a5d81f393f6fb5e7bae3f31";
const AUTO_LABEL = "🤖 자동 알림";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const NO_KAKAO = args.has("--no-kakao") || DRY;
const SUMMARY = args.has("--summary");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const KAKAO_KEY = process.env.KAKAOWORK_APP_KEY;
const CONV_IDS = (process.env.KAKAOWORK_CONVERSATION_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!NOTION_TOKEN) {
  console.log("::error::NOTION_TOKEN이 설정되지 않았습니다.");
  process.exit(1);
}

// ---------- 날짜 (KST 기준 '며칠 지났나') ----------
const kstDate = (d) => new Date(new Date(d).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const TODAY = kstDate(Date.now());
const daysSince = (d) => (d ? Math.floor((Date.parse(TODAY) - Date.parse(kstDate(d))) / 86400e3) : null);

// ---------- Notion API ----------
async function notion(path, method = "GET", body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(`Notion ${method} ${path.split("/")[0]} → ${res.status} ${json.code}: ${json.message}`);
    return json;
  }
}

async function queryAll(dbId, filter) {
  const out = [];
  let cursor;
  do {
    const r = await notion(`databases/${dbId}/query`, "POST", { page_size: 100, filter, start_cursor: cursor });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ---------- 속성 읽기 ----------
const P = (page, name) => page.properties[name];
const text = (prop) => {
  const v = prop?.[prop?.type];
  return Array.isArray(v) ? v.map((t) => t.plain_text).join("") : "";
};
const statusName = (prop) => prop?.status?.name ?? prop?.select?.name ?? null;
const multi = (prop) => (prop?.multi_select || []).map((o) => o.name);
const dateStart = (prop) => prop?.date?.start ?? null;
const people = (prop) => (prop?.people || []).map((u) => u.id);

function readCompany(pg) {
  const ceo = text(P(pg, "대표자명")).replace(/\(.*?\)/g, "").trim();
  let name = text(P(pg, "회사명")).trim() || "(회사명 없음)";
  // "개인", "(예비 창업)"처럼 회사명만으로 구분이 안 되면 대표자명을 붙인다
  if (ceo && /^(개\s*인|\(?예비\s*창업(자)?\)?|ㅇㅇ|\(회사명 없음\))$/.test(name)) name = `${name}(${ceo})`;
  return {
    id: pg.id,
    url: pg.url,
    name,
    ceo,
    phone: P(pg, "전화번호")?.phone_number || "",
    status: statusName(P(pg, "진행 여부")), // 컨택 상태는 26.10 진행 여부로 합쳐졌다
    orgs: multi(P(pg, "진행 기관")),
    owners: people(P(pg, "소통 담당자")),
    created: pg.created_time,
    edited: pg.last_edited_time, // '최근 연락일' 칸이 없어져 마지막 수정 시각을 마지막 접점으로 본다
    contractDate: dateStart(P(pg, "계약일")),
    deposit: P(pg, "착수금 입금 확인")?.checkbox ?? false,
  };
}

// ---------- 페이지 본문 블록 ----------
const rt = (s) => [{ type: "text", text: { content: String(s).slice(0, 1900) } }];
const para = (s) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(s) } });
const h3 = (s) => ({ object: "block", type: "heading_3", heading_3: { rich_text: rt(s) } });
const todo = (s) => ({ object: "block", type: "to_do", to_do: { rich_text: rt(s), checked: false } });
const bullet = (s) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(s) } });
const callout = (s, emoji = "💡") => ({ object: "block", type: "callout", callout: { rich_text: rt(s), icon: { type: "emoji", emoji } } });
const code = (s) => ({ object: "block", type: "code", code: { rich_text: rt(s), language: "plain text" } });
const mention = (pageId, label) => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: {
    rich_text: [{ type: "mention", mention: { page: { id: pageId } } }, ...(label ? rt(` — ${label}`) : [])],
  },
});
const draft = (s) => [h3("📱 고객 안내 메시지 초안 (복사해서 사용)"), code(s)];
const doneNote = callout("처리 후 대시보드의 '진행 여부'를 맞게 바꾸고, 이 할 일의 상태를 '완료'로 바꿔 주세요.", "✅");

function missingInfo(c) {
  const miss = [];
  if (!c.ceo) miss.push("대표자명");
  if (!c.phone) miss.push("전화번호");
  return miss;
}

// ---------- 규칙 ----------
// 업체별 규칙: 조건이 맞으면 { code, title, body, cooldown(완료 후 다시 만들기까지 일수) }
const ACTIVE = ["진행 중", "계약 중"];
const RECENT_CONTRACT = 183; // 계약일이 이보다 오래된 예전 업체는 정체 알림에서 뺀다

function companyRules(c) {
  const out = [];
  const d = daysSince(c.edited);

  // 1. 브리핑 작성
  if (c.status === "인터뷰 완료 및 피드백 필요") {
    const miss = missingInfo(c);
    out.push({
      code: `BRIEF:${c.id}`,
      title: `📄 ${c.name} — 자금진단 브리핑 작성·전달`,
      memo: "인터뷰 완료, 브리핑 필요",
      cooldown: 30,
      body: [
        callout("인터뷰가 끝난 업체입니다. 자금진단 브리핑 자료를 작성해서 전달해 주세요.", "📄"),
        ...(miss.length ? [para(`⚠️ 대시보드에 비어 있는 정보: ${miss.join(", ")}`)] : []),
        todo("브리핑 자료 작성 (회사명_자금진단_미라클기업연구소.docx)"),
        todo("고객에게 전달 후 '진행 여부' → 피드백 전달 완료"),
        ...draft(T.msgBriefDelivery(c)),
        doneNote,
      ],
    });
  }

  // 2. 브리핑 전달 후 진행 의사 확인
  if (["피드백 전달 완료", "피드백 완료"].includes(c.status) && d >= 3 && d <= 45) {
    out.push({
      code: `CLOSE:${c.id}`,
      title: `🤝 ${c.name} — 브리핑 후 진행 의사 확인`,
      memo: `마지막 수정 ${d}일 전`,
      cooldown: 7,
      body: [
        callout(`브리핑 전달 후 ${d}일이 지났습니다. 진행 의사를 확인할 시점입니다.`, "🤝"),
        todo("고객 연락 (카톡 또는 유선)"),
        todo("진행 의사 있으면 '진행 여부' → 계약 중"),
        todo("미진행이면 '진행 여부' → 진행 NO"),
        ...draft(T.msgAfterBrief(c)),
        doneNote,
      ],
    });
  }

  // 3. 계약 후 착수금 확인 (최근 90일 안에 등록된 업체만 — 예전 건까지 알림이 쏟아지지 않도록)
  if (c.status === "계약 중" && !c.deposit && d >= 1 && daysSince(c.created) <= 90) {
    out.push({
      code: `DEPOSIT:${c.id}`,
      title: `💰 ${c.name} — 착수금 입금 확인`,
      memo: "계약 중, 착수금 미확인",
      cooldown: 3,
      body: [
        callout("계약 중인데 '착수금 입금 확인'이 체크되어 있지 않습니다. 체크하면 진행 여부가 자동으로 '진행 중'이 됩니다.", "💰"),
        todo("입금 확인되면 대시보드 '착수금 입금 확인' 체크"),
        ...draft(T.msgDeposit(c)),
        doneNote,
      ],
    });
  }

  // 4. 진행 시작 직후 기관별 준비서류 안내 / 회신 확인 (계약일 14일 이내)
  if (c.status === "진행 중" && c.contractDate && daysSince(c.contractDate) <= 14) {
    for (const org of c.orgs.filter((o) => T.DOCS[o])) {
      out.push({
        code: `DOCS:${c.id}:${org}`,
        title: `📂 ${c.name} — ${org} 준비서류 안내`,
        followTitle: `📂 ${c.name} — ${org} 서류 회신 확인`,
        memo: `${org} 서류 준비`,
        cooldown: 5,
        body: [
          callout(`${org} 신청 준비 단계입니다. 아래 서류 목록을 고객에게 안내해 주세요. (상품·지역에 따라 추가 서류가 있을 수 있음)`, "📂"),
          h3(`${org} 기본 준비서류`),
          ...T.DOCS[org].map(todo),
          todo("받은 서류는 구글드라이브 업체 폴더에 올리기"),
          ...draft(T.msgDocs(c, org, T.DOCS[org])),
          doneNote,
        ],
        followBody: [
          callout(`${org} 서류 안내 후 5일이 지났습니다. 회신을 확인해 주세요.`, "📂"),
          todo("받은 서류 / 못 받은 서류 확인"),
          ...draft(T.msgDocsFollow(c, org)),
          doneNote,
        ],
      });
    }
  }

  return out.map((r) => ({ ...r, company: c }));
}

// 묶음 규칙: 여러 업체를 하나의 할 일로 모아서 보여 준다 (매 실행마다 목록 갱신)
function digestRules(companies) {
  const lists = { NEW_LEAD: [], NO_REPLY: [], INFO_WAIT: [], STALE: [] };
  for (const c of companies) {
    const d = daysSince(c.edited);
    if (c.status === "컨택 전") lists.NEW_LEAD.push([c, `${daysSince(c.created)}일 전 등록`]);
    if (c.status === "컨택함(응답대기)" && d >= 3 && d <= 30) lists.NO_REPLY.push([c, `마지막 수정 ${d}일 전`]);
    if (c.status === "정보요청 후 대기상태" && d >= 3) lists.INFO_WAIT.push([c, `요청 후 ${d}일`]);
    const old = c.contractDate && daysSince(c.contractDate) > RECENT_CONTRACT;
    if (ACTIVE.includes(c.status) && !old && d >= 14) lists.STALE.push([c, `${d}일째 기록 없음`]);
  }
  const sample = { ceo: "○○○" };
  return [
    {
      code: "DIGEST:NEW_LEAD",
      title: (n) => `📥 신규 문의 — 첫 연락 필요 (${n}곳)`,
      items: lists.NEW_LEAD,
      head: [callout("새로 들어온 문의 중 아직 첫 연락을 하지 않은 업체입니다. 연락 후 '진행 여부'를 바꾸면 목록에서 빠집니다.", "📥")],
      tail: draft(T.msgFirstContact(sample)),
    },
    {
      code: "DIGEST:NO_REPLY",
      title: (n) => `🔁 응답대기 3일 이상 — 재컨택 (${n}곳)`,
      items: lists.NO_REPLY,
      head: [callout("연락했지만 3일 이상 답이 없는 업체입니다(30일 넘은 건 제외). 재컨택 후 업체 페이지에 댓글을 남기면 3일간 목록에서 빠집니다.", "🔁")],
      tail: draft(T.msgNoReply(sample)),
    },
    {
      code: "DIGEST:INFO_WAIT",
      title: (n) => `📨 자료 요청 후 회신대기 (${n}곳)`,
      items: lists.INFO_WAIT,
      head: [callout("자료를 요청했는데 3일 이상 회신이 없는 업체입니다.", "📨")],
      tail: draft(T.msgInfoWait(sample)),
    },
    {
      code: "DIGEST:STALE",
      title: (n) => `🕸️ 진행 중인데 2주 이상 기록 없는 업체 (${n}곳)`,
      items: lists.STALE,
      head: [
        callout(
          "'진행 중/계약 중'인데 14일 넘게 업데이트가 없는 업체입니다(계약 6개월 지난 예전 업체 제외). 현황판을 갱신하거나 '진행 여부'를 정리해 주세요.",
          "🕸️",
        ),
      ],
      tail: [],
    },
  ];
}

// ---------- To Do 쓰기 ----------
function todoProps({ title, code, memo, company, owners }) {
  const props = {
    이름: { title: rt(title) },
    구분: { select: { name: AUTO_LABEL } },
    "알림 코드": { rich_text: rt(code) },
    "상태 구분": { status: { name: "시작 전" } },
    마감일: { date: { start: TODAY } },
  };
  if (memo) props["메모"] = { rich_text: rt(memo) };
  if (company) props["관련 업체"] = { relation: [{ id: company.id }] };
  props["작성"] = { select: { name: "Claude" } }; // 자동 할 일은 담당자를 비우고 '작성'에 Claude로 표시한다(26.10)
  return props;
}

async function createTodo(item, blocks) {
  const page = await notion("pages", "POST", {
    parent: { database_id: TODO_DB },
    properties: todoProps(item),
    children: blocks.slice(0, 100),
  });
  for (let i = 100; i < blocks.length; i += 100)
    await notion(`blocks/${page.id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  return page;
}

async function replaceContent(pageId, blocks) {
  let cursor;
  const old = [];
  do {
    const r = await notion(`blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    old.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  for (const b of old) await notion(`blocks/${b.id}`, "DELETE");
  for (let i = 0; i < blocks.length; i += 100)
    await notion(`blocks/${pageId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
}

// ---------- 카카오워크 ----------
async function kakao(textMsg) {
  if (NO_KAKAO || !KAKAO_KEY || CONV_IDS.length === 0) return;
  for (const cid of CONV_IDS) {
    try {
      const res = await fetch("https://api.kakaowork.com/v1/messages.send", {
        method: "POST",
        headers: { Authorization: `Bearer ${KAKAO_KEY}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ conversation_id: cid, text: textMsg }),
      });
      const j = await res.json();
      if (!j.success) console.log(`카카오워크 발송 실패: ${j.error?.code}`);
    } catch (e) {
      console.log(`카카오워크 발송 오류: ${e.message}`);
    }
  }
}

// ---------- 실행 ----------
async function main() {
  console.log(`CRM 할 일 점검 시작 (${TODAY} KST${DRY ? ", 시험 실행" : ""})`);

  const pages = await queryAll(DASHBOARD_DB, {
    property: "진행 여부", status: { does_not_equal: "진행 NO" },
  });
  const companies = pages.map(readCompany);

  const existing = await queryAll(TODO_DB, { property: "구분", select: { equals: AUTO_LABEL } });
  const byCode = new Map();
  for (const t of existing) {
    const code = text(P(t, "알림 코드"));
    if (!code) continue;
    const rec = { id: t.id, url: t.url, done: statusName(P(t, "상태 구분")) === "완료", edited: t.last_edited_time };
    (byCode.get(code) || byCode.set(code, []).get(code)).push(rec);
  }

  const created = [];

  // 업체별 할 일
  for (const c of companies) {
    for (const r of companyRules(c)) {
      const prev = byCode.get(r.code) || [];
      if (prev.some((p) => !p.done)) continue; // 아직 처리 안 된 할 일이 있음
      const lastDone = prev.map((p) => p.edited).sort().pop();
      if (lastDone && daysSince(lastDone) < r.cooldown) continue; // 최근에 처리함
      const isFollow = prev.length > 0 && r.followTitle;
      const item = { title: isFollow ? r.followTitle : r.title, code: r.code, memo: r.memo, company: c, owners: c.owners };
      const blocks = [mention(c.id, "업체 페이지"), ...(isFollow ? r.followBody : r.body)];
      if (DRY) console.log(`  + ${item.title}`);
      else {
        const pg = await createTodo(item, blocks);
        created.push({ title: item.title, url: pg.url });
      }
    }
  }

  // 묶음 할 일 (열려 있으면 내용만 갱신)
  const digestStatus = [];
  for (const d of digestRules(companies)) {
    const open = (byCode.get(d.code) || []).find((p) => !p.done);
    const n = d.items.length;
    digestStatus.push({ title: d.title(n), n, url: open?.url });
    if (n === 0) continue;
    const blocks = [
      ...d.head,
      para(`${TODAY} 기준 · 매 실행마다 목록이 자동으로 갱신됩니다.`),
      ...d.items.slice(0, 80).map(([c, label]) => mention(c.id, label)),
      ...(n > 80 ? [para(`… 외 ${n - 80}곳`)] : []),
      ...d.tail,
    ];
    if (DRY) {
      console.log(`  ▣ ${d.title(n)}${open ? " (기존 항목 갱신)" : ""}`);
      continue;
    }
    if (open) {
      await notion(`pages/${open.id}`, "PATCH", { properties: { 이름: { title: rt(d.title(n)) }, 마감일: { date: { start: TODAY } } } });
      await replaceContent(open.id, blocks);
    } else {
      const pg = await createTodo({ title: d.title(n), code: d.code }, blocks);
      digestStatus.at(-1).url = pg.url;
      created.push({ title: d.title(n), url: pg.url });
    }
  }

  console.log(`점검 업체 ${companies.length}곳 · 새 할 일 ${created.length}건`);

  // 카카오워크 요약
  if (created.length || SUMMARY) {
    const openCount = existing.filter((t) => statusName(P(t, "상태 구분")) !== "완료").length + created.length;
    const lines = [`🤖 [CRM 알림] ${TODAY.slice(5).replace("-", "/")} 할 일`];
    if (created.length) {
      lines.push(`\n새로 생긴 할 일 ${created.length}건`);
      for (const c of created.slice(0, 15)) lines.push(`• ${c.title}\n  ${c.url}`);
      if (created.length > 15) lines.push(`… 외 ${created.length - 15}건`);
    }
    const digests = digestStatus.filter((d) => d.n > 0);
    if (SUMMARY && digests.length) {
      lines.push(`\n묶음 점검`);
      for (const d of digests) lines.push(`• ${d.title}`);
    }
    lines.push(`\n미완료 자동 할 일 총 ${openCount}건 → 노션 To Do List에서 '🤖 자동 알림'으로 확인해 주세요.`);
    await kakao(lines.join("\n"));
  }
}

main().catch((e) => {
  console.log(`::error::${e.message}`);
  process.exit(1);
});
