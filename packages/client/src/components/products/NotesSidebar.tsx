import { forwardRef, type ComponentProps } from 'react';
import { WorkspaceSidebar } from '../sidebar/WorkspaceSidebar';

type ProductSidebarProps = Omit<ComponentProps<typeof WorkspaceSidebar>, 'product'>;

export const NotesSidebar = forwardRef<HTMLElement, ProductSidebarProps>((props, ref) => (
  <WorkspaceSidebar ref={ref} product="notes" {...props} />
));

NotesSidebar.displayName = 'NotesSidebar';
