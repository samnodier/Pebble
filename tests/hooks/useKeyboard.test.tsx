import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BINDINGS, useShortcutStore } from "../../src/stores/shortcut.store";
import { useMailStore } from "../../src/stores/mail.store";
import { useToastStore } from "../../src/stores/toast.store";

const mocks = vi.hoisted(() => ({
  queryClient: {
    invalidateQueries: vi.fn(),
    getQueriesData: vi.fn(() => []),
  },
  archiveMessage: vi.fn(),
  deleteMessage: vi.fn(),
  restoreMessage: vi.fn(),
  updateMessageFlags: vi.fn(),
  getMessage: vi.fn(),
  patchMessagesCache: vi.fn(),
  readFirstCachedMessages: vi.fn(() => []),
  snapshotMessagesCache: vi.fn(() => "snapshot"),
  restoreMessagesCache: vi.fn(),
}));

vi.mock("../../src/lib/query-client", () => ({
  queryClient: mocks.queryClient,
}));

vi.mock("../../src/lib/api", () => ({
  archiveMessage: mocks.archiveMessage,
  deleteMessage: mocks.deleteMessage,
  restoreMessage: mocks.restoreMessage,
  updateMessageFlags: mocks.updateMessageFlags,
  getMessage: mocks.getMessage,
}));

vi.mock("../../src/hooks/queries", () => ({
  patchMessagesCache: mocks.patchMessagesCache,
  readFirstCachedMessages: mocks.readFirstCachedMessages,
  snapshotMessagesCache: mocks.snapshotMessagesCache,
  restoreMessagesCache: mocks.restoreMessagesCache,
}));

vi.mock("../../src/lib/i18n", () => ({
  default: {
    t: (_key: string, fallback: string) => fallback,
  },
}));

import { resetKeyboardUndo, useKeyboard } from "../../src/hooks/useKeyboard";
import { useUIStore } from "../../src/stores/ui.store";

