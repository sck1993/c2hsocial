# SocialListener — AGENTS.md

## 프로젝트 개요

디스코드, 인스타그램, 페이스북 등 각종 소셜 플랫폼에서 등록한 계정 또는 서버의 지표, 유저 댓글, 동향 등을 수집하고 AI로 분석하여 리포트를 발간하는 툴.

**현재 구현된 플랫폼:** Discord, Instagram, Facebook Group, Facebook Page, Naver Lounge, DCInside, YouTube
**예정 플랫폼:** 인터넷 사이트 크롤링

---

## 기술 스택

| 분류     | 기술                                       |
| -------- | ------------------------------------------ |
| Backend  | Firebase Functions v2 (Cloud Run), Node.js |
| Frontend | Firebase Hosting, Vanilla JS (단일 SPA)    |
| DB       | Firestore                                  |
| AI       | OpenRouter API                             |
| 이메일   | Gmail SMTP                                 |
| 기타     | Google Sheets 연동                         |

---

## 주요 지침

### 세션 시작

새 세션에서 첫 작업 전에는 먼저 프로젝트 루트 구조와 `functions/src`, `firebase.json`, 각 `package.json`을 훑어 현재 엔트리포인트와 배포 구성을 파악한 후 작업을 진행한다.

Codex 환경에서는 특정 슬래시 커맨드나 외부 플랫폼 전용 워크플로를 전제하지 않는다. 현재 세션에서 실제로 사용 가능한 도구와 권한 범위 안에서 먼저 확인하고 진행한다.

### 이메일 발송 금지

이메일 리포트 발송은 민감한 수신인이 지정되어 있으므로, 테스트 목적으로 임의 발송을 해서는 안 된다.
이메일 발송이 필요한 경우 사용자에게 이유를 설명하고 명시적인 승낙을 받은 후 진행한다.
해당 엔드포인트: `/report/trigger`, `/guilds/test-delivery`, `/instagram/email/trigger`, `/weekly-report/trigger`, `/facebook/email/trigger`, `/facebook/page/email/trigger`, `/naver/email/trigger`, `/report-presets/email/trigger`, `/dcinside/email/trigger`

### 운영 API 호출 주의

`/api/*` 엔드포인트 중 `POST`, `PATCH`, `DELETE`는 이메일 발송 여부와 무관하게 Firestore 데이터, 세션, 설정값, 리포트 상태를 실제로 변경할 수 있다.
운영 API 호출은 읽기 전용 조회가 아닌 이상 기본적으로 사용자 승인 후 진행한다.
특히 시드 생성, 세션 저장/삭제, 채널/길드 설정 변경, 프리셋 수정·삭제 계열은 테스트 목적이라도 임의 실행하지 않는다.

### 이메일 템플릿 구조

개별 플랫폼의 자체 이메일 디자인과 프리셋 통합 이메일 디자인은 **서로 독립적으로 유지**한다.
공용화는 SMTP 전송, HTML escape 같은 **비주얼 비의존 공통부까지만** 허용하고, 템플릿/섹션 렌더링은 섞지 않는다.

통합 프리셋 이메일을 수정할 때는 **프론트 프리뷰(`hosting/public/app.js`)와 실제 발송 렌더러(`functions/src/reportPresetDelivery.js`)가 서로 별개**라는 점을 항상 확인한다.
통합 리포트의 레이아웃, 섹션 메타, 링크 버튼, 칩 UI를 바꾸면 대개 두 파일을 함께 수정해야 하며, 배포도 `hosting`과 `functions`를 같이 보는 것을 기본으로 한다.

### 통합 프리셋 다국어 운영 메모

