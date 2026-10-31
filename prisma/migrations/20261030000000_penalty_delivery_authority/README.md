# Penalty-delivery authority migration

Backfill fences pilots with existing seizure, mining-violation, lockout, or citation state at
`authorityRevision = 1`; it copies that revision to existing nonce rows so a delayed server delivery
is a duplicate. It deliberately does not synthesize historical outbox events.

Rollback is operational: first stop the internal consumer and wait for every unpublished
`AuthorityUpdateOutbox` row to be reconciled. Retain the migration's tables and authority columns
until all deployed RTSE pods no longer require strict revision admission; then a separately reviewed
rollback migration may drop the two foreign keys, indexes, tables, source-row revision columns, and
player authority columns in that order. Never roll back while a spool can redeliver a penalty.
