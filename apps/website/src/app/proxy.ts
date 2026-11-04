import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

/** CSRF protection: state-changing requests must come from our own origin. */
export function proxy(request: NextRequest) {
  if (request.method === "GET" || request.method === "HEAD") return NextResponse.next()
  const originHeader = request.headers.get("Origin")
  const hostHeader = request.headers.get("X-Forwarded-Host") ?? request.headers.get("Host")
  if (originHeader === null || hostHeader === null) return new NextResponse(null, { status: 403 })
  try {
    if (new URL(originHeader).host !== hostHeader) return new NextResponse(null, { status: 403 })
  } catch {
    return new NextResponse(null, { status: 403 })
  }
  return NextResponse.next()
}
