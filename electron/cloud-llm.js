/**
 * Multi-vendor cloud LLM module.
 * DeepSeek + Gemini + Codex (OpenAI-compatible) → OpenAI SDK
 * Claude → Anthropic SDK
 */
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const VENDORS = {
  deepseek: {
    name: 'DeepSeek',
    icon: '🔵',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  gemini: {
    name: 'Gemini',
    icon: '🟢',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  claude: {
    name: 'Claude',
    icon: '🟣',
    models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    // Anthropic SDK — no baseURL, handled separately
  },
  codex: {
    name: 'Codex',
    icon: '🟡',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
};

function getVendorForModel(model) {
  for (const [key, v] of Object.entries(VENDORS)) {
    if (v.models.includes(model)) return { key, ...v };
  }
  return null;
}

function getAvailableModels(config) {
  const models = [];
  for (const [key, v] of Object.entries(VENDORS)) {
    const keyField = key + 'Key';
    if (config[keyField]) {
      for (const m of v.models) models.push({ model: m, vendor: key, vendorName: v.name, icon: v.icon });
    }
  }
  return models;
}

// ── System Prompt ──────────────────────────────────────────────

function buildSystemMessage(tools) {
  const toolList = tools ? tools.map(t =>
    `- ${t.function.name}: ${t.function.description}`
  ).join('\n') : '';

  return {
    role: 'system',
    content: `You are an AI assistant controlling the AC27 Level Editor via tools. You are NOT ChatGPT.

## TOOLS
${toolList}

## CRITICAL
- USE THE TOOLS. Do not describe what you'd do — actually call the functions.
- Always call get_airport_info before creating/modifying flights.
- Be brief. After completing the task, give a short summary.`,
  };
}

// ── Tool Conversion ────────────────────────────────────────────

function mcpToolsToOpenAITools(mcpTools) {
  return mcpTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: t.inputSchema.type,
        properties: t.inputSchema.properties,
        required: t.inputSchema.required || [],
      },
    },
  }));
}

// ── OpenAI-compatible chat (DeepSeek, Gemini, Codex) ───────────

function sanitizeToolsForVendor(tools, baseURL) {
  // Gemini's OpenAI-compatible endpoint rejects OpenAI-specific JSON Schema
  // keywords like minItems, maxItems, default, and const at the top level.
  if (!tools || !baseURL) return tools;
  const isGemini = baseURL.includes('generativelanguage.googleapis.com');
  if (!isGemini) return tools;

  return tools.map(t => {
    const clean = JSON.parse(JSON.stringify(t));
    const params = clean.function.parameters;
    // Strip OpenAI extensions that Gemini rejects
    delete params.minItems;
    delete params.maxItems;
    delete params.default;
    // Recursively strip from nested objects/items
    function strip(obj) {
      if (!obj || typeof obj !== 'object') return;
      delete obj.minItems;
      delete obj.maxItems;
      delete obj.default;
      delete obj.const;
      if (obj.properties) {
        for (const v of Object.values(obj.properties)) strip(v);
      }
      if (obj.items) strip(obj.items);
    }
    strip(params);
    return clean;
  });
}

async function openaiChat(conversation, tools, onToolCall, baseURL, apiKey, model, onThinking) {
  const openai = new OpenAI({ baseURL, apiKey, timeout: 120000 });

  let lastCallSig = '';
  let sameCallCount = 0;
  let allThinking = '';

  while (true) {
    const body = { model, messages: conversation, stream: false };
    const sanitizedTools = sanitizeToolsForVendor(tools, baseURL);
    if (sanitizedTools && sanitizedTools.length > 0) body.tools = sanitizedTools;

    console.log('[CloudLLM] REQUEST model:', model, 'messages:', conversation.length, 'tools:', (body.tools || []).length);
    let response;
    try {
      response = await openai.chat.completions.create(body);
    } catch (err) {
      console.error('[CloudLLM] API ERROR:', model, err.status, err.message, err.code || '');
      throw err;
    }
    const msg = response.choices[0].message;
    const content = msg.content || '';
    const toolCalls = msg.tool_calls || [];
    const thinking = msg.reasoning_content || msg.thinking || '';
    if (thinking) {
      allThinking += (allThinking ? '\n\n' : '') + thinking;
      if (onThinking) onThinking(thinking);
    }

    console.log('[CloudLLM]', model, '- content:', content.length, 'chars, tool_calls:', toolCalls.length, ', thinking:', thinking.length, 'chars');
    if (content) console.log('[CloudLLM] RESPONSE:', content.slice(0, 500));
    if (thinking) console.log('[CloudLLM] THINKING:', thinking.slice(0, 500));

    // If thinking but no content and no tool calls — model stopped short, nudge it
    if (toolCalls.length === 0 && !content && thinking && sameCallCount === 0) {
      conversation.push({ role: 'assistant', content: thinking ? '(thinking)' : null });
      conversation.push({ role: 'user', content: 'Now produce the actual response. Summarize what you did.' });
      continue;
    }

    if (toolCalls.length > 0) {
      conversation.push({ role: 'assistant', content: content || null, tool_calls: toolCalls, thinking });
      for (const tc of toolCalls) {
        try {
          let args = tc.function.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = {}; }
          }
          const rawResult = await onToolCall({ function: { name: tc.function.name, arguments: args } });
          const cleanResult = rawResult.result || rawResult.error || rawResult;
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(cleanResult) });
        } catch (e) {
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: e.message }) });
        }
      }
      continue;
    }

    // Dedup guard
    const sig = 'text:' + content.slice(0, 200);
    if (sig === lastCallSig) {
      sameCallCount++;
      if (sameCallCount >= 2) return { content: content || 'Stopped — repeated output.', thinking: allThinking };
    } else { sameCallCount = 0; }
    lastCallSig = sig;
    return { content, thinking: allThinking };
  }
}

