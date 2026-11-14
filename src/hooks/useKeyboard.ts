import { useEffect, useRef } from "react";
import { useShortcutStore } from "@/stores/shortcut.store";
import { useCommandStore } from "@/stores/command.store";
import { useUIStore } from "@/stores/ui.store";
import { isComposeDirty, useComposeStore } from "@/stores/compose.store";
import { useMailStore } from "@/stores/mail.store";
import { useToastStore } from "@/stores/toast.store";
import { updateMessageFlags, archiveMessage, deleteMessage, restoreMessage, getMessage } from "@/lib/api";
import { queryClient } from "@/lib/query-client";
import type { Folder, MessageSummary, ThreadSummary } from "@/lib/api";
import {
  patchMessagesCache,
  readFirstCachedMessages,
  restoreMessagesCache,
  snapshotMessagesCache,
} from "@/hooks/queries";
import { allAccountsFolderId, roleForSelection, type FolderRole } from "@/lib/folderAggregation";
import { VIM_BINDINGS, VIM_PAGE_STEP, VIM_PREFIXES, VIM_SEQUENCE_TIMEOUT_MS } from "@/lib/vimKeys";
import i18n from "@/lib/i18n";

function eventToKeyString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!["Control", "Meta", "Shift", "Alt"].includes(e.key)) {
    parts.push(key);
  }
  return parts.join("+");
}

export { eventToKeyString };

/** Read the first matching cached messages from React Query */
function getCachedMessages(): MessageSummary[] {
  return readFirstCachedMessages(queryClient);
}

/** Read the first matching cached threads from React Query */
function getCachedThreads(): ThreadSummary[] {
  const entries = queryClient.getQueriesData<ThreadSummary[]>({ queryKey: ["threads"] });
  for (const [, data] of entries) {
    if (data && data.length > 0) return data;
  }
  return [];
}

/** All folders currently held in the React Query cache, across accounts */
function getCachedFolders(): Folder[] {
  return queryClient
    .getQueriesData<Folder[]>({ queryKey: ["folders"] })
    .flatMap(([, data]) => (Array.isArray(data) ? data : []));
}

function invalidateAfterMove() {
  queryClient.invalidateQueries({ queryKey: ["messages"] });
  queryClient.invalidateQueries({ queryKey: ["threads"] });
  queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
}

/** The most recent keyboard delete/archive, undone by "u" or the toast button */
let pendingUndo: (() => void) | null = null;

/** Test hook: forget any undo left over from a previous test */
export function resetKeyboardUndo() {
  pendingUndo = null;
}

function registerUndo(undo: () => Promise<unknown>, messageId: string, failureMessage: string): () => void {
  const run = () => {
    if (pendingUndo === run) pendingUndo = null;
    undo()
      .then(() => {
        invalidateAfterMove();
        useMailStore.getState().setSelectedMessage(messageId);
      })
      .catch(() => {
        useToastStore.getState().addToast({ message: failureMessage, type: "error" });
      });
  };
  pendingUndo = run;
  return run;
}

/**
 * In bulk-selection mode, hand the action to the message list's batch handler,
 * which owns the confirmation dialog. Returns false when nothing is selected.
 */
function dispatchBatchAction(action: "delete" | "archive"): boolean {
  const { batchMode, selectedMessageIds } = useMailStore.getState();
  if (!batchMode || selectedMessageIds.size === 0) return false;
  document.dispatchEvent(new CustomEvent("pebble:batch-action", { detail: action }));
  return true;
}

/** Move the selection by `delta` messages (or threads), clamped to the list */
function moveSelectionBy(delta: number) {
  const state = useMailStore.getState();
  if (state.threadView) {
    const threads = getCachedThreads();
    if (threads.length === 0) return;
    const idx = threads.findIndex((t) => t.thread_id === state.selectedThreadId);
    const next = Math.min(Math.max((idx < 0 ? 0 : idx + delta), 0), threads.length - 1);
    state.setSelectedThreadId(threads[next].thread_id);
  } else {
    const messages = getCachedMessages();
    if (messages.length === 0) return;
    const idx = messages.findIndex((m) => m.id === state.selectedMessageId);
    const next = Math.min(Math.max((idx < 0 ? 0 : idx + delta), 0), messages.length - 1);
    state.setSelectedMessage(messages[next].id);
  }
}

/** x: add or remove the current message from the bulk selection */
function toggleCurrentInSelection() {
  const state = useMailStore.getState();
  if (state.threadView || !state.selectedMessageId) return;
  if (!state.batchMode) state.toggleBatchMode();
  useMailStore.getState().toggleMessageSelection(state.selectedMessageId);
}

