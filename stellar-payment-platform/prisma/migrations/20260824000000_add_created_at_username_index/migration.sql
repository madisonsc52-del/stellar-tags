-- CreateIndex
-- Composite index backing keyset (cursor) pagination on username_registry:
-- ORDER BY created_at DESC, username DESC becomes a backward index scan and
-- the cursor predicate an index seek, keeping deep pages O(log n).
CREATE INDEX "username_registry_created_at_username_idx" ON "username_registry"("created_at", "username");
