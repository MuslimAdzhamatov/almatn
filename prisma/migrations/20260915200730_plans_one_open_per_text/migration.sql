-- Не больше одного открытого плана (active | learning_done) на текст (CLAUDE.md, раздел 5.7).
-- Prisma не описывает частичные индексы в схеме, поэтому индекс задан вручную.
CREATE UNIQUE INDEX "plans_one_open_per_text"
  ON "plans" ("textId")
  WHERE "status" IN ('active', 'learning_done');
