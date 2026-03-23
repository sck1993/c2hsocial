# /check-report — 특정 날짜 리포트 데이터 조회

Firestore에 저장된 특정 날짜의 리포트 데이터를 조회하여 요약한다.

## 실행 순서

1. 사용자가 날짜를 지정하지 않은 경우 오늘 날짜(KST) 기준 전일 날짜를 사용
2. 플랫폼을 지정하지 않은 경우 Discord, Instagram, Facebook 전체 조회
3. Firebase MCP 또는 API 엔드포인트를 통해 해당 날짜 리포트 조회:
   - Discord: `GET /report?workspaceId=ws_antigravity&date={date}`
   - Instagram: `GET /instagram/report?workspaceId=ws_antigravity&date={date}`
   - Facebook: `GET /facebook/report?workspaceId=ws_antigravity&date={date}`
4. 조회 결과를 플랫폼별로 요약 출력

## 출력 형식

```
## {date} 리포트
### Discord — {guildName}
- 메시지 수: ...
- 감정: ...
- 주요 이슈: ...

### Instagram — {username}
- 게시물 수: ...
- 주요 지표: ...

### Facebook — {groupName}
- 게시물 수: ...
- 주요 동향: ...
```

## 주의사항

- API 호출 시 `x-admin-secret: Bizdev2026!` 헤더 필수
- API URL: `https://api-xsauyjh24q-du.a.run.app`
