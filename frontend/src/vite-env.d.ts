/// <reference types="vite/client" />

declare module 'virtual:wmind-public-assets' {
  /** Returns a content-versioned URL in production and the source URL in dev. */
  export function publicAssetUrl(path: string): string;
}
