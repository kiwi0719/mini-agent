/**
 * 离线校验：不连任何模型，直接检查各 Provider 组装出的请求体是否符合对应 API 的约定。
 * 覆盖 OpenAI 兼容的三种 flavor（openai / vllm / ollama）与 Anthropic 格式的全部 preset
 * （anthropic / kimi / glm / deepseek / minimax / custom），以及全部工具的 JSON Schema。
 * 用法: node scripts/check-request-schema.ts
 */
import { Ajv } from 'ajv';
import { OpenAICompatProvider, type Flavor } from '../src/llm/openai.ts';
import { AnthropicProvider, ANTHROPIC_PRESETS, normalizeBase, type AnthropicPreset } from '../src/llm/anthropic.ts';
import { createDefaultRegistry } from '../src/tools/index.ts';
import { SYSTEM_PROMPT } from '../src/agent.ts';
import type { Message } from '../src/types.ts';

const ajv = new Ajv({ strict: true, allErrors: true });
let failures = 0;
const check = (cond: unknown, msg: string) => { if (!cond) { failures++; console.log('  ✘', msg); } };

const registry = createDefaultRegistry();
const tools = registry.schemas(new Set(registry.all().filter((t) => t.deferred).map((t) => t.name))); // 含全部 deferred，覆盖所有 schema

// 一段包含全部消息角色的历史：user → assistant(tool_calls) → tool(含失败) → system 提示
const history: Message[] = [
  { role: 'user', content: '测试任务' },
  { role: 'assistant', content: '先读文件', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }, { id: 'c2', name: 'calculator', input: { expression: '1+1' } }] },
  { role: 'tool', results: [{ callId: 'c1', name: 'read_file', result: { ok: false, error: '不存在' } }, { callId: 'c2', name: 'calculator', result: { ok: true, output: '2' } }] },
  { role: 'system', content: '注入提示' },
];

// ---------- 1. 每个工具的 JSON Schema 本身合法（strict 模式，未知关键字会报错） ----------
console.log(`\n[1] ${tools.length} 个工具的 JSON Schema`);
for (const t of tools) {
  check(/^[a-zA-Z0-9_-]{1,64}$/.test(t.name), `${t.name}: 名称须匹配 ^[a-zA-Z0-9_-]{1,64}$（OpenAI 约束）`);
  check(t.description.length > 0 && t.description.length <= 1024, `${t.name}: description 长度需在 1..1024`);
  check(t.input_schema.type === 'object', `${t.name}: parameters.type 必须是 object`);
  check(typeof t.input_schema.properties === 'object', `${t.name}: parameters.properties 必须存在`);
  try { ajv.compile(t.input_schema); } catch (e) { check(false, `${t.name}: schema 不合法 — ${(e as Error).message}`); }
  for (const r of t.input_schema.required ?? []) check(r in t.input_schema.properties, `${t.name}: required 字段 ${r} 不在 properties 中`);
}

