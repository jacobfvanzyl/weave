import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppResume } from "./use-app-resume";

const lifecycle = vi.hoisted(() => ({
  listener: undefined as ((state: { isActive: boolean }) => void) | undefined,
  remove: vi.fn(async () => undefined),
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (
        _event: string,
        listener: (state: { isActive: boolean }) => void,
      ) => {
        lifecycle.listener = listener;
        return { remove: lifecycle.remove };
      },
    ),
  },
}));

beforeEach(() => {
  lifecycle.listener = undefined;
  lifecycle.remove.mockClear();
});

describe("useAppResume", () => {
  it("runs only after the app returns from an inactive state", async () => {
    const onResume = vi.fn();
    const { unmount } = renderHook(() => useAppResume(onResume));
    await act(async () => await Promise.resolve());

    act(() => lifecycle.listener?.({ isActive: true }));
    expect(onResume).not.toHaveBeenCalled();
    act(() => lifecycle.listener?.({ isActive: false }));
    act(() => lifecycle.listener?.({ isActive: true }));
    expect(onResume).toHaveBeenCalledOnce();

    unmount();
    await expect.poll(() => lifecycle.remove).toHaveBeenCalledOnce();
  });
});
