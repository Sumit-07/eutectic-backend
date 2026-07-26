-- 0003_forums_tags_posts  (ticket M0-BE-04)
--
-- Forums, tags, posts and the post↔tag link table (system-design §5 "Forums,
-- tags, posts"), plus the §8 search substrate: a GENERATED tsvector column on
-- `posts` with a GIN index, queried with `websearch_to_tsquery`. Additive only:
-- CREATE TABLE / CREATE INDEX, nothing else.
--
-- Conventions (SD §5 preamble, as applied in 0001): every table gets
-- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` and
-- `created_at timestamptz NOT NULL DEFAULT now()`; `updated_at` is added where
-- rows mutate in place. The one exception is `post_tags`, for which SD §5 gives
-- an explicit composite PRIMARY KEY — that PK stands, there is no `id`, and
-- there is no `updated_at` because a link row is immutable (it is inserted or
-- deleted, never edited).
--
-- Numbering: this is 0003 per the D-011 protocol; 0002 (M0-BE-03, agents) is in
-- flight on a sibling branch. Sequence numbers are assigned by the ticket, not
-- by arrival order.

-- Forums carry the tone policy that shapes every agent response inside them
-- (capabilities: a roast forum and a care forum are different products). Both
-- the policy and the class allow-list are admin-editable, hence `updated_at`.
-- No CHECK on `tone_policy` or on the class array: adding a tone or an agent
-- class must not require a migration (same reasoning as D-011's ink ruling —
-- validity is enforced in the service layer).
CREATE TABLE forums (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  slug                    text UNIQUE NOT NULL,
  name                    text NOT NULL,
  tone_policy             text NOT NULL,                              -- 'roast' | 'plain' | 'care'
  allowed_agent_classes   text[] NOT NULL DEFAULT '{staff,registry}'
);

-- `canonical_tag_id` is the alias seam, present day 1 (SD §5): an alias tag
-- points at the canonical tag it collapses into, and aliases are resolved on
-- write (SD §8), never at query time. Nullable — a canonical tag points at
-- nothing. `post_count` is a maintained counter, so `updated_at` applies.
CREATE TABLE tags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  slug              text UNIQUE NOT NULL,
  canonical_tag_id  uuid REFERENCES tags,   -- alias support, day 1
  post_count        int NOT NULL DEFAULT 0
);

-- A post is structured, not a text box: `body_idea` plus the two answered
-- fields are separate columns because the composer asks separate questions and
-- the agents read them separately. `search_vector` is GENERATED ALWAYS —
-- Postgres maintains it, no trigger, no application write path can forget it.
-- The expression is SD §5's verbatim; changing it means a new migration that
-- rewrites the column, so it is not a thing to tweak casually.
CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  author_user_id  uuid NOT NULL REFERENCES users,
  surface         text NOT NULL,        -- 'validate' (others later)
  forum_id        uuid NOT NULL REFERENCES forums,
  body_idea       text NOT NULL,        -- 50-70 words, enforced in the service layer
  field_who       text NOT NULL,
  field_today     text NOT NULL,
  visibility      text NOT NULL DEFAULT 'public',   -- 'public'|'unlisted'
  status          text NOT NULL DEFAULT 'live',     -- 'live'|'removed'
  search_vector   tsvector GENERATED ALWAYS AS (
                    to_tsvector('english',
                      body_idea || ' ' || field_who || ' ' || field_today)
                  ) STORED
);

CREATE INDEX posts_search_idx ON posts USING GIN (search_vector);

-- Max 2 tags per post is enforced in the service layer, not here (SD §5 notes a
-- deferred CHECK via trigger as the eventual belt-and-braces; it is not part of
-- this migration). ON DELETE CASCADE on `post_id` only: deleting a post drops
-- its links, deleting a tag must not silently unlink posts.
CREATE TABLE post_tags (
  post_id     uuid NOT NULL REFERENCES posts ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, tag_id)
);

-- The tag feed reads (tag_id, post_id); the PK already covers (post_id, tag_id).
CREATE INDEX post_tags_tag_id_post_id_idx ON post_tags (tag_id, post_id);
