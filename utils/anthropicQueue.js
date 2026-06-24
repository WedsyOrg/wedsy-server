const axios = require('axios');

// MB6 Slice 11 — ONE in-process Anthropic queue shared by the WhatsApp and
// Instagram agents. Calls are serialized (single node process), and a 429
// backs the whole queue off exponentially before the request retries — a
// burst of webhooks can no longer stampede the API. Behavior is otherwise
// identical: callers keep their own retry/FailureLog semantics for non-429
// errors, because this module re-throws those untouched.
const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_429_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialize requests: the same promise-chain idiom LeadAssignmentService uses.
let queue = Promise.resolve();

const post = async (payload) =>
  axios.post(ANTHROPIC_API_URL, payload, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
  });

const is429 = (error) => !!(error && error.response && error.response.status === 429);

const runWithBackoff = async (payload) => {
  let backoff = BASE_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await post(payload);
    } catch (error) {
      if (!is429(error) || attempt >= MAX_429_RETRIES) throw error;
      console.warn(`[AnthropicQueue] 429 — backing off ${backoff}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
};

// The one entry point: enqueue an Anthropic messages call. Resolves with the
// axios response; rejects with the original error for non-429 failures (and
// for a 429 that survived every backoff).
const callAnthropic = (payload) => {
  const task = queue.then(() => runWithBackoff(payload));
  queue = task.catch(() => {}); // a failed call never wedges the queue
  return task;
};

module.exports = { callAnthropic };
