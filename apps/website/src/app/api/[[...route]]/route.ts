import app from "@api/internal"
import { Hono } from "hono"

export const runtime = "nodejs"

const mounted = new Hono().route("/api", app)
const handler = (request: Request) => mounted.fetch(request)

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
