from typing import Optional

from agent import (
    setuhaul_dispatch_chain,
    log_chat_message,
    session_manager,
    get_driver,
    verify_driver_phone,
    create_conversation,
)


def _authenticate(thread_id: str, payload: dict, log) -> Optional[str]:
    """
    Authenticate a driver for this session via payload fields, mirroring the
    interactive authenticate_driver()/start_driver_session() CLI flow.

    Returns an error string on failure, or None on success.
    """
    driver_id = payload.get("driver_id")
    phone = payload.get("phone") or payload.get("mobile_number")

    if not driver_id or not phone:
        return (
            "Driver session not found or not authenticated. "
            "Provide 'driver_id' and 'phone' in the payload to authenticate."
        )

    driver_id = driver_id.strip().upper()
    driver = get_driver(driver_id)
    if not driver:
        return f"Driver '{driver_id}' was not found."

    status = driver.get("status")
    if status and str(status).lower() != "active":
        return "This driver account is not active."

    if not verify_driver_phone(driver_id, phone):
        return "Mobile number verification failed."

    if not create_conversation(thread_id, driver_id):
        log.warning("Conversation could not be persisted to Supabase for %s", thread_id)

    session_manager.update(
        thread_id,
        driver_id=driver_id,
        authenticated=True,
        mobile_verified=True,
        auth_method="driver_id_and_registered_phone",
    )
    log.info(f"Driver {driver_id} authenticated for session {thread_id}")
    return None


async def handle_invoke(payload: dict, context, log) -> dict:
    thread_id = payload.get("thread_id") or getattr(context, "session_id", "default-session")

    state = session_manager.get_state(thread_id)
    authenticated = bool(state) and state.get("authenticated") is True

    if not authenticated:
        auth_error = _authenticate(thread_id, payload, log)
        if auth_error:
            return {"error": auth_error}

    prompt = payload.get("prompt") or payload.get("user_input")

    if not prompt:
        if not authenticated:
            return {"result": "Authentication successful. Send a 'prompt' to start chatting."}
        return {"error": "Provide 'prompt' or 'user_input'."}

    log.info(f"Agent input: {prompt}")

    log_chat_message(thread_id, None, "driver", prompt)

    response = await setuhaul_dispatch_chain.ainvoke({
        "request_id": thread_id,
        "chat_history": "",
        "message": prompt,
    })
    output = response.content

    log_chat_message(thread_id, None, "assistant", output)
    log.info(f"Agent output: {output}")

    return {"result": output}
