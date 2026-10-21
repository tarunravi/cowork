/**
 * The one pane beside a conversation. Each state is a URL flag, so opening one is a real navigation:
 * it survives a reload and Back closes it. Only one can be on at a time, which the patch enforces by
 * setting all three flags together rather than leaving each caller to clear the others.
 */
export type ConversationPanel = "settings" | "watch" | "work";

export function conversationPanelSearch(panel: ConversationPanel | null) {
  return {
    settings: panel === "settings" ? true : undefined,
    watch: panel === "watch" ? true : undefined,
    work: panel === "work" ? true : undefined,
  };
}
