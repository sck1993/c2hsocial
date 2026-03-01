# 📄 제품 요구사항 정의서 (PRD): 소셜 리스너 (Social Listener)

**문서 버전:** 1.4.0 (디스코드 위기 감지 및 맞춤형 프롬프트 기능 추가)
**작성일:** 2026-02-28
**개발 주체:** ANTIGRAVITY
**프로젝트 목적:** Discord, Instagram, YouTube 등 주요 소셜 플랫폼의 원시(Raw) 데이터를 수집하고, AI를 통해 분석/요약하여 중앙 대시보드에서 통합 관리하는 자동화 관제 시스템 구축. 다수의 고객(B2B)에게 제공하며, 매월 상세 사용 내역 기반의 인보이스를 청구하는 상용 서비스로 발전시킨다.

---

## 1. 프로젝트 개요 (Project Overview)

### 1.1. 배경 및 필요성

다양한 소셜 플랫폼에 분산된 유저의 반응, 여론, 동향을 수동으로 취합하는 것은 비효율적입니다. '소셜 리스너'는 MCP(Model Context Protocol)를 활용해 데이터 수집을 규격화하고, OpenRouter(LLM)를 통해 유의미한 리포트를 자동 생성합니다. 이를 비즈니스 모델로 전환하여 타 기업/크리에이터에게 동향 분석 서비스를 제공합니다.

### 1.2. 핵심 목표 (Core Objectives)

- **플랫폼 통합 수집:** Discord, Instagram, YouTube의 일일 데이터를 자동 수집.
- **채널별 개별 리포트 및 구독:** 하나의 플랫폼 내에서도 고객이 수신을 원하는 특정 채널(또는 타겟)만 선택하여 개별적인 동향 리포트를 발행.
- **AI 기반 자동화 및 맞춤 분석:** 수집된 데이터를 LLM에 전달하여 핵심 요약, 감정 분석을 수행하며, 고객이 설정한 채널별 맞춤형 포커스 질문에 대한 답을 제공.
- **실시간 위기 감지 (Discord 전용):** 여론이 급변하는 실시간 채팅 플랫폼의 특성을 반영하여, 심각한 이슈 발생 시 즉각적인 알림 발송.
- **Multi-Tenant SaaS 구조:** 고객(Workspace)별로 데이터와 설정을 완벽히 격리하고, 월별 인보이스를 발행.

---

## 2. 시스템 아키텍처 (System Architecture)

### 2.1. 기술 스택 (Tech Stack)

| 영역 | 기술 |
|------|------|
| Frontend | HTML/CSS/JavaScript (또는 React/Vue) + Firebase Hosting |
| Backend | Firebase Cloud Functions (Node.js) |
| Database | Firebase Cloud Firestore (NoSQL) |
| Authentication | Firebase Authentication (고객 계정 관리) |
| Scheduler | Google Cloud Scheduler (Cron Job) |
| AI API | OpenRouter API (Claude 3.5 Sonnet / GPT-4o-mini 등) |
| Integration | 플랫폼별 독립된 MCP 서버 |
| Alert & Email | SendGrid(이메일 발송) 및 Slack/Discord Webhook (위기 감지 알림용) |
| Invoice | PDFKit(또는 Puppeteer) 활용 인보이스 PDF 생성 |
| Cost Monitoring | Google Cloud Billing API, OpenRouter API 통계 조회 연동 |

### 2.2. 데이터 플로우 (Data Flow)

1. Cloud Scheduler가 트리거 발생 시, 활성 고객(Workspace) 목록을 순회.
2. 고객의 설정(Settings) DB를 확인하여 수신 활성화(Active)된 특정 채널들의 목록만 추출.
3. 추출된 개별 채널별로 MCP 서버에 데이터 수집 도구 실행 요청.
4. 수집된 데이터를 고객이 설정한 **'맞춤형 프롬프트'** 와 함께 OpenRouter API로 전송하여 리포트 생성.
5. **[위기 감지 분기]** 디스코드 채널의 경우, 반환된 분석 결과에서 '부정 감정 임계치 초과' 또는 '위기 키워드'가 감지되면 즉시 관리자 이메일/메신저로 알림 발송.
6. 실행 완료 직후 발생한 비용(수집 건수, 사용 토큰)을 당월 Usage Log DB에 누적 기록.
7. OpenRouter가 반환한 개별 리포트를 고객의 Firestore 공간 내 채널 단위로 분리 저장.
8. 월말 인보이스 발행 시, 채널별 수집 비용을 합산하여 청구서 발송.

---

## 3. 주요 기능 명세 (Core Features)

### 3.1. 자동 데이터 수집 파이프라인 (Data Ingestion)

- **선택적 타겟 수집:** 고객이 대시보드에서 명시적으로 추가하고 활성화(ON)한 채널/해시태그/검색어에 대해서만 병렬 수집 진행.

### 3.2. AI 분석 및 요약 엔진 (AI Analysis Engine)

