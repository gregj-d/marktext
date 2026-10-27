import type { ReviewSession } from '@shared/types/review'

export const reviewSessions = new Map<string, { pathname: string; session: ReviewSession }>()

export const isReviewFile = (pathname: string): boolean =>
  [...reviewSessions.values()].some(({ session }) => session.file === pathname)
