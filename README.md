# Dom-In-O

**.domino 파일로 열리는, LLM이 실시간으로 UI를 만드는 크로스플랫폼 앱 런타임.**

웹사이트나 공유 링크로 받은 `*.domino` 파일(또는 `domino://` URL)을 열면, 런타임이 파일에 담긴
설정·API·스크립트를 읽고, 등록한 BYOK LLMProvider로 화면을 실시간 생성합니다. 로그인 페이지부터
대시보드, 버튼 클릭 후의 다음 화면까지 — 마치 앱이 원래 거기 있었던 것처럼.

## 동작 방식

```
.domino 파일 (INI + 스크립트)
   │  파서: [meta] [auth] [api] [ui] [script]
   ▼
에이전트 루프 (BYOK LLM: OpenAI /responses · /chat/completions · Anthropic /v1/messages)
   │  도구: render_ui · call_api(allow 화이트리스트) · navigate
   ▼
UiSpec JSON → 12칼럼 카드 그리드 렌더 (스트리밍 중에도 점진적 렌더)
   │
   ├─ 버튼/폼 이벤트 → 현재 컨텍스트 + ACTION 메시지 → LLM이 다음 화면 실시간 생성
   ├─ 이전/다음 페이지 히스토리 (⌘[ / ⌘])
   └─ 세션 내 렌더 캐시 (재실행 시 폐기 → 재생성)
```

- **로그인 플로우**: domino가 `auth`를 선언하면 LLM이 로그인 페이지를 만들고, 런토마이가
  폼 제출을 가로채 `login_endpoint`로 실제 로그인 → 토큰 저장 → `skip_if_logged_in`이면
  다음 실행 시 로그인 건너뜀.
- **디자인 테마**: domino의 `[ui]` 섹션이 앱 전체 스타일을 결정합니다.

## .domino 포맷 (v1)

```ini
[meta]
name = ExampleCRM
logo = https://example.com/logo.png
home = main

[auth]
required = true
login_endpoint = https://api.example.com/auth/login
token_key = access_token
skip_if_logged_in = true

[api]
base_url = https://api.example.com
allow = /login, /leads, /leads/*

[ui]
theme = dark            ; light | dark
primary = #4f46e5       ; 강조색 (버튼·링크·카드 헤더)
style = sharp           ; soft(기본, 둥근) | sharp(각진, rounded-none 느낌)
radius = 0              ; px 단위 직접 지정 (style보다 우선)
density = compact       ; comfortable(기본) | compact(조밀한 배치)
success = #10b981       ; 단계별 색 (Tailwind 팔레트 느낌)
warning = #f59e0b
danger = #ef4444

[script]
when not logged_in -> goto login
when logged_in -> goto main
on auth_failed -> goto login
```

`[script]` 조건식 DSL: `logged_in`, `not ...`, `param.plan == "pro"`, `count > 3`,
`and` / `or` / `괄호` 지원. 명령: `goto <page>`, `render <page>`, `call <endpoint>`.

## 시작하기

```bash
npm install
npm run dev          # Electron 데스크톱 앱
npm run build:web && npx vite preview --config vite.web.config.ts   # 순수 웹 빌드
npm run typecheck && npm test
```

설정(⚙)에서 LLM Provider를 등록하세요. 지원 엔드포인트:

| Provider | 엔드포인트 | 비고 |
|---|---|---|
| OpenAI Responses | `/responses` | 최신 OpenAI |
| Chat Completions | `/v1/chat/completions` | OpenAI 호환 API·Ollama·커스텀 베이스 URL |
| Anthropic Messages | `/v1/messages` | Claude |

API 키는 데스크톱에서 `safeStorage`로 암호화 저장, 웹에서는 localStorage.

### 로컬 E2E 데모 (API 키 불필요)

```bash
node samples/mock-server.mjs   # :8787 — 목 백엔드 + 목 LLM(SSE)
npm run dev                    # 앱 실행 → "예시로 시작하기"
```

설정에서 Base URL `http://127.0.0.1:8787/v1`, 모델 `mock-model`, 임의의 키를 저장하면
로그인 → 대시보드 → "New lead" → 뒤로가기 → 캐시 히트까지 전 과정을 체험할 수 있습니다.

## 패키징

```bash
npm run dist          # 현재 OS용 아티팩트 → release/ (DMG/ZIP·NSIS·AppImage/deb)
```

GitHub Actions(`.github/workflows/build.yml`)가 푸시 시 맥/윈도우/리눅스별 아티팩트를 빌드·업로드합니다.

## 안드로이드 (Capacitor)

코어와 렌더러가 순수 웹이므로 동일 번들이 웹뷰에서 그대로 동작합니다.

```bash
npm run android:sync                # 웹 빌드 → android/ 셸 동기화
npx cap open android                # Android Studio에서 빌드/실행
```

`android/` 플랫폼 프로젝트가 저장소에 포함되어 있습니다. 파일 열기/딥링크(`domino://`)는
웹 셸의 URL 입력·파일 선택으로 동작하며, 플랫폼 어댑터(`window.dominoBridge` 부재 시
localStorage 폴백)로 저장소가 추상화되어 있습니다.

## 아키텍처

```
src/core/            플랫폼 독립 코어 (Electron·웹·Capacitor 공용)
  domino/            포맷 타입 + 파서 + 조건 DSL + 스크립트 엔진
  spec/              UiSpec JSON 스키마 (zod 검증)
  ui/                컴포넌트 레지스트리(24종) + CardGrid(12칼럼)
  llm/               프로바이더 어댑터 3종 (정규화된 스트리밍 델타)
  agent/             에이전트 루프 + 부분 JSON 복구(점진 렌더) + API 화이트리스트
  session/           히스토리 스택 + 세션 캐시 + 설정/토큰 영속화
src/renderer/        React 앱 셸 (환영/설정/러닝타임 화면, 플랫폼 어댑터 주입)
src/shell-electron/  main + preload (domino:// 프로토콜, IPC, safeStorage)
android/             Capacitor 안드로이드 셸
samples/             샘플 .domino 3종 + 목 서버
```
