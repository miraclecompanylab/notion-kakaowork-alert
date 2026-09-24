# Notion -> Kakaowork 새 글/댓글 자동 알림 (GitHub Actions용)
# 노트북 버전(C:\Users\JJ\NotionKakaoAlert)을 옮긴 것. 비밀값은 전부 환경변수(GitHub Secrets)로 받는다.
#   NOTION_TOKEN            노션 통합 토큰
#   KAKAOWORK_APP_KEY       카카오워크 봇 앱키
#   KAKAOWORK_CONVERSATION_IDS  알림 받을 채팅방 ID, 쉼표로 구분
# 상태(마지막 확인 시각)는 state/last_check.txt 에 저장 → 워크플로가 캐시로 다음 실행에 넘겨준다.
# 공개 저장소의 실행 로그는 누구나 볼 수 있으므로 글 제목·댓글 내용은 로그에 남기지 않는다.

$ErrorActionPreference = "Stop"

$NotionToken = $env:NOTION_TOKEN
$KakaoAppKey = $env:KAKAOWORK_APP_KEY
$ConversationIds = ($env:KAKAOWORK_CONVERSATION_IDS -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }

if (-not $NotionToken -or -not $KakaoAppKey -or $ConversationIds.Count -eq 0) {
    Write-Host "::error::NOTION_TOKEN / KAKAOWORK_APP_KEY / KAKAOWORK_CONVERSATION_IDS Secrets가 설정되지 않았습니다."
    exit 1
}

# 카카오워크 키가 유효한지 먼저 확인 (새 글이 없으면 발송을 안 하니 키 오류를 모르고 지나칠 수 있음)
try {
    $kw = Invoke-RestMethod -Uri "https://api.kakaowork.com/v1/users.list?limit=1" -Headers @{ Authorization = "Bearer $KakaoAppKey" } -Method Get
    if ($kw.success -eq $false) {
        Write-Host "::error::카카오워크 키 확인 실패: $($kw.error.code) $($kw.error.message)"
        exit 1
    }
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -in 401, 403) {
        Write-Host "::error::카카오워크 앱키가 올바르지 않습니다 (HTTP $status)."
        exit 1
    }
    Write-Host "::warning::카카오워크 키 확인 중 오류 (계속 진행): $($_.Exception.Message)"
}

$StateDir  = Join-Path $PSScriptRoot "state"
$StateFile = Join-Path $StateDir "last_check.txt"
$SeedFile  = Join-Path $PSScriptRoot "seed_last_check.txt"

function Write-Log($msg) {
    Write-Host "$((Get-Date).ToUniversalTime().AddHours(9).ToString('yyyy-MM-dd HH:mm:ss')) KST - $msg"
}

function Invoke-JsonPost($Uri, $Headers, $BodyObj) {
    $json = $BodyObj | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Uri $Uri -Headers $Headers -Method Post -Body $bytes -ContentType "application/json; charset=utf-8"
}

# PowerShell 7은 JSON의 날짜 문자열을 DateTime으로 자동 변환하므로 둘 다 처리
function ConvertTo-UtcDate($v) {
    if ($v -is [datetime]) { return $v.ToUniversalTime() }
    return [datetime]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
}

function Get-TitleFromPage($page) {
    if ($null -eq $page.properties) { return "(제목 없음)" }
    $titleProp = $page.properties.PSObject.Properties | Where-Object { $_.Value.type -eq "title" } | Select-Object -First 1
    if ($null -eq $titleProp) { return "(제목 없음)" }
    $joined = ($titleProp.Value.title | ForEach-Object { $_.plain_text }) -join ""
    if ([string]::IsNullOrWhiteSpace($joined)) { return "(제목 없음)" }
    return $joined
}

