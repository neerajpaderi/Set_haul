# SetuHaul — Driver Exception & Dock Slot Coordination Agent

A conversational agent for truck drivers to report delays and request revised
dock appointment slots, built for the SetuHaul FDE classroom challenge.

## Architecture

The LLM is a conversational layer only — it never decides slot availability,
priority, or double-booking outcomes. Those are enforced by atomic Postgres
RPC functions (`hold_slot_atomic`, `confirm_slot_atomic`, `release_hold_atomic`)
in `migration_v2.sql`, called via Supabase RPC. This guarantees two drivers
racing for the same slot can never both "win" it, even under concurrent load.

- `schema.py` — pydantic models and enums (tool input schemas + DB write validation)
- `agent.py` — tools, LLM binding (LangChain + OpenRouter), prompt, and CLI loop
- `migration_v2.sql` — Postgres schema additions: atomic hold/confirm/release RPCs

## Setup

1. Clone the repo and create a virtual environment:
   ```bash
   git clone https://github.com/aksh-sood/SetHaul.git
   cd SetHaul
   python -m venv venv
   source venv/bin/activate   # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and fill in real values:
   ```bash
   cp .env.example .env
   ```

3. Run `migration_v2.sql` in the Supabase SQL editor for your project
   (adds the atomic locking RPCs; assumes an existing `appointments` table
   with an `appointment_status` enum of `pending | confirmed | cancelled | superseded`).

4. Run the agent:
   ```bash
   python agent.py
   ```

## Concurrency model

Slot reservation is a two-step hold → confirm flow:
- `hold_slot` — atomically reserves a slot only if it is `available` or its
  previous hold expired. Returns `conflict` if another driver already holds it.
- `confirm_slot` — commits the hold only if it still belongs to the calling
  driver and hasn't expired. Supersedes (not overwrites) any prior confirmed
  slot for the same shipment.
- `release_hold` — lets a driver back out of a pending hold before confirming.

## Out of scope

Facility-wide scheduling optimization (multi-truck dock sequencing) is not
implemented — see the FDE brief's optional §7.3 extension for that scope.