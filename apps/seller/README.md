# Mapae seller

유료 리소스의 x402 `402 Payment Required` 응답을 만들고, 로컬 facilitator에
검증·정산을 요청합니다.

```sh
bun install
cp .env.example .env
# PAY_TO에는 수취인의 공개 주소만 입력
chmod 600 .env
bun run dev
```

기본 바인딩은 `127.0.0.1:3000`입니다. 외부 배포에서는 `BASE_URL`을 HTTPS로
설정하고, facilitator는 공인 인터넷에 노출하지 않은 채 같은 사설 네트워크에서
연결합니다.

결제 payload는 판매자가 제시한 네트워크·자산·금액·수취인·EIP-712 도메인과
정확히 일치해야 하며, 오류 로그에는 재사용 가능한 signature를 남기지 않습니다.