// ---------- 2. 三种 flavor 的请求体 ----------
const expectations: Record<Flavor, { stream: boolean; tool_choice: boolean; stream_options: boolean }> = {
  openai: { stream: true, tool_choice: true, stream_options: true },
  vllm: { stream: true, tool_choice: true, stream_options: true },
  ollama: { stream: false, tool_choice: false, stream_options: false },
};
for (const flavor of Object.keys(expectations) as Flavor[]) {
  console.log(`\n[2] flavor=${flavor}`);
  const p = new OpenAICompatProvider({ flavor, model: 'test-model', apiKey: 'k' });
  const body = p.buildRequestBody(SYSTEM_PROMPT, history, tools) as any;
  const exp = expectations[flavor];
  check(body.model === 'test-model', 'model');
  check(body.stream === exp.stream, `stream 应为 ${exp.stream}`);
  check(('tool_choice' in body) === exp.tool_choice, exp.tool_choice ? '应带 tool_choice=auto' : 'Ollama 不支持 tool_choice，不应发送');
  if (exp.tool_choice) check(body.tool_choice === 'auto', 'tool_choice 应为 auto');
  check(('stream_options' in body) === exp.stream_options, exp.stream_options ? '应带 stream_options.include_usage' : '不应发送 stream_options');
  check(!('parallel_tool_calls' in body), '不发送 parallel_tool_calls（Ollama 不支持，其余默认即 true）');
  // tools 形状
  check(Array.isArray(body.tools) && body.tools.length === tools.length, 'tools 数量');
  for (const t of body.tools) {
    check(t.type === 'function', `${t.function?.name}: type=function`);
    check(typeof t.function.name === 'string' && typeof t.function.description === 'string', `${t.function?.name}: name/description`);
    check(t.function.parameters?.type === 'object', `${t.function?.name}: parameters.type=object`);
    check(!('input_schema' in t.function), `${t.function?.name}: 不应泄漏 Anthropic 的 input_schema 字段名`);
  }
  // messages 形状
  const roles = body.messages.map((m: any) => m.role);
  check(roles[0] === 'system', 'messages[0] 为 system');
  check(roles.every((r: string) => ['system', 'user', 'assistant', 'tool'].includes(r)), `角色只能是 system/user/assistant/tool，实际 ${[...new Set(roles)].join(',')}`);
  const asst = body.messages.find((m: any) => m.role === 'assistant');
  check(Array.isArray(asst.tool_calls) && asst.tool_calls.length === 2, 'assistant.tool_calls 数量');
  for (const tc of asst.tool_calls) {
    check(tc.type === 'function' && typeof tc.id === 'string', 'tool_call 需有 id 与 type=function');
    check(typeof tc.function.arguments === 'string', 'tool_call.function.arguments 必须是 JSON 字符串（不是对象）');
    try { JSON.parse(tc.function.arguments); } catch { check(false, 'arguments 不是合法 JSON'); }
  }
  const toolMsgs = body.messages.filter((m: any) => m.role === 'tool');
  check(toolMsgs.length === 2, '每个 tool_result 一条 role=tool 消息');
  for (const tm of toolMsgs) check(typeof tm.tool_call_id === 'string' && typeof tm.content === 'string', 'tool 消息需有 tool_call_id 与字符串 content');
  const ids = new Set(asst.tool_calls.map((c: any) => c.id));
  check(toolMsgs.every((tm: any) => ids.has(tm.tool_call_id)), 'tool_call_id 必须对应前一条 assistant 的 tool_calls');
  // 顺序：assistant(tool_calls) 之后紧跟其 tool 消息（多数服务端要求）
  const ai = body.messages.indexOf(asst);
  check(body.messages[ai + 1]?.role === 'tool' && body.messages[ai + 2]?.role === 'tool', 'tool 消息需紧跟 assistant');
  check(JSON.stringify(body).length > 0 && !JSON.stringify(body).includes('undefined'), '序列化后不含 undefined 字面量');
}

