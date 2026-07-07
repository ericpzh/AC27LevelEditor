/**
 * Unit tests for electron/cloud-llm.js — remote model calls & chat orchestration.
 *
 * Mock strategy: cloud-llm.js is CommonJS.  vitestʼs vi.mock only intercepts
 * ESM imports, not CJS requires.  We therefore prime Nodeʼs require cache
 * BEFORE loading cloud-llm so the OpenAI / Anthropic SDKs are stubbed out.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Module from 'module';

// ── Mock SDK instances ───────────────────────────────────────────
let mockOpenAICreate;
let mockAnthropicCreate;

function createMockOpenAI() {
  const create = vi.fn();
  mockOpenAICreate = create;
  const MockOpenAI = vi.fn(function (opts) {
    this._opts = opts;
    this.chat = { completions: { create } };
  });
  // Mimic the real package: module.exports is a function (constructor proxy)
  return MockOpenAI;
}

function createMockAnthropic() {
  const create = vi.fn();
  mockAnthropicCreate = create;
  const MockAnthropic = vi.fn(function (opts) {
    this._opts = opts;
    this.messages = { create };
  });
  return MockAnthropic;
}

// ── Helpers ──────────────────────────────────────────────────────

function primeCache() {
  // Stub the SDK packages in Node's require cache BEFORE cloud-llm loads them
  require.cache[require.resolve('openai')] = {
    id: require.resolve('openai'),
    filename: require.resolve('openai'),
    loaded: true,
    exports: createMockOpenAI(),
  };
  require.cache[require.resolve('@anthropic-ai/sdk')] = {
    id: require.resolve('@anthropic-ai/sdk'),
    filename: require.resolve('@anthropic-ai/sdk'),
    loaded: true,
    exports: createMockAnthropic(),
  };
}

function clearCache() {
  delete require.cache[require.resolve('openai')];
  delete require.cache[require.resolve('@anthropic-ai/sdk')];
  delete require.cache[require.resolve('../../electron/cloud-llm')];
}

// Reset mocks between tests
beforeEach(() => {
  clearCache();
  primeCache();
});

afterEach(() => {
  clearCache();
});

// Dynamic require after cache priming
function getCloudLLM() {
  return require('../../electron/cloud-llm');
}

// ── Test data ────────────────────────────────────────────────────

const MOCK_MCP_TOOLS = [
  {
    name: 'get_airport_info',
    description: 'Get the full constraint map for the current airport.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_flights',
    description: 'Create flights in the editor.',
    inputSchema: {
      type: 'object',
      properties: {
        flights: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 500 },
      },
      required: ['flights'],
    },
  },
];

// ══════════════════════════════════════════════════════════════════
//  VENDORS & model lookup
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — VENDORS registry', () => {
  it('has entries for all four vendors', () => {
    const { VENDORS } = getCloudLLM();
    expect(VENDORS).toHaveProperty('deepseek');
    expect(VENDORS).toHaveProperty('gemini');
    expect(VENDORS).toHaveProperty('claude');
    expect(VENDORS).toHaveProperty('codex');
  });

  it('every vendor has name, icon, and models', () => {
    for (const [key, v] of Object.entries(getCloudLLM().VENDORS)) {
      expect(v.name, `${key}: name`).toBeTruthy();
      expect(typeof v.name).toBe('string');
      expect(v.icon, `${key}: icon`).toBeTruthy();
      expect(Array.isArray(v.models), `${key}: models is array`).toBe(true);
      expect(v.models.length, `${key}: models non-empty`).toBeGreaterThanOrEqual(1);
    }
  });

  it('OpenAI-compatible vendors have a baseURL', () => {
    const { VENDORS } = getCloudLLM();
    expect(VENDORS.deepseek.baseURL).toBe('https://api.deepseek.com');
    expect(VENDORS.gemini.baseURL).toContain('generativelanguage.googleapis.com');
    expect(VENDORS.codex.baseURL).toBe('https://api.openai.com/v1');
  });

  it('Claude has no baseURL (uses Anthropic SDK)', () => {
    expect(getCloudLLM().VENDORS.claude.baseURL).toBeUndefined();
  });

  it('model lists match expectations', () => {
    const { VENDORS } = getCloudLLM();
    expect(VENDORS.deepseek.models).toContain('deepseek-v4-pro');
    expect(VENDORS.deepseek.models).toContain('deepseek-v4-flash');
    expect(VENDORS.gemini.models).toContain('gemini-2.5-pro');
    expect(VENDORS.gemini.models).toContain('gemini-2.5-flash');
    expect(VENDORS.claude.models).toContain('claude-sonnet-4-6');
    expect(VENDORS.claude.models).toContain('claude-haiku-4-5');
    expect(VENDORS.codex.models).toContain('gpt-4o');
    expect(VENDORS.codex.models).toContain('gpt-4o-mini');
  });
});

describe('cloud-llm — getVendorForModel', () => {
  it('returns vendor info for a known model', () => {
    const result = getCloudLLM().getVendorForModel('deepseek-v4-pro');
    expect(result).toBeTruthy();
    expect(result.key).toBe('deepseek');
    expect(result.name).toBe('DeepSeek');
  });

  it.each([
    ['gemini-2.5-pro', 'gemini', 'Gemini'],
    ['gemini-2.5-flash', 'gemini', 'Gemini'],
    ['claude-sonnet-4-6', 'claude', 'Claude'],
    ['claude-haiku-4-5', 'claude', 'Claude'],
    ['gpt-4o', 'codex', 'Codex'],
    ['gpt-4o-mini', 'codex', 'Codex'],
    ['deepseek-v4-flash', 'deepseek', 'DeepSeek'],
  ])('model %s → vendor %s (%s)', (model, expectedKey, expectedName) => {
    const result = getCloudLLM().getVendorForModel(model);
    expect(result.key).toBe(expectedKey);
    expect(result.name).toBe(expectedName);
  });

  it('returns null for unknown model or empty string', () => {
    const { getVendorForModel } = getCloudLLM();
    expect(getVendorForModel('nonexistent-model')).toBeNull();
    expect(getVendorForModel('')).toBeNull();
  });

  it('includes baseURL for non-claude vendors', () => {
    const { getVendorForModel } = getCloudLLM();
    expect(getVendorForModel('deepseek-v4-flash').baseURL).toBe('https://api.deepseek.com');
    expect(getVendorForModel('gemini-2.5-flash').baseURL).toContain('generativelanguage.googleapis.com');
    expect(getVendorForModel('gpt-4o-mini').baseURL).toBe('https://api.openai.com/v1');
  });
});

// ══════════════════════════════════════════════════════════════════
//  getAvailableModels
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — getAvailableModels', () => {
  it('returns empty array when no keys are set', () => {
    const config = { deepseekKey: '', geminiKey: '', claudeKey: '', codexKey: '' };
    expect(getCloudLLM().getAvailableModels(config)).toEqual([]);
  });

  it('returns DeepSeek models when deepseekKey is set', () => {
    const config = { deepseekKey: 'sk-abc', geminiKey: '', claudeKey: '', codexKey: '' };
    const models = getCloudLLM().getAvailableModels(config);
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.vendor).toBe('deepseek');
      expect(m.vendorName).toBe('DeepSeek');
      expect(m.icon).toBeTruthy();
    }
  });

  it('returns all vendors models when all keys are set', () => {
    const config = { deepseekKey: 'sk-a', geminiKey: 'sk-b', claudeKey: 'sk-c', codexKey: 'sk-d' };
    const models = getCloudLLM().getAvailableModels(config);
    expect(models).toHaveLength(8); // 4 vendors × 2 models each
    const vendors = new Set(models.map(m => m.vendor));
    expect(vendors.has('deepseek')).toBe(true);
    expect(vendors.has('gemini')).toBe(true);
    expect(vendors.has('claude')).toBe(true);
    expect(vendors.has('codex')).toBe(true);
  });

  it('filters out vendors whose key field is missing entirely', () => {
    const config = { deepseekKey: 'sk-a' };
    const models = getCloudLLM().getAvailableModels(config);
    const vendors = new Set(models.map(m => m.vendor));
    expect(vendors.size).toBe(1);
    expect(vendors.has('deepseek')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  mcpToolsToOpenAITools
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — mcpToolsToOpenAITools', () => {
  it('converts MCP tools to OpenAI function format', () => {
    const result = getCloudLLM().mcpToolsToOpenAITools(MOCK_MCP_TOOLS);
    expect(result).toHaveLength(2);

    expect(result[0].type).toBe('function');
    expect(result[0].function.name).toBe('get_airport_info');
    expect(result[0].function.description).toBe('Get the full constraint map for the current airport.');
    expect(result[0].function.parameters.type).toBe('object');
    expect(result[0].function.parameters.properties).toEqual({});
    expect(result[0].function.parameters.required).toEqual([]);

    expect(result[1].function.name).toBe('create_flights');
    expect(result[1].function.parameters.properties).toHaveProperty('flights');
    expect(result[1].function.parameters.required).toContain('flights');
  });

  it('preserves minItems / maxItems for non-Gemini use', () => {
    const result = getCloudLLM().mcpToolsToOpenAITools(MOCK_MCP_TOOLS);
    const flightsProp = result[1].function.parameters.properties.flights;
    expect(flightsProp.minItems).toBe(1);
    expect(flightsProp.maxItems).toBe(500);
  });

  it('returns empty array for empty input', () => {
    expect(getCloudLLM().mcpToolsToOpenAITools([])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  sanitizeToolsForVendor (now exported for testing)
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — sanitizeToolsForVendor', () => {
  function makeTools() {
    return getCloudLLM().mcpToolsToOpenAITools(MOCK_MCP_TOOLS);
  }

  it('leaves tools unchanged for non-Gemini baseURL', () => {
    const result = getCloudLLM().sanitizeToolsForVendor(makeTools(), 'https://api.deepseek.com');
    const flightsProp = result[1].function.parameters.properties.flights;
    expect(flightsProp.minItems).toBe(1);
    expect(flightsProp.maxItems).toBe(500);
  });

  it('strips OpenAI-only keywords for Gemini', () => {
    const result = getCloudLLM().sanitizeToolsForVendor(makeTools(), 'https://generativelanguage.googleapis.com/v1beta/openai');
    const flightsProp = result[1].function.parameters.properties.flights;
    expect(flightsProp.minItems).toBeUndefined();
    expect(flightsProp.maxItems).toBeUndefined();
    expect(flightsProp.type).toBe('array'); // preserved
  });

  it('strips const and default keywords for Gemini', () => {
    const withConst = [{
      type: 'function',
      function: {
        name: 'test',
        description: '',
        parameters: {
          type: 'object',
          properties: { mode: { type: 'string', const: 'auto', default: 'manual' } },
        },
      },
    }];
    const result = getCloudLLM().sanitizeToolsForVendor(withConst, 'https://generativelanguage.googleapis.com/v1beta/openai');
    const mode = result[0].function.parameters.properties.mode;
    expect(mode.const).toBeUndefined();
    expect(mode.default).toBeUndefined();
  });

  it('returns null/undefined unchanged', () => {
    const { sanitizeToolsForVendor } = getCloudLLM();
    expect(sanitizeToolsForVendor(null, 'https://api.deepseek.com')).toBeNull();
    expect(sanitizeToolsForVendor(undefined, 'https://api.deepseek.com')).toBeUndefined();
  });

  it('strips nested minItems/maxItems from items schemas', () => {
    const withNested = [{
      type: 'function',
      function: {
        name: 'nested_test',
        description: '',
        parameters: {
          type: 'object',
          properties: {
            flights: {
              type: 'array', minItems: 1, maxItems: 100,
              items: {
                type: 'object',
                properties: {
                  codes: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    }];
    const result = getCloudLLM().sanitizeToolsForVendor(withNested, 'https://generativelanguage.googleapis.com/v1beta/openai');
    const flights = result[0].function.parameters.properties.flights;
    expect(flights.minItems).toBeUndefined();
    expect(flights.maxItems).toBeUndefined();
    expect(flights.items.properties.codes.minItems).toBeUndefined();
    expect(flights.items.properties.codes.maxItems).toBeUndefined();
  });

  it('does not strip for null/empty baseURL', () => {
    const tools = makeTools();
    const { sanitizeToolsForVendor } = getCloudLLM();
    expect(sanitizeToolsForVendor(tools, null)[1].function.parameters.properties.flights.minItems).toBe(1);
    expect(sanitizeToolsForVendor(tools, '')[1].function.parameters.properties.flights.minItems).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  chat — entry errors (no SDK call needed)
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — chat entry errors', () => {
  it.each([
    ['unknown model', 'unknown-model-xyz', 'Unknown model'],
    ['nonexistent vendor model', 'gpt-5-ultra', 'Unknown model'],
  ])('throws for %s', async (_, model, expectedMsg) => {
    await expect(
      getCloudLLM().chat(
        [{ role: 'user', content: 'hi' }],
        [],
        async () => {},
        { deepseekKey: 'sk-test', selectedModel: model },
      ),
    ).rejects.toThrow(expectedMsg);
  });

  it('throws when API key is empty for the selected model', async () => {
    await expect(
      getCloudLLM().chat(
        [{ role: 'user', content: 'hi' }],
        [],
        async () => {},
        { deepseekKey: '', selectedModel: 'deepseek-v4-pro' },
      ),
    ).rejects.toThrow('No API key for DeepSeek');
  });

  it('throws when API key field is missing entirely', async () => {
    await expect(
      getCloudLLM().chat(
        [{ role: 'user', content: 'hi' }],
        [],
        async () => {},
        { selectedModel: 'deepseek-v4-pro' },
      ),
    ).rejects.toThrow('No API key');
  });

  it('throws for Claude when claudeKey is missing', async () => {
    await expect(
      getCloudLLM().chat(
        [{ role: 'user', content: 'hi' }],
        [],
        async () => {},
        { claudeKey: '', selectedModel: 'claude-sonnet-4-6' },
      ),
    ).rejects.toThrow('No API key for Claude');
  });
});

// ══════════════════════════════════════════════════════════════════
//  chat — success, OpenAI path (DeepSeek / Gemini / Codex)
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — chat success (OpenAI path)', () => {
  it('returns content from a single-turn conversation', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hello from DeepSeek!', tool_calls: [] } }],
    });

    const result = await getCloudLLM().chat(
      [{ role: 'user', content: 'Hello!' }],
      [],
      async () => {},
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    expect(result.content).toBe('Hello from DeepSeek!');
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);

    const body = mockOpenAICreate.mock.calls[0][0];
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.stream).toBe(false);

    // Auto-generated system message
    const sysMsg = body.messages.find(m => m.role === 'system');
    expect(sysMsg).toBeTruthy();
    expect(sysMsg.content).toContain('AC27 Editor');
  });

  it('preserves existing system message instead of auto-generating', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'I understand.', tool_calls: [] } }],
    });

    await getCloudLLM().chat(
      [
        { role: 'system', content: 'You are a test bot.' },
        { role: 'user', content: 'Hi' },
      ],
      [],
      async () => {},
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    const body = mockOpenAICreate.mock.calls[0][0];
    expect(body.messages[0].content).toBe('You are a test bot.');
  });
});

// ══════════════════════════════════════════════════════════════════
//  chat — tool calling loop (OpenAI path)
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — chat with tool calls (OpenAI path)', () => {
  it('handles tool_calls and continues until final response', async () => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Let me check.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_airport_info', arguments: '{}' } }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Airport ZSJN has 2 runways.', tool_calls: [] } }],
      });

    const onToolCall = vi.fn().mockResolvedValue({ result: { runways: ['01', '19'] } });

    const { chat, mcpToolsToOpenAITools } = getCloudLLM();
    const tools = mcpToolsToOpenAITools([{
      name: 'get_airport_info',
      description: 'Get airport info',
      inputSchema: { type: 'object', properties: {}, required: [] },
    }]);

    const result = await chat(
      [{ role: 'user', content: 'What runways?' }],
      tools,
      onToolCall,
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0][0].function.name).toBe('get_airport_info');
    expect(result.content).toContain('ZSJN');
  });

  it('gracefully handles tool call errors', async () => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_err', type: 'function', function: { name: 'bad_tool', arguments: '{}' } }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Tool failed but I can still help.', tool_calls: [] } }],
      });

    const onToolCall = vi.fn().mockRejectedValue(new Error('Tool crashed'));

    const { chat } = getCloudLLM();
    const result = await chat(
      [{ role: 'user', content: 'Try the bad tool' }],
      [{ function: { name: 'bad_tool', description: '', parameters: { type: 'object', properties: {}, required: [] } } }],
      onToolCall,
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('Tool failed');
  });

  it('handles malformed JSON arguments in tool calls', async () => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            tool_calls: [{ id: 'bad_json', type: 'function', function: { name: 'test', arguments: 'not valid json' } }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Recovered from bad args.', tool_calls: [] } }],
      });

    const onToolCall = vi.fn().mockResolvedValue({ result: 'ok' });

    const { chat } = getCloudLLM();
    await chat(
      [{ role: 'user', content: 'Test' }],
      [{ function: { name: 'test', description: '', parameters: { type: 'object', properties: {}, required: [] } } }],
      onToolCall,
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    expect(onToolCall).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
//  Conversation tracking & loop continuation
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — conversation tracking across turns', () => {
  it('preserves conversation history across tool-call iterations', async () => {
    // Two tool calls then final text → 3 API calls total
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Checking tool A...',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'tool_a', arguments: '{}' } }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Checking tool B...',
            tool_calls: [{ id: 't2', type: 'function', function: { name: 'tool_b', arguments: '{"x":1}' } }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'All tools done. Here is the final answer.', tool_calls: [] } }],
      });

    const onToolCall = vi.fn()
      .mockResolvedValueOnce({ result: 'ok_a' })
      .mockResolvedValueOnce({ result: 'ok_b' });

    const { chat } = getCloudLLM();
    const result = await chat(
      [{ role: 'user', content: 'Use both tools' }],
      [
        { function: { name: 'tool_a', description: '', parameters: { type: 'object', properties: {}, required: [] } } },
        { function: { name: 'tool_b', description: '', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: [] } } },
      ],
      onToolCall,
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    expect(mockOpenAICreate).toHaveBeenCalledTimes(3);
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(onToolCall.mock.calls[0][0].function.name).toBe('tool_a');
    expect(onToolCall.mock.calls[1][0].function.name).toBe('tool_b');
    expect(result.content).toBe('All tools done. Here is the final answer.');

    // Verify conversation grew across calls
    const lastBody = mockOpenAICreate.mock.calls[2][0];
    const msgs = lastBody.messages;
    // system + user + assistant(tool_a) + tool_result_a + assistant(tool_b) + tool_result_b
    expect(msgs.length).toBeGreaterThanOrEqual(6);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Gemini sanitization via chat
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — chat with Gemini (sanitization applied)', () => {
  it('strips OpenAI keywords before sending to Gemini', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Done!', tool_calls: [] } }],
    });

    const { chat, mcpToolsToOpenAITools } = getCloudLLM();
    const tools = mcpToolsToOpenAITools(MOCK_MCP_TOOLS);

    await chat(
      [{ role: 'user', content: 'Do something' }],
      tools,
      async () => {},
      { geminiKey: 'sk-test', selectedModel: 'gemini-2.5-pro' },
    );

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    const body = mockOpenAICreate.mock.calls[0][0];
    const flightsProp = body.tools[1].function.parameters.properties.flights;
    expect(flightsProp.minItems).toBeUndefined();
    expect(flightsProp.maxItems).toBeUndefined();
    expect(flightsProp.type).toBe('array');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Claude path (Anthropic SDK)
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — Claude (Anthropic path)', () => {
  it('uses Anthropic SDK and returns content', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello from Claude!' }],
    });

    const result = await getCloudLLM().chat(
      [{ role: 'user', content: 'Hi Claude' }],
      [],
      async () => {},
      { claudeKey: 'sk-ant-test', selectedModel: 'claude-sonnet-4-6' },
    );

    expect(result.content).toBe('Hello from Claude!');
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);

    const body = mockAnthropicCreate.mock.calls[0][0];
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBeDefined();
    expect(body.system[0].type).toBe('text');
  });

  it('converts tools to Anthropic input_schema format', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Got the tools.' }],
    });

    const { chat } = getCloudLLM();
    await chat(
      [{ role: 'user', content: 'Use tools' }],
      [{ function: { name: 'test_tool', description: 'A test tool', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } } }],
      async () => {},
      { claudeKey: 'sk-ant-test', selectedModel: 'claude-haiku-4-5' },
    );

    const body = mockAnthropicCreate.mock.calls[0][0];
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('test_tool');
    expect(body.tools[0].input_schema.type).toBe('object');
    expect(body.tools[0].input_schema.properties).toEqual({ x: { type: 'string' } });
  });

  it('handles Claude tool_use → loop → final text', async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Let me look that up.' },
          { type: 'tool_use', id: 'tu_1', name: 'get_airport_info', input: {} },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Here is the airport info.' }],
      });

    const onToolCall = vi.fn().mockResolvedValue({ result: { airport: 'ZSJN' } });

    const { chat } = getCloudLLM();
    const result = await chat(
      [{ role: 'user', content: 'What airport?' }],
      [{ function: { name: 'get_airport_info', description: '', parameters: { type: 'object', properties: {}, required: [] } } }],
      onToolCall,
      { claudeKey: 'sk-ant-test', selectedModel: 'claude-sonnet-4-6' },
    );

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Here is the airport info.');
  });

  it('handles Claude tool errors', async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_err', name: 'broken', input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'The tool failed.' }],
      });

    const onToolCall = vi.fn().mockRejectedValue(new Error('Boom'));

    const { chat } = getCloudLLM();
    const result = await chat(
      [{ role: 'user', content: 'Use broken tool' }],
      [{ function: { name: 'broken', description: '', parameters: { type: 'object', properties: {}, required: [] } } }],
      onToolCall,
      { claudeKey: 'sk-ant-test', selectedModel: 'claude-sonnet-4-6' },
    );

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('The tool failed.');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Thinking support
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — thinking', () => {
  it('Claude: passes thinking blocks through to result + onThinking callback', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: 'thinking', thinking: 'Hmm, let me analyze this carefully...' },
        { type: 'text', text: 'Here is my answer.' },
      ],
    });

    const onThinking = vi.fn();
    const result = await getCloudLLM().chat(
      [{ role: 'user', content: 'Complex question' }],
      [],
      async () => {},
      { claudeKey: 'sk-ant-test', selectedModel: 'claude-sonnet-4-6' },
      onThinking,
    );

    expect(result.content).toBe('Here is my answer.');
    expect(result.thinking).toContain('Hmm, let me analyze');
    expect(onThinking).toHaveBeenCalledWith('Hmm, let me analyze this carefully...');
  });

  it('DeepSeek: passes reasoning_content through to result + onThinking callback', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: 'The answer is 42.',
          reasoning_content: 'DeepSeek R1 thinking deeply...',
          tool_calls: [],
        },
      }],
    });

    const onThinking = vi.fn();
    const result = await getCloudLLM().chat(
      [{ role: 'user', content: 'What is the answer?' }],
      [],
      async () => {},
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
      onThinking,
    );

    expect(result.content).toBe('The answer is 42.');
    expect(result.thinking).toContain('DeepSeek R1');
    expect(onThinking).toHaveBeenCalledWith('DeepSeek R1 thinking deeply...');
  });

  it('accumulates thinking across multi-turn tool calls', async () => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            reasoning_content: 'First thought...',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'test', arguments: '{}' } }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { content: 'Done.', reasoning_content: 'Final thought...', tool_calls: [] },
        }],
      });

    const { chat } = getCloudLLM();
    const result = await chat(
      [{ role: 'user', content: 'Think and act' }],
      [{ function: { name: 'test', description: '', parameters: { type: 'object', properties: {}, required: [] } } }],
      async () => ({ result: 'ok' }),
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    expect(result.thinking).toContain('First thought');
    expect(result.thinking).toContain('Final thought');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Empty-content nudge
// ══════════════════════════════════════════════════════════════════

describe('cloud-llm — empty-content nudge', () => {
  it('nudges OpenAI model when only thinking (no content, no tools)', async () => {
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: '', reasoning_content: 'Analyzing deeply...', tool_calls: [] } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'OK here is my summary.', reasoning_content: '', tool_calls: [] } }],
      });

    const result = await getCloudLLM().chat(
      [{ role: 'user', content: 'Help' }],
      [],
      async () => {},
      { deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' },
    );

    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('OK here is my summary.');
  });

  it('nudges Claude when only thinking (no text, no tools)', async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: 'thinking', thinking: 'Hmm let me think...' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Here is the actual answer.' }],
      });

    const result = await getCloudLLM().chat(
      [{ role: 'user', content: 'Question' }],
      [],
      async () => {},
      { claudeKey: 'sk-ant-test', selectedModel: 'claude-sonnet-4-6' },
    );

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('Here is the actual answer.');
  });
});
