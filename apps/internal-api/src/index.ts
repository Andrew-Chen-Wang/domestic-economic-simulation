import { Scalar } from "@scalar/hono-api-reference"
import { Hono } from "hono"
import { generateSpecs, type OpenApiSpecsOptions, openAPISpecs } from "hono-typebox-openapi"
import { ErrorObjectT, ErrorResponseT, InnerErrorT } from "./utils/errors/error.serializer"
import engine from "./engine"

const spec: OpenApiSpecsOptions = {
  documentation: {
    info: {
      title: "Economy Simulation API",
      version: "1.0.0",
      description: "Simulation engine API (in-process TypeScript engine, SQLite store)",
    },
    servers: [{ url: "http://localhost:3001", description: "Local Server" }],
    components: {
      schemas: {
        InnerErrorT,
        ErrorObjectT,
        ErrorResponseT,
      },
    },
  },
}

const app = new Hono()
if (process.env.NODE_ENV === "development") {
  app.get("/openapi", openAPISpecs(app, spec))
  app.get(
    "/docs",
    Scalar(() => {
      return {
        url: "/openapi",
        theme: "saturn",
      }
    }),
  )
}

const routes = app.route("", engine)

export default app
export type AppType = typeof routes

if (process.argv.includes("--openapi")) {
  generateSpecs(app, spec)
    .then((specs) => {
      console.log(JSON.stringify(specs, null, 2))
    })
    .catch(console.error)
}
