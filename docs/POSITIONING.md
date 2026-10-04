# Polya — positioning

## The one-liner

**Understand it, don't just submit it.**

## The problem

Students already use AI for school — that ship has sailed. But generic chatbots know nothing about
the student's actual course, and their default behavior is to complete the work rather than build
the understanding. Universities can't stop it, can't see it, and can't shape it; students who lean
on it hardest learn the least; access to the best tools tracks ability to pay.

## The product

Polya is a course-aware tutor. Connect a course and Polya studies what the class actually covers —
readings, slides, pages, lecture transcripts — then helps the way a great tutor does:

- **Guided first.** Asked to "solve question 4," Polya asks what you've tried, offers a hint, walks
  one step, shows a similar worked example — and gives the full solution when that's what actually
  serves learning. (The help ladder, after George Pólya's *How to Solve It*.)
- **Answers with receipts.** Every claim carries a citation that opens the source it came from —
  the exact PDF page, the course page, or the transcript passage (with timestamps when the
  transcript has them). No hallucinated course facts, and the student always sees the source.
- **The professor's method.** When slides teach a numbered method, Polya learns it as a procedure
  and walks students through *those* steps — not a generic internet solution.
- **Study modes today, instructor guardrails next.** Students choose the assistance mode per
  course — Open, Guided, Practice, or Review — and Polya's behavior visibly follows. The policy
  engine is built; instructor identity and assignment-level enforcement are the institutional
  layer we add once course-level adoption is proven. That is the campus story: a sanctioned AI
  whose pedagogy the faculty can govern.

## Where Polya sits in Scope

Scope is building **the LMS where students actually do the work** (see
`../../scope-docs/ROADMAP.md`). Polya is the AI layer of that course workspace — the part a
faculty can govern.

Foundation models made answers abundant; understanding is still scarce. The defensible layer is not
the model — it's the **course context and instructional policy** between models and students. The
Scope extension gives us live LMS access patterns and distribution; Lectra gives us the document
workspace where the work happens; Polya is the tutor that knows what the course actually taught.

That has a consequence worth stating plainly: **Polya's instructor policy controls belong to the
same instructor layer as grading, rubrics, and roster sync.** They are not a separate product
surface, and the seam between "Polya the standalone site" and "the tutor inside the course" is an
open design decision (`../../scope-docs/MASTER_PLAN.md` WS-7).

## Motion

Student-first and **free** — build course-level density, which creates the institutional pull:
professor notices → policy controls → departmental pilot in gateway STEM courses → campus license
("Polya Campus": every student gets it, faculty keep learning in the loop).

Revenue is institution-led only. There is no self-serve paid tier and no Pro plan — do not write
copy that implies one. Consumer tiers were removed across the company on 2026-07-24.

We never promise to block other AI tools — we promise the sanctioned option is *better for
coursework* because it starts from the course itself.

## Lines that work

- "Students already use AI to get through school. Polya turns it into a tutor."
- "Get help without giving up the learning."
- "Every answer shows its receipts."
- "General AI answers questions. Polya knows the course, keeps the training wheels honest, and
  teaches through the problem."
- Blunt version for investors: answers are abundant; understanding is scarce; we sell the layer
  that turns one into the other — with the university, not against it.