// ── Claude chat (Anthropic SDK) ─────────────────────────────────

function toolsToAnthropic(tools) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: {
      type: t.function.parameters.type,
      properties: t.function.parameters.properties,
      required: t.function.parameters.required,
    },
  }));
}

async function claudeChat(conversation, tools, onToolCall, apiKey, model, onThinking) {
  const anthropic = new Anthropic({ apiKey });

  // Anthropic requires system as top-level param, not a message
  const systemMsg = conversation.find(m => m.role === 'system');
  const messages = conversation.filter(m => m.role !== 'system').map(m => {
    // Anthropic tool results need specific format
    if (m.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
    }
    return { role: m.role, content: m.content };
  });

  let lastCallSig = '';
  let sameCallCount = 0;
  let allThinking = '';

  while (true) {
    const body = {
      model,
      max_tokens: 4096,
      system: systemMsg ? [{ type: 'text', text: systemMsg.content }] : undefined,
      messages,
    };
    if (tools && tools.length > 0) body.tools = toolsToAnthropic(tools);

    console.log('[CloudLLM/Claude] REQUEST model:', model, 'messages:', messages.length, 'tools:', (body.tools || []).length);
    let response;
    try {
      response = await anthropic.messages.create(body);
    } catch (err) {
      console.error('[CloudLLM/Claude] API ERROR:', model, err.status, err.message, err.type || '');
      throw err;
    }
    const contentBlocks = response.content || [];
    const textBlocks = contentBlocks.filter(b => b.type === 'text');
    const thinkingBlocks = contentBlocks.filter(b => b.type === 'thinking');
    const content = textBlocks.map(b => b.text).join('');
    const thinking = thinkingBlocks.map(b => b.thinking || '').join('');
    const toolUseBlocks = contentBlocks.filter(b => b.type === 'tool_use');
    if (thinking) {
      allThinking += (allThinking ? '\n\n' : '') + thinking;
      if (onThinking) onThinking(thinking);
    }

    console.log('[CloudLLM/Claude]', model, '- content:', content.length, 'chars, tool_uses:', toolUseBlocks.length, ', thinking:', thinking.length, 'chars');
    if (content) console.log('[CloudLLM/Claude] RESPONSE:', content.slice(0, 500));
    if (thinking) console.log('[CloudLLM/Claude] THINKING:', thinking.slice(0, 500));

    if (toolUseBlocks.length === 0 && !content && thinking && sameCallCount === 0) {
      messages.push({ role: 'assistant', content: '(thinking)' });
      messages.push({ role: 'user', content: 'Now produce the actual response. Summarize what you did.' });
      continue;
    }

    if (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: contentBlocks, thinking });
      for (const tb of toolUseBlocks) {
        try {
          const rawResult = await onToolCall({ function: { name: tb.name, arguments: tb.input } });
          const cleanResult = rawResult.result || rawResult.error || rawResult;
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(cleanResult) }],
          });
        } catch (e) {
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify({ error: e.message }) }],
          });
        }
      }
      continue;
    }

    const sig = 'text:' + content.slice(0, 200);
    if (sig === lastCallSig) {
      sameCallCount++;
      if (sameCallCount >= 2) return { content: content || 'Stopped — repeated output.', thinking: allThinking };
    } else { sameCallCount = 0; }
    lastCallSig = sig;
    return { content, thinking: allThinking };
  }
}

// ── Main chat entry ────────────────────────────────────────────

async function chat(messages, tools, onToolCall, config, onThinking) {
  const model = config.selectedModel || VENDORS.deepseek.models[0];
  const vendor = getVendorForModel(model);
  if (!vendor) throw new Error('Unknown model: ' + model);

  const apiKey = config[vendor.key + 'Key'];
  if (!apiKey) throw new Error('No API key for ' + vendor.name);

  let conversation = messages;
  const hasSystem = conversation.length > 0 && conversation[0].role === 'system';
  if (!hasSystem) conversation = [buildSystemMessage(tools), ...conversation];

  if (vendor.key === 'claude') {
    return claudeChat(conversation, tools, onToolCall, apiKey, model, onThinking);
  }
  return openaiChat(conversation, tools, onToolCall, vendor.baseURL, apiKey, model, onThinking);
}

module.exports = { chat, mcpToolsToOpenAITools, sanitizeToolsForVendor, VENDORS, getAvailableModels, getVendorForModel };
