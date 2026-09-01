import { defineConfig } from 'vite'

/**
 * The UI is served by the daemon from `dist/`, never by a dev server in
 * production, so the build has to produce something that works from a plain
 * static directory.
 *
 * `base: '/ui/'` is what makes that true. Relative asset paths would resolve
 * against `/ui` without its trailing slash and land on `/assets/...`, so the
 * base is absolute and matches where the daemon mounts the bundle.
 */
export default defineConfig({
  base: '/ui/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One page, one bundle. Chunk splitting buys nothing over loopback and
    // costs an extra request on a cold open.
    chunkSizeWarningLimit: 2048,
  },
})
