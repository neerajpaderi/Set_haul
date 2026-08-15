# SetHaul

SetuHaul's driver exception & dock slot coordination agent — a conversational assistant that
truck drivers message about delivery delays, ETAs, and dock appointment booking. Built on
LangChain/LangGraph, deployed to Amazon Bedrock AgentCore Runtime, backed by Supabase (Postgres).
The `frontend/` app (FleetPulse) is the driver-facing web client that surfaces this agent as an
in-app chatbot alongside shipment tracking and dock slot booking.

## Architecture

The LLM is a conversational layer only — it never decides slot availability, priority, or
double-booking outcomes. Those are enforced by atomic Postgres RPC functions:

- `hold_slot_atomic` — reserve a slot, fails with `conflict` if already held/booked
- `confirm_slot_atomic` — commit a held slot, verifying the hold is still valid and unexpired
- `release_hold_atomic` — release a hold early (e.g. driver changes their mind)

All writes go through pydantic-validated tool inputs ([schema.py](app/SetHaul/schema.py)). Every
driver/assistant message is persisted to `chat_messages` so a driver can return later and ask
"what's my status".

**Run `migration_v2.sql` in Supabase before running the agent** — the RPC functions and tables it
depends on must exist first.

The `frontend/` Express server calls the same three RPCs directly (via the Supabase service-role
key) to power its own slot booking UI, independent of the agent — see
[server/routes.ts](frontend/server/routes.ts). Its `/api/chat` endpoint invokes the deployed
Bedrock AgentCore runtime for the chatbot widget and falls back to canned keyword-matched
responses if the runtime isn't configured or the call fails — see
[server/app.ts](frontend/server/app.ts).

## Project Structure

```
SetHaul/
├── AGENTS.md                    # AI coding assistant context (AgentCore schema reference)
├── agentcore/
│   ├── agentcore.json           # Runtime, env vars, and credential provider config
│   ├── aws-targets.json         # Deployment target (AWS account + region)
│   ├── .env.local               # Local secrets (gitignored)
│   ├── .llm-context/            # TypeScript type defs for the agentcore.json schema
│   └── cdk/                     # CDK infra (@aws/agentcore-cdk) — deploy via `agentcore deploy`
├── app/SetHaul/                  # Agent application code
│   ├── main.py                  # BedrockAgentCoreApp entrypoint
│   ├── agentcore_app.py         # Maps AgentCore invoke payloads to the LangChain chain
│   ├── agent.py                 # Tools, system prompt, and the dispatch chain itself
│   ├── schema.py                # Pydantic models/enums for tool inputs and DB writes
│   ├── model/load.py            # Model client + AgentCore Identity API key resolution
│   ├── observability.py         # OTel metrics (messages loaded, response length)
│   └── mcp_client/              # MCP client helper (not currently wired into the agent)
└── frontend/                     # FleetPulse driver web app (React + Express, Vite build)
    ├── server.ts                # Dev/prod entrypoint — Vite middleware or static `dist/`
    ├── server/
    │   ├── app.ts                # Express app, request logging, `/api/chat` (agent proxy + fallback)
    │   ├── routes.ts             # Driver/shipment/dock-slot REST API (reads/writes Supabase directly)
    │   ├── supabaseClient.ts     # Supabase client (service-role key, server-side only)
    │   ├── shipmentShaping.ts    # Joins raw shipment rows into the client-facing Shipment view
    │   └── bedrockAgentCore.ts   # Bedrock AgentCore invoke client + reply parsing
    ├── api/index.ts             # Vercel serverless entrypoint (wraps the Express app)
    └── src/
        ├── App.tsx               # Tab shell: active shipment, dock booking, history, profile
        ├── components/
        │   ├── ActiveShipment/   # Current load status + issue reporting
        │   ├── SlotBooking/      # Dock slot browsing/hold/confirm UI
        │   ├── History/          # Completed/cancelled shipment history
        │   ├── Profile/          # Driver profile view
        │   ├── Auth/             # Demo login (localStorage-based, no real auth)
        │   └── Chatbot/          # Chat widget calling the agent via `/api/chat`
        └── api/client.ts         # Typed fetch wrappers for the `/api/*` routes
```

## Tools

| Tool | Purpose |
| --- | --- |
| `get_driver_shipment_details` | Look up a driver's active shipment |
| `check_existing_open_exception` | Avoid duplicate exception rows on retries |
| `record_exception` | Insert or update a driver-reported exception |
| `record_eta_update` | Append a driver-declared ETA (additive audit trail) |
| `check_slot_availability` | Only source of truth for feasible, available dock slots |
| `hold_slot` / `confirm_slot` / `release_hold` | Atomic slot lifecycle via Postgres RPCs |
| `get_appointment_status` | Current pending/confirmed appointment for a shipment |
| `escalate_to_human` | Hand off when no feasible slot, contradictory info, or outside automated authority |

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `sethaul_supabase_api_key` (identity) / `SUPABASE_KEY` (local) | Yes | Supabase API key |
| `sethaul_open_router_api_key` (identity) / `OPEN_ROUTER_API_KEY` (local) | Yes | OpenRouter API key (Gemini via OpenRouter) |
| `REDIS_URL` | Yes | Redis connection string |
| `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` | No | LangSmith tracing |
| `LOCAL_DEV` | No | Set to `1` to read secrets from `.env.local` instead of AgentCore Identity |

In deployed environments, API keys are resolved through AgentCore Identity credential providers
(`sethaul_supabase_api_key`, `sethaul_open_router_api_key`) rather than plain env vars — see
[model/load.py](app/SetHaul/model/load.py).

### Frontend (`frontend/.env`, see `.env.example`)

| Variable | Required | Description |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Same Supabase project as the agent |
| `SUPABASE_KEY` | Yes | Supabase **service-role** key (server-side only — never expose to the browser or prefix with `VITE_`) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | No | Credentials for invoking Bedrock AgentCore; omit to use an IAM role / `aws configure` profile |
| `BEDROCK_AGENTCORE_RUNTIME_ARN` | No | ARN of the deployed agent runtime; if unset, `/api/chat` falls back to canned responses |
| `APP_URL` | No | Self-referential app URL (auto-injected by AI Studio/Cloud Run) |

## Development

```bash
agentcore dev                                    # run the agent locally with hot-reload
agentcore invoke --dev "What can you do"         # invoke the local agent server
```

Or run the chat loop directly for a quick manual test:

```bash
cd app/SetHaul
python agent.py
```

For the frontend:

```bash
cd frontend
npm install
npm run dev      # Express + Vite dev server on http://localhost:3000
```

## Deployment

```bash
agentcore deploy    # synthesize CDK and deploy to AWS
agentcore status    # check deployment status
agentcore invoke    # invoke the deployed agent
```

The frontend deploys separately (see `frontend/vercel.json`):

```bash
cd frontend
npm run build       # vite build + esbuild server bundle to dist/
npm run start        # serve dist/ with the bundled Express server
```

See [AGENTS.md](AGENTS.md) for the full AgentCore schema reference and CLI command list.
