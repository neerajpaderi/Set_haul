from opentelemetry.instrumentation.langchain import LangchainInstrumentor
from bedrock_agentcore.runtime import BedrockAgentCoreApp

import agentcore_app

LangchainInstrumentor().instrument()

app = BedrockAgentCoreApp()
log = app.logger


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")
    return await agentcore_app.handle_invoke(payload, context, log)


if __name__ == "__main__":
    app.run()
