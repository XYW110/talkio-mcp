# Docker 镜像发布（GitHub Actions → Docker Hub）

> 镜像自动构建发布流水线的可执行契约：secrets 装配、镜像命名、配置注入与故障判定。
> 改动 `.github/workflows/docker-publish.yml`、`Dockerfile` runtime 阶段、`experts.default.json`、`.dockerignore` 之一，必须同步本文件。

---

## 1. Scope / Trigger

- 触发条件：改动发布 workflow、`Dockerfile`、`experts.default.json`、`.dockerignore`，或更换 Docker Hub 账号 / 仓库名。
- 本模块跨「CI + secrets + 镜像内配置装配」三层，属于基础设施与交付契约，必须保持本文件同步。

## 2. Signatures

流水线（`.github/workflows/docker-publish.yml`）：

```yaml
on:
  push:
    branches: [master]      # → latest
    tags: ["v*"]            # → <version> / <major>.<minor>
  workflow_dispatch: ~
jobs:
  quality:                  # npm ci → npm run typecheck → npm test
  publish:                  # needs: quality → setup-buildx → login → metadata → build-push
```

镜像命名（唯一合法形式）：

```
<DOCKERHUB_USERNAME>/<IMAGE_NAME>:<tag>     # 例：dockercom110/talkio-mcp:latest
```

仓库内契约文件：

| 文件 | 角色 |
| --- | --- |
| `experts.default.json` | 入库的**脱敏**默认配置（无真实密钥 / 内网地址），构建时复制为 `/app/experts.json` |
| `experts.json` | 本地真实配置，`.gitignore` + `.dockerignore` 双重排除，**永不入库、永不入镜像上下文** |
| `Dockerfile` runtime 阶段 | `COPY package*.json experts.default.json ./` → `npm ci --omit=dev && cp experts.default.json experts.json` |

## 3. Contracts

### GitHub Secrets（仓库级：Settings → Secrets and variables → Actions）

| Name | 必填 | 取值约束 |
| --- | --- | --- |
| `DOCKERHUB_USERNAME` | 是 | Docker Hub 的 **Docker ID**（登录用户名），**不是 Display Name**；当前值 `dockercom110` |
| `DOCKERHUB_TOKEN` | 是 | Docker Hub Personal Access Token，权限 **Read & Write**，形如 `dckr_pat_...` |

### 环境变量

| 变量 | 作用域 | 值 |
| --- | --- | --- |
| `IMAGE_NAME` | workflow `env` | `talkio-mcp`（**仅仓库名，不含命名空间**） |
| `OPENAI_API_KEY` 等 | 容器运行时 | 由 `docker run --env-file .env` 或 `-e` 注入；`experts.json` 只存变量名（`apiKeyEnv` 间接引用） |

### 产出标签

| 触发 | 标签 |
| --- | --- |
| push `master` | `latest` |
| push tag `v0.2.0` | `0.2.0`、`0.2` |
| workflow_dispatch | 按当前 ref 同上 |

### 触发冲突处理

workflow 级 `concurrency.group = docker-publish-${{ github.ref }}`、`cancel-in-progress: false`：同一 ref 的发布串行排队，不打断进行中的推送。

## 4. Validation & Error Matrix

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `Log in to Docker Hub` 报 `unauthorized: incorrect username or password` | username 非真实 Docker ID，或 token 与账号不匹配 / 已撤销 | 见「诊断」小节，先本地判定再动 CI |
| `curl -u <user>:<token> https://registry-1.docker.io/v2/` 返回 `401` | 该 token 在目标账号下无效 | 确认浏览器登录账号 → 重新生成 PAT |
| push 阶段 `denied: requested access to the resource is denied` | 命名空间与 token 账号不一致，或 token 权限为 Read-only | 核对 `<user>/<repo>` 与 token 权限 |
| 构建阶段 `COPY ... experts.json: not found` | 误将依赖指向被 `.gitignore` 忽略的真实配置 | 一律 `COPY experts.default.json` |
| 本地 `docker compose up` 启动即失败 | 宿主机无 `experts.json`，Docker 把缺失挂载点创建成目录 | 注释掉该挂载（改用镜像内置模板），或先创建文件 |
| `config.ts` 启动即 `exit(1)` | 容器内配置缺 provider / 引用不完整 | 检查 `experts.default.json` 的 provider↔model↔card 引用完整性 |

