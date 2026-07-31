# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# 仅拷贝依赖清单，最大化利用镜像层缓存
COPY package*.json ./
RUN npm ci

# 拷贝源码并编译
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 生产依赖 + 默认专家配置
COPY package*.json experts.json ./
RUN npm ci --omit=dev

# 编译产物
COPY --from=builder /app/dist ./dist

# 非 root 运行
RUN addgroup -S talkio && adduser -S talkio -G talkio \
  && chown -R talkio:talkio /app
USER talkio

EXPOSE 3100

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--transport", "sse", "--port", "3100", "--host", "0.0.0.0"]
