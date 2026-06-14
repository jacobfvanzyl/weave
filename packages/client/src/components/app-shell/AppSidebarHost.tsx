import type { RefObject, ReactNode } from 'react';
import { WorkspaceSidebar } from '../sidebar/WorkspaceSidebar';

type AppSidebarHostProps = {
  closeOnPinnedSelect: boolean;
  connectionSettingsButton?: ReactNode;
  isPortraitViewport: boolean;
  isSidebarOpen: boolean;
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
  showSidebarPreview,
  sidebarRef,
  onCloseSidebar,
  onCloseSidebarPreview,
  onOpenSidebarPreview,
  onScheduleSidebarPreviewClose,
}: AppSidebarHostProps) => (
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
        <WorkspaceSidebar
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
