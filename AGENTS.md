# AGENTS.md

## Git identity (MANDATORY — never forget)

- **모든 커밋과 푸시는 반드시 `Luna <xxs.main@gmail.com>` 프로필로만 한다.**
- 다른 이름/이메일로 커밋하면 안 된다. 이 저장소의 `git config user.name` / `user.email`은
  이미 `Luna` / `xxs.main@gmail.com`으로 설정되어 있다 — 다른 값으로 덮어쓰지 말 것.
- 커밋 전 `git log -1 --format='%an <%ae>'`로 저자를 확인할 것.

## NEVER include an AI contributor in commits (ABSOLUTELY FORBIDDEN)

> **극도로 중요: 절대, 어떤 경우에도, 커밋이나 푸시에 "Claude 컨트리뷰터"를 넣지 않는다.**

- 커밋 메시지에 `Co-Authored-By: Claude ...`, `Co-Authored-By: <noreply@anthropic.com>`,
  `Generated with Claude Code`, `Claude Code`, `Authored-by: Claude` 등 **어떤 형태의
  AI/Claude 기여자 표기나 크레딧 줄도 절대 추가하지 않는다.**
- 커밋 메시지 본문·푸시하는 모든 브랜치 커밋·PR 본문 어디에도 AI 저자 크레딧을 남기지 않는다.
- 코밋 트레일러(trailer) 자동 삽입 스킬/훅/설정이 있더라도 **이 저장소에서는 반드시 제거한다.**
- 커밋 직후 `git log -1` / `git log --format=%B -1`로 `Claude`·`Co-Authored`·`anthropic`·
  `noreply` 문자열이 **없는지 검사**하고, 있으면 즉시 `git commit --amend`로 제거한 뒤 푸시한다.
- 이 규칙은 identity 규칙과 동등한 **최우선 필수 사항**이다. 어길 경우 커밋을 다시 작성한다.
