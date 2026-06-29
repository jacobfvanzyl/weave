import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createClientAppPersistStorage,
  getBuildClientAppId,
  getClientAppDefinition,
  getClientAppStorageKey,
  sanitizeProductForClientApp,
} from '../lib/client-app';
import type { ProductId } from '../lib/products';

type ProductState = {
  activeProduct: ProductId;
  setActiveProduct: (activeProduct: ProductId) => void;
};

export const useProductStore = create<ProductState>()(
  persist(
    set => ({
      activeProduct: getClientAppDefinition().defaultProduct,
      setActiveProduct: activeProduct => set({ activeProduct: sanitizeProductForClientApp(activeProduct) }),
    }),
    {
      name: getClientAppStorageKey('weave.product-mode.v1'),
      version: 1,
      storage: createClientAppPersistStorage('weave.product-mode.v1'),
      migrate: persistedState => {
        const state = persistedState && typeof persistedState === 'object'
          ? persistedState as Partial<ProductState>
          : {};
        return {
          activeProduct: sanitizeProductForClientApp(state.activeProduct),
        };
      },
      merge: (persistedState, currentState) => {
        const state = persistedState && typeof persistedState === 'object'
          ? persistedState as Partial<ProductState>
          : {};
        return {
          ...currentState,
          activeProduct: sanitizeProductForClientApp(state.activeProduct ?? currentState.activeProduct),
        };
      },
      partialize: state => ({ activeProduct: state.activeProduct }),
    },
  ),
);

export const getActiveClientAppId = getBuildClientAppId;
