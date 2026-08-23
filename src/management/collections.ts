import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { ManagementActor } from "../control-plane/types.js";
import { ValidationError } from "../control-plane/errors.js";
import type { CredentialService } from "../credentials/service.js";
import { reject, type ManagementAuthorizer } from "./auth.js";
import { applyCatalogDefaults } from "../providers/catalog.js";
import { providerCapabilityEvidenceSchema } from "../registry/model-registry.js";
import {
  toAccountDto,
  toPoolDto,
  toProfileDto,
  toProviderDto,
} from "./dtos.js";

const idSchema = z.uuid();
const versionSchema = z.number().int().positive();
const providerBody = z.object({
  name: z.string().min(1),
  integrationMode: z.enum(["direct", "oauth", "bridge"]),
  endpointPolicy: z.string().min(1).optional(),
  capabilityEvidence: providerCapabilityEvidenceSchema.optional(),
  requiredTermsRevision: z.string().min(1).optional(),
  provenanceRef: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  version: versionSchema.optional(),
});
const accountBody = z.object({
  pseudonym: z.string().min(1).optional(),
  providerId: z.uuid().optional(),
  credentialHandle: z.string().min(1).optional(),
  credentialRef: z.string().min(1).optional(),
  state: z.enum(["ready", "paused", "unready", "revoked"]).optional(),
  pauseReason: z.string().min(1).optional(),
  quotaClass: z.string().min(1).optional(),
  termsRevision: z.string().min(1).optional(),
  version: versionSchema.optional(),
});
const poolBody = z.object({
  name: z.string().min(1).optional(),
  providerId: z.uuid().optional(),
  strategy: z.enum(["manual", "round-robin", "fill-first", "adaptive"]).optional(),
  affinity: z.unknown().optional(),
  retryBudget: z.number().int().nonnegative().optional(),
  accountIds: z.array(z.uuid()).optional(),
  version: versionSchema.optional(),
});
const profileBody = z.object({
  name: z.string().min(1).optional(),
  harness: z.enum(["claude", "codex"]).optional(),
  providerId: z.uuid().optional(),
  poolId: z.uuid().optional(),
  modelRoles: z.record(z.string(), z.string().min(1)).optional(),
  capabilityPolicy: z.unknown().optional(),
  launchPolicy: z.unknown().optional(),
  version: versionSchema.optional(),
});

