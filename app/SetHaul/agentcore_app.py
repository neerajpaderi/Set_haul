from agent import setuhaul_dispatch_chain, log_chat_message


async def handle_invoke(payload: dict, context, log) -> dict:
    prompt = payload.get("prompt") or payload.get("user_input")

    if not prompt:
        return {"error": "Provide 'prompt' or 'user_input'."}

    thread_id = payload.get("thread_id") or getattr(context, "session_id", "default-session")
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
