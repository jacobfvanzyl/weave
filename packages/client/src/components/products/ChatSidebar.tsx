import { forwardRef, type ComponentProps } from 'react';
import { WorkspaceSidebar } from '../sidebar/WorkspaceSidebar';

type ProductSidebarProps = Omit<ComponentProps<typeof WorkspaceSidebar>, 'product'>;

export const ChatSidebar = forwardRef<HTMLElement, ProductSidebarProps>((props, ref) => (
  <WorkspaceSidebar ref={ref} product="chat" {...props} />
));

ChatSidebar.displayName = 'ChatSidebar';
