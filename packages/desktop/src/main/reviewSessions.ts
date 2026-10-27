import type { ReviewSession } from '@shared/types/review'
import { createHash } from 'node:crypto'

export const reviewSessions = new Map<string, { pathname: string; session: ReviewSession; savedHash?: string }>()

export const isReviewFile = (pathname: string): boolean =>
  [...reviewSessions.values()].some(({ session }) => session.file === pathname)

export const recordReviewWrite = (pathname: string, bytes: Uint8Array): void => {
  for (const entry of reviewSessions.values()) {
    if (entry.session.file === pathname) entry.savedHash = createHash('sha256').update(bytes).digest('hex')
  }
}

export const isOwnReviewWrite = (pathname: string, bytes: Uint8Array): boolean => {
  const entry = [...reviewSessions.values()].find(({ session }) => session.file === pathname)
  return !!entry?.savedHash && entry.savedHash === createHash('sha256').update(bytes).digest('hex')
}
