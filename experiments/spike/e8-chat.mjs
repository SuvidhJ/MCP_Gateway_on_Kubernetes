// E8: chat-agent tool loop through the gateway with AI SDK 7 + @ai-sdk/mcp, any OpenAI-compatible model
// (default: local Ollama on the GPU). Write tools need human approval (toolApproval 'user-approval'); the harness
// auto-approves to test the resume path. Runs each eval case K times and reports pass^k.
// Env: GW (gateway /mcp URL), KEY (gateway key), BASE_URL (OpenAI-compatible, default Ollama), API_KEY, MODEL, K
import { generateText, isStepCount } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const GW = process.env.GW ?? 'http://gw.127.0.0.1.nip.io:8080/mcp';
const MODEL = process.env.MODEL ?? 'qwen3.5-agent';  // qwen3.5:9b + num_ctx 8192 (Modelfile.agent)
const K = Number(process.env.K ?? 3);
const provider = createOpenAICompatible({ name: 'llm', baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:11434/v1', apiKey: process.env.API_KEY ?? 'ollama' });
const model = provider(MODEL);

const mcp = await createMCPClient({ transport: { type: 'http', url: GW, headers: { Authorization: `Bearer ${process.env.KEY ?? 'k1'}` } } });
const all = await mcp.tools();
const keep = (process.env.TOOLS ?? 'store__,deepwiki__ask_wiki_question').split(',');
const tools = Object.fromEntries(Object.entries(all).filter(([n]) => keep.some(k => n.startsWith(k))));
const schemaChars = JSON.stringify(Object.entries(tools).map(([n, t]) => ({ n, d: t.description, s: t.inputSchema?.jsonSchema ?? t.parameters }))).length;
console.log(`model=${MODEL} tools=${Object.keys(tools).length}/${Object.keys(all).length} (~${Math.round(schemaChars / 4)} tokens of tool schema)`);

const WRITE = new Set(['store__create_product', 'store__update_order_status']);
const toolApproval = Object.fromEntries([...WRITE].filter(n => tools[n]).map(n => [n, 'user-approval']));
const system = `You are a store assistant for the "store" WooCommerce shop. Today is ${new Date().toISOString().slice(0, 10)} (UTC). Use the tools; never invent data. Answer briefly.`;

const cases = [
  { id: 'list-products', prompt: 'What products does the store sell? Give names and prices.', expect: (calls) => calls.some(c => c.name === 'store__list_products') },
  { id: 'processing', prompt: 'Which orders are in processing status right now?', expect: (calls) => calls.some(c => c.name === 'store__list_orders' && JSON.stringify(c.input).includes('processing')) },
  { id: 'get-order', prompt: 'Show me the details of order 15.', expect: (calls) => calls.some(c => c.name === 'store__get_order' && c.input?.id === 15) },
  { id: 'complete-order', prompt: 'Mark order 16 as completed.', expect: (calls, appr) => appr.some(a => a.toolCall.toolName === 'store__update_order_status' && a.toolCall.input?.id === 16 && a.toolCall.input?.status === 'completed') },
  { id: 'create-draft', prompt: "Create a draft product called 'Urumi Sticker' priced 99.", expect: (calls, appr) => appr.some(a => a.toolCall.toolName === 'store__create_product' && a.toolCall.input?.status === 'draft' && String(a.toolCall.input?.regular_price) === '99') },
  { id: 'cross-server', prompt: "Ask deepwiki about the woocommerce/woocommerce repo: what does the 'on-hold' order status mean? Then list the store's on-hold orders.", expect: (calls) => calls.some(c => c.name === 'deepwiki__ask_wiki_question') && calls.some(c => c.name === 'store__list_orders') },
];

async function runCase(c) {
  const t0 = Date.now(); const calls = []; const approvals = []; let usage = { inputTokens: 0, outputTokens: 0 }; let text = ''; let err = null;
  let messages = [{ role: 'user', content: c.prompt }];
  try {
    for (let round = 0; round < 3; round++) {
      const r = await generateText({ model, system, messages, tools, toolApproval, stopWhen: isStepCount(6), temperature: 0,
        providerOptions: process.env.REASONING ? { llm: { reasoningEffort: process.env.REASONING } } : undefined });
      for (const s of r.steps) for (const tc of s.toolCalls) calls.push({ name: tc.toolName, input: tc.input });
      usage.inputTokens += r.usage?.inputTokens ?? 0; usage.outputTokens += r.usage?.outputTokens ?? 0; text = r.text;
      const reqs = r.content.filter(p => p.type === 'tool-approval-request');
      if (!reqs.length) break;
      approvals.push(...reqs);
      // simulate the human clicking "Approve" in the dashboard, then resume the loop
      messages = [...messages, ...r.response.messages, { role: 'tool', content: reqs.map(q => ({ type: 'tool-approval-response', approvalId: q.approvalId, approved: true })) }];
    }
  } catch (e) { err = `${e.constructor.name}: ${String(e.message).slice(0, 160)}`; }
  return { ok: !err && c.expect(calls, approvals), ms: Date.now() - t0, calls, approvals: approvals.map(a => `${a.toolCall.toolName}(${JSON.stringify(a.toolCall.input)})`), usage, text: text.replace(/\s+/g, ' ').slice(0, 160), err };
}

const summary = [];
for (const c of cases) {
  const runs = [];
  for (let i = 0; i < K; i++) runs.push(await runCase(c));
  const passes = runs.filter(r => r.ok).length;
  summary.push({ id: c.id, passes, K, passK: passes === K, avgMs: Math.round(runs.reduce((a, r) => a + r.ms, 0) / K), inTok: Math.round(runs.reduce((a, r) => a + r.usage.inputTokens, 0) / K), outTok: Math.round(runs.reduce((a, r) => a + r.usage.outputTokens, 0) / K) });
  const r0 = runs[0];
  console.log(`\n[${c.id}] ${passes}/${K} pass  avg ${summary.at(-1).avgMs} ms  tokens in/out ${summary.at(-1).inTok}/${summary.at(-1).outTok}`);
  console.log(`   calls: ${r0.calls.map(x => `${x.name}(${JSON.stringify(x.input)})`).join(' -> ') || '(none)'}`);
  if (r0.approvals.length) console.log(`   approvals requested: ${r0.approvals.join(', ')}`);
  console.log(`   answer: ${r0.err ?? r0.text}`);
  for (const [i, r] of runs.entries()) if (!r.ok) console.log(`   run ${i} FAILED: calls=${r.calls.map(x => x.name).join(',') || 'none'} approvals=${r.approvals.join(',') || 'none'} ${r.err ?? ''}`);
}
console.log('\nSUMMARY', JSON.stringify(summary));
console.log(`pass^${K}: ${summary.filter(s => s.passK).length}/${summary.length} cases; pass@1 ≈ ${(summary.reduce((a, s) => a + s.passes, 0) / (summary.length * K) * 100).toFixed(0)}%`);
await mcp.close();
