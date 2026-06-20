/**
 * mock.js — Deterministic mock LLM provider for testing.
 * Set LLM_PROVIDER=mock in test environments — never calls a live API.
 *
 * Returns a predictable JSON response that passes basic schema checks.
 */

async function complete({ system, messages, model, maxTokens }) {
  const lastMessage = messages?.[messages.length - 1]?.content ?? '';

  // Return a minimal valid response that won't crash callers
  const mockResponse = JSON.stringify({
    hasEvent: false,
    action: 'ignore',
    reason: '[mock] test response',
    _mock: true,
  });

  return {
    text: mockResponse,
    inputTokens: 10,
    outputTokens: 10,
  };
}

module.exports = { complete };
