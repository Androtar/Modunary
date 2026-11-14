/// <reference types="vite/client" />

import type { BannerlordApi } from '../electron/preload'

declare global {
  interface Window {
    bannerlord: BannerlordApi
  }
}

export {}