- **채널별 독립 분석 및 맞춤 포커스 (Custom Prompting):**
  - 일괄적인 요약 외에, 고객이 대시보드에서 채널별로 입력한 "맞춤형 지시사항"을 LLM 시스템 프롬프트에 주입하여 분석.
  - 예: "이번 1.2 패치 밸런스에 대한 유저 반응을 집중적으로 요약해 줘."
- **분석 항목:** `summary`(동향 요약), `custom_answer`(맞춤형 프롬프트에 대한 답변), `sentiment`(감정 지표), `keywords`(핵심 키워드), `issues`(주요 화제).

### 3.3. 🚨 실시간 위기 감지 알림 (Crisis Alert - Discord 전용)

- **기능 설명:** 실시간 소통이 활발한 Discord 채널에 한정하여, AI 분석 결과가 특정 '위험 조건'을 충족하면 리포트 발행 주기(24시간)를 기다리지 않고 고객의 담당자에게 즉시 알림(Email/Webhook)을 전송.
- **트리거 조건 설정:**
  - 부정적 감정(Negative Sentiment)이 설정된 임계치(예: 60%)를 초과할 때.
  - 고객이 미리 등록한 '위험 키워드(예: 환불, 버그, 서버 다운, 고소)'가 다수 발견될 때.

### 3.4. SaaS 대시보드 웹앱 (SaaS Dashboard)

- **고객용 대시보드 (Client View):**
  - 구독 채널 및 분석 포커스 관리: 특정 채널을 등록/On-Off 하고, 해당 채널 전용 '맞춤형 프롬프트'를 작성하는 기능.
  - 위기 감지 설정 (Discord 탭): 알림을 받을 위험 키워드 및 수신처(이메일, 웹훅 URL) 설정.
  - 채널별 리포트 뷰어 및 인보이스 다운로드 기능.
- **최고 관리자용 대시보드 (Super Admin View):**
  - 실시간 원가(GCP, OpenRouter API) 및 사용량 모니터링.
  - 월별 상세 인보이스 관리 및 이메일 발송.

---

## 4. 데이터베이스 스키마 (Firestore Schema) - Multi-Tenant 구조

맞춤형 프롬프트와 디스코드 전용 위기 감지 설정을 지원하도록 `subscribed_channels` 구조를 고도화했습니다.

### 4.1. `workspaces` (Collection - 고객별 격리 공간)

```
workspaces/
└── {workspace_id}
    ├── companyName: String
    ├── billingEmail: String
    ├── baseMonthlyFee: Number
    │
    ├── subscribed_channels/ (Sub-Collection)
    │   └── {채널고유ID}  예: discord_123456
    │       ├── platform: String          # discord | instagram | youtube
    │       ├── channelName: String
    │       ├── isActive: Boolean
    │       ├── customPrompt: String      # 선택: 채널 전용 분석 지시문
    │       └── alertConfig: Object       # 선택: platform이 'discord'일 때만 사용
    │           ├── isEnabled: Boolean
    │           ├── triggerKeywords: Array<String>   # ["환불", "서버"]
    │           ├── negativeThreshold: Number        # 60 → 부정 60% 이상 시 알림
    │           └── notifyWebhookUrl: String
    │
    ├── reports/ (Sub-Collection)
    │   └── {YYYY-MM-DD}
    │       └── channels/ (Sub-Collection)
    │           └── {채널고유ID}
    │               ├── platform: String
    │               ├── summary: String
    │               ├── custom_answer: String       # 맞춤형 프롬프트 분석 결과
    │               ├── sentiment: String
    │               ├── keywords: Array<String>
    │               ├── issues: Array<Object>
    │               └── isAlertTriggered: Boolean   # 위기 알림 발송 여부 마킹
    │
    └── usage_logs/ (Sub-Collection)
        └── {log_id}
            └── (API 비용 및 플랫폼 수집 내역 분할 기록)
```

---

## 5. 비기능적 요구사항 (Non-Functional Requirements)

- **보안 및 테넌트 격리 (Security):** Firestore Security Rules 적용.
- **알림 스팸 방지 (Alert Debouncing):** 위기 감지 알림이 단기간에 폭주하지 않도록, 채널당 알림 발생 후 쿨타임(예: 최소 4시간 대기)을 적용.
- **청구 데이터 무결성 (Accuracy):** API 통신 실패 시 비용 미누적 트랜잭션 처리.

---

## 6. 개발 페이즈 및 마일스톤 (Milestones)

| Phase | 내용 |
|-------|------|
| **Phase 1** (MVP) | Discord 대상 MCP 연동 및 기본 AI 요약 파이프라인 구축 |
| **Phase 2** (고도화) | `customPrompt` 활용 채널별 맞춤 분석 + Discord 위기 감지 로직(Threshold 분석 및 웹훅 알림) 구현 |
| **Phase 3** (기능 확장) | YouTube, Instagram 플랫폼 추가 연동 |
| **Phase 4** (SaaS 상용화) | Firestore Multi-tenant 적용 + 고객용 대시보드 완성 + 월별 상세 인보이스(PDF) 생성 및 발송 시스템 구축 |