describe("useKeyboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetKeyboardUndo();
    mocks.archiveMessage.mockResolvedValue("archived");
    useShortcutStore.setState({
      bindings: { ...DEFAULT_BINDINGS, "archive-message": "E" },
      recording: null,
    });
    useMailStore.setState({
      selectedMessageId: "message-1",
      selectedThreadId: null,
      threadView: false,
    });
  });

  it("refreshes folder unread counts after the archive shortcut succeeds", async () => {
    renderHook(() => useKeyboard());

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    });

    await waitFor(() => expect(mocks.archiveMessage).toHaveBeenCalledWith("message-1"));
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["folder-unread-counts"] });
  });

  describe("delete shortcut", () => {
    const inbox = { id: "inbox-1", account_id: "acc-1", role: "inbox" };
    const trash = { id: "trash-1", account_id: "acc-1", role: "trash" };
    const msg = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      remote_id: `r-${id}`,
      is_draft: false,
      ...extra,
    });

    function pressDelete() {
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      });
    }

    beforeEach(() => {
      mocks.deleteMessage.mockResolvedValue(undefined);
      mocks.restoreMessage.mockResolvedValue(undefined);
      mocks.queryClient.getQueriesData.mockImplementation(
        ({ queryKey }: { queryKey: string[] }) =>
          queryKey[0] === "folders" ? [[["folders", "acc-1"], [inbox, trash]]] : [],
      );
      mocks.readFirstCachedMessages.mockReturnValue([
        msg("message-0"),
        msg("message-1"),
        msg("message-2"),
      ]);
      useMailStore.setState({ activeFolderId: "inbox-1" });
      useToastStore.setState({ toasts: [] });
    });

    it("binds the Delete key by default", () => {
      expect(DEFAULT_BINDINGS["delete-message"]).toBe("Delete");
    });

    it("moves the selected message to trash and selects the next one", async () => {
      renderHook(() => useKeyboard());
      pressDelete();

      await waitFor(() => expect(mocks.deleteMessage).toHaveBeenCalledWith("message-1"));
      expect(useMailStore.getState().selectedMessageId).toBe("message-2");
      await waitFor(() =>
        expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["folder-unread-counts"] }),
      );
    });

    it("selects the previous message when deleting the last one", async () => {
      useMailStore.setState({ selectedMessageId: "message-2" });
      renderHook(() => useKeyboard());
      pressDelete();

      await waitFor(() => expect(mocks.deleteMessage).toHaveBeenCalledWith("message-2"));
      expect(useMailStore.getState().selectedMessageId).toBe("message-1");
    });

    it("offers undo that restores the message", async () => {
      renderHook(() => useKeyboard());
      pressDelete();

      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.action)).toBe(true));
      const toast = useToastStore.getState().toasts.find((t) => t.action)!;
      act(() => toast.action!.onClick());

      await waitFor(() => expect(mocks.restoreMessage).toHaveBeenCalledWith("message-1"));
      await waitFor(() => expect(useMailStore.getState().selectedMessageId).toBe("message-1"));
    });

    it("rolls back when the delete fails", async () => {
      mocks.deleteMessage.mockRejectedValue(new Error("offline"));
      renderHook(() => useKeyboard());
      pressDelete();

      await waitFor(() => expect(mocks.restoreMessagesCache).toHaveBeenCalled());
      expect(useMailStore.getState().selectedMessageId).toBe("message-1");
    });

    it("never permanently deletes from the trash folder", () => {
      useMailStore.setState({ activeFolderId: "trash-1" });
      renderHook(() => useKeyboard());
      pressDelete();

      expect(mocks.deleteMessage).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts.at(-1)?.type).toBe("info");
    });

    it("never permanently deletes a local-only draft", () => {
      mocks.readFirstCachedMessages.mockReturnValue([msg("message-1", { is_draft: true, remote_id: "" })]);
      renderHook(() => useKeyboard());
      pressDelete();

      expect(mocks.deleteMessage).not.toHaveBeenCalled();
    });

    it("ignores the key while typing in an input", () => {
      renderHook(() => useKeyboard());
      const input = document.createElement("input");
      document.body.appendChild(input);
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      });
      input.remove();

      expect(mocks.deleteMessage).not.toHaveBeenCalled();
    });
  });

  describe("vim keys", () => {
    const folders = [
      { id: "inbox-1", account_id: "acc-1", role: "inbox" },
      { id: "sent-1", account_id: "acc-1", role: "sent" },
      { id: "trash-1", account_id: "acc-1", role: "trash" },
      { id: "inbox-2", account_id: "acc-2", role: "inbox" },
    ];

    function press(key: string, init: KeyboardEventInit = {}) {
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
      });
    }

    beforeEach(() => {
      mocks.deleteMessage.mockResolvedValue(undefined);
      mocks.queryClient.getQueriesData.mockImplementation(
        ({ queryKey }: { queryKey: string[] }) =>
          queryKey[0] === "folders" ? [[["folders", "acc-1"], folders]] : [],
      );
      mocks.readFirstCachedMessages.mockReturnValue([
        { id: "message-0", remote_id: "r0", is_draft: false },
        { id: "message-1", remote_id: "r1", is_draft: false },
        { id: "message-2", remote_id: "r2", is_draft: false },
      ]);
      useShortcutStore.setState({ vimMode: true });
      useMailStore.setState({ activeAccountId: "acc-1", activeFolderId: "inbox-1" });
    });

    it("dd moves the selected message to trash", async () => {
      renderHook(() => useKeyboard());
      press("d");
      expect(mocks.deleteMessage).not.toHaveBeenCalled();
      press("d");
      await waitFor(() => expect(mocks.deleteMessage).toHaveBeenCalledWith("message-1"));
    });

    it("forgets a pending d after the timeout", () => {
      vi.useFakeTimers();
      try {
        renderHook(() => useKeyboard());
        press("d");
        act(() => vi.advanceTimersByTime(1100));
        press("d");
        expect(mocks.deleteMessage).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("handles a non-matching second key on its own", () => {
      renderHook(() => useKeyboard());
      press("d");
      press("j");
      expect(useMailStore.getState().selectedMessageId).toBe("message-2");
      expect(mocks.deleteMessage).not.toHaveBeenCalled();
    });

    it("gg selects the first message and G the last", () => {
      renderHook(() => useKeyboard());
      press("g");
      press("g");
      expect(useMailStore.getState().selectedMessageId).toBe("message-0");
      press("Shift", { shiftKey: true });
      press("G", { shiftKey: true });
      expect(useMailStore.getState().selectedMessageId).toBe("message-2");
    });

    it("h closes the open message and l opens the first one", () => {
      renderHook(() => useKeyboard());
      press("h");
      expect(useMailStore.getState().selectedMessageId).toBeNull();
      press("l");
      expect(useMailStore.getState().selectedMessageId).toBe("message-0");
    });

    it("g-prefixed keys go to the active account's folders", () => {
      renderHook(() => useKeyboard());
      press("g");
      press("s");
      expect(useMailStore.getState().activeFolderId).toBe("sent-1");
      press("g");
      press("t");
      expect(useMailStore.getState().activeFolderId).toBe("trash-1");
      press("g");
      press("i");
      expect(useMailStore.getState().activeFolderId).toBe("inbox-1");
    });

    it("goes to the combined folder when viewing all accounts", () => {
      useMailStore.setState({ activeAccountId: null });
      renderHook(() => useKeyboard());
      press("g");
      press("s");
      expect(useMailStore.getState().activeFolderId).toBe("all:sent");
    });

    it("does nothing when vim keys are turned off", () => {
      useShortcutStore.setState({ vimMode: false });
      renderHook(() => useKeyboard());
      press("d");
      press("d");
      press("h");
      expect(mocks.deleteMessage).not.toHaveBeenCalled();
      expect(useMailStore.getState().selectedMessageId).toBe("message-1");
    });

    it("lets the user's own bindings win over vim keys", async () => {
      useShortcutStore.setState({ bindings: { ...DEFAULT_BINDINGS, "archive-message": "D" } });
      renderHook(() => useKeyboard());
      press("d");
      await waitFor(() => expect(mocks.archiveMessage).toHaveBeenCalledWith("message-1"));
      expect(mocks.deleteMessage).not.toHaveBeenCalled();
    });

    it("ignores vim keys while typing", () => {
      renderHook(() => useKeyboard());
      const input = document.createElement("input");
      document.body.appendChild(input);
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
      });
      input.remove();
      expect(mocks.deleteMessage).not.toHaveBeenCalled();
    });
  });

  describe("vim paging, selection, undo and help", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, remote_id: `r${i}`, is_draft: false }));

    function press(key: string, init: KeyboardEventInit = {}) {
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
      });
    }

    beforeEach(() => {
      mocks.deleteMessage.mockResolvedValue(undefined);
      mocks.restoreMessage.mockResolvedValue(undefined);
      mocks.readFirstCachedMessages.mockReturnValue(many);
      mocks.queryClient.getQueriesData.mockImplementation(
        ({ queryKey }: { queryKey: string[] }) =>
          queryKey[0] === "folders" ? [[["folders", "acc-1"], [{ id: "inbox-1", account_id: "acc-1", role: "inbox" }]]] : [],
      );
      useShortcutStore.setState({ vimMode: true });
      useMailStore.setState({
        activeAccountId: "acc-1",
        activeFolderId: "inbox-1",
        selectedMessageId: "m5",
        batchMode: false,
        selectedMessageIds: new Set(),
      });
      useToastStore.setState({ toasts: [] });
    });

    it("Ctrl+d and Ctrl+u move ten messages, stopping at the ends", () => {
      renderHook(() => useKeyboard());
      press("d", { ctrlKey: true });
      expect(useMailStore.getState().selectedMessageId).toBe("m15");
      press("d", { ctrlKey: true });
      expect(useMailStore.getState().selectedMessageId).toBe("m24");
      press("u", { ctrlKey: true });
      expect(useMailStore.getState().selectedMessageId).toBe("m14");
      press("u", { ctrlKey: true });
      press("u", { ctrlKey: true });
      expect(useMailStore.getState().selectedMessageId).toBe("m0");
    });

    it("x toggles the current message in a bulk selection", () => {
      renderHook(() => useKeyboard());
      press("x");
      expect(useMailStore.getState().batchMode).toBe(true);
      expect([...useMailStore.getState().selectedMessageIds]).toEqual(["m5"]);
      press("j");
      press("x");
      expect([...useMailStore.getState().selectedMessageIds].sort()).toEqual(["m5", "m6"]);
      press("x");
      expect([...useMailStore.getState().selectedMessageIds]).toEqual(["m5"]);
    });

    it("dd, Delete and e act on the bulk selection through the list", () => {
      const seen: unknown[] = [];
      const listener = (e: Event) => seen.push((e as CustomEvent).detail);
      document.addEventListener("pebble:batch-action", listener);
      try {
        renderHook(() => useKeyboard());
        press("x");
        press("d");
        press("d");
        press("Delete");
        press("e");
        expect(seen).toEqual(["delete", "delete", "archive"]);
        expect(mocks.deleteMessage).not.toHaveBeenCalled();
        expect(mocks.archiveMessage).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener("pebble:batch-action", listener);
      }
    });

    it("Escape leaves bulk selection", () => {
      renderHook(() => useKeyboard());
      press("x");
      press("Escape");
      expect(useMailStore.getState().batchMode).toBe(false);
      expect(useMailStore.getState().selectedMessageIds.size).toBe(0);
    });

    it("u undoes the last delete once", async () => {
      renderHook(() => useKeyboard());
      press("Delete");
      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.action)).toBe(true));
      press("u");
      await waitFor(() => expect(mocks.restoreMessage).toHaveBeenCalledWith("m5"));
      await waitFor(() => expect(useMailStore.getState().selectedMessageId).toBe("m5"));

      press("u");
      expect(mocks.restoreMessage).toHaveBeenCalledTimes(1);
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe("Nothing to undo");
    });

    it("u undoes an archive by archiving the message again", async () => {
      renderHook(() => useKeyboard());
      press("e");
      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.action)).toBe(true));
      press("u");
      await waitFor(() => expect(mocks.archiveMessage).toHaveBeenCalledTimes(2));
      expect(mocks.archiveMessage).toHaveBeenLastCalledWith("m5");
    });

    it("? opens the shortcuts settings", () => {
      renderHook(() => useKeyboard());
      press("?", { shiftKey: true });
      expect(useUIStore.getState().activeView).toBe("settings");
      expect(useUIStore.getState().settingsTab).toBe("shortcuts");
    });
  });
});
