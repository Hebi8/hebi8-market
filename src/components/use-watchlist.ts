"use client";

import { useEffect, useOptimistic, useRef, useTransition } from "react";
import { addSymbol, editWatchlist } from "@/app/actions";
import { useLocalStorage } from "@/lib/use-local-storage";
import { applyOp, COLLAPSED_KEY, mergeTarget, opError, type ListGroup, type WatchlistOp } from "@/lib/watchlist";
import { useUi } from "./UiProvider";
import { useDragSort } from "./use-drag-sort";

/** What removing a symbol needs to say what went and to put it back: the name shown, and the yaml's own `name` and `bench`. */
export interface Removable {
  key: string;
  name: string;
  yamlName: string | null;
  bench: string | null;
}

/**
 * The watchlist's groups as the overview and the chart's panel edit them: every change shows at
 * once and is written to the yaml by `editWatchlist`, which applies the same edit with the same
 * rules; one the rules refuse is not sent, and says why at once. A failure on the server puts its
 * order back and says why. Folded groups are remembered in the browser.
 */
export function useWatchlist<T extends { key: string }>(groups: ListGroup<T>[], { readOnly, sorted = false }: { readOnly: boolean; sorted?: boolean }) {
  const { toast } = useUi();
  const [list, apply] = useOptimistic(groups, (state: ListGroup<T>[], op: WatchlistOp) => applyOp(state, op));
  const [, startTransition] = useTransition();
  const [collapsed, setCollapsed] = useLocalStorage<string[]>(COLLAPSED_KEY, []);
  // what is folded when an action comes back, not when it was sent
  const latestCollapsed = useRef(collapsed);
  useEffect(() => {
    latestCollapsed.current = collapsed;
  });

  const run = (op: WatchlistOp, done?: () => void) => {
    const error = opError(list, op);
    if (error) return toast(error, { kind: "error" });
    startTransition(async () => {
      apply(op);
      const result = await editWatchlist(op);
      if (result.ok) done?.();
      else toast(result.error, { kind: "error" });
    });
  };

  const edit = {
    moveSymbol: (key: string, group: string, index: number) => run({ type: "moveSymbol", key, group, index }),
    /** Gone at once, with a toast that puts it back at the end of its group (the first fetch of `addSymbol` included). */
    removeSymbol: (item: Removable, group: string) =>
      run({ type: "removeSymbol", key: item.key }, () =>
        toast(`已移除 ${item.name}`, {
          action: {
            label: "撤销",
            onClick: () =>
              void addSymbol({ key: item.key, group, name: item.yamlName ?? undefined, bench: item.bench ?? undefined }).then((result) => {
                if (!result.ok) toast(result.error, { kind: "error" });
              }),
          },
        }),
      ),
    moveGroup: (name: string, index: number) => run({ type: "moveGroup", name, index }),
    addGroup: (name: string) => run({ type: "addGroup", name }),
    renameGroup: (name: string, next: string) =>
      run({ type: "renameGroup", name, next }, () => {
        const now = latestCollapsed.current;
        if (now.includes(name)) setCollapsed(now.map((n) => (n === name ? next : n)));
      }),
    deleteGroup: (name: string) => {
      const into = mergeTarget(list, name);
      const count = list.find((g) => g.name === name)?.items.length ?? 0;
      run({ type: "deleteGroup", name }, () => toast(count && into ? `已删除分组「${name}」，${count} 个标的并入「${into}」` : `已删除分组「${name}」`));
    },
  };

  const toggle = (name: string) => setCollapsed(collapsed.includes(name) ? collapsed.filter((n) => n !== name) : [...collapsed, name]);

  const drag = useDragSort({
    groups: list,
    collapsed,
    enabled: !readOnly && !sorted,
    onDrop: (d) => (d.kind === "symbol" ? edit.moveSymbol(d.key, d.group, d.index) : edit.moveGroup(d.name, d.index)),
    expand: (name) => setCollapsed(latestCollapsed.current.filter((n) => n !== name)),
  });

  return { groups: list, collapsed, toggle, edit, drag, readOnly, canDrag: !readOnly && !sorted };
}
