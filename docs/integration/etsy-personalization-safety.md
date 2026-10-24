# Etsy personalization preservation

The current ERP editor supports one text personalization question. Etsy also
supports multiple questions, dropdowns, uploads and optional text add-on prices.
This connector deliberately does not claim that the ERP can edit all of them.

## Read behavior

Online listing reads call the dedicated
`GET /v3/application/listings/{listing_id}/personalization` endpoint. Deprecated
listing-level personalization fields are not used as a fallback. Missing or
malformed question data fails the read rather than being treated as no questions.

One understood text question is normalized to the existing ERP fields. Multiple
questions, unknown fields, upload/dropdown types and add-on pricing remain intact
in the snapshot's personalization data and produce
`ETSY_PERSONALIZATION_REQUIRES_ETSY`. They must be edited on Etsy. This snapshot is
evidence; it is not a supported ERP editing format or a replacement payload.

## Write behavior

Both draft configuration and full-content synchronization read current
personalization before changing listing content or inventory:

| Current Etsy state | ERP request | Result |
| --- | --- | --- |
| No questions | One text question | Validate and create the question |
| One fully understood text question | Changed text settings | Preserve its ID and seller-defined label, update supported fields |
| One fully understood text question | Identical settings | Skip personalization POST, preserving historical long instructions |
| Existing question | Local personalization disabled or omitted | Block; deletion must be performed on Etsy |
| Multiple questions, uploads, dropdowns, add-on pricing or unknown fields | Any full-content/configuration request | Block before any listing or inventory mutation; edit on Etsy |
| Personalization response missing or malformed | Any full-content/configuration request | Fail closed before mutation |

The connector never sends `supports_multiple_personalization_questions=true`.
Etsy's conflict response remains an additional protection if a seller adds
questions between our preflight read and the write. It is not a transactional
lock or a guarantee against every concurrent edit. A conflict after an accepted
inventory/content write requires reconciliation and is not automatically retried.

New personalization writes enforce the current text constraints: instructions
have at most 120 Unicode characters; the question label has at most 45; each
starts with a letter or number and contains at most one word beginning with three
uppercase letters. Stored drafts and historical read values are not truncated or
rewritten. Invalid new instructions fail before even creating a new Etsy draft.

Full-content updates omit `is_personalizable`; omitting personalization locally
does not disable it remotely. They also omit `production_partner_ids`, including
an empty array, so the ERP does not request removal or replacement of existing
production partners. This release does not add production-partner configuration
or prove that a newly created POD listing has the required disclosure. Operators
must configure and verify it on Etsy before activating the listing.

## Operator diagnostics

Safety blocks contain fixed Chinese instructions to edit on Etsy and read again.
The publication worker preserves these specific safe messages; arbitrary provider
errors still use the existing redacted generic messages. Full-content sync keeps
the same safety message in its failed event. No buyer data, provider response body
or credentials are added to diagnostic messages.

## Verification scope

`publication-personalization.test.ts` covers current-schema reads, lossless unknown
data, blocking before all mutations, retained IDs/labels, historical long text,
invalid write constraints, local disable protection and concurrent-conflict
reconciliation. `publication.test.ts` continues to cover ordinary draft and
publication operations. Worker tests verify that operator safety instructions
survive error handling without exposing arbitrary errors.

These are mocked protocol tests, not live Etsy certification. No real listing,
store, order or production partner was modified for this change. Real acceptance
must use an explicitly authorized store and verify the seller-facing question
set and partner disclosure before and after each supported action.

## Official references

Verified on 2026-09-17:

- [Personalization migration and replacement semantics](https://developers.etsy.com/documentation/tutorials/personalization-migration/)
- [Personalization examples and concurrent overwrite warning](https://developers.etsy.com/documentation/tutorials/personalization/examples/)
- [Optional text add-on pricing](https://developers.etsy.com/documentation/tutorials/personalization-addon-pricing/)
- [Etsy API reference, including production_partner_ids](https://developer.etsy.com/documentation/reference/)
