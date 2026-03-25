# SocialListener — CLAUDE.md

## 프로젝트 개요

디스코드, 유튜브 등 각종 소셜 플랫폼에서 등록한 계정 또는 서버의 지표, 유저 댓글, 동향 등을 수집하고 AI로 분석하여 리포트를 발간하는 툴.

**현재 구현된 플랫폼:** Discord, Instagram, Facebook Group, Facebook Page, Naver Lounge, DCInside
**예정 플랫폼:** 인터넷 사이트 크롤링

---

## 기술 스택

| 분류 | 기술 |
|------|------|
| Backend | Firebase Functions v2 (Cloud Run), Node.js |
| Frontend | Firebase Hosting, Vanilla JS (단일 SPA) |
| DB | Firestore |
| AI | OpenRouter API |
| 이메일 | Gmail SMTP |
| 기타 | Google Sheets 연동 |

---

## 주요 지침

### 세션 시작
새 세션에서 첫 작업 전에는 반드시 `/start` 커맨드로 프로젝트 구조를 먼저 파악한 후 작업을 진행한다.

### 이메일 발송 금지
이메일 리포트 발송은 민감한 수신인이 지정되어 있으므로, 테스트 목적으로 임의 발송을 해서는 안 된다.
이메일 발송이 필요한 경우 사용자에게 이유를 설명하고 명시적인 승낙을 받은 후 진행한다.
해당 엔드포인트: `/report/trigger`, `/guilds/test-delivery`, `/instagram/email/trigger`, `/weekly-report/trigger`, `/facebook/email/trigger`, `/facebook/page/email/trigger`, `/naver/email/trigger`, `/report-presets/email/trigger`, `/dcinside/email/trigger`

### DCInside 수집 아키텍처
DCInside는 GCP IP(AS15169)를 차단하므로 Cloud Run에서 직접 수집이 불가능하다.
수집은 **Mac Mini(`judymoon.local`)에서 로컬 실행**하고, Cloud Run은 Firestore에 저장된 수집 데이터를 읽어 AI 분석·이메일 발송만 담당한다.

- **Mac Mini 수집 스크립트**: `functions/src/dcinsideLocalCollect.js`
- **수집 데이터 Firestore 경로**: `workspaces/{wsId}/dcinside_collected/{date}/galleries/{docId}`
- **Mac Mini crontab**: 매일 08:45 KST 자동 실행
  ```
  45 8 * * * cd /Users/judymoon/Desktop/신건호/SocialListener/functions && /Users/judymoon/.nvm/versions/node/v24.14.0/bin/node src/dcinsideLocalCollect.js >> /Users/judymoon/dc-collect.log 2>&1
  ```
  - nvm 환경을 cron이 못 불러오므로 node 절대 경로 필수
  - 수집 로그: `/Users/judymoon/dc-collect.log`
- **프로젝트 경로 (Mac Mini)**: `/Users/judymoon/Desktop/신건호/SocialListener/functions`

수집 관련 버그 수정 시 Mac Mini에서 `git pull` 후 재수집 테스트가 필요하다.

### 코드 작업 후 처리
- **규모가 큰 작업**: 완료 후 문법 확인 및 타입체크 실시 → Firebase 배포 진행
- **간단한 작업**: 배포 없이 마무리, 사용자에게 배포 여부를 물어본 후 답변에 따라 진행

### API 문서 조회
공식 API 문서 확인이 필요할 때는 context7 MCP를 사용하여 최신 문서를 조회한다.

### 진행 상황 설명 시 감정 표현
작업 중간중간 현재 진행 상황을 설명할 때, 문장 앞에 상태를 직관적으로 파악할 수 있도록 감정 표현을 붙인다.
정상/문제 여부를 빠르게 캐치할 수 있게 하는 것이 목적이므로, 고정된 표현을 반복하지 말고 상황과 문맥에 맞게 자연스럽게 표현한다.
예를 들어 예상치 못한 결과라면 놀람을, 우려했던 부분이 무사히 통과됐다면 안도감을, 깔끔하게 해결됐다면 산뜻함을 담는 식으로 감정의 결을 다양하게 활용한다.

