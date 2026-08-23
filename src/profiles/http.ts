import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ProfileRecord } from "../control-plane/types.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import { toPlannedLaunchDto } from "../management/dtos.js";
import type { ModelUniverseSnapshot, SessionPolicySnapshot } from "../routing/model-projection/types.js";
import { ProfileActivationError } from "./errors.js";
import { inspectLaunchableProfile } from "./activate.js";
import type { LaunchSessionRegistry } from "./sessions.js";
import type { RouteTraceRing } from "./traces.js";

const issueBody = z.object({
  profileName: z.string().min(1),
  leaseId: z.uuid(),
});

export function activationStatus(error: unknown): number {
  return error instanceof ProfileActivationError && error.code === "profile-not-found" ? 404 : 400;
}

export function registerLaunchSessionRoutes(
  app: FastifyInstance,
  input: Readonly<{
    store: ControlPlaneStore;
    sessions: LaunchSessionRegistry;
    traces: RouteTraceRing;
    isInstanceToken: (token: string | undefined) => boolean;
    resolveSession: (token: string | undefined) => { profileName: string } | undefined;
    extractToken: (headers: Readonly<{ authorization?: string | undefined; "x-api-key"?: string | string[] | undefined }>) => string | undefined;
    leaseActive?: (leaseId: string) => boolean;
    /**
     * #73: returns an actionable reason string when new launch-session
     * issuance must be refused (the update drain phase has begun on this
     * runtime). Existing sessions keep running to completion.
     */
    refuseIssuance?: () => string | undefined;
    /**
     * Compiles the session-pinned snapshots (#72 + #J2 contract A) from the
     * current policy + registry at issue time: the model-universe snapshot for
     * projection/discovery stability, plus the frozen profile-route binding
     * (model roles/policy + provider→pool execution target).
     */
    compileBinding: (profile: ProfileRecord) => Readonly<{ universe: ModelUniverseSnapshot; policy: SessionPolicySnapshot }>;
  }>,
): void {
  app.post("/v1/launch-sessions", async (request, reply) => {
    if (!input.isInstanceToken(input.extractToken(request.headers))) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const refused = input.refuseIssuance?.();
    if (refused !== undefined) {
      return reply.code(409).send({ error: "update-pending", reason: refused });
    }
    const parsed = issueBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid" });
    try {
      const { profile, launchPolicy } = inspectLaunchableProfile(input.store.listProfiles(), parsed.data.profileName);
      if (input.leaseActive !== undefined && !input.leaseActive(parsed.data.leaseId)) {
        return await reply.code(400).send({ error: "lease-not-active" });
      }
      const compiled = input.compileBinding(profile);
      const token = input.sessions.issue({
        profileId: profile.id,
        profileName: profile.name,
        leaseId: parsed.data.leaseId,
        modelUniverse: compiled.universe,
        binding: compiled.policy,
      });
      return await reply.code(201).send({
        profileName: profile.name,
        profileId: profile.id,
        harness: profile.harness,
        launchPolicy,
        planned: toPlannedLaunchDto({
          provider: compiled.policy.provider,
          pool: compiled.policy.pool,
          modelRoles: compiled.policy.profile.modelRoles,
          policyRevision: compiled.universe.policyRevision,
          ...(typeof launchPolicy.model === "string" ? { launchPolicyModel: launchPolicy.model } : {}),
        }),
        token,
      });
    } catch (error) {
      if (error instanceof ProfileActivationError) {
        return await reply.code(activationStatus(error)).send({ error: error.code });
      }
      if (error instanceof Error && error.message === "lease-not-active") {
        return await reply.code(400).send({ error: "lease-not-active" });
      }
      throw error;
    }
  });

  app.get("/v1/route-traces", async (request, reply) => {
    const token = input.extractToken(request.headers);
    if (input.isInstanceToken(token)) return { traces: input.traces.list() };
    const session = input.resolveSession(token);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    return { traces: input.traces.list(session.profileName) };
  });
}
