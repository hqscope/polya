# Polya

Course-aware AI tutoring that helps students **learn** — hints, guided steps, and worked
explanations grounded in their actual course materials, with every claim cited back to the exact
page, slide, or lecture moment it came from. Students choose the assistance level per course
(Open / Guided / Practice / Review) and Polya's behavior follows.

Named for George Pólya, whose *How to Solve It* taught teaching-by-questions.

Polya is the AI layer of **Scope**, the course workspace — the sanctioned tutor whose pedagogy a
faculty can govern. Company direction: `../scope-docs/ROADMAP.md`. Free for students; revenue is
institutional.

## Develop

```sh
npm install
cp .env.template .env.local   # defaults already point at the shared project
npm run dev                   # http://localhost:3000
```

Local database work: `supabase start` / `supabase db reset` (Polya-only stack).
Checks: `npm run lint` · `npm run typecheck` · `npm test` · `npm run eval`.

## Read first

- `CLAUDE.md` — repo conventions and the **hard rules** for the shared Supabase project.
- `docs/ARCHITECTURE.md` — system design (ingestion, retrieval, tutoring, schema).
- `docs/POSITIONING.md` — product narrative and pitch language.
