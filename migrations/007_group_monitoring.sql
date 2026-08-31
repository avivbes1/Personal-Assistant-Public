-- Migration 007: Group Monitoring — One source of truth (B7)
--
-- Problem: `related_to` TEXT column was overloaded — serving as both a type
-- enum (monitored/master/ignored) AND a free-text child name. No constraint
-- prevented wrong values (ISSUE-023 root cause: OpenClaw wrote a child name
-- instead of 'monitored').
--
-- Fix: Add a dedicated `monitored` INTEGER column (0/1). `related_to` is
-- repurposed for the relationship (child name / 'master' / NULL). The bot's
-- own code always wrote `related_to='monitored'` and put the child name in
-- `description`; OpenClaw intuitively wrote the child name to `related_to`.
-- Now both conventions converge: `monitored` is the flag, `related_to` is
-- the relationship context.
--
-- NOTE: This migration is applied by db.js at startup via try/catch ALTER
-- (same pattern as all other migrations in this repo). The SQL below is
-- documentation and can be run manually if needed.

-- Step 1: Add the monitored column
ALTER TABLE groups ADD COLUMN monitored INTEGER NOT NULL DEFAULT 0;

-- Step 2: Backfill from existing related_to values
UPDATE groups SET monitored = 1 WHERE related_to = 'monitored';

-- Step 3: Clean up related_to for monitored groups — move free-text to
-- description if it was in related_to, clear the enum value.
-- Groups that already had related_to='monitored' → set related_to=NULL
-- (the relationship info is in description / primary_child).
UPDATE groups SET related_to = NULL WHERE related_to = 'monitored';

-- Step 4: 'unmonitored' was an ad-hoc value used to explicitly opt out.
-- Map it to monitored=0 and clear related_to.
UPDATE groups SET monitored = 0, related_to = NULL WHERE related_to = 'unmonitored';

-- Note: related_to='master' and related_to='ignored' remain as-is — they are
-- valid relationship types. monitored stays 0 for those (correct — master and
-- ignored groups are not monitored).
