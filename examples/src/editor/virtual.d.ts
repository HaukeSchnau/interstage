declare module 'virtual:checker-files' {
  /** File contents by absolute path; see `checkerFiles` in vite.config.ts. */
  const files: Record<string, string>
  export default files
}