$script:sendFailures = 0
function Send-KakaoAlert($text) {
    $headers = @{ Authorization = "Bearer $KakaoAppKey" }
    foreach ($cid in $ConversationIds) {
        try {
            Invoke-JsonPost -Uri "https://api.kakaowork.com/v1/messages.send" -Headers $headers -BodyObj @{
                conversation_id = $cid
                text = $text
            } | Out-Null
        } catch {
            $script:sendFailures++
            Write-Log "카카오워크 발송 실패 (방 $($ConversationIds.IndexOf($cid) + 1)번): $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 300
    }
}

# ---- 상태(마지막 확인 시각) 로드 ----
$nowIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

if (Test-Path $StateFile) {
    $lastCheck = (Get-Content $StateFile -Raw).Trim()
} elseif (Test-Path $SeedFile) {
    # 첫 실행: 노트북에서 마지막으로 확인한 시각부터 이어받는다 (그 사이 글 누락 방지)
    $lastCheck = (Get-Content $SeedFile -Raw).Trim()
    Write-Log "첫 실행 - 노트북 기준 시각에서 이어받음"
} else {
    Set-Content -Path $StateFile -Value $nowIso -NoNewline
    Write-Log "첫 실행 - 기준 시각 설정 (이번 실행에서는 알림 없음)"
    exit 0
}

Write-Log "실행 시작. 기준 시각=$lastCheck"
$lastCheckDt = ConvertTo-UtcDate $lastCheck

$notionHeaders = @{
    Authorization    = "Bearer $NotionToken"
    "Notion-Version" = "2022-06-28"
}

# ---- 1. 연결된 모든 페이지/DB 목록 (100개 넘으면 다음 페이지까지) ----
$allObjects = @()
$cursor = $null
do {
    $body = @{ page_size = 100 }
    if ($cursor) { $body.start_cursor = $cursor }
    $r = Invoke-JsonPost -Uri "https://api.notion.com/v1/search" -Headers $notionHeaders -BodyObj $body
    $allObjects += $r.results
    $cursor = if ($r.has_more) { $r.next_cursor } else { $null }
} while ($cursor)

$databases = $allObjects | Where-Object { $_.object -eq "database" }
$pages     = $allObjects | Where-Object { $_.object -eq "page" }

$dbTitleMap = @{}
foreach ($db in $databases) {
    $t = ($db.title | ForEach-Object { $_.plain_text }) -join ""
    if ([string]::IsNullOrWhiteSpace($t)) { $t = "(이름 없는 데이터베이스)" }
    $dbTitleMap[$db.id] = $t
}
$pageTitleMap = @{}
foreach ($p in $pages) { $pageTitleMap[$p.id] = Get-TitleFromPage $p }

$newItemCount = 0
$newCommentCount = 0

# ---- 2. 각 데이터베이스: 새로 생성된 항목(새 글) ----
foreach ($db in $databases) {
    try {
        $q = Invoke-JsonPost -Uri "https://api.notion.com/v1/databases/$($db.id)/query" -Headers $notionHeaders -BodyObj @{
            filter = @{
                timestamp    = "created_time"
                created_time = @{ after = $lastCheck }
            }
        }
        foreach ($item in $q.results) {
            $title = Get-TitleFromPage $item
            $dbName = $dbTitleMap[$db.id]
            Send-KakaoAlert "📝 [새 글] `"$dbName`"에 등록됨`n제목: $title`n$($item.url)"
            $newItemCount++
        }
    } catch {
        Write-Log "DB 조회 실패: $($_.Exception.Message)"
    }
    Start-Sleep -Milliseconds 150
}

# ---- 3. 각 페이지: 새 댓글 ----
foreach ($p in $pages) {
    try {
        $c = Invoke-RestMethod -Uri "https://api.notion.com/v1/comments?block_id=$($p.id)&page_size=50" -Headers $notionHeaders -Method Get
        foreach ($comment in $c.results) {
            if ((ConvertTo-UtcDate $comment.created_time) -gt $lastCheckDt) {
                $text = ($comment.rich_text | ForEach-Object { $_.plain_text }) -join ""
                $pageTitle = $pageTitleMap[$p.id]
                if ([string]::IsNullOrWhiteSpace($pageTitle)) { $pageTitle = "(제목 없음)" }
                Send-KakaoAlert "💬 [새 댓글] `"$pageTitle`" 페이지`n내용: $text`n$($p.url)"
                $newCommentCount++
            }
        }
    } catch {
        # 댓글 API 권한 없는 블록 등은 조용히 넘어감
    }
    Start-Sleep -Milliseconds 150
}

Write-Log "실행 완료. 페이지 $($pages.Count)개·DB $($databases.Count)개 확인, 새 글 $newItemCount 건, 새 댓글 $newCommentCount 건."

# ---- 4. 상태 업데이트 ----
Set-Content -Path $StateFile -Value $nowIso -NoNewline

if ($script:sendFailures -gt 0) {
    Write-Host "::warning::카카오워크 발송 실패 $($script:sendFailures)건"
}
