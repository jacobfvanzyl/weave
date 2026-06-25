import type { RefObject, ReactNode } from 'react';
import type { ProductId } from '../../lib/products';
import { ChatSidebar } from '../products/ChatSidebar';
import { CodeSidebar } from '../products/CodeSidebar';
import { NotesSidebar } from '../products/NotesSidebar';

type AppSidebarHostProps = {
  closeOnPinnedSelect: boolean;
  connectionSettingsButton?: ReactNode;
  isPortraitViewport: boolean;
  isSidebarOpen: boolean;
  product: ProductId;
  showSidebarPreview: boolean;
  sidebarRef: RefObject<HTMLElement | null>;
  onCloseSidebar: () => void;
  onCloseSidebarPreview: () => void;
  onOpenSidebarPreview: () => void;
  onScheduleSidebarPreviewClose: () => void;
};

export const AppSidebarHost = ({
  closeOnPinnedSelect,
  connectionSettingsButton,
  isPortraitViewport,
  isSidebarOpen,
  product,
  showSidebarPreview,
  sidebarRef,
  onCloseSidebar,
  onCloseSidebarPreview,
  onOpenSidebarPreview,
  onScheduleSidebarPreviewClose,
}: AppSidebarHostProps) => {
  const Sidebar = product === 'notes' ? NotesSidebar : product === 'chat' ? ChatSidebar : CodeSidebar;

  return (
    <>
      {isSidebarOpen ? (
        <>
          <button
            className="fixed inset-0 z-30 bg-background/80 md:hidden"
            aria-label="Close sidebar"
            onClick={onCloseSidebar}
          />
          <Sidebar
            ref={sidebarRef}
            closeOnSelect={closeOnPinnedSelect}
            connectionSettingsButton={connectionSettingsButton}
            onClose={onCloseSidebar}
          />
        </>
      ) : null}
      {showSidebarPreview ? (
        <div
          data-weave-sidebar-preview
          {...(!isPortraitViewport
            ? {
                onMouseEnter: onOpenSidebarPreview,
                onMouseLeave: onScheduleSidebarPreviewClose,
              }
            : {})}
        >
          {isPortraitViewport ? (
            <button
              className="fixed inset-0 z-30 bg-background/80"
              aria-label="Close sidebar"
              onClick={onCloseSidebarPreview}
            />
          ) : null}
          <Sidebar
            ref={sidebarRef}
            presentation="overlay"
            closeOnSelect
            connectionSettingsButton={connectionSettingsButton}
            onClose={onCloseSidebarPreview}
          />
        </div>
      ) : null}
    </>
  );
};
