'use strict';

// The agent loop. Uses the Anthropic SDK with a manual tool-use loop so every
// tool call goes through our scope-enforcing handlers. The model explores the
// researcher's own site and writes test plans; it cannot send payloads itself.

const Anthropic = require('@anthropic-ai/sdk');
const { systemPrompt } = require('./prompt');
const { createTools } = require('./tools');

const MODEL = process.env.HUNT_AGENT_MODEL || 'claude-opus-5-5';

function textOf(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function runAgent(env) {
  const { cfg, log, onAssistant } = env;
  const ClientCtor = Anthropic.default || Anthropic;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    log('[agent] no ANTHROPIC_API_KEY set; set one to run the agent. Skipping the agent loop.');
    return { stopped: 'no-api-key' };
  }
  const client = new ClientCtor();
  const tools = createTools(env);

  const system = systemPrompt({ sites: cfg.siteList, oobHost: cfg.oobHost });
  const messages = [{
    role: 'user',
    content: cfg.goal || 'Explore the installed apps on my test site and point me at the most promising leads, with a safe manual test plan for each.',
  }];

  const maxTurns = cfg.maxTurns || 40;
  for (let turn = 0; turn < maxTurns; turn++) {
    let res;
    try {
      res = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system,
        tools: tools.defs,
        messages,
      });
    } catch (e) {
      log(`[agent] API error: ${e.message}`);
      if (e.status === 401) return { stopped: 'auth-error' };
      // Back off once and retry; the SDK already retries 429/5xx internally.
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const say = textOf(res.content);
    if (say && onAssistant) onAssistant(say);

    if (res.stop_reason === 'refusal') { log('[agent] model declined this request'); return { stopped: 'refusal', tools }; }
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }

    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason === 'end_turn' || toolUses.length === 0) {
      return { stopped: 'done', summary: say, tools };
    }

    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const tu of toolUses) {
      const out = await tools.run(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, is_error: !out.ok });
    }
    messages.push({ role: 'user', content: results });
  }
  log('[agent] reached the turn limit; stopping');
  return { stopped: 'max-turns', tools };
}

module.exports = { runAgent };
