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

import { useKeyboard } from "../../src/hooks/useKeyboard";

describe("useKeyboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
