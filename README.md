# FreeMiMoApi

Standalone OpenAI-compatible API proxy for **Xiaomi MiMo Code Free** (unlimited, no API key needed).

Reverse-engineers the MiMo Code CLI free-tier endpoint and exposes it as a standard OpenAI-compatible `/v1/chat/completions` server.

## How It Works

```
Your App → FreeMiMoApi (localhost:9656)
  → Bootstrap JWT (SHA-256 device fingerprint)
  → Inject system marker (anti-abuse bypass)
  → Xiaomi MiMo Free API
  → Stream/JSON response back
```

**Key mechanisms:**
- **JWT Bootstrap** — `POST /api/free-ai/bootstrap` with device fingerprint → receives JWT
- **System Marker** — injects `"You are MiMoCode, an interactive CLI tool..."` as first system message (required by Xiaomi anti-abuse)
- **X-Mimo-Source** header — `mimocode-cli-free` (identifies free-tier client)
- **Auto-retry** — re-bootstraps JWT on 401/403 automatically

## Install

```bash
git clone https://github.com/tioyudi/FreeMiMoApi.git
cd FreeMiMoApi
npm install
```

## Run

```bash
# Foreground
node server.js

# Background (tmux)
tmux new-session -d -s mimo 'node server.js'

# Custom port
PORT=8080 node server.js
```

Default port: **9656**

## Usage

### List models
```bash
curl http://localhost:9656/v1/models
```

### Chat (non-streaming)
```bash
curl http://localhost:9656/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "mimo-auto",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Chat (streaming)
```bash
curl http://localhost:9656/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "mimo-auto",
    "messages": [{"role": "user", "content": "Write a haiku"}],
    "stream": true
  }'
```

### Use with any OpenAI-compatible client
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9656/v1",
    api_key="free"  # any string works
)

response = client.chat.completions.create(
    model="mimo-auto",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9656` | Server port |

## Model

Only **`mimo-auto`** is available (Xiaomi's free-tier model). It resolves to their latest internal model automatically.

## Architecture

```
POST /v1/chat/completions
  ├── getJwt() → cached or bootstrap fresh JWT
  ├── injectMarker() → prepend system marker to messages
  ├── fetch(Xiaomi API) → with headers:
  │     Authorization: Bearer <JWT>
  │     X-Mimo-Source: mimocode-cli-free
  │     x-session-affinity: ses_<random>
  │     User-Agent: (Chrome UA rotation)
  ├── if 401/403 → re-bootstrap JWT, retry once
  └── Forward response (streaming SSE or JSON)

GET /v1/models → static list [mimo-auto]
```

## Integration with 9Router

Add as a provider connection:
- **Provider Type:** OpenAI Compatible Chat
- **Base URL:** `http://localhost:9656/v1`
- **Prefix:** `mimof` (or any)
- **API Key:** anything (e.g. `free`)

## License

MIT
