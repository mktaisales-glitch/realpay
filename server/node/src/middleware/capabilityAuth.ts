import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import type { Db } from "../db/database.ts";
import { getProject, type Project } from "../db/repository.ts";
import { DomainError } from "../domain/domainError.ts";
import { hashToken } from "../domain/milestoneService.ts";
import type { Role } from "../domain/projectView.ts";

/* ######################################################################
 * Capability links: each project has one secret link for the owner and
 * one for the contractor. Only the SHA-256 of each token is stored.
 * The browser sends the token as "Authorization: Bearer <token>".
 * ###################################################################### */

declare module "express-serve-static-core" {
  interface Request {
    realpay?: { project: Project; role: Role };
  }
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function resolveRole(project: Project, token: string): Role | undefined {
  const hash = hashToken(token);
  if (sameHash(hash, project.ownerTokenHash)) return "owner";
  if (sameHash(hash, project.contractorTokenHash)) return "contractor";
  return undefined;
}

export function requireRole(db: Db, ...allowed: Role[]) {
  return function capabilityAuth(
    request: Request,
    _response: Response,
    next: NextFunction,
  ) {
    const header = request.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const projectId = String(
      request.params.projectId ?? request.body?.projectId ?? "",
    );
    const project = projectId ? getProject(db, projectId) : undefined;
    // Same answer for "no project" and "wrong token": ids cannot be probed.
    const role = project && token ? resolveRole(project, token) : undefined;
    if (!project || !role) {
      throw new DomainError(
        401,
        "UNAUTHORIZED",
        "This link is not valid for this project.",
      );
    }
    if (!allowed.includes(role)) {
      throw new DomainError(
        403,
        "FORBIDDEN",
        `Only the ${allowed.join(" or ")} can do this.`,
      );
    }
    request.realpay = { project, role };
    next();
  };
}