- 통합 프리셋 스키마는 `name`, `nameEn`, `recipientsKo`, `recipientsEn`, `deliveryConfig.email` 기준으로 운영한다. 기존 `recipients`는 한국어 수신자 fallback 용도다.
- 통합 프리셋 실제 발송은 `한국어 리포트`와 `영+한 리포트`로 분기된다. 영문 수신자는 상단 영문 리포트 뒤에 동일 날짜의 한국어 리포트가 이어붙는 합본 메일을 받는다.
- 프리셋 관리 화면 프리뷰는 아직 한국어 목업 기준이다. 영문 전용 프리뷰 토글은 없다.
- 영문 통합 메일의 히어로 제목 및 메일 제목은 `nameEn`을 우선 사용하고, 비어 있으면 `name`으로 fallback 한다.
- 영문 본문 데이터는 각 플랫폼 일일 파이프라인에서 생성된다. 과거 날짜 리포트에는 EN 필드가 없을 수 있으므로 통합 메일 렌더러에서 한국어 fallback이 섞일 수 있다.
- 통합 리포트 감정 막대는 현재 Discord, Naver Lounge, DCInside 섹션에만 들어간다. Facebook 그룹/페이지에는 아직 넣지 않았다.
- YouTube 요약 섹션은 현재 `[업로드 동향]`, `[반응 요약]` 2개만 사용한다. 예전 `[주요 채널]`이 남아 보이면 해당 날짜 YouTube 리포트를 재생성해야 한다.

### DCInside 수집 아키텍처

DCInside는 GCP IP(AS15169)를 차단하므로 Cloud Run에서 직접 수집이 불가능하다.
수집은 **Mac Mini(`judymoon.local`)에서 로컬 실행**하고, Cloud Run은 Firestore에 저장된 수집 데이터를 읽어 AI 분석·이메일 발송만 담당한다.

- **Mac Mini 수집 스크립트**: `functions/src/dcinsideLocalCollect.js`
- **수집 데이터 Firestore 경로**: `workspaces/{wsId}/dcinside_collected/{date}/galleries/{docId}`
- **Mac Mini crontab**: 매일 08:45 KST 자동 실행 (`45 8 * * *`)
- **프로젝트 경로 (Mac Mini)**: `/Users/judymoon/Desktop/신건호/SocialListener/functions`

수집 관련 버그 수정 시 이 저장소 수정만으로 검증이 끝나지 않을 수 있다. Mac Mini에서의 `git pull` 및 재수집 테스트는 사용자 승인과 실제 접근 가능 여부를 확인한 뒤 별도 후속 작업으로 진행한다.

### 코드 작업 후 처리

- **규모가 큰 작업**: 완료 후 `lint`, 문법 확인, 필요한 범위의 실행 검증을 실시한다. 배포는 자동으로 진행하지 않고, 사용자 요청 또는 명시적 승인 후에만 진행한다.
- **간단한 작업**: 배포 없이 마무리한다. 사용자가 원할 때만 배포 여부를 확인해 진행한다.

### lint 및 검증 규칙

- `functions/src` 또는 Functions가 참조하는 JS를 수정했으면 기본 검증으로 `functions/`에서 `npm run lint`를 실행한다.
- 현재 Functions lint는 `functions/.eslintrc.cjs` 기준으로 동작하므로, 변경 후 최소한 lint 에러 없이 통과시키는 것을 기본으로 한다.
- 기존 경고를 새로 늘리지 않는 방향을 우선하며, 작업 범위 밖의 대규모 경고 정리는 사용자 요청 없이 벌이지 않는다.
- 문서만 바꿨거나 운영 메모만 수정한 경우에는 `lint`를 생략할 수 있다.
- `hosting/`만 수정한 경우 현재 전용 lint 스크립트가 없으므로 존재하지 않는 검증 단계를 지어내지 않는다. 대신 필요한 범위의 수동 확인이나 화면 동작 확인으로 대체한다.
- `lint` 오류나 경고를 정리할 때는 이번 작업과 직접 맞닿은 범위부터 우선 처리하고, 무관한 파일 전반을 한꺼번에 뒤엎지 않는다.

### API 문서 조회

공식 API 문서 확인이 필요할 때는 현재 세션에서 사용 가능한 공식 문서용 MCP 또는 공식 웹 문서를 우선 사용한다. 특정 MCP 이름을 고정 전제로 두지 않는다.

### 문서와 실제 코드의 우선순위

