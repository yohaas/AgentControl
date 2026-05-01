import type { ChatTranscriptDetailMode, ExternalEditor, MenuDisplayMode, ThemeMode, TileScrollingMode } from "../../store/app-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const TILE_MAX_HEIGHT = 2000;
const CHAT_FONT_SIZE_MIN = 11;
const CHAT_FONT_SIZE_MAX = 24;
const CHAT_FONT_DEFAULT_VALUE = "__agent-hero-default-font";
const CHAT_FONT_OPTIONS = [
  { label: "App default", value: "" },
  { label: "System UI", value: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Geneva, sans-serif" },
  { label: "Trebuchet MS", value: "\"Trebuchet MS\", Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "\"Times New Roman\", Times, serif" },
  { label: "Garamond", value: "Garamond, Georgia, serif" },
  { label: "Consolas", value: "Consolas, \"Cascadia Mono\", monospace" },
  { label: "Courier New", value: "\"Courier New\", Courier, monospace" }
] as const;
const CHAT_TRANSCRIPT_DETAIL_OPTIONS = [
  { value: "responses", label: "Responses only" },
  { value: "actions", label: "Actions" },
  { value: "detailed", label: "Detailed" },
  { value: "raw", label: "Raw" }
] as const;

function normalizeChatFontFamily(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function chatFontSelectValue(value: unknown) {
  const normalized = normalizeChatFontFamily(value);
  return normalized || CHAT_FONT_DEFAULT_VALUE;
}

function chatFontValueFromSelect(value: string) {
  return value === CHAT_FONT_DEFAULT_VALUE ? "" : value;
}

interface SettingsAppearanceTabProps {
  themeMode: ThemeMode;
  setThemeMode: (value: ThemeMode) => void;
  menuDisplay: MenuDisplayMode;
  setMenuDisplay: (value: MenuDisplayMode) => void;
  tileScrolling: TileScrollingMode;
  setTileScrolling: (value: TileScrollingMode) => void;
  tileHeight: number;
  setTileHeight: (value: number) => void;
  tileColumns: number;
  setTileColumns: (value: number) => void;
  chatFontFamily: string;
  setChatFontFamily: (value: string) => void;
  chatFontSize: number;
  setChatFontSize: (value: number) => void;
  chatTranscriptDetail: ChatTranscriptDetailMode;
  setChatTranscriptDetail: (value: ChatTranscriptDetailMode) => void;
  pinLastSentMessage: boolean;
  setPinLastSentMessage: (value: boolean) => void;
  externalEditor: ExternalEditor;
  setExternalEditor: (value: ExternalEditor) => void;
  externalEditorUrlTemplate: string;
  setExternalEditorUrlTemplate: (value: string) => void;
  inputNotificationsEnabled: boolean;
  notificationPermission: string;
  onToggleInputNotifications: (enabled: boolean) => void;
  onSendTestInputNotification: () => void;
}

export function SettingsAppearanceTab({
  themeMode,
  setThemeMode,
  menuDisplay,
  setMenuDisplay,
  tileScrolling,
  setTileScrolling,
  tileHeight,
  setTileHeight,
  tileColumns,
  setTileColumns,
  chatFontFamily,
  setChatFontFamily,
  chatFontSize,
  setChatFontSize,
  chatTranscriptDetail,
  setChatTranscriptDetail,
  pinLastSentMessage,
  setPinLastSentMessage,
  externalEditor,
  setExternalEditor,
  externalEditorUrlTemplate,
  setExternalEditorUrlTemplate,
  inputNotificationsEnabled,
  notificationPermission,
  onToggleInputNotifications,
  onSendTestInputNotification
}: SettingsAppearanceTabProps) {
  const normalizedCustomFont = normalizeChatFontFamily(chatFontFamily);

  return (
    <>
      <section className="grid gap-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Theme & layout</h3>
          <p className="text-xs text-muted-foreground">Control the app theme and agent tile layout.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-5">
          <label className="grid min-w-0 gap-1.5 text-sm">
            Color mode
            <Select value={themeMode} onValueChange={(value) => setThemeMode(value as ThemeMode)}>
              <SelectTrigger className="px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            Menu display
            <Select value={menuDisplay} onValueChange={(value) => setMenuDisplay(value as MenuDisplayMode)}>
              <SelectTrigger className="px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="iconOnly">Icon Only</SelectItem>
                <SelectItem value="iconText">Icon + Text</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            Scrolling
            <Select value={tileScrolling} onValueChange={(value) => setTileScrolling(value as TileScrollingMode)}>
              <SelectTrigger className="px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vertical">Vertical</SelectItem>
                <SelectItem value="horizontal">Horizontal</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            <span>
              Tile height <span className="text-xs text-muted-foreground">(0 = full height)</span>
            </span>
            <Input
              type="number"
              min={0}
              max={TILE_MAX_HEIGHT}
              value={tileHeight}
              className="px-2"
              onChange={(event) => setTileHeight(Number(event.target.value))}
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            Columns
            <Input
              type="number"
              min={1}
              max={6}
              step={1}
              value={tileColumns}
              className="px-2"
              onChange={(event) => setTileColumns(Number(event.target.value))}
            />
          </label>
        </div>
      </section>
      <section className="grid gap-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Chat</h3>
          <p className="text-xs text-muted-foreground">Set message display preferences.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_12rem]">
          <label className="grid min-w-0 gap-1.5 text-sm">
            Chat font
            <Select value={chatFontSelectValue(chatFontFamily)} onValueChange={(value) => setChatFontFamily(chatFontValueFromSelect(value))}>
              <SelectTrigger className="px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAT_FONT_OPTIONS.map((option) => (
                  <SelectItem key={option.label} value={option.value || CHAT_FONT_DEFAULT_VALUE}>
                    {option.label}
                  </SelectItem>
                ))}
                {normalizedCustomFont && !CHAT_FONT_OPTIONS.some((option) => option.value === normalizedCustomFont) && (
                  <SelectItem value={normalizedCustomFont}>Custom: {normalizedCustomFont}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            Chat font size
            <Input
              type="number"
              min={CHAT_FONT_SIZE_MIN}
              max={CHAT_FONT_SIZE_MAX}
              step={1}
              value={chatFontSize}
              className="px-2"
              onChange={(event) => setChatFontSize(Number(event.target.value))}
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            Chat detail
            <Select value={chatTranscriptDetail} onValueChange={(value) => setChatTranscriptDetail(value as ChatTranscriptDetailMode)}>
              <SelectTrigger className="px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAT_TRANSCRIPT_DETAIL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={pinLastSentMessage}
            onChange={(event) => setPinLastSentMessage(event.target.checked)}
          />
          <span>
            <span className="block font-medium">Pin last sent message while scrolling</span>
            <span className="block text-xs text-muted-foreground">Keep your most recent message visible at the top of a scrolled chat.</span>
          </span>
        </label>
      </section>
      <section className="grid gap-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Editor & notifications</h3>
          <p className="text-xs text-muted-foreground">Configure editor links and browser notifications.</p>
        </div>
        <div className="grid gap-2 rounded-md border border-border bg-background/50 p-3">
          <div className="grid gap-2 sm:grid-cols-[220px_minmax(0,1fr)]">
            <label className="grid min-w-0 gap-1.5 text-sm">
              External editor
              <Select value={externalEditor} onValueChange={(value) => setExternalEditor(value as ExternalEditor)}>
                <SelectTrigger className="px-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="vscode">VS Code</SelectItem>
                  <SelectItem value="cursor">Cursor</SelectItem>
                  <SelectItem value="custom">Custom URL</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {externalEditor === "custom" && (
              <label className="grid min-w-0 gap-1.5 text-sm">
                URL template
                <Input
                  value={externalEditorUrlTemplate}
                  onChange={(event) => setExternalEditorUrlTemplate(event.target.value)}
                  placeholder="myeditor://open?file={encodedPath}&line={line}"
                />
              </label>
            )}
          </div>
          {externalEditor === "custom" && (
            <p className="text-xs text-muted-foreground">Custom templates support {"{path}"}, {"{encodedPath}"}, and {"{line}"}.</p>
          )}
        </div>
        <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={inputNotificationsEnabled}
            onChange={(event) => onToggleInputNotifications(event.target.checked)}
          />
          <span>
            <span className="block font-medium">Notify when agents need input</span>
            <span className="block text-xs text-muted-foreground">
              Show a browser notification for permission prompts or questions.
              {notificationPermission === "denied" && " Notifications are blocked in this browser."}
            </span>
          </span>
          <Button type="button" variant="outline" size="sm" className="ml-auto shrink-0" onClick={onSendTestInputNotification}>
            Send Test
          </Button>
        </label>
      </section>
    </>
  );
}
