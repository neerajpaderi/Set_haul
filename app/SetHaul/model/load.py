import os
from langchain_google_genai import ChatGoogleGenerativeAI
from bedrock_agentcore.identity.auth import requires_api_key

IDENTITY_PROVIDER_NAME = "sethaul_open_router_api_key"
IDENTITY_ENV_VAR = "OPEN_ROUTER_API_KEY"

SUPABASE_IDENTITY_PROVIDER_NAME = "sethaul_supabase_api_key"
SUPABASE_IDENTITY_ENV_VAR = "SUPABASE_KEY"


def _fetch_identity_api_key(provider_name: str) -> str:
    @requires_api_key(provider_name=provider_name)
    def _fetch(api_key: str) -> str:
        return api_key
    return _fetch()


def get_api_key(provider_name: str, local_env_var: str) -> str:
    """
    Fetch an API key by name via AgentCore Identity in deployed environments.
    For local development, run via 'agentcore dev' which loads agentcore/.env.local
    and falls back to reading local_env_var directly.
    """
    if os.getenv("LOCAL_DEV") == "1":
        api_key = os.getenv(local_env_var)
        if not api_key:
            raise RuntimeError(
                f"{local_env_var} not found. Add {local_env_var}=your-key to .env.local"
            )
        return api_key
    return _fetch_identity_api_key(provider_name)


def load_model() -> ChatGoogleGenerativeAI:
    """Get authenticated Gemini model client."""
    return ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        api_key=get_api_key(IDENTITY_PROVIDER_NAME, IDENTITY_ENV_VAR)
    )
