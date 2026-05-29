import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';

const normalizeLanguage = (className?: string) =>
  className?.split(' ').find(name => name.startsWith('language-'))?.slice('language-'.length) || 'text';

const maxHighlightCacheEntries = 200;
const highlightCache = new Map<string, string>();

const cacheHighlight = (key: string, html: string) => {
  highlightCache.set(key, html);
  if (highlightCache.size <= maxHighlightCacheEntries) return;

  const firstKey = highlightCache.keys().next().value;
  if (typeof firstKey === 'string') highlightCache.delete(firstKey);
};

export const CodeBlock = ({ children, className }: { children: string; className?: string }) => {
  const mode = useThemeStore(state => state.mode);
  const resolvedTheme = getResolvedTheme(mode);
  const code = String(children).replace(/\n$/, '');
  const language = normalizeLanguage(className);
  const theme = resolvedTheme === 'dark' ? 'catppuccin-mocha' : 'catppuccin-latte';
  const cacheKey = `${theme}:${language}:${code}`;
  const [html, setHtml] = useState(() => highlightCache.get(cacheKey) ?? '');

  useEffect(() => {
    let cancelled = false;
    const cachedHtml = highlightCache.get(cacheKey);
    if (cachedHtml) {
      setHtml(cachedHtml);
      return () => {
        cancelled = true;
      };
    }

    setHtml('');

    void codeToHtml(code, {
      lang: language,
      theme,
    })
      .then(nextHtml => {
        cacheHighlight(cacheKey, nextHtml);
        if (!cancelled) setHtml(nextHtml);
      })
      .catch(() => {
        if (!cancelled) setHtml('');
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, language, theme]);

  if (!html) {
    return <code className={className}>{children}</code>;
  }

  return <div className="shiki-code" dangerouslySetInnerHTML={{ __html: html }} />;
};