export function registerManagementCollections(
  app: FastifyInstance,
  authorize: ManagementAuthorizer,
  store: ControlPlaneStore,
  credentials?: CredentialService,
): void {
  registerCollection(app, authorize, "providers", {
    list: () => store.listProviders().map(toProviderDto),
    create: (body, actor) => {
      const parsed = providerBody.parse(body);
      const catalog = applyCatalogDefaults(parsed);
      return toProviderDto(store.createProvider({
        name: parsed.name,
        integrationMode: parsed.integrationMode,
        endpointPolicy: catalog.endpointPolicy,
        capabilityEvidence: parsed.capabilityEvidence,
        requiredTermsRevision: catalog.requiredTermsRevision,
        provenanceRef: parsed.provenanceRef,
      }, actor));
    },
    update: (id, body, actor) => {
      const parsed = providerBody.partial().extend({ version: versionSchema }).parse(body);
      return toProviderDto(store.updateProvider(id, parsed.version, parsed, actor));
    },
    delete: (id, version, actor) => store.deleteProvider(id, version, actor),
  });
  registerCollection(app, authorize, "accounts", {
    list: async () => {
      const accounts = store.listAccounts();
      if (!credentials) return accounts.map((record) => toAccountDto(record));
      return Promise.all(accounts.map(async (record) => toAccountDto(record, await credentials.readiness(record))));
    },
    create: async (body, actor) => {
      const envRef = envCredentialRefFrom(body);
      if (envRef !== undefined) {
        if (!credentials) throw new ValidationError("credential service is unavailable");
        const parsed = accountBody.extend({
          pseudonym: z.string().min(1),
          providerId: z.uuid(),
        }).parse(body);
        const record = credentials.createDirectEnvironmentAccount({
          providerId: parsed.providerId,
          pseudonym: parsed.pseudonym,
          credentialRef: envRef,
        }, actor);
        return toAccountDto(record, await credentials.readiness(record));
      }
      const parsed = accountBody.extend({
        pseudonym: z.string().min(1),
        providerId: z.uuid(),
        credentialHandle: z.string().min(1),
      }).parse(body);
      return toAccountDto(store.createAccount(parsed, actor));
    },
    update: (id, body, actor) => {
      const parsed = accountBody.extend({ version: versionSchema }).parse(body);
      if (parsed.termsRevision !== undefined) {
        return toAccountDto(store.acknowledgeTerms(id, parsed.version, parsed.termsRevision, actor));
      }
      return toAccountDto(store.updateAccount(id, parsed.version, parsed, actor));
    },
    delete: (id, version, actor) => store.deleteAccount(id, version, actor),
  });
  registerCollection(app, authorize, "pools", {
    list: () => store.listPools().map(toPoolDto),
    create: (body, actor) => {
      const parsed = poolBody.extend({
        name: z.string().min(1),
        providerId: z.uuid(),
        strategy: z.enum(["manual", "round-robin", "fill-first", "adaptive"]),
      }).parse(body);
      return toPoolDto(store.createPool(parsed, actor));
    },
    update: (id, body, actor) => {
      const parsed = poolBody.extend({ version: versionSchema }).parse(body);
      return toPoolDto(store.updatePool(id, parsed.version, parsed, actor));
    },
    delete: (id, version, actor) => store.deletePool(id, version, actor),
  });
  registerCollection(app, authorize, "profiles", {
    list: () => store.listProfiles().map(toProfileDto),
    create: (body, actor) => {
      const parsed = profileBody.extend({
        name: z.string().min(1),
        harness: z.enum(["claude", "codex"]),
        modelRoles: z.record(z.string(), z.string().min(1)),
      }).parse(body);
      return toProfileDto(store.createProfile(parsed, actor));
    },
    update: (id, body, actor) => {
      const parsed = profileBody.extend({ version: versionSchema }).parse(body);
      return toProfileDto(store.updateProfile(id, parsed.version, parsed, actor));
    },
  });
}

function envCredentialRefFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record["credentialRef"] === "string" && record["credentialRef"].startsWith("env:")) {
    return record["credentialRef"];
  }
  return undefined;
}

const deleteVersionSchema = z.object({ version: z.coerce.number().int().positive() });

function registerCollection(
  app: FastifyInstance,
  authorize: ManagementAuthorizer,
  name: string,
  handlers: Readonly<{
    list: () => unknown;
    create: (body: unknown, actor: ManagementActor) => unknown;
    update: (id: string, body: unknown, actor: ManagementActor) => unknown;
    delete?: (id: string, version: number, actor: ManagementActor) => unknown;
  }>,
): void {
  app.get(`/v1/${name}`, async (request, reply) => {
    const principal = authorize(request, reply, false);
    if (!principal) return;
    return { items: await handlers.list() };
  });
  app.post(`/v1/${name}`, async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    return reply.code(201).send(await handlers.create(request.body, principal.actor));
  });
  app.patch(`/v1/${name}/:id`, async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    const parsed = z.object({ id: idSchema }).safeParse(request.params);
    if (!parsed.success) return reject(reply, 400, "invalid");
    return handlers.update(parsed.data.id, request.body, principal.actor);
  });
  if (handlers.delete === undefined) return;
  const remove = handlers.delete;
  app.delete(`/v1/${name}/:id`, async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    const parsed = z.object({ id: idSchema }).safeParse(request.params);
    if (!parsed.success) return reject(reply, 400, "invalid");
    const fromQuery = deleteVersionSchema.safeParse(request.query);
    const version = fromQuery.success ? fromQuery : deleteVersionSchema.safeParse(request.body);
    if (!version.success) return reject(reply, 400, "invalid");
    return reply.code(200).send(await remove(parsed.data.id, version.data.version, principal.actor));
  });
}
