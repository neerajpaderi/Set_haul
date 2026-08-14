import { randomUUID } from 'crypto';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

// Returns null (not a throw) when unconfigured so callers can fall back to
// the canned local responses instead of hard-failing.
export const getBedrockAgentCoreClient = () => {
  const runtimeArn = process.env.BEDROCK_AGENTCORE_RUNTIME_ARN;
  const region = process.env.AWS_REGION;
  if (!runtimeArn || !region) return null;
  // Credentials resolved via the AWS SDK v3 default credential provider chain
  // (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN env vars,
  // or an IAM role / shared profile if those aren't set).
  return new BedrockAgentCoreClient({ region });
};

export const invokeAgentCore = async (payloadObj: unknown): Promise<string> => {
  const client = getBedrockAgentCoreClient();
  const runtimeArn = process.env.BEDROCK_AGENTCORE_RUNTIME_ARN;
  if (!client || !runtimeArn) {
    throw new Error('Bedrock AgentCore is not configured (missing AWS_REGION or BEDROCK_AGENTCORE_RUNTIME_ARN)');
  }

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    // runtimeSessionId must be 33-256 chars. A fresh id per request is fine
    // since the UI already resends full conversation history each turn.
    runtimeSessionId: `session-${randomUUID()}`,
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify(payloadObj)),
  });

  const response = await client.send(command);
  if (!response.response) return '';
  return response.response.transformToString('utf-8');
};

// Confirmed via smoke test against the live agent: it replies with
// {"result": "..."} (and {"error": "..."} when the request is malformed,
// e.g. missing `prompt`/`user_input` — that case falls through to `null`
// below since `error` isn't a recognized key, triggering the canned fallback).
// The other candidate keys are kept as defensive fallbacks in case the
// agent's contract changes or varies by input.
export const extractAgentReplyText = (rawBody: string): string | null => {
  if (!rawBody) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Not JSON — treat the whole body as the reply text.
    const trimmed = rawBody.trim();
    return trimmed || null;
  }

  const candidateKeys = ['result', 'text', 'output', 'completion', 'message'];

  for (const key of candidateKeys) {
    if (typeof parsed?.[key] === 'string' && parsed[key].trim()) {
      return parsed[key];
    }
  }

  // Bedrock Converse-style nested shape.
  const converseText = parsed?.output?.message?.content?.[0]?.text;
  if (typeof converseText === 'string' && converseText.trim()) {
    return converseText;
  }

  // Some agents wrap their reply under a `response` or `data` object.
  for (const wrapperKey of ['response', 'data']) {
    const wrapper = parsed?.[wrapperKey];
    if (wrapper && typeof wrapper === 'object') {
      for (const key of candidateKeys) {
        if (typeof wrapper[key] === 'string' && wrapper[key].trim()) {
          return wrapper[key];
        }
      }
    }
  }

  return null;
};
