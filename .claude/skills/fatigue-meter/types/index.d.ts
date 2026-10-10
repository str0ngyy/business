export type Reading = {
  /** Input tokens of the last response; absent until the first response. */
  tokens?: number
  /** The model's context window, in tokens. */
  window: number
}

declare module 'claude-code' {
  interface PluginState {
    'fatigue-meter': {
      reading: Reading | null
      compactions: number
      /** Index of the zone last announced, so a toast fires once per step up. */
      announced: number
    }
  }
}
