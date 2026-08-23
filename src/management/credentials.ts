import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isControlPlaneError } from "../control-plane/errors.js";
import { toPublicError } from "../credentials/service.js";
import type { CredentialService } from "../credentials/service.js";
import type { ManagementActor } from "../control-plane/types.js";
import { reject, type ManagementAuthorizer } from "./auth.js";
import { toAccountDto } from "./dtos.js";

const idSchema = z.uuid();
const versionSchema = z.number().int().positive();

export function registerCredentialRoutes(
  app: FastifyInstance,
  authorize: ManagementAuthorizer,
  credentials: CredentialService,
): void {
  app.post("/v1/credentials/import/preview", async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    const parsed = z.object({ sourcePath: z.string().min(1), providerId: z.uuid() }).parse(request.body);
    return wrap(credentials.previewImport(parsed.sourcePath, parsed.providerId));
  });
  app.post("/v1/credentials/import", async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    const parsed = z.object({
      sourcePath: z.string().min(1),
      providerId: z.uuid(),
      pseudonym: z.string().min(1),
      sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }).parse(request.body);
    return reply.code(201).send(toAccountDto(await credentials.importCodex(parsed, principal.actor), "ready"));
  });
  app.post("/v1/credentials/login", async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    const parsed = z.object({ providerId: z.uuid(), pseudonym: z.string().min(1) }).parse(request.body);
    return credentials.startLogin(parsed, principal.actor);
  });
  app.post("/v1/credentials/login/complete", async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    return toAccountDto(await credentials.finishLogin(principal.actor), "ready");
  });
  app.post("/v1/credentials/login/cancel", async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    const parsed = z.object({ state: z.string().min(1) }).parse(request.body);
    await credentials.cancelLogin(parsed.state);
    return { cancelled: true };
  });
  app.post("/v1/accounts/:id/refresh", async (request, reply) => {
    const actor = mutation(authorize, request, reply);
    if (!actor) return;
    const parsed = z.object({ version: versionSchema }).parse(request.body);
    const id = parseId(request.params, reply);
    if (!id) return;
    return toAccountDto(await credentials.refresh(id, parsed.version, actor));
  });
  app.post("/v1/accounts/:id/revoke", async (request, reply) => {
    const actor = mutation(authorize, request, reply);
    if (!actor) return;
    const parsed = z.object({ version: versionSchema }).parse(request.body);
    const id = parseId(request.params, reply);
    if (!id) return;
    return toAccountDto(await credentials.revoke(id, parsed.version, actor), "revoked");
  });
  app.post("/v1/accounts/:id/select", async (request, reply) => {
    const actor = mutation(authorize, request, reply);
    if (!actor) return;
    const parsed = z.object({ version: versionSchema }).parse(request.body);
    const id = parseId(request.params, reply);
    if (!id) return;
    const account = await credentials.select(id, parsed.version, actor);
    return toAccountDto(account, await credentials.readiness(account));
  });
}

function mutation(
  authorize: ManagementAuthorizer,
  request: Parameters<ManagementAuthorizer>[0],
  reply: Parameters<ManagementAuthorizer>[1],
): ManagementActor | undefined {
  return authorize(request, reply, true)?.actor;
}

function parseId(params: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): string | undefined {
  const parsed = z.object({ id: idSchema }).safeParse(params);
  if (!parsed.success) {
    void reject(reply as never, 400, "invalid");
    return undefined;
  }
  return parsed.data.id;
}

async function wrap<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const mapped = toPublicError(error);
    if (mapped) throw mapped;
    if (isControlPlaneError(error)) throw error;
    throw error;
  }
}