이 문서의 프로젝트 구조, 스케줄러 시간, 엔드포인트 목록, 운영 메모는 참고 자료다. 실제 동작과 충돌하거나 오래된 흔적이 보이면 `functions/src/index.js`, `firebase.json`, 각 `package.json` 등 현재 소스 코드를 우선 기준으로 삼는다.
문서와 코드가 어긋나면 코드를 기준으로 판단하되, 필요하면 문서도 함께 갱신한다.

### 진행 상황 설명 시 감정 표현

작업 중간중간 현재 진행 상황을 설명할 때, 문장 앞에 상태를 직관적으로 파악할 수 있도록 감정 표현을 붙인다.
예를 들어 예상치 못한 결과라면 놀람을, 우려했던 부분이 무사히 통과됐다면 안도감을, 깔끔하게 해결됐다면 즐거움을 담는 식으로 감정의 결을 다양하게 활용한다.
정상/문제 여부를 빠르게 캐치할 수 있게 하는 것이 목적이므로, 고정된 표현을 반복하지 말고 상황과 문맥에 맞게 자연스럽게 표현한다.

---

## 파일 네이밍 규칙

새로 생성하는 모든 JS 파일은 아래 규칙을 따른다.

### 형식

**`{platform}{Feature}{Role}.js`** — camelCase 통일

- **platform**: 플랫폼 특정 파일은 항상 prefix 붙임 (`discord`, `instagram`, `youtube` …)
- **Feature**: 기능/주제 (생략 가능)
- **Role**: 아래 표의 suffix 중 하나로 반드시 마침

### 역할별 suffix

| suffix        | 역할                                                       | 예시                                                       |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `Pipeline`  | 수집 → 분석 → 저장 → 발송을 조율하는 E2E 오케스트레이터 | `discordDailyPipeline.js`, `instagramDailyPipeline.js` |
| `Collector` | 외부 플랫폼 API 호출 및 원시 데이터 반환                   | `discordCollector.js`, `instagramCollector.js`         |
| `Analyzer`  | AI/처리 분석 로직                                          | `openrouterAnalyzer.js`                                  |
| `Delivery`  | 이메일·Sheets 등 최종 출력 발송                           | `reportDelivery.js`, `reportPresetDelivery.js`          |
| `Core`      | 여러 모듈이 공유하는 공통 기반/인프라                      | `instagramCollectorCore.js`, `reportEmailCore.js`       |
| `Utils`     | 날짜·포맷 등 범용 헬퍼                                    | `dateUtils.js`                                           |
| `index.js`  | 진입점 — 변경 없음                                        |                                                            |

### 추가 규칙

- **camelCase 통일** — snake_case(`instagram_core.js`) 사용 금지
- **Collector는 `collectors/` 디렉토리에** — 파이프라인 루트에 수집 파일 두지 않음
- **예외: 로컬 실행 스크립트는 루트 배치 가능** — 예: `functions/src/dcinsideLocalCollect.js`
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
│   │   ├── facebookGroupDailyPipeline.js   # Facebook 그룹 크롤링/분석 파이프라인 (Playwright)
│   │   ├── facebookPageDailyPipeline.js    # Facebook 페이지 Graph API 수집/분석 파이프라인
│   │   ├── naverLoungeDailyPipeline.js     # 네이버 라운지 수집/분석/저장 파이프라인
│   │   ├── dcinsideDailyPipeline.js        # DCInside Firestore 수집 데이터 읽기 → AI 분석 → 이메일
│   │   ├── youtubeDailyPipeline.js         # YouTube 키워드 수집/관련성 판정/분석/이메일
│   │   ├── dcinsideLocalCollect.js         # Mac Mini 전용 로컬 수집 스크립트
│   │   ├── reportPresetDailyPipeline.js    # 리포트 프리셋 통합 이메일 파이프라인
│   │   ├── reportDelivery.js               # 개별 플랫폼 이메일 + Google Sheets 발송
│   │   ├── reportPresetDelivery.js         # 프리셋 통합 이메일 렌더링/발송
│   │   ├── reportEmailCore.js              # SMTP 전송 공통부
│   │   ├── collectors/
│   │   │   ├── discordCollector.js         # Discord 메시지 수집 (증분 snowflake)
│   │   │   ├── discordInsightCollector.js  # Discord Guild Insights 수집
│   │   │   ├── instagramCollector.js       # Instagram (Facebook Graph API 방식)
│   │   │   ├── instagramDirectCollector.js # Instagram (Business Login 방식)
│   │   │   ├── instagramCollectorCore.js   # Instagram 공통 factory/기반
│   │   │   ├── facebookGroupCollector.js   # Playwright 기반 Facebook 그룹 크롤러
│   │   │   ├── facebookPageCollector.js    # Facebook Graph API v22.0 페이지 수집기
│   │   │   ├── naverLoungeCollector.js     # HTTP(Axios) 기반 네이버 라운지 수집기
│   │   │   ├── youtubeCollector.js         # YouTube Data API 기반 검색/상세 수집기
│   │   │   └── dcinsideCollector.js        # cheerio 기반 DCInside HTML 스크래퍼
│   │   ├── analyzers/
│   │   │   └── openrouterAnalyzer.js       # OpenRouter AI 분석
│   │   └── utils/
│   │       └── dateUtils.js                # KST 날짜 헬퍼
│   └── .env                                # 환경변수 (커밋 금지)
├── apps-script/
│   └── Code.gs                             # Google Sheets / Apps Script 연동 코드
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
firebase deploy --only "functions,hosting"

