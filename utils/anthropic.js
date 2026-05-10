const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk').Anthropic || require('@anthropic-ai/sdk');
const NotificationFailureLog = require('../models/NotificationFailureLog');

const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TRIES = 3;
const RETRY_DELAY_MS = 2000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function logFailure(callerId, errMessage) {
  try {
    await NotificationFailureLog.create({
      service: 'Anthropic',
      error: errMessage,
      attempts: MAX_TRIES,
      params: { callerId },
    });
  } catch (logErr) {
    console.error(`[anthropic] failed to write NotificationFailureLog: ${logErr.message}`);
  }
}

async function callWithTool({ system, messages, tool, callerId }) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system,
        messages,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
      });

      const toolUse = (response.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (!toolUse) {
        await logFailure(callerId, 'no tool_use in response');
        return null;
      }
      return toolUse.input;
    } catch (err) {
      lastError = err;
      const status = err && err.status ? ` [${err.status}]` : '';
      console.log(`[anthropic] ${callerId} retry ${attempt}/${MAX_TRIES} after error: ${err.message}${status}`);
      if (attempt < MAX_TRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const status = lastError && lastError.status ? ` [${lastError.status}]` : '';
  await logFailure(callerId, `${lastError ? lastError.message : 'unknown error'}${status}`);
  return null;
}

module.exports = { callWithTool, ANTHROPIC_MODEL };
