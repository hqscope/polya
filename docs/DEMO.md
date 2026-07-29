# Polya — demo walkthrough

The scripted flow for the demo video / investor walkthrough. Every beat below is
built and verified against the shared backend.

## Setup (once)

1. Sign in at `/login` with Google.
2. `/app/connect` → paste your school's Canvas URL + a personal access token
   (Canvas → Account → Settings → **+ New Access Token**).
3. Pick a course → watch the import progress fill in (readings, pages, syllabus).

## The five beats

1. **It knows the course.** Open the course. Ask a factual question
   ("Why does the electron transport chain need oxygen?"). Polya answers in
   prose with a `[1]` citation.

2. **Answers with receipts.** Click the `[1]` pill → the source panel opens the
   exact PDF page (or the transcript at the moment it was said). The claim is
   traceable, not hallucinated.

3. **Help that teaches, not finishes.** In the default **Guided** mode, ask
   "Solve this for me: which statistical test should I use for three groups?"
   Polya does **not** dump the answer — it asks what you've tried and gives the
   next step. Click **"I'm stuck"** to climb the ladder one rung.

4. **The professor's method.** Ask "Walk me through choosing a statistical
   test." Polya retrieves the numbered method from the slides and steps through
   it — the professor's own procedure, not a generic internet answer.

5. **The instructor's guardrails.** Open **Course materials → Assistance
   policy.** Flip **Guided → Open → Practice** and re-ask the same question:
   - *Open* gives the full walkthrough.
   - *Practice* refuses to reveal and makes the student commit an answer first.
   This is the university sale: a sanctioned AI whose pedagogy faculty control.

## Reproducible verification (no Canvas needed)

The committed synthetic course drives deterministic checks:

```sh
# Seed the fixture course into a backend and run the ingest pump:
POLYA_SUPABASE_URL=... POLYA_ANON_KEY=... POLYA_TEST_EMAIL=... POLYA_TEST_PASSWORD=... \
  node scripts/seed-fixture.ts

# Retrieval recall against the golden set (gate: recall@5 >= 0.8):
POLYA_SUPABASE_URL=... POLYA_ANON_KEY=... POLYA_COURSE_ID=<from seed> \
POLYA_TEST_EMAIL=... POLYA_TEST_PASSWORD=... \
  node scripts/eval/run-eval.ts
```

Last run against the shared backend with real Gemini embeddings:
**recall@5 = 1.00, MRR = 1.000** across the four golden questions (factual,
procedural, navigational, transcript).
