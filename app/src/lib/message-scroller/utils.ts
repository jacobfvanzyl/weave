// Adapted from shadcn/ui packages/react/src/message-scroller/utils.ts at 4aaea19d9cff
// (MIT, Copyright (c) 2023 shadcn). See ./README.md for what weave changed.

import * as React from "react"

function useLatest<T>(value: T) {
  const ref = React.useRef(value)

  ref.current = value

  return ref
}

export { useLatest }

// A ref callback that sets each of the given refs, which the upstream's own use-render provided.
function composeRefs<T>(...refs: (React.Ref<T> | undefined)[]) {
  return (value: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value)
      else if (ref) (ref as React.RefObject<T | null>).current = value
    }
  }
}

export { composeRefs }
