import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  type ConversationItem,
  DirectHostClient,
  type HostSnapshot,
} from './portal-client';

const shortDate = (value: string) => new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(value));

export function App() {
  const [hostUrl, setHostUrl] = useState('ws://127.0.0.1:4122');
  const [token, setToken] = useState('');
  const [client, setClient] = useState<DirectHostClient>();
  const [snapshot, setSnapshot] = useState<HostSnapshot>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const itemsEnd = useRef<HTMLDivElement>(null);

  useEffect(() => () => client?.close(), [client]);
  useEffect(() => itemsEnd.current?.scrollIntoView({ behavior: 'smooth' }), [items]);

  const workspaceNames = useMemo(
    () => new Map(snapshot?.workspaces.map((workspace) => [workspace.workspaceId, workspace.name]) ?? []),
    [snapshot],
  );
  const agentNames = useMemo(
    () => new Map(snapshot?.agents.map((agent) => [agent.agentId, agent.name]) ?? []),
    [snapshot],
  );

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    client?.close();
    const next = new DirectHostClient(hostUrl, token, (item) =>
      setItems((current) => {
        const previous = current.at(-1);
        if (item.append && previous?.append && previous.role === item.role) {
          return [...current.slice(0, -1), { ...previous, text: `${previous.text}${item.text}` }];
        }
        return [...current, item];
      }));
    try {
      const nextSnapshot = await next.snapshot();
      setClient(next);
      setSnapshot(nextSnapshot);
      setSelectedThreadId(undefined);
      setItems([]);
    } catch (cause) {
      next.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await client.snapshot());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const attach = async (threadId: string) => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    setItems([]);
    try {
      await client.attach(threadId);
      setSelectedThreadId(threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createThread = async () => {
    const workspace = snapshot?.workspaces[0];
    const agent = snapshot?.agents[0];
    if (!client || !workspace || !agent) return;
    setBusy(true);
    setError(undefined);
    setItems([]);
    try {
      const thread = await client.createThread(workspace.workspaceId, agent.agentId);
      setSnapshot(await client.snapshot());
      await client.attach(thread.threadId);
      setSelectedThreadId(thread.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const sendPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!client || !text) return;
    setPrompt('');
    setBusy(true);
    setError(undefined);
    try {
      await client.prompt(text);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">A</div>
        <div>
          <h1>Alpha</h1>
          <p>Direct Portal client · {Capacitor.getPlatform()}</p>
        </div>
        <span className={`connection-dot ${snapshot ? 'connected' : ''}`} />
      </header>

      {!snapshot ? (
        <section className="connect-panel">
          <p className="eyebrow">Portal connection</p>
          <h2>Your agents, where they run.</h2>
          <p className="lede">Alpha connects directly to Portal. The token stays in memory and is never put in the URL.</p>
          <form onSubmit={connect}>
            <label>
              Portal URL
              <input value={hostUrl} onChange={(event) => setHostUrl(event.target.value)} inputMode="url" />
            </label>
            <label>
              Access token
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                autoComplete="off"
                placeholder="Required"
              />
            </label>
            <button disabled={busy || !token}>{busy ? 'Connecting…' : 'Connect to Portal'}</button>
          </form>
          <p className="hint">Browser origins must be allowed by Portal. Native Alpha uses <code>capacitor://localhost</code>.</p>
          {error && <p className="error">{error}</p>}
        </section>
      ) : (
        <div className="workspace">
          <aside className="thread-sidebar">
            <div className="sidebar-heading">
              <div>
                <p className="eyebrow">Portal Threads</p>
                <strong>{snapshot.threads.length} available</strong>
              </div>
              <div className="sidebar-actions">
                <button className="quiet-button" onClick={refresh} disabled={busy}>Refresh</button>
                <button className="quiet-button" onClick={createThread} disabled={busy || !snapshot.workspaces.length || !snapshot.agents.length}>New</button>
              </div>
            </div>
            <div className="thread-list">
              {snapshot.threads.map((thread) => (
                <button
                  className={`thread-row ${selectedThreadId === thread.threadId ? 'selected' : ''}`}
                  key={thread.threadId}
                  onClick={() => attach(thread.threadId)}
                  disabled={busy}
                >
                  <span className="thread-title">{thread.title || workspaceNames.get(thread.workspaceId) || thread.workspaceId}</span>
                  <span>{agentNames.get(thread.agentId) || thread.agentId} · {shortDate(thread.updatedAt)}</span>
                  <span className={`status ${thread.status}`}>{thread.status}</span>
                </button>
              ))}
              {!snapshot.threads.length && <p className="empty">No Portal-managed ACP Threads yet.</p>}
            </div>
          </aside>

          <section className="conversation">
            {selectedThreadId ? (
              <>
                <div className="conversation-scroll">
                  {items.map((item) => (
                    <article className={`message ${item.role}`} key={item.id}>
                      <span>{item.role}</span>
                      <p>{item.text}</p>
                    </article>
                  ))}
                  {!items.length && !busy && <p className="empty">The Thread loaded without replayable messages.</p>}
                  <div ref={itemsEnd} />
                </div>
                <form className="composer" onSubmit={sendPrompt}>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Message the attached agent…"
                    rows={2}
                  />
                  <button disabled={busy || !prompt.trim()}>{busy ? 'Working…' : 'Send'}</button>
                </form>
              </>
            ) : (
              <div className="conversation-empty">
                <span>↗</span>
                <h2>Choose a Thread</h2>
                <p>Alpha will attach over ACP and ask the Agent to replay its session.</p>
              </div>
            )}
            {error && <p className="error floating">{error}</p>}
          </section>
        </div>
      )}
    </main>
  );
}
