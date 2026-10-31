# Penalty-delivery authority migration

Backfill fences pilots with existing seizure, mining-violation, lockout, or citation state at
`authorityRevision = 1`; it copies that revision to existing nonce rows so a delayed server delivery
is a duplicate.

Rollback is operational: first stop the internal consumer. Retain the migration's tables and authority columns
until all deployed RTSE pods no longer require strict revision admission; then a separately reviewed
rollback migration may drop the foreign key, indexes, table, source-row revision columns, and
player authority columns in that order. Never roll back while a spool can redeliver a penalty.