// ---------- 3. Anthropic 格式：每个 preset 的请求体 / 头 / baseUrl 归一化 ----------
for (const preset of Object.keys(ANTHROPIC_PRESETS) as AnthropicPreset[]) {
  console.log(`\n[3] preset=${preset}`);
  const d = ANTHROPIC_PRESETS[preset];
  // 显式传入每个字段（包括空的 authToken），避免读到宿主机的 ANTHROPIC_* 环境变量导致断言不可复现
  const p = new AnthropicProvider({ preset, apiKey: 'sk-test', authToken: '', model: d.model || 'test-model', baseUrl: d.baseUrl || 'https://gw.example.com' });
  const body = p.buildRequestBody(SYSTEM_PROMPT, history, tools) as any;
  const headers = p.buildHeaders();

  // 顶层字段：Anthropic 的 system 是独立字段，不是 messages[0]
  check(typeof body.model === 'string' && body.model.length > 0, 'model 非空');
  check(typeof body.max_tokens === 'number' && body.max_tokens > 0, 'max_tokens 必填且为正数（Anthropic 与 OpenAI 的关键差异）');
  check(body.system === SYSTEM_PROMPT, 'system 应为顶层字段');
  check(!body.messages.some((m: any) => m.role === 'system'), 'messages 里不应出现 system 角色（Anthropic 不支持）');
  check(body.messages.every((m: any) => m.role === 'user' || m.role === 'assistant'), 'messages 角色只能是 user / assistant');
  check(!('tool_choice' in body), '未强制工具选择时不应发送 tool_choice');
  check(!('stream_options' in body), 'stream_options 是 OpenAI 扩展，不应出现在 Anthropic 请求里');

  // 工具形状：Anthropic 用 input_schema，且没有 type/function 包装
  check(Array.isArray(body.tools) && body.tools.length === tools.length, 'tools 数量');
  for (const t of body.tools) {
    check(t.input_schema?.type === 'object', `${t.name}: input_schema.type=object`);
    check(!('parameters' in t), `${t.name}: 不应带 OpenAI 的 parameters 字段名`);
    check(!('type' in t) && !('function' in t), `${t.name}: 不应带 OpenAI 的 type/function 包装`);
    check(typeof t.name === 'string' && typeof t.description === 'string', `${t.name}: name/description`);
  }

  // tool_use / tool_result 配对：assistant 的 tool_use.input 必须是对象（不是 JSON 字符串，这点与 OpenAI 相反）
  const asst = body.messages.find((m: any) => m.role === 'assistant');
  const toolUses = asst.content.filter((b: any) => b.type === 'tool_use');
  check(toolUses.length === 2, 'assistant 应含 2 个 tool_use 块');
  for (const tu of toolUses) {
    check(typeof tu.id === 'string' && tu.id.length > 0, 'tool_use 需有 id');
    check(tu.input !== null && typeof tu.input === 'object' && !Array.isArray(tu.input), 'tool_use.input 必须是对象（Anthropic 与 OpenAI 的 arguments 字符串相反）');
  }
  check(asst.content.length > 0, 'assistant.content 不可为空数组（部分兼容端点会拒绝）');

  // tool_result 必须在 user 消息里，且 id 与前面的 tool_use 对应
  const resultMsg = body.messages.find((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'));
  check(resultMsg?.role === 'user', 'tool_result 必须放在 user 消息中');
  const useIds = new Set(toolUses.map((t: any) => t.id));
  for (const b of resultMsg.content) {
    check(b.type === 'tool_result', 'tool_result 消息内不应混入其他块类型');
    check(useIds.has(b.tool_use_id), `tool_use_id ${b.tool_use_id} 必须对应前面的 tool_use`);
    check(typeof b.content === 'string', 'tool_result.content 应为字符串');
  }
  check(resultMsg.content.some((b: any) => b.is_error === true), '失败的工具结果应带 is_error: true');

  // 运行中注入的 system 提示：Anthropic 无对话内 system 角色，应降级为带标记的 user 消息
  check(body.messages.some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<system_notice>')), 'system 注入应降级为带 <system_notice> 标记的 user 消息');

  // 请求头
  check(headers['anthropic-version'] === '2023-06-01', 'anthropic-version 头');
  check(headers['x-api-key'] === 'sk-test', 'x-api-key 头（官方只看这个）');
  check(headers.authorization === 'Bearer sk-test', '只给 apiKey 时，Authorization 也用它兜底（部分网关只看 Bearer）');
  // 反向：只给 authToken（只认 Bearer 的网关），x-api-key 也要用它兜底
  const tokenOnly = new AnthropicProvider({ preset, apiKey: '', authToken: 'tok-test', model: d.model || 'test-model', baseUrl: d.baseUrl || 'https://gw.example.com' }).buildHeaders();
  check(tokenOnly['x-api-key'] === 'tok-test' && tokenOnly.authorization === 'Bearer tok-test', '只给 authToken 时两种头都用它');
  check(headers['content-type'] === 'application/json', 'content-type 头');

  check(!JSON.stringify(body).includes('undefined'), '序列化后不含 undefined 字面量');
}

// ---------- 4. baseUrl 归一化：各种写法都要落到 …/v1 ----------
console.log('\n[4] baseUrl 归一化');
for (const [input, want] of [
  ['https://api.anthropic.com', 'https://api.anthropic.com/v1'],
  ['https://api.anthropic.com/', 'https://api.anthropic.com/v1'],
  ['https://api.moonshot.cn/anthropic', 'https://api.moonshot.cn/anthropic/v1'],
  ['https://gw.example.com/v1', 'https://gw.example.com/v1'],
  ['https://gw.example.com/v1/messages', 'https://gw.example.com/v1'],
  ['https://gw.example.com/v1/', 'https://gw.example.com/v1'],
] as [string, string][]) {
  const got = normalizeBase(input);
  check(got === want, `normalizeBase("${input}") 期望 "${want}"，实际 "${got}"`);
}

console.log(failures ? `\n✘ ${failures} 项不通过` : '\n✔ 全部通过');
process.exit(failures ? 1 : 0);
