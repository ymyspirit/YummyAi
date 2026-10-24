# Native method publication and execution authority

2026-10-16 · PRD 1.1 · B14/B28. Implementation is incremental; this decision
does not mark the method workbench or full platform accepted.

The current POD output contract is a stable original-file completion, independent
of task-view DTOs. Freeze original code-v1 definitions and schema hashes for
explicit compatibility; retain their exact publication until an operator reviews
and publishes code-v2. The owner records the actual technical handoff atomically
with its files and pending-review version. This adds no production approval or
rewritten historical evidence. See [POD completion](../integration/pod-completion.md).

Reuse the existing code-owned HarnessRegistry and knowledge owner. The open
[Agent Skills specification](https://agentskills.io/specification) and its
[reference project](https://github.com/agentskills/agentskills) separate metadata,
instructions and supporting resources. Use that distinction for review, without
adding a dynamic script loader or another agent framework. Skill-file metadata
does not authorize ERP tools. Business actions remain in their existing owners.

The method owner records tenant-specific adoption of supported code methods,
immutable versions and create/revise/submit/publish/reject/disable events. A
version pins the exact registered instructions, ordered steps, tool contract,
reviewed notes and knowledge-version provenance. Clients select a registered key;
the server resolves executable content. Notes remain source data, not system
instructions, tool definitions, numerical production parameters or approval.

An unpublished draft leaves the existing built-in method available and is visibly
unadopted. Publishing is an explicit workflow:approve action after submission and
review of the exact checksum; it applies to new inputs. New drafts and publishing
v2 do not rewrite v1 inputs. Disable increments a withdrawal generation and stops
old selections even after a later explicit re-enable. No implicit fallback after
a tenant adopted and disabled a method. Legacy inputs without a publication
snapshot are identified; they cannot bypass a tenant's adopted governance.

Registered targets include the nine assistant kinds, separate artwork audit,
the existing workflow/POD methods and the two
[order-design owners](../integration/order-design-completion.md). They share the
publication owner while retaining their business execution and original recovery
records. Method-wide
knowledge provenance initially accepts published, general platform/market/product
guidance only. Product/store-specific facts continue through the existing scoped
assistant knowledge and business inputs, never through global method notes.

Before creating, submitting and adopting a model response, recheck current
method availability, immutable version/checksum, withdrawal generation, registered
contract and knowledge provenance. A late revocation preserves the original paid
response and fee while rejecting adoption. The final writable completion
transaction holds a shared method-row lock so disable cannot commit between its
method check and the result commit. Method publication grants no execution role.

The first implementation slice delivers contracts, RLS persistence, owner APIs
and real assistant enforcement. The subsequent native workbench adds exact-version
review, source selection/current availability and immutable history, with local
browser evidence for publication, conflicts and current-access withdrawal. Other
governed business-object/provider trials and full business acceptance remain
separate. Normal business databases and real user documents are not changed by
disposable tests. See [the workbench delivery](../project-control/METHOD_WORKBENCH_DELIVERY_20261016.md).

The subsequent [business-method slice](../project-control/BUSINESS_METHODS_DELIVERY_20261016.md)
exercises order review and SKU packaging through their actual owners with isolated
synthetic business inputs. Previews disclose the planned method; results disclose
the pinned method and open that exact historical version. New publication rejects
an outdated inspected basis before another intent is created. Completed records
recheck current read access, and late successful reads cannot restore cleared
private content. Together with knowledge dialogue this covers three assistant
kinds; six others, artwork audit, workflows/POD and real-provider acceptance remain
independent requirements.

The [additional owner-path verification](../project-control/REMAINING_METHODS_DELIVERY_20261017.md)
extends published-method execution evidence to creative, normal artwork preflight,
template configuration, finance, procurement and after-sales, plus the distinct
automatic artwork-audit method. Actual owners and the processor retain v1 after
v2 publication; fresh inputs adopt v2. Reviewed notes stay out of system messages
and tool definitions, and current knowledge read permission applies even without
bibliographic search hits. Synthetic model/storage/parser fixture boundaries are
explicit. This adds verification to the existing production implementation; it
does not establish real-provider quality, workflow/POD adoption or business release.

## Workflow and POD extension (2026-10-18)

Workflow and POD now reuse this same owner for separate publications. Workflow
activation fixes the parent selection and, for delegation, the child's selection.
Migration 0121 stores an immutable POD method snapshot inside the original
execution/fingerprint; historical NULL remains missing. Admission/adoption checks
current publication generations, knowledge provenance and actor grants. Shared
knowledge-entry locks serialize source withdrawal with the owning write.

Method notes remain manual guidance, never processor parameters, graph changes
or manufacturing approval. The UI reuses exact-version evidence links. The
ordinary database and user PDF are not adopted or migrated by isolated checks.
See [execution methods](../integration/execution-methods.md) for deployment,
legacy/paid-response boundaries and verification scope. Other executors, real
provider quality, business trials and release remain separate.

## Order design extension (2026-10-18)

The two order-design methods bind the original private work revision, code-owned
plan and publication in the existing registration transaction. Current member,
publication generation and knowledge checks guard execution and adoption;
received original responses and reported fees survive in-flight authority loss
under the original token and retention guards. Technical completion atomically
references actual unreviewed editor versions and private proof bytes. Original
input, completed output and handed-off proof metadata are immutable; genuine
legacy omissions remain explicit. See
[order design completion](../integration/order-design-completion.md). No model,
factory, privacy-expired fee recovery or production approval is inferred.
