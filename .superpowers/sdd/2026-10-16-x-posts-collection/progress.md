# SDD ledger — plan: docs/superpowers/plans/2026-10-16-x-posts-collection.md

Pre-flight: no Git metadata is present in the provided project directory, so a Git worktree and commit-range workflow are unavailable. The user approved Native execution in this project workspace.

Pre-flight interface: Task 1 produces x_post_collections, x_posts, x_post_collection_results, and APIFY_API_TOKEN; Task 2 consumes these for the Apify runner. Migration must precede API module registration.
Pre-flight interface: Task 2 produces collection execution and status; Task 3 exposes those contracts over authenticated API routes.
Pre-flight interface: Task 3 exposes collection, status, posts, and export routes; Task 4 consumes them in the UI.
Pre-flight interface: Task 5 documents the final config and user workflow produced by Tasks 1–4.

Ruling: Use the existing API process for serialized collection execution and mark interrupted jobs failed at startup — the app currently has one API container, and durable recovery would require a separate worker/retry design beyond the approved scope.

Implementation progress: Added migration 022 and API-only `APIFY_API_TOKEN` configuration. Added the authenticated X collection API, sequential Apify Actor execution, normalized PostgreSQL upserts/provenance, run recovery on startup, per-topic progress, paginated reads, and XLSX export. Added the hash-routed X Posts sidebar page with date/topic/limit inputs, saved collection history, progress/results, filtering, clickable post/author URLs, and Excel download. Included X tables in Clear Database and added README setup/retention notes. No tests or build/typecheck commands were run per task instructions; changes were reviewed by source inspection only.
