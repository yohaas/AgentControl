import { useMemo } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import type { SavedChat } from "@agent-hero/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { sendCommand } from "../lib/ws-client";

interface ChatHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chats: SavedChat[];
  retentionDays: number;
  onOpenChat: (chat: SavedChat) => void;
}

function formatDate(value: string): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleString();
}

export function ChatHistoryDialog({ open, onOpenChange, chats, retentionDays, onOpenChat }: ChatHistoryDialogProps) {
  const description = useMemo(() => {
    if (retentionDays <= 0) return "Closed chats are kept here indefinitely. Save a chat to move it to Saved Chats.";
    return `Closed chats are kept here for ${retentionDays} day${retentionDays === 1 ? "" : "s"} after their last activity. Save a chat to move it to Saved Chats and keep it permanently.`;
  }, [retentionDays]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,640px)]">
        <DialogHeader>
          <DialogTitle>Chat history</DialogTitle>
          <p className="text-xs text-muted-foreground">{description}</p>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-2 overflow-y-auto pr-1">
          {chats.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              No chat history yet.
            </p>
          ) : (
            chats.map((chat) => {
              const prompt = chat.initialPrompt?.trim() || "(no prompt)";
              return (
                <div
                  key={chat.id}
                  className="flex flex-col gap-2 rounded-md border border-border bg-background/50 p-3 transition-colors hover:bg-accent/40 sm:flex-row sm:items-start sm:justify-between"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    title="Open chat"
                    onClick={() => onOpenChat(chat)}
                  >
                    <p className="line-clamp-2 break-words text-sm font-medium" title={prompt}>
                      {prompt}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={chat.agent.displayName}>
                      {chat.agent.displayName}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Created {formatDate(chat.savedAt)} · Last activity {formatDate(chat.updatedAt)}
                    </p>
                  </button>
                  <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      title="Save chat (move to Saved Chats)"
                      onClick={() => sendCommand({ type: "promoteSavedChat", savedChatId: chat.id })}
                    >
                      <Bookmark className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      title="Delete chat"
                      onClick={() => {
                        if (window.confirm("Delete this chat from history? This cannot be undone.")) {
                          sendCommand({ type: "deleteSavedChat", savedChatId: chat.id });
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
