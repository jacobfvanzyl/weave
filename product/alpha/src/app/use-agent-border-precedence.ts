import { useEffect } from 'react';

// The native terminal and the web outline can land on different fractional
// pixels. Give the shared straight edge to the terminal instead of relying on
// stacking two independently antialiased borders at the same nominal position.
export function useAgentBorderPrecedence() {
  useEffect(() => {
    const group = document.getElementById('terminal-agent-layout');
    if (!group) return;
    let frame: number | undefined;
    const observed = new Set<Element>();
    const update = () => {
      frame = undefined;
      const agent = group.querySelector<HTMLElement>('[data-slot="thread-pane"]');
      const terminal = group.querySelector<HTMLElement>('[data-focused="true"]:not([data-agent-focused="true"]) [data-slot="terminal-focus-border"]');
      const elements = [group, agent, terminal].filter((element): element is HTMLElement => Boolean(element));
      for (const element of observed) if (!elements.includes(element as HTMLElement)) { resize.unobserve(element); observed.delete(element); }
      for (const element of elements) if (!observed.has(element)) { resize.observe(element); observed.add(element); }
      if (!agent) return;
      let cutout = '';
      let offset = '';
      if (group.dataset.agentSeam === 'overlap' && terminal) {
        const edge = terminal.getBoundingClientRect();
        const pane = agent.getBoundingClientRect();
        const dockedLeft = group.dataset.agentDock === 'left';
        const distance = dockedLeft ? edge.left - pane.right : edge.right - pane.left;
        if (edge.width > 0 && edge.height > 0 && pane.height > 0 && Math.abs(distance) <= 2) {
          const style = getComputedStyle(terminal);
          const width = Number.parseFloat(dockedLeft ? style.borderLeftWidth : style.borderRightWidth) || 1;
          // Align the remaining mauve segments to the blue stroke's outer
          // edge, not the adjacent panel's box. They then meet at the tangent.
          offset = `${distance + (dockedLeft ? width : -width)}px`;
          const topRadius = Number.parseFloat(dockedLeft ? style.borderTopLeftRadius : style.borderTopRightRadius) || 0;
          const bottomRadius = Number.parseFloat(dockedLeft ? style.borderBottomLeftRadius : style.borderBottomRightRadius) || 0;
          const start = Math.max(0, edge.top - pane.top + topRadius);
          const end = Math.min(pane.height, edge.bottom - pane.top - bottomRadius);
          if (end > start) cutout = `linear-gradient(to bottom, black 0px ${start}px, transparent ${start}px ${end}px, black ${end}px 100%)`;
        }
      }
      if (agent.style.getPropertyValue('--agent-border-mask') !== cutout) {
        if (cutout) agent.style.setProperty('--agent-border-mask', cutout);
        else agent.style.removeProperty('--agent-border-mask');
      }
      if (agent.style.getPropertyValue('--agent-border-offset') !== offset) {
        if (offset) agent.style.setProperty('--agent-border-offset', offset);
        else agent.style.removeProperty('--agent-border-offset');
      }
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'hidden', 'data-focused', 'data-agent-focused', 'data-input-owner', 'data-agent-seam', 'data-agent-dock'] });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule);
      group.querySelector<HTMLElement>('[data-slot="thread-pane"]')?.style.removeProperty('--agent-border-mask');
      group.querySelector<HTMLElement>('[data-slot="thread-pane"]')?.style.removeProperty('--agent-border-offset');
    };
  }, []);
}
