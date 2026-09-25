# Notion → 카카오워크 알림

노션에 새 글·새 댓글이 생기면 카카오워크로 알려주는 봇. GitHub Actions가 5분마다 실행하므로 PC가 꺼져 있어도 동작한다.

필요한 Secrets (Settings → Secrets and variables → Actions):

| 이름 | 값 |
|---|---|
| `NOTION_TOKEN` | 노션 통합(Integration) 토큰 |
| `KAKAOWORK_APP_KEY` | 카카오워크 봇 앱키 |
| `KAKAOWORK_CONVERSATION_IDS` | 알림 받을 채팅방 ID, 쉼표로 구분 |

수동 실행: Actions 탭 → "Notion → 카카오워크 알림" → Run workflow

## 대시보드 진행 여부 자동 이동 (`crm/status_sync.mjs`)

"업체 진행 대시보드"에서 팀원이 컨택 상태만 바꾸면 5분 안에 진행 여부를 맞춰 준다 (`.github/workflows/status-sync.yml`).

| 조건 | 진행 여부 |
|---|---|
| 컨택 상태가 정보요청 후 대기상태 이후 단계 + 진행 여부 시작 전 | → 상담 중 |
| 컨택함 (응답대기) + 진행 여부 상담 중 | → 시작 전 |
| 착수금 입금 확인 체크 + 진행 여부 계약 중 | → 진행 중 |

시험 실행: `node crm/status_sync.mjs --dry-run`
