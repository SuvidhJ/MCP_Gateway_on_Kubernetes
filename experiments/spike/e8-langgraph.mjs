// E8b: the same eval as e8-chat.mjs, with LangChain 1 createAgent + humanInTheLoopMiddleware + @langchain/mcp-adapters
// (decision 7: AI SDK 7 vs LangChain/LangGraph). Same gateway, same model, same cases, auto-approve on interrupt.
import { createAgent, humanInTheLoopMiddleware } from 'langchain';
import { MemorySaver, Command } from '@langchain/langgraph';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { ChatOpenAI } from '@langchain/openai';

const GW = process.env.GW ?? 'http://gw.127.0.0.1.nip.io:8080/mcp';
const MODEL = process.env.MODEL ?? 'qwen3.5-agent';
const K = Number(process.env.K ?? 3);
// Note: the adapter prefixes tool names with the server key by default (gw_store__list_orders); turn that off.
const mcp = new MultiServerMCPClient({ prefixToolNameWithServerName: false, mcpServers: { gw: { transport: 'http', url: GW, headers: { Authorization: `Bearer ${process.env.KEY ?? 'k1'}` } } } });
const all = await mcp.getTools();
const keep = (process.env.TOOLS ?? 'store__,deepwiki__ask_wiki_question').split(',');
const tools = all.filter(t => keep.some(k => t.name.startsWith(k)));
console.log(`model=${MODEL} tools=${tools.length}/${all.length}: ${tools.map(t => t.name).join(', ')}`);
const model = new ChatOpenAI({ model: MODEL, temperature: 0, apiKey: process.env.API_KEY ?? 'ollama', configuration: { baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:11434/v1' },
  ...(process.env.REASONING ? { modelKwargs: { reasoning_effort: process.env.REASONING } } : {}) });
const systemPrompt = `You are a store assistant for the "store" WooCommerce shop. Today is ${new Date().toISOString().slice(0, 10)} (UTC). Use the tools; never invent data. Answer briefly.`;
const agent = createAgent({ model, tools, systemPrompt, checkpointer: new MemorySaver(),
  middleware: [humanInTheLoopMiddleware({ interruptOn: { store__create_product: true, store__update_order_status: true } })] });

const cases = [
  { id: 'list-products', prompt: 'What products does the store sell? Give names and prices.', expect: (calls) => calls.some(c => c.name === 'store__list_products') },
  { id: 'processing', prompt: 'Which orders are in processing status right now?', expect: (calls) => calls.some(c => c.name === 'store__list_orders' && JSON.stringify(c.args).includes('processing')) },
  { id: 'get-order', prompt: 'Show me the details of order 15.', expect: (calls) => calls.some(c => c.name === 'store__get_order' && c.args?.id === 15) },
  { id: 'complete-order', prompt: 'Mark order 16 as completed.', expect: (calls, appr) => appr.some(a => a.name === 'store__update_order_status' && a.args?.id === 16 && a.args?.status === 'completed') },
  { id: 'create-draft', prompt: "Create a draft product called 'Urumi Sticker' priced 99.", expect: (calls, appr) => appr.some(a => a.name === 'store__create_product' && a.args?.status === 'draft' && String(a.args?.regular_price) === '99') },
  { id: 'cross-server', prompt: "Ask deepwiki about the woocommerce/woocommerce repo: what does the 'on-hold' order status mean? Then list the store's on-hold orders.", expect: (calls) => calls.some(c => c.name === 'deepwiki__ask_wiki_question') && calls.some(c => c.name === 'store__list_orders') },
];

let thread = 0;
async function runCase(c) {
  const t0 = Date.now(); const config = { configurable: { thread_id: `t${++thread}` }, recursionLimit: 20 };
  const approvals = []; let result; let err = null;
  try {
    result = await agent.invoke({ messages: [{ role: 'user', content: c.prompt }] }, config);
    for (let i = 0; i < 3 && result.__interrupt__?.length; i++) {
      const req = result.__interrupt__[0].value;
      approvals.push(...req.actionRequests.map(a => ({ name: a.name, args: a.args ?? a.arguments })));
      result = await agent.invoke(new Command({ resume: { decisions: req.actionRequests.map(() => ({ type: 'approve' })) } }), config);
    }
  } catch (e) { err = `${e.constructor.name}: ${String(e.message).slice(0, 160)}`; }
  const msgs = result?.messages ?? [];
  const calls = msgs.flatMap(m => (m.tool_calls ?? []).map(tc => ({ name: tc.name, args: tc.args })));
  const usage = msgs.reduce((a, m) => ({ in: a.in + (m.usage_metadata?.input_tokens ?? 0), out: a.out + (m.usage_metadata?.output_tokens ?? 0) }), { in: 0, out: 0 });
  const last = msgs.at(-1); const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
  return { ok: !err && c.expect(calls, approvals), ms: Date.now() - t0, calls, approvals, usage, text: text.replace(/\s+/g, ' ').slice(0, 160), err };
}

const summary = [];
for (const c of cases) {
  const runs = []; for (let i = 0; i < K; i++) runs.push(await runCase(c));
  const passes = runs.filter(r => r.ok).length;
  summary.push({ id: c.id, passes, K, passK: passes === K, avgMs: Math.round(runs.reduce((a, r) => a + r.ms, 0) / K), inTok: Math.round(runs.reduce((a, r) => a + r.usage.in, 0) / K), outTok: Math.round(runs.reduce((a, r) => a + r.usage.out, 0) / K) });
  const r0 = runs[0];
  console.log(`\n[${c.id}] ${passes}/${K} pass  avg ${summary.at(-1).avgMs} ms  tokens in/out ${summary.at(-1).inTok}/${summary.at(-1).outTok}`);
  console.log(`   calls: ${r0.calls.map(x => `${x.name}(${JSON.stringify(x.args)})`).join(' -> ') || '(none)'}`);
  if (r0.approvals.length) console.log(`   interrupts approved: ${r0.approvals.map(a => `${a.name}(${JSON.stringify(a.args)})`).join(', ')}`);
  console.log(`   answer: ${r0.err ?? r0.text}`);
  for (const [i, r] of runs.entries()) if (!r.ok) console.log(`   run ${i} FAILED: calls=${r.calls.map(x => x.name).join(',') || 'none'} approvals=${r.approvals.map(a => a.name).join(',') || 'none'} ${r.err ?? ''}`);
}
console.log('\nSUMMARY', JSON.stringify(summary));
console.log(`pass^${K}: ${summary.filter(s => s.passK).length}/${summary.length} cases; pass@1 ≈ ${(summary.reduce((a, s) => a + s.passes, 0) / (summary.length * K) * 100).toFixed(0)}%`);
await mcp.close();
