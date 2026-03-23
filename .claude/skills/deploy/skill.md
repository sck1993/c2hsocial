# /deploy — Firebase 배포

Firebase Functions + Hosting을 배포한다.

## 실행 순서

1. 사용자가 별도로 범위를 지정하지 않은 경우 `firebase deploy --only functions,hosting` 실행
2. 사용자가 `functions`만 또는 `hosting`만 지정한 경우 해당 범위로만 실행
3. 배포 결과(성공/실패)를 간결하게 출력

## 주의사항

- `functions/.env` 파일이 없으면 functions 배포 불가 — 없을 경우 사용자에게 알림
- `node_modules`가 없으면 `cd functions && npm install` 먼저 실행
- 배포 전 문법 오류가 우려되면 사용자에게 먼저 확인 후 진행

## 완료 후 출력

배포 성공 시 Hosting URL과 Function URL을 안내한다.
