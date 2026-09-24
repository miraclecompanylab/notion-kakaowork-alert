# Notion → 카카오워크 알림

노션에 새 글·새 댓글이 생기면 카카오워크로 알려주는 봇. GitHub Actions가 5분마다 실행하므로 PC가 꺼져 있어도 동작한다.

필요한 Secrets (Settings → Secrets and variables → Actions):

| 이름 | 값 |
|---|---|
| `NOTION_TOKEN` | 노션 통합(Integration) 토큰 |
| `KAKAOWORK_APP_KEY` | 카카오워크 봇 앱키 |
| `KAKAOWORK_CONVERSATION_IDS` | 알림 받을 채팅방 ID, 쉼표로 구분 |

수동 실행: Actions 탭 → "Notion → 카카오워크 알림" → Run workflow
