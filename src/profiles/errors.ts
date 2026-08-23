import type { ModelSelectionFailure } from "../routing/model-selection/errors.js";
import type { ModelIntentFailure } from "../routing/model-intent/errors.js";
import type { TierResolutionFailure } from "../routing/model-tiers/errors.js";

export class ProfileActivationError extends Error {
  override name = "ProfileActivationError";
  public constructor(
    readonly code: "profile-not-found" | "profile-not-claude" | "profile-has-no-pool" | "role-unmapped" | "capability-rejected" | "invalid-launch-policy" | "tier-unavailable" | "model-unavailable" | "context_window_exceeded",
    message = "Profile cannot be activated",
    /**
     * Typed model-selection failure reason (#68) when the activation failed at
     * the model-selection stage. The HTTP contract keeps the stable
     * `capability-rejected` code; this carries the actionable taxonomy.
     */
    readonly modelFailure?: ModelSelectionFailure,
    /**
     * Typed tier-resolution failure reason (#69) when the activation failed
     * resolving a logical tier (`haiku`/`sonnet`/`opus`/`fable`). The HTTP
     * contract keeps the stable `tier-unavailable` code; this carries the
     * actionable reason (`family-unknown`, `override-rejected`,
     * `mapping-invalid`, or the underlying `tier-unavailable` cause).
     */
    readonly tierFailure?: TierResolutionFailure,
    /**
     * Underlying #68 model-selection failure code when the tier stage failed
     * validating a mapped/derived target for THIS request (e.g.
     * `reasoning-unsupported` for a tools+effort subagent). Surfaces on the
     * HTTP contract as an additive `cause` for actionability.
     */
    readonly tierCause?: string,
    /**
     * Typed model-intent classification failure (#125) when the selector could
     * not be classified into a known namespace/kind (e.g. `unknown-namespace`
     * for an invalid `rly-tier:*` value). Carried so the HTTP contract can
     * surface the actionable selector-namespace reason without leaking content.
     */
    readonly intentFailure?: ModelIntentFailure,
  ) {
    super(message);
  }
}
