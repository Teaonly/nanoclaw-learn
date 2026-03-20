## Setup

### Prerequisites

- Node.js 22+
- Docker (for agent containers)


### Install

```bash
git clone https://github.com/teaonly/nanoclaw-learn
cd nanoclaw-learn
npm install
```
### Configure

主控端（Host）需要的环境变量，创建修改 '.env' 文件

```bash
## GLM后台模型配置
ANTHROPIC_AUTH_TOKEN=智谱的KEY
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5
ANTHROPIC_MODEL=glm-5

## QQ需要的变量，可以从QQ机器人开放平台获得
QQ_APPID=1234556
QQ_APPSEC=QQ
```

容器端需要的环境变量，创建修改 '.env' 文件

```bash
## 容器环境变量示例
## 这些变量会被传递到容器运行时
## 复制此文件为 .env_container 并修改

# 代理配置（如需要）
# HTTP_PROXY=http://proxy.example.com:8080
# HTTPS_PROXY=http://proxy.example.com:8080
# NO_PROXY=localhost,127.0.0.1
```

### Build the agent container (first time)

```bash
./container/build.sh
```

### Run

```bash
npm run build && npm start
# or for development:
npm run dev
```

### 关于自动配置Group
当前QQ Channel采用自动创建Group实现。
