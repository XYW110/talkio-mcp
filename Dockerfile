# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# 后端依赖（仅依赖清单 → 最大化镜像层缓存）
COPY package*.json ./
RUN npm ci

# 前端依赖（admin-web 使用独立 package-lock.json）
COPY admin-web/package*.json ./admin-web/
RUN cd admin-web && npm ci

# 拷贝源码并编译（后端 tsc + 前端 vite）
COPY tsconfig.json ./
COPY src/ ./src/
COPY admin-web/ ./admin-web/
RUN npm run build
RUN npm run build:web

# ---------- Stage 2: runtime ----------
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 生产依赖 + 默认专家配置
# experts.default.json 是入库的脱敏模板（无真实密钥/内网地址），构建时复制为
# /app/experts.json，保证镜像开箱可用；运行时可用 -v 挂载真实配置覆盖。
COPY package*.json experts.default.json ./
RUN npm ci --omit=dev \
  && cp experts.default.json experts.json

# 后端编译产物 + 前端静态产物
# （SSE 模式的 /api 静态服务通过 <config目录>/admin-web/dist 托管管理界面）
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/admin-web/dist ./admin-web/dist

# 非 root 运行
RUN addgroup -S talkio && adduser -S talkio -G talkio \
  && chown -R talkio:talkio /app
USER talkio

EXPOSE 3100

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--transport", "sse", "--port", "3100", "--host", "0.0.0.0"]