# Functions만
firebase deploy --only functions

# Hosting만
firebase deploy --only hosting
```

> `functions/.env` 파일이 반드시 존재해야 functions 배포 가능.
> `node_modules` 없으면 `cd functions && npm install` 먼저 실행.
> 배포 명령은 프로젝트 루트(`SocialListener/`)에서 실행하는 것을 기본 원칙으로 한다.
> Codex/PowerShell 환경에서는 `--only`에 여러 대상을 줄 때 반드시 `"functions,hosting"`처럼 따옴표로 감싼다.
> Firebase CLI 경로 인식이 불안정하면 `firebase` 대신 `firebase.cmd` 또는 사용 중인 절대 경로 래퍼를 사용한다.

---

## 스케줄러

현재 Firebase Cloud Scheduler는 개별 작업별 cron을 직접 들고 있지 않고, **`schedulerDispatcher` 1개가 5분마다 실행**되며 Firestore 설정을 읽어 실제 due task만 실행한다.

- **실제 Cloud Scheduler job**: `schedulerDispatcher`
- **Dispatcher cron**: `*/5 * * * *` (매 5분, UTC 기준 동일)
- **설정 저장 위치**: `workspaces/ws_antigravity/settings/schedulers`
- **웹앱 관리 메뉴**: `리포트 설정 > 스케줄러 관리`
- **시간 제약**: 시각은 5분 단위만 허용
- **제외 대상**: Mac Mini의 `dcinsideLocalCollect.js` 로컬 cron (`45 8 * * *`, KST 08:45)

### 관리 대상 작업

| 작업 key | 기본 시각 (KST) | 설명 |
| -------- | --------------- | ---- |
| `alertPipeline` | 매 2시간 / 00분 | Discord 증분 수집 + 키워드 알림 |
| `dailyPipeline` | 09:00 | Discord 일간 리포트 생성 |
| `insightCollector` | 09:30 | Discord Guild Insights 수집 |
| `weeklyPipeline` | 월 10:00 | Discord 주간 리포트 생성 + 이메일 발송 |
| `instagramPipeline` | 09:00 | Instagram 수집/분석/이메일 |
| `facebookGroupPipeline` | 09:00 | Facebook 그룹 크롤링/분석/이메일 |
| `facebookPagePipeline` | 09:05 | Facebook 페이지 Graph API 수집/분석/이메일 |
| `naverLoungePipeline` | 09:10 | 네이버 라운지 수집/분석/이메일 |
| `dcinsidePipeline` | 09:00 | DCInside Firestore 수집 데이터 읽기 → AI 분석 → 이메일 |
| `youtubePipeline` | 08:50 | YouTube 신규 업로드 수집/분석/이메일 |
| `presetPipeline` | 09:30 | 리포트 프리셋 통합 이메일 발송 |

---