/**
 * Move the selected message to Trash from the keyboard.
 *
 * Unlike the toolbar button this skips the confirm dialog, because it can only
 * ever move to Trash, and offers Undo instead. Anything that would be a
 * permanent delete (a message already in Trash, or a local-only draft) is
 * refused here and left to the toolbar's confirmed Delete button.
 */
function deleteSelectedMessage() {
  if (dispatchBatchAction("delete")) return;
  const mail = useMailStore.getState();
  const selectedId = mail.selectedMessageId;
  if (!selectedId) return;

  const toast = useToastStore.getState();
  const folderRole = roleForSelection(mail.activeFolderId, getCachedFolders());
  const messages = getCachedMessages();
  const idx = messages.findIndex((m) => m.id === selectedId);
  const msg = idx >= 0 ? messages[idx] : undefined;

  if (folderRole === "trash" || (msg?.is_draft && msg.remote_id === "")) {
    toast.addToast({
      message: i18n.t(
        "messageActions.permanentDeleteNeedsButton",
        "Use the Delete button to permanently delete this message",
      ),
      type: "info",
    });
    return;
  }

  // Keep the reader moving: select the next message, or the previous one at the end
  const neighbour = idx >= 0 ? (messages[idx + 1] ?? messages[idx - 1]) : undefined;
  const previousLists = snapshotMessagesCache(queryClient);
  patchMessagesCache(queryClient, (page) => page.filter((m) => m.id !== selectedId));
  mail.setSelectedMessage(neighbour?.id ?? null);

  deleteMessage(selectedId)
    .then(() => {
      invalidateAfterMove();
      toast.addToast({
        message: i18n.t("messageActions.deleteSuccess", "Message deleted"),
        type: "success",
        action: {
          label: i18n.t("common.undo", "Undo"),
          onClick: registerUndo(
            () => restoreMessage(selectedId),
            selectedId,
            i18n.t("messageActions.restoreFailed", "Failed to restore message"),
          ),
        },
      });
    })
    .catch(() => {
      restoreMessagesCache(queryClient, previousLists);
      useMailStore.getState().setSelectedMessage(selectedId);
      toast.addToast({
        message: i18n.t("messageActions.deleteFailed", "Failed to delete message"),
        type: "error",
      });
    });
}

/** Select the first or last message (or thread) in the loaded list */
function selectMessageAt(position: "first" | "last") {
  const state = useMailStore.getState();
  if (state.threadView) {
    const threads = getCachedThreads();
    const thread = position === "first" ? threads[0] : threads[threads.length - 1];
    if (thread) state.setSelectedThreadId(thread.thread_id);
  } else {
    const messages = getCachedMessages();
    const message = position === "first" ? messages[0] : messages[messages.length - 1];
    if (message) state.setSelectedMessage(message.id);
  }
}

function closeSelectedMessage() {
  const state = useMailStore.getState();
  if (state.threadView) state.setSelectedThreadId(null);
  else state.setSelectedMessage(null);
}

/**
 * Open the system folder with this role for the active account, or the
 * combined folder when viewing all accounts. Respects unsaved compose drafts
 * the same way a sidebar click does.
 */
function goToFolderRole(role: FolderRole) {
  const { activeAccountId } = useMailStore.getState();
  const folderId = activeAccountId
    ? getCachedFolders().find((f) => f.account_id === activeAccountId && f.role === role)?.id
    : allAccountsFolderId(role);
  if (!folderId) return;

  if (isComposeDirty()) {
    useComposeStore.setState({
      showComposeLeaveConfirm: true,
      pendingView: "inbox",
      pendingNavigation: () => useMailStore.getState().setActiveFolderId(folderId),
    });
    return;
  }
  useUIStore.getState().setActiveView("inbox");
  useMailStore.getState().setActiveFolderId(folderId);
}