---

## 파일 네이밍 규칙

새로 생성하는 모든 JS 파일은 아래 규칙을 따른다.

### 형식

**`{platform}{Feature}{Role}.js`** — camelCase 통일

- **platform**: 플랫폼 특정 파일은 항상 prefix 붙임 (`discord`, `instagram`, `youtube` …)
- **Feature**: 기능/주제 (생략 가능)
- **Role**: 아래 표의 suffix 중 하나로 반드시 마침

### 역할별 suffix

| suffix | 역할 | 예시 |
|--------|------|------|
| `Pipeline` | 수집 → 분석 → 저장 → 발송을 조율하는 E2E 오케스트레이터 | `discordDailyPipeline.js`, `instagramDailyPipeline.js` |
| `Collector` | 외부 플랫폼 API 호출 및 원시 데이터 반환 | `discordCollector.js`, `instagramCollector.js` |
| `Analyzer` | AI/처리 분석 로직 | `openrouterAnalyzer.js` |
| `Delivery` | 이메일·Sheets 등 최종 출력 발송 | `reportDelivery.js` |
| `Core` | 여러 Collector가 공유하는 factory/공통 기반 | `instagramCollectorCore.js` |
| `Utils` | 날짜·포맷 등 범용 헬퍼 | `dateUtils.js` |
| `index.js` | 진입점 — 변경 없음 | |

### 추가 규칙

- **camelCase 통일** — snake_case(`instagram_core.js`) 사용 금지
- **Collector는 `collectors/` 디렉토리에** — 파이프라인 루트에 수집 파일 두지 않음
- **플랫폼 특정 파일은 prefix 필수** — 특정 플랫폼에 종속된 파일에서 prefix 생략 금지 (`pipeline.js` ❌ → `discordDailyPipeline.js` ✅)
- **범용 유틸은 prefix 생략 가능** — 여러 플랫폼에서 공유하는 파일은 platform prefix 없이 `{Feature}{Role}.js` 형식 허용 (`reportEmailCore.js`, `reportPresetDelivery.js` 등)

---

## 프로젝트 구조

```
SocialListener/
├── functions/
│   ├── src/
│   │   ├── index.js                        # HTTP API 라우트 + Cloud Scheduler 트리거
│   │   ├── discordDailyPipeline.js         # Discord 일별 리포트 파이프라인
│   │   ├── discordAlertPipeline.js         # 2시간마다 증분 수집 + 키워드 알림
│   │   ├── discordWeeklyPipeline.js        # Discord 주간 리포트 파이프라인
│   │   ├── instagramDailyPipeline.js       # Instagram 수집/분석/이메일 파이프라인
│   │   ├── facebookGroupDailyPipeline.js   # Facebook 그룹 크롤링/분석 파이프라인 (Playwright)
│   │   ├── facebookPageDailyPipeline.js    # Facebook 페이지 Graph API 수집/분석 파이프라인
│   │   ├── naverLoungeDailyPipeline.js     # 네이버 라운지 수집/분석/저장 파이프라인
│   │   ├── dcinsideDailyPipeline.js        # DCInside Firestore 수집 데이터 읽기 → AI 분석 → 이메일
│   │   ├── dcinsideLocalCollect.js         # Mac Mini 전용 수집 스크립트 (GCP IP 차단 우회, git으로 관리)
│   │   ├── reportPresetDailyPipeline.js    # 리포트 프리셋 통합 이메일 파이프라인
│   │   ├── reportDelivery.js               # 플랫폼별 이메일(Gmail) + Google Sheets 발송
│   │   ├── reportEmailCore.js              # Gmail SMTP 공통 발송 유틸 (dispatchEmail)
│   │   ├── reportPresetDelivery.js         # 통합 프리셋 이메일 HTML 빌더 (sendUnifiedEmailReport)
│   │   ├── collectors/
│   │   │   ├── discordCollector.js         # Discord 메시지 수집 (증분 snowflake)
│   │   │   ├── discordInsightCollector.js  # Discord Guild Insights 수집
│   │   │   ├── instagramCollector.js       # Instagram (Facebook Graph API 방식)
│   │   │   ├── instagramDirectCollector.js # Instagram (Business Login 방식)
│   │   │   ├── instagramCollectorCore.js   # Instagram 공통 factory/기반
│   │   │   ├── facebookGroupCollector.js   # Playwright 기반 Facebook 그룹 크롤러
│   │   │   ├── facebookPageCollector.js    # Facebook Graph API v22.0 페이지 수집기
│   │   │   ├── naverLoungeCollector.js     # HTTP(Axios) 기반 네이버 라운지 수집기
│   │   │   └── dcinsideCollector.js        # cheerio 기반 DCInside HTML 스크래퍼
│   │   ├── analyzers/
│   │   │   └── openrouterAnalyzer.js       # OpenRouter AI 분석
│   │   └── utils/
│   │       └── dateUtils.js                # KST 날짜 헬퍼
│   └── .env                                # 환경변수 (커밋 금지)
└── hosting/
    └── public/
        ├── index.html            # SPA 대시보드
        ├── app.js
        └── app.css
```

