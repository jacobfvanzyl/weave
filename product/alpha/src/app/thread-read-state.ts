import type { ThreadAttention } from '@weave/product-protocol';

type Observation = { state: ThreadAttention['state']; generation?: number; read: boolean; awaitingSnapshot?: boolean };

/** Device-local read state, independent of sidebar mounting and Host polling. */
export class ThreadReadState {
  private focused?: string;
  private observations = new Map<string, Observation>();
  focus(id?: string) {
    const changed = this.focused !== id;
    this.focused = id;
    const entry = id ? this.observations.get(id) : undefined;
    const consumed = entry?.state === 'completed' && !entry.read;
    if (consumed) entry.read = true;
    return changed || consumed;
  }
  started(id: string) {
    this.observations.set(id, { state: 'working', generation: this.observations.get(id)?.generation, read: false });
  }
  completed(id: string) {
    this.observations.set(id, { state: 'completed', generation: this.observations.get(id)?.generation, read: this.focused === id, awaitingSnapshot: true });
  }
  observe(id: string, attention?: ThreadAttention) {
    if (!attention || attention.state === 'unavailable') return;
    const previous = this.observations.get(id);
    const sameRuntime = previous?.generation === undefined || attention.generation === undefined || previous.generation === attention.generation;
    if (previous?.awaitingSnapshot && sameRuntime) {
      // A prompt response arrives before the next Host observation. Preserve
      // whether it was seen at completion, including across a late working poll.
      if (attention.state === 'working' || attention.state === 'waiting') return;
      if (attention.state === 'completed') { previous.awaitingSnapshot = false; previous.generation = attention.generation; return; }
    }
    if (previous?.state === attention.state && sameRuntime) return;
    this.observations.set(id, { state: attention.state, generation: attention.generation, read: attention.state === 'completed' && this.focused === id });
  }
  unread(id: string) { const entry = this.observations.get(id); return entry?.state === 'completed' && !entry.read; }
}
