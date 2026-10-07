/** The last handoff the mod ran or saved in this session. */
export type HandoffRecord = {
  /** When its turn completed (ms since epoch). */
  at: number
  /** The handoff file the mod saved, or the file or URL the answer named. */
  path: string | null
  /** False when the turn was aborted or ended in an error, or the mod could not save the handoff. */
  ok: boolean
  /** Why no handoff file came of the turn, when the mod knows. */
  problem?: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-handoff': {
      /** Start of the last main-loop request: the cache's lifetime counts from here. */
      lastRequestAt: number | null
      /** A turn the mod did not start has run since the last handoff. */
      armed: boolean
      /** Paused for this session with /auto-handoff off. */
      paused: boolean
      /** The lastRequestAt the one-minute warning was shown for. */
      warnedFor: number | null
      /** When the handoff command was queued; null once its turn started. */
      pendingSince: number | null
      /** The turn the handoff command started: permission prompts in it are declined. */
      handoffTurnId: string | null
      /** A main-loop turn is running. */
      turnRunning: boolean
      last: HandoffRecord | null
      /** The handoff command question was asked in this session. */
      asked: boolean
      /** When /auto-handoff:handoff ran (by the mod or the person); null once its turn started. */
      saveSince: number | null
      /** The turn of /auto-handoff:handoff: the mod saves its answer. */
      saveTurnId: string | null
      /** Permission requests declined in the handoff turn. */
      declined: number
      /** Subagents started in the handoff turn: their permission prompts are declined too. */
      handoffAgents: string[]
    }
  }
}
