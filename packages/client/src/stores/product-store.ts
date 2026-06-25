import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProductId } from '../lib/products';

type ProductState = {
  activeProduct: ProductId;
  setActiveProduct: (activeProduct: ProductId) => void;
};

export const useProductStore = create<ProductState>()(
  persist(
    set => ({
      activeProduct: 'code',
      setActiveProduct: activeProduct => set({ activeProduct }),
    }),
    {
      name: 'weave.product-mode.v1',
      version: 1,
      partialize: state => ({ activeProduct: state.activeProduct }),
    },
  ),
);