/** Execute a shortcut action. Shared by rebindable shortcuts and vim keys. */
function runAction(actionId: string) {
  switch (actionId) {
    case "close-modal":
      if (useCommandStore.getState().isOpen) {
        useCommandStore.getState().close();
      } else if (useUIStore.getState().activeView === "compose") {
        useComposeStore.getState().closeCompose();
      } else if (useUIStore.getState().activeView === "search") {
        useUIStore.getState().setActiveView("inbox");
      } else if (useMailStore.getState().batchMode) {
        useMailStore.getState().toggleBatchMode();
      }
      break;
    case "toggle-view-inbox":
      useUIStore.getState().setActiveView("inbox");
      break;
    case "toggle-view-kanban":
      useUIStore.getState().setActiveView("kanban");
      break;
    case "toggle-star": {
      const { selectedMessageId } = useMailStore.getState();
      if (selectedMessageId) {
        const messages = getCachedMessages();
        const msg = messages.find((m) => m.id === selectedMessageId);
        if (msg) {
          const newStarred = !msg.is_starred;
          // Optimistic update in React Query cache
          patchMessagesCache(queryClient, (page) =>
            page.map((m) =>
              m.id === selectedMessageId ? { ...m, is_starred: newStarred } : m,
            ),
          );
          updateMessageFlags(selectedMessageId, undefined, newStarred)
            .then(() => queryClient.invalidateQueries({ queryKey: ["messages"] }))
            .catch(() => {
              // Rollback on error
              patchMessagesCache(queryClient, (page) =>
                page.map((m) =>
                  m.id === selectedMessageId ? { ...m, is_starred: !newStarred } : m,
                ),
              );
            });
        }
      }
      break;
    }
    case "archive-message": {
      if (dispatchBatchAction("archive")) break;
      const { selectedMessageId } = useMailStore.getState();
      if (selectedMessageId) {
        // Optimistic removal from React Query cache
        patchMessagesCache(queryClient, (page) =>
          page.filter((m) => m.id !== selectedMessageId),
        );
        useMailStore.getState().setSelectedMessage(null);
        archiveMessage(selectedMessageId)
          .then((result) => {
            if (result === "skipped") return;
            queryClient.invalidateQueries({ queryKey: ["messages"] });
            queryClient.invalidateQueries({ queryKey: ["threads"] });
            queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] });
            const msg = result === "unarchived" ? i18n.t("messageActions.unarchiveSuccess", "Message moved to inbox") : i18n.t("messageActions.archiveSuccess", "Message archived");
            // Archiving an archived message moves it back, so the same call undoes it
            const undo = result === "archived"
              ? registerUndo(
                () => archiveMessage(selectedMessageId),
                selectedMessageId,
                i18n.t("messageActions.unarchiveFailed", "Failed to unarchive"),
              )
              : undefined;
            useToastStore.getState().addToast({
              message: msg,
              type: "success",
              ...(undo ? { action: { label: i18n.t("common.undo", "Undo"), onClick: undo } } : {}),
            });
          })
          .catch(() => {
            queryClient.invalidateQueries({ queryKey: ["messages"] });
            useMailStore.getState().setSelectedMessage(selectedMessageId);
            useToastStore.getState().addToast({ message: i18n.t("messageActions.archiveFailed", "Failed to archive"), type: "error" });
          });
      }
      break;
    }
    case "delete-message":
      deleteSelectedMessage();
      break;
    case "next-message": {
      const state = useMailStore.getState();
      if (state.threadView) {
        const threads = getCachedThreads();
        const idx = threads.findIndex((t) => t.thread_id === state.selectedThreadId);
        if (idx < threads.length - 1) {
          state.setSelectedThreadId(threads[idx + 1].thread_id);
        }
      } else {
        const messages = getCachedMessages();
        const idx = messages.findIndex((m) => m.id === state.selectedMessageId);
        if (idx < messages.length - 1) {
          state.setSelectedMessage(messages[idx + 1].id);
        }
      }
      break;
    }
    case "prev-message": {
      const state = useMailStore.getState();
      if (state.threadView) {
        const threads = getCachedThreads();
        const idx = threads.findIndex((t) => t.thread_id === state.selectedThreadId);
        if (idx > 0) {
          state.setSelectedThreadId(threads[idx - 1].thread_id);
        }
      } else {
        const messages = getCachedMessages();
        const idx = messages.findIndex((m) => m.id === state.selectedMessageId);
        if (idx > 0) {
          state.setSelectedMessage(messages[idx - 1].id);
        }
      }
      break;
    }
    case "compose-new":
      useComposeStore.getState().openCompose("new");
      break;
    case "reply": {
      const { selectedMessageId: selId } = useMailStore.getState();
      if (selId) {
        getMessage(selId).then((msg) => {
          if (msg) useComposeStore.getState().openCompose("reply", msg);
        });
      }
      break;
    }
    case "reply-all": {
      const { selectedMessageId: selId } = useMailStore.getState();
      if (selId) {
        getMessage(selId).then((msg) => {
          if (msg) useComposeStore.getState().openCompose("reply-all", msg);
        });
      }
      break;
    }
    case "forward": {
      const { selectedMessageId: selId } = useMailStore.getState();
      if (selId) {
        getMessage(selId).then((msg) => {
          if (msg) useComposeStore.getState().openCompose("forward", msg);
        });
      }
      break;
    }
    case "focus-search":
      useUIStore.getState().setActiveView("search");
      break;
    case "open-message": {
      const state = useMailStore.getState();
      if (state.threadView) {
        if (!state.selectedThreadId) {
          const threads = getCachedThreads();
          if (threads.length > 0) {
            state.setSelectedThreadId(threads[0].thread_id);
          }
        }
      } else {
        if (!state.selectedMessageId) {
          const messages = getCachedMessages();
          if (messages.length > 0) {
            state.setSelectedMessage(messages[0].id);
          }
        }
      }
      break;
    }
    case "open-search":
      useUIStore.getState().setActiveView("search");
      break;
    case "open-cloud-settings":
      useUIStore.getState().setActiveView("settings");
      break;
    case "toggle-notifications": {
      const { notificationsEnabled, setNotificationsEnabled } = useUIStore.getState();
      setNotificationsEnabled(!notificationsEnabled);
      break;
    }
    case "translate-selection":
      document.dispatchEvent(new CustomEvent("pebble:translate-selection"));
      break;
    case "toggle-bilingual":
      document.dispatchEvent(new CustomEvent("pebble:toggle-bilingual"));
      break;
    case "first-message":
      selectMessageAt("first");
      break;
    case "last-message":
      selectMessageAt("last");
      break;
    case "close-message":
      closeSelectedMessage();
      break;
    case "page-down":
      moveSelectionBy(VIM_PAGE_STEP);
      break;
    case "page-up":
      moveSelectionBy(-VIM_PAGE_STEP);
      break;
    case "toggle-select":
      toggleCurrentInSelection();
      break;
    case "undo":
      if (pendingUndo) {
        pendingUndo();
      } else {
        useToastStore.getState().addToast({
          message: i18n.t("shortcuts.vim.nothingToUndo", "Nothing to undo"),
          type: "info",
        });
      }
      break;
    case "show-shortcuts":
      useUIStore.getState().setSettingsTab("shortcuts");
      useUIStore.getState().setActiveView("settings");
      break;
    case "go-inbox":
      goToFolderRole("inbox");
      break;
    case "go-sent":
      goToFolderRole("sent");
      break;
    case "go-drafts":
      goToFolderRole("drafts");
      break;
    case "go-archive":
      goToFolderRole("archive");
      break;
    case "go-trash":
      goToFolderRole("trash");
      break;
    default:
      break;
  }
}

