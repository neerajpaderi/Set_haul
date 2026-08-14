# SetHaul

SetuHaul's driver exception & dock slot coordination agent — a conversational assistant that
truck drivers message about delivery delays, ETAs, and dock appointment booking. Built on
LangChain/LangGraph, deployed to Amazon Bedrock AgentCore Runtime, backed by Supabase (Postgres).

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
└── app/SetHaul/                 # Agent application code
    ├── main.py                  # BedrockAgentCoreApp entrypoint
    ├── agentcore_app.py         # Maps AgentCore invoke payloads to the LangChain chain
    ├── agent.py                 # Tools, system prompt, and the dispatch chain itself
    ├── schema.py                # Pydantic models/enums for tool inputs and DB writes
    ├── model/load.py            # Model client + AgentCore Identity API key resolution
    ├── observability.py         # OTel metrics (messages loaded, response length)
    └── mcp_client/              # MCP client helper (not currently wired into the agent)
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

## Development

```bash
agentcore dev                                    # run locally with hot-reload
agentcore invoke --dev "What can you do"         # invoke the local server
```

Or run the chat loop directly for a quick manual test:

```bash
cd app/SetHaul
python agent.py
```

## Deployment

```bash
agentcore deploy    # synthesize CDK and deploy to AWS
agentcore status    # check deployment status
agentcore invoke    # invoke the deployed agent
```

See [AGENTS.md](AGENTS.md) for the full AgentCore schema reference and CLI command list.
