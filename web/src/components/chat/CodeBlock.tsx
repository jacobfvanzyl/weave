import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';

const normalizeLanguage = (className?: string) =>
  className?.split(' ').find(name => name.startsWith('language-'))?.slice('language-'.length) || 'text';

export const CodeBlock = ({ children, className }: { children: string; className?: string }) => {
  const mode = useThemeStore(state => state.mode);
  const resolvedTheme = getResolvedTheme(mode);
  const [html, setHtml] = useState('');
  const code = String(children).replace(/\n$/, '');
  const language = normalizeLanguage(className);

  useEffect(() => {
    let cancelled = false;

    void codeToHtml(code, {
      lang: language,
      theme: resolvedTheme === 'dark' ? 'catppuccin-mocha' : 'catppuccin-latte',
    })
      .then(nextHtml => {
        if (!cancelled) setHtml(nextHtml);
      })
      .catch(() => {
        if (!cancelled) setHtml('');
      });

    return () => {
      cancelled = true;
    };
  }, [code, language, resolvedTheme]);

  if (!html) {
    return <code className={className}>{children}</code>;
  }

  return <div className="shiki-code" dangerouslySetInnerHTML={{ __html: html }} />;
};