export function useKeyboard() {
  // Reverse lookup: keyString (lowercase) -> actionId, rebuilt only when bindings change
  const keyToActionRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const bindings = useShortcutStore.getState().bindings;
    const map = new Map<string, string>();
    for (const [actionId, keys] of Object.entries(bindings)) {
      map.set(keys.toLowerCase(), actionId);
    }
    keyToActionRef.current = map;

    // Also subscribe to future binding changes
    const unsubscribe = useShortcutStore.subscribe((state) => {
      const updated = new Map<string, string>();
      for (const [actionId, keys] of Object.entries(state.bindings)) {
        updated.set(keys.toLowerCase(), actionId);
      }
      keyToActionRef.current = updated;
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    // First key of a pending vim sequence ("d", "g"), cleared after a timeout
    let pendingKey: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const clearPending = () => {
      pendingKey = null;
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      pendingTimer = undefined;
    };

    function handleKeyDown(e: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return;
      // Don't interfere with shortcut recording
      if (useShortcutStore.getState().recording) return;
      // A bare modifier press (e.g. Shift before G) must not break a sequence
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;

      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      const keyString = eventToKeyString(e).toLowerCase();
      const actionId = keyToActionRef.current.get(keyString);

      // Command palette always works even in inputs
      if (actionId === "command-palette") {
        clearPending();
        e.preventDefault();
        useCommandStore.getState().open();
        return;
      }

      // Skip single-key shortcuts when in inputs
      if (isInput) {
        clearPending();
        return;
      }

      if (useShortcutStore.getState().vimMode) {
        const previousKey = pendingKey;
        clearPending();

        if (previousKey) {
          const sequenceAction = VIM_BINDINGS[`${previousKey} ${keyString}`];
          if (sequenceAction) {
            e.preventDefault();
            runAction(sequenceAction);
            return;
          }
          // Not a known sequence: handle this key on its own below
        }

        // User bindings take priority over vim keys
        if (!actionId) {
          if (VIM_PREFIXES.has(keyString)) {
            e.preventDefault();
            pendingKey = keyString;
            pendingTimer = setTimeout(clearPending, VIM_SEQUENCE_TIMEOUT_MS);
            return;
          }
          const vimAction = VIM_BINDINGS[keyString];
          if (vimAction) {
            e.preventDefault();
            runAction(vimAction);
            return;
          }
        }
      }

      if (!actionId) return;
      e.preventDefault();
      runAction(actionId);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearPending();
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
