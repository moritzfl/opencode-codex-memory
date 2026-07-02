import path from "path"
import { memoryRoot } from "./paths.js"

export function safeResolveMemoryPath(rel: string): string {
  const root = memoryRoot()
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes memory root: ${rel}`)
  }
  return resolved
}