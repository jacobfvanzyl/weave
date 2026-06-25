import { forwardRef, type ComponentProps } from 'react';
import { WorkspaceSidebar } from '../sidebar/WorkspaceSidebar';

type ProductSidebarProps = Omit<ComponentProps<typeof WorkspaceSidebar>, 'product'>;

export const CodeSidebar = forwardRef<HTMLElement, ProductSidebarProps>((props, ref) => (
  <WorkspaceSidebar ref={ref} product="code" {...props} />
));

CodeSidebar.displayName = 'CodeSidebar';
