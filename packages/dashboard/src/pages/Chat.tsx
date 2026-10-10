import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Chat as ChatSession, useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';
import { getCsrf } from '../api';
import { Badge, ErrorText, Json, type Tone } from '../ui';
import { useInfo } from './Keys';

// One chat session per login, kept at module level so it survives switching tabs.
let session: ChatSession<UIMessage> | null = null;
function getSession(): ChatSession<UIMessage> {
  session ??= new ChatSession<UIMessage>({
    transport: new DefaultChatTransport<UIMessage>({
      api: '/api/chat',
      headers: () => ({ 'x-csrf-token': getCsrf() }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  return session;
}
export function resetChat() {
  void session?.stop();
  session = null;
}

export function Chat() {
  const info = useInfo();
  if (info.isPending) return <p className="muted">Loading…</p>;
  if (info.error) return <ErrorText error={info.error} />;
  if (!info.data?.chat.enabled) {
    return (
      <div className="card notice">
        <h2>Chat is disabled</h2>
        <p className="muted">
          The gateway has no LLM configured for the chat agent. Set the model settings in the Helm values and redeploy.
        </p>
      </div>
    );
  }
  return <ChatView model={info.data.chat.model} />;
}

function ChatView({ model }: { model: string | null }) {
  const [, force] = useState(0);
  const { messages, sendMessage, status, error, stop, addToolApprovalResponse, clearError } = useChat({
    chat: getSession(),
  });
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === 'submitted' || status === 'streaming';
  const awaitingApproval = messages.some((m) =>
    m.parts.some((p) => isToolUIPart(p) && p.state === 'approval-requested'));

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, status]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void sendMessage({ text });
  };

  const newChat = () => {
    resetChat();
    force((n) => n + 1);
  };

  return (
    <div className="chat">
      <div className="page-head">
        <div>
          <h2>Chat agent</h2>
          <p className="muted">
            {model ? <>Model <code>{model}</code>. </> : null}
            Tools that are not read-only ask for your approval first.
          </p>
        </div>
        {messages.length > 0 && <button className="btn" onClick={newChat}>New chat</button>}
      </div>
      <div className="card chat-log">
        {messages.length === 0 && (
          <p className="muted empty">
            Try: "List the 5 most recent orders", or "Create a product called Blue Mug priced 12.50".
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <div className="msg-role">{m.role === 'user' ? 'You' : 'Assistant'}</div>
            <div className="msg-body">
              {m.parts.map((part, i) => {
                if (part.type === 'text') return <div key={i} className="msg-text">{part.text}</div>;
                if (part.type === 'reasoning' && part.text) {
                  return <details key={i} className="reasoning"><summary>Reasoning</summary>{part.text}</details>;
                }
                if (isToolUIPart(part)) {
                  return <ToolCard key={part.toolCallId} part={part}
                    onDecide={(approved) => part.approval && void addToolApprovalResponse({ id: part.approval.id, approved })} />;
                }
                return null;
              })}
            </div>
          </div>
        ))}
        {status === 'submitted' && <div className="muted thinking">Thinking…</div>}
        {error && (
          <div className="error">
            {error.message || 'The chat request failed.'}{' '}
            <button className="btn btn-small" onClick={clearError}>Dismiss</button>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form className="chat-input" onSubmit={submit}>
        <textarea
          rows={2}
          value={input}
          placeholder={awaitingApproval ? 'Approve or deny the pending tool call above first…' : 'Ask about the store…'}
          disabled={awaitingApproval}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
          }}
        />
        {busy
          ? <button type="button" className="btn" onClick={() => void stop()}>Stop</button>
          : <button className="btn btn-primary" disabled={!input.trim() || awaitingApproval}>Send</button>}
      </form>
      <p className="muted small">
        The assistant acts as you: every tool call goes through the gateway with your identity and appears in the audit log.
      </p>
    </div>
  );
}

const STATE: Record<string, [Tone, string]> = {
  'input-streaming': ['grey', 'preparing'],
  'input-available': ['blue', 'running'],
  'approval-requested': ['amber', 'needs approval'],
  'approval-responded': ['blue', 'decided'],
  'output-available': ['green', 'done'],
  'output-error': ['red', 'error'],
  'output-denied': ['grey', 'denied'],
};

function ToolCard({ part, onDecide }: { part: ToolUIPart | DynamicToolUIPart; onDecide: (approved: boolean) => void }) {
  const name = getToolName(part);
  const [tone, label] = STATE[part.state] ?? ['grey', part.state];
  if (part.state === 'approval-requested') {
    return (
      <div className="tool-card approval">
        <div className="tool-head">
          <span>The agent wants to run <code>{name}</code> with:</span>
          <Badge tone={tone}>{label}</Badge>
        </div>
        <Json value={part.input} />
        <div className="form-actions">
          <button className="btn btn-primary" onClick={() => onDecide(true)}>Approve</button>
          <button className="btn btn-danger" onClick={() => onDecide(false)}>Deny</button>
        </div>
      </div>
    );
  }
  return (
    <div className={`tool-card state-${part.state}`}>
      <div className="tool-head">
        <span>Tool <code>{name}</code></span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {part.input !== undefined && (
        <details>
          <summary>Input</summary>
          <Json value={part.input} />
        </details>
      )}
      {part.state === 'output-available' && (
        <details>
          <summary>Output</summary>
          <Json value={toolText(part.output)} />
        </details>
      )}
      {part.state === 'output-error' && <div className="error">{part.errorText}</div>}
      {part.state === 'output-denied' && <div className="muted small">You denied this call; it was not executed.</div>}
    </div>
  );
}

/** MCP tool results are `{content: [{type:'text', text}], ...}`; show the text when that is all there is. */
function toolText(output: unknown): unknown {
  if (output && typeof output === 'object' && 'content' in output && Array.isArray(output.content)) {
    const content = output.content as { type?: string; text?: string }[];
    if (content.every((c) => c.type === 'text')) {
      const text = content.map((c) => c.text ?? '').join('\n');
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  return output;
}
