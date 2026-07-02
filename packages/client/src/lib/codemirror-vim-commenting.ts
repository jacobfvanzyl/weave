import { toggleComment } from "@codemirror/commands";
import { Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Vim, type CodeMirrorV, type OperatorFn } from "@replit/codemirror-vim";

const WEAVE_TOGGLE_COMMENT_OPERATOR = "weaveToggleComment";
const WEAVE_VIM_COMMENTING_REGISTERED = Symbol.for(
  "weave.vimCommentingRegistered",
);

export type VimCommentingApi = Pick<
  typeof Vim,
  "defineOperator" | "mapCommand"
>;

type RegisteredVimCommentingApi = VimCommentingApi & {
  [WEAVE_VIM_COMMENTING_REGISTERED]?: boolean;
};

const isTransaction = (value: unknown): value is Transaction => {
  if (value instanceof Transaction) return true;
  if (!value || typeof value !== "object") return false;
  return "changes" in value && "startState" in value && "newSelection" in value;
};

const getDispatchedTransactions = (
  view: EditorView,
  args: readonly unknown[],
): readonly Transaction[] => {
  const firstArg = args[0];
  if (isTransaction(firstArg)) return [firstArg];
  if (Array.isArray(firstArg) && firstArg.every(isTransaction)) {
    return firstArg;
  }
  if (args.length === 0) return [];
  return [view.state.update(...(args as TransactionSpec[]))];
};

const weaveToggleCommentOperator: OperatorFn = (
  cm: CodeMirrorV,
  _operatorArgs,
  _ranges,
  oldAnchor,
) => {
  const view = cm.cm6;
  const originalDispatch = view.dispatch;
  let mappedCursor = cm.indexFromPos(oldAnchor);

  view.dispatch = ((...args: unknown[]) => {
    for (const transaction of getDispatchedTransactions(view, args)) {
      mappedCursor = transaction.changes.mapPos(mappedCursor);
    }
    (originalDispatch as (...dispatchArgs: unknown[]) => void).apply(
      view,
      args,
    );
  }) as EditorView["dispatch"];

  try {
    return toggleComment(view) ? cm.posFromIndex(mappedCursor) : oldAnchor;
  } finally {
    view.dispatch = originalDispatch;
  }
};

export const registerWeaveVimCommenting = (
  vimApi: VimCommentingApi = Vim,
) => {
  const registeredApi = vimApi as RegisteredVimCommentingApi;
  if (registeredApi[WEAVE_VIM_COMMENTING_REGISTERED]) return;

  vimApi.defineOperator(
    WEAVE_TOGGLE_COMMENT_OPERATOR,
    weaveToggleCommentOperator,
  );
  vimApi.mapCommand("gc", "operator", WEAVE_TOGGLE_COMMENT_OPERATOR, {}, {
    isEdit: true,
  });

  registeredApi[WEAVE_VIM_COMMENTING_REGISTERED] = true;
};
