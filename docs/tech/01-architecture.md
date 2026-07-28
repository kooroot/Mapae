<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->

# 1. 시스템 구성

| 컴포넌트 | 역할 | 런타임 |
|---|---|---|
| `contracts/` | MockUSDC (EIP-3009) | Solidity 0.8.28 / Foundry |
| `facilitator/` | x402 결제 검증·정산 브로드캐스트 | x402-rs (Rust, 컨테이너 운영) |
| `apps/seller` | 402 발행 (유료 리소스) | Bun + Hono |
| `apps/agent` | 402 수신 → 서명 → 재요청 | Bun (→ MCP 클라이언트) |
| `apps/console` | 위임·한도 관리, 영수증 조회 | Vite + TanStack + wagmi |
| `packages/shared` | 체인·토큰·x402 타입·에러 모델 | TypeScript |
| `packages/delegation` | Framework 환경·caveat·서명·재위임·취소·ERC-7710 | Smart Accounts Kit 1.7 |
| `apps/facilitator-erc7710` | ERC-7710 verify/settle 어댑터 | Bun + viem |
| `apps/delegated-agent` | parent 위임에서 결제별 leaf 생성 | Bun |
| `apps/delegated-seller` | ERC-7710 402 발행·리소스 게이트 | Bun + Hono |
| `apps/agent-mcp` | 결제 루프를 MCP tool로 노출 | Bun + MCP SDK (stdio) |
| `apps/revocation-submitter` | owner 서명 회수 UserOp 수신 → `handleOps` (loopback 전용) | Bun + Hono |
| `apps/delegation-lab` | 배포 preview·negative-path·e2e 수트·fork 오케스트레이션 | Bun |
| `apps/web` | 공개 랜딩 + 콘솔 (SSR, 체인 직접 읽기) | TanStack Start + Cloudflare |

**언어 선택 근거** — 위임 레이어가 ERC-7710/7715 구현체(MetaMask Delegation Toolkit)에 의존하고 이는 TypeScript 전용이므로 애플리케이션 계층은 TS. facilitator는 자체 구현 대신 x402-rs 컨테이너를 **운영**하는 포지션.
