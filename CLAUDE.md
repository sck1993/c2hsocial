# SocialListener — CLAUDE.md

## 프로젝트 개요

디스코드, 유튜브 등 각종 소셜 플랫폼에서 등록한 계정 또는 서버의 지표, 유저 댓글, 동향 등을 수집하고 AI로 분석하여 리포트를 발간하는 툴.

**현재 구현된 플랫폼:** Discord, Instagram, Facebook Group
**예정 플랫폼:** YouTube, 인터넷 사이트 크롤링

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
해당 엔드포인트: `/report/trigger`, `/guilds/test-delivery`, `/instagram/email/trigger`, `/weekly-report/trigger`, `/facebook/email/trigger`

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
- **플랫폼 prefix 필수** — 플랫폼 특정 파일에서 prefix 생략 금지 (`pipeline.js` ❌ → `discordDailyPipeline.js` ✅)

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
│   │   ├── facebookGroupDailyPipeline.js   # Facebook 그룹 크롤링/분석 파이프라인
│   │   ├── reportDelivery.js               # 이메일(Gmail) + Google Sheets 발송
│   │   ├── collectors/
│   │   │   ├── discordCollector.js         # Discord 메시지 수집 (증분 snowflake)
│   │   │   ├── discordInsightCollector.js  # Discord Guild Insights 수집
│   │   │   ├── instagramCollector.js       # Instagram (Facebook Graph API 방식)
│   │   │   ├── instagramDirectCollector.js # Instagram (Business Login 방식)
│   │   │   ├── instagramCollectorCore.js   # Instagram 공통 factory/기반
│   │   │   └── facebookGroupCollector.js   # Playwright 기반 Facebook 그룹 크롤러
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

| 스케줄러 | Cron (UTC) | KST | 설명 |
|----------|-----------|-----|------|
| `alertPipeline` | `0 */2 * * *` | 매 2시간 | 증분 수집 + 키워드 알림 |
| `dailyPipeline` | `0 0 * * *` | 09:00 | Discord: collected_chunks → AI 분석 → 리포트 생성 |
| `insightCollector` | `30 0 * * *` | 09:30 | Discord Guild Insights 수집 → weekly_insights 저장 |
| `weeklyPipeline` | `0 1 * * 1` | 월 10:00 | Discord 주간 리포트 생성 + 이메일 발송 |
| `instagramPipeline` | `0 0 * * *` | 09:00 | Instagram 수집/분석/이메일 |

---

## 커스텀 스킬

| 커맨드 | 설명 |
|--------|------|
| `/start` | 세션 시작 시 프로젝트 구조 전체 파악 |
| `/deploy` | Firebase 배포 실행 |
| `/check-report` | 특정 날짜 리포트 데이터 조회 |
