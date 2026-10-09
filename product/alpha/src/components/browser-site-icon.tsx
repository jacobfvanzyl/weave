import { useState } from 'react';
import { browserFaviconUrl } from '@weave/product-protocol';
import { HugeiconsIcon } from '@hugeicons/react';
import { BotIcon, Globe02Icon } from '@hugeicons/core-free-icons';
import { Badge } from './ui/badge';

export const browserPageLabel = (url: string) => {
  if (!url || url === 'about:blank') return 'New page';
  try { return new URL(url).hostname || 'Browser'; } catch { return 'Browser'; }
};

export function BrowserSiteIcon({ faviconUrl, agent = false }: { faviconUrl?: string; agent?: boolean }) {
  const [failedIcon, setFailedIcon] = useState<string>();
  const icon = browserFaviconUrl(faviconUrl);
  return <span className='relative inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-4' aria-hidden='true'>
    {icon && icon !== failedIcon ? <img src={icon} alt='' className='size-4 object-contain' referrerPolicy='no-referrer' onError={() => setFailedIcon(icon)} /> : <HugeiconsIcon icon={Globe02Icon} />}
    {agent && <Badge className='absolute -right-1 -bottom-1 size-3 p-0 ring-2 ring-sidebar' title='Agent Browser' data-agent-browser-badge><HugeiconsIcon icon={BotIcon} /></Badge>}
  </span>;
}
