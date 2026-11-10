import path from "node:path";
import { fileURLToPath } from "node:url";

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";

import type { Config } from "./config.ts";
import type { Db } from "./db/database.ts";
import type { MilestoneService } from "./domain/milestoneService.ts";
import type { Template } from "./domain/templates.ts";
import errorMiddleware from "./middleware/errorMiddleware.ts";
import {
  createPayPalRouter,
  type RawBodyRequest,
} from "./routes/paypalRoutes.ts";
import { createProjectRouter } from "./routes/projectRoutes.ts";

/* ######################################################################
 * Express application. Kept separate from server.ts so tests can mount
 * it with supertest and a fake payments gateway.
 * ###################################################################### */

const CLIENT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "client",
);

const PAYPAL_SOURCES = [
  "https://*.paypal.com",
  "https://*.paypalobjects.com",
  "https://*.venmo.com",
];

export type AppDependencies = {
  config: Config;
  db: Db;
  service: MilestoneService;
  templates: Map<string, Template>;
};

export function createApp({ config, db, service, templates }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);

  /* ######################################################################
   * Security headers. The PayPal JS SDK needs its own origins for
   * scripts, frames and API calls; nothing else is allowed.
   * ###################################################################### */

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...PAYPAL_SOURCES],
          frameSrc: ["'self'", ...PAYPAL_SOURCES],
          connectSrc: ["'self'", ...PAYPAL_SOURCES],
          imgSrc: ["'self'", "data:", "blob:", ...PAYPAL_SOURCES],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      // PayPal's popup checkout needs to talk back to the opener window.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );
  // Same-origin only: no CORS headers, so other sites cannot call the API.
  // The raw bytes are kept for PayPal webhook signature checks.
  app.use(
    express.json({
      limit: "64kb",
      verify: (request, _response, buffer) => {
        (request as RawBodyRequest).rawBody = buffer.toString("utf8");
      },
    }),
  );

  /* ######################################################################
   * API
   * ###################################################################### */

  app.get("/healthz", (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  });
  app.use("/paypal-api", createPayPalRouter({ config, db, service }));
  app.use("/api", createProjectRouter({ config, db, service, templates }));
  app.use(["/api", "/paypal-api"], (_request: Request, response: Response) => {
    response
      .status(404)
      .json({ error: "Not Found", errorDescription: "No such endpoint." });
  });

  /* ######################################################################
   * Browser client (static HTML, CSS and ES modules, no build step)
   * ###################################################################### */

  app.use(
    express.static(CLIENT_DIR, {
      extensions: ["html"],
      index: "index.html",
      maxAge: "1h",
    }),
  );
  app.get(
    "/p/:projectId",
    (_request: Request, response: Response, next: NextFunction) => {
      response.sendFile(
        path.join(CLIENT_DIR, "project.html"),
        (error) => error && next(error),
      );
    },
  );

  app.use(errorMiddleware);
  return app;
}
