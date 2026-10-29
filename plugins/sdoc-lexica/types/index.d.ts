// The sdoc-lexica plugin's contract: the values it keeps in $.state.

// What the conversation has been shown (savedState in hooks/handlers.mjs),
// the subagents briefed and the paths allowed for the session (register.mjs).
export type SdocLexicaConversation = {
  indexSent: boolean;
  readSeen: string[];
  nudged: string[];
  editAcked: string[];
  opening: string | null;
  usage: { startedAt?: number; tokens?: number } | null;
  briefed: string[];
  allowed: string[];
};

declare module 'claude-code' {
  interface PluginState {
    'sdoc-lexica': { conversation: SdocLexicaConversation };
  }
}
