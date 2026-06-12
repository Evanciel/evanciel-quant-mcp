# quant-mcp 24/7 헤드리스 데몬(audit P0-2). MCP 클라이언트 없이 봇+대시보드 상시 가동.
#
# 빌드:  docker build -t quant-mcp .
# 실행:  docker run -d --name quant-mcp --restart=always \
#          -v ~/.quant-mcp:/root/.quant-mcp \            # 자격증명·store.db·audit 영속
#          -p 127.0.0.1:7788:7788 \                       # 대시보드(호스트 로컬에만 바인딩)
#          --env-file .env.local \                        # 키/게이트 env (이미지에 굽지 않음)
#          quant-mcp
# 중지(킬스위치): docker stop quant-mcp  또는 텔레그램 /halt
FROM node:22-slim

WORKDIR /app

# 의존성 레이어 캐시. 데몬은 tsx(devDependency)로 구동하므로 dev 포함 설치.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev || npm install --include=dev

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 7788

# /healthz: 무인증·민감정보 0(살아있음+가동 봇 수). 실패 누적 시 Docker가 unhealthy → restart 정책과 조합.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7788/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/daemon.ts"]