---

## 배포 커맨드

```bash
# Functions + Hosting 함께 배포 (가장 일반적)
firebase deploy --only functions,hosting

# Functions만
firebase deploy --only functions

# Hosting만
firebase deploy --only hosting
```

> `functions/.env` 파일이 반드시 존재해야 functions 배포 가능.
> `node_modules` 없으면 `cd functions && npm install` 먼저 실행.

---

## 스케줄러

현재 Firebase Cloud Scheduler는 개별 작업별 cron을 직접 들고 있지 않고, **`schedulerDispatcher` 1개가 5분마다 실행**되며 Firestore 설정을 읽어 실제 due task만 실행한다.

- **실제 Cloud Scheduler job**: `schedulerDispatcher`
- **Dispatcher cron**: `*/5 * * * *`
- **설정 저장 위치**: `workspaces/ws_antigravity/settings/schedulers`
- **웹앱 관리 메뉴**: `리포트 설정 > 스케줄러 관리`
- **시간 제약**: 시각은 5분 단위만 허용
- **제외 대상**: Mac Mini `dcinsideLocalCollect.js` 로컬 cron (`45 8 * * *`, KST 08:45)

### 관리 대상 작업

| 작업 key | 기본 시각 (KST) | 설명 |
|----------|-----------------|------|
| `alertPipeline` | 매 2시간 / 00분 | Discord 증분 수집 + 키워드 알림 |
| `dailyPipeline` | 09:00 | Discord: collected_chunks → AI 분석 → 리포트 생성 |
| `insightCollector` | 09:30 | Discord Guild Insights 수집 → weekly_insights 저장 |
| `weeklyPipeline` | 월 10:00 | Discord 주간 리포트 생성 + 이메일 발송 |
| `instagramPipeline` | 09:00 | Instagram 수집/분석/이메일 |
| `facebookGroupPipeline` | 09:00 | Facebook 그룹 Playwright 수집/분석/이메일 |
| `facebookPagePipeline` | 09:05 | Facebook 페이지 Graph API 수집/분석/이메일 |
| `naverLoungePipeline` | 09:10 | 네이버 라운지 HTTP 수집/분석/이메일 |
| `dcinsidePipeline` | 09:00 | DCInside: dcinside_collected 읽기 → AI 분석 → 이메일 |
| `youtubePipeline` | 08:50 | YouTube 신규 업로드 수집/분석/이메일 |
| `presetPipeline` | 09:30 | 리포트 프리셋 통합 이메일 발송 |

---

## 커스텀 스킬

| 커맨드 | 설명 |
|--------|------|
| `/start` | 세션 시작 시 프로젝트 구조 전체 파악 |
| `/deploy` | Firebase 배포 실행 |
| `/check-report` | 특정 날짜 리포트 데이터 조회 |

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
