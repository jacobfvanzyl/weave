import type { RefObject, ReactNode } from 'react';
import { getClientAppSidebarProducts, type ClientAppDefinition } from '../../lib/client-app';
import type { ProductId } from '../../lib/products';
import { WorkspaceSidebar } from '../sidebar/WorkspaceSidebar';

type AppSidebarHostProps = {
  adoptedLocalPortalId?: string;
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
  adoptedLocalPortalId,
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
  const sidebarProducts = getClientAppSidebarProducts(clientApp);
  const sidebarProduct = sidebarProducts.length > 1 ? clientApp.defaultProduct : product;
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
          <WorkspaceSidebar
            ref={sidebarRef}
            adoptedLocalPortalId={adoptedLocalPortalId}
            closeOnSelect={closeOnPinnedSelect}
            connectionSettingsButton={connectionSettingsButton}
            product={sidebarProduct}
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
          <WorkspaceSidebar
            ref={sidebarRef}
            adoptedLocalPortalId={adoptedLocalPortalId}
            presentation="overlay"
            closeOnSelect
            connectionSettingsButton={connectionSettingsButton}
            product={sidebarProduct}
            projectProducts={sidebarProducts}
            showPlainThreads={showPlainThreads}
            onClose={onCloseSidebarPreview}
          />
        </div>
      ) : null}
    </>
  );
};
