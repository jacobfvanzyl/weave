import type { RefObject, ReactNode } from 'react';
import { getClientAppSidebarProducts, type ClientAppDefinition } from '../../lib/client-app';
import type { ProductId } from '../../lib/products';
import { ChatSidebar } from '../products/ChatSidebar';
import { CodeSidebar } from '../products/CodeSidebar';
import { NotesSidebar } from '../products/NotesSidebar';

type AppSidebarHostProps = {
  closeOnPinnedSelect: boolean;
  clientApp: ClientAppDefinition;
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
  clientApp,
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
  const sidebarProducts = getClientAppSidebarProducts(clientApp);
  const showPlainThreads = sidebarProducts.includes('chat');

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
            projectProducts={sidebarProducts}
            showPlainThreads={showPlainThreads}
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
            projectProducts={sidebarProducts}
            showPlainThreads={showPlainThreads}
            onClose={onCloseSidebarPreview}
          />
        </div>
      ) : null}
    </>
  );
};
