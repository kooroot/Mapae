# mapae-hello-probe — `.mcpb` 플랜 실측 프로브

로드맵 M2.1 (a)의 **08-31 오전** 작업을 위한 hello-world Desktop Extension이다.
Claude Desktop의 **Free 계정과 Pro 계정**에 같은 `.mcpb`를 설치해 "설치가 되는가,
도구 호출이 되는가"를 기록한다. 이 두 칸이 소비자 레일(M2.3 — `mapae.mcpb`
더블클릭)이 어느 플랜에서 존재하는지를 정한다.

프로브는 마패와 아무 관계가 없는 최소 서버다 — 네트워크 없음, 키 없음, 의존성
없음. 도구 하나 `mapae_hello`가 고정 문장을 돌려줄 뿐이다. 실제 마패 MCP 서버는
`apps/agent-mcp`이고 그 설치법은 [`docs/mcp-guide.md`](../../../docs/mcp-guide.md)에
있다.

## 안에 든 것

| 파일 | 역할 |
|---|---|
| `manifest.json` | MCPB 매니페스트 0.3. 서버 타입 `node`, 진입점 `server/index.js`, 도구 `mapae_hello` |
| `server/index.js` | 줄 단위 JSON-RPC 2.0 stdio 서버. 순수 Node ≥ 18, `require`·`import` 없음. `initialize` · `ping` · `tools/list` · `tools/call` 처리, 로그는 stderr로만 |
| `README.md` | 이 문서 — 절차와 결과 표 |

아카이브에는 위 세 파일만 들어간다. **이 디렉터리에 두는 파일은 전부 아카이브에
포함되므로** 스크린샷 같은 증거 파일은 여기가 아니라 바깥(`docs/` 등)에 둔다.

## 08-31 절차

같은 `.mcpb` 파일을 두 계정에서 차례로 시험한다. 계정마다 스크린샷 두 장(설치
결과, 도구 호출 결과)을 남기고 아래 표를 채운다.

1. Claude Desktop에 해당 계정으로 로그인한다.
2. **설정 → 확장 → 고급 설정 → Install Extension…** 에서 `mapae-hello-probe.mcpb`를
   고른다. (Finder·탐색기에서 `.mcpb`를 더블클릭해도 같은 설치 대화상자가 열린다 — 이것이
   M2.3의 소비자 경로이므로 여유가 있으면 둘 다 시험한다.)
3. 설치 대화상자에서 "설치"를 누르고, 확장 목록에 **Mapae Hello Probe**가 켜진
   상태로 나타나는지 확인한다. → 스크린샷 1
4. 새 대화를 열고 `mapae_hello 도구를 호출해 줘`라고 적는다. 도구 승인 대화상자가
   뜨면 허용한다.
5. 응답에 다음 문장이 그대로 나오면 도구 호출 성공이다. → 스크린샷 2

   > 마패 프로브 응답 — 이 계정에서 .mcpb 설치와 실행이 됩니다 (플랜 기록용)

6. 막히면 **어느 단계에서** 막혔는지 적는다 — 확장 메뉴 자체가 없음 / 설치
   대화상자가 거절함 / 설치는 되나 도구가 목록에 없음 / 호출이 실패함. 대화상자의
   문구를 그대로 스크린샷에 담는다.

서버는 시작할 때 stderr에 `listening on stdio — node vX on darwin`처럼 자기를
실행한 Node 버전을 적는다. Claude Desktop의 MCP 로그 디렉터리(macOS
`~/Library/Logs/Claude/`, Windows `%APPDATA%\Claude\logs\`)에서 이름에
`mapae-hello-probe`가 든 `mcp-server-*.log`를 열어 그 줄을 찾으면 M2.3 (a)가
번들 대상으로 삼을 Node 런타임 버전이 나온다 — 한 줄 옮겨 적어 둔다.

스크린샷 파일명은 `mcpb-probe-<플랜>-<단계>-2026-08-31.png` 꼴로 한다
(예: `mcpb-probe-free-install-2026-08-31.png`, `mcpb-probe-pro-call-2026-08-31.png`).

## 결과

| 플랜 | 설치 가부 | 도구 호출 가부 | 스크린샷 파일명 | 날짜 |
|---|---|---|---|---|
| Free | | | | |
| Pro | | | | |

## 결과에 따른 다음 행동

- **둘 다 됨** — M2.3이 계획대로 간다. `mapae.mcpb`가 소비자 경로이고 플랜 조건은
  없다.
- **Free만 막힘** — 소비자 레일은 Pro 전용이다. `docs/mcp-guide.md`(M2.3 (c))와
  M3.7 예산의 "테스터 플랜 5개" 항목에 "Claude Pro 필요"를 적고, 덱의 소비자
  슬라이드에 한 줄로 밝힌다.
- **둘 다 막힘** — 09-01에 결정한다(로드맵 M2.1 (a)): 소비자 계획안을
  "`claude_desktop_config.json` 한 줄 + Node 설치"로 바꾸고, 지표 "터미널 없이"의
  정의를 "터미널 없이(설정 파일 1회)"로 고쳐 적는다.

## 다시 만들기

저장소 루트에서:

```bash
bunx @anthropic-ai/mcpb validate apps/delegation-lab/mcpb-probe/manifest.json
bunx @anthropic-ai/mcpb pack apps/delegation-lab/mcpb-probe <out>.mcpb
```

`pack`은 매니페스트를 먼저 검증하고 `total files: 3`을 출력해야 한다. CLI 2.1.2의
파일 목록 표시는 경로를 `../../../`로 잘못 접어 보여 주므로(아카이브 내용은
정상이다) 실제 항목은 `unzip -l <out>.mcpb`로 본다 — `README.md`, `manifest.json`,
`server/index.js` 셋이어야 한다.

Claude Desktop 없이 서버만 확인하려면 (요청 세 줄을 파이프로 넣는다):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mapae_hello","arguments":{}}}' \
  | node apps/delegation-lab/mcpb-probe/server/index.js
```

stdout에 JSON 두 줄(initialize 결과, 도구 결과)이 나오고 stderr에 로그 네 줄
(listening, initialize, client initialized, stdin closed)이 나오면 정상이다.