## 5. Good/Base/Bad Cases

- **Good**：`master` push → `quality` 全绿 → 构建 `linux/amd64` → 推送 `<DockerID>/talkio-mcp:latest`；发版时 `git tag v0.2.0 && git push origin v0.2.0` 额外产出 `0.2.0` / `0.2` 可回滚锚点。
- **Base**：仅注入 `OPENAI_API_KEY` 即可 `docker run` 启动（镜像内置脱敏模板）；无密钥时用 `TALKIO_MOCK_PROVIDER=1` 跑 mock。
- **Bad**：仓库提交真实 `experts.json`（泄露内网 `baseUrl`）；workflow 硬编码命名空间（换账号后静默失败）。

## 6. Tests Required

| 层 | 断言点 |
| --- | --- |
| 本地 · 凭据 | `curl -s -o NUL -w "%{http_code}" -u "$USER:$TOKEN" https://registry-1.docker.io/v2/` == `200`（不需要 Docker daemon） |
| 本地 · 配置 | `node -e "import('./dist/config.js').then(m=>m.loadConfig('experts.default.json',{skipDotenv:true}))"` 成功加载，`cards.length >= 1` 且无 `121.43`/内网串命中 |
| CI · 门禁 | `quality` job 必须 `success`，否则阻断发布（禁止绕过） |
| 发布后 · 产物 | `https://hub.docker.com/v2/repositories/<user>/talkio-mcp/tags/` 中 `name` 含期望标签 |

## 7. Wrong vs Correct

#### Wrong

```yaml
env:
  IMAGE_NAME: xyw/talkio-mcp        # 硬编码命名空间：与真实 Docker ID 不符时登录/推送失败
```

```yaml
images: ${{ env.IMAGE_NAME }}
```

```dockerfile
COPY package*.json experts.json ./  # 该文件被 .gitignore 忽略，CI 克隆后根本不存在
```

#### Correct

```yaml
env:
  IMAGE_NAME: talkio-mcp            # 仅仓库名
```

```yaml
images: ${{ secrets.DOCKERHUB_USERNAME }}/${{ env.IMAGE_NAME }}
```

```dockerfile
COPY package*.json experts.default.json ./
RUN npm ci --omit=dev \
  && cp experts.default.json experts.json
```

---

## Common Mistake: Docker ID ≠ Display Name

**Symptom**：`docker login` 报 `incorrect username or password`，但用户名"看起来没错"。

**Cause**：Docker Hub 同时存在 Docker ID（登录名，决定认证与命名空间）与 Display Name（展示名），二者经常不同；填 Display Name 必然认证失败。

**Fix**：用 `https://hub.docker.com/v2/users/<name>/` 反查真实存在性（`200` = 存在，`404` = 不存在）。

**Prevention**：secret 只填 Docker ID；镜像命名空间一律由该 secret 拼接，不硬编码。

## Gotcha: 凭据诊断不需要 Docker daemon

`curl -u "<user>:<token>" https://registry-1.docker.io/v2/` 可直接判定凭据有效性（`200` 有效 / `401` 无效），不依赖本地 Docker Desktop 是否运行。排查 CI `docker login` 失败时优先用它，避免反复触发 CI 运行。

判定技巧：若凭据"外形"正常（长度 / `dckr` 前缀 / 无空白符）但 registry 返回 `401`，说明 token 不属于该账号或已被撤销 —— 此时查"账号"比查"token 内容"更有效。

> **Warning**：不要把 secret 原文打印进 CI 日志。需要诊断时只输出长度、固定前缀、是否含空白符等非敏感特征（历史实现见提交 `69d934d`，问题定位后已移除）。
